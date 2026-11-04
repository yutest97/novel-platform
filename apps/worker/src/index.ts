/**
 * Worker 进程入口（A1-3C）。
 *
 * 启动顺序：
 *   1. 读取运行配置（非法直接退出，退出码 1）；
 *   2. 构造 Provider（只构造一次）与 `chapter.draft` 注册表；
 *   3. 启动健康检查 HTTP 服务；
 *   4. 并发启动 WorkerRunner 轮询循环。
 *
 * 关闭顺序（SIGTERM / SIGINT）：
 *   WorkerRunner.stop() → 关闭健康检查端口 → 等待当前轮询退出 → Prisma disconnect
 *   → 退出码 0；超过总时限则强制退出（未完成的任务由租约回收）。
 *
 * 轮询循环异常（例如数据库尚未迁移、临时不可用）：记录稳定错误码，退避后重启循环；
 * 进程与 /healthz 保持存活，等数据库就绪后自动继续消费。只有**未捕获异常**才退出码 1。
 *
 * 日志约束：只打印 taskId / taskType / 状态 / 稳定错误码 / provider 名称，
 * 绝不打印 prompt、正文、API Key、任务快照或原始异常消息（可能含连接串）。
 */

import { disconnectPrisma, getPrismaClient } from '@novel/db';
import { ModelProviderError, WorkflowError } from '@novel/workflow';

import { WorkerConfigError } from './config.js';
import { createWorkerRuntime } from './runtime.js';
import { startHealthServer } from './server.js';

/** 关闭总时限：超时强制退出，未完成的任务交给租约回收。 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

/** 轮询循环失败后的退避区间（空库未迁移 / 数据库短暂不可用时保持进程存活）。 */
const MIN_LOOP_RETRY_MS = 1_000;
const MAX_LOOP_RETRY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 把任意异常收敛成可安全打印的错误码（不打印 message）。 */
function safeErrorCode(error: unknown): string {
  return error instanceof WorkflowError ? error.code : 'WORKFLOW_INTERNAL_ERROR';
}

/** 启动阶段的错误摘要：只对白名单错误类型打印消息。 */
function describeStartupError(error: unknown): string {
  if (error instanceof WorkerConfigError) {
    return `配置错误：${error.message}`;
  }
  if (error instanceof ModelProviderError) {
    return `模型配置错误：${error.message}`;
  }
  return `启动失败，code=${safeErrorCode(error)}`;
}

function main(): void {
  const db = getPrismaClient();
  const runtime = createWorkerRuntime(db);
  const { config, provider, runner } = runtime;

  const server = startHealthServer(config.port);

  console.log(
    `[worker] 运行参数：id=${runner.id} provider=${provider.name} model=${provider.defaultModel} ` +
      `lease=${config.leaseMs}ms poll=${config.pollIntervalMs}ms sweep=${config.sweepIntervalMs}ms`,
  );

  // 健康检查与任务轮询并发：轮询循环失败时进程与健康检查继续存活。
  let retiring = false;

  const superviseLoop = async (): Promise<void> => {
    let retryMs = MIN_LOOP_RETRY_MS;
    while (!retiring) {
      try {
        await runner.start();
        return;
      } catch (error) {
        if (retiring) {
          return;
        }
        console.error(`[worker] 轮询循环失败，code=${safeErrorCode(error)}；${retryMs}ms 后重试`);
        await sleep(retryMs);
        retryMs = Math.min(retryMs * 2, MAX_LOOP_RETRY_MS);
      }
    }
  };

  const workerLoop = superviseLoop();

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
    retiring = true;
    console.log(`[worker] 收到 ${signal}，停止领取新任务……`);

    // 总时限兜底：包括"正在执行的任务"在内，超过时限一律强制退出。
    const forceTimer = setTimeout(() => {
      console.warn('[worker] 关闭超时，强制退出');
      process.exit(exitCode);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    runner.stop();
    await closeHealthServer();

    try {
      await workerLoop;
    } catch (error) {
      console.warn(`[worker] 轮询循环异常结束，code=${safeErrorCode(error)}`);
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

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });
}

process.on('uncaughtException', (error: unknown) => {
  // 不打印 error.message：可能包含连接串、prompt 或正文。
  console.error(`[worker] 未捕获异常，code=${safeErrorCode(error)}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error(`[worker] 未处理的 Promise 拒绝，code=${safeErrorCode(reason)}`);
  process.exit(1);
});

try {
  main();
} catch (error: unknown) {
  console.error(`[worker] ${describeStartupError(error)}`);
  process.exit(1);
}
