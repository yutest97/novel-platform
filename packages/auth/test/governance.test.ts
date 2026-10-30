/**
 * 管理员治理事务与最后管理员保护（REV-02 第 2、3 条）。
 *
 * 覆盖：
 * - 所有管理员写操作在事务内取固定 advisory lock，并在**事务内重读 actor**；
 * - 唯一管理员不能停用自己（LAST_ADMIN_PROTECTED）；
 * - 两个管理员时，一个可以停用另一个；
 * - 两个管理员并发互相停用，最终恰好保留一个 active admin；
 * - 首登未改密的管理员不能执行管理操作；
 * - 上述失败场景都不留下业务修改与审计。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@novel/db';

import { AuthError } from '../src/errors.js';
import { adminResetPassword, setUserStatus } from '../src/users.js';
import { closeTestDb, createTestUser, requireDatabaseUrl, testDb } from './helpers/db.js';

const META = { ip: '203.0.113.50', userAgent: 'vitest-governance' };

/** 统计仍为 active 的管理员中属于给定集合的个数。 */
async function countActiveAdminsIn(db: PrismaClient, ids: readonly string[]): Promise<number> {
  return db.user.count({ where: { role: 'admin', status: 'active', id: { in: [...ids] } } });
}

/**
 * 临时把"其他"active 管理员停用，构造"全局只剩一个可用管理员"的场景。
 *
 * 最后管理员保护是**全局**约束，测试库中已有其它测试创建的活跃管理员，
 * 因此必须临时清场；`finally` 中恢复原状。
 */
async function withOnlyAdmin(
  db: PrismaClient,
  keepId: string,
  run: () => Promise<void>,
): Promise<void> {
  const others = await db.user.findMany({
    where: { role: 'admin', status: 'active', id: { not: keepId } },
    select: { id: true },
  });
  const ids = others.map((item) => item.id);

  if (ids.length > 0) {
    await db.user.updateMany({ where: { id: { in: ids } }, data: { status: 'disabled' } });
  }
  try {
    await run();
  } finally {
    if (ids.length > 0) {
      await db.user.updateMany({ where: { id: { in: ids } }, data: { status: 'active' } });
    }
  }
}

describe('管理员治理', () => {
  beforeAll(() => {
    requireDatabaseUrl();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('唯一管理员不能停用自己（LAST_ADMIN_PROTECTED，且无副作用）', async () => {
    const db = testDb();
    const admin = await createTestUser(db, { role: 'admin' });

    await withOnlyAdmin(db, admin.id, async () => {
      const error = await setUserStatus(db, {
        actorId: admin.id,
        userId: admin.id,
        status: 'disabled',
        meta: META,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('LAST_ADMIN_PROTECTED');
      expect((error as AuthError).status).toBe(403);

      const row = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(row.status).toBe('active');

      const audit = await db.auditLog.findFirst({
        where: { action: 'user.disabled', targetId: admin.id },
      });
      expect(audit).toBeNull();
    });
  });

  it('唯一管理员不能停用另一个非管理员账号时不受影响（只保护管理员）', async () => {
    const db = testDb();
    const admin = await createTestUser(db, { role: 'admin' });
    const author = await createTestUser(db, { role: 'author' });

    await withOnlyAdmin(db, admin.id, async () => {
      const updated = await setUserStatus(db, {
        actorId: admin.id,
        userId: author.id,
        status: 'disabled',
        meta: META,
      });
      expect(updated.status).toBe('disabled');
    });
  });

  it('两个管理员时，一个可以停用另一个', async () => {
    const db = testDb();
    const first = await createTestUser(db, { role: 'admin' });
    const second = await createTestUser(db, { role: 'admin' });

    const updated = await setUserStatus(db, {
      actorId: first.id,
      userId: second.id,
      status: 'disabled',
      meta: META,
    });

    expect(updated.status).toBe('disabled');
    const row = await db.user.findUniqueOrThrow({ where: { id: second.id } });
    expect(row.status).toBe('disabled');

    const audit = await db.auditLog.findFirst({
      where: { action: 'user.disabled', targetId: second.id, actorId: first.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
  });

  it('两个管理员并发互相停用：最终恰好保留一个 active admin', async () => {
    const db = testDb();
    const first = await createTestUser(db, { role: 'admin' });
    const second = await createTestUser(db, { role: 'admin' });

    const results = await Promise.allSettled([
      setUserStatus(db, { actorId: first.id, userId: second.id, status: 'disabled', meta: META }),
      setUserStatus(db, { actorId: second.id, userId: first.id, status: 'disabled', meta: META }),
    ]);

    const fulfilled = results.filter((item) => item.status === 'fulfilled').length;
    const rejected = results.filter((item) => item.status === 'rejected').length;

    // 串行化后：先执行的一方成功，后执行的一方因 actor 已被停用而失败。
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);

    const remaining = await countActiveAdminsIn(db, [first.id, second.id]);
    expect(remaining).toBe(1);

    // 失败方的目标没有被停用（不存在"两边都被停用"）
    const rows = await db.user.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { id: true, status: true },
    });
    expect(rows.filter((row) => row.status === 'active').length).toBe(1);
  });

  it('首登未改密的管理员不能执行管理操作（且无副作用）', async () => {
    const db = testDb();
    const pendingAdmin = await createTestUser(db, { role: 'admin', mustChangePassword: true });
    const target = await createTestUser(db, { role: 'author' });

    const statusError = await setUserStatus(db, {
      actorId: pendingAdmin.id,
      userId: target.id,
      status: 'disabled',
      meta: META,
    }).catch((caught: unknown) => caught);

    expect(statusError).toBeInstanceOf(AuthError);
    expect((statusError as AuthError).code).toBe('PASSWORD_CHANGE_REQUIRED');

    const resetError = await adminResetPassword(db, {
      actorId: pendingAdmin.id,
      userId: target.id,
      newPassword: 'pending-admin-should-not-reset',
      meta: META,
    }).catch((caught: unknown) => caught);

    expect(resetError).toBeInstanceOf(AuthError);
    expect((resetError as AuthError).code).toBe('PASSWORD_CHANGE_REQUIRED');

    // 目标账号未变化、无审计
    const row = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.status).toBe('active');
    expect(row.mustChangePassword).toBe(false);

    const audits = await db.auditLog.findMany({ where: { targetId: target.id } });
    expect(audits).toEqual([]);
  });

  it('停用失败（最后管理员）不产生审计，启用不受该限制', async () => {
    const db = testDb();
    const admin = await createTestUser(db, { role: 'admin' });

    await withOnlyAdmin(db, admin.id, async () => {
      await setUserStatus(db, {
        actorId: admin.id,
        userId: admin.id,
        status: 'disabled',
        meta: META,
      }).catch(() => undefined);

      const audits = await db.auditLog.findMany({
        where: { action: 'user.disabled', targetId: admin.id },
      });
      expect(audits).toEqual([]);

      // 启用（active）不会触发最后管理员保护
      const updated = await setUserStatus(db, {
        actorId: admin.id,
        userId: admin.id,
        status: 'active',
        meta: META,
      });
      expect(updated.status).toBe('active');
    });
  });
});
