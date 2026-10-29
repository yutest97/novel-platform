/**
 * 审计原子性（REV-01 第 2 条）。
 *
 * 用**数据库级故障注入**（临时触发器让 audit_logs 的 INSERT 抛错）验证：
 * 审计写入失败时，业务修改必须回滚，不能出现"改了但没审计"的状态。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSession } from '../src/sessions.js';
import { createInitialAdmin, setUserStatus, adminResetPassword } from '../src/users.js';
import {
  closeTestDb,
  createTestUser,
  requireDatabaseUrl,
  testConfig,
  testDb,
  uniqueEmail,
} from './helpers/db.js';

const META = { ip: '203.0.113.30', userAgent: 'vitest-atomicity' };

/** 在 audit_logs 上安装"禁止插入"触发器，返回卸载函数。 */
async function blockAuditInserts(tag: string): Promise<() => Promise<void>> {
  const db = testDb();
  const fn = `inject_audit_fail_${tag}`;

  await db.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'inject:audit-write-failed'; END; $$ LANGUAGE plpgsql`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${fn}_trg BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  );

  return async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn}_trg ON audit_logs`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
  };
}

describe('审计写入失败时业务回滚', () => {
  beforeAll(() => {
    requireDatabaseUrl();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('停用账号：审计写失败 → 状态回滚为 active，会话不被删除', async () => {
    const db = testDb();
    const admin = await createTestUser(db, { role: 'admin' });
    const target = await createTestUser(db);
    // 先建立一个会话，用于验证"回滚后会话仍在"
    const session = await createSession(db, { userId: target.id, config: testConfig() });

    const restore = await blockAuditInserts(`disable_${Date.now()}`);
    try {
      await expect(
        setUserStatus(db, {
          actorId: admin.id,
          userId: target.id,
          status: 'disabled',
          meta: META,
        }),
      ).rejects.toThrowError(/audit-write-failed/);
    } finally {
      await restore();
    }

    const row = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.status).toBe('active');
    await expect(db.session.count({ where: { userId: target.id } })).resolves.toBe(1);
    await expect(db.session.count({ where: { id: session.sessionId } })).resolves.toBe(1);
  });

  it('管理员重置密码：审计写失败 → 密码哈希与 mustChangePassword 均回滚', async () => {
    const db = testDb();
    const admin = await createTestUser(db, { role: 'admin' });
    const target = await createTestUser(db);
    const before = await db.user.findUniqueOrThrow({ where: { id: target.id } });

    const restore = await blockAuditInserts(`reset_${Date.now()}`);
    try {
      await expect(
        adminResetPassword(db, {
          actorId: admin.id,
          userId: target.id,
          newPassword: 'should-never-be-persisted-2026',
          meta: META,
        }),
      ).rejects.toThrowError(/audit-write-failed/);
    } finally {
      await restore();
    }

    const after = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.mustChangePassword).toBe(before.mustChangePassword);
  });

  it('创建初始管理员：审计写失败 → 账号不会被创建', async () => {
    const db = testDb();
    const email = uniqueEmail('atomic');

    const restore = await blockAuditInserts(`create_${Date.now()}`);
    try {
      await expect(
        createInitialAdmin(db, {
          email,
          password: 'initial-password-should-rollback',
          meta: META,
        }),
      ).rejects.toThrowError(/audit-write-failed/);
    } finally {
      await restore();
    }

    await expect(db.user.findUnique({ where: { email } })).resolves.toBeNull();
  });

  it('触发器卸载后审计恢复正常写入（证明故障是注入的，不是环境坏了）', async () => {
    const db = testDb();
    const admin = await createTestUser(db, { role: 'admin' });
    const target = await createTestUser(db);

    await setUserStatus(db, {
      actorId: admin.id,
      userId: target.id,
      status: 'disabled',
      meta: META,
    });

    const audit = await db.auditLog.findFirst({
      where: { action: 'user.disabled', targetId: target.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
  });
});
