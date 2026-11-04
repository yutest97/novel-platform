/**
 * 人工章节版本保存 API（A1-4B-A）。
 *
 * 覆盖：
 * - 首版（baseVersionId=null）与基于最新版本追加（parent 指向基线）；
 * - 服务端 trim + 重新计算 wordCount；正文过短 / 空白 / 超长 → 400；
 * - 旧 baseVersionId → 409，且不产生新版本；
 * - 并发同 base 恰好一个成功；并发不同 base 不会跳号或覆盖；
 * - finalized 保存后回到 in_review；abandoned → 409；
 * - 跨作品 / 跨章节 404、管理员 403、缺 Origin 403；
 * - 严格白名单（source / versionNo / createdBy / 章节与作品 id / 时间戳）；
 * - 审计写入失败整体回滚；
 * - 响应与审计都不含正文。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import { countWords } from '@novel/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { POST as versionsPost } from '../app/api/works/[id]/chapters/[chapterId]/versions/route.js';

const ORIGIN = 'http://127.0.0.1:3000';
/** 正文里放一个唯一标记：用于断言响应 / 审计都不回显正文。 */
const MARKER = `机密标记-${randomUUID().slice(0, 8)}`;
const DRAFT = `${MARKER}，风从演武场尽头吹来，吹动了青石上的尘埃。${'他握紧了手中的剑。'.repeat(150)}`;
const DRAFT_2 = `${MARKER}，雨夜里，他第一次听见剑鸣。${'屋檐滴水声一下一下。'.repeat(150)}`;

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

async function createUser(role: 'author' | 'admin'): Promise<{ id: string; token: string }> {
  const user = await db.user.create({
    data: {
      email: `chapter-human-${role}-${randomUUID()}@example.test`,
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
      title: `人工版本作品-${randomUUID().slice(0, 8)}`,
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

function chapterParams(id: string, chapterId: string) {
  return { params: Promise.resolve({ id, chapterId }) };
}

interface SaveBody {
  readonly status: number;
  readonly json: {
    version?: {
      versionId: string;
      versionNo: number;
      wordCount: number;
      source: string;
      parentVersionId: string | null;
      chapterStatus: string;
    };
    error?: { code: string; message: string };
  };
  readonly text: string;
}

/** 直接调用路由处理器（与真实 HTTP 同一条代码路径）。 */
async function save(
  fixture: Fixture,
  body: Record<string, unknown>,
  options: {
    token?: string;
    origin?: string | null;
    workId?: string;
    chapterId?: string;
  } = {},
): Promise<SaveBody> {
  const workId = options.workId ?? fixture.workId;
  const chapterId = options.chapterId ?? fixture.chapterId;
  const token = options.token === undefined ? fixture.token : options.token;
  const response = await versionsPost(
    postRequest(
      `/api/works/${workId}/chapters/${chapterId}/versions`,
      body,
      options.origin === undefined ? { token } : { token, origin: options.origin },
    ),
    chapterParams(workId, chapterId),
  );
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as SaveBody['json'], text };
}

async function versionRows(chapterId: string) {
  return db.chapterVersion.findMany({
    where: { chapterId },
    orderBy: { versionNo: 'asc' },
    select: { id: true, versionNo: true, source: true, parentVersionId: true, wordCount: true },
  });
}

async function chapterStatus(chapterId: string): Promise<string> {
  const row = await db.chapter.findUniqueOrThrow({
    where: { id: chapterId },
    select: { status: true },
  });
  return row.status;
}

async function versionAuditRows(chapterId: string) {
  return db.auditLog.findMany({
    where: { action: 'chapter.version_created', targetId: chapterId },
    orderBy: { createdAt: 'asc' },
  });
}

beforeAll(() => {
  db = getPrismaClient();
});

afterEach(async () => {
  // 清理可能残留的审计拦截触发器（审计回滚用例失败时也能恢复）
  await db.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS test_block_version_audit_trigger ON audit_logs',
  );
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_block_version_audit()');
});

afterAll(async () => {
  for (const workId of works) {
    await db.$transaction(
      async (tx) => {
        // 注意：audit_logs 是 append-only（有 no_delete 触发器），这里不清理审计行。
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
  // 注意：`audit_logs` 是 append-only（UPDATE/DELETE 都被触发器拒绝），
  // 而 user 删除会触发审计行的 `ON DELETE SET NULL`（本质是 UPDATE）→ 失败。
  // 因此这里**不删测试用户**：与 workflow 包的章节测试同一策略，只清理作品侧数据。
  await db.$disconnect();
});

describe('保存人工版本：版本号与父子关系', () => {
  it('无正式版本时 baseVersionId=null → 版本 1，source=human，parent=null', async () => {
    const fixture = await createFixture();

    const saved = await save(fixture, { content: DRAFT, baseVersionId: null });
    expect(saved.status).toBe(201);
    expect(saved.json.version).toMatchObject({
      versionNo: 1,
      source: 'human',
      parentVersionId: null,
      chapterStatus: 'in_review',
    });

    const rows = await versionRows(fixture.chapterId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ versionNo: 1, source: 'human', parentVersionId: null });
    expect(await chapterStatus(fixture.chapterId)).toBe('in_review');
  });

  it('基于版本 1 保存 → 版本 2，parent 指向版本 1', async () => {
    const fixture = await createFixture();
    const first = await save(fixture, { content: DRAFT, baseVersionId: null });
    const v1 = first.json.version?.versionId ?? '';

    const second = await save(fixture, { content: DRAFT_2, baseVersionId: v1 });
    expect(second.status).toBe(201);
    expect(second.json.version).toMatchObject({
      versionNo: 2,
      parentVersionId: v1,
      chapterStatus: 'in_review',
    });

    const rows = await versionRows(fixture.chapterId);
    expect(rows.map((row) => row.versionNo)).toEqual([1, 2]);
    expect(rows[1]?.parentVersionId).toBe(v1);
    // 旧版本原样保留（append-only）
    expect(rows[0]?.id).toBe(v1);
  });

  it('服务端 trim 并重新计算 wordCount，不信任客户端', async () => {
    const fixture = await createFixture();
    const padded = `\n\n  ${DRAFT}  \n\n`;

    const saved = await save(fixture, { content: padded, baseVersionId: null });
    expect(saved.status).toBe(201);

    const stored = await db.chapterVersion.findFirstOrThrow({
      where: { chapterId: fixture.chapterId },
      select: { content: true, wordCount: true },
    });
    expect(stored.content).toBe(DRAFT.trim());
    expect(stored.wordCount).toBe(countWords(DRAFT.trim()));
    expect(saved.json.version?.wordCount).toBe(countWords(DRAFT.trim()));
  });

  it('响应不含正文（只回版本元信息）', async () => {
    const fixture = await createFixture();
    const saved = await save(fixture, { content: DRAFT, baseVersionId: null });

    expect(saved.status).toBe(201);
    expect(saved.text).not.toContain(MARKER);
    expect(Object.keys(saved.json.version ?? {}).sort()).toEqual([
      'chapterStatus',
      'parentVersionId',
      'source',
      'versionId',
      'versionNo',
      'wordCount',
    ]);
  });
});

describe('正文校验', () => {
  it('过短 / 空白 / 超长 → 400 CHAPTER_CONTENT_INVALID，且不产生版本', async () => {
    const fixture = await createFixture();

    const tooShort = await save(fixture, { content: '字'.repeat(1199), baseVersionId: null });
    expect(tooShort.status).toBe(400);
    expect(tooShort.json.error?.code).toBe('CHAPTER_CONTENT_INVALID');
    expect(tooShort.json.error?.message).toBe('章节正文不合法，请检查字数和内容');

    const blank = await save(fixture, { content: '   \n\t  ', baseVersionId: null });
    expect(blank.status).toBe(400);
    expect(blank.json.error?.code).toBe('CHAPTER_CONTENT_INVALID');

    const tooLong = await save(fixture, { content: '字'.repeat(200_001), baseVersionId: null });
    expect(tooLong.status).toBe(400);
    expect(tooLong.json.error?.code).toBe('CHAPTER_CONTENT_INVALID');

    expect(await versionRows(fixture.chapterId)).toHaveLength(0);
    expect(await chapterStatus(fixture.chapterId)).toBe('planned');
  });

  it('content 非字符串 / 缺失 → 400 VALIDATION_FAILED', async () => {
    const fixture = await createFixture();

    const missing = await save(fixture, { baseVersionId: null });
    expect(missing.status).toBe(400);
    expect(missing.json.error?.code).toBe('VALIDATION_FAILED');

    const wrongType = await save(fixture, { content: 123, baseVersionId: null });
    expect(wrongType.status).toBe(400);
    expect(wrongType.json.error?.code).toBe('VALIDATION_FAILED');
  });
});

describe('baseVersionId 并发控制', () => {
  it('旧 baseVersionId → 409 CHAPTER_VERSION_CONFLICT，不新增版本', async () => {
    const fixture = await createFixture();
    const first = await save(fixture, { content: DRAFT, baseVersionId: null });
    const v1 = first.json.version?.versionId ?? '';

    const stale = await save(fixture, { content: DRAFT_2, baseVersionId: randomUUID() });
    expect(stale.status).toBe(409);
    expect(stale.json.error?.code).toBe('CHAPTER_VERSION_CONFLICT');
    expect(await versionRows(fixture.chapterId)).toHaveLength(1);

    // 已有版本却按"无版本"提交同样冲突
    const nullBase = await save(fixture, { content: DRAFT_2, baseVersionId: null });
    expect(nullBase.status).toBe(409);
    expect(nullBase.json.error?.code).toBe('CHAPTER_VERSION_CONFLICT');

    // 用正确基线仍然可以继续追加
    const second = await save(fixture, { content: DRAFT_2, baseVersionId: v1 });
    expect(second.status).toBe(201);
    expect(await versionRows(fixture.chapterId)).toHaveLength(2);
  });

  it('两个并发请求同一 base：恰好一个成功，另一个 409，只新增一个版本', async () => {
    const fixture = await createFixture();
    const first = await save(fixture, { content: DRAFT, baseVersionId: null });
    const v1 = first.json.version?.versionId ?? '';

    const [a, b] = await Promise.all([
      save(fixture, { content: DRAFT, baseVersionId: v1 }),
      save(fixture, { content: DRAFT_2, baseVersionId: v1 }),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);
    const conflict = a.status === 409 ? a : b;
    expect(conflict.json.error?.code).toBe('CHAPTER_VERSION_CONFLICT');

    const rows = await versionRows(fixture.chapterId);
    expect(rows.map((row) => row.versionNo)).toEqual([1, 2]);
    expect(rows[1]?.parentVersionId).toBe(v1);
  });

  it('并发不同 base：只允许一个成功，版本号连续不跳号', async () => {
    const fixture = await createFixture();
    const first = await save(fixture, { content: DRAFT, baseVersionId: null });
    const v1 = first.json.version?.versionId ?? '';

    const [withBase, withNull] = await Promise.all([
      save(fixture, { content: DRAFT_2, baseVersionId: v1 }),
      save(fixture, { content: DRAFT, baseVersionId: null }),
    ]);

    const statuses = [withBase.status, withNull.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);
    expect(withBase.status).toBe(201);
    expect(withNull.status).toBe(409);
    expect(withNull.json.error?.code).toBe('CHAPTER_VERSION_CONFLICT');

    const rows = await versionRows(fixture.chapterId);
    expect(rows.map((row) => row.versionNo)).toEqual([1, 2]);
    // 没有覆盖：版本 1 的正文保持原样
    const v1Row = await db.chapterVersion.findUniqueOrThrow({ where: { id: v1 } });
    expect(v1Row.content).toBe(DRAFT.trim());
  });
});

describe('章节状态边界', () => {
  it('finalized 章节允许保存，保存后回到 in_review', async () => {
    const fixture = await createFixture();
    await db.chapter.update({ where: { id: fixture.chapterId }, data: { status: 'finalized' } });

    const saved = await save(fixture, { content: DRAFT, baseVersionId: null });
    expect(saved.status).toBe(201);
    expect(saved.json.version?.chapterStatus).toBe('in_review');
    expect(await chapterStatus(fixture.chapterId)).toBe('in_review');
  });

  it('abandoned 章节拒绝保存：409 CHAPTER_STATE_INVALID_FOR_SAVE，无新版本', async () => {
    const fixture = await createFixture();
    await db.chapter.update({ where: { id: fixture.chapterId }, data: { status: 'abandoned' } });

    const saved = await save(fixture, { content: DRAFT, baseVersionId: null });
    expect(saved.status).toBe(409);
    expect(saved.json.error?.code).toBe('CHAPTER_STATE_INVALID_FOR_SAVE');
    expect(await versionRows(fixture.chapterId)).toHaveLength(0);
    expect(await chapterStatus(fixture.chapterId)).toBe('abandoned');
  });

  it('planned / outlined / drafting 保存后都推进到 in_review', async () => {
    for (const status of ['planned', 'outlined', 'drafting']) {
      const fixture = await createFixture();
      await db.chapter.update({ where: { id: fixture.chapterId }, data: { status } });

      const saved = await save(fixture, { content: DRAFT, baseVersionId: null });
      expect(saved.status, status).toBe(201);
      expect(await chapterStatus(fixture.chapterId), status).toBe('in_review');
    }
  });
});

describe('权限与请求契约', () => {
  it('跨作品 / 跨章节 / 不存在的章节 → 404', async () => {
    const fixture = await createFixture();
    const other = await createFixture();

    const crossWork = await save(
      fixture,
      { content: DRAFT, baseVersionId: null },
      {
        chapterId: other.chapterId,
      },
    );
    expect(crossWork.status).toBe(404);

    const missing = await save(
      fixture,
      { content: DRAFT, baseVersionId: null },
      {
        chapterId: randomUUID(),
      },
    );
    expect(missing.status).toBe(404);

    // 他人作品（workId 属于别人）同样 404
    const otherWork = await save(
      fixture,
      { content: DRAFT, baseVersionId: null },
      {
        workId: other.workId,
        chapterId: other.chapterId,
      },
    );
    expect(otherWork.status).toBe(404);
  });

  it('管理员 403；缺 Origin 403；未登录 401', async () => {
    const fixture = await createFixture();
    const admin = await createUser('admin');

    const byAdmin = await save(
      fixture,
      { content: DRAFT, baseVersionId: null },
      {
        token: admin.token,
      },
    );
    expect(byAdmin.status).toBe(403);

    const noOrigin = await save(fixture, { content: DRAFT, baseVersionId: null }, { origin: null });
    expect(noOrigin.status).toBe(403);

    const anonymous = await save(fixture, { content: DRAFT, baseVersionId: null }, { token: '' });
    expect(anonymous.status).toBe(401);
  });

  it('严格白名单：source / versionNo / createdBy / 归属 / 时间戳一律 400', async () => {
    const fixture = await createFixture();

    for (const field of [
      'source',
      'versionNo',
      'createdBy',
      'chapterId',
      'workId',
      'createdAt',
      'parentVersionId',
    ]) {
      const rejected = await save(fixture, {
        content: DRAFT,
        baseVersionId: null,
        [field]: 'x',
      });
      expect(rejected.status, field).toBe(400);
      expect(rejected.json.error?.code, field).toBe('VALIDATION_FAILED');
    }

    expect(await versionRows(fixture.chapterId)).toHaveLength(0);
  });

  it('baseVersionId 必须显式提交；非 UUID → 400', async () => {
    const fixture = await createFixture();

    const missing = await save(fixture, { content: DRAFT });
    expect(missing.status).toBe(400);
    expect(missing.json.error?.code).toBe('VALIDATION_FAILED');

    const notUuid = await save(fixture, { content: DRAFT, baseVersionId: 'not-a-uuid' });
    expect(notUuid.status).toBe(400);
    expect(notUuid.json.error?.code).toBe('VALIDATION_FAILED');
  });
});

describe('审计与事务', () => {
  it('审计只记 ids / 版本号 / 来源 / 字数 / 父版本，不含正文', async () => {
    const fixture = await createFixture();
    const first = await save(fixture, { content: DRAFT, baseVersionId: null });
    const v1 = first.json.version?.versionId ?? '';
    await save(fixture, { content: DRAFT_2, baseVersionId: v1 });

    const audits = await versionAuditRows(fixture.chapterId);
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      const detail = audit.detail as Record<string, unknown>;
      expect(Object.keys(detail).sort()).toEqual([
        'chapterId',
        'parentVersionId',
        'source',
        'versionId',
        'versionNo',
        'wordCount',
        'workId',
      ]);
      expect(detail['source']).toBe('human');
      expect(JSON.stringify(detail)).not.toContain(MARKER);
    }
    expect(audits[1]?.detail).toMatchObject({ parentVersionId: v1, versionNo: 2 });
  });

  it('审计写入失败 → 版本与章节状态整体回滚', async () => {
    const fixture = await createFixture();

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_block_version_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'chapter.version_created' THEN
          RAISE EXCEPTION 'test: blocked version audit';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER test_block_version_audit_trigger
        BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION test_block_version_audit()
    `);

    try {
      const failed = await save(fixture, { content: DRAFT, baseVersionId: null });
      expect(failed.status).toBe(500);
    } finally {
      await db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_block_version_audit_trigger ON audit_logs',
      );
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_block_version_audit()');
    }

    expect(await versionRows(fixture.chapterId)).toHaveLength(0);
    expect(await chapterStatus(fixture.chapterId)).toBe('planned');
    expect(await versionAuditRows(fixture.chapterId)).toHaveLength(0);

    // 去掉触发器后可以正常保存（证明失败只是审计导致的整体回滚）
    const ok = await save(fixture, { content: DRAFT, baseVersionId: null });
    expect(ok.status).toBe(201);
    expect(await versionRows(fixture.chapterId)).toHaveLength(1);
  });
});
