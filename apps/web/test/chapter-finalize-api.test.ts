/**
 * 章节定稿 API（A1-4B-C-C）。
 *
 * 覆盖：
 * - `in_review` + 最新版本 → finalized；重复定稿同一版本幂等且不重复写审计；
 * - 旧版本 → 409 `CHAPTER_VERSION_CONFLICT`；无版本 / 非 in_review → 409；
 * - 已定稿但版本不同 → 409 `CHAPTER_STATE_INVALID_FOR_FINALIZE`；
 * - 定稿后生成 / 恢复被拒绝；人工保存 revision → 回到 in_review，可再次定稿；
 * - 并发定稿同一版本：一个首次写入、一个幂等，审计最多一条；
 * - 跨章节 / 跨作品 / 随机版本 id → 稳定冲突；401 / 403 / 缺 Origin / 400；
 * - 审计 detail 恰 5 个字段且不含正文；审计失败整体回滚。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { POST as finalizePost } from '../app/api/works/[id]/chapters/[chapterId]/finalize/route.js';
import { POST as generatePost } from '../app/api/works/[id]/chapters/[chapterId]/generate/route.js';
import { POST as versionsPost } from '../app/api/works/[id]/chapters/[chapterId]/versions/route.js';
import { POST as restorePost } from '../app/api/works/[id]/chapters/[chapterId]/versions/[versionId]/restore/route.js';

const ORIGIN = 'http://127.0.0.1:3000';
const MARKER = `定稿机密-${randomUUID().slice(0, 8)}`;

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
  readonly strangerWorkId: string;
}

const works: string[] = [];

async function createUser(role: 'author' | 'admin'): Promise<{ id: string; token: string }> {
  const user = await db.user.create({
    data: {
      email: `chapter-finalize-${role}-${randomUUID()}@example.test`,
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
  const workId = await createWork(author.id, '定稿作品');
  const otherWorkId = await createWork(author.id, '定稿作品-另一部');
  const strangerWorkId = await createWork(stranger.id, '他人作品');

  const chapter = await db.chapter.create({
    data: { workId, chapterNo: 1, title: '第一章' },
    select: { id: true },
  });
  const chapter2 = await db.chapter.create({
    data: { workId, chapterNo: 2, title: '第二章' },
    select: { id: true },
  });
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

interface FinalizeResponse {
  readonly status: number;
  readonly json: {
    chapter?: {
      chapterId: string;
      status: string;
      versionId: string;
      versionNo: number;
      deduplicated: boolean;
    };
    error?: { code: string; message: string };
  };
  readonly text: string;
}

async function finalize(
  fixture: Fixture,
  body: Record<string, unknown>,
  options: { token?: string; origin?: string | null; workId?: string; chapterId?: string } = {},
): Promise<FinalizeResponse> {
  const workId = options.workId ?? fixture.workId;
  const chapterId = options.chapterId ?? fixture.chapterId;
  const token = options.token === undefined ? fixture.token : options.token;
  const response = await finalizePost(
    postRequest(
      `/api/works/${workId}/chapters/${chapterId}/finalize`,
      body,
      options.origin === undefined ? { token } : { token, origin: options.origin },
    ),
    { params: Promise.resolve({ id: workId, chapterId }) },
  );
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as FinalizeResponse['json'], text };
}

async function saveVersion(
  fixture: Fixture,
  content: string,
  baseVersionId: string | null,
): Promise<{ status: number; versionId: string; versionNo: number }> {
  const response = await versionsPost(
    postRequest(
      `/api/works/${fixture.workId}/chapters/${fixture.chapterId}/versions`,
      { content, baseVersionId },
      { token: fixture.token },
    ),
    { params: Promise.resolve({ id: fixture.workId, chapterId: fixture.chapterId }) },
  );
  const body = (await response.json()) as { version?: { versionId: string; versionNo: number } };
  return {
    status: response.status,
    versionId: body.version?.versionId ?? '',
    versionNo: body.version?.versionNo ?? 0,
  };
}

async function seedTwoVersions(fixture: Fixture): Promise<{ v1: string; v2: string }> {
  const first = await saveVersion(fixture, V1_TEXT, null);
  expect(first.status).toBe(201);
  const second = await saveVersion(fixture, V2_TEXT, first.versionId);
  expect(second.status).toBe(201);
  return { v1: first.versionId, v2: second.versionId };
}

async function chapterStatus(chapterId: string): Promise<string> {
  const row = await db.chapter.findUniqueOrThrow({
    where: { id: chapterId },
    select: { status: true },
  });
  return row.status;
}

async function finalizeAuditRows(chapterId: string) {
  return db.auditLog.findMany({
    where: { action: 'chapter.finalized', targetId: chapterId },
    orderBy: { createdAt: 'asc' },
  });
}

beforeAll(() => {
  db = getPrismaClient();
});

afterEach(async () => {
  await db.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS test_block_finalize_audit_trigger ON audit_logs',
  );
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_block_finalize_audit()');
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
  await db.$disconnect();
});

describe('定稿语义', () => {
  it('in_review + 最新版本 → finalized，审计 5 个字段且不含正文', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);
    expect(await chapterStatus(fixture.chapterId)).toBe('in_review');

    const result = await finalize(fixture, { versionId: v2 });
    expect(result.status).toBe(200);
    expect(result.json.chapter).toMatchObject({
      chapterId: fixture.chapterId,
      status: 'finalized',
      versionId: v2,
      versionNo: 2,
      deduplicated: false,
    });
    expect(result.text).not.toContain(MARKER);
    expect(v1).not.toBe(v2);

    expect(await chapterStatus(fixture.chapterId)).toBe('finalized');
    const audits = await finalizeAuditRows(fixture.chapterId);
    expect(audits).toHaveLength(1);
    const detail = audits[0]?.detail as unknown as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(
      ['chapterId', 'versionId', 'versionNo', 'wordCount', 'workId'].sort(),
    );
    expect(detail).toMatchObject({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      versionId: v2,
      versionNo: 2,
    });
    expect(JSON.stringify(detail)).not.toContain(MARKER);
  });

  it('重复定稿同一版本 → 幂等（deduplicated=true），审计不增加', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);

    const first = await finalize(fixture, { versionId: v2 });
    expect(first.status).toBe(200);
    expect(first.json.chapter?.deduplicated).toBe(false);

    const second = await finalize(fixture, { versionId: v2 });
    expect(second.status).toBe(200);
    expect(second.json.chapter?.deduplicated).toBe(true);
    expect(await finalizeAuditRows(fixture.chapterId)).toHaveLength(1);
    expect(await chapterStatus(fixture.chapterId)).toBe('finalized');
  });

  it('versionId 为旧版本 → 409 CHAPTER_VERSION_CONFLICT，状态不变', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);

    const result = await finalize(fixture, { versionId: v1 });
    expect(result.status).toBe(409);
    expect(result.json.error?.code).toBe('CHAPTER_VERSION_CONFLICT');
    expect(await chapterStatus(fixture.chapterId)).toBe('in_review');
    expect(await finalizeAuditRows(fixture.chapterId)).toHaveLength(0);
    expect(v2).not.toBe(v1);
  });

  it('响应字段不变：provider / model 不在请求契约，也不出现在响应里', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);

    // 请求体提交 provider / model 属于未知字段 → 400，且不产生任务
    const rejected = await finalize(fixture, {
      versionId: v2,
      provider: 'openai-compatible',
      model: 'not-allowed',
    });
    expect(rejected.status).toBe(400);
    expect(await chapterStatus(fixture.chapterId)).toBe('in_review');
    expect(await db.generationTask.count({ where: { chapterId: fixture.chapterId } })).toBe(0);

    const ok = await finalize(fixture, { versionId: v2 });
    expect(ok.status).toBe(200);
    // 响应仍只有 chapter 的 5 个字段
    expect(Object.keys(ok.json).sort()).toEqual(['chapter']);
    expect(Object.keys(ok.json.chapter as Record<string, unknown>).sort()).toEqual(
      ['chapterId', 'deduplicated', 'status', 'versionId', 'versionNo'].sort(),
    );
    expect(ok.text).not.toContain('mock-model');
    expect(ok.text).not.toContain('provider');

    // 摘要任务由服务端装配（provider / model 来自配置），但不出现在响应里
    const task = await db.generationTask.findFirstOrThrow({
      where: { chapterId: fixture.chapterId, taskType: 'chapter.summarize' },
    });
    expect(task).toMatchObject({ provider: 'mock', model: 'mock-model' });
    expect(task.inputSnapshot).toEqual({ sourceVersionId: v2 });
  });

  it('无正式版本 → 409 CHAPTER_STATE_INVALID_FOR_FINALIZE', async () => {
    const fixture = await createFixture();

    const result = await finalize(fixture, { versionId: randomUUID() });
    expect(result.status).toBe(409);
    expect(result.json.error?.code).toBe('CHAPTER_STATE_INVALID_FOR_FINALIZE');
  });

  it('planned / outlined / drafting / abandoned → 409，且不写审计', async () => {
    const fixture = await createFixture();
    const { v1 } = await seedTwoVersions(fixture);

    for (const status of ['planned', 'outlined', 'drafting', 'abandoned'] as const) {
      await db.chapter.update({ where: { id: fixture.chapterId }, data: { status } });
      const result = await finalize(fixture, { versionId: v1 });
      expect(result.status, status).toBe(409);
      expect(result.json.error?.code).toBe('CHAPTER_STATE_INVALID_FOR_FINALIZE');
      expect(await chapterStatus(fixture.chapterId)).toBe(status);
    }
    expect(await finalizeAuditRows(fixture.chapterId)).toHaveLength(0);
  });
});

describe('定稿后的写操作边界', () => {
  it('定稿后生成候选 → 409，且不创建任务', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);
    expect((await finalize(fixture, { versionId: v2 })).status).toBe(200);

    const response = await generatePost(
      postRequest(
        `/api/works/${fixture.workId}/chapters/${fixture.chapterId}/generate`,
        { requestId: randomUUID(), targetWords: 3000 },
        { token: fixture.token },
      ),
      { params: Promise.resolve({ id: fixture.workId, chapterId: fixture.chapterId }) },
    );
    const body = (await response.json()) as { error?: { code: string } };
    expect(response.status).toBe(409);
    expect(body.error?.code).toBe('CHAPTER_STATE_INVALID_FOR_GENERATION');
    // A2-D-B 起，定稿会在同一事务内入队 `chapter.summarize`：
    // 这里只要求没有"正文任务"，摘要任务的存在是预期行为。
    expect(
      await db.generationTask.count({
        where: { chapterId: fixture.chapterId, taskType: 'chapter.draft' },
      }),
    ).toBe(0);
    expect(
      await db.generationTask.count({
        where: { chapterId: fixture.chapterId, taskType: 'chapter.summarize' },
      }),
    ).toBe(1);
  });

  it('定稿后恢复历史版本 → 409，且不新增版本', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);
    expect((await finalize(fixture, { versionId: v2 })).status).toBe(200);

    const response = await restorePost(
      postRequest(
        `/api/works/${fixture.workId}/chapters/${fixture.chapterId}/versions/${v1}/restore`,
        { baseVersionId: v2 },
        { token: fixture.token },
      ),
      {
        params: Promise.resolve({
          id: fixture.workId,
          chapterId: fixture.chapterId,
          versionId: v1,
        }),
      },
    );
    const body = (await response.json()) as { error?: { code: string } };
    expect(response.status).toBe(409);
    expect(body.error?.code).toBe('CHAPTER_STATE_INVALID_FOR_SAVE');
    expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(2);
  });

  it('定稿后人工保存 revision → in_review，并可再次定稿', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);
    expect((await finalize(fixture, { versionId: v2 })).status).toBe(200);

    const revised = await saveVersion(fixture, longText(`${MARKER}-修订`), v2);
    expect(revised.status).toBe(201);
    expect(await chapterStatus(fixture.chapterId)).toBe('in_review');

    const again = await finalize(fixture, { versionId: revised.versionId });
    expect(again.status).toBe(200);
    expect(again.json.chapter?.versionNo).toBe(3);
    expect(again.json.chapter?.deduplicated).toBe(false);
    expect(await finalizeAuditRows(fixture.chapterId)).toHaveLength(2);
  });

  it('已定稿但传入不同版本 → 409 CHAPTER_STATE_INVALID_FOR_FINALIZE', async () => {
    const fixture = await createFixture();
    const { v1, v2 } = await seedTwoVersions(fixture);
    expect((await finalize(fixture, { versionId: v2 })).status).toBe(200);

    const result = await finalize(fixture, { versionId: v1 });
    expect(result.status).toBe(409);
    expect(result.json.error?.code).toBe('CHAPTER_STATE_INVALID_FOR_FINALIZE');
    // 已定稿时不会退化成"版本冲突"，避免泄露旧版本是否存在
    expect(result.json.error?.code).not.toBe('CHAPTER_VERSION_CONFLICT');
  });
});

describe('归属与权限', () => {
  it('跨章节 / 随机版本 id → 409 CHAPTER_VERSION_CONFLICT', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);
    // 第二章的版本
    const other = await saveVersion({ ...fixture, chapterId: fixture.chapter2Id }, V1_TEXT, null);
    expect(other.status).toBe(201);

    const crossChapter = await finalize(fixture, { versionId: other.versionId });
    expect(crossChapter.status).toBe(409);
    expect(crossChapter.json.error?.code).toBe('CHAPTER_VERSION_CONFLICT');

    const random = await finalize(fixture, { versionId: randomUUID() });
    expect(random.status).toBe(409);
    expect(random.json.error?.code).toBe('CHAPTER_VERSION_CONFLICT');
    expect(v2).not.toBe('');
  });

  it('跨作品的版本 id → 409（不会命中其它作品）', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);
    const foreignChapter = await db.chapter.findFirstOrThrow({
      where: { workId: fixture.otherWorkId },
      select: { id: true },
    });
    const foreign = await db.chapterVersion.create({
      data: {
        workId: fixture.otherWorkId,
        chapterId: foreignChapter.id,
        versionNo: 1,
        content: V1_TEXT,
        wordCount: V1_TEXT.length,
        source: 'human',
        createdBy: fixture.authorId,
      },
      select: { id: true },
    });

    const result = await finalize(fixture, { versionId: foreign.id });
    expect(result.status).toBe(409);
    expect(result.json.error?.code).toBe('CHAPTER_VERSION_CONFLICT');
    expect(v2).not.toBe('');
  });

  it('未登录 401、管理员 403、他人作品 404', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);
    const admin = await createUser('admin');
    const stranger = await createUser('author');

    expect((await finalize(fixture, { versionId: v2 }, { token: '' })).status).toBe(401);
    expect((await finalize(fixture, { versionId: v2 }, { token: admin.token })).status).toBe(403);
    expect((await finalize(fixture, { versionId: v2 }, { token: stranger.token })).status).toBe(
      404,
    );
  });

  it('缺 Origin → 403', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);

    const result = await finalize(fixture, { versionId: v2 }, { origin: null });
    expect(result.status).toBe(403);
    expect(result.json.error?.code).toBe('INVALID_ORIGIN');
  });
});

describe('请求校验', () => {
  it('缺 versionId / null / 空串 / 非字符串 / 未知字段 / 非法 UUID → 400', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);

    const cases: Record<string, unknown>[] = [
      {},
      { versionId: null },
      { versionId: '' },
      { versionId: 42 },
      { versionId: v2, baseVersionId: v2 },
      { versionId: v2, status: 'finalized' },
      { versionId: 'not-a-uuid' },
    ];
    for (const body of cases) {
      const result = await finalize(fixture, body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.json.error?.code).toBe('VALIDATION_FAILED');
    }
    expect(await chapterStatus(fixture.chapterId)).toBe('in_review');
    expect(await finalizeAuditRows(fixture.chapterId)).toHaveLength(0);
  });
});

describe('并发与回滚', () => {
  it('两次并发定稿同一版本 → 一个首次写入、一个幂等，审计最多一条', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);

    const results = await Promise.all([
      finalize(fixture, { versionId: v2 }),
      finalize(fixture, { versionId: v2 }),
    ]);
    expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 200]);
    const dedupFlags = results.map((result) => result.json.chapter?.deduplicated).sort();
    expect(dedupFlags).toEqual([false, true]);
    expect(await finalizeAuditRows(fixture.chapterId)).toHaveLength(1);
    expect(await chapterStatus(fixture.chapterId)).toBe('finalized');
  });

  it('审计写入失败 → 章节状态整体回滚，之后可正常定稿', async () => {
    const fixture = await createFixture();
    const { v2 } = await seedTwoVersions(fixture);

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_block_finalize_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'chapter.finalized' THEN
          RAISE EXCEPTION 'test: blocked finalize audit';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER test_block_finalize_audit_trigger
        BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION test_block_finalize_audit()
    `);

    let status = 0;
    try {
      const failed = await finalize(fixture, { versionId: v2 });
      status = failed.status;
    } finally {
      await db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_block_finalize_audit_trigger ON audit_logs',
      );
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_block_finalize_audit()');
    }
    expect(status).toBe(500);
    expect(await chapterStatus(fixture.chapterId)).toBe('in_review');
    expect(await finalizeAuditRows(fixture.chapterId)).toHaveLength(0);

    // 去掉拦截后可正常定稿（证明失败只是审计导致的整体回滚）
    const ok = await finalize(fixture, { versionId: v2 });
    expect(ok.status).toBe(200);
    expect(await chapterStatus(fixture.chapterId)).toBe('finalized');
  });
});
