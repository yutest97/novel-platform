/**
 * 测试辅助：连接真实 PostgreSQL。
 *
 * 集成测试连真实数据库；缺少 DATABASE_URL 时**直接失败**（不静默跳过）。
 */

import { randomUUID } from 'node:crypto';

import { disconnectPrisma, getPrismaClient, type PrismaClient } from '@novel/db';

/** 断言 DATABASE_URL 存在，否则抛出明确错误。 */
export function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error('集成测试需要真实 PostgreSQL：请设置 DATABASE_URL 并先执行 pnpm db:deploy。');
  }
  return url;
}

/** 共享的 Prisma 客户端（与生产共用同一单例）。 */
export function testDb(): PrismaClient {
  requireDatabaseUrl();
  return getPrismaClient();
}

/** 断开连接（测试结束时调用）。 */
export async function closeTestDb(): Promise<void> {
  await disconnectPrisma();
}

/** 生成唯一邮箱。 */
export function uniqueEmail(prefix = 'work'): string {
  return `${prefix}-${randomUUID()}@example.test`;
}
