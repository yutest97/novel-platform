/**
 * Worker 运行时装配（A1-3C）。
 *
 * 启动时**只构造一次** Provider，并把同一个实例同时交给：
 * - `chapter.draft` 工作流（Planner / Writer 的实际模型调用）；
 * - `WorkerRunner` 的预检（任务记录的 provider/model 必须与它一致）。
 *
 * 这样不会出现「预检用一个 Provider、执行用另一个 Provider」的漂移。
 */

import type { PrismaClient } from '@novel/db';
import {
  createChapterDraftWorkflow,
  createChapterMockProvider,
  createChapterReviewWorkflow,
  createChapterSummaryWorkflow,
  createModelProvider,
  createNovelCoordinatorMockProvider,
  NovelCoordinatorWorker,
  readProviderConfig,
  WorkflowKernel,
  WorkflowRegistry,
  WorkerRunner,
  type ModelProvider,
  type ProviderRuntimeConfig,
} from '@novel/workflow';

import { readWorkerRuntimeConfig, type WorkerRuntimeConfig } from './config.js';

/** 装配结果（不启动任何循环 / 端口）。 */
export interface WorkerRuntime {
  readonly provider: ModelProvider;
  readonly novelProvider: ModelProvider;
  readonly config: WorkerRuntimeConfig;
  readonly runner: WorkerRunner;
  readonly novelRunner: NovelCoordinatorWorker;
}

/** 测试注入点：默认 `createModelProvider` / Coordinator Mock，生产不传。 */
export interface WorkerRuntimeDeps {
  readonly createProvider?: (config: ProviderRuntimeConfig) => ModelProvider;
  readonly createNovelProvider?: (config: ProviderRuntimeConfig) => ModelProvider;
}

/**
 * 构造 Worker 运行时。
 *
 * 不做任何数据库连接或网络请求：健康检查与轮询由 `index.ts` 启动。
 * 配置错误（`WorkerConfigError` / `ModelProviderError`）原样抛出，
 * 由进程入口转成安全日志 + 退出码 1。
 */
export function createWorkerRuntime(
  db: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
  deps: WorkerRuntimeDeps = {},
): WorkerRuntime {
  const config = readWorkerRuntimeConfig(env);
  const providerConfig = readProviderConfig(env);
  // 只构造一次：同一个实例同时用于工作流执行与 Worker 预检。
  // Mock 模式使用章节专用输出（通用 MockProvider 的默认值无法通过 Planner Schema）。
  const provider =
    deps.createProvider !== undefined
      ? deps.createProvider(providerConfig)
      : providerConfig.kind === 'mock'
        ? createChapterMockProvider()
        : createModelProvider(providerConfig);

  // C1-A：Coordinator 只做语义决策，Mock 输出必须符合 Coordinator Schema，
  // 因此与章节流水线的 Mock 分开构造；真实 Provider 复用同一配置。
  const novelProvider =
    deps.createNovelProvider !== undefined
      ? deps.createNovelProvider(providerConfig)
      : providerConfig.kind === 'mock'
        ? createNovelCoordinatorMockProvider()
        : createModelProvider(providerConfig);

  const registry = new WorkflowRegistry();
  registry.register(createChapterDraftWorkflow({ db, provider }));
  // A2-C-B：候选审阅是独立任务，与正文生成共用同一个 Provider 实例。
  registry.register(createChapterReviewWorkflow({ db, provider }));
  // A2-D-B：定稿章节摘要是独立任务，同样复用同一个 Provider 实例。
  registry.register(createChapterSummaryWorkflow({ db, provider }));

  const runner = new WorkerRunner(db, new WorkflowKernel(registry), {
    provider,
    ...(config.workerId === undefined ? {} : { workerId: config.workerId }),
    leaseMs: config.leaseMs,
    ...(config.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: config.heartbeatIntervalMs }),
    pollIntervalMs: config.pollIntervalMs,
    sweepIntervalMs: config.sweepIntervalMs,
  });

  // C1-A：Coordinator 轮询与 generation task 轮询共用一个 supervisor 策略，
  // 由 index.ts 启动独立循环，任一循环永久失败都退出进程。
  const novelRunner = new NovelCoordinatorWorker(db, {
    provider: novelProvider,
    ...(config.workerId === undefined ? {} : { workerId: `${config.workerId}:novel` }),
    leaseMs: config.leaseMs,
    ...(config.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: config.heartbeatIntervalMs }),
    sweepIntervalMs: config.sweepIntervalMs,
  });

  return { provider, novelProvider, config, runner, novelRunner };
}
