/**
 * 管理接口（M1-B2）—— 路由级测试。
 *
 * 直接调用 Next 路由处理器，底层是真实 PostgreSQL + 真实 argon2id。
 *
 * 说明：共享测试库的账号数已远超产品上限（10），因此"创建成功 / 第 11 个失败"
 * 在**服务层**用一次性数据库验证（packages/auth/test/admin-users.test.ts），
 * 在容器烟测里用干净数据库端到端验证；本文件负责路由层的授权、Origin、
 * 字段泄露、满员冲突、重置与停用/启用。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { disconnectPrisma, getPrismaClient } from '@novel/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as createUserRoute, GET as listUsersRoute } from '../app/api/admin/users/route.js';
import { POST as loginRoute } from '../app/api/auth/login/route.js';
import { GET as meRoute } from '../app/api/auth/me/route.js';
import { POST as resetPasswordRoute } from '../app/api/admin/users/[id]/reset-password/route.js';
import { PATCH as statusRoute } from '../app/api/admin/users/[id]/status/route.js';
import { loginLimiter } from '../src/auth-runtime.js';

const BASE = 'http://localhost:3000';
const ORIGIN = 'http://localhost:3000';

function requireDatabaseUrl(): void {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error('接口测试需要真实 PostgreSQL：请设置 DATABASE_URL 并先执行迁移');
  }
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function getRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, { headers });
}

function paramsOf(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function cookieOf(response: Response): string {
  const list = response.headers.getSetCookie();
  const cookie = list[0] ?? '';
  const match = /novel_session=([^;]*)/.exec(cookie);
  return match?.[1] ?? '';
}

async function login(email: string, password: string): Promise<Response> {
  return loginRoute(jsonRequest('/api/auth/login', { email, password }, { origin: ORIGIN }));
}

/** 创建一个测试账号（哈希由 argon2 生成，through 数据库直写以覆盖各角色状态）。 */
async function createUser(
  options: {
    role?: 'admin' | 'author';
    status?: 'active' | 'disabled';
    mustChangePassword?: boolean;
    password?: string;
  } = {},
): Promise<{ id: string; email: string; password: string }> {
  const { hashPassword } = await import('@novel/auth');
  const db = getPrismaClient();
  const email = `m1b2-web-${randomUUID()}@example.test`;
  const password = options.password ?? 'Api-Test-Pass-2026';

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

/** 以某个账号登录并拿到会话令牌。 */
async function loginToken(email: string, password: string): Promise<string> {
  const response = await login(email, password);
  expect(response.status).toBe(200);
  const token = cookieOf(response);
  expect(token).not.toBe('');
  return token;
}

describe('管理接口', () => {
  beforeAll(() => {
    requireDatabaseUrl();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  beforeEach(() => {
    loginLimiter.resetAll();
  });

  it('作者调用全部管理接口返回 403', async () => {
    const author = await createUser({ role: 'author' });
    const token = await loginToken(author.email, author.password);
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${token}` };

    const list = await listUsersRoute(getRequest('/api/admin/users', headers));
    expect(list.status).toBe(403);

    const create = await createUserRoute(
      jsonRequest(
        '/api/admin/users',
        { email: `x-${randomUUID()}@example.test` },
        { ...headers, origin: ORIGIN },
      ),
    );
    expect(create.status).toBe(403);

    const reset = await resetPasswordRoute(
      jsonRequest(
        `/api/admin/users/${author.id}/reset-password`,
        {},
        { ...headers, origin: ORIGIN },
      ),
      paramsOf(author.id),
    );
    expect(reset.status).toBe(403);

    const status = await statusRoute(
      new Request(`${BASE}/api/admin/users/${author.id}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...headers, origin: ORIGIN },
        body: JSON.stringify({ status: 'disabled' }),
      }),
      paramsOf(author.id),
    );
    expect(status.status).toBe(403);
  });

  it('停用的管理员返回 403', async () => {
    // 先以 active 身份登录拿到会话，再在库里停用：验证"每次请求重查状态"。
    const admin = await createUser({ role: 'admin' });
    const token = await loginToken(admin.email, admin.password);
    await getPrismaClient().user.update({ where: { id: admin.id }, data: { status: 'disabled' } });

    const response = await listUsersRoute(
      getRequest('/api/admin/users', { cookie: `${SESSION_COOKIE_NAME}=${token}` }),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('首登未改密的管理员返回 403', async () => {
    const admin = await createUser({ role: 'admin', mustChangePassword: true });
    const token = await loginToken(admin.email, admin.password);

    const response = await listUsersRoute(
      getRequest('/api/admin/users', { cookie: `${SESSION_COOKIE_NAME}=${token}` }),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('缺少 Origin 的写请求返回 403', async () => {
    const admin = await createUser({ role: 'admin' });
    const token = await loginToken(admin.email, admin.password);
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${token}` };

    const create = await createUserRoute(
      jsonRequest('/api/admin/users', { email: `no-origin-${randomUUID()}@example.test` }, headers),
    );
    expect(create.status).toBe(403);

    const status = await statusRoute(
      new Request(`${BASE}/api/admin/users/${admin.id}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ status: 'active' }),
      }),
      paramsOf(admin.id),
    );
    expect(status.status).toBe(403);
  });

  it('管理员列出账号：字段完整且不含密码哈希/令牌', async () => {
    const admin = await createUser({ role: 'admin' });
    const token = await loginToken(admin.email, admin.password);

    const response = await listUsersRoute(
      getRequest('/api/admin/users', { cookie: `${SESSION_COOKIE_NAME}=${token}` }),
    );

    expect(response.status).toBe(200);
    const text = await response.clone().text();
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('tokenHash');
    expect(text).not.toContain('$argon2');

    const body = (await response.json()) as { users: Record<string, unknown>[] };
    const me = body.users.find((item) => item['id'] === admin.id);
    expect(me).toBeDefined();
    expect(Object.keys(me ?? {}).sort()).toEqual(
      ['createdAt', 'email', 'id', 'mustChangePassword', 'role', 'status', 'updatedAt'].sort(),
    );
  });

  it('账号已达上限时创建返回 409 USER_LIMIT_REACHED，且不新增账号/不写审计', async () => {
    const admin = await createUser({ role: 'admin' });
    const token = await loginToken(admin.email, admin.password);
    const db = getPrismaClient();

    const targetEmail = `over-limit-${randomUUID()}@example.test`;
    const beforeAudits = await db.auditLog.count();

    const response = await createUserRoute(
      jsonRequest(
        '/api/admin/users',
        { email: targetEmail },
        { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: ORIGIN },
      ),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('USER_LIMIT_REACHED');
    // 不新增账号、不写审计（按邮箱精确断言，避免并行用例干扰总数）
    await expect(db.user.findUnique({ where: { email: targetEmail } })).resolves.toBeNull();
    await expect(db.auditLog.count()).resolves.toBe(beforeAudits);
  });

  it('创建缺少 email 时返回 400', async () => {
    const admin = await createUser({ role: 'admin' });
    const token = await loginToken(admin.email, admin.password);

    const response = await createUserRoute(
      jsonRequest(
        '/api/admin/users',
        {},
        { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: ORIGIN },
      ),
    );

    expect(response.status).toBe(400);
  });

  it('重置密码：旧会话立即失效，响应不含哈希', async () => {
    const admin = await createUser({ role: 'admin' });
    const author = await createUser({ role: 'author' });
    const adminToken = await loginToken(admin.email, admin.password);
    const authorToken = await loginToken(author.email, author.password);

    const response = await resetPasswordRoute(
      jsonRequest(
        `/api/admin/users/${author.id}/reset-password`,
        {},
        { cookie: `${SESSION_COOKIE_NAME}=${adminToken}`, origin: ORIGIN },
      ),
      paramsOf(author.id),
    );

    expect(response.status).toBe(200);
    const text = await response.clone().text();
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('$argon2');

    const body = (await response.json()) as {
      newPassword?: string;
      user: { mustChangePassword: boolean };
    };
    expect(body.user.mustChangePassword).toBe(true);
    expect(typeof body.newPassword).toBe('string');
    expect((body.newPassword ?? '').length).toBeGreaterThanOrEqual(20);

    // 旧会话失效
    const meAfter = await meRoute(
      getRequest('/api/auth/me', { cookie: `${SESSION_COOKIE_NAME}=${authorToken}` }),
    );
    expect(meAfter.status).toBe(401);

    // 新口令可登录（首登会要求改密，故用登录接口本身判定）
    const relogin = await login(author.email, body.newPassword ?? '');
    expect(relogin.status).toBe(200);
  });

  it('停用后作者登录 403，启用后可重新登录', async () => {
    const admin = await createUser({ role: 'admin' });
    const author = await createUser({ role: 'author' });
    const adminToken = await loginToken(admin.email, admin.password);
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${adminToken}`, origin: ORIGIN };

    const disable = await statusRoute(
      new Request(`${BASE}/api/admin/users/${author.id}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ status: 'disabled' }),
      }),
      paramsOf(author.id),
    );
    expect(disable.status).toBe(200);

    const blockedLogin = await login(author.email, author.password);
    expect(blockedLogin.status).toBe(403);

    const enable = await statusRoute(
      new Request(`${BASE}/api/admin/users/${author.id}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ status: 'active' }),
      }),
      paramsOf(author.id),
    );
    expect(enable.status).toBe(200);

    const okLogin = await login(author.email, author.password);
    expect(okLogin.status).toBe(200);
  });

  it('非法 status 值返回 400', async () => {
    const admin = await createUser({ role: 'admin' });
    const token = await loginToken(admin.email, admin.password);

    const response = await statusRoute(
      new Request(`${BASE}/api/admin/users/${admin.id}/status`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
          origin: ORIGIN,
        },
        body: JSON.stringify({ status: 'deleted' }),
      }),
      paramsOf(admin.id),
    );

    expect(response.status).toBe(400);
  });

  it('未登录访问管理接口返回 401', async () => {
    const response = await listUsersRoute(getRequest('/api/admin/users'));

    expect(response.status).toBe(401);
  });
});
