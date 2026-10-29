import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from '../src/audit.js';
import { AuthError } from '../src/errors.js';
import { FixedWindowRateLimiter } from '../src/ratelimit.js';
import { changePassword, getCurrentUser, loginWithPassword, logout } from '../src/service.js';
import { adminResetPassword, createInitialAdmin, setUserStatus } from '../src/users.js';
import { createSession } from '../src/sessions.js';
import {
  closeTestDb,
  createTestUser,
  requireDatabaseUrl,
  testConfig,
  testDb,
  uniqueEmail,
} from './helpers/db.js';
import { EMPTY_REQUEST_META } from '../src/types.js';

const META = { ip: '203.0.113.10', userAgent: 'vitest' };

function newLimiter(): FixedWindowRateLimiter {
  return new FixedWindowRateLimiter({ maxAttempts: 5, windowMs: 60_000 });
}

describe('登录 / 退出 / 改密（真实 PostgreSQL）', () => {
  beforeAll(() => {
    requireDatabaseUrl();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  let limiter: FixedWindowRateLimiter;
  beforeEach(() => {
    limiter = newLimiter();
  });

  it('正确密码登录成功并签发会话', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();

    const result = await loginWithPassword(db, limiter, {
      email: user.email,
      password: user.password,
      config,
      meta: META,
    });

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.user.email).toBe(user.email);
    expect(result.user.id).toBe(user.id);

    const context = await getCurrentUser(db, { token: result.token, config });
    expect(context.user.id).toBe(user.id);
  });

  it('账号不存在与密码错误返回完全相同的错误（语义不可区分）', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();

    const wrongPassword = await loginWithPassword(db, limiter, {
      email: user.email,
      password: 'definitely-wrong-password',
      config,
      meta: META,
    }).catch((error: unknown) => error);

    const unknownAccount = await loginWithPassword(db, limiter, {
      email: uniqueEmail('ghost'),
      password: 'definitely-wrong-password',
      config,
      meta: META,
    }).catch((error: unknown) => error);

    expect(wrongPassword).toBeInstanceOf(AuthError);
    expect(unknownAccount).toBeInstanceOf(AuthError);

    const a = wrongPassword as AuthError;
    const b = unknownAccount as AuthError;
    expect(a.code).toBe('INVALID_CREDENTIALS');
    expect(b.code).toBe('INVALID_CREDENTIALS');
    expect(a.status).toBe(b.status);
    expect(a.toBody()).toEqual(b.toBody());
  });

  it('邮箱大小写不影响登录', async () => {
    const db = testDb();
    const user = await createTestUser(db);

    const result = await loginWithPassword(db, limiter, {
      email: user.email.toUpperCase(),
      password: user.password,
      config: testConfig(),
      meta: META,
    });

    expect(result.user.id).toBe(user.id);
  });

  it('登录成功与失败都写审计，且失败审计不含提交的密码', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();
    const submittedPassword = 'this-is-the-submitted-password';

    await loginWithPassword(db, limiter, {
      email: user.email,
      password: user.password,
      config,
      meta: META,
    });

    await loginWithPassword(db, limiter, {
      email: user.email,
      password: submittedPassword,
      config,
      meta: META,
    }).catch(() => undefined);

    const succeeded = await db.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.LOGIN_SUCCEEDED, actorId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(succeeded).not.toBeNull();

    const failedRows = await db.auditLog.findMany({
      where: { action: AUDIT_ACTIONS.LOGIN_FAILED, actorId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    expect(failedRows.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(failedRows);
    expect(serialized).not.toContain(submittedPassword);
    expect(serialized).not.toContain(user.password);
    expect(serialized).toContain('bad_password');
  });

  it('登录时轮换：旧会话被吊销', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();

    const first = await loginWithPassword(db, limiter, {
      email: user.email,
      password: user.password,
      config,
      meta: META,
    });

    const second = await loginWithPassword(db, limiter, {
      email: user.email,
      password: user.password,
      config,
      meta: META,
      previousToken: first.token,
    });

    await expect(getCurrentUser(db, { token: first.token, config })).rejects.toThrowError(/未登录/);
    const context = await getCurrentUser(db, { token: second.token, config });
    expect(context.user.id).toBe(user.id);
  });

  it('退出登录后令牌失效，且重复退出不报错', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();
    const session = await loginWithPassword(db, limiter, {
      email: user.email,
      password: user.password,
      config,
      meta: META,
    });

    await expect(logout(db, { token: session.token, meta: META })).resolves.toEqual({
      loggedOut: true,
    });
    await expect(logout(db, { token: session.token, meta: META })).resolves.toEqual({
      loggedOut: false,
    });
    await expect(getCurrentUser(db, { token: session.token, config })).rejects.toThrowError(
      /未登录/,
    );
  });

  it('改密后旧会话全部失效，并签发新会话', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();

    const session = await loginWithPassword(db, limiter, {
      email: user.email,
      password: user.password,
      config,
      meta: META,
    });
    // 另一台设备上的会话
    const otherDevice = await createSession(db, { userId: user.id, config });

    const rotated = await changePassword(db, {
      token: session.token,
      currentPassword: user.password,
      newPassword: 'a-brand-new-password-2026',
      config,
      meta: META,
    });

    await expect(getCurrentUser(db, { token: session.token, config })).rejects.toThrowError(
      /未登录/,
    );
    await expect(getCurrentUser(db, { token: otherDevice.token, config })).rejects.toThrowError(
      /未登录/,
    );
    await expect(getCurrentUser(db, { token: rotated.token, config })).resolves.toBeDefined();

    // 新密码可登录，旧密码不可
    await expect(
      loginWithPassword(db, limiter, {
        email: user.email,
        password: user.password,
        config,
        meta: META,
      }),
    ).rejects.toThrowError(AuthError);

    await expect(
      loginWithPassword(db, limiter, {
        email: user.email,
        password: 'a-brand-new-password-2026',
        config,
        meta: META,
      }),
    ).resolves.toBeDefined();
  });

  it('改密时当前密码错误被拒绝', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();
    const session = await loginWithPassword(db, limiter, {
      email: user.email,
      password: user.password,
      config,
      meta: META,
    });

    await expect(
      changePassword(db, {
        token: session.token,
        currentPassword: 'wrong-current-password',
        newPassword: 'another-new-password-2026',
        config,
        meta: META,
      }),
    ).rejects.toThrowError(/当前密码不正确/);
  });

  it('首登未改密：只能访问改密与退出', async () => {
    const db = testDb();
    const user = await createTestUser(db, { mustChangePassword: true });
    const config = testConfig();

    const session = await loginWithPassword(db, limiter, {
      email: user.email,
      password: user.password,
      config,
      meta: META,
    });

    await expect(getCurrentUser(db, { token: session.token, config })).rejects.toThrowError(
      /必须先修改密码/,
    );

    // 改密接口仍然放行
    const rotated = await changePassword(db, {
      token: session.token,
      currentPassword: user.password,
      newPassword: 'first-login-new-password',
      config,
      meta: META,
    });

    await expect(getCurrentUser(db, { token: rotated.token, config })).resolves.toBeDefined();
    expect(rotated.user.mustChangePassword).toBe(false);
  });

  it('连续 5 次失败后触发限流', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();

    for (let index = 0; index < 5; index += 1) {
      await expect(
        loginWithPassword(db, limiter, {
          email: user.email,
          password: `wrong-password-${index}`,
          config,
          meta: META,
        }),
      ).rejects.toThrowError(AuthError);
    }

    const blocked = await loginWithPassword(db, limiter, {
      email: user.email,
      password: user.password,
      config,
      meta: META,
    }).catch((error: unknown) => error);

    expect(blocked).toBeInstanceOf(AuthError);
    expect((blocked as AuthError).code).toBe('RATE_LIMITED');
    expect((blocked as AuthError).status).toBe(429);
  });

  it('停用账号后登录返回 403 语义', async () => {
    const db = testDb();
    const admin = await createTestUser(db, { role: 'admin' });
    const user = await createTestUser(db);
    const config = testConfig();

    await setUserStatus(db, {
      actorId: admin.id,
      userId: user.id,
      status: 'disabled',
      meta: META,
    });

    const error = await loginWithPassword(db, limiter, {
      email: user.email,
      password: user.password,
      config,
      meta: META,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('ACCOUNT_DISABLED');
    expect((error as AuthError).status).toBe(403);

    const audit = await db.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.USER_DISABLED, targetId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
  });

  it('管理员重置密码：置为必须改密、吊销会话并写审计', async () => {
    const db = testDb();
    const admin = await createTestUser(db, { role: 'admin' });
    const user = await createTestUser(db);
    const config = testConfig();

    const session = await loginWithPassword(db, limiter, {
      email: user.email,
      password: user.password,
      config,
      meta: META,
    });

    await adminResetPassword(db, {
      actorId: admin.id,
      userId: user.id,
      newPassword: 'admin-reset-brand-new-password',
      meta: META,
    });

    // 旧会话失效
    await expect(getCurrentUser(db, { token: session.token, config })).rejects.toThrowError(
      /未登录/,
    );

    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.mustChangePassword).toBe(true);
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(row.passwordHash).not.toContain('admin-reset-brand-new-password');

    const audit = await db.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.ADMIN_PASSWORD_RESET, targetId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain('admin-reset-brand-new-password');

    // 新密码可登录
    await expect(
      loginWithPassword(db, newLimiter(), {
        email: user.email,
        password: 'admin-reset-brand-new-password',
        config,
        meta: META,
      }),
    ).resolves.toBeDefined();
  });
});

describe('初始管理员（seed）', () => {
  beforeAll(() => {
    requireDatabaseUrl();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('创建成功且幂等，初始密码只以 argon2id 哈希入库', async () => {
    const db = testDb();
    const email = uniqueEmail('admin');
    const password = 'initial-admin-password';

    const first = await createInitialAdmin(db, { email, password, meta: EMPTY_REQUEST_META });
    expect(first.created).toBe(true);

    const second = await createInitialAdmin(db, { email, password, meta: EMPTY_REQUEST_META });
    expect(second.created).toBe(false);
    expect(second.userId).toBe(first.userId);

    const row = await db.user.findUniqueOrThrow({ where: { id: first.userId } });
    expect(row.role).toBe('admin');
    expect(row.mustChangePassword).toBe(true);
    expect(row.passwordHash).not.toContain(password);
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);

    const audit = await db.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.ADMIN_CREATED, targetId: first.userId },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain(password);
  });
});
