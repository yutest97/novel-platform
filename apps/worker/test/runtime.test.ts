/**
 * Worker 运行时装配（A1-3C）。
 *
 * 不连数据库、不联网：
 * - 用空对象代替 PrismaClient（构造期不会访问数据库）；
 * - OpenAI 模式只构造 Provider，fetch 用 spy 证明未被调用。
 */

import type { PrismaClient } from '@novel/db';
import {
  createModelProvider,
  ModelProviderError,
  type ProviderRuntimeConfig,
} from '@novel/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkerConfigError } from '../src/config.js';
import { createWorkerRuntime } from '../src/runtime.js';

const db = {} as PrismaClient;
const KEY_MARKER = 'sk-live-a1-3c-must-not-leak';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWorkerRuntime', () => {
  it('Mock 模式启动：provider=mock / model=mock-model，runner 可用', () => {
    const runtime = createWorkerRuntime(db, { MODEL_PROVIDER: 'mock' });
    expect(runtime.provider.name).toBe('mock');
    expect(runtime.provider.defaultModel).toBe('mock-model');
    expect(runtime.runner.id).not.toBe('');
    expect(runtime.config.leaseMs).toBe(30_000);
  });

  it('Provider 只构造一次（执行与预检共用同一实例）', () => {
    const factory = vi.fn((config: ProviderRuntimeConfig) => createModelProvider(config));
    const runtime = createWorkerRuntime(
      db,
      { MODEL_PROVIDER: 'mock' },
      { createProvider: factory },
    );

    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.provider.name).toBe('mock');
    // runtime 暴露的就是工厂唯一一次构造的实例（工作流与预检共用）
    expect(runtime.provider).toBe(factory.mock.results[0]?.value);
  });

  it('OpenAI 兼容模式：只构造 Provider，不发起网络请求', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const runtime = createWorkerRuntime(db, {
      MODEL_PROVIDER: 'openai-compatible',
      MODEL_BASE_URL: 'https://model.example.test/v1',
      MODEL_NAME: 'runtime-test-model',
      MODEL_API_KEY: KEY_MARKER,
    });

    expect(runtime.provider.name).toBe('openai-compatible');
    expect(runtime.provider.defaultModel).toBe('runtime-test-model');
    expect(fetchSpy).not.toHaveBeenCalled();
    // 序列化 Provider 时只暴露身份，不带 Key
    expect(JSON.stringify(runtime.provider)).not.toContain(KEY_MARKER);
  });

  it('模型配置非法 → ModelProviderError，消息不含 Key', () => {
    try {
      createWorkerRuntime(db, {
        MODEL_PROVIDER: 'openai-compatible',
        MODEL_BASE_URL: 'not-a-url',
        MODEL_NAME: 'runtime-test-model',
        MODEL_API_KEY: KEY_MARKER,
      });
      throw new Error('应当抛出 ModelProviderError');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelProviderError);
      expect((error as Error).message).not.toContain(KEY_MARKER);
    }
  });

  it('Worker 配置非法时在构造 Provider 之前失败', () => {
    const factory = vi.fn((config: ProviderRuntimeConfig) => createModelProvider(config));
    expect(() =>
      createWorkerRuntime(
        db,
        { MODEL_PROVIDER: 'mock', WORKER_LEASE_MS: '30000', WORKER_HEARTBEAT_MS: '30000' },
        { createProvider: factory },
      ),
    ).toThrowError(WorkerConfigError);
    expect(factory).not.toHaveBeenCalled();
  });
});
