/**
 * 章节版本摘要只读 API（A2-D-D）。
 *
 * 覆盖：
 * - 有摘要 → 200、字段完整、日期 ISO、响应不含正文 / provider / model / task；
 * - 无摘要但版本存在 → 404 `SUMMARY_NOT_FOUND`；
 * - 跨作品 / 跨章节 / 随机 versionId → 404；
 * - 未登录 401、管理员 403；
 * - 只读：不写 audit_logs、不改 summary / version / task；
 * - 历史版本的摘要可单独读取，不会被当前版本摘要替换。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import { countWords } from '@novel/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as summaryGet } from '../app/api/works/[id]/chapters/[chapterId]/versions/[versionId]/summary/route.js';

/** 正文里的机密标记：绝不能出现在摘要响应里。 */
const MARKER = `摘要机密-${randomUUID().slice(0, 8)}`;
const CONTENT = `${MARKER}，风从演武场尽头吹来。${'他握紧了手中的剑。'.repeat(160)}`;

let db: PrismaClient;

interface Fixture {
  readonly authorId: string;
  readonly token: string;
  readonly adminToken: string;
  readonly workId: string;
  readonly chapterId: string;
  /** 同一作品的第二章（测跨章节）。 */
  readonly chapter2Id: string;
  /** 同一作者的另一个作品。 */
  readonly otherWorkId: string;
  readonly otherChapterId: string;
  /** 他人作品 + 章节。 */
  readonly strangerWorkId: string;
  readonly strangerChapterId: string;
}

const works: string[] = [];

async function createUser(role: 'author' | 'admin'): Promise<{ id: string; token: string }> {
  const user = await db.user.create({
    data: {
      email: `chapter-summary-${role}-${randomUUID()}@example.test`,
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
  const admin = await createUser('admin');
  const stranger = await createUser('author');
  const workId = await createWork(author.id, '摘要作品');
  const otherWorkId = await createWork(author.id, '摘要作品-另一部');
  const strangerWorkId = await createWork(stranger.id, '他人摘要作品');

  const chapter = await db.chapter.create({
    data: { workId, chapterNo: 1, title: '第一章' },
    select: { id: true },
  });
  const chapter2 = await db.chapter.create({
    data: { workId, chapterNo: 2, title: '第二章' },
    select: { id: true },
  });
  const otherChapter = await db.chapter.create({
    data: { workId: otherWorkId, chapterNo: 1, title: '别作第一章' },
    select: { id: true },
  });
  const strangerChapter = await db.chapter.create({
    data: { workId: strangerWorkId, chapterNo: 1, title: '他人第一章' },
    select: { id: true },
  });

  return {
    authorId: author.id,
    token: author.token,
    adminToken: admin.token,
    workId,
    chapterId: chapter.id,
    chapter2Id: chapter2.id,
    otherWorkId,
    otherChapterId: otherChapter.id,
    strangerWorkId,
    strangerChapterId: strangerChapter.id,
  };
}

/** 造一个正式版本（不经过定稿流程：本卡只测只读接口）。 */
async function seedVersion(options: {
  readonly workId: string;
  readonly chapterId: string;
  readonly authorId: string;
  readonly versionNo: number;
}): Promise<string> {
  const version = await db.chapterVersion.create({
    data: {
      workId: options.workId,
      chapterId: options.chapterId,
      versionNo: options.versionNo,
      content: CONTENT,
      wordCount: countWords(CONTENT),
      source: 'human',
      createdBy: options.authorId,
    },
    select: { id: true },
  });
  return version.id;
}

async function seedSummary(options: {
  readonly workId: string;
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly summary: string;
}): Promise<string> {
  const row = await db.chapterSummary.create({
    data: {
      workId: options.workId,
      chapterId: options.chapterId,
      sourceVersionId: options.sourceVersionId,
      agentName: 'summarizer.chapter',
      agentVersion: '1.0.0',
      provider: 'openai-compatible',
      model: 'gpt-4o-mini-summary',
      summary: options.summary,
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(() => {
  db = getPrismaClient();
});

afterAll(async () => {
  for (const workId of works) {
    await db.$transaction(
      async (tx) => {
        // summary / version 都是 append-only：测试清理沿用受控关闭触发器策略
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_summaries" DISABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_versions" DISABLE TRIGGER USER');
        await tx.chapterSummary.deleteMany({ where: { workId } });
        await tx.chapterVersion.deleteMany({ where: { workId } });
        await tx.chapter.deleteMany({ where: { workId } });
        await tx.work.deleteMany({ where: { id: workId } });
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_versions" ENABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_summaries" ENABLE TRIGGER USER');
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
  }
});

function getRequest(path: string, options: { token?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
  }
  return new Request(`http://127.0.0.1:3000${path}`, { method: 'GET', headers });
}

interface HttpResult {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly text: string;
  readonly headers: Headers;
}

async function read(response: Response): Promise<HttpResult> {
  const text = await response.text();
  return {
    status: response.status,
    json: JSON.parse(text) as Record<string, unknown>,
    text,
    headers: response.headers,
  };
}

async function fetchSummary(
  fixture: Fixture,
  versionId: string,
  options: { token?: string; workId?: string; chapterId?: string } = {},
): Promise<HttpResult> {
  const workId = options.workId ?? fixture.workId;
  const chapterId = options.chapterId ?? fixture.chapterId;
  const token = options.token === undefined ? fixture.token : options.token;
  return read(
    await summaryGet(
      getRequest(`/api/works/${workId}/chapters/${chapterId}/versions/${versionId}/summary`, {
        token,
      }),
      { params: Promise.resolve({ id: workId, chapterId, versionId }) },
    ),
  );
}

interface SummaryBody {
  readonly summary: {
    id: string;
    chapterId: string;
    sourceVersionId: string;
    versionNo: number;
    summary: string;
    agentName: string;
    agentVersion: string;
    createdAt: string;
  };
}

function summaryOf(result: HttpResult): SummaryBody['summary'] {
  return (result.json as unknown as SummaryBody).summary;
}

describe('读取摘要', () => {
  it('有摘要 → 200，字段完整且日期为 ISO', async () => {
    const fixture = await createFixture();
    const versionId = await seedVersion({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      versionNo: 1,
    });
    const summaryId = await seedSummary({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: versionId,
      summary: '主角在演武场初次显露天赋。',
    });

    const result = await fetchSummary(fixture, versionId);

    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(result.json)).toEqual(['summary']);
    const summary = summaryOf(result);
    expect(summary).toEqual({
      id: summaryId,
      chapterId: fixture.chapterId,
      sourceVersionId: versionId,
      versionNo: 1,
      summary: '主角在演武场初次显露天赋。',
      agentName: 'summarizer.chapter',
      agentVersion: '1.0.0',
      createdAt: summary.createdAt,
    });
    expect(Number.isNaN(Date.parse(summary.createdAt))).toBe(false);
    // 只有 8 个字段：没有正文、任务、provider / model
    expect(Object.keys(summary).sort()).toEqual([
      'agentName',
      'agentVersion',
      'chapterId',
      'createdAt',
      'id',
      'sourceVersionId',
      'summary',
      'versionNo',
    ]);
  });

  it('版本存在但还没有摘要 → 404 SUMMARY_NOT_FOUND', async () => {
    const fixture = await createFixture();
    const versionId = await seedVersion({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      versionNo: 1,
    });

    const result = await fetchSummary(fixture, versionId);

    expect(result.status).toBe(404);
    expect((result.json.error as { code: string }).code).toBe('SUMMARY_NOT_FOUND');
  });

  it('跨作品 / 跨章节 / 随机 versionId → 404 SUMMARY_NOT_FOUND', async () => {
    const fixture = await createFixture();
    const versionId = await seedVersion({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      versionNo: 1,
    });
    await seedSummary({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: versionId,
      summary: '本作摘要。',
    });

    // 换到另一部作品的章节
    const crossWork = await fetchSummary(fixture, versionId, {
      workId: fixture.otherWorkId,
      chapterId: fixture.otherChapterId,
    });
    expect(crossWork.status).toBe(404);
    expect((crossWork.json.error as { code: string }).code).toBe('SUMMARY_NOT_FOUND');

    // 同作品但换章节
    const crossChapter = await fetchSummary(fixture, versionId, { chapterId: fixture.chapter2Id });
    expect(crossChapter.status).toBe(404);
    expect((crossChapter.json.error as { code: string }).code).toBe('SUMMARY_NOT_FOUND');

    // 随机版本 id
    const random = await fetchSummary(fixture, randomUUID());
    expect(random.status).toBe(404);
    expect((random.json.error as { code: string }).code).toBe('SUMMARY_NOT_FOUND');
  });

  it('未登录 401；管理员 403；他人作品 404', async () => {
    const fixture = await createFixture();
    const versionId = await seedVersion({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      versionNo: 1,
    });
    await seedSummary({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: versionId,
      summary: '本作摘要。',
    });

    expect((await fetchSummary(fixture, versionId, { token: '' })).status).toBe(401);
    expect((await fetchSummary(fixture, versionId, { token: fixture.adminToken })).status).toBe(
      403,
    );

    // 他人作品：requireOwnedWork 直接 404（不区分"不是你的"与"不存在"）
    const strangerVersion = await seedVersion({
      workId: fixture.strangerWorkId,
      chapterId: fixture.strangerChapterId,
      authorId: fixture.authorId,
      versionNo: 1,
    });
    const foreign = await fetchSummary(fixture, strangerVersion, {
      workId: fixture.strangerWorkId,
      chapterId: fixture.strangerChapterId,
    });
    expect(foreign.status).toBe(404);
    expect((foreign.json.error as { code: string }).code).toBe('NOT_FOUND');
  });

  it('响应不含正文、provider / model 与任务字段', async () => {
    const fixture = await createFixture();
    const versionId = await seedVersion({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      versionNo: 1,
    });
    await seedSummary({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: versionId,
      summary: '主角在演武场初次显露天赋。',
    });

    const result = await fetchSummary(fixture, versionId);

    expect(result.text).not.toContain(MARKER);
    expect(result.text).not.toContain('他握紧了手中的剑。'.repeat(3));
    for (const forbidden of [
      'provider',
      'model',
      'gpt-4o-mini-summary',
      'generationTask',
      'inputSnapshot',
      'requestId',
      'prompt',
    ]) {
      expect(result.text).not.toContain(forbidden);
    }
  });

  it('只读：不写 audit_logs，也不改 summary / version / task', async () => {
    const fixture = await createFixture();
    const versionId = await seedVersion({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      versionNo: 1,
    });
    const summaryId = await seedSummary({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: versionId,
      summary: '主角在演武场初次显露天赋。',
    });

    const before = {
      audit: await db.auditLog.count({ where: { targetId: fixture.chapterId } }),
      summary: await db.chapterSummary.findUniqueOrThrow({ where: { id: summaryId } }),
      version: await db.chapterVersion.findUniqueOrThrow({ where: { id: versionId } }),
      tasks: await db.generationTask.count({ where: { workId: fixture.workId } }),
    };

    const first = await fetchSummary(fixture, versionId);
    const second = await fetchSummary(fixture, versionId);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.text).toBe(first.text);

    expect(await db.auditLog.count({ where: { targetId: fixture.chapterId } })).toBe(before.audit);
    expect(await db.chapterSummary.findUniqueOrThrow({ where: { id: summaryId } })).toEqual(
      before.summary,
    );
    expect(await db.chapterVersion.findUniqueOrThrow({ where: { id: versionId } })).toEqual(
      before.version,
    );
    expect(await db.generationTask.count({ where: { workId: fixture.workId } })).toBe(before.tasks);
    // 没有因为读取而新建摘要任务
    expect(
      await db.generationTask.count({
        where: { chapterId: fixture.chapterId, taskType: 'chapter.summarize' },
      }),
    ).toBe(0);
  });

  it('历史版本的摘要可单独读取，不会被当前版本摘要替换', async () => {
    const fixture = await createFixture();
    const v1 = await seedVersion({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      versionNo: 1,
    });
    const v2 = await seedVersion({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      versionNo: 2,
    });
    await seedSummary({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: v1,
      summary: '第一版摘要：主角入门。',
    });
    await seedSummary({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: v2,
      summary: '第二版摘要：主角初次比试。',
    });

    const older = summaryOf(await fetchSummary(fixture, v1));
    const latest = summaryOf(await fetchSummary(fixture, v2));

    expect(older.sourceVersionId).toBe(v1);
    expect(older.versionNo).toBe(1);
    expect(older.summary).toBe('第一版摘要：主角入门。');
    expect(latest.sourceVersionId).toBe(v2);
    expect(latest.versionNo).toBe(2);
    expect(latest.summary).toBe('第二版摘要：主角初次比试。');
  });
});
