/**
 * workflow 包测试辅助（A1-1）。
 *
 * 与其它后端包一致：集成测试连真实 PostgreSQL，缺少 DATABASE_URL 直接失败。
 * 每个用例自建 user/work/chapter，结束后按 "任务 → 章节 → 作品 → 用户" 顺序清理
 * （generation_tasks 对 works 是 RESTRICT，顺序不能反）。
 */

import { randomUUID } from 'node:crypto';

import { disconnectPrisma, getPrismaClient, type PrismaClient } from '@novel/db';

/** 断言并返回 DATABASE_URL。 */
export function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error('集成测试需要真实 PostgreSQL：请设置 DATABASE_URL 并先执行 pnpm db:deploy。');
  }
  return url;
}

/** 共享 Prisma 客户端。 */
export function testDb(): PrismaClient {
  requireDatabaseUrl();
  return getPrismaClient();
}

/** 断开连接。 */
export async function closeTestDb(): Promise<void> {
  await disconnectPrisma();
}

/** 创建一个测试用户。 */
export async function createTestUser(
  db: PrismaClient,
  role: 'author' | 'admin' = 'author',
): Promise<{ id: string; email: string }> {
  const email = `a1-${role}-${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: {
      email,
      passwordHash: '$argon2id$stub',
      role,
      status: 'active',
      mustChangePassword: false,
    },
    select: { id: true, email: true },
  });
  return user;
}

/** 创建一个测试作品。 */
export async function createTestWork(
  db: PrismaClient,
  authorId: string,
  title = `A1 作品-${randomUUID().slice(0, 8)}`,
): Promise<{ id: string; title: string }> {
  const work = await db.work.create({
    data: { authorId, title, genreRulePackage: 'xuanhuan' },
    select: { id: true, title: true },
  });
  return work;
}

/** 创建一章（默认第 1 章）。 */
export async function createTestChapter(
  db: PrismaClient,
  workId: string,
  chapterNo = 1,
): Promise<{ id: string; chapterNo: number }> {
  const chapter = await db.chapter.create({
    data: { workId, chapterNo, title: `第 ${chapterNo} 章` },
    select: { id: true, chapterNo: true },
  });
  return chapter;
}

/**
 * 清理一个作品下的全部测试数据。
 *
 * 顺序：候选 → 合同 → 任务（上下文/日志级联）→ 章节 → 作品。
 * 合同/候选对任务、章节、作品都是 RESTRICT，顺序不能反。
 */
export async function cleanupWork(db: PrismaClient, workId: string): Promise<void> {
  await db.chapterCandidate.deleteMany({ where: { workId } });
  await db.chapterContract.deleteMany({ where: { workId } });
  await db.generationTask.deleteMany({ where: { workId } });
  await db.chapter.deleteMany({ where: { workId } });
  await db.work.deleteMany({ where: { id: workId } });
}

/** 清理用户（作品已清理后）。 */
export async function cleanupUser(db: PrismaClient, userId: string): Promise<void> {
  await db.user.deleteMany({ where: { id: userId } });
}

/** 静默 Worker 日志（测试不打印任务内容）。 */
export const silentLogger = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};
