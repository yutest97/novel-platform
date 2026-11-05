/**
 * 连续性事实提取的 Provider 解析（A2-B-REV-01）。
 *
 * 与章节流水线一致：`MODEL_PROVIDER=mock` 时不能直接用通用 MockProvider
 * （默认输出 `{ok:true}` 过不了 fact 输出 Schema），必须换成事实专用 Mock。
 *
 * 这里只负责"按配置创建"，不做 HTTP 映射；配置非法时照常抛
 * `ModelProviderError`（`MODEL_NOT_CONFIGURED`），由调用方决定对外错误码。
 */

import type { ModelProvider } from '../model-types.js';
import { createModelProvider, readProviderConfig } from '../provider.js';
import { createContinuityFactsMockProvider } from './facts-mock.js';

/**
 * 按环境变量创建事实提取 Provider。
 *
 * - `MODEL_PROVIDER=mock`（默认）→ 事实专用 Mock（`{"facts": []}`）；
 * - `MODEL_PROVIDER=openai-compatible` → OpenAI 兼容 Provider（真实网络调用）；
 * - 其它取值 / 非法超时 → `ModelProviderError`（`MODEL_NOT_CONFIGURED`）。
 */
export function createChapterFactProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ModelProvider {
  const config = readProviderConfig(env);
  if (config.kind === 'mock') {
    return createContinuityFactsMockProvider();
  }
  return createModelProvider(config);
}
