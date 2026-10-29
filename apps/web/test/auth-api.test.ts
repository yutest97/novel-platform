/**
 * 认证接口的行为测试。
 *
 * 直接调用 Next 路由处理器（不启动服务器），但底层使用：
 * 真实 PostgreSQL、真实 argon2id 哈希、真实 Cookie 头解析。
 * 不使用 mock 替代数据库。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME, hashPassword } from '@novel/auth';
import { disconnectPrisma, getPrismaClient } from '@novel/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as changePasswordRoute } from '../app/api/auth/change-password/route.js';
import { POST as loginRoute } from '../app/api/auth/login/route.js';
import { POST as logoutRoute } from '../app/api/auth/logout/route.js';
import { GET as meRoute } from '../app/api/auth/me/route.js';
import { loginLimiter } from '../src/auth-runtime.js';

const BASE = 'http://localhost:3000';
const ORIGIN = 'http://localhost:3000';
const COOKIE_NAME = SESSION_COOKIE_NAME;

/** 测试账号邮箱前缀。 */
const TEST_PREFIX = 'm1b1-web-';

function requireDatabaseUrl(): void {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error('接口测试需要真实 PostgreSQL：请设置 DATABASE_URL 并先执行迁移');
  }
}

async function createTestUser(
  options: { password?: string; mustChangePassword?: boolean; status?: 'active' | 'disabled' } = {},
): Promise<{ id: string; email: string; password: string }> {
  const db = getPrismaClient();
  const email = `${TEST_PREFIX}${randomUUID()}@example.test`;
  const password = options.password ?? 'api-test-password-1234';
  const passwordHash = await hashPassword(password);

  const user = await db.user.create({
    data: {
      email,
      passwordHash,
      role: 'author',
      status: options.status ?? 'active',
      mustChangePassword: options.mustChangePassword ?? false,
    },
    select: { id: true },
  });

  return { id: user.id, email, password };
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

/** 从响应中取出会话 Cookie 字符串。 */
function setCookieOf(response: Response): string {
  const list = response.headers.getSetCookie();
  const cookie = list[0] ?? response.headers.get('set-cookie') ?? '';
  expect(cookie).toContain(`${COOKIE_NAME}=`);
  return cookie;
}

/** 从 Set-Cookie 中取出令牌。 */
function tokenOf(response: Response): string {
  const match = /novel_session=([^;]*)/.exec(setCookieOf(response));
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

async function login(email: string, password: string): Promise<Response> {
  return loginRoute(jsonRequest('/api/auth/login', { email, password }, { origin: ORIGIN }));
}

describe('认证接口', () => {
  beforeAll(() => {
    requireDatabaseUrl();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  beforeEach(() => {
    loginLimiter.resetAll();
  });

  it('未登录访问 /api/auth/me 返回 401', async () => {
    const response = await meRoute(getRequest('/api/auth/me'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'UNAUTHENTICATED', message: '未登录或登录已失效' },
    });
  });

  it('登录成功返回 200，Cookie 具备 HttpOnly/Secure/SameSite=Lax/Path=/', async () => {
    const user = await createTestUser();
    const response = await login(user.email, user.password);

    expect(response.status).toBe(200);

    const cookie = setCookieOf(response);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    const maxAge = /Max-Age=(\d+)/.exec(cookie)?.[1];
    expect(Number(maxAge)).toBeGreaterThan(0);

    const body = (await response.json()) as { user: Record<string, unknown> };
    expect(body.user['email']).toBe(user.email);
    // 响应体不得包含密码哈希或会话令牌
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('$argon2');
    expect(serialized).not.toContain(tokenOf(response));
    expect(body.user['passwordHash']).toBeUndefined();
  });

  it('账号不存在与密码错误返回完全相同的状态码与响应体', async () => {
    const user = await createTestUser();

    const wrongPassword = await login(user.email, 'wrong-password-value');
    const unknownAccount = await login(
      `${TEST_PREFIX}ghost-${randomUUID()}@example.test`,
      'wrong-password-value',
    );

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);

    const bodyA = await wrongPassword.json();
    const bodyB = await unknownAccount.json();
    expect(bodyA).toEqual(bodyB);
  });

  it('登录缺少 Origin 头被拒绝（403）', async () => {
    const user = await createTestUser();
    const response = await loginRoute(
      jsonRequest('/api/auth/login', { email: user.email, password: user.password }),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_ORIGIN');
  });

  it('跨站 Origin 被拒绝（403）', async () => {
    const user = await createTestUser();
    const response = await loginRoute(
      jsonRequest(
        '/api/auth/login',
        { email: user.email, password: user.password },
        { origin: 'https://evil.example.com' },
      ),
    );

    expect(response.status).toBe(403);
  });

  it('带有效 Cookie 访问 /me 返回 200', async () => {
    const user = await createTestUser();
    const loginResponse = await login(user.email, user.password);
    const token = tokenOf(loginResponse);

    const response = await meRoute(
      getRequest('/api/auth/me', { cookie: `${COOKIE_NAME}=${token}` }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { email: string; mustChangePassword: boolean };
      session: { absoluteExpiresAt: string; idleExpiresAt: string };
    };
    expect(body.user.email).toBe(user.email);
    expect(body.user.mustChangePassword).toBe(false);
    expect(new Date(body.session.absoluteExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('账号停用后既有 Cookie 立即返回 403', async () => {
    const user = await createTestUser();
    const loginResponse = await login(user.email, user.password);
    const token = tokenOf(loginResponse);

    await getPrismaClient().user.update({
      where: { id: user.id },
      data: { status: 'disabled' },
    });

    const response = await meRoute(
      getRequest('/api/auth/me', { cookie: `${COOKIE_NAME}=${token}` }),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('首登未改密：/me 返回 403，改密接口放行并轮换会话', async () => {
    const user = await createTestUser({ mustChangePassword: true });
    const loginResponse = await login(user.email, user.password);
    const oldToken = tokenOf(loginResponse);

    const meBefore = await meRoute(
      getRequest('/api/auth/me', { cookie: `${COOKIE_NAME}=${oldToken}` }),
    );
    expect(meBefore.status).toBe(403);
    const meBody = (await meBefore.json()) as { error: { code: string } };
    expect(meBody.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changeResponse = await changePasswordRoute(
      jsonRequest(
        '/api/auth/change-password',
        { currentPassword: user.password, newPassword: 'first-login-brand-new-password' },
        { origin: ORIGIN, cookie: `${COOKIE_NAME}=${oldToken}` },
      ),
    );
    expect(changeResponse.status).toBe(200);
    const newToken = tokenOf(changeResponse);
    expect(newToken).not.toBe(oldToken);

    // 旧会话已被吊销
    const oldCookieMe = await meRoute(
      getRequest('/api/auth/me', { cookie: `${COOKIE_NAME}=${oldToken}` }),
    );
    expect(oldCookieMe.status).toBe(401);

    // 新会话可用
    const newCookieMe = await meRoute(
      getRequest('/api/auth/me', { cookie: `${COOKIE_NAME}=${newToken}` }),
    );
    expect(newCookieMe.status).toBe(200);
  });

  it('改密接口缺少 Origin 时拒绝', async () => {
    const user = await createTestUser();
    const loginResponse = await login(user.email, user.password);
    const token = tokenOf(loginResponse);

    const response = await changePasswordRoute(
      jsonRequest(
        '/api/auth/change-password',
        { currentPassword: user.password, newPassword: 'another-brand-new-password' },
        { cookie: `${COOKIE_NAME}=${token}` },
      ),
    );

    expect(response.status).toBe(403);
  });

  it('退出登录清除 Cookie，并使令牌失效', async () => {
    const user = await createTestUser();
    const loginResponse = await login(user.email, user.password);
    const token = tokenOf(loginResponse);

    const logoutResponse = await logoutRoute(
      jsonRequest('/api/auth/logout', {}, { origin: ORIGIN, cookie: `${COOKIE_NAME}=${token}` }),
    );

    expect(logoutResponse.status).toBe(200);
    const cleared = setCookieOf(logoutResponse);
    expect(cleared).toContain('Max-Age=0');

    const meAfter = await meRoute(
      getRequest('/api/auth/me', { cookie: `${COOKIE_NAME}=${token}` }),
    );
    expect(meAfter.status).toBe(401);
  });

  it('连续 5 次登录失败后触发限流（429）', async () => {
    const user = await createTestUser();

    for (let index = 0; index < 5; index += 1) {
      const failed = await login(user.email, `wrong-password-${index}`);
      expect(failed.status).toBe(401);
    }

    const blocked = await login(user.email, user.password);
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('伪造 X-Forwarded-For 无法绕过登录限流', async () => {
    const user = await createTestUser();

    // 每次都换一个伪造的 XFF，但应用只信任代理写入的 X-Real-IP（此处缺失 → 同一共享桶）
    for (let index = 0; index < 5; index += 1) {
      const response = await loginRoute(
        jsonRequest(
          '/api/auth/login',
          { email: user.email, password: `wrong-password-${index}` },
          { origin: ORIGIN, 'x-forwarded-for': `10.0.0.${index}` },
        ),
      );
      expect(response.status).toBe(401);
    }

    const blocked = await loginRoute(
      jsonRequest(
        '/api/auth/login',
        { email: user.email, password: user.password },
        { origin: ORIGIN, 'x-forwarded-for': '10.9.9.9' },
      ),
    );

    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('错误响应不包含密码、令牌或哈希', async () => {
    const user = await createTestUser();
    const submitted = 'submitted-password-value-1234';

    const response = await login(user.email, submitted);
    const text = await response.text();

    expect(text).not.toContain(submitted);
    expect(text).not.toContain('$argon2');
    expect(text.toLowerCase()).not.toContain('password_hash');
  });
});
