/**
 * 章节 / 生成任务 / 候选 / 采纳 路由测试（A1-3B）。
 *
 * 关注路由层的五件事：
 * - 会话与归属：未登录 401、他人作品 404、管理员 403、缺 Origin 403；
 * - **严格白名单**：provider / model / authorId / status 等字段必须 400；
 * - provider / model 只来自服务端配置；
 * - requestId 幂等（同内容返回同一任务，异内容 409）；
 * - 响应只含安全字段：不含 prompt、API Key、input_snapshot。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import { countWords } from '@novel/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { GET as chapterGet } from '../app/api/works/[id]/chapters/[chapterId]/route.js';
import { POST as adoptPost } from '../app/api/works/[id]/chapters/[chapterId]/candidates/[candidateId]/adopt/route.js';
import { GET as candidateGet } from '../app/api/works/[id]/chapters/[chapterId]/candidates/[candidateId]/route.js';
import { POST as generatePost } from '../app/api/works/[id]/chapters/[chapterId]/generate/route.js';
import { POST as chaptersPost } from '../app/api/works/[id]/chapters/route.js';
import { POST as cancelPost } from '../app/api/works/[id]/generation-tasks/[taskId]/cancel/route.js';
import { GET as taskGet } from '../app/api/works/[id]/generation-tasks/[taskId]/route.js';

const ORIGIN = 'http://127.0.0.1:3000';
const API_KEY_MARKER = 'sk-test-SECRET-must-not-leak';
const SERVER_MODEL = 'server-configured-model';

/** 正文：1600 个非空白字符，满足候选 `word_count >= 1200` 的数据库下限。 */
const DRAFT = '风从演武场尽头吹来，吹动了青石上的尘埃。'.repeat(80);

let db: PrismaClient;
/**
 * 本文件创建的任务 id。
 *
 * `pnpm test` 里 web 与 workflow 共用同一个 PostgreSQL，而 Worker 的
 * `claimNextTask` 是**全局**取最早 queued 的任务；这里留下的 queued / processing
 * 会被下一个包的 Worker 测试领走。因此每个用例结束都要把它们收敛到终态。
 */
let trackedTaskIds: string[] = [];

interface TestUser {
  id: string;
  token: string;
}

async function createUser(role: 'author' | 'admin'): Promise<TestUser> {
  const user = await db.user.create({
    data: {
      email: `chapter-api-${role}-${randomUUID()}@example.test`,
      passwordHash: '$argon2id$stub',
      role,
      status: 'active',
      mustChangePassword: false,
    },
  });
  const { createSession, readAuthConfig } = await import('@novel/auth');
  const session = await createSession(db, { userId: user.id, config: readAuthConfig() });
  return { id: user.id, token: session.token };
}

async function createWork(authorId: string): Promise<string> {
  const work = await db.work.create({
    data: { authorId, title: `章节作品-${randomUUID()}`, genreRulePackage: 'xuanhuan' },
  });
  return work.id;
}

function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    /** null 表示**不带** Origin（用于缺 Origin 的用例）；省略表示默认可信来源。 */
    origin?: string | null;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.token !== undefined) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
  }
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) {
    headers['origin'] = origin;
  }
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function chapterParams(
  id: string,
  chapterId: string,
): {
  params: Promise<{ id: string; chapterId: string }>;
} {
  return { params: Promise.resolve({ id, chapterId }) };
}

function candidateParams(
  id: string,
  chapterId: string,
  candidateId: string,
): { params: Promise<{ id: string; chapterId: string; candidateId: string }> } {
  return { params: Promise.resolve({ id, chapterId, candidateId }) };
}

function taskParams(
  id: string,
  taskId: string,
): {
  params: Promise<{ id: string; taskId: string }>;
} {
  return { params: Promise.resolve({ id, taskId }) };
}

async function createChapter(
  workId: string,
  token: string,
  chapterNo = 1,
  title = `第一章-${randomUUID().slice(0, 6)}`,
): Promise<{ id: string; chapterNo: number; title: string; status: string }> {
  const response = await chaptersPost(
    request(`/api/works/${workId}/chapters`, {
      method: 'POST',
      body: { chapterNo, title },
      token,
    }),
    { params: Promise.resolve({ id: workId }) },
  );
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  const body = (await response.json()) as {
    chapter: { id: string; chapterNo: number; title: string; status: string };
  };
  return body.chapter;
}

async function startTask(
  workId: string,
  chapterId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ task: Record<string, unknown>; status: number }> {
  const response = await generatePost(
    request(`/api/works/${workId}/chapters/${chapterId}/generate`, {
      method: 'POST',
      body,
      token,
    }),
    chapterParams(workId, chapterId),
  );
  const parsed = (await response.json()) as { task?: Record<string, unknown> };
  const task = parsed.task ?? {};
  if (typeof task['id'] === 'string') {
    trackedTaskIds.push(task['id']);
  }
  return { task, status: response.status };
}

/** 直接种一个候选：需要同任务、同章节、同作品的合同（A1-2 复合外键）。 */
async function seedCandidate(
  workId: string,
  chapterId: string,
  taskId: string,
  content = DRAFT,
): Promise<string> {
  const contract = await db.chapterContract.create({
    data: {
      workId,
      chapterId,
      generationTaskId: taskId,
      versionNo: 1,
      goal: '测试用章节合同',
      mustInclude: [] as never,
      mustNotInclude: [] as never,
      sceneBeats: { version: 1, characters: [], scenes: [] } as never,
      targetWords: 3000,
      status: 'frozen',
    },
    select: { id: true },
  });
  const candidate = await db.chapterCandidate.create({
    data: {
      workId,
      chapterId,
      generationTaskId: taskId,
      contractId: contract.id,
      content,
      wordCount: countWords(content),
      structuredPlan: { version: 1, goal: '测试用章节合同' } as never,
      status: 'candidate',
    },
    select: { id: true },
  });
  return candidate.id;
}

/**
 * 把任务置为 `processing`（模拟 Worker 领取）。
 *
 * 不用 `claimNextTask`：共享测试库里还有其它用例遗留的 queued 任务，
 * 全局领取会拿到最早的那一条，无法确定命中本用例的任务。
 */
async function markProcessing(taskId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE generation_tasks
       SET status = 'processing',
           locked_by = 'api-test-worker',
           lease_until = clock_timestamp() + interval '30 seconds',
           heartbeat_at = clock_timestamp(),
           attempt_count = attempt_count + 1,
           updated_at = clock_timestamp()
     WHERE id = ${taskId}::uuid
  `;
}

/** 记录并恢复模型相关环境变量，避免污染其它用例。 */
const MODEL_ENV_KEYS = ['MODEL_PROVIDER', 'MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_NAME'] as const;
const savedEnv: Record<string, string | undefined> = {};

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

beforeAll(async () => {
  db = getPrismaClient();
  for (const key of MODEL_ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  // 默认走 Mock：不联网、确定性输出
  process.env['MODEL_PROVIDER'] = 'mock';
  delete process.env['MODEL_NAME'];
});

afterEach(async () => {
  for (const id of trackedTaskIds) {
    await db.$executeRaw`
      UPDATE generation_tasks
         SET status = 'cancelled',
             cancel_requested_at = COALESCE(cancel_requested_at, clock_timestamp()),
             locked_by = NULL,
             lease_until = NULL,
             updated_at = clock_timestamp()
       WHERE id = ${id}::uuid AND status IN ('queued', 'processing')
    `;
  }
  trackedTaskIds = [];
});

afterAll(async () => {
  for (const key of MODEL_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await db.$disconnect();
});

describe('章节创建与读取', () => {
  it('未登录 → 401', async () => {
    const response = await chaptersPost(
      request('/api/works/00000000-0000-0000-0000-000000000000/chapters', {
        method: 'POST',
        body: { chapterNo: 1, title: '第一章' },
      }),
      { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) },
    );
    expect(response.status).toBe(401);
  });

  it('作者创建章节：初始 planned，审计只含 workId/chapterId/chapterNo', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    const chapter = await createChapter(workId, author.token, 3, '  第三章  ');
    expect(chapter.chapterNo).toBe(3);
    expect(chapter.title).toBe('第三章');
    expect(chapter.status).toBe('planned');

    const audits = await db.auditLog.findMany({
      where: { action: 'chapter.created', targetId: chapter.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe(author.id);
    const detail = audits[0]?.detail as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(['chapterId', 'chapterNo', 'workId']);
  });

  it('重复章号 → 409 CHAPTER_NO_TAKEN；非法章号/标题 → 400', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    await createChapter(workId, author.token, 1);

    const duplicate = await chaptersPost(
      request(`/api/works/${workId}/chapters`, {
        method: 'POST',
        body: { chapterNo: 1, title: '重复章号' },
        token: author.token,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()) as unknown).toMatchObject({
      error: { code: 'CHAPTER_NO_TAKEN' },
    });

    for (const body of [
      { chapterNo: 0, title: '零章' },
      { chapterNo: -1, title: '负章' },
      { chapterNo: 1.5, title: '小数章' },
      { chapterNo: '2', title: '字符串章号' },
      { chapterNo: 2, title: '   ' },
      { chapterNo: 2, title: 'x'.repeat(201) },
      { chapterNo: 2, title: '带状态', status: 'drafting' },
      { chapterNo: 2, title: '带时间', createdAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      const response = await chaptersPost(
        request(`/api/works/${workId}/chapters`, {
          method: 'POST',
          body,
          token: author.token,
        }),
        { params: Promise.resolve({ id: workId }) },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('缺 Origin → 403；他人作品 → 404；管理员 → 403', async () => {
    const author = await createUser('author');
    const other = await createUser('author');
    const admin = await createUser('admin');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);

    const noOrigin = await chaptersPost(
      request(`/api/works/${workId}/chapters`, {
        method: 'POST',
        body: { chapterNo: 2, title: '缺来源' },
        token: author.token,
        origin: null,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(noOrigin.status).toBe(403);

    const foreign = await chaptersPost(
      request(`/api/works/${workId}/chapters`, {
        method: 'POST',
        body: { chapterNo: 2, title: '他人作品' },
        token: other.token,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(foreign.status).toBe(404);

    const byAdmin = await chapterGet(
      request(`/api/works/${workId}/chapters/${chapter.id}`, { token: admin.token }),
      chapterParams(workId, chapter.id),
    );
    expect(byAdmin.status).toBe(403);
  });

  it('章节详情：章节 + 最新任务 + 候选摘要（不含正文）', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);

    const empty = await chapterGet(
      request(`/api/works/${workId}/chapters/${chapter.id}`, { token: author.token }),
      chapterParams(workId, chapter.id),
    );
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as {
      chapter: { id: string };
      latestTask: unknown;
      candidates: unknown[];
    };
    expect(emptyBody.chapter.id).toBe(chapter.id);
    expect(emptyBody.latestTask).toBeNull();
    expect(emptyBody.candidates).toEqual([]);

    const { task } = await startTask(workId, chapter.id, author.token, {
      requestId: `req-${randomUUID()}`,
    });
    await seedCandidate(workId, chapter.id, String(task['id']));

    const response = await chapterGet(
      request(`/api/works/${workId}/chapters/${chapter.id}`, { token: author.token }),
      chapterParams(workId, chapter.id),
    );
    const body = (await response.json()) as {
      latestTask: Record<string, unknown>;
      candidates: Record<string, unknown>[];
    };
    expect(body.latestTask['id']).toBe(task['id']);
    expect(body.candidates).toHaveLength(1);
    // 摘要不含正文
    expect(Object.keys(body.candidates[0] ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'status',
      'wordCount',
    ]);
    expect(JSON.stringify(body)).not.toContain('风从演武场');
  });
});

describe('生成任务', () => {
  it('创建任务：provider/model 来自服务端配置；input_snapshot 只含 targetWords/style', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);

    const requestId = `req-${randomUUID()}`;
    const { task, status } = await withEnv(
      {
        MODEL_PROVIDER: 'openai-compatible',
        MODEL_BASE_URL: 'https://model.example.test/v1',
        MODEL_API_KEY: API_KEY_MARKER,
        MODEL_NAME: SERVER_MODEL,
      },
      () =>
        startTask(workId, chapter.id, author.token, {
          requestId,
          targetWords: 3000,
          style: { tone: '克制', pointOfView: '第三人称限知', pacing: '中速' },
        }),
    );

    expect(status).toBe(201);
    expect(task['status']).toBe('queued');
    expect(task['chapterId']).toBe(chapter.id);

    const row = await db.generationTask.findFirstOrThrow({ where: { requestId, workId } });
    expect(row.taskType).toBe('chapter.draft');
    // provider / model 来自服务端环境变量（客户端未提交）
    expect(row.provider).toBe('openai-compatible');
    expect(row.model).toBe(SERVER_MODEL);
    // 快照只含 targetWords / style，且不含 Key
    expect(row.inputSnapshot).toEqual({
      targetWords: 3000,
      style: { tone: '克制', pointOfView: '第三人称限知', pacing: '中速' },
    });
    expect(JSON.stringify(row.inputSnapshot)).not.toContain(API_KEY_MARKER);
  });

  it('客户端提交 provider/model/authorId/status → 400', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);

    for (const extra of [
      { provider: 'openai-compatible' },
      { model: 'client-model' },
      { authorId: author.id },
      { status: 'succeeded' },
      { workId },
      { inputSnapshot: { prompt: 'x' } },
    ]) {
      const response = await generatePost(
        request(`/api/works/${workId}/chapters/${chapter.id}/generate`, {
          method: 'POST',
          body: { requestId: `req-${randomUUID()}`, ...extra },
          token: author.token,
        }),
        chapterParams(workId, chapter.id),
      );
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await db.generationTask.count({ where: { chapterId: chapter.id } })).toBe(0);
  });

  it('finalized / abandoned 章节不能提交生成：409、不建任务、不写审计', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);

    for (const status of ['finalized', 'abandoned'] as const) {
      await db.chapter.update({ where: { id: chapter.id }, data: { status } });
      const tasksBefore = await db.generationTask.count({ where: { chapterId: chapter.id } });
      const auditsBefore = await db.auditLog.count();

      const response = await generatePost(
        request(`/api/works/${workId}/chapters/${chapter.id}/generate`, {
          method: 'POST',
          body: { requestId: `req-${randomUUID()}` },
          token: author.token,
        }),
        chapterParams(workId, chapter.id),
      );

      expect(response.status, status).toBe(409);
      expect((await response.json()) as unknown).toMatchObject({
        error: { code: 'CHAPTER_STATE_INVALID_FOR_GENERATION' },
      });
      expect(await db.generationTask.count({ where: { chapterId: chapter.id } })).toBe(tasksBefore);
      expect(await db.auditLog.count()).toBe(auditsBefore);
    }

    expect(await db.generationTask.count({ where: { chapterId: chapter.id } })).toBe(0);
  });

  it('planned / outlined / drafting / in_review 均可创建生成任务', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    let chapterNo = 1;

    for (const status of ['planned', 'outlined', 'drafting', 'in_review'] as const) {
      const chapter = await createChapter(workId, author.token, chapterNo);
      chapterNo += 1;
      await db.chapter.update({ where: { id: chapter.id }, data: { status } });

      const { task, status: httpStatus } = await startTask(workId, chapter.id, author.token, {
        requestId: `req-${randomUUID()}`,
      });
      expect(httpStatus, status).toBe(201);
      expect(task['status'], status).toBe('queued');
      expect(task['chapterId']).toBe(chapter.id);
    }
  });

  it('幂等优先：章节定稿后同 requestId 同内容重试 → 200 返回原任务，不新增任务', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);
    const requestId = `req-${randomUUID()}`;

    const first = await startTask(workId, chapter.id, author.token, {
      requestId,
      targetWords: 3000,
    });
    expect(first.status).toBe(201);
    await db.chapter.update({ where: { id: chapter.id }, data: { status: 'finalized' } });

    const retry = await startTask(workId, chapter.id, author.token, {
      requestId,
      targetWords: 3000,
    });
    expect(retry.status).toBe(200);
    expect(retry.task['id']).toBe(first.task['id']);
    expect(await db.generationTask.count({ where: { chapterId: chapter.id } })).toBe(1);
  });

  it('幂等优先：定稿后同 requestId 异内容 → 409 TASK_REQUEST_CONFLICT（不是状态错误）', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);
    const requestId = `req-${randomUUID()}`;

    const first = await startTask(workId, chapter.id, author.token, {
      requestId,
      targetWords: 3000,
    });
    expect(first.status).toBe(201);
    await db.chapter.update({ where: { id: chapter.id }, data: { status: 'finalized' } });

    const response = await generatePost(
      request(`/api/works/${workId}/chapters/${chapter.id}/generate`, {
        method: 'POST',
        body: { requestId, targetWords: 3200 },
        token: author.token,
      }),
      chapterParams(workId, chapter.id),
    );
    expect(response.status).toBe(409);
    expect((await response.json()) as unknown).toMatchObject({
      error: { code: 'TASK_REQUEST_CONFLICT' },
    });
    expect(await db.generationTask.count({ where: { chapterId: chapter.id } })).toBe(1);
  });

  it('已有任务后，全新 requestId 在 finalized / abandoned 章节仍被状态闸门拦下', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    for (const status of ['finalized', 'abandoned'] as const) {
      const chapter = await createChapter(workId, author.token, status === 'finalized' ? 1 : 2);
      const first = await startTask(workId, chapter.id, author.token, {
        requestId: `req-${randomUUID()}`,
      });
      expect(first.status, status).toBe(201);

      await db.chapter.update({ where: { id: chapter.id }, data: { status } });
      const tasksBefore = await db.generationTask.count({ where: { chapterId: chapter.id } });

      const response = await generatePost(
        request(`/api/works/${workId}/chapters/${chapter.id}/generate`, {
          method: 'POST',
          body: { requestId: `req-${randomUUID()}` },
          token: author.token,
        }),
        chapterParams(workId, chapter.id),
      );
      expect(response.status, status).toBe(409);
      expect((await response.json()) as unknown).toMatchObject({
        error: { code: 'CHAPTER_STATE_INVALID_FOR_GENERATION' },
      });
      expect(await db.generationTask.count({ where: { chapterId: chapter.id } })).toBe(tasksBefore);
    }
  });

  it('同 requestId 同输入 → 返回同一任务（200）；异输入 → 409 TASK_REQUEST_CONFLICT', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);
    const requestId = `req-${randomUUID()}`;

    const first = await startTask(workId, chapter.id, author.token, { requestId });
    expect(first.status).toBe(201);
    const second = await startTask(workId, chapter.id, author.token, { requestId });
    expect(second.status).toBe(200);
    expect(second.task['id']).toBe(first.task['id']);
    expect(await db.generationTask.count({ where: { chapterId: chapter.id } })).toBe(1);

    const conflicting = await generatePost(
      request(`/api/works/${workId}/chapters/${chapter.id}/generate`, {
        method: 'POST',
        body: { requestId, targetWords: 3200 },
        token: author.token,
      }),
      chapterParams(workId, chapter.id),
    );
    expect(conflicting.status).toBe(409);
    expect((await conflicting.json()) as unknown).toMatchObject({
      error: { code: 'TASK_REQUEST_CONFLICT' },
    });
    expect(await db.generationTask.count({ where: { chapterId: chapter.id } })).toBe(1);
  });

  it('生成任务写接口同样要求 Origin', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);

    const response = await generatePost(
      request(`/api/works/${workId}/chapters/${chapter.id}/generate`, {
        method: 'POST',
        body: { requestId: `req-${randomUUID()}` },
        token: author.token,
        origin: null,
      }),
      chapterParams(workId, chapter.id),
    );
    expect(response.status).toBe(403);
  });

  it('查看任务只返回安全摘要：不含 input_snapshot / requestId / 租约 / Key', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);
    const { task } = await startTask(workId, chapter.id, author.token, {
      requestId: `req-${randomUUID()}`,
    });

    const response = await taskGet(
      request(`/api/works/${workId}/generation-tasks/${String(task['id'])}`, {
        token: author.token,
      }),
      taskParams(workId, String(task['id'])),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { task: Record<string, unknown> };
    expect(Object.keys(body.task).sort()).toEqual([
      'attemptCount',
      'cancelRequestedAt',
      'chapterId',
      'createdAt',
      'currentStep',
      'errorCode',
      'errorMessage',
      'id',
      'maxAttempts',
      'status',
      'updatedAt',
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('inputSnapshot');
    expect(text).not.toContain('requestId');
    expect(text).not.toContain(API_KEY_MARKER);
  });

  it('取消 queued 任务 → cancelled；取消后不会被领取', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);
    const { task } = await startTask(workId, chapter.id, author.token, {
      requestId: `req-${randomUUID()}`,
    });

    const response = await cancelPost(
      request(`/api/works/${workId}/generation-tasks/${String(task['id'])}/cancel`, {
        method: 'POST',
        token: author.token,
      }),
      taskParams(workId, String(task['id'])),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { task: { status: string }; record: unknown };
    expect(body.task.status).toBe('cancelled');

    const row = await db.generationTask.findUniqueOrThrow({
      where: { id: String(task['id']) },
    });
    expect(row.status).toBe('cancelled');
    expect(row.cancelRequestedAt).not.toBeNull();
    expect(row.lockedBy).toBeNull();
  });

  it('取消后用相同参数、新 requestId 重新生成 → 新任务（旧 requestId 仍幂等命中 cancelled）', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);
    const firstRequestId = `req-${randomUUID()}`;
    const first = await startTask(workId, chapter.id, author.token, {
      requestId: firstRequestId,
      targetWords: 3000,
    });

    const cancelled = await cancelPost(
      request(`/api/works/${workId}/generation-tasks/${String(first.task['id'])}/cancel`, {
        method: 'POST',
        token: author.token,
      }),
      taskParams(workId, String(first.task['id'])),
    );
    expect(cancelled.status).toBe(200);

    // 旧 requestId 重放：按幂等返回既有 cancelled 任务，这就是前端必须换新 id 的原因
    const replay = await startTask(workId, chapter.id, author.token, {
      requestId: firstRequestId,
      targetWords: 3000,
    });
    expect(replay.status).toBe(200);
    expect(replay.task['id']).toBe(first.task['id']);
    expect(replay.task['status']).toBe('cancelled');

    // 新 requestId：必须创建新任务，页面才不会停在旧的 cancelled 上
    const fresh = await startTask(workId, chapter.id, author.token, {
      requestId: `req-${randomUUID()}`,
      targetWords: 3000,
    });
    expect(fresh.status).toBe(201);
    expect(fresh.task['id']).not.toBe(first.task['id']);
    expect(fresh.task['status']).toBe('queued');

    const count = await db.generationTask.count({ where: { chapterId: chapter.id } });
    expect(count).toBe(2);
  });

  it('取消 processing 任务只写 cancel_requested_at，状态仍为 processing', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);
    const { task } = await startTask(workId, chapter.id, author.token, {
      requestId: `req-${randomUUID()}`,
    });

    await markProcessing(String(task['id']));

    const response = await cancelPost(
      request(`/api/works/${workId}/generation-tasks/${String(task['id'])}/cancel`, {
        method: 'POST',
        token: author.token,
      }),
      taskParams(workId, String(task['id'])),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      task: { status: string; cancelRequestedAt: string | null };
    };
    expect(body.task.status).toBe('processing');
    expect(body.task.cancelRequestedAt).not.toBeNull();
  });

  it('他人作品 / 管理员不能查看或取消任务', async () => {
    const author = await createUser('author');
    const other = await createUser('author');
    const admin = await createUser('admin');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);
    const { task } = await startTask(workId, chapter.id, author.token, {
      requestId: `req-${randomUUID()}`,
    });
    const taskId = String(task['id']);

    const foreign = await taskGet(
      request(`/api/works/${workId}/generation-tasks/${taskId}`, { token: other.token }),
      taskParams(workId, taskId),
    );
    expect(foreign.status).toBe(404);

    const adminGet = await taskGet(
      request(`/api/works/${workId}/generation-tasks/${taskId}`, { token: admin.token }),
      taskParams(workId, taskId),
    );
    expect(adminGet.status).toBe(403);

    const adminCancel = await cancelPost(
      request(`/api/works/${workId}/generation-tasks/${taskId}/cancel`, {
        method: 'POST',
        token: admin.token,
      }),
      taskParams(workId, taskId),
    );
    expect(adminCancel.status).toBe(403);
  });
});

describe('候选读取与采纳', () => {
  it('候选读取：作者可读；他人 404；管理员 403；跨章节 404', async () => {
    const author = await createUser('author');
    const other = await createUser('author');
    const admin = await createUser('admin');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token, 1);
    const another = await createChapter(workId, author.token, 2);
    const { task } = await startTask(workId, chapter.id, author.token, {
      requestId: `req-${randomUUID()}`,
    });
    const candidateId = await seedCandidate(workId, chapter.id, String(task['id']));

    const ok = await candidateGet(
      request(`/api/works/${workId}/chapters/${chapter.id}/candidates/${candidateId}`, {
        token: author.token,
      }),
      candidateParams(workId, chapter.id, candidateId),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      candidate: Record<string, unknown>;
    };
    expect(Object.keys(body.candidate).sort()).toEqual([
      'chapterId',
      'content',
      'contractId',
      'createdAt',
      'id',
      'status',
      'structuredPlan',
      'wordCount',
    ]);
    expect(body.candidate['content']).toBe(DRAFT);
    expect(body.candidate['wordCount']).toBe(countWords(DRAFT));

    const foreign = await candidateGet(
      request(`/api/works/${workId}/chapters/${chapter.id}/candidates/${candidateId}`, {
        token: other.token,
      }),
      candidateParams(workId, chapter.id, candidateId),
    );
    expect(foreign.status).toBe(404);

    const byAdmin = await candidateGet(
      request(`/api/works/${workId}/chapters/${chapter.id}/candidates/${candidateId}`, {
        token: admin.token,
      }),
      candidateParams(workId, chapter.id, candidateId),
    );
    expect(byAdmin.status).toBe(403);

    // 跨章节：候选属于 chapter，却用 another 的路径读取
    const crossChapter = await candidateGet(
      request(`/api/works/${workId}/chapters/${another.id}/candidates/${candidateId}`, {
        token: author.token,
      }),
      candidateParams(workId, another.id, candidateId),
    );
    expect(crossChapter.status).toBe(404);
    expect((await crossChapter.json()) as unknown).toMatchObject({
      error: { code: 'CHAPTER_CANDIDATE_NOT_FOUND' },
    });
  });

  it('采纳成功 → 201；重复采纳 → 200 deduplicated；不返回正文', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);
    const { task } = await startTask(workId, chapter.id, author.token, {
      requestId: `req-${randomUUID()}`,
    });
    const candidateId = await seedCandidate(workId, chapter.id, String(task['id']));

    const first = await adoptPost(
      request(`/api/works/${workId}/chapters/${chapter.id}/candidates/${candidateId}/adopt`, {
        method: 'POST',
        body: { requestId: `adopt-${randomUUID()}` },
        token: author.token,
      }),
      candidateParams(workId, chapter.id, candidateId),
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { version: Record<string, unknown> };
    expect(Object.keys(firstBody.version).sort()).toEqual([
      'chapterStatus',
      'deduplicated',
      'versionId',
      'versionNo',
      'wordCount',
    ]);
    expect(firstBody.version).toMatchObject({
      versionNo: 1,
      wordCount: countWords(DRAFT),
      chapterStatus: 'in_review',
      deduplicated: false,
    });
    expect(JSON.stringify(firstBody)).not.toContain('风从演武场');

    const second = await adoptPost(
      request(`/api/works/${workId}/chapters/${chapter.id}/candidates/${candidateId}/adopt`, {
        method: 'POST',
        body: {},
        token: author.token,
      }),
      candidateParams(workId, chapter.id, candidateId),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { version: { deduplicated: boolean } };
    expect(secondBody.version.deduplicated).toBe(true);

    expect(await db.chapterVersion.count({ where: { chapterId: chapter.id } })).toBe(1);
  });

  it('finalized 章节采纳 → 409 CHAPTER_STATE_INVALID_FOR_ADOPTION', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);
    const { task } = await startTask(workId, chapter.id, author.token, {
      requestId: `req-${randomUUID()}`,
    });
    const candidateId = await seedCandidate(workId, chapter.id, String(task['id']));

    await db.chapter.update({ where: { id: chapter.id }, data: { status: 'finalized' } });

    const response = await adoptPost(
      request(`/api/works/${workId}/chapters/${chapter.id}/candidates/${candidateId}/adopt`, {
        method: 'POST',
        body: {},
        token: author.token,
      }),
      candidateParams(workId, chapter.id, candidateId),
    );
    expect(response.status).toBe(409);
    expect((await response.json()) as unknown).toMatchObject({
      error: { code: 'CHAPTER_STATE_INVALID_FOR_ADOPTION' },
    });
    expect(await db.chapterVersion.count({ where: { chapterId: chapter.id } })).toBe(0);
  });

  it('采纳要求 Origin；他人作品 404；管理员 403', async () => {
    const author = await createUser('author');
    const other = await createUser('author');
    const admin = await createUser('admin');
    const workId = await createWork(author.id);
    const chapter = await createChapter(workId, author.token);
    const { task } = await startTask(workId, chapter.id, author.token, {
      requestId: `req-${randomUUID()}`,
    });
    const candidateId = await seedCandidate(workId, chapter.id, String(task['id']));

    const noOrigin = await adoptPost(
      request(`/api/works/${workId}/chapters/${chapter.id}/candidates/${candidateId}/adopt`, {
        method: 'POST',
        body: {},
        token: author.token,
        origin: null,
      }),
      candidateParams(workId, chapter.id, candidateId),
    );
    expect(noOrigin.status).toBe(403);

    const foreign = await adoptPost(
      request(`/api/works/${workId}/chapters/${chapter.id}/candidates/${candidateId}/adopt`, {
        method: 'POST',
        body: {},
        token: other.token,
      }),
      candidateParams(workId, chapter.id, candidateId),
    );
    expect(foreign.status).toBe(404);

    const byAdmin = await adoptPost(
      request(`/api/works/${workId}/chapters/${chapter.id}/candidates/${candidateId}/adopt`, {
        method: 'POST',
        body: {},
        token: admin.token,
      }),
      candidateParams(workId, chapter.id, candidateId),
    );
    expect(byAdmin.status).toBe(403);

    // 未知字段（例如 approval 之类的臆造字段）一律 400
    const unknownField = await adoptPost(
      request(`/api/works/${workId}/chapters/${chapter.id}/candidates/${candidateId}/adopt`, {
        method: 'POST',
        body: { versionNo: 9 },
        token: author.token,
      }),
      candidateParams(workId, chapter.id, candidateId),
    );
    expect(unknownField.status).toBe(400);
  });

  it('跨作品候选采纳 → 404 CHAPTER_CANDIDATE_NOT_FOUND', async () => {
    const author = await createUser('author');
    const workA = await createWork(author.id);
    const workB = await createWork(author.id);
    const chapterA = await createChapter(workA, author.token, 1);
    const chapterB = await createChapter(workB, author.token, 1);
    const { task } = await startTask(workB, chapterB.id, author.token, {
      requestId: `req-${randomUUID()}`,
    });
    const candidateB = await seedCandidate(workB, chapterB.id, String(task['id']));

    const response = await adoptPost(
      request(`/api/works/${workA}/chapters/${chapterA.id}/candidates/${candidateB}/adopt`, {
        method: 'POST',
        body: {},
        token: author.token,
      }),
      candidateParams(workA, chapterA.id, candidateB),
    );
    expect(response.status).toBe(404);
  });
});
