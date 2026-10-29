import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthError } from '../src/errors.js';
import {
  authenticateToken,
  computeExpiries,
  createSession,
  findSessionByToken,
  revokeAllSessions,
} from '../src/sessions.js';
import { hashSessionToken } from '../src/token.js';
import {
  closeTestDb,
  createTestUser,
  requireDatabaseUrl,
  testConfig,
  testDb,
} from './helpers/db.js';

describe('会话（真实 PostgreSQL）', () => {
  beforeAll(() => {
    requireDatabaseUrl();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('数据库只保存令牌哈希，不保存令牌本身', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();

    const issued = await createSession(db, { userId: user.id, config });

    const row = await db.session.findUniqueOrThrow({ where: { id: issued.sessionId } });

    expect(row.tokenHash).toBe(hashSessionToken(issued.token));
    expect(row.tokenHash).not.toBe(issued.token);
    // 整行序列化后不得出现令牌明文
    expect(JSON.stringify(row)).not.toContain(issued.token);
  });

  it('同时计算绝对有效期与空闲有效期，且空闲不超过绝对', () => {
    const config = testConfig({
      sessionAbsoluteTtlMs: 2 * 60 * 60 * 1000,
      sessionIdleTtlMs: 30 * 60 * 1000,
    });
    const now = new Date('2026-01-01T00:00:00.000Z');

    const { absoluteExpiresAt, idleExpiresAt } = computeExpiries(config, now);

    expect(absoluteExpiresAt.toISOString()).toBe('2026-01-01T02:00:00.000Z');
    expect(idleExpiresAt.toISOString()).toBe('2026-01-01T00:30:00.000Z');
    expect(idleExpiresAt.getTime()).toBeLessThanOrEqual(absoluteExpiresAt.getTime());
  });

  it('空闲有效期到期后会话失效，并被清理', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig({ sessionIdleTtlMs: 60_000, sessionAbsoluteTtlMs: 3_600_000 });
    const issued = await createSession(db, { userId: user.id, config });

    const later = new Date(Date.now() + 61_000);
    await expect(
      authenticateToken(db, issued.token, config, { now: later, allowPasswordChangePending: true }),
    ).rejects.toThrowError(AuthError);

    await expect(db.session.findUnique({ where: { id: issued.sessionId } })).resolves.toBeNull();
  });

  it('绝对有效期到期后会话失效（即使一直有活动）', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig({ sessionIdleTtlMs: 600_000, sessionAbsoluteTtlMs: 120_000 });
    const issued = await createSession(db, { userId: user.id, config });

    const later = new Date(Date.now() + 120_001);
    await expect(
      authenticateToken(db, issued.token, config, { now: later, allowPasswordChangePending: true }),
    ).rejects.toThrowError(AuthError);
  });

  it('每次校验都会刷新空闲有效期', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig({ sessionIdleTtlMs: 600_000, sessionAbsoluteTtlMs: 7_200_000 });
    const issued = await createSession(db, { userId: user.id, config });

    const later = new Date(Date.now() + 300_000);
    const context = await authenticateToken(db, issued.token, config, {
      now: later,
      allowPasswordChangePending: true,
    });

    expect(context.idleExpiresAt.getTime()).toBe(later.getTime() + 600_000);
    const row = await db.session.findUniqueOrThrow({ where: { id: issued.sessionId } });
    expect(row.idleExpiresAt.getTime()).toBe(context.idleExpiresAt.getTime());
  });

  it('每个账号最多 5 个活跃会话，第 6 个出现时淘汰最旧会话', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();

    const issued = [];
    for (let index = 0; index < 6; index += 1) {
      issued.push(await createSession(db, { userId: user.id, config }));
    }

    const active = await db.session.findMany({ where: { userId: user.id } });
    expect(active.length).toBe(5);

    // 第 1 个（最旧）被淘汰，第 2–6 个保留
    await expect(findSessionByToken(db, issued[0]?.token ?? '')).resolves.toBeNull();
    for (const kept of issued.slice(1)) {
      await expect(findSessionByToken(db, kept.token)).resolves.not.toBeNull();
    }
  });

  it('账号停用后其全部会话立即失效', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();

    const first = await createSession(db, { userId: user.id, config });
    const second = await createSession(db, { userId: user.id, config });

    await db.user.update({ where: { id: user.id }, data: { status: 'disabled' } });

    await expect(
      authenticateToken(db, first.token, config, { allowPasswordChangePending: true }),
    ).rejects.toThrowError(/已停用/);
    // 第一次校验时该账号的全部会话已被清除，因此第二个令牌直接变成"未登录"。
    // 两种结果都满足"停用后不能继续使用任何既有 Cookie"。
    await expect(
      authenticateToken(db, second.token, config, { allowPasswordChangePending: true }),
    ).rejects.toThrowError(/未登录/);

    // 校验失败时该账号的会话已被清空
    await expect(db.session.count({ where: { userId: user.id } })).resolves.toBe(0);
  });

  it('吊销会话后令牌立即不可用', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();
    const issued = await createSession(db, { userId: user.id, config });

    await revokeAllSessions(db, user.id);

    await expect(
      authenticateToken(db, issued.token, config, { allowPasswordChangePending: true }),
    ).rejects.toThrowError(AuthError);
  });

  it('未知令牌一律 401 语义', async () => {
    const db = testDb();
    const config = testConfig();

    await expect(
      authenticateToken(db, 'not-a-real-token', config, { allowPasswordChangePending: true }),
    ).rejects.toThrowError(/未登录/);
  });
});
