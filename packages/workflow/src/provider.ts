/**
 * Provider 选择与配置（A1-1）。
 *
 * Mock / 真实 Provider 只由**配置**切换，代码路径完全一致：
 * - `MODEL_PROVIDER=mock`（默认）：不联网，确定性输出，供单测/CI；
 * - `MODEL_PROVIDER=openai-compatible`：读 `MODEL_BASE_URL` / `MODEL_API_KEY` / `MODEL_NAME`。
 *
 * 不提供管理页面输入 Key 的能力；Key 只来自环境变量。
 */

import type { ModelProvider } from './model-types.js';
import { ModelProviderError } from './model-types.js';
import { MockProvider } from './providers/mock.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible.js';

/** Provider 类型。 */
export type ModelProviderKind = 'mock' | 'openai-compatible';

/** 运行时配置（与 Provider 实现解耦）。 */
export interface ProviderRuntimeConfig {
  readonly kind: ModelProviderKind;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

function parseKind(raw: string | undefined): ModelProviderKind {
  const value = (raw ?? 'mock').trim().toLowerCase();
  if (value === '' || value === 'mock') {
    return 'mock';
  }
  if (value === 'openai-compatible' || value === 'openai') {
    return 'openai-compatible';
  }
  throw new ModelProviderError('MODEL_NOT_CONFIGURED', 'MODEL_PROVIDER 取值不合法');
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ModelProviderError('MODEL_NOT_CONFIGURED', 'MODEL_TIMEOUT_MS 取值不合法');
  }
  return value;
}

/**
 * 从环境变量读取配置。
 *
 * 只校验"形状"，不连接任何服务；真实连通性由首次调用暴露。
 */
export function readProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderRuntimeConfig {
  const kind = parseKind(env['MODEL_PROVIDER']);
  return {
    kind,
    baseUrl: (env['MODEL_BASE_URL'] ?? '').trim(),
    apiKey: (env['MODEL_API_KEY'] ?? '').trim(),
    model: (env['MODEL_NAME'] ?? '').trim(),
    timeoutMs: parseTimeout(env['MODEL_TIMEOUT_MS']),
  };
}

/** 按配置创建 Provider。 */
export function createModelProvider(config: ProviderRuntimeConfig): ModelProvider {
  if (config.kind === 'mock') {
    return new MockProvider();
  }
  return new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.timeoutMs,
  });
}

/** 便捷入口：读环境变量并创建 Provider。 */
export function createModelProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  return createModelProvider(readProviderConfig(env));
}
