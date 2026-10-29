import type { HealthComponent } from '@novel/shared';

import { getPrismaClient } from './client.js';

/** 数据库探测的默认超时（毫秒）。 */
export const DB_PROBE_TIMEOUT_MS = 3000;

/**
 * 探测数据库连接状态。
 *
 * 关键约束：数据库连接失败时必须返回 `error` 状态，使健康检查返回 503，
 * 绝不能因异常被吞掉而"永远返回 OK"。
 */
export async function probeDatabase(
  timeoutMs: number = DB_PROBE_TIMEOUT_MS,
): Promise<HealthComponent> {
  const startedAt = Date.now();
  try {
    const client = getPrismaClient();
    await withTimeout(client.$queryRawUnsafe('SELECT 1'), timeoutMs);
    return {
      name: 'database',
      status: 'ok',
      detail: '连接正常',
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      name: 'database',
      status: 'error',
      detail: describeError(error),
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** 把任意异常转换为不泄露敏感信息的简短描述。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    // 只取错误名与首行消息，避免把连接串（含密码）写入日志或健康检查响应。
    const firstLine = error.message.split('\n')[0] ?? '';
    return `${error.name}: ${firstLine}`;
  }
  return '未知错误';
}

/** 为 Promise 增加超时控制。 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`操作超时（${timeoutMs}ms）`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
