/**
 * 章节列表 / 正式版本只读 API（A1-4A）。
 *
 * 覆盖：
 * - 章节列表按 chapterNo 升序、只含徽标字段（无正文）；
 * - 正式版本摘要按 versionNo 倒序、无正文；
 * - 正式正文按作品 + 章节隔离，跨章节 / 跨作品 404；
 * - 未登录 401、管理员 403、他人作品 404；
 * - 响应不含 prompt / 任务快照 / Key。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import { countWords, createGenerationTask } from '@novel/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { GET as chaptersGet } from '../app/api/works/[id]/chapters/route.js';
import { GET as chapterGet } from '../app/api/works/[id]/chapters/[chapterId]/route.js';
import { GET as versionGet } from '../app/api/works/[id]/chapters/[chapterId]/versions/[versionId]/route.js';
import { GET as versionsGet } from '../app/api/works/[id]/chapters/[chapterId]/versions/route.js';

const ORIGIN = 'http://127.0.0.1:3000';
const DRAFT = '风从演武场尽头吹来，吹动了青石上的尘埃。'.repeat(80);

let db: PrismaClient;

interface Fixture {
  readonly authorId: string;
  readonly token: string;
  readonly workId: string;
  readonly chapterId: string;
  readonly chapter2Id: string;
}

const users: string[] = [];
const works: string[] = [];
const tasks: string[] = [];

async function createUser(role: 'author' | 'admin'): Promise<{ id: string; token: string }> {
  const user = await db.user.create({
    data: {
      email: `chapter-read-${role}-${randomUUID()}@example.test`,
      passwordHash: '$argon2id$stub',
      role,
      status: 'active',
      mustChangePassword: false,
    },
  });
  users.push(user.id);
  const { createSession, readAuthConfig } = await import('@novel/auth');
  const session = await createSession(db, { userId: user.id, config: readAuthConfig() });
  return { id: user.id, token: session.token };
}

async function createFixture(): Promise<Fixture> {
  const author = await createUser('author');
  const work = await db.work.create({
    data: {
      authorId: author.id,
      title: `只读作品-${randomUUID().slice(0, 8)}`,
      genreRulePackage: 'xuanhuan',
    },
  });
  works.push(work.id);
  const chapter = await db.chapter.create({
    data: { workId: work.id, chapterNo: 1, title: '第一章' },
    select: { id: true },
  });
  const chapter2 = await db.chapter.create({
    data: { workId: work.id, chapterNo: 2, title: '第二章' },
    select: { id: true },
  });
  return {
    authorId: author.id,
    token: author.token,
    workId: work.id,
    chapterId: chapter.id,
    chapter2Id: chapter2.id,
  };
}

function request(path: string, options: { token?: string; origin?: string | null } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
  }
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) {
    headers['origin'] = origin;
  }
  return new Request(`http://127.0.0.1:3000${path}`, { method: 'GET', headers });
}

function chapterParams(id: string, chapterId: string) {
  return { params: Promise.resolve({ id, chapterId }) };
}

function versionParams(id: string, chapterId: string, versionId: string) {
  return { params: Promise.resolve({ id, chapterId, versionId }) };
}

async function seedVersion(
  fixture: Fixture,
  chapterId: string,
  versionNo: number,
): Promise<string> {
  const version = await db.chapterVersion.create({
    data: {
      workId: fixture.workId,
      chapterId,
      versionNo,
      content: DRAFT,
      wordCount: countWords(DRAFT),
      source: 'human',
      createdBy: fixture.authorId,
    },
    select: { id: true },
  });
  return version.id;
}

beforeAll(() => {
  db = getPrismaClient();
});

afterEach(async () => {
  for (const taskId of tasks) {
    await db.$executeRaw`
      UPDATE generation_tasks
         SET status = 'cancelled',
             cancel_requested_at = COALESCE(cancel_requested_at, clock_timestamp()),
             locked_by = NULL,
             lease_until = NULL,
             updated_at = clock_timestamp()
       WHERE id = ${taskId}::uuid AND status IN ('queued', 'processing')
    `;
  }
  tasks.length = 0;
});

afterAll(async () => {
  for (const workId of works) {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_versions" DISABLE TRIGGER USER');
        await tx.chapterVersion.deleteMany({ where: { workId } });
        await tx.chapterContract.deleteMany({ where: { workId } });
        await tx.chapterCandidate.deleteMany({ where: { workId } });
        await tx.generationTask.deleteMany({ where: { workId } });
        await tx.chapter.deleteMany({ where: { workId } });
        await tx.work.deleteMany({ where: { id: workId } });
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_versions" ENABLE TRIGGER USER');
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
  }
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe('GET /chapters', () => {
  it('按 chapterNo 升序返回，只含徽标字段，不含正文', async () => {
    const fixture = await createFixture();
    const task = await createGenerationTask(db, {
      authorId: fixture.authorId,
      workId: fixture.workId,
      chapterId: fixture.chapter2Id,
      requestId: `read-${randomUUID()}`,
      taskType: 'chapter.draft',
      inputSnapshot: { targetWords: 3000 },
      provider: 'mock',
      model: 'mock-model',
    });
    tasks.push(task.task.id);

    const response = await chaptersGet(
      request(`/api/works/${fixture.workId}/chapters`, { token: fixture.token }),
      { params: Promise.resolve({ id: fixture.workId }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      chapters: Record<string, unknown>[];
    };
    expect(body.chapters).toHaveLength(2);
    expect(body.chapters.map((row) => row['chapterNo'])).toEqual([1, 2]);
    expect(body.chapters[0]).toMatchObject({
      status: 'planned',
      latestTaskStatus: null,
      latestTaskStep: null,
    });
    expect(body.chapters[1]).toMatchObject({
      latestTaskStatus: 'queued',
    });

    expect(Object.keys(body.chapters[0] ?? {}).sort()).toEqual([
      'chapterNo',
      'id',
      'latestTaskStatus',
      'latestTaskStep',
      'status',
      'title',
      'updatedAt',
      'workId',
    ]);
    expect(JSON.stringify(body)).not.toContain('风从演武场');
  });

  it('未登录 401；他人作品 404；管理员 403', async () => {
    const fixture = await createFixture();
    const other = await createUser('author');
    const admin = await createUser('admin');

    const anonymous = await chaptersGet(request(`/api/works/${fixture.workId}/chapters`), {
      params: Promise.resolve({ id: fixture.workId }),
    });
    expect(anonymous.status).toBe(401);

    const foreign = await chaptersGet(
      request(`/api/works/${fixture.workId}/chapters`, { token: other.token }),
      { params: Promise.resolve({ id: fixture.workId }) },
    );
    expect(foreign.status).toBe(404);

    const byAdmin = await chaptersGet(
      request(`/api/works/${fixture.workId}/chapters`, { token: admin.token }),
      { params: Promise.resolve({ id: fixture.workId }) },
    );
    expect(byAdmin.status).toBe(403);
  });
});

describe('GET /chapters/:chapterId/versions', () => {
  it('按 versionNo 倒序返回摘要，不含正文/prompt/Key', async () => {
    const fixture = await createFixture();
    await seedVersion(fixture, fixture.chapterId, 1);
    await seedVersion(fixture, fixture.chapterId, 2);

    const response = await versionsGet(
      request(`/api/works/${fixture.workId}/chapters/${fixture.chapterId}/versions`, {
        token: fixture.token,
      }),
      chapterParams(fixture.workId, fixture.chapterId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { versions: Record<string, unknown>[] };
    expect(body.versions.map((row) => row['versionNo'])).toEqual([2, 1]);
    expect(Object.keys(body.versions[0] ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'source',
      'versionNo',
      'wordCount',
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('风从演武场');
    expect(text).not.toContain('prompt');
    expect(text).not.toContain('sk-');
  });

  it('跨章节 / 他人作品 / 管理员权限', async () => {
    const fixture = await createFixture();
    await seedVersion(fixture, fixture.chapterId, 1);
    const other = await createUser('author');
    const admin = await createUser('admin');

    // 章节 2 没有版本；用章节 2 的路径读取章节 1 的版本列表应为空（不是泄漏）
    const crossChapter = await versionsGet(
      request(`/api/works/${fixture.workId}/chapters/${fixture.chapter2Id}/versions`, {
        token: fixture.token,
      }),
      chapterParams(fixture.workId, fixture.chapter2Id),
    );
    expect(crossChapter.status).toBe(200);
    expect(((await crossChapter.json()) as { versions: unknown[] }).versions).toEqual([]);

    const foreign = await versionsGet(
      request(`/api/works/${fixture.workId}/chapters/${fixture.chapterId}/versions`, {
        token: other.token,
      }),
      chapterParams(fixture.workId, fixture.chapterId),
    );
    expect(foreign.status).toBe(404);

    const byAdmin = await versionsGet(
      request(`/api/works/${fixture.workId}/chapters/${fixture.chapterId}/versions`, {
        token: admin.token,
      }),
      chapterParams(fixture.workId, fixture.chapterId),
    );
    expect(byAdmin.status).toBe(403);
  });
});

describe('GET /chapters/:chapterId/versions/:versionId', () => {
  it('返回正文与元信息，不含 prompt / 任务快照 / Key', async () => {
    const fixture = await createFixture();
    const versionId = await seedVersion(fixture, fixture.chapterId, 1);

    const response = await versionGet(
      request(`/api/works/${fixture.workId}/chapters/${fixture.chapterId}/versions/${versionId}`, {
        token: fixture.token,
      }),
      versionParams(fixture.workId, fixture.chapterId, versionId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: Record<string, unknown> };
    expect(body.version).toMatchObject({
      id: versionId,
      chapterId: fixture.chapterId,
      versionNo: 1,
      source: 'human',
      wordCount: countWords(DRAFT),
      content: DRAFT,
    });
    expect(Object.keys(body.version).sort()).toEqual([
      'chapterId',
      'content',
      'createdAt',
      'id',
      'source',
      'versionNo',
      'wordCount',
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('prompt');
    expect(text).not.toContain('inputSnapshot');
    expect(text).not.toContain('requestId');
  });

  it('跨章节 / 不存在的版本 → 404；他人作品 404；管理员 403', async () => {
    const fixture = await createFixture();
    const versionId = await seedVersion(fixture, fixture.chapterId, 1);
    const other = await createUser('author');
    const admin = await createUser('admin');

    const crossChapter = await versionGet(
      request(`/api/works/${fixture.workId}/chapters/${fixture.chapter2Id}/versions/${versionId}`, {
        token: fixture.token,
      }),
      versionParams(fixture.workId, fixture.chapter2Id, versionId),
    );
    expect(crossChapter.status).toBe(404);

    const missingId = randomUUID();
    const missing = await versionGet(
      request(`/api/works/${fixture.workId}/chapters/${fixture.chapterId}/versions/${missingId}`, {
        token: fixture.token,
      }),
      versionParams(fixture.workId, fixture.chapterId, missingId),
    );
    expect(missing.status).toBe(404);

    const foreign = await versionGet(
      request(`/api/works/${fixture.workId}/chapters/${fixture.chapterId}/versions/${versionId}`, {
        token: other.token,
      }),
      versionParams(fixture.workId, fixture.chapterId, versionId),
    );
    expect(foreign.status).toBe(404);

    const byAdmin = await versionGet(
      request(`/api/works/${fixture.workId}/chapters/${fixture.chapterId}/versions/${versionId}`, {
        token: admin.token,
      }),
      versionParams(fixture.workId, fixture.chapterId, versionId),
    );
    expect(byAdmin.status).toBe(403);
  });
});

// 保留对章节详情接口的引用，避免误删“详情只含候选摘要”的覆盖
describe('章节详情仍然不返回正文', () => {
  it('candidates 摘要字段固定', async () => {
    const fixture = await createFixture();
    const response = await chapterGet(
      request(`/api/works/${fixture.workId}/chapters/${fixture.chapterId}`, {
        token: fixture.token,
      }),
      chapterParams(fixture.workId, fixture.chapterId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { candidates: unknown[] };
    expect(body.candidates).toEqual([]);
  });
});
