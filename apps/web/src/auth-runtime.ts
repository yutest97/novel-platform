/**
 * 认证运行期单例。
 *
 * 限流器必须跨请求共享计数，因此放在模块作用域；
 * Prisma 客户端本身由 @novel/db 保证全环境单例复用。
 */

import { FixedWindowRateLimiter, readAuthConfig, type AuthConfig } from '@novel/auth';
import { getPrismaClient } from '@novel/db';

/** 进程级登录限流器。 */
export const loginLimiter = new FixedWindowRateLimiter({
  maxAttempts: readAuthConfig().loginMaxAttempts,
  windowMs: readAuthConfig().loginWindowMs,
});

/** 获取 Prisma 客户端（全环境复用同一实例）。 */
export function db() {
  return getPrismaClient();
}

/** 读取当前认证配置。 */
export function authConfig(): AuthConfig {
  return readAuthConfig();
}
