/**
 * `chapter.review` 固定工作流（A2-C-B）。
 *
 * 步骤（顺序固定，Kernel 不根据模型输出决定下一步）：
 *   load_review_input → run_reviewer → persist_review_result
 *
 * 分工：
 * - 工作流代码负责装配输入、创建 / 复用 run、状态迁移与落库；
 * - Reviewer 只把结构化输入变成结构化问题，不访问数据库；
 * - 每次实际 Provider 调用写且只写一条 llm_call_logs；
 * - 失败只标记 review run 与任务，**不修改候选、合同、章节、采纳或 draft 任务**；
 * - 取消 / 租约丢失由任务 fence 与数据库触发器兜底，不写问题、不覆盖 run。
 */

import type { PrismaClient } from '@novel/db';

import { AgentRunner, type AgentRunResult } from '../agent.js';
import { NonRetryableTaskError, sanitizeTaskError, TaskLeaseLostError } from '../errors.js';
import type { WorkflowDefinition, WorkflowStepContext } from '../kernel.js';
import type { ModelProvider } from '../model-types.js';
import { recordLlmCall } from '../queue.js';
import {
  markReviewRunFailed,
  parseChapterReviewTaskInput,
  persistReviewResult,
  prepareReviewRun,
  type ChapterReviewContext,
  type ReviewTaskFence,
} from './review.js';
import { REVIEWER_CHAPTER_AGENT, validateReviewerOutput } from './reviewer.js';
import type { ChapterReviewerOutput } from './reviewer.js';
import { CHAPTER_REVIEW_TASK_TYPE } from './types.js';

const STATE_FENCE = 'review.fence';
const STATE_CONTEXT = 'review.context';
const STATE_SKIP = 'review.skip';
const STATE_OUTPUT = 'review.output';
const STATE_RESULT = 'review.result';

export interface ChapterReviewWorkflowOptions {
  readonly db: PrismaClient;
  readonly provider: ModelProvider;
}

/** 本次审阅实际使用的 provider / model（成功落库用）。 */
interface ReviewResultMeta {
  readonly provider: string;
  readonly model: string;
}

function requireState<T>(context: WorkflowStepContext, key: string): T {
  const value = context.state.get<T>(key);
  if (value === undefined) {
    throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', `工作流状态缺失：${key}`);
  }
  return value;
}

/** 创建 `chapter.review` 工作流定义。 */
export function createChapterReviewWorkflow(
  options: ChapterReviewWorkflowOptions,
): WorkflowDefinition {
  const { db, provider } = options;
  const runner = new AgentRunner(provider);
  const configuredModel = runner.resolveModel(REVIEWER_CHAPTER_AGENT);
  const stage = `agent:${REVIEWER_CHAPTER_AGENT.name}@${REVIEWER_CHAPTER_AGENT.promptVersion}`;

  /**
   * 调用 Reviewer 并写**恰好一条** LLM 日志。
   *
   * - Provider 失败 → `success=false` + 稳定错误码；
   * - Schema / 语义失败（`AGENT_OUTPUT_INVALID`）→ 同样 `success=false`：
   *   这一次调用确实没有产出可用结果；
   * - 日志只记计量与结果，不含 prompt、正文、evidence、suggestion 或原始响应。
   */
  async function callReviewer(input: {
    readonly taskId: string;
    readonly reviewInput: ChapterReviewContext;
    readonly signal: AbortSignal;
  }): Promise<AgentRunResult<ChapterReviewerOutput>> {
    const startedAt = Date.now();
    let raw: AgentRunResult<ChapterReviewerOutput>;
    try {
      raw = await runner.run<ChapterReviewerOutput>(
        REVIEWER_CHAPTER_AGENT,
        input.reviewInput.input,
        { signal: input.signal },
      );
    } catch (error) {
      const sanitized = sanitizeTaskError(error);
      await recordLlmCall(db, {
        taskId: input.taskId,
        stage,
        provider: provider.name,
        model: configuredModel,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Math.max(0, Date.now() - startedAt),
        success: false,
        errorCode: sanitized.code,
      });
      throw error;
    }

    let output: ChapterReviewerOutput;
    try {
      output = validateReviewerOutput(raw.output, { draft: input.reviewInput.draft });
    } catch (error) {
      const sanitized = sanitizeTaskError(error);
      await recordLlmCall(db, {
        taskId: input.taskId,
        stage,
        provider: raw.provider,
        model: raw.model,
        promptTokens: raw.usage.promptTokens,
        completionTokens: raw.usage.completionTokens,
        latencyMs: raw.latencyMs,
        success: false,
        errorCode: sanitized.code,
      });
      throw error;
    }

    await recordLlmCall(db, {
      taskId: input.taskId,
      stage,
      provider: raw.provider,
      model: raw.model,
      promptTokens: raw.usage.promptTokens,
      completionTokens: raw.usage.completionTokens,
      latencyMs: raw.latencyMs,
      success: true,
    });
    return { ...raw, output };
  }

  /** 失败标记：控制层错误（租约丢失）继续抛出，不由本流程吞掉。 */
  async function failRun(fence: ReviewTaskFence, error: unknown): Promise<void> {
    if (error instanceof TaskLeaseLostError) {
      return;
    }
    await markReviewRunFailed({
      db,
      fence,
      errorCode: sanitizeTaskError(error).code,
    });
  }

  return {
    taskType: CHAPTER_REVIEW_TASK_TYPE,
    steps: [
      {
        name: 'load_review_input',
        run: async (context) => {
          const chapterId = context.task.chapterId;
          if (chapterId === null) {
            throw new NonRetryableTaskError('TASK_INPUT_INVALID', '审阅任务必须指定 chapterId');
          }
          const workerId = context.workerId;
          if (workerId === null) {
            throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '工作流缺少 workerId');
          }
          const parsed = parseChapterReviewTaskInput(context.task.input);
          const fence: ReviewTaskFence = {
            taskId: context.task.taskId,
            workId: context.task.workId,
            chapterId,
            candidateId: parsed.candidateId,
            workerId,
          };

          const prepared = await prepareReviewRun({
            db,
            fence,
            provider: provider.name,
            model: configuredModel,
          });

          context.state.set(STATE_FENCE, fence);
          context.state.set(STATE_CONTEXT, prepared.context);
          context.state.set(STATE_SKIP, prepared.skip);
        },
      },
      {
        name: 'run_reviewer',
        run: async (context) => {
          const skip = requireState<boolean>(context, STATE_SKIP);
          if (skip) {
            // 已有成功的 run：不调用模型、不重复写日志。
            return;
          }
          const fence = requireState<ReviewTaskFence>(context, STATE_FENCE);
          const reviewInput = requireState<ChapterReviewContext>(context, STATE_CONTEXT);

          try {
            const result = await callReviewer({
              taskId: fence.taskId,
              reviewInput,
              signal: context.signal,
            });
            context.state.set(STATE_OUTPUT, result.output);
            context.state.set(STATE_RESULT, {
              provider: result.provider,
              model: result.model,
            } satisfies ReviewResultMeta);
          } catch (error) {
            await failRun(fence, error);
            throw error;
          }
        },
      },
      {
        name: 'persist_review_result',
        run: async (context) => {
          const skip = requireState<boolean>(context, STATE_SKIP);
          if (skip) {
            return;
          }
          const fence = requireState<ReviewTaskFence>(context, STATE_FENCE);
          const output = requireState<ChapterReviewerOutput>(context, STATE_OUTPUT);
          const meta = requireState<ReviewResultMeta>(context, STATE_RESULT);

          try {
            await persistReviewResult({
              db,
              fence,
              output,
              provider: meta.provider,
              model: meta.model,
            });
          } catch (error) {
            await failRun(fence, error);
            throw error;
          }
        },
      },
    ],
  };
}
