/**
 * 连续性事实提取使用的模型 Provider（A2-B / A2-B-REV-01）。
 *
 * 生产：与 Worker 一致的 `MODEL_PROVIDER` 等环境变量。
 * - `mock`（默认）→ **事实专用** Mock（`{"facts": []}`），不是通用 Mock
 *   （通用 Mock 的 `{ok:true}` 过不了 fact 输出 Schema，会稳定 422）；
 * - `openai-compatible` → OpenAI 兼容 Provider。
 *
 * 配置缺失 / 非法时，`createModelProviderFromEnv()` 会抛 `ModelProviderError`
 * （`MODEL_NOT_CONFIGURED`）。这类错误发生在**任何数据库事务之前**，
 * 因此在构造边界统一映射为稳定的 502 `CONTINUITY_EXTRACTION_FAILED`：
 * 不建 run、不写候选、不写审计，也不回显 Key / Base URL / 环境变量。
 *
 * 测试：`setChapterFactProvider()` 注入确定性替身；`null` 复原。
 * 只影响本进程的 HTTP 路由，不改变 `ModelProvider` 契约。
 */

import { AuthError } from '@novel/auth';
import {
  createChapterFactProviderFromEnv,
  isModelProviderError,
  type ModelProvider,
} from '@novel/workflow';

let injected: ModelProvider | null = null;

/** 测试注入点：传入 `null` 表示恢复环境变量解析。 */
export function setChapterFactProvider(provider: ModelProvider | null): void {
  injected = provider;
}

/**
 * 本次请求使用的 Provider：注入优先，否则按环境变量创建。
 *
 * @throws AuthError `CONTINUITY_EXTRACTION_FAILED`（502）配置非法时
 */
export function chapterFactProvider(): ModelProvider {
  if (injected !== null) {
    return injected;
  }
  try {
    return createChapterFactProviderFromEnv();
  } catch (error) {
    // 只暴露稳定错误码：不把 Key / URL / 环境变量名带出去
    if (isModelProviderError(error)) {
      throw new AuthError('CONTINUITY_EXTRACTION_FAILED');
    }
    throw error;
  }
}
