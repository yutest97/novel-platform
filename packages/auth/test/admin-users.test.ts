/**
 * 管理员账号管理（M1-B2）—— 服务层测试。
 *
 * 每个用例使用**独立的 PostgreSQL schema**（见 helpers/isolated-db.ts）：
 * 账号总数上限是全局约束，只有在干净的数据空间里才能验证
 * "创建到第 10 个成功、第 11 个失败"以及并发不突破上限。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@novel/db';

import { createAuthorUser, listUsers } from '../src/admin-users.js';
import { MAX_USER_ACCOUNTS, readMaxUserAccounts } from '../src/config.js';
import { AuthError } from '../src/errors.js';
import { hashPassword, verifyPassword } from '../src/password.js';
import { FixedWindowRateLimiter } from '../src/ratelimit.js';
import { loginWithPassword } from '../src/service.js';
import { createSession, findSessionByToken } from '../src/sessions.js';
import { resetUserPassword, setUserStatus } from '../src/users.js';
import { closeTestDb, requireDatabaseUrl, testConfig, uniqueEmail } from './helpers/db.js';
import { createIsolatedDb } from './helpers/isolated-db.js';

const META = { ip: '203.0.113.60', userAgent: 'vitest-admin-users' };

/** 在给定数据库上建一个测试账号（不依赖共享库）。 */
async function seedUser(
  db: PrismaClient,
  options: {
    role?: 'admin' | 'author';
    status?: 'active' | 'disabled';
    mustChangePassword?: boolean;
  } = {},
): Promise<{ id: string; email: string; password: string }> {
  const email = uniqueEmail(options.role ?? 'user');
  const password = 'test-password-1234';
  const user = await db.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      role: options.role ?? 'author',
      status: options.status ?? 'active',
      mustChangePassword: options.mustChangePassword ?? false,
    },
    select: { id: true },
  });
  return { id: user.id, email, password };
}

/** 在一次性 schema 中执行测试，结束后清理。 */
async function withFreshDb<T>(tag: string, run: (db: PrismaClient) => Promise<T>): Promise<T> {
  const isolated = await createIsolatedDb(tag);
  try {
    return await run(isolated.db);
  } finally {
    await isolated.dispose();
  }
}

describe('管理员账号管理（隔离 schema）', () => {
  beforeAll(() => {
    requireDatabaseUrl();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('账号上限常量恒为 10，环境变量只能调小、不能调大', () => {
    expect(MAX_USER_ACCOUNTS).toBe(10);
    expect(readMaxUserAccounts({})).toBe(10);
    expect(readMaxUserAccounts({ AUTH_MAX_USER_ACCOUNTS: '99' })).toBe(10);
    expect(readMaxUserAccounts({ AUTH_MAX_USER_ACCOUNTS: '3' })).toBe(3);
    expect(readMaxUserAccounts({ AUTH_MAX_USER_ACCOUNTS: 'abc' })).toBe(10);
  });

  it('列表只返回安全字段，按创建时间正序，且不含密码哈希', async () => {
    await withFreshDb('list', async (db) => {
      const first = await seedUser(db, { role: 'author' });
      const second = await seedUser(db, { role: 'admin' });

      const users = await listUsers(db);

      expect(users.length).toBe(2);
      expect(users[0]?.id).toBe(first.id);
      expect(users[1]?.id).toBe(second.id);
      expect(Object.keys(users[0] ?? {}).sort()).toEqual(
        ['createdAt', 'email', 'id', 'mustChangePassword', 'role', 'status', 'updatedAt'].sort(),
      );

      const serialized = JSON.stringify(users);
      expect(serialized).not.toContain('$argon2');
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('tokenHash');

      const createdTimes = users.map((item) => Date.parse(item.createdAt));
      expect(createdTimes).toEqual([...createdTimes].sort((a, b) => a - b));
    });
  });

  it('创建作者：邮箱小写、role=author、必须改密、生成口令≥20 且只出现一次', async () => {
    await withFreshDb('create', async (db) => {
      const admin = await seedUser(db, { role: 'admin' });
      const email = uniqueEmail('Author-Mixed');

      const created = await createAuthorUser(db, {
        actorId: admin.id,
        email: email.toUpperCase(),
        meta: META,
      });

      expect(created.user.email).toBe(email.toLowerCase());
      expect(created.user.role).toBe('author');
      expect(created.user.status).toBe('active');
      expect(created.user.mustChangePassword).toBe(true);
      expect(created.initialPassword).not.toBeNull();
      expect((created.initialPassword ?? '').length).toBeGreaterThanOrEqual(20);

      const row = await db.user.findUniqueOrThrow({ where: { id: created.user.id } });
      expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(row.passwordHash).not.toContain(created.initialPassword ?? 'x');
      await expect(verifyPassword(row.passwordHash, created.initialPassword ?? '')).resolves.toBe(
        true,
      );

      expect(JSON.stringify(created.user)).not.toContain('passwordHash');
      expect(JSON.stringify(created.user)).not.toContain('$argon2');

      const audit = await db.auditLog.findFirst({
        where: { action: 'admin.user_created', targetId: created.user.id },
      });
      expect(audit).not.toBeNull();
      expect(JSON.stringify(audit)).not.toContain(created.initialPassword ?? 'x');
      expect((audit?.detail as { email?: string } | null)?.email).toBe(email.toLowerCase());
    });
  });

  it('重复邮箱（大小写不同）返回 EMAIL_TAKEN，且不新增账号、不写审计', async () => {
    await withFreshDb('dup', async (db) => {
      const admin = await seedUser(db, { role: 'admin' });
      const first = await createAuthorUser(db, {
        actorId: admin.id,
        email: uniqueEmail('dup'),
        meta: META,
      });
      const before = await db.user.count();
      const auditsBefore = await db.auditLog.count();

      const error = await createAuthorUser(db, {
        actorId: admin.id,
        email: first.user.email.toUpperCase(),
        meta: META,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('EMAIL_TAKEN');
      expect((error as AuthError).status).toBe(409);
      await expect(db.user.count()).resolves.toBe(before);
      await expect(db.auditLog.count()).resolves.toBe(auditsBefore);
    });
  });

  it('管理员显式设置初始密码时不回显，且该口令可直接登录', async () => {
    await withFreshDb('explicit', async (db) => {
      const admin = await seedUser(db, { role: 'admin' });
      const email = uniqueEmail('explicit');
      const password = 'Explicit-Initial-Pass-2026';

      const created = await createAuthorUser(db, {
        actorId: admin.id,
        email,
        initialPassword: password,
        meta: META,
      });

      expect(created.initialPassword).toBeNull();
      expect(JSON.stringify(created)).not.toContain(password);

      const limiter = new FixedWindowRateLimiter({ maxAttempts: 10, windowMs: 60_000 });
      const session = await loginWithPassword(db, limiter, {
        email,
        password,
        config: testConfig(),
        meta: META,
      });
      expect(session.user.id).toBe(created.user.id);
    });
  });

  it('第 11 个账号创建失败（前 10 个成功）', async () => {
    await withFreshDb('limit', async (db) => {
      const admin = await seedUser(db, { role: 'admin' }); // 第 1 个
      for (let index = 2; index <= MAX_USER_ACCOUNTS; index += 1) {
        await createAuthorUser(db, {
          actorId: admin.id,
          email: uniqueEmail(`slot-${index}`),
          meta: META,
        });
      }
      await expect(db.user.count()).resolves.toBe(MAX_USER_ACCOUNTS);

      const error = await createAuthorUser(db, {
        actorId: admin.id,
        email: uniqueEmail('slot-11'),
        meta: META,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('USER_LIMIT_REACHED');
      expect((error as AuthError).status).toBe(409);
      await expect(db.user.count()).resolves.toBe(MAX_USER_ACCOUNTS);
    });
  });

  it('并发创建账号无法突破上限（15 并发 → 恰好 10 个账号）', async () => {
    await withFreshDb('concurrent', async (db) => {
      const admin = await seedUser(db, { role: 'admin' });

      const results = await Promise.allSettled(
        Array.from({ length: 15 }, (_, index) =>
          createAuthorUser(db, {
            actorId: admin.id,
            email: uniqueEmail(`concurrent-${index}`),
            meta: META,
          }),
        ),
      );

      const fulfilled = results.filter((item) => item.status === 'fulfilled').length;
      const rejected = results.filter(
        (item): item is PromiseRejectedResult => item.status === 'rejected',
      );

      expect(fulfilled).toBe(MAX_USER_ACCOUNTS - 1); // 已有 1 个管理员
      expect(rejected.length).toBe(15 - (MAX_USER_ACCOUNTS - 1));
      for (const item of rejected) {
        expect((item.reason as AuthError).code).toBe('USER_LIMIT_REACHED');
      }

      await expect(db.user.count()).resolves.toBe(MAX_USER_ACCOUNTS);
    });
  });

  it('重置密码：生成新口令、旧会话全部失效、必须改密、写审计', async () => {
    await withFreshDb('reset', async (db) => {
      const admin = await seedUser(db, { role: 'admin' });
      const author = await seedUser(db, { role: 'author' });
      const session = await createSession(db, { userId: author.id, config: testConfig() });

      const result = await resetUserPassword(db, {
        actorId: admin.id,
        userId: author.id,
        meta: META,
      });

      expect(result.newPassword).not.toBeNull();
      expect((result.newPassword ?? '').length).toBeGreaterThanOrEqual(20);
      expect(result.user.mustChangePassword).toBe(true);
      expect(JSON.stringify(result.user)).not.toContain('passwordHash');

      await expect(findSessionByToken(db, session.token)).resolves.toBeNull();

      const row = await db.user.findUniqueOrThrow({ where: { id: author.id } });
      expect(row.mustChangePassword).toBe(true);
      await expect(verifyPassword(row.passwordHash, result.newPassword ?? '')).resolves.toBe(true);

      const audit = await db.auditLog.findFirst({
        where: { action: 'admin.password_reset', targetId: author.id },
      });
      expect(audit).not.toBeNull();
      expect(JSON.stringify(audit)).not.toContain(result.newPassword ?? 'x');
    });
  });

  it('重置密码时显式提供口令不回显', async () => {
    await withFreshDb('reset-explicit', async (db) => {
      const admin = await seedUser(db, { role: 'admin' });
      const author = await seedUser(db, { role: 'author' });

      const result = await resetUserPassword(db, {
        actorId: admin.id,
        userId: author.id,
        newPassword: 'Admin-Chosen-Pass-2026',
        meta: META,
      });

      expect(result.newPassword).toBeNull();
      expect(JSON.stringify(result)).not.toContain('Admin-Chosen-Pass-2026');
    });
  });

  it('停用立即吊销会话，启用后写入审计', async () => {
    await withFreshDb('status', async (db) => {
      const admin = await seedUser(db, { role: 'admin' });
      const author = await seedUser(db, { role: 'author' });
      const session = await createSession(db, { userId: author.id, config: testConfig() });

      const disabled = await setUserStatus(db, {
        actorId: admin.id,
        userId: author.id,
        status: 'disabled',
        meta: META,
      });
      expect(disabled.status).toBe('disabled');
      await expect(findSessionByToken(db, session.token)).resolves.toBeNull();

      expect(
        await db.auditLog.findFirst({ where: { action: 'user.disabled', targetId: author.id } }),
      ).not.toBeNull();

      const enabled = await setUserStatus(db, {
        actorId: admin.id,
        userId: author.id,
        status: 'active',
        meta: META,
      });
      expect(enabled.status).toBe('active');
      expect(
        await db.auditLog.findFirst({ where: { action: 'user.enabled', targetId: author.id } }),
      ).not.toBeNull();
    });
  });

  it('最后管理员保护依然生效（唯一管理员不能停用自己）', async () => {
    await withFreshDb('last-admin', async (db) => {
      const admin = await seedUser(db, { role: 'admin' });

      const error = await setUserStatus(db, {
        actorId: admin.id,
        userId: admin.id,
        status: 'disabled',
        meta: META,
      }).catch((caught: unknown) => caught);

      expect((error as AuthError).code).toBe('LAST_ADMIN_PROTECTED');
      const row = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(row.status).toBe('active');
      expect(await db.auditLog.count()).toBe(0);
    });
  });

  it('失败请求不留下业务修改或成功审计（重复邮箱 / 作者越权）', async () => {
    await withFreshDb('no-side-effects', async (db) => {
      const admin = await seedUser(db, { role: 'admin' });
      const author = await seedUser(db, { role: 'author' });
      const existing = await createAuthorUser(db, {
        actorId: admin.id,
        email: uniqueEmail('noaudit'),
        meta: META,
      });

      const beforeCount = await db.user.count();
      const beforeAudits = await db.auditLog.count();

      await createAuthorUser(db, {
        actorId: admin.id,
        email: existing.user.email,
        meta: META,
      }).catch(() => undefined);
      await createAuthorUser(db, {
        actorId: author.id,
        email: uniqueEmail('nope'),
        meta: META,
      }).catch(() => undefined);

      await expect(db.user.count()).resolves.toBe(beforeCount);
      await expect(db.auditLog.count()).resolves.toBe(beforeAudits);
    });
  });
});
