/**
 * 连续性事实专用 MockProvider（A2-B-REV-01）。
 *
 * 背景：通用 `MockProvider` 的默认输出是 `{ok:true}`，无法通过
 * `continuity.extractor` 的输出 Schema，因此 `MODEL_PROVIDER=mock`（默认值）
 * 下提取会稳定得到 422 —— 与"本地与 CI 无网络可运行"的约定矛盾。
 *
 * 本模块提供事实专用 Mock：
 * - 固定输出 `{"facts": []}`：对任意章节 / 任意实体上下文都合法，
 *   表示"本章没有可提取的变化"；
 * - 身份仍是 `name=mock / defaultModel=mock-model`，与真实 Provider 的落库字段一致；
 * - 不联网、不读 Key、不读系统时钟（由 `MockProvider` 保证确定性）。
 *
 * 只用于 `MODEL_PROVIDER=mock`；生产仍走 OpenAI 兼容 Provider。
 */

import type { ModelProvider } from '../model-types.js';
import { MockProvider } from '../providers/mock.js';

/** Mock 模式下事实提取的固定输出（严格符合 factOutputSchema）。 */
export const CONTINUITY_FACTS_MOCK_OUTPUT = { facts: [] } as const;

/** 创建事实提取专用 Mock Provider。 */
export function createContinuityFactsMockProvider(): ModelProvider {
  return new MockProvider({ json: { facts: [] }, latencyMs: 0 });
}
