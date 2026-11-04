/**
 * MockProvider（A1-1）。
 *
 * 证明：确定性、无网络、深拷贝隔离、错误以 rejection 形式出现。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockProvider } from '../src/providers/mock.js';
import type { ModelJsonInput } from '../src/model-types.js';

const input: ModelJsonInput = {
  model: 'mock-model',
  maxOutputTokens: 128,
  messages: [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '{"question":"你好"}' },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MockProvider', () => {
  it('defaultModel 默认 mock-model，可配置且空白回落', () => {
    expect(new MockProvider().defaultModel).toBe('mock-model');
    expect(new MockProvider({ model: 'mock-large' }).defaultModel).toBe('mock-large');
    expect(new MockProvider({ model: '   ' }).defaultModel).toBe('mock-model');
  });

  it('默认输出固定，不联网', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('不应联网')));
    vi.stubGlobal('fetch', fetchSpy);

    const provider = new MockProvider();
    const first = await provider.generateJson(input);
    const second = await provider.generateJson(input);

    expect(first.json).toEqual({ ok: true });
    expect(first).toEqual(second);
    expect(first.provider).toBe('mock');
    expect(first.model).toBe('mock-model');
    expect(first.usage.promptTokens).toBeGreaterThan(0);
    expect(first.latencyMs).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('支持按输入计算的纯函数输出', async () => {
    const provider = new MockProvider({
      json: (value) => ({ echoed: value.messages.at(-1)?.content ?? '' }),
    });
    const result = await provider.generateJson(input);
    expect(result.json).toEqual({ echoed: '{"question":"你好"}' });
  });

  it('返回深拷贝，调用方修改不污染下一次调用', async () => {
    const provider = new MockProvider({ json: { items: ['a'] } });
    const first = await provider.generateJson(input);
    (first.json as { items: string[] }).items.push('b');

    const second = await provider.generateJson(input);
    expect(second.json).toEqual({ items: ['a'] });
  });

  it('文本输出同样确定', async () => {
    const provider = new MockProvider({ text: '固定文本', latencyMs: 7 });
    const result = await provider.generateText(input);
    expect(result.text).toBe('固定文本');
    expect(result.latencyMs).toBe(7);
    expect(result.usage.completionTokens).toBeGreaterThan(0);
  });

  it('responder 抛错时以 rejection 形式出现', async () => {
    const provider = new MockProvider({
      json: () => {
        throw new Error('模拟失败');
      },
    });
    await expect(provider.generateJson(input)).rejects.toThrow('模拟失败');
  });
});
