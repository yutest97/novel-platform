/**
 * Coordinator 问答 API 路由测试（C1-A）。
 *
 * 覆盖：鉴权 / 管理员 403 / Origin / 请求体白名单、响应只回显契约字段、
 * 跨作者与畸形 id 404、回答幂等与版本冲突、取消幂等、no-store。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME, createSession, readAuthConfig } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import { NovelCoordinatorWorker, createNovelCoordinatorMockProvider } from '@novel/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as getRunRoute } from '../app/api/novel-runs/[runId]/route.js';
import { POST as answerRunRoute } from '../app/api/novel-runs/[runId]/answer/route.js';
import { POST as cancelRunRoute } from '../app/api/novel-runs/[runId]/cancel/route.js';
import { POST as createRunRoute } from '../app/api/novel-runs/route.js';

const ORIGIN = 'http://127.0.0.1:3000';
const TEST_WORKER_ID = `novel-api-${randomUUID()}`;

let db: PrismaClient;

interface TestUser {
  id: string;
  email: string;
  token: string;
}

const createdRuns: string[] = [];
const createdUsers: string[] = [];

async function createUser(role: 'author' | 'admin'): Promise<TestUser> {
  const email = `novel-api-${role}-${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: {
      email,
      passwordHash: '$argon2id$stub',
      role,
      status: 'active',
      mustChangePassword: false,
    },
  });
  createdUsers.push(user.id);
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

function postRequest(
  path: string,
  options: { token?: string; origin?: string; body?: unknown } = {},
): Request {
  if (options.body === undefined) {
    const headers: Record<string, string> = {};
    if (options.token !== undefined) {
      headers['cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
    }
    if (options.origin !== undefined) {
      headers['origin'] = options.origin;
    }
    return new Request(`http://127.0.0.1:3000${path}`, { method: 'POST', headers });
  }
  return jsonRequest(path, options.body, options);
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

function runContext(runId: string): { params: Promise<{ runId: string }> } {
  return { params: Promise.resolve({ runId }) };
}

async function createRun(token: string, requestText = '写一个东方玄幻故事'): Promise<Response> {
  return createRunRoute(jsonRequest('/api/novel-runs', { requestText }, { token, origin: ORIGIN }));
}

async function createRunId(token: string): Promise<string> {
  const response = await createRun(token);
  expect(response.status).toBe(201);
  const body = (await response.json()) as { runId: string };
  createdRuns.push(body.runId);
  return body.runId;
}

function worker(): NovelCoordinatorWorker {
  return new NovelCoordinatorWorker(db, {
    provider: createNovelCoordinatorMockProvider(),
    workerId: TEST_WORKER_ID,
    leaseMs: 5_000,
    heartbeatIntervalMs: 1_000,
    sweepIntervalMs: 1,
  });
}

async function toWaitingUser(runId: string): Promise<void> {
  // 同一测试文件内可能还有其它 queued run；循环领取直到目标 run 进入 waiting_user。
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const row = await db.novelRun.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true },
    });
    if (row.status === 'waiting_user') {
      return;
    }
    const outcome = await worker().runOnce();
    if (outcome === 'idle' && row.status === 'queued') {
      throw new Error('目标 run 未被 Worker 领取');
    }
  }
  throw new Error('等待 waiting_user 超时');
}

describe('Coordinator 问答 API（C1-A）', () => {
  beforeAll(() => {
    db = getPrismaClient();
  });

  afterAll(async () => {
    if (createdRuns.length > 0) {
      await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('ALTER TABLE "novel_agent_calls" DISABLE TRIGGER USER');
          await tx.$executeRawUnsafe('ALTER TABLE "novel_run_steps" DISABLE TRIGGER USER');
          await tx.$executeRawUnsafe('ALTER TABLE "novel_runs" DISABLE TRIGGER USER');
          await tx.novelAgentCall.deleteMany({ where: { runId: { in: createdRuns } } });
          await tx.novelRunStep.deleteMany({ where: { runId: { in: createdRuns } } });
          await tx.novelRun.deleteMany({ where: { id: { in: createdRuns } } });
          await tx.$executeRawUnsafe('ALTER TABLE "novel_runs" ENABLE TRIGGER USER');
          await tx.$executeRawUnsafe('ALTER TABLE "novel_run_steps" ENABLE TRIGGER USER');
          await tx.$executeRawUnsafe('ALTER TABLE "novel_agent_calls" ENABLE TRIGGER USER');
        },
        { maxWait: 15_000, timeout: 30_000 },
      );
    }
    await db.user.deleteMany({ where: { id: { in: createdUsers } } });
    await db.$disconnect();
  });

  it('未登录 401，管理员 403，Origin 非法 403', async () => {
    const unauthenticated = await createRunRoute(
      jsonRequest('/api/novel-runs', { requestText: '写一个故事' }, { origin: ORIGIN }),
    );
    expect(unauthenticated.status).toBe(401);

    const admin = await createUser('admin');
    const adminResponse = await createRunRoute(
      jsonRequest(
        '/api/novel-runs',
        { requestText: '写一个故事' },
        { token: admin.token, origin: ORIGIN },
      ),
    );
    expect(adminResponse.status).toBe(403);

    const author = await createUser('author');
    const badOrigin = await createRunRoute(
      jsonRequest(
        '/api/novel-runs',
        { requestText: '写一个故事' },
        { token: author.token, origin: 'http://evil.example' },
      ),
    );
    expect(badOrigin.status).toBe(403);
  });

  it('创建只接受 requestText，响应只含 runId / status / version', async () => {
    const author = await createUser('author');

    const forged = await createRunRoute(
      jsonRequest(
        '/api/novel-runs',
        { requestText: '写一个故事', authorId: author.id, status: 'completed' },
        { token: author.token, origin: ORIGIN },
      ),
    );
    expect(forged.status).toBe(400);
    const forgedBody = (await forged.json()) as { error: { code: string } };
    expect(forgedBody.error.code).toBe('VALIDATION_FAILED');

    const response = await createRun(author.token);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['runId', 'status', 'version']);
    expect(body['status']).toBe('queued');
    expect(body['version']).toBe(0);
    createdRuns.push(String(body['runId']));

    const row = await db.novelRun.findUniqueOrThrow({
      where: { id: String(body['runId']) },
      select: { authorId: true, requestText: true, workId: true, stateSummary: true },
    });
    expect(row.authorId).toBe(author.id);
    expect(row.requestText).toBe('写一个东方玄幻故事');
    expect(row.workId).toBeNull();
    // 不创建假 Work，也不把 provider / prompt 写进快照。
    const serialized = JSON.stringify(row.stateSummary);
    expect(serialized).not.toContain('provider');
    expect(serialized).not.toContain('prompt');
  });

  it('读取只回显契约字段；跨作者与畸形 id 404', async () => {
    const author = await createUser('author');
    const runId = await createRunId(author.token);
    await toWaitingUser(runId);

    const response = await getRunRoute(
      getRequest(`/api/novel-runs/${runId}`, { token: author.token }),
      runContext(runId),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'createdAt',
      'currentGoal',
      'decisionSummary',
      'options',
      'question',
      'runId',
      'status',
      'stepCount',
      'updatedAt',
      'version',
    ]);
    expect(body['status']).toBe('waiting_user');
    expect(body['version']).toBe(1);
    expect(typeof body['question']).toBe('string');
    expect(Array.isArray(body['options'])).toBe(true);
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'stateSummary',
      'lockedBy',
      'leaseUntil',
      'provider',
      'model',
      'prompt',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const other = await createUser('author');
    const crossAuthor = await getRunRoute(
      getRequest(`/api/novel-runs/${runId}`, { token: other.token }),
      runContext(runId),
    );
    expect(crossAuthor.status).toBe(404);

    const malformed = await getRunRoute(
      getRequest('/api/novel-runs/not-a-uuid', { token: author.token }),
      runContext('not-a-uuid'),
    );
    expect(malformed.status).toBe(404);
    const malformedBody = (await malformed.json()) as { error: { code: string } };
    expect(malformedBody.error.code).toBe('NOVEL_RUN_NOT_FOUND');
  });

  it('管理员读取一律 403', async () => {
    const admin = await createUser('admin');
    const response = await getRunRoute(
      getRequest(`/api/novel-runs/${randomUUID()}`, { token: admin.token }),
      runContext(randomUUID()),
    );
    expect(response.status).toBe(403);
  });

  it('回答：非 waiting_user 409、旧版本 409、同答案幂等、不同答案 409', async () => {
    const author = await createUser('author');
    const runId = await createRunId(author.token);

    const queuedAnswer = await answerRunRoute(
      jsonRequest(
        `/api/novel-runs/${runId}/answer`,
        { expectedVersion: 0, answer: '太早了' },
        { token: author.token, origin: ORIGIN },
      ),
      runContext(runId),
    );
    expect(queuedAnswer.status).toBe(409);
    expect(((await queuedAnswer.json()) as { error: { code: string } }).error.code).toBe(
      'NOVEL_RUN_INVALID_STATE',
    );

    await toWaitingUser(runId);

    const stale = await answerRunRoute(
      jsonRequest(
        `/api/novel-runs/${runId}/answer`,
        { expectedVersion: 0, answer: '东方玄幻' },
        { token: author.token, origin: ORIGIN },
      ),
      runContext(runId),
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'NOVEL_RUN_VERSION_CONFLICT',
    );

    const ok = await answerRunRoute(
      jsonRequest(
        `/api/novel-runs/${runId}/answer`,
        { expectedVersion: 1, answer: '东方玄幻' },
        { token: author.token, origin: ORIGIN },
      ),
      runContext(runId),
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { status: string; version: number };
    expect(okBody.status).toBe('queued');
    expect(okBody.version).toBe(2);

    // 系统推进后，旧版本 + 同答案仍然幂等回显当前状态。
    await toWaitingUser(runId);
    const repeat = await answerRunRoute(
      jsonRequest(
        `/api/novel-runs/${runId}/answer`,
        { expectedVersion: 1, answer: '东方玄幻' },
        { token: author.token, origin: ORIGIN },
      ),
      runContext(runId),
    );
    expect(repeat.status).toBe(200);
    const repeatBody = (await repeat.json()) as { status: string; version: number };
    expect(repeatBody.status).toBe('waiting_user');
    expect(repeatBody.version).toBe(3);

    const conflict = await answerRunRoute(
      jsonRequest(
        `/api/novel-runs/${runId}/answer`,
        { expectedVersion: 1, answer: '都市异能' },
        { token: author.token, origin: ORIGIN },
      ),
      runContext(runId),
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
      'NOVEL_RUN_ANSWER_CONFLICT',
    );
  });

  it('回答拒绝伪造字段与非法版本类型', async () => {
    const author = await createUser('author');
    const runId = await createRunId(author.token);
    await toWaitingUser(runId);

    const forged = await answerRunRoute(
      jsonRequest(
        `/api/novel-runs/${runId}/answer`,
        { expectedVersion: 1, answer: '东方玄幻', authorId: author.id },
        { token: author.token, origin: ORIGIN },
      ),
      runContext(runId),
    );
    expect(forged.status).toBe(400);

    const badVersion = await answerRunRoute(
      jsonRequest(
        `/api/novel-runs/${runId}/answer`,
        { expectedVersion: '1', answer: '东方玄幻' },
        { token: author.token, origin: ORIGIN },
      ),
      runContext(runId),
    );
    expect(badVersion.status).toBe(400);
  });

  it('取消：queued 直接 cancelled，终态幂等，跨作者 404', async () => {
    const author = await createUser('author');
    const runId = await createRunId(author.token);

    const response = await cancelRunRoute(
      postRequest(`/api/novel-runs/${runId}/cancel`, { token: author.token, origin: ORIGIN }),
      runContext(runId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; version: number };
    expect(body.status).toBe('cancelled');
    expect(body.version).toBe(1);

    const again = await cancelRunRoute(
      postRequest(`/api/novel-runs/${runId}/cancel`, { token: author.token, origin: ORIGIN }),
      runContext(runId),
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { version: number }).version).toBe(1);

    const other = await createUser('author');
    const crossAuthor = await cancelRunRoute(
      postRequest(`/api/novel-runs/${runId}/cancel`, { token: other.token, origin: ORIGIN }),
      runContext(runId),
    );
    expect(crossAuthor.status).toBe(404);
  });

  it('回答 / 取消同样要求合法 Origin', async () => {
    const author = await createUser('author');
    const runId = await createRunId(author.token);
    const noOrigin = await cancelRunRoute(
      postRequest(`/api/novel-runs/${runId}/cancel`, { token: author.token }),
      runContext(runId),
    );
    expect(noOrigin.status).toBe(403);
  });
});
