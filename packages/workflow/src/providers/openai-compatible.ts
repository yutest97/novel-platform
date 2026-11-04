/**
 * OpenAI 兼容 Provider（A1-1）。
 *
 * 只依赖标准 `fetch`，不引入 Agent 框架或第三方 SDK。
 *
 * 安全约束：
 * - API Key 只出现在请求头，绝不进入日志、错误消息或返回值；
 * - 失败时只抛固定文案 + HTTP 状态码，**不含**请求体、prompt、
 *   响应体或底层异常信息；
 * - 响应体大小有上限，避免异常服务把进程拖垮。
 *
 * 测试：单测通过注入 `fetchImpl` 完成，**不允许真实联网**。
 */

import type {
  ModelJsonInput,
  ModelJsonResult,
  ModelProvider,
  ModelTextInput,
  ModelTextResult,
  ModelUsage,
} from '../model-types.js';
import { ModelProviderError } from '../model-types.js';

/** 注入点：与全局 fetch 同签名，便于单测替换。 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenAICompatibleConfig {
  /** 例如 `https://api.openai.com/v1` 或自建兼容网关。 */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** 默认模型；AgentDefinition 可覆盖。 */
  readonly model: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  /** 响应体上限（字符数），默认 1 MiB。 */
  readonly maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** 去掉首尾空白与可选的 Markdown 代码围栏。 */
function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) {
    return trimmed;
  }
  const withoutOpen = trimmed.slice(3);
  const firstNewline = withoutOpen.indexOf('\n');
  const body = firstNewline === -1 ? '' : withoutOpen.slice(firstNewline + 1);
  return body.slice(0, -3).trim();
}

function readUsage(value: unknown): ModelUsage {
  if (typeof value !== 'object' || value === null) {
    return { promptTokens: 0, completionTokens: 0 };
  }
  const usage = value as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  return {
    promptTokens: typeof prompt === 'number' && Number.isFinite(prompt) && prompt >= 0 ? prompt : 0,
    completionTokens:
      typeof completion === 'number' && Number.isFinite(completion) && completion >= 0
        ? completion
        : 0,
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';

  private readonly config: Required<Omit<OpenAICompatibleConfig, 'fetchImpl'>> & {
    readonly fetchImpl: FetchLike;
  };

  /** 环境变量 / 配置中的 MODEL_NAME；Agent 未显式指定时使用。 */
  get defaultModel(): string {
    return this.config.model;
  }

  /**
   * 只序列化身份信息。
   *
   * 防止误用 `JSON.stringify(provider)` / 结构化日志时把 API Key 带进日志或错误。
   */
  toJSON(): { name: string; defaultModel: string } {
    return { name: this.name, defaultModel: this.defaultModel };
  }

  constructor(config: OpenAICompatibleConfig) {
    const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
    if (baseUrl === '' || typeof config.apiKey !== 'string' || config.apiKey.trim() === '') {
      throw new ModelProviderError('MODEL_NOT_CONFIGURED', '模型服务未配置');
    }
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new ModelProviderError('MODEL_NOT_CONFIGURED', '模型服务地址不合法');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ModelProviderError('MODEL_NOT_CONFIGURED', '模型服务地址必须是 http(s)');
    }
    if (config.model.trim() === '') {
      throw new ModelProviderError('MODEL_NOT_CONFIGURED', '模型名称未配置');
    }

    this.config = {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      model: config.model.trim(),
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      fetchImpl: config.fetchImpl ?? ((input, init) => fetch(input, init)),
    };
  }

  async generateJson(input: ModelJsonInput): Promise<ModelJsonResult> {
    const result = await this.call(input, true);
    let json: unknown;
    try {
      json = JSON.parse(stripCodeFence(result.content)) as unknown;
    } catch {
      // 不回显 content：模型输出可能含敏感内容。
      throw new ModelProviderError('MODEL_INVALID_RESPONSE', '模型返回的不是合法 JSON');
    }
    return {
      json,
      provider: this.name,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  }

  async generateText(input: ModelTextInput): Promise<ModelTextResult> {
    const result = await this.call(input, false);
    return {
      text: result.content,
      provider: this.name,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  }

  /** 发一次 chat/completions 请求，返回原始文本内容。 */
  private async call(
    input: ModelJsonInput,
    jsonMode: boolean,
  ): Promise<{ content: string; model: string; usage: ModelUsage; latencyMs: number }> {
    if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
      throw new ModelProviderError('MODEL_INVALID_RESPONSE', '模型请求参数不合法');
    }
    // 允许调用方覆盖默认模型；空串则回落到环境变量配置的模型。
    const model = input.model.trim() === '' ? this.config.model : input.model;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);
    const onAbort = (): void => {
      controller.abort();
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    // 信号在调用前就已取消：addEventListener 不会再触发，必须主动同步一次。
    if (input.signal?.aborted === true) {
      controller.abort();
    }

    const startedAt = Date.now();
    try {
      let response: Response;
      try {
        response = await this.config.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: input.messages,
            max_tokens: input.maxOutputTokens,
            temperature: input.temperature ?? 0.2,
            stream: false,
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: controller.signal,
        });
      } catch {
        if (timedOut) {
          throw new ModelProviderError('MODEL_TIMEOUT', '模型服务超时', { retryable: true });
        }
        if (input.signal?.aborted === true) {
          throw new ModelProviderError('MODEL_ABORTED', '模型调用已取消');
        }
        throw new ModelProviderError('MODEL_NETWORK_ERROR', '无法连接模型服务', {
          retryable: true,
        });
      }

      if (!response.ok) {
        throw new ModelProviderError('MODEL_HTTP_ERROR', `模型服务返回 HTTP ${response.status}`, {
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
        });
      }

      let raw: string;
      try {
        raw = await response.text();
      } catch {
        throw new ModelProviderError('MODEL_NETWORK_ERROR', '读取模型响应失败', {
          retryable: true,
        });
      }
      if (raw.length > this.config.maxResponseBytes) {
        throw new ModelProviderError('MODEL_INVALID_RESPONSE', '模型响应过大');
      }

      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new ModelProviderError('MODEL_INVALID_RESPONSE', '模型响应不是合法 JSON');
      }

      const content = this.readContent(body);
      const usage = readUsage(
        typeof body === 'object' && body !== null && 'usage' in body
          ? (body as { usage?: unknown }).usage
          : undefined,
      );

      return { content, model, usage, latencyMs: Math.max(0, Date.now() - startedAt) };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 从 chat/completions 响应里取 choices[0].message.content。 */
  private readContent(body: unknown): string {
    if (typeof body !== 'object' || body === null) {
      throw new ModelProviderError('MODEL_INVALID_RESPONSE', '模型响应结构不合法');
    }
    const choices = (body as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ModelProviderError('MODEL_INVALID_RESPONSE', '模型响应缺少 choices');
    }
    const first = choices[0] as { message?: unknown } | undefined;
    const message = first?.message;
    if (typeof message !== 'object' || message === null) {
      throw new ModelProviderError('MODEL_INVALID_RESPONSE', '模型响应缺少 message');
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new ModelProviderError('MODEL_INVALID_RESPONSE', '模型响应内容为空');
    }
    return content;
  }
}
