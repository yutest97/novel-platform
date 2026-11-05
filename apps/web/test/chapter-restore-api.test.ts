/**
 * 历史版本恢复 API（A1-4B-C-B）。
 *
 * 覆盖：
 * - 恢复历史版本 → 新版本（正文 / 字数原样复制、parent 指向恢复前最新版）；
 * - 原历史版本与中间版本原样保留（append-only，绝不修改 / 删除）；
 * - 恢复最新版本 → 409 `CHAPTER_VERSION_ALREADY_LATEST`；
 * - 同 base 并发恰好 201 + 409，只新增一个版本；
 * - 基线过期 → 409 `CHAPTER_VERSION_CONFLICT`；
 * - 跨章节 / 跨作品 / 随机版本 id → 404；401 / 403 / 缺 Origin；
 * - 严格白名单：缺 baseVersionId / null / 空串 / 非法 UUID / 未知字段 → 400；
 * - abandoned → 409；审计 detail 只有 7 个字段且不含正文；审计失败整体回滚；
 * - 响应不含正文。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import { restoreChapterVersion } from '@novel/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { POST as versionsPost } from '../app/api/works/[id]/chapters/[chapterId]/versions/route.js';
import { POST as restorePost } from '../app/api/works/[id]/chapters/[chapterId]/versions/[versionId]/restore/route.js';

const ORIGIN = 'http://127.0.0.1:3000';
const MARKER = `恢复机密-${randomUUID().slice(0, 8)}`;

/** 造一段满足 1200 非空白字符下限的正文。 */
function longText(marker: string): string {
  return `${marker}，风从演武场尽头吹来，吹动了青石上的尘埃。${'他握紧了手中的剑。'.repeat(160)}`;
}

const V1_TEXT = longText(`${MARKER}-第一版`);
const V2_TEXT = longText(`${MARKER}-第二版`);

let db: PrismaClient;

interface Fixture {
  readonly authorId: string;
  readonly token: string;
  readonly workId: string;
  readonly chapterId: string;
  readonly chapter2Id: string;
  /** 同一作者的另一个作品（测跨作品版本）。 */
  readonly otherWorkId: string;
  /** 另一个作者的作品（测他人作品）。 */
  readonly strangerWorkId: string;
}

const users: string[] = [];
const works: string[] = [];

async function createUser(role: 'author' | 'admin'): Promise<{ id: string; token: string }> {
  const user = await db.user.create({
    data: {
      email: `chapter-restore-${role}-${randomUUID()}@example.test`,
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

async function createWork(authorId: string, prefix: string): Promise<string> {
  const work = await db.work.create({
    data: {
      authorId,
      title: `${prefix}-${randomUUID().slice(0, 8)}`,
      genreRulePackage: 'xuanhuan',
    },
    select: { id: true },
  });
  works.push(work.id);
  return work.id;
}

async function createFixture(): Promise<Fixture> {
  const author = await createUser('author');
  const stranger = await createUser('author');
  const workId = await createWork(author.id, '恢复作品');
  const otherWorkId = await createWork(author.id, '恢复作品-另一部');
  const strangerWorkId = await createWork(stranger.id, '他人作品');

  const chapter = await db.chapter.create({
    data: { workId, chapterNo: 1, title: '第一章' },
    select: { id: true },
  });
  const chapter2 = await db.chapter.create({
    data: { workId, chapterNo: 2, title: '第二章' },
    select: { id: true },
  });
  // 其它作品里各放一章：用于构造"属于别的作品 / 别的章节"的版本。
  await db.chapter.create({ data: { workId: otherWorkId, chapterNo: 1, title: '别作第一章' } });
  await db.chapter.create({ data: { workId: strangerWorkId, chapterNo: 1, title: '他人第一章' } });

  return {
    authorId: author.id,
    token: author.token,
    workId,
    chapterId: chapter.id,
    chapter2Id: chapter2.id,
    otherWorkId,
    strangerWorkId,
  };
}

function postRequest(
  path: string,
  body: unknown,
  options: { token?: string; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
  }
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) {
    headers['origin'] = origin;
  }
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function saveVersion(
  fixture: Fixture,
  content: string,
  baseVersionId: string | null,
): Promise<{ status: number; versionId: string; versionNo: number }> {
  const response = await versionsPost(
    postRequest(
      `/api/works/${fixture.workId}/chapters/${fixture.chapterId}/versions`,
      {
        content,
        baseVersionId,
      },
      { token: fixture.token },
    ),
    { params: Promise.resolve({ id: fixture.workId, chapterId: fixture.chapterId }) },
  );
  const body = (await response.json()) as {
    version?: { versionId: string; versionNo: number };
  };
  return {
    status: response.status,
    versionId: body.version?.versionId ?? '',
    versionNo: body.version?.versionNo ?? 0,
  };
}

interface RestoreResponse {
  readonly status: number;
  readonly json: {
    version?: {
      versionId: string;
      versionNo: number;
      wordCount: number;
      source: string;
      parentVersionId: string;
      restoredFromVersionId: string;
      chapterStatus: string;
    };
    error?: { code: string; message: string };
  };
  readonly text: string;
}

async function restore(
  fixture: Fixture,
  sourceVersionId: string,
  body: Record<string, unknown>,
  options: {
    token?: string;
    origin?: string | null;
    workId?: string;
    chapterId?: string;
  } = {},
): Promise<RestoreResponse> {
  const workId = options.workId ?? fixture.workId;
  const chapterId = options.chapterId ?? fixture.chapterId;
  const token = options.token === undefined ? fixture.token : options.token;
  const response = await restorePost(
    postRequest(
      `/api/works/${workId}/chapters/${chapterId}/versions/${sourceVersionId}/restore`,
      body,
      options.origin === undefined ? { token } : { token, origin: options.origin },
    ),
    { params: Promise.resolve({ id: workId, chapterId, versionId: sourceVersionId }) },
  );
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as RestoreResponse['json'], text };
}

/** 建一个带版本 1 / 2 的章节，返回两个版本 id。 */
async function seedTwoVersions(fixture: Fixture): Promise<{ v1: string; v2: string }> {
  const first = await saveVersion(fixture, V1_TEXT, null);
  expect(first.status).toBe(201);
  const second = await saveVersion(fixture, V2_TEXT, first.versionId);
  expect(second.status).toBe(201);
  return { v1: first.versionId, v2: second.versionId };
}

async function versionRows(chapterId: string) {
  return db.chapterVersion.findMany({
    where: { chapterId },
    orderBy: { versionNo: 'asc' },
    select: {
      id: true,
      versionNo: true,
      source: true,
      parentVersionId: true,
      wordCount: true,
      content: true,
    },
  });
}

async function chapterStatus(chapterId: string): Promise<string> {
  const row = await db.chapter.findUniqueOrThrow({
    where: { id: chapterId },
    select: { status: true },
  });
  return row.status;
}

async function restoreAuditRows(chapterId: string) {
  return db.auditLog.findMany({
    where: { action: 'chapter.version_restored', targetId: chapterId },
    orderBy: { createdAt: 'asc' },
  });
}

beforeAll(() => {
  db = getPrismaClient();
});

afterEach(async () => {
  await db.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS test_block_restore_audit_trigger ON audit_logs',
  );
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_block_restore_audit()');
});

afterAll(async () => {
  for (const workId of works) {
    await db.$transaction(
      async (tx) => {
        // chapter_versions 有不可变触发器（UPDATE/DELETE 拒绝），清理测试数据要先禁用。
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
  // audit_logs 是 append-only，测试用户不删（同其它章节测试策略）。
  await db.$disconnect();
});

describe('恢复语义', () => {
  it('恢复版本 1 → 新版本 3，正文与字数与版本 1 一致，版本 1/2 原样保留', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);
    const before = await versionRows(fixture.chapterId);

    const restored = await restore(fixture, v1, { baseVersionId: v2 });
    expect(restored.status).toBe(201);
    expect(restored.json.version).toMatchObject({
      versionNo: 3,
      source: 'human',
      parentVersionId: v2,
      restoredFromVersionId: v1,
      chapterStatus: 'in_review',
    });

    const after = await versionRows(fixture.chapterId);
    expect(after.map((row) => row.versionNo)).toEqual([1, 2, 3]);
    // 新版本正文 / 字数与来源版本完全一致（服务端原样复制，不重新计算）
    expect(after[2]?.content).toBe(before[0]?.content);
    expect(after[2]?.wordCount).toBe(before[0]?.wordCount);
    expect(restored.json.version?.wordCount).toBe(before[0]?.wordCount);
    // 历史版本一个字节都没动
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
  });

  it('恢复中间版本 → parent 指向恢复前最新版，restoredFromVersionId 指向来源', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);

    const restored = await restore(fixture, v1, { baseVersionId: v2 });
    expect(restored.status).toBe(201);
    const rows = await versionRows(fixture.chapterId);
    expect(rows[2]?.parentVersionId).toBe(v2);
    expect(restored.json.version?.restoredFromVersionId).toBe(v1);
  });

  it('恢复后章节状态进入 in_review（finalized 也会被拉回）', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);
    await db.chapter.update({ where: { id: fixture.chapterId }, data: { status: 'finalized' } });

    const restored = await restore(fixture, v1, { baseVersionId: v2 });
    expect(restored.status).toBe(201);
    expect(await chapterStatus(fixture.chapterId)).toBe('in_review');
  });
});

describe('恢复目标与冲突', () => {
  it('恢复最新版本 → 409 CHAPTER_VERSION_ALREADY_LATEST，不新增版本', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);

    const restored = await restore(fixture, v2, { baseVersionId: v2 });
    expect(restored.status).toBe(409);
    expect(restored.json.error?.code).toBe('CHAPTER_VERSION_ALREADY_LATEST');
    expect(restored.json.error?.message).toBe('该版本已是最新版本，无需恢复');
    expect(await versionRows(fixture.chapterId)).toHaveLength(2);
  });

  it('baseVersionId 过期 → 409 CHAPTER_VERSION_CONFLICT，不新增版本', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);

    const restored = await restore(fixture, v1, { baseVersionId: v1 });
    expect(restored.status).toBe(409);
    expect(restored.json.error?.code).toBe('CHAPTER_VERSION_CONFLICT');
    expect(await versionRows(fixture.chapterId)).toHaveLength(2);
    expect(v1).not.toBe(v2);
  });

  it('同 base 并发恢复 → 恰好 201 + 409，只新增一个版本且版本号连续', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);

    const results = await Promise.all([
      restore(fixture, v1, { baseVersionId: v2 }),
      restore(fixture, v1, { baseVersionId: v2 }),
    ]);
    const statuses = results.map((result) => result.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const conflict = results.find((result) => result.status === 409);
    expect(conflict?.json.error?.code).toBe('CHAPTER_VERSION_CONFLICT');

    const rows = await versionRows(fixture.chapterId);
    expect(rows.map((row) => row.versionNo)).toEqual([1, 2, 3]);
  });
});

describe('归属与权限', () => {
  it('跨章节的版本 → 404（不经过 HTTP 校验也一样）', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);
    const other = await saveVersionToAnotherChapter(fixture);

    const restored = await restore(fixture, other, { baseVersionId: v2 });
    expect(restored.status).toBe(404);
    expect(restored.json.error?.code).toBe('NOT_FOUND');
    expect(await versionRows(fixture.chapterId)).toHaveLength(2);
  });

  it('跨作品的版本 → 404', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);
    const foreign = await db.chapterVersion.create({
      data: {
        workId: fixture.otherWorkId,
        chapterId: await firstChapterOf(fixture.otherWorkId),
        versionNo: 1,
        content: V1_TEXT,
        wordCount: V1_TEXT.length,
        source: 'human',
        createdBy: fixture.authorId,
      },
      select: { id: true },
    });

    const restored = await restore(fixture, foreign.id, { baseVersionId: v2 });
    expect(restored.status).toBe(404);
    expect(restored.json.error?.code).toBe('NOT_FOUND');
  });

  it('随机 / 不存在的版本 id → 404', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);

    const restored = await restore(fixture, randomUUID(), { baseVersionId: v2 });
    expect(restored.status).toBe(404);
    expect(restored.json.error?.code).toBe('NOT_FOUND');
  });

  it('未登录 401、管理员 403、他人作品 404', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);
    const admin = await createUser('admin');
    const stranger = await createUser('author');

    const anonymous = await restore(fixture, v1, { baseVersionId: v2 }, { token: '' });
    expect(anonymous.status).toBe(401);

    const byAdmin = await restore(fixture, v1, { baseVersionId: v2 }, { token: admin.token });
    expect(byAdmin.status).toBe(403);

    const byStranger = await restore(fixture, v1, { baseVersionId: v2 }, { token: stranger.token });
    expect(byStranger.status).toBe(404);
  });
});

describe('请求校验', () => {
  it('缺 Origin → 403', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);

    const restored = await restore(fixture, v1, { baseVersionId: v2 }, { origin: null });
    expect(restored.status).toBe(403);
    expect(restored.json.error?.code).toBe('INVALID_ORIGIN');
  });

  it('缺 baseVersionId / null / 空串 / 非字符串 / 未知字段 / 非法 UUID → 400', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);

    const cases: Record<string, unknown>[] = [
      {},
      { baseVersionId: null },
      { baseVersionId: '' },
      { baseVersionId: 42 },
      { baseVersionId: v2, content: '越权提交正文' },
      { baseVersionId: v2, sourceVersionId: v1 },
      { baseVersionId: 'not-a-uuid' },
    ];
    for (const body of cases) {
      const restored = await restore(fixture, v1, body);
      expect(restored.status, JSON.stringify(body)).toBe(400);
      expect(restored.json.error?.code).toBe('VALIDATION_FAILED');
    }
    expect(await versionRows(fixture.chapterId)).toHaveLength(2);
  });

  it('非法 sourceVersionId（非 UUID）→ 400', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);

    const restored = await restore(fixture, 'not-a-uuid', { baseVersionId: v2 });
    expect(restored.status).toBe(400);
    expect(restored.json.error?.code).toBe('VALIDATION_FAILED');
  });

  it('响应不含正文', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);

    const restored = await restore(fixture, v1, { baseVersionId: v2 });
    expect(restored.status).toBe(201);
    expect(restored.text).not.toContain(MARKER);
    expect(restored.text).not.toContain('风从演武场尽头吹来');
  });
});

describe('章节状态与审计', () => {
  it('abandoned 章节 → 409 CHAPTER_STATE_INVALID_FOR_SAVE', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);
    await db.chapter.update({ where: { id: fixture.chapterId }, data: { status: 'abandoned' } });

    const restored = await restore(fixture, v1, { baseVersionId: v2 });
    expect(restored.status).toBe(409);
    expect(restored.json.error?.code).toBe('CHAPTER_STATE_INVALID_FOR_SAVE');
    expect(await versionRows(fixture.chapterId)).toHaveLength(2);
  });

  it('审计 chapter.version_restored 的 detail 只有 7 个字段且不含正文', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);

    const restored = await restore(fixture, v1, { baseVersionId: v2 });
    expect(restored.status).toBe(201);

    const audits = await restoreAuditRows(fixture.chapterId);
    expect(audits).toHaveLength(1);
    const detail = audits[0]?.detail as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(
      [
        'chapterId',
        'parentVersionId',
        'sourceVersionId',
        'versionId',
        'versionNo',
        'wordCount',
        'workId',
      ].sort(),
    );
    expect(detail).toMatchObject({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: v1,
      parentVersionId: v2,
      versionNo: 3,
    });
    expect(JSON.stringify(detail)).not.toContain(MARKER);
  });

  it('审计写入失败 → 版本与章节状态整体回滚', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_block_restore_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'chapter.version_restored' THEN
          RAISE EXCEPTION 'test: blocked restore audit';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER test_block_restore_audit_trigger
        BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION test_block_restore_audit()
    `);

    let status = 0;
    try {
      const failed = await restore(fixture, v1, { baseVersionId: v2 });
      status = failed.status;
    } finally {
      await db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_block_restore_audit_trigger ON audit_logs',
      );
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_block_restore_audit()');
    }
    expect(status).toBe(500);
    expect(await versionRows(fixture.chapterId)).toHaveLength(2);
    expect(await restoreAuditRows(fixture.chapterId)).toHaveLength(0);

    // 去掉拦截后可正常恢复（证明失败只是审计导致的整体回滚）
    const ok = await restore(fixture, v1, { baseVersionId: v2 });
    expect(ok.status).toBe(201);
    expect(await versionRows(fixture.chapterId)).toHaveLength(3);
  });
});

describe('服务层直接调用', () => {
  it('只读来源版本：恢复前后历史版本内容 / 字数不变', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);
    const before = await versionRows(fixture.chapterId);

    const restored = await restoreChapterVersion({
      db,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      sourceVersionId: v1,
      baseVersionId: v2,
    });

    expect(restored.versionNo).toBe(3);
    expect(restored.restoredFromVersionId).toBe(v1);
    const after = await versionRows(fixture.chapterId);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
  });
});

/** 在 fixture 的第二章里造一个版本，用于跨章节用例。 */
async function saveVersionToAnotherChapter(fixture: Fixture): Promise<string> {
  const response = await versionsPost(
    postRequest(
      `/api/works/${fixture.workId}/chapters/${fixture.chapter2Id}/versions`,
      { content: V2_TEXT, baseVersionId: null },
      { token: fixture.token },
    ),
    { params: Promise.resolve({ id: fixture.workId, chapterId: fixture.chapter2Id }) },
  );
  const body = (await response.json()) as { version?: { versionId: string } };
  expect(response.status).toBe(201);
  return body.version?.versionId ?? '';
}

/** 取作品的第一章 id（用于跨作品版本）。 */
async function firstChapterOf(workId: string): Promise<string> {
  const chapter = await db.chapter.findFirstOrThrow({
    where: { workId },
    orderBy: { chapterNo: 'asc' },
    select: { id: true },
  });
  return chapter.id;
}
