/**
 * `chapter.draft` 固定工作流（A1-2）。
 *
 * 步骤（顺序固定，Kernel 不根据模型输出决定下一步）：
 *   assemble_context → plan_chapter → validate_and_freeze_contract
 *   → write_draft → validate_draft → persist_candidate
 *
 * 分工：
 * - 工作流代码负责装配上下文、校验、冻结、状态迁移与持久化；
 * - Planner / Writer 只产出结构化结果，不访问数据库；
 * - 每个模型调用都写 llm_call_logs（成功与失败都写）；
 * - 每步之前由 Kernel 统一检查取消 / 租约 / 所有权，写入步骤再做事务内 fencing。
 */

import type { PrismaClient } from '@novel/db';

import { AgentRunner, type AgentDefinition, type AgentRunResult } from '../agent.js';
import { NonRetryableTaskError, sanitizeTaskError } from '../errors.js';
import type { WorkflowDefinition, WorkflowStepContext } from '../kernel.js';
import type { ModelProvider } from '../model-types.js';
import { recordLlmCall } from '../queue.js';
import {
  normalizePlannerOutput,
  PLANNER_CHAPTER_AGENT,
  prepareDraftText,
  WRITER_CHAPTER_AGENT,
} from './agents.js';
import { buildChapterDraftContext } from './context.js';
import {
  freezeChapterContract,
  loadExistingCandidate,
  loadExistingContract,
  markChapterDrafting,
  persistChapterCandidate,
  type ReviewTaskSpec,
  type TaskFence,
} from './persistence.js';
import { REVIEWER_CHAPTER_AGENT } from './reviewer.js';
import {
  CHAPTER_DRAFT_TASK_TYPE,
  MAX_CONTRACT_TARGET_WORDS,
  MIN_CONTRACT_TARGET_WORDS,
  type ChapterDraftContext,
  type ChapterStyle,
  type FrozenContract,
  type PlannerOutput,
  type ValidatedDraft,
} from './types.js';

const STATE_CONTEXT = 'chapter.context';
const STATE_FENCE = 'chapter.fence';
const STATE_PLAN = 'chapter.plan';
const STATE_CONTRACT = 'chapter.contract';
const STATE_DRAFT = 'chapter.draft';

export interface ChapterDraftWorkflowOptions {
  readonly db: PrismaClient;
  readonly provider: ModelProvider;
}

interface ParsedTaskInput {
  readonly targetWords?: number;
  readonly style?: Partial<ChapterStyle>;
}

interface RawDraft {
  readonly text: string;
}

function invalidInput(detail: string): never {
  throw new NonRetryableTaskError('TASK_INPUT_INVALID', detail);
}

/** 解析任务输入（只允许 targetWords / style，未知字段直接拒绝）。 */
function parseTaskInput(value: unknown): ParsedTaskInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidInput('任务输入必须是对象');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'targetWords' && key !== 'style') {
      invalidInput(`不支持的输入字段 ${key}`);
    }
  }

  let targetWords: number | undefined;
  const rawTarget = record['targetWords'];
  if (rawTarget !== undefined) {
    if (
      typeof rawTarget !== 'number' ||
      !Number.isInteger(rawTarget) ||
      rawTarget < MIN_CONTRACT_TARGET_WORDS ||
      rawTarget > MAX_CONTRACT_TARGET_WORDS
    ) {
      invalidInput(
        `targetWords 必须是 ${MIN_CONTRACT_TARGET_WORDS}..${MAX_CONTRACT_TARGET_WORDS} 的整数`,
      );
    }
    targetWords = rawTarget;
  }

  let style: Partial<ChapterStyle> | undefined;
  const rawStyle = record['style'];
  if (rawStyle !== undefined) {
    if (rawStyle === null || typeof rawStyle !== 'object' || Array.isArray(rawStyle)) {
      invalidInput('style 必须是对象');
    }
    const styleRecord = rawStyle as Record<string, unknown>;
    const parsed: { tone?: string; pointOfView?: string; pacing?: string } = {};
    for (const key of Object.keys(styleRecord)) {
      if (key !== 'tone' && key !== 'pointOfView' && key !== 'pacing') {
        invalidInput(`不支持的 style 字段 ${key}`);
      }
      const value = styleRecord[key];
      if (typeof value !== 'string' || value.trim() === '' || value.length > 100) {
        invalidInput(`style.${key} 必须是 1..100 字符的字符串`);
      }
      parsed[key] = value.trim();
    }
    style = parsed;
  }

  return {
    ...(targetWords === undefined ? {} : { targetWords }),
    ...(style === undefined ? {} : { style }),
  };
}

function requireState<T>(context: WorkflowStepContext, key: string): T {
  const value = context.state.get<T>(key);
  if (value === undefined) {
    throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', `工作流状态缺失：${key}`);
  }
  return value;
}

function requireFence(context: WorkflowStepContext): TaskFence {
  return requireState<TaskFence>(context, STATE_FENCE);
}

function planFromContract(contract: FrozenContract): PlannerOutput {
  return {
    goal: contract.goal,
    mustInclude: contract.mustInclude,
    mustNotInclude: contract.mustNotInclude,
    characters: contract.characters,
    scenes: contract.scenes,
    targetWords: contract.targetWords,
  };
}

function summarize(entities: ChapterDraftContext['characters']) {
  return entities.map((entity) => ({
    id: entity.id,
    name: entity.name,
    summary: entity.summary,
  }));
}

function buildPlannerInput(context: ChapterDraftContext): Record<string, unknown> {
  return {
    chapter: {
      chapterNo: context.chapter.chapterNo,
      title: context.chapter.title,
      targetWords: context.targetWords,
    },
    style: context.style,
    workDirection: context.direction,
    characters: summarize(context.characters),
    realms: summarize(context.realms),
    factions: summarize(context.factions),
  };
}

function buildWriterInput(
  context: ChapterDraftContext,
  contract: FrozenContract,
): Record<string, unknown> {
  const wanted = new Set(contract.characters);
  const matched = context.characters.filter((entity) => wanted.has(entity.name));
  // 合同没点名人物时回落到全部人物，保证 Writer 至少能看到主要角色。
  const picked = matched.length > 0 ? matched : context.characters;

  return {
    contract: {
      goal: contract.goal,
      mustInclude: contract.mustInclude,
      mustNotInclude: contract.mustNotInclude,
      characters: contract.characters,
      scenes: contract.scenes,
      targetWords: contract.targetWords,
    },
    characters: summarize(picked),
    realms: summarize(context.realms),
    style: context.style,
    targetWords: contract.targetWords,
  };
}

/**
 * 调用 Agent 并写 LLM 日志。
 *
 * - 成功：记录 Provider 返回的 token / 延迟；
 * - 失败：记录稳定错误码与 0 token，**不记录 prompt / 响应 / 原始异常**；
 * - 原始异常继续向上抛，由 Worker 决定重试或失败。
 */
async function callAgent<T>(input: {
  readonly runner: AgentRunner;
  readonly providerName: string;
  readonly db: Pick<PrismaClient, 'llmCallLog'>;
  readonly taskId: string;
  readonly agent: AgentDefinition;
  readonly agentInput: unknown;
  readonly signal: AbortSignal;
}): Promise<AgentRunResult<T>> {
  const stage = `agent:${input.agent.name}@${input.agent.promptVersion}`;
  const startedAt = Date.now();
  try {
    const result = await input.runner.run<T>(input.agent, input.agentInput, {
      signal: input.signal,
    });
    await recordLlmCall(input.db, {
      taskId: input.taskId,
      stage,
      provider: result.provider,
      model: result.model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      latencyMs: result.latencyMs,
      success: true,
    });
    return result;
  } catch (error) {
    const sanitized = sanitizeTaskError(error);
    await recordLlmCall(input.db, {
      taskId: input.taskId,
      stage,
      provider: input.providerName,
      // 失败时也要记录实际解析出的模型（不能是空字符串）。
      model: input.runner.resolveModel(input.agent),
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
      success: false,
      errorCode: sanitized.code,
    });
    throw error;
  }
}

/** 创建 `chapter.draft` 工作流定义。 */
export function createChapterDraftWorkflow(
  options: ChapterDraftWorkflowOptions,
): WorkflowDefinition {
  const { db, provider } = options;
  const runner = new AgentRunner(provider);
  // 审阅任务与正文任务使用同一套服务端 Provider 配置：
  // model 由 `runner.resolveModel(reviewer.chapter)` 决定（Agent 未硬编码模型）。
  const reviewTask: ReviewTaskSpec = {
    provider: provider.name,
    model: runner.resolveModel(REVIEWER_CHAPTER_AGENT),
  };

  function assertChapterTask(context: WorkflowStepContext): string {
    const chapterId = context.task.chapterId;
    if (chapterId === null) {
      invalidInput('章节任务必须指定 chapterId');
    }
    return chapterId;
  }

  return {
    taskType: CHAPTER_DRAFT_TASK_TYPE,
    steps: [
      {
        name: 'assemble_context',
        run: async (context) => {
          const chapterId = assertChapterTask(context);
          const parsed = parseTaskInput(context.task.input);
          const assembled = await buildChapterDraftContext(db, {
            workId: context.task.workId,
            chapterId,
            ...(parsed.targetWords === undefined ? {} : { targetWords: parsed.targetWords }),
            ...(parsed.style === undefined ? {} : { style: parsed.style }),
          });
          const workerId = context.workerId;
          if (workerId === null) {
            throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '工作流缺少 workerId');
          }
          const fence: TaskFence = {
            taskId: context.task.taskId,
            workId: context.task.workId,
            chapterId,
            workerId,
            authorId: assembled.context.work.authorId,
          };

          // 只记录来源与摘要，不记录正文 / prompt。
          // 先删后插（同事务）：重试时不会重复、也不会留下上一轮已失效的来源；
          // `context.truncated` 的 ref_id 为 NULL，不能依赖唯一键去重。
          await db.$transaction(async (tx) => {
            await tx.taskContext.deleteMany({ where: { taskId: context.task.taskId } });
            if (assembled.sources.length > 0) {
              await tx.taskContext.createMany({
                data: assembled.sources.map((source) => ({
                  taskId: context.task.taskId,
                  contextType: source.contextType,
                  refId: source.refId,
                  snippet: source.snippet,
                  rank: source.rank,
                })),
              });
            }
          });

          context.state.set(STATE_CONTEXT, assembled.context);
          context.state.set(STATE_FENCE, fence);
        },
      },
      {
        name: 'plan_chapter',
        run: async (context) => {
          const chapterContext = requireState<ChapterDraftContext>(context, STATE_CONTEXT);
          const fence = requireFence(context);

          // 重试复用：合同已冻结 → 不再调用 Planner。
          const existing = await loadExistingContract(db, fence.taskId);
          if (existing !== null) {
            context.state.set(STATE_CONTRACT, existing);
            context.state.set(STATE_PLAN, planFromContract(existing));
            return;
          }

          const result = await callAgent<PlannerOutput>({
            runner,
            providerName: provider.name,
            db,
            taskId: fence.taskId,
            agent: PLANNER_CHAPTER_AGENT,
            agentInput: buildPlannerInput(chapterContext),
            signal: context.signal,
          });

          const plan = normalizePlannerOutput(result.output, {
            allowedCharacters: chapterContext.characters.map((entity) => entity.name),
            targetWords: chapterContext.targetWords,
          });
          context.state.set(STATE_PLAN, plan);
        },
      },
      {
        name: 'validate_and_freeze_contract',
        run: async (context) => {
          const plan = requireState<PlannerOutput>(context, STATE_PLAN);
          const fence = requireFence(context);
          const contract = await freezeChapterContract({ db, fence, plan });
          context.state.set(STATE_CONTRACT, contract);
        },
      },
      {
        name: 'write_draft',
        run: async (context) => {
          const chapterContext = requireState<ChapterDraftContext>(context, STATE_CONTEXT);
          const fence = requireFence(context);
          const contract = requireState<FrozenContract>(context, STATE_CONTRACT);

          // 重试复用：候选已写入 → 不再调用 Writer、不重复插行。
          const existing = await loadExistingCandidate(db, fence.taskId);
          if (existing !== null) {
            context.state.set(STATE_DRAFT, { text: existing.content } satisfies RawDraft);
            return;
          }

          // "Writer 开始后 drafting"：在模型调用之前提交，失败时保留该里程碑。
          await markChapterDrafting({ db, fence });

          const result = await callAgent<RawDraft>({
            runner,
            providerName: provider.name,
            db,
            taskId: fence.taskId,
            agent: WRITER_CHAPTER_AGENT,
            agentInput: buildWriterInput(chapterContext, contract),
            signal: context.signal,
          });

          context.state.set(STATE_DRAFT, { text: result.output.text } satisfies RawDraft);
        },
      },
      {
        name: 'validate_draft',
        run: (context) => {
          const raw = requireState<RawDraft>(context, STATE_DRAFT);
          // 不信任模型自报字数：按"非空白字符数"重新统计，< 1200 直接失败。
          const validated: ValidatedDraft = prepareDraftText(raw.text);
          context.state.set(STATE_DRAFT, validated);
          return Promise.resolve();
        },
      },
      {
        name: 'persist_candidate',
        run: async (context) => {
          const fence = requireFence(context);
          const contract = requireState<FrozenContract>(context, STATE_CONTRACT);
          const plan = requireState<PlannerOutput>(context, STATE_PLAN);
          const draft = requireState<ValidatedDraft>(context, STATE_DRAFT);
          await persistChapterCandidate({ db, fence, contract, draft, plan, review: reviewTask });
        },
      },
    ],
  };
}
