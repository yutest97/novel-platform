/**
 * 连续性事实提取使用的模型 Provider（A2-B）。
 *
 * 生产：与 Worker 完全一致，读 `MODEL_PROVIDER` 等环境变量。
 * 测试：`setChapterFactProvider()` 注入确定性替身（路由处理函数无法从外部传参，
 * 因此需要一个进程内的替换点）；`setChapterFactProvider(null)` 复原。
 *
 * 只影响本进程的 HTTP 路由，不改变 `ModelProvider` 契约，也不缓存请求结果。
 */

import { createModelProviderFromEnv, type ModelProvider } from '@novel/workflow';

let injected: ModelProvider | null = null;

/** 测试注入点：传入 `null` 表示恢复环境变量解析。 */
export function setChapterFactProvider(provider: ModelProvider | null): void {
  injected = provider;
}

/** 本次请求使用的 Provider：注入优先，否则按环境变量创建。 */
export function chapterFactProvider(): ModelProvider {
  return injected ?? createModelProviderFromEnv();
}
