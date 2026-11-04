/**
 * OpenAI 兼容 Provider（A1-1）。
 *
 * 全部通过注入的 `fetchImpl` 完成，**不真实联网**。
 * 重点证明：请求形状、JSON/文本解析、错误脱敏（不含 Key / prompt / 响应体）。
 */

import { describe, expect, it, vi } from 'vitest';

import { ModelProviderError } from '../src/model-types.js';
import { OpenAICompatibleProvider, type FetchLike } from '../src/providers/openai-compatible.js';
import { createModelProvider, readProviderConfig } from '../src/provider.js';

const SECRET_KEY = 'sk-test-SECRET-KEY';
const SECRET_PROMPT = '这是不能出现在错误里的 prompt';

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 从 fetch 调用里安全取出 JSON 请求体。 */
function bodyOf(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') {
    throw new Error('请求体必须是字符串');
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function providerWith(fetchImpl: FetchLike, timeoutMs = 1000): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: 'https://model.example.test/v1/',
    apiKey: SECRET_KEY,
    model: 'default-model',
    timeoutMs,
    fetchImpl,
  });
}

const input = {
  model: 'agent-model',
  maxOutputTokens: 128,
  messages: [
    { role: 'system' as const, content: 'system' },
    { role: 'user' as const, content: SECRET_PROMPT },
  ],
};

describe('OpenAICompatibleProvider 请求与解析', () => {
  it('generateJson：请求形状正确，解析 content 与 usage', async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(
        okJson({
          choices: [{ message: { content: '{"title":"第一章"}' } }],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        }),
      ),
    );
    const provider = providerWith(fetchImpl);

    const result = await provider.generateJson(input);

    expect(result.json).toEqual({ title: '第一章' });
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 5 });
    expect(result.model).toBe('agent-model');
    expect(result.provider).toBe('openai-compatible');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe('https://model.example.test/v1/chat/completions');
    const init = call?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET_KEY}`);
    const body = bodyOf(init);
    expect(body['model']).toBe('agent-model');
    expect(body['max_tokens']).toBe(128);
    expect(body['stream']).toBe(false);
    expect(body['response_format']).toEqual({ type: 'json_object' });
    expect(body['messages']).toEqual(input.messages);
  });

  it('generateText：不带 response_format，返回原始文本', async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(okJson({ choices: [{ message: { content: '正文片段' } }] })),
    );
    const provider = providerWith(fetchImpl);

    const result = await provider.generateText(input);

    expect(result.text).toBe('正文片段');
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = bodyOf(init);
    expect(body['response_format']).toBeUndefined();
  });

  it('容忍 Markdown 代码围栏', async () => {
    const provider = providerWith(() =>
      Promise.resolve(okJson({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] })),
    );
    await expect(provider.generateJson(input)).resolves.toMatchObject({ json: { ok: true } });
  });

  it('空 model 回落到配置的默认模型', async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(okJson({ choices: [{ message: { content: '{"ok":true}' } }] })),
    );
    const provider = providerWith(fetchImpl);
    const result = await provider.generateJson({ ...input, model: '' });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(bodyOf(init)['model']).toBe('default-model');
    expect(result.model).toBe('default-model');
  });
});

describe('OpenAICompatibleProvider 错误脱敏', () => {
  it('JSON 内容非法：固定文案，不含响应内容', async () => {
    const provider = providerWith(() =>
      Promise.resolve(okJson({ choices: [{ message: { content: `not-json ${SECRET_PROMPT}` } }] })),
    );
    try {
      await provider.generateJson(input);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelProviderError);
      const modelError = error as ModelProviderError;
      expect(modelError.code).toBe('MODEL_INVALID_RESPONSE');
      expect(modelError.message).not.toContain(SECRET_PROMPT);
    }
  });

  it('HTTP 500：可重试，消息只含状态码', async () => {
    const provider = providerWith(() =>
      Promise.resolve(new Response(JSON.stringify({ error: SECRET_PROMPT }), { status: 500 })),
    );
    try {
      await provider.generateJson(input);
      throw new Error('should have thrown');
    } catch (error) {
      const modelError = error as ModelProviderError;
      expect(modelError.code).toBe('MODEL_HTTP_ERROR');
      expect(modelError.status).toBe(500);
      expect(modelError.retryable).toBe(true);
      expect(modelError.message).toContain('500');
      expect(modelError.message).not.toContain(SECRET_PROMPT);
      expect(JSON.stringify(modelError)).not.toContain(SECRET_KEY);
    }
  });

  it('HTTP 401：不可重试', async () => {
    const provider = providerWith(() => Promise.resolve(new Response('', { status: 401 })));
    await expect(provider.generateJson(input)).rejects.toMatchObject({
      code: 'MODEL_HTTP_ERROR',
      retryable: false,
      status: 401,
    });
  });

  it('网络异常：固定文案，不透传底层错误（可能含 Key/URL）', async () => {
    const provider = providerWith(() =>
      Promise.reject(new Error(`connect failed with ${SECRET_KEY}`)),
    );
    try {
      await provider.generateJson(input);
      throw new Error('should have thrown');
    } catch (error) {
      const modelError = error as ModelProviderError;
      expect(modelError.code).toBe('MODEL_NETWORK_ERROR');
      expect(modelError.retryable).toBe(true);
      expect(modelError.message).toBe('无法连接模型服务');
      expect(JSON.stringify(modelError)).not.toContain(SECRET_KEY);
      expect(JSON.stringify(modelError)).not.toContain(SECRET_PROMPT);
    }
  });

  it('超时：可重试', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const provider = providerWith(fetchImpl, 10);
    await expect(provider.generateJson(input)).rejects.toMatchObject({
      code: 'MODEL_TIMEOUT',
      retryable: true,
    });
  });

  it('外部取消：MODEL_ABORTED，不重试', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl: FetchLike = (_url, init) => {
      if (init.signal?.aborted === true) {
        return Promise.reject(new Error('aborted'));
      }
      return Promise.resolve(okJson({ choices: [{ message: { content: '{}' } }] }));
    };
    await expect(
      providerWith(fetchImpl).generateJson({ ...input, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'MODEL_ABORTED', retryable: false });
  });

  it('非法请求参数：拒绝调用', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const provider = providerWith(fetchImpl);
    await expect(provider.generateJson({ ...input, maxOutputTokens: 0 })).rejects.toMatchObject({
      code: 'MODEL_INVALID_RESPONSE',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Provider 配置', () => {
  it('默认 mock', () => {
    const config = readProviderConfig({});
    expect(config.kind).toBe('mock');
    expect(createModelProvider(config).name).toBe('mock');
  });

  it('openai-compatible 读取 baseUrl/key/model/timeout', () => {
    const config = readProviderConfig({
      MODEL_PROVIDER: 'openai-compatible',
      MODEL_BASE_URL: 'https://x.test/v1',
      MODEL_API_KEY: SECRET_KEY,
      MODEL_NAME: 'gpt-test',
      MODEL_TIMEOUT_MS: '12345',
    });
    expect(config).toEqual({
      kind: 'openai-compatible',
      baseUrl: 'https://x.test/v1',
      apiKey: SECRET_KEY,
      model: 'gpt-test',
      timeoutMs: 12_345,
    });
    expect(createModelProvider(config).name).toBe('openai-compatible');
  });

  it('非法取值与缺配置都报 MODEL_NOT_CONFIGURED', () => {
    expect(() => readProviderConfig({ MODEL_PROVIDER: 'other' })).toThrow(ModelProviderError);
    expect(() => readProviderConfig({ MODEL_TIMEOUT_MS: '0' })).toThrow(ModelProviderError);
    expect(() =>
      createModelProvider({
        kind: 'openai-compatible',
        baseUrl: '',
        apiKey: SECRET_KEY,
        model: 'x',
        timeoutMs: 1000,
      }),
    ).toThrow(ModelProviderError);
    expect(() =>
      createModelProvider({
        kind: 'openai-compatible',
        baseUrl: 'https://x.test',
        apiKey: '',
        model: 'x',
        timeoutMs: 1000,
      }),
    ).toThrow(ModelProviderError);
  });
});
