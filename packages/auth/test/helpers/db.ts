/**
 * 集成测试的数据库工具。
 *
 * 说明：
 * - 集成测试**必须**有真实 PostgreSQL。缺少 DATABASE_URL 时直接失败，
 *   不允许静默跳过（否则 CI 可能在"没有数据库"的情况下显示绿色）。
 * - audit_logs 是 append-only（数据库触发器禁止 DELETE），因此测试**不清理**
 *   审计记录；测试账号使用随机邮箱，互不干扰。
 */

import { randomUUID } from 'node:crypto';

import { disconnectPrisma, getPrismaClient, type PrismaClient } from '@novel/db';

import { readAuthConfig, type AuthConfig } from '../../src/config.js';
import { hashPassword } from '../../src/password.js';

/** 测试账号邮箱前缀。 */
export const TEST_EMAIL_PREFIX = 'm1b1-test-';

/** 断言 DATABASE_URL 存在，否则抛出明确错误。 */
export function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error(
      '集成测试需要真实 PostgreSQL：请设置 DATABASE_URL 并先执行 pnpm --filter @novel/db migrate:deploy',
    );
  }
  return url;
}

/** 获取测试用 Prisma 客户端（与生产共用同一单例）。 */
export function testDb(): PrismaClient {
  return getPrismaClient();
}

/** 关闭数据库连接（测试结束后调用）。 */
export async function closeTestDb(): Promise<void> {
  await disconnectPrisma();
}

/** 生成唯一测试邮箱。 */
export function uniqueEmail(tag = 'user'): string {
  return `${TEST_EMAIL_PREFIX}${tag}-${randomUUID()}@example.test`;
}

/** 测试用认证配置（有效期缩短，便于断言）。 */
export function testConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  const base = readAuthConfig({
    AUTH_SESSION_ABSOLUTE_HOURS: '2',
    AUTH_SESSION_IDLE_MINUTES: '30',
    AUTH_LOGIN_MAX_ATTEMPTS: '5',
    AUTH_LOGIN_WINDOW_MINUTES: '15',
  });
  return { ...base, ...overrides };
}

/** 创建一个测试账号。 */
export async function createTestUser(
  db: PrismaClient,
  options: {
    password?: string;
    role?: 'admin' | 'author';
    status?: 'active' | 'disabled';
    mustChangePassword?: boolean;
    email?: string;
  } = {},
): Promise<{ id: string; email: string; password: string }> {
  const email = options.email ?? uniqueEmail();
  const password = options.password ?? 'test-password-1234';
  const passwordHash = await hashPassword(password);

  const user = await db.user.create({
    data: {
      email,
      passwordHash,
      role: options.role ?? 'author',
      status: options.status ?? 'active',
      mustChangePassword: options.mustChangePassword ?? false,
    },
    select: { id: true },
  });

  return { id: user.id, email, password };
}
