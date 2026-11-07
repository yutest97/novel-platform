/**
 * 模型 Provider 的统一契约（A1-1）。
 *
 * 所有 Provider 只做一件事：把「消息 + 模型 + 上限」换成结构化结果，
 * 不读数据库、不决定工作流下一步、不把失败原因原样抛给调用方。
 *
 * 安全约束（对实现方的硬要求）：
 * - 抛出的 `ModelProviderError.message` 只能含固定文案与 HTTP 状态码，
 *   不含 API Key、prompt、请求体、响应体或底层异常信息；
 * - 不记录任何请求/响应正文。
 */

import type { WorkflowErrorCode } from './errors.js';
import { WorkflowError } from './errors.js';

/** 一条对话消息（只保留 role/content）。 */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** JSON 生成输入。 */
export interface ModelJsonInput {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

/** 文本生成输入。 */
export type ModelTextInput = ModelJsonInput;

/** token 用量（Provider 未返回时补 0）。 */
export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** JSON 生成结果。 */
export interface ModelJsonResult {
  readonly json: unknown;
  readonly provider: string;
  readonly model: string;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
}

/** 文本生成结果。 */
export interface ModelTextResult {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
}

/**
 * 已完成调用的安全元数据。
 *
 * 只含 provider / model / usage / latency；不得附 prompt、原始响应、
 * 正文或底层异常，用于调用失败后仍能保留已发生的 token 成本。
 */
export interface ModelCallMetadata {
  readonly provider: string;
  readonly model: string;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
}

/** Provider 统一接口。 */
export interface ModelProvider {
  readonly name: string;
  /**
   * 默认模型名（非空）。
   *
   * `AgentDefinition.model` 为空时由 AgentRunner 回落到这里；
   * 任务角色不应把某个 mock 模型硬编码进 Agent 定义。
   */
  readonly defaultModel: string;
  generateJson(input: ModelJsonInput): Promise<ModelJsonResult>;
  generateText(input: ModelTextInput): Promise<ModelTextResult>;
}

/**
 * Provider 身份（name + defaultModel）。
 *
 * Worker 只需这两项做「任务记录 vs 当前配置」预检，不需要完整的生成能力；
 * 这样测试可以只传一个值对象，不会误构造真实网络客户端。
 */
export type ModelProviderIdentity = Pick<ModelProvider, 'name' | 'defaultModel'>;

/** Provider 可用的错误码子集。 */
export type ModelErrorCode = Extract<
  WorkflowErrorCode,
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_NETWORK_ERROR'
  | 'MODEL_TIMEOUT'
  | 'MODEL_ABORTED'
  | 'MODEL_HTTP_ERROR'
  | 'MODEL_INVALID_RESPONSE'
>;

/** 模型调用错误（安全文案 + 稳定错误码 + 可重试语义）。 */
export class ModelProviderError extends WorkflowError {
  /** 仅在 HTTP 错误时存在。 */
  readonly status?: number;
  /** Provider 已完成调用并读到 usage 时的安全元数据；失败前无调用则为空。 */
  readonly callMetadata?: ModelCallMetadata;

  constructor(
    code: ModelErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number; callMetadata?: ModelCallMetadata } = {},
  ) {
    super(code, message, { retryable: options.retryable ?? false });
    this.name = 'ModelProviderError';
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.callMetadata !== undefined) {
      this.callMetadata = options.callMetadata;
    }
  }
}

/** 判断是否为模型调用错误。 */
export function isModelProviderError(error: unknown): error is ModelProviderError {
  return error instanceof ModelProviderError;
}

/**
 * 估算 token 用量（Mock/测试用）。
 *
 * 只用于让 MockProvider 的输出**确定**，不追求与真实 tokenizer 一致。
 */
export function estimateTokens(text: string): number {
  if (text === '') {
    return 0;
  }
  return Math.ceil(text.length / 4);
}
