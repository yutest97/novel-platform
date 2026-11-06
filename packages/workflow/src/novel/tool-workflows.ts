/**
 * C1-A：Coordinator 可用工具的最小确定性工作流描述。
 *
 * 工具不是任意函数：
 * - 每个工具声明可从哪些状态进入、输入 Schema、成功迁移、副作用等级与超时；
 * - `execute` 只把通过校验的 action 换算成「安全输出摘要 + 下一状态摘要」；
 * - Runtime 负责状态迁移、预算、租约、熔断与落库，工具本身不碰数据库。
 *
 * C1-A 只注册 `ask_user` / `finish`；`waiting_approval` 留给后续阶段。
 */

import type { JsonSchema } from '../json-schema.js';
import type { NovelCoordinatorAction } from './coordinator-agent.js';
import type { NovelRunStateSummary, NovelRunStatus, NovelToolName } from './types.js';

/** 工具副作用等级（C1-A 两个工具都不产生创作资料）。 */
export type NovelToolSideEffect = 'read_only' | 'create_candidate' | 'external_cost';

/** 工具执行上下文：只含已校验的 action 与运行时摘要。 */
export interface NovelToolContext {
  readonly action: NovelCoordinatorAction;
  readonly summary: NovelRunStateSummary;
  readonly stepNo: number;
  readonly signature: string;
  readonly repeatCount: number;
}

/** 工具执行结果：下一状态、安全输出摘要与下一轮调度摘要。 */
export interface NovelToolResult {
  readonly status: NovelRunStatus;
  readonly outputSummary: Record<string, unknown>;
  readonly stateSummary: NovelRunStateSummary;
}

/** 工具工作流定义。 */
export interface NovelToolWorkflow {
  readonly name: NovelToolName;
  readonly allowedFromStatus: readonly NovelRunStatus[];
  readonly inputSchema: JsonSchema;
  readonly successTransition: NovelRunStatus;
  readonly sideEffect: NovelToolSideEffect;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly execute: (context: NovelToolContext) => NovelToolResult;
}

const MAX_KNOWN_FACTS = 6;

function baseNextSummary(context: NovelToolContext): NovelRunStateSummary {
  return {
    ...context.summary,
    openQuestions: [],
    nextAllowedTools: [],
    latestAnswer: null,
    lastActionSignature: context.signature,
    repeatCount: context.repeatCount,
    lastStepNo: context.stepNo,
  };
}

/**
 * `ask_user`：只写待答问题，不写任何人物 / 世界观 / 大纲资料。
 *
 * 作者此前的回答在这里收敛成短事实，供下一轮 Coordinator 决策。
 */
const ASK_USER_WORKFLOW: NovelToolWorkflow = {
  name: 'ask_user',
  allowedFromStatus: ['running'],
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 600 },
      options: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 60 },
        maxItems: 6,
      },
      finishReason: { type: 'null' },
    },
    required: ['question', 'options', 'finishReason'],
    additionalProperties: false,
  },
  successTransition: 'waiting_user',
  sideEffect: 'read_only',
  maxAttempts: 1,
  timeoutMs: 60_000,
  execute: (context) => {
    const question = context.action.input.question ?? '';
    const knownFacts =
      context.summary.latestAnswer === null
        ? context.summary.knownFacts
        : [...context.summary.knownFacts, context.summary.latestAnswer].slice(-MAX_KNOWN_FACTS);
    const next = baseNextSummary(context);
    return {
      status: 'waiting_user',
      outputSummary: {
        kind: 'question',
        question,
        options: [...context.action.input.options],
      },
      stateSummary: {
        ...next,
        knownFacts,
        openQuestions: question === '' ? [] : [question],
      },
    };
  },
};

/** `finish`：结束本轮问答；不写创作资料，也不产生作者确认门禁。 */
const FINISH_WORKFLOW: NovelToolWorkflow = {
  name: 'finish',
  allowedFromStatus: ['running'],
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'null' },
      options: { type: 'array', items: { type: 'string' }, maxItems: 0 },
      finishReason: { type: 'string', minLength: 1, maxLength: 120 },
    },
    required: ['question', 'options', 'finishReason'],
    additionalProperties: false,
  },
  successTransition: 'completed',
  sideEffect: 'read_only',
  maxAttempts: 1,
  timeoutMs: 60_000,
  execute: (context) => {
    const next = baseNextSummary(context);
    return {
      status: 'completed',
      outputSummary: {
        kind: 'finish',
        finishReason: context.action.input.finishReason ?? '',
      },
      stateSummary: next,
    };
  },
};

/** C1-A 工具白名单（顺序稳定，便于测试与文档引用）。 */
export const NOVEL_TOOL_WORKFLOWS: Readonly<Record<NovelToolName, NovelToolWorkflow>> = {
  ask_user: ASK_USER_WORKFLOW,
  finish: FINISH_WORKFLOW,
};

/** 按名称取工具工作流；未知名称返回 null（Runtime 用稳定错误码失败）。 */
export function getNovelToolWorkflow(name: string): NovelToolWorkflow | null {
  return Object.prototype.hasOwnProperty.call(NOVEL_TOOL_WORKFLOWS, name)
    ? NOVEL_TOOL_WORKFLOWS[name as NovelToolName]
    : null;
}
