/**
 * 章节正式版本 diff 服务与只读 API（A1-4B-C-A）。
 *
 * 覆盖：
 * - 两个版本之间的行级 diff（新增 / 删除 / 替换 / 上下文）；
 * - 相同版本 → 全 equal；方向反转 → added / removed 互换；
 * - 跨作品 / 跨章节 / 随机版本 id 统一 404（不泄露存在性）；
 * - 未登录 401、管理员 403、他人作品 404；
 * - query 白名单：缺参 / 重复 / 未知参数 / 非法 UUID → 400；
 * - 响应不含完整正文、作者 id 或内部字段；
 * - 结果确定；后加新版本不影响已选两个版本的 diff。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import { countWords, diffChapterVersions } from '@novel/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as diffGet } from '../app/api/works/[id]/chapters/[chapterId]/versions/diff/route.js';

const ORIGIN = 'http://127.0.0.1:3000';

let db: PrismaClient;

interface Fixture {
  readonly authorId: string;
  readonly token: string;
  readonly workId: string;
  readonly chapterId: string;
  readonly chapter2Id: string;
  /** 第 1 章的版本 1 / 版本 2。 */
  readonly version1Id: string;
  readonly version2Id: string;
}

const users: string[] = [];
const works: string[] = [];

/** 60 行正文（每行 ~27 字，总长度满足数据库 1200 字符下限）。 */
function baseLines(count = 60): string[] {
  return Array.from(
    { length: count },
    (_, index) => `第 ${String(index + 1)} 行：风从演武场尽头吹来，吹动了青石上的尘埃。`,
  );
}

const LINES_V1 = baseLines();
const LINES_V2 = (() => {
  const copy = [...LINES_V1];
  // 替换第 10 行
  copy[9] = '第 10 行：雨落在青瓦上，他数着更声。';
  // 删除第 20 行
  copy.splice(19, 1);
  // 在第 30 行后插入一行
  copy.splice(30, 0, '新增：他把剑收回鞘中，转身走进雨里。');
  return copy;
})();

const CONTENT_V1 = LINES_V1.join('\n');
const CONTENT_V2 = LINES_V2.join('\n');

async function createUser(role: 'author' | 'admin'): Promise<{ id: string; token: string }> {
  const user = await db.user.create({
    data: {
      email: `chapter-diff-${role}-${randomUUID()}@example.test`,
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

async function seedVersion(
  input: {
    readonly workId: string;
    readonly chapterId: string;
    readonly authorId: string;
    readonly versionNo: number;
  },
  content: string,
): Promise<string> {
  const version = await db.chapterVersion.create({
    data: {
      workId: input.workId,
      chapterId: input.chapterId,
      versionNo: input.versionNo,
      content,
      wordCount: countWords(content),
      source: 'human',
      createdBy: input.authorId,
    },
    select: { id: true },
  });
  return version.id;
}

async function createFixture(): Promise<Fixture> {
  const author = await createUser('author');
  const work = await db.work.create({
    data: {
      authorId: author.id,
      title: `diff 作品-${randomUUID().slice(0, 8)}`,
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

  const version1Id = await seedVersion(
    { workId: work.id, chapterId: chapter.id, authorId: author.id, versionNo: 1 },
    CONTENT_V1,
  );
  const version2Id = await seedVersion(
    { workId: work.id, chapterId: chapter.id, authorId: author.id, versionNo: 2 },
    CONTENT_V2,
  );

  return {
    authorId: author.id,
    token: author.token,
    workId: work.id,
    chapterId: chapter.id,
    chapter2Id: chapter2.id,
    version1Id,
    version2Id,
  };
}

function request(
  fixture: { readonly workId: string; readonly chapterId: string },
  query: string,
  options: { token?: string; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
  }
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) {
    headers['origin'] = origin;
  }
  return new Request(
    `http://127.0.0.1:3000/api/works/${fixture.workId}/chapters/${fixture.chapterId}/versions/diff${query}`,
    { method: 'GET', headers },
  );
}

function params(fixture: { readonly workId: string; readonly chapterId: string }) {
  return { params: Promise.resolve({ id: fixture.workId, chapterId: fixture.chapterId }) };
}

function query(from: string, to: string): string {
  return `?fromVersionId=${encodeURIComponent(from)}&toVersionId=${encodeURIComponent(to)}`;
}

interface DiffBody {
  readonly diff: {
    readonly fromVersion: Record<string, unknown>;
    readonly toVersion: Record<string, unknown>;
    readonly lines: {
      kind: string;
      oldLineNo: number | null;
      newLineNo: number | null;
      text: string;
    }[];
    readonly stats: { added: number; removed: number; unchanged: number };
  };
}

beforeAll(() => {
  db = getPrismaClient();
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

describe('GET /chapters/:chapterId/versions/diff', () => {
  it('返回版本元信息与行级 diff，统计正确，不含完整正文', async () => {
    const fixture = await createFixture();
    const response = await diffGet(
      request(fixture, query(fixture.version1Id, fixture.version2Id), { token: fixture.token }),
      params(fixture),
    );
    expect(response.status).toBe(200);

    const text = await response.text();
    // 不返回两份完整正文：没有任何 content 字段
    expect(text.includes('"content"')).toBe(false);

    const body = JSON.parse(text) as DiffBody;
    expect(Object.keys(body.diff).sort()).toEqual(['fromVersion', 'lines', 'stats', 'toVersion']);
    expect(Object.keys(body.diff.fromVersion).sort()).toEqual([
      'id',
      'source',
      'versionNo',
      'wordCount',
    ]);
    expect(body.diff.fromVersion).toMatchObject({ id: fixture.version1Id, versionNo: 1 });
    expect(body.diff.toVersion).toMatchObject({ id: fixture.version2Id, versionNo: 2 });
    expect(body.diff.stats).toEqual({ added: 2, removed: 2, unchanged: 58 });

    const removed = body.diff.lines.filter((line) => line.kind === 'removed');
    const added = body.diff.lines.filter((line) => line.kind === 'added');
    // 第 10 行被替换 → 旧行的第 10 行在 removed；第 20 行被删除 → 也在 removed
    expect(removed.map((line) => line.text)).toContain(LINES_V1[9]);
    expect(removed.map((line) => line.text)).toContain(LINES_V1[19]);
    expect(added.map((line) => line.text)).toContain(LINES_V2[9]);
    expect(added.map((line) => line.text)).toContain('新增：他把剑收回鞘中，转身走进雨里。');

    // 行号：equal 两侧都有（删除后两侧会出现偏移），added 只有新行号，removed 只有旧行号
    for (const line of body.diff.lines) {
      if (line.kind === 'equal') {
        expect(line.oldLineNo).not.toBeNull();
        expect(line.newLineNo).not.toBeNull();
      } else if (line.kind === 'added') {
        expect(line.oldLineNo).toBeNull();
      } else {
        expect(line.newLineNo).toBeNull();
      }
    }
  });

  it('同一个版本对比自己：全 equal，不是错误', async () => {
    const fixture = await createFixture();
    const response = await diffGet(
      request(fixture, query(fixture.version1Id, fixture.version1Id), { token: fixture.token }),
      params(fixture),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DiffBody;
    expect(body.diff.stats).toEqual({ added: 0, removed: 0, unchanged: LINES_V1.length });
    expect(body.diff.lines.every((line) => line.kind === 'equal')).toBe(true);
    expect(body.diff.fromVersion['id']).toBe(body.diff.toVersion['id']);
  });

  it('交换方向后 added / removed 互换', async () => {
    const fixture = await createFixture();
    const forward = (await (
      await diffGet(
        request(fixture, query(fixture.version1Id, fixture.version2Id), { token: fixture.token }),
        params(fixture),
      )
    ).json()) as DiffBody;
    const backward = (await (
      await diffGet(
        request(fixture, query(fixture.version2Id, fixture.version1Id), { token: fixture.token }),
        params(fixture),
      )
    ).json()) as DiffBody;

    expect(forward.diff.stats).toEqual(backward.diff.stats);
    expect(forward.diff.lines.filter((line) => line.kind === 'added').map((l) => l.text)).toEqual(
      backward.diff.lines.filter((line) => line.kind === 'removed').map((l) => l.text),
    );
  });

  it('中文、emoji 与 CRLF 混用也能正确比较', async () => {
    const fixture = await createFixture();
    // 保留足够的行数以满足数据库 1200 字符下限；前 3 行用来验证 emoji 与换行归一化
    const tail = LINES_V1.slice(3);
    const left = ['第一行：他握紧了剑🙂', '第二行：雨落在青瓦上', '第三行：更声渐远', ...tail].join(
      '\r\n',
    );
    const right = [
      '第一行：他握紧了剑🙂',
      '第二行：雨落在青瓦上',
      '第三行：更声渐远，灯也灭了',
      ...tail,
    ].join('\n');
    const versionA = await seedVersion(
      {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        authorId: fixture.authorId,
        versionNo: 3,
      },
      left,
    );
    const versionB = await seedVersion(
      {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        authorId: fixture.authorId,
        versionNo: 4,
      },
      right,
    );

    const body = (await (
      await diffGet(
        request(fixture, query(versionA, versionB), { token: fixture.token }),
        params(fixture),
      )
    ).json()) as DiffBody;
    // 只有第 3 行不同，其余（含填充行）全部 equal
    expect(body.diff.stats).toEqual({ added: 1, removed: 1, unchanged: LINES_V1.length - 1 });
    expect(body.diff.lines[0]).toMatchObject({
      kind: 'equal',
      text: '第一行：他握紧了剑🙂',
    });
  });

  it('结果确定：同一请求重复执行完全一致', async () => {
    const fixture = await createFixture();
    const call = async (): Promise<string> =>
      (
        await diffGet(
          request(fixture, query(fixture.version1Id, fixture.version2Id), {
            token: fixture.token,
          }),
          params(fixture),
        )
      ).text();
    expect(await call()).toBe(await call());
  });

  it('后加新版本不影响已选两个版本的 diff', async () => {
    const fixture = await createFixture();
    const first = await (
      await diffGet(
        request(fixture, query(fixture.version1Id, fixture.version2Id), { token: fixture.token }),
        params(fixture),
      )
    ).text();

    await seedVersion(
      {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        authorId: fixture.authorId,
        versionNo: 3,
      },
      `${CONTENT_V2}\n后来又写了一行。`,
    );

    const second = await (
      await diffGet(
        request(fixture, query(fixture.version1Id, fixture.version2Id), { token: fixture.token }),
        params(fixture),
      )
    ).text();
    expect(second).toBe(first);
  });
});

describe('版本归属与权限', () => {
  it('跨章节的版本 → 404', async () => {
    const fixture = await createFixture();
    const otherChapterVersion = await seedVersion(
      {
        workId: fixture.workId,
        chapterId: fixture.chapter2Id,
        authorId: fixture.authorId,
        versionNo: 1,
      },
      CONTENT_V1,
    );
    const response = await diffGet(
      request(fixture, query(fixture.version1Id, otherChapterVersion), { token: fixture.token }),
      params(fixture),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('跨作品的版本 → 404', async () => {
    const fixture = await createFixture();
    const otherAuthor = await createUser('author');
    const otherWork = await db.work.create({
      data: {
        authorId: otherAuthor.id,
        title: `另一个作品-${randomUUID().slice(0, 8)}`,
        genreRulePackage: 'xuanhuan',
      },
    });
    works.push(otherWork.id);
    const otherChapter = await db.chapter.create({
      data: { workId: otherWork.id, chapterNo: 1, title: '第一章' },
      select: { id: true },
    });
    const foreignVersion = await seedVersion(
      {
        workId: otherWork.id,
        chapterId: otherChapter.id,
        authorId: otherAuthor.id,
        versionNo: 1,
      },
      CONTENT_V2,
    );

    const response = await diffGet(
      request(fixture, query(fixture.version1Id, foreignVersion), { token: fixture.token }),
      params(fixture),
    );
    expect(response.status).toBe(404);
  });

  it('随机版本 id → 404', async () => {
    const fixture = await createFixture();
    const response = await diffGet(
      request(fixture, query(fixture.version1Id, randomUUID()), { token: fixture.token }),
      params(fixture),
    );
    expect(response.status).toBe(404);
  });

  it('未登录 401、管理员 403、他人作品 404', async () => {
    const fixture = await createFixture();

    const anonymous = await diffGet(
      request(fixture, query(fixture.version1Id, fixture.version2Id), { origin: null }),
      params(fixture),
    );
    expect(anonymous.status).toBe(401);

    const admin = await createUser('admin');
    const byAdmin = await diffGet(
      request(fixture, query(fixture.version1Id, fixture.version2Id), { token: admin.token }),
      params(fixture),
    );
    expect(byAdmin.status).toBe(403);

    const stranger = await createUser('author');
    const byStranger = await diffGet(
      request(fixture, query(fixture.version1Id, fixture.version2Id), { token: stranger.token }),
      params(fixture),
    );
    expect(byStranger.status).toBe(404);
  });
});

describe('query 校验', () => {
  it('缺参数 / 重复参数 / 空值 / 未知参数 / 非法 UUID → 400', async () => {
    const fixture = await createFixture();
    const cases = [
      '',
      `?fromVersionId=${fixture.version1Id}`,
      `?toVersionId=${fixture.version2Id}`,
      `?fromVersionId=${fixture.version1Id}&fromVersionId=${fixture.version2Id}&toVersionId=${fixture.version2Id}`,
      `?fromVersionId=&toVersionId=${fixture.version2Id}`,
      `${query(fixture.version1Id, fixture.version2Id)}&unknown=1`,
      '?fromVersionId=not-a-uuid&toVersionId=also-not-a-uuid',
    ];

    for (const search of cases) {
      const response = await diffGet(
        request(fixture, search, { token: fixture.token }),
        params(fixture),
      );
      expect(response.status, `query=${search}`).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('错误响应不包含正文片段', async () => {
    const fixture = await createFixture();
    const response = await diffGet(
      request(fixture, query(fixture.version1Id, randomUUID()), { token: fixture.token }),
      params(fixture),
    );
    const text = await response.text();
    expect(text).not.toContain('风从演武场');
    expect(text).not.toContain('青石');
  });
});

describe('服务层直接调用', () => {
  it('跨章节返回 404（不经过 HTTP）', async () => {
    const fixture = await createFixture();
    const otherChapterVersion = await seedVersion(
      {
        workId: fixture.workId,
        chapterId: fixture.chapter2Id,
        authorId: fixture.authorId,
        versionNo: 1,
      },
      CONTENT_V1,
    );
    await expect(
      diffChapterVersions({
        db,
        authorId: fixture.authorId,
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        fromVersionId: fixture.version1Id,
        toVersionId: otherChapterVersion,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('服务层不写审计、不改版本行', async () => {
    const fixture = await createFixture();
    const before = await db.chapterVersion.findMany({
      where: { chapterId: fixture.chapterId },
      orderBy: { versionNo: 'asc' },
      select: { id: true, content: true, wordCount: true },
    });
    const auditBefore = await db.auditLog.count({
      where: { targetId: fixture.chapterId },
    });

    await diffChapterVersions({
      db,
      authorId: fixture.authorId,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      fromVersionId: fixture.version1Id,
      toVersionId: fixture.version2Id,
    });

    const after = await db.chapterVersion.findMany({
      where: { chapterId: fixture.chapterId },
      orderBy: { versionNo: 'asc' },
      select: { id: true, content: true, wordCount: true },
    });
    expect(after).toEqual(before);
    expect(await db.auditLog.count({ where: { targetId: fixture.chapterId } })).toBe(auditBefore);
  });
});
