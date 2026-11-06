/**
 * Worker 进程入口（A1-3C / A1-3C-REV-01）。
 *
 * 启动顺序：
 *   1. 读取运行配置（非法直接退出，退出码 1）；
 *   2. 构造 Provider（只构造一次）与 `chapter.draft` 注册表；
 *   3. 构造 supervisor（初始 starting）与健康检查服务（读取 supervisor 快照）；
 *   4. 启动 supervisor：直接调用 `runOnce()`，首次正常返回后进入 ready。
 *
 * 关闭顺序（SIGTERM / SIGINT）：
 *   supervisor.stop()（先置 stopping）→ 关闭健康检查端口 → 等待当前 runOnce 退出
 *   → Prisma disconnect → 退出码 0；超过总时限则强制退出（任务由租约回收）。
 *
 * 瞬态错误（Prisma 初始化/连接、P2021 缺表、57P01/57P03 等）：进入 retrying，
 * 1s→5s 退避后重试；/healthz 返回 503（不伪装健康），迁移/连接恢复后自动 ready + 200。
 * 永久错误（业务 WorkflowError、P2022 缺列、TypeError/ReferenceError/未知异常）：
 * loop=failed，进程退出码 1，由容器重启策略决定是否恢复。
 *
 * 日志约束：只打印 taskId / taskType / 状态 / 稳定错误码 / provider 名称，
 * 绝不打印 prompt、正文、API Key、任务快照或原始异常消息（可能含连接串）。
 */

import { disconnectPrisma, getPrismaClient } from '@novel/db';
import { ModelProviderError, type WorkerLogger } from '@novel/workflow';

import { WorkerConfigError } from './config.js';
import { safeWorkerLoopErrorCode } from './loop-errors.js';
import { createWorkerRuntime } from './runtime.js';
import { startHealthServer } from './server.js';
import { mergeWorkerLoopSnapshots, WorkerLoopSupervisor } from './supervisor.js';

/** 关闭总时限：超时强制退出，未完成的任务交给租约回收。 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

const logger: WorkerLogger = {
  info: (message, meta) => {
    console.log(`[worker] ${message}`, meta ?? '');
  },
  warn: (message, meta) => {
    console.warn(`[worker] ${message}`, meta ?? '');
  },
  error: (message, meta) => {
    console.error(`[worker] ${message}`, meta ?? '');
  },
};

/** 启动阶段的错误摘要：只对白名单错误类型打印消息。 */
function describeStartupError(error: unknown): string {
  if (error instanceof WorkerConfigError) {
    return `配置错误：${error.message}`;
  }
  if (error instanceof ModelProviderError) {
    return `模型配置错误：${error.message}`;
  }
  return `启动失败，code=${safeWorkerLoopErrorCode(error)}`;
}

function main(): void {
  // 关闭 Prisma 自身的原始错误输出：循环错误统一由 supervisor 记录安全 code，
  // 避免缺表 / 连接串等信息直接进入 stdout/stderr。
  const db = getPrismaClient({ log: [] });
  const runtime = createWorkerRuntime(db);
  const { config, provider, novelProvider, runner, novelRunner } = runtime;

  // 两条独立循环：generation tasks 与 novel runs。共享同一 supervisor 语义，
  // 健康检查合并两者快照（任一永久失败即 503 / 退出进程）。
  const supervisor = new WorkerLoopSupervisor({
    runner,
    pollIntervalMs: config.pollIntervalMs,
    logger,
  });
  const novelSupervisor = new WorkerLoopSupervisor({
    runner: novelRunner,
    pollIntervalMs: config.pollIntervalMs,
    logger,
  });
  const server = startHealthServer(config.port, {
    loopState: () => mergeWorkerLoopSnapshots([supervisor.snapshot(), novelSupervisor.snapshot()]),
  });

  let shuttingDown = false;

  const closeHealthServer = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
        server.closeIdleConnections();
      } catch {
        // 端口未成功监听：无需再关闭，直接进入下一步。
        resolve();
      }
    });
  };

  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // stopping 必须先于关闭健康端口，避免关闭窗口里仍显示 ready。
    supervisor.stop();
    novelSupervisor.stop();
    runner.stop();
    novelRunner.stop();
    console.log(`[worker] 收到 ${signal}，停止领取新任务……`);

    // 总时限兜底：包括"正在执行的任务"在内，超过时限一律强制退出。
    const forceTimer = setTimeout(() => {
      console.warn('[worker] 关闭超时，强制退出');
      process.exit(exitCode);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    await closeHealthServer();

    try {
      await Promise.all([workerLoop, novelLoop]);
    } catch (error) {
      console.warn(`[worker] 轮询循环异常结束，code=${safeWorkerLoopErrorCode(error)}`);
    }

    try {
      await disconnectPrisma();
    } catch {
      // 连接已断开 / 从未建立：不打印原始错误。
    }

    clearTimeout(forceTimer);
    console.log('[worker] 已停止');
    process.exit(exitCode);
  };

  const workerLoop = supervisor
    .run()
    .then((result) => {
      if (result.status === 'failed') {
        console.error(`[worker] 生成任务轮询永久失败，code=${result.errorCode}`);
        void shutdown('WORKER_LOOP_FAILED', 1);
      }
    })
    .catch((error: unknown) => {
      console.error(`[worker] 生成任务 supervisor 异常，code=${safeWorkerLoopErrorCode(error)}`);
      void shutdown('WORKER_SUPERVISOR_ERROR', 1);
    });

  const novelLoop = novelSupervisor
    .run()
    .then((result) => {
      if (result.status === 'failed') {
        console.error(`[worker] 小说问答轮询永久失败，code=${result.errorCode}`);
        void shutdown('WORKER_NOVEL_LOOP_FAILED', 1);
      }
    })
    .catch((error: unknown) => {
      console.error(`[worker] 小说问答 supervisor 异常，code=${safeWorkerLoopErrorCode(error)}`);
      void shutdown('WORKER_NOVEL_SUPERVISOR_ERROR', 1);
    });

  console.log(
    `[worker] 运行参数：id=${runner.id} provider=${provider.name} model=${provider.defaultModel} ` +
      `novelProvider=${novelProvider.name} novelModel=${novelProvider.defaultModel} ` +
      `lease=${config.leaseMs}ms poll=${config.pollIntervalMs}ms sweep=${config.sweepIntervalMs}ms`,
  );

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });
}

process.on('uncaughtException', (error: unknown) => {
  // 不打印 error.message：可能包含连接串、prompt 或正文。
  console.error(`[worker] 未捕获异常，code=${safeWorkerLoopErrorCode(error)}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error(`[worker] 未处理的 Promise 拒绝，code=${safeWorkerLoopErrorCode(reason)}`);
  process.exit(1);
});

try {
  main();
} catch (error: unknown) {
  console.error(`[worker] ${describeStartupError(error)}`);
  process.exit(1);
}
