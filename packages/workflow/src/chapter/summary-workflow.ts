/**
 * `chapter.summarize` 固定工作流（A2-D-B）。
 *
 * 步骤（顺序固定，Kernel 不根据模型输出决定下一步）：
 *   load_summary_input → summarize_chapter → persist_summary
 *
 * 分工：
 * - 工作流负责校验定稿 / 最新版本、装配输入、落库与幂等；
 * - Summarizer 只把正文变成 `summary`，不访问数据库；
 * - 每次实际 Provider 调用写且只写一条 `llm_call_logs`；
 * - 失败不修改章节、正式版本、候选、合同或采纳权；不写 audit_logs。
 */

import type { PrismaClient } from '@novel/db';
import { runWorkWrite } from '@novel/works';

import { AgentRunner, type AgentRunResult } from '../agent.js';
import { NonRetryableTaskError, sanitizeTaskError } from '../errors.js';
import type { WorkflowDefinition, WorkflowStepContext } from '../kernel.js';
import type { ModelProvider } from '../model-types.js';
import { recordLlmCall } from '../queue.js';
import { assertTaskFence } from './persistence.js';
import {
  findExistingSummary,
  loadChapterSummaryContext,
  parseChapterSummaryTaskInput,
  persistChapterSummary,
  type ChapterSummaryContext,
  type SummaryTaskFence,
} from './summary.js';
import {
  assertSummarizerInput,
  SUMMARIZER_CHAPTER_AGENT,
  validateSummarizerOutput,
  type ChapterSummarizerOutput,
} from './summarizer.js';
import { CHAPTER_SUMMARY_TASK_TYPE } from './types.js';

const STATE_FENCE = 'summary.fence';
const STATE_CONTEXT = 'summary.context';
const STATE_SKIP = 'summary.skip';
const STATE_OUTPUT = 'summary.output';
const STATE_RESULT = 'summary.result';

export interface ChapterSummaryWorkflowOptions {
  readonly db: PrismaClient;
  readonly provider: ModelProvider;
}

/** 本次摘要实际使用的 provider / model（落库用）。 */
interface SummaryResultMeta {
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

/** 创建 `chapter.summarize` 工作流定义。 */
export function createChapterSummaryWorkflow(
  options: ChapterSummaryWorkflowOptions,
): WorkflowDefinition {
  const { db, provider } = options;
  const runner = new AgentRunner(provider);
  const configuredModel = runner.resolveModel(SUMMARIZER_CHAPTER_AGENT);
  const stage = `agent:${SUMMARIZER_CHAPTER_AGENT.name}@${SUMMARIZER_CHAPTER_AGENT.promptVersion}`;

  /**
   * 调用 Summarizer 并写**恰好一条** LLM 日志。
   *
   * - 输入契约在调用前校验（不合法则不发请求、不写日志）；
   * - Provider 失败 / 输出非法都写 `success=false` + 稳定错误码；
   * - 日志只记计量与结果，不含正文、摘要、prompt 或原始响应。
   */
  async function callSummarizer(input: {
    readonly taskId: string;
    readonly context: ChapterSummaryContext;
    readonly signal: AbortSignal;
  }): Promise<AgentRunResult<ChapterSummarizerOutput>> {
    assertSummarizerInput(input.context.agentInput);

    const startedAt = Date.now();
    let raw: AgentRunResult<ChapterSummarizerOutput>;
    try {
      raw = await runner.run<ChapterSummarizerOutput>(
        SUMMARIZER_CHAPTER_AGENT,
        input.context.agentInput,
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

    let output: ChapterSummarizerOutput;
    try {
      output = validateSummarizerOutput(raw.output);
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

  return {
    taskType: CHAPTER_SUMMARY_TASK_TYPE,
    steps: [
      {
        name: 'load_summary_input',
        run: async (context) => {
          const chapterId = context.task.chapterId;
          if (chapterId === null) {
            throw new NonRetryableTaskError('TASK_INPUT_INVALID', '摘要任务必须指定 chapterId');
          }
          const workerId = context.workerId;
          if (workerId === null) {
            throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '工作流缺少 workerId');
          }
          const parsed = parseChapterSummaryTaskInput(context.task.input);
          const fence: SummaryTaskFence = {
            taskId: context.task.taskId,
            workId: context.task.workId,
            chapterId,
            sourceVersionId: parsed.sourceVersionId,
            workerId,
          };

          // 任务行锁 + `locked_by` fence；上下文与 task_contexts 同事务写入。
          const loaded = await runWorkWrite(db, fence.workId, async (tx) => {
            await assertTaskFence(tx, fence);
            const summaryContext = await loadChapterSummaryContext(tx, {
              workId: fence.workId,
              chapterId: fence.chapterId,
              sourceVersionId: fence.sourceVersionId,
            });
            const existing = await findExistingSummary(tx, fence.sourceVersionId);

            await tx.taskContext.deleteMany({ where: { taskId: fence.taskId } });
            if (summaryContext.sources.length > 0) {
              await tx.taskContext.createMany({
                data: summaryContext.sources.map((source) => ({
                  taskId: fence.taskId,
                  contextType: source.contextType,
                  refId: source.refId,
                  snippet: source.snippet,
                  rank: source.rank,
                })),
              });
            }
            return { summaryContext, skip: existing !== null };
          });

          context.state.set(STATE_FENCE, fence);
          context.state.set(STATE_CONTEXT, loaded.summaryContext);
          context.state.set(STATE_SKIP, loaded.skip);
        },
      },
      {
        name: 'summarize_chapter',
        run: async (context) => {
          const skip = requireState<boolean>(context, STATE_SKIP);
          if (skip) {
            // 已有同版本摘要：不调用模型、不重复写日志。
            return;
          }
          const fence = requireState<SummaryTaskFence>(context, STATE_FENCE);
          const summaryContext = requireState<ChapterSummaryContext>(context, STATE_CONTEXT);

          // 摘要任务没有独立 run 行需要标记：Provider / 输出失败由 Kernel 分类，
          // 控制层错误（TASK_LEASE_LOST）也原样向上抛，不做额外落库。
          const result = await callSummarizer({
            taskId: fence.taskId,
            context: summaryContext,
            signal: context.signal,
          });
          context.state.set(STATE_OUTPUT, result.output);
          context.state.set(STATE_RESULT, {
            provider: result.provider,
            model: result.model,
          } satisfies SummaryResultMeta);
        },
      },
      {
        name: 'persist_summary',
        run: async (context) => {
          const skip = requireState<boolean>(context, STATE_SKIP);
          if (skip) {
            return;
          }
          const fence = requireState<SummaryTaskFence>(context, STATE_FENCE);
          const output = requireState<ChapterSummarizerOutput>(context, STATE_OUTPUT);
          const meta = requireState<SummaryResultMeta>(context, STATE_RESULT);

          await persistChapterSummary({
            db,
            fence,
            output,
            provider: meta.provider,
            model: meta.model,
          });
        },
      },
    ],
  };
}
