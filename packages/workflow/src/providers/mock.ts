/**
 * MockProvider（A1-1）。
 *
 * 用途：单测 / CI / 本地无网络环境。行为完全确定：
 * - 不发起任何网络请求；
 * - 输出由构造参数决定（固定值或纯函数）；
 * - token 用量由字符数估算，latency 由参数固定（默认 0）；
 * - 返回值做深拷贝，调用方修改不会污染下一次调用。
 */

import type {
  ModelJsonInput,
  ModelJsonResult,
  ModelProvider,
  ModelTextInput,
  ModelTextResult,
} from '../model-types.js';
import { estimateTokens } from '../model-types.js';

/** Mock 允许返回的 JSON 值。 */
export type MockJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly MockJsonValue[]
  | { readonly [key: string]: MockJsonValue };

/** Mock 输出：固定值，或只依赖输入的纯函数。 */
export type MockJsonResponder = MockJsonValue | ((input: ModelJsonInput) => MockJsonValue);
export type MockTextResponder = string | ((input: ModelTextInput) => string);

export interface MockProviderOptions {
  readonly json?: MockJsonResponder;
  readonly text?: MockTextResponder;
  /** 默认模型名；缺省 `mock-model`（非空）。 */
  readonly model?: string;
  /** 固定延迟（毫秒），不读系统时钟，保证确定性。 */
  readonly latencyMs?: number;
}

/** 默认 JSON 输出。 */
const DEFAULT_JSON = { ok: true } as const;
/** 默认文本输出。 */
const DEFAULT_TEXT = 'mock response';

function cloneJson(value: MockJsonValue): MockJsonValue {
  return structuredClone(value);
}

export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  /** 默认模型名：Agent 未显式指定时使用。 */
  readonly defaultModel: string;
  private readonly options: MockProviderOptions;

  constructor(options: MockProviderOptions = {}) {
    this.options = options;
    const configured = options.model?.trim() ?? '';
    this.defaultModel = configured === '' ? 'mock-model' : configured;
  }

  /**
   * 用 `Promise.resolve().then` 保持"错误以 rejection 形式出现"的接口语义，
   * 同时避免 async 方法里没有 await（ESLint `require-await`）。
   */
  generateJson(input: ModelJsonInput): Promise<ModelJsonResult> {
    return Promise.resolve().then(() => {
      const responder = this.options.json ?? DEFAULT_JSON;
      const json = typeof responder === 'function' ? responder(input) : responder;
      const cloned = cloneJson(json);
      const promptText = input.messages.map((message) => message.content).join('\n');
      return {
        json: cloned,
        provider: this.name,
        model: input.model,
        usage: {
          promptTokens: estimateTokens(promptText),
          completionTokens: estimateTokens(JSON.stringify(cloned)),
        },
        latencyMs: this.options.latencyMs ?? 0,
      };
    });
  }

  generateText(input: ModelTextInput): Promise<ModelTextResult> {
    return Promise.resolve().then(() => {
      const responder = this.options.text ?? DEFAULT_TEXT;
      const text = typeof responder === 'function' ? responder(input) : responder;
      if (typeof text !== 'string') {
        throw new Error('MockProvider 的 text 输出必须是字符串');
      }
      const promptText = input.messages.map((message) => message.content).join('\n');
      return {
        text,
        provider: this.name,
        model: input.model,
        usage: {
          promptTokens: estimateTokens(promptText),
          completionTokens: estimateTokens(text),
        },
        latencyMs: this.options.latencyMs ?? 0,
      };
    });
  }
}
