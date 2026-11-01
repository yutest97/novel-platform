/**
 * 作品接口的路由层测试（M2-A）。
 *
 * 覆盖：未登录 401、非作者 403、停用 403、首登未改密 403、
 * Origin 校验、authorId 伪造无效、作者间隔离。
 */

import { randomUUID } from 'node:crypto';

import { getPrismaClient, type PrismaClient } from '@novel/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as listWorksRoute, POST as createWorkRoute } from '../app/api/works/route.js';
import { GET as getWorkRoute, PATCH as updateWorkRoute } from '../app/api/works/[id]/route.js';
import { SESSION_COOKIE_NAME } from '@novel/auth';

const ORIGIN = 'http://127.0.0.1:3000';

let db: PrismaClient;

interface TestUser {
  id: string;
  email: string;
  token: string;
}

async function createUser(role: 'author' | 'admin'): Promise<TestUser> {
  const email = `works-api-${role}-${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: {
      email,
      passwordHash: '$argon2id$stub',
      role,
      status: 'active',
      mustChangePassword: false,
    },
  });

  // 直接签发会话令牌（绕过密码校验，只为测试接口层）
  const { createSession } = await import('@novel/auth');
  const { readAuthConfig } = await import('@novel/auth');
  const config = readAuthConfig();
  const session = await createSession(db, { userId: user.id, config });

  return { id: user.id, email, token: session.token };
}

function jsonRequest(
  path: string,
  body: unknown,
  options: { token?: string; origin?: string } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
  }
  if (options.origin !== undefined) {
    headers['origin'] = options.origin;
  }
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function getRequest(path: string, options: { token?: string; origin?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
  }
  if (options.origin !== undefined) {
    headers['origin'] = options.origin;
  }
  return new Request(`http://127.0.0.1:3000${path}`, { method: 'GET', headers });
}

describe('作品接口（M2-A）', () => {
  beforeAll(() => {
    db = getPrismaClient();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('未登录访问作品列表返回 401', async () => {
    const response = await listWorksRoute(getRequest('/api/works'));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('未登录创建作品返回 401', async () => {
    // 带合法 Origin 但没有会话 Cookie —— 与现有接口一致：
    // Origin 校验通过后才进入会话校验，未登录一律 401。
    const response = await createWorkRoute(
      jsonRequest(
        '/api/works',
        { title: '未登录作品', genreRulePackage: 'xuanhuan' },
        { origin: ORIGIN },
      ),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('管理员访问作品接口返回 403', async () => {
    const admin = await createUser('admin');
    const listResponse = await listWorksRoute(getRequest('/api/works', { token: admin.token }));
    expect(listResponse.status).toBe(403);
    const body = (await listResponse.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');

    const createResponse = await createWorkRoute(
      jsonRequest(
        '/api/works',
        { title: '管理员作品', genreRulePackage: 'xuanhuan' },
        { token: admin.token, origin: ORIGIN },
      ),
    );
    expect(createResponse.status).toBe(403);
  });

  it('首登未改密的作者无法创建作品（403）', async () => {
    const email = `works-api-pending-${randomUUID()}@example.test`;
    const user = await db.user.create({
      data: {
        email,
        passwordHash: '$argon2id$stub',
        role: 'author',
        status: 'active',
        mustChangePassword: true,
      },
    });
    const { createSession } = await import('@novel/auth');
    const { readAuthConfig } = await import('@novel/auth');
    const session = await createSession(db, { userId: user.id, config: readAuthConfig() });

    const response = await createWorkRoute(
      jsonRequest(
        '/api/works',
        { title: '未改密作品', genreRulePackage: 'xuanhuan' },
        { token: session.token, origin: ORIGIN },
      ),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('已停用的作者无法访问作品接口（403）', async () => {
    const author = await createUser('author');
    // 先拿到会话，再停用账号（验证"每次请求重新校验状态"）
    await db.user.update({ where: { id: author.id }, data: { status: 'disabled' } });

    const response = await listWorksRoute(getRequest('/api/works', { token: author.token }));
    expect(response.status).toBe(403);
  });

  it('创建作品缺少 Origin 返回 403', async () => {
    const author = await createUser('author');
    const response = await createWorkRoute(
      jsonRequest(
        '/api/works',
        { title: '无来源作品', genreRulePackage: 'xuanhuan' },
        { token: author.token },
      ),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_ORIGIN');
  });

  it('伪造 authorId 或 role 的请求被拒绝', async () => {
    const author = await createUser('author');
    const other = await createUser('author');

    const forged = await createWorkRoute(
      jsonRequest(
        '/api/works',
        {
          title: '伪造作者',
          genreRulePackage: 'xuanhuan',
          authorId: other.id,
          role: 'admin',
        },
        { token: author.token, origin: ORIGIN },
      ),
    );
    expect(forged.status).toBe(400);
    const body = (await forged.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');

    // 且没有产生任何作品
    const rows = await db.work.findMany({ where: { title: '伪造作者' } });
    expect(rows).toHaveLength(0);
  });

  it('作者创建作品成功，authorId 来自会话', async () => {
    const author = await createUser('author');
    const response = await createWorkRoute(
      jsonRequest(
        '/api/works',
        { title: `接口作品-${randomUUID()}`, genreRulePackage: 'xuanhuan' },
        { token: author.token, origin: ORIGIN },
      ),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { work: { id: string } };
    const row = await db.work.findUniqueOrThrow({ where: { id: body.work.id } });
    expect(row.authorId).toBe(author.id);
  });

  it('作者列表只包含自己的作品；访问他人作品返回 404', async () => {
    const authorA = await createUser('author');
    const authorB = await createUser('author');

    const created = await createWorkRoute(
      jsonRequest(
        '/api/works',
        { title: `隔离作品-${randomUUID()}`, genreRulePackage: 'xuanhuan' },
        { token: authorA.token, origin: ORIGIN },
      ),
    );
    const { work } = (await created.json()) as { work: { id: string; title: string } };

    const listB = await listWorksRoute(getRequest('/api/works', { token: authorB.token }));
    const listBody = (await listB.json()) as { works: { id: string; title: string }[] };
    expect(listBody.works.map((item) => item.title)).not.toContain(work.title);

    const detail = await getWorkRoute(
      getRequest(`/api/works/${work.id}`, { token: authorB.token }),
      { params: Promise.resolve({ id: work.id }) },
    );
    expect(detail.status).toBe(404);
  });

  it('更新作品：不能修改 authorId 与题材', async () => {
    const author = await createUser('author');
    const other = await createUser('author');

    const created = await createWorkRoute(
      jsonRequest(
        '/api/works',
        { title: `待改作品-${randomUUID()}`, genreRulePackage: 'xuanhuan' },
        { token: author.token, origin: ORIGIN },
      ),
    );
    const { work } = (await created.json()) as { work: { id: string } };

    const patched = await updateWorkRoute(
      jsonRequest(
        `/api/works/${work.id}`,
        { title: '改过的标题', targetChapters: 25 },
        { token: author.token, origin: ORIGIN },
      ),
      { params: Promise.resolve({ id: work.id }) },
    );
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { work: { title: string; targetChapters: number } };
    expect(body.work.title).toBe('改过的标题');
    expect(body.work.targetChapters).toBe(25);

    // 试图把作品"转移"给另一个作者：请求体里的服务端字段被拒绝
    const forged = await updateWorkRoute(
      jsonRequest(
        `/api/works/${work.id}`,
        { authorId: other.id },
        { token: author.token, origin: ORIGIN },
      ),
      { params: Promise.resolve({ id: work.id }) },
    );
    expect(forged.status).toBe(400);

    const row = await db.work.findUniqueOrThrow({ where: { id: work.id } });
    expect(row.authorId).toBe(author.id);
    expect(row.genreRulePackage).toBe('xuanhuan');
  });

  it('响应体不含 passwordHash、authorId 等敏感字段', async () => {
    const author = await createUser('author');
    const created = await createWorkRoute(
      jsonRequest(
        '/api/works',
        { title: `安全字段-${randomUUID()}`, genreRulePackage: 'xuanhuan' },
        { token: author.token, origin: ORIGIN },
      ),
    );
    const text = await created.text();
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('authorId');
    expect(text).not.toContain('argon2');
  });

  it('重复标题返回 409 WORK_TITLE_TAKEN', async () => {
    const author = await createUser('author');
    const title = `重复标题-${randomUUID()}`;

    const first = await createWorkRoute(
      jsonRequest(
        '/api/works',
        { title, genreRulePackage: 'xuanhuan' },
        { token: author.token, origin: ORIGIN },
      ),
    );
    expect(first.status).toBe(201);

    const second = await createWorkRoute(
      jsonRequest(
        '/api/works',
        { title, genreRulePackage: 'xuanhuan' },
        { token: author.token, origin: ORIGIN },
      ),
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORK_TITLE_TAKEN');
  });

  it('参数校验失败返回 400', async () => {
    const author = await createUser('author');

    const missingTitle = await createWorkRoute(
      jsonRequest(
        '/api/works',
        { genreRulePackage: 'xuanhuan' },
        { token: author.token, origin: ORIGIN },
      ),
    );
    expect(missingTitle.status).toBe(400);

    const badGenre = await createWorkRoute(
      jsonRequest(
        '/api/works',
        { title: `题材错误-${randomUUID()}`, genreRulePackage: 'no-such-genre' },
        { token: author.token, origin: ORIGIN },
      ),
    );
    expect(badGenre.status).toBe(400);
    const body = (await badGenre.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_RULE_PACKAGE');
  });
});
