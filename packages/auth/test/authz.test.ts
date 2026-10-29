/**
 * 管理员授权（REV-01 第 1 条）。
 *
 * 覆盖：作者 / 已停用管理员 / 不存在的 actor 调用管理员操作一律被拒绝，
 * 且**业务数据保持不变**（不是"先改了再报错"）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthError } from '../src/errors.js';
import { adminResetPassword, requireActiveAdmin, setUserStatus } from '../src/users.js';
import { closeTestDb, createTestUser, requireDatabaseUrl, testDb } from './helpers/db.js';

const META = { ip: '203.0.113.20', userAgent: 'vitest-authz' };
const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';

describe('管理员授权', () => {
  beforeAll(() => {
    requireDatabaseUrl();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('仅 active 管理员通过 requireActiveAdmin', async () => {
    const db = testDb();
    const admin = await createTestUser(db, { role: 'admin' });

    const actor = await requireActiveAdmin(db, admin.id);
    expect(actor.id).toBe(admin.id);
    expect(actor.role).toBe('admin');
  });

  it('作者被拒绝（FORBIDDEN / 403）', async () => {
    const db = testDb();
    const author = await createTestUser(db, { role: 'author' });

    const error = await requireActiveAdmin(db, author.id).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('FORBIDDEN');
    expect((error as AuthError).status).toBe(403);
  });

  it('已停用的管理员被拒绝（ACCOUNT_DISABLED / 403）', async () => {
    const db = testDb();
    const admin = await createTestUser(db, { role: 'admin', status: 'disabled' });

    const error = await requireActiveAdmin(db, admin.id).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('ACCOUNT_DISABLED');
    expect((error as AuthError).status).toBe(403);
  });

  it('不存在的 actor 与非法 id 被拒绝（FORBIDDEN，不泄露存在性）', async () => {
    const db = testDb();

    for (const actorId of [NONEXISTENT_ID, 'not-a-uuid']) {
      const error = await requireActiveAdmin(db, actorId).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('FORBIDDEN');
    }
  });

  it('作者调用 setUserStatus：被拒绝且目标状态不变', async () => {
    const db = testDb();
    const author = await createTestUser(db, { role: 'author' });
    const target = await createTestUser(db);

    await expect(
      setUserStatus(db, { actorId: author.id, userId: target.id, status: 'disabled', meta: META }),
    ).rejects.toThrowError(/没有权限/);

    const row = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.status).toBe('active');
  });

  it('停用管理员调用 setUserStatus：被拒绝且目标状态不变', async () => {
    const db = testDb();
    const disabledAdmin = await createTestUser(db, { role: 'admin', status: 'disabled' });
    const target = await createTestUser(db);

    await expect(
      setUserStatus(db, {
        actorId: disabledAdmin.id,
        userId: target.id,
        status: 'disabled',
        meta: META,
      }),
    ).rejects.toThrowError(/已停用/);

    const row = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.status).toBe('active');
  });

  it('不存在的 actor 调用 setUserStatus：被拒绝且目标状态不变', async () => {
    const db = testDb();
    const target = await createTestUser(db);

    await expect(
      setUserStatus(db, {
        actorId: NONEXISTENT_ID,
        userId: target.id,
        status: 'disabled',
        meta: META,
      }),
    ).rejects.toThrowError(/没有权限/);

    const row = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.status).toBe('active');
  });

  it('越权调用 adminResetPassword：被拒绝且密码哈希不变', async () => {
    const db = testDb();
    const author = await createTestUser(db, { role: 'author' });
    const target = await createTestUser(db);
    const before = await db.user.findUniqueOrThrow({ where: { id: target.id } });

    for (const actorId of [author.id, NONEXISTENT_ID]) {
      await expect(
        adminResetPassword(db, {
          actorId,
          userId: target.id,
          newPassword: 'attacker-chosen-password-2026',
          meta: META,
        }),
      ).rejects.toThrowError(AuthError);
    }

    const after = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.mustChangePassword).toBe(before.mustChangePassword);
  });

  it('越权尝试不产生审计记录（没有发生成功的业务变更）', async () => {
    const db = testDb();
    const author = await createTestUser(db, { role: 'author' });
    const target = await createTestUser(db);

    await setUserStatus(db, {
      actorId: author.id,
      userId: target.id,
      status: 'disabled',
      meta: META,
    }).catch(() => undefined);

    const audit = await db.auditLog.findFirst({
      where: { action: 'user.disabled', targetId: target.id },
    });
    expect(audit).toBeNull();
  });
});
