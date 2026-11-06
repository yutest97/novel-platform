/**
 * 连续性事实 API（A2-B）。
 *
 * 覆盖：
 * - POST 提取：首次 201、同版本幂等 200、Provider / 模型输出稳定错误码；
 * - POST 前置：未定稿、旧版本、进行中、attempt 被接管；
 * - POST 校验：未知字段 / null / 非法 UUID / 缺 Origin / 401 / 403 / 404；
 * - GET 列表：六类过滤、未知 factType、重复 query、排序、total、truncated、空列表；
 * - GET 候选详情 / run：跨章节、跨作品、随机 id → 404；
 * - 脱敏：响应不含正文、prompt、attemptToken；
 * - GET 只读：不写审计、不改 run / candidate。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import type { ModelProvider } from '@novel/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { GET as factDetailGet } from '../app/api/works/[id]/chapters/[chapterId]/facts/[candidateId]/route.js';
import { POST as extractPost } from '../app/api/works/[id]/chapters/[chapterId]/facts/extract/route.js';
import { GET as factsGet } from '../app/api/works/[id]/chapters/[chapterId]/facts/route.js';
import { GET as runGet } from '../app/api/works/[id]/chapters/[chapterId]/fact-runs/[runId]/route.js';
import { setChapterFactProvider } from '../src/fact-provider.js';

const ORIGIN = 'http://127.0.0.1:3000';
const MARKER = `连续性机密-${randomUUID().slice(0, 8)}`;

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
  /** 同一作者的另一个作品（测跨作品）。 */
  readonly otherWorkId: string;
  /** 另一个作品的章节（测跨章节）。 */
  readonly otherChapterId: string;
  /** 他人作品。 */
  readonly strangerWorkId: string;
  readonly characterId: string;
  readonly itemId: string;
}

const works: string[] = [];

async function createUser(role: 'author' | 'admin'): Promise<{ id: string; token: string }> {
  const user = await db.user.create({
    data: {
      email: `chapter-facts-${role}-${randomUUID()}@example.test`,
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
  const workId = await createWork(author.id, '事实作品');
  const otherWorkId = await createWork(author.id, '事实作品-另一部');
  const strangerWorkId = await createWork(stranger.id, '他人事实作品');

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
  await db.chapter.create({ data: { workId: strangerWorkId, chapterNo: 1, title: '他人第一章' } });

  const character = await db.entity.create({
    data: { workId, entityType: 'character', name: '李青', orderIndex: 1 },
    select: { id: true },
  });
  const item = await db.entity.create({
    data: { workId, entityType: 'item', name: '玄铁剑', orderIndex: 1 },
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
    characterId: character.id,
    itemId: item.id,
  };
}

/** 插入一个正式版本；`finalize=true` 时把章节置为定稿。 */
async function seedVersion(
  fixture: Fixture,
  versionNo: number,
  options: { readonly finalize?: boolean; readonly content?: string } = {},
): Promise<{ versionId: string; versionNo: number }> {
  const content = options.content ?? `${CONTENT}-v${versionNo}`;
  const version = await db.chapterVersion.create({
    data: {
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      versionNo,
      content,
      wordCount: content.length,
      source: 'human',
      createdBy: fixture.authorId,
    },
    select: { id: true },
  });
  if (options.finalize === true) {
    await db.chapter.update({ where: { id: fixture.chapterId }, data: { status: 'finalized' } });
  }
  return { versionId: version.id, versionNo };
}

function sampleFacts(fixture: Fixture): unknown[] {
  return [
    {
      factType: 'character_state',
      subjectId: fixture.characterId,
      summary: '主角受了内伤',
      reason: '正文写到他咳血',
    },
    {
      factType: 'plot_thread',
      threadStatus: 'new',
      summary: '灵泉异动的线索出现',
      reason: '泉底出现裂纹',
    },
    {
      factType: 'item_change',
      subjectId: fixture.itemId,
      summary: '玄铁剑出现裂痕',
      reason: '正文写到剑身崩裂',
    },
  ];
}

interface StubProvider extends ModelProvider {
  /** 调用次数（用于验证幂等命中不再调用模型）。 */
  calls: number;
  /** 下一次 `generateJson` 的行为。 */
  mode: 'ok' | 'throw' | 'invalid' | 'takeover';
  /** takeover 模式使用：模拟接管发生在哪个作品上。 */
  takeoverWorkId?: string;
}

function stubProvider(facts: unknown[]): StubProvider {
  const provider: StubProvider = {
    name: 'stub',
    defaultModel: 'stub-model',
    calls: 0,
    mode: 'ok',
    async generateJson() {
      provider.calls += 1;
      if (provider.mode === 'throw') {
        throw new Error('stub provider failure');
      }
      if (provider.mode === 'takeover') {
        // 模拟另一路请求在本 attempt 的模型调用期间接管同一 run
        await db.$executeRawUnsafe(
          `UPDATE "chapter_fact_runs"
             SET "status" = 'failed', "error_code" = 'CONTINUITY_EXTRACTION_FAILED',
                 "finished_at" = clock_timestamp()
           WHERE "work_id" = $1::uuid AND "status" = 'running'`,
          provider.takeoverWorkId ?? '',
        );
        await db.$executeRawUnsafe(
          `UPDATE "chapter_fact_runs"
             SET "status" = 'running', "error_code" = NULL, "finished_at" = NULL,
                 "started_at" = clock_timestamp(), "attempt_token" = gen_random_uuid()
           WHERE "work_id" = $1::uuid AND "status" = 'failed'`,
          provider.takeoverWorkId ?? '',
        );
      }
      return {
        json: provider.mode === 'invalid' ? { nope: true } : { facts },
        provider: 'stub',
        model: 'stub-model',
        usage: { promptTokens: 1, completionTokens: 1 },
        latencyMs: 1,
      };
    },
    async generateText() {
      throw new Error('未使用');
    },
  };
  return provider;
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

function getRequest(
  path: string,
  options: { token?: string; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
  }
  const origin = options.origin === undefined ? null : options.origin;
  if (origin !== null) {
    headers['origin'] = origin;
  }
  return new Request(`http://127.0.0.1:3000${path}`, { method: 'GET', headers });
}

interface HttpResult {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly text: string;
}

async function read(response: Response): Promise<HttpResult> {
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as Record<string, unknown>, text };
}

async function extract(
  fixture: Fixture,
  body: Record<string, unknown>,
  options: { token?: string; origin?: string | null; workId?: string; chapterId?: string } = {},
): Promise<HttpResult> {
  const workId = options.workId ?? fixture.workId;
  const chapterId = options.chapterId ?? fixture.chapterId;
  const token = options.token === undefined ? fixture.token : options.token;
  return read(
    await extractPost(
      postRequest(
        `/api/works/${workId}/chapters/${chapterId}/facts/extract`,
        body,
        options.origin === undefined ? { token } : { token, origin: options.origin },
      ),
      { params: Promise.resolve({ id: workId, chapterId }) },
    ),
  );
}

async function listFacts(
  fixture: Fixture,
  query = '',
  options: { token?: string; workId?: string; chapterId?: string } = {},
): Promise<HttpResult> {
  const workId = options.workId ?? fixture.workId;
  const chapterId = options.chapterId ?? fixture.chapterId;
  const token = options.token === undefined ? fixture.token : options.token;
  return read(
    await factsGet(
      getRequest(`/api/works/${workId}/chapters/${chapterId}/facts${query}`, { token }),
      { params: Promise.resolve({ id: workId, chapterId }) },
    ),
  );
}

async function factDetail(
  fixture: Fixture,
  candidateId: string,
  options: { token?: string; workId?: string; chapterId?: string } = {},
): Promise<HttpResult> {
  const workId = options.workId ?? fixture.workId;
  const chapterId = options.chapterId ?? fixture.chapterId;
  const token = options.token === undefined ? fixture.token : options.token;
  return read(
    await factDetailGet(
      getRequest(`/api/works/${workId}/chapters/${chapterId}/facts/${candidateId}`, { token }),
      { params: Promise.resolve({ id: workId, chapterId, candidateId }) },
    ),
  );
}

async function factRun(
  fixture: Fixture,
  runId: string,
  options: { token?: string; workId?: string; chapterId?: string } = {},
): Promise<HttpResult> {
  const workId = options.workId ?? fixture.workId;
  const chapterId = options.chapterId ?? fixture.chapterId;
  const token = options.token === undefined ? fixture.token : options.token;
  return read(
    await runGet(
      getRequest(`/api/works/${workId}/chapters/${chapterId}/fact-runs/${runId}`, { token }),
      { params: Promise.resolve({ id: workId, chapterId, runId }) },
    ),
  );
}

beforeAll(() => {
  db = getPrismaClient();
});

afterEach(() => {
  setChapterFactProvider(null);
});

afterAll(async () => {
  for (const workId of works) {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_fact_decisions" DISABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_fact_candidates" DISABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_fact_runs" DISABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_versions" DISABLE TRIGGER USER');
        await tx.chapterFactDecision.deleteMany({ where: { workId } });
        await tx.chapterFactCandidate.deleteMany({ where: { workId } });
        await tx.chapterFactRun.deleteMany({ where: { workId } });
        await tx.chapterVersion.deleteMany({ where: { workId } });
        await tx.entityAttribute.deleteMany({ where: { entity: { workId } } });
        await tx.entity.deleteMany({ where: { workId } });
        await tx.chapter.deleteMany({ where: { workId } });
        await tx.work.deleteMany({ where: { id: workId } });
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_versions" ENABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_fact_runs" ENABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_fact_candidates" ENABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_fact_decisions" ENABLE TRIGGER USER');
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
  }
});

describe('POST 提取', () => {
  it('首次提取 201；同版本重试 200 且 created=false（不重复调用模型）', async () => {
    const fixture = await createFixture();
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    const provider = stubProvider(sampleFacts(fixture));
    setChapterFactProvider(provider);

    const first = await extract(fixture, { sourceVersionId: versionId });
    expect(first.status).toBe(201);
    const extraction = first.json['extraction'] as Record<string, unknown>;
    expect(extraction).toMatchObject({
      created: true,
      sourceVersionId: versionId,
      sourceVersionNo: 1,
      agentName: 'continuity.extractor',
      agentVersion: '1.0.0',
      provider: 'stub',
      model: 'stub-model',
      factCount: 3,
    });
    expect(extraction['factTypeCounts']).toEqual({
      character_state: 1,
      plot_thread: 1,
      item_change: 1,
    });
    expect(provider.calls).toBe(1);

    const second = await extract(fixture, { sourceVersionId: versionId });
    expect(second.status).toBe(200);
    const repeated = second.json['extraction'] as Record<string, unknown>;
    expect(repeated).toMatchObject({ created: false, runId: extraction['runId'] });
    expect(provider.calls).toBe(1);
  });

  it('Provider 失败 → 502 CONTINUITY_EXTRACTION_FAILED；模型输出不合法 → 422', async () => {
    const fixture = await createFixture();
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    const provider = stubProvider([]);
    setChapterFactProvider(provider);

    provider.mode = 'throw';
    const failed = await extract(fixture, { sourceVersionId: versionId });
    expect(failed.status).toBe(502);
    expect((failed.json['error'] as { code: string }).code).toBe('CONTINUITY_EXTRACTION_FAILED');

    provider.mode = 'invalid';
    const invalid = await extract(fixture, { sourceVersionId: versionId });
    expect(invalid.status).toBe(422);
    expect((invalid.json['error'] as { code: string }).code).toBe('CONTINUITY_FACTS_INVALID');
  });

  it('未定稿 → 409；旧版本 → 409；进行中 → 409；被接管 → 409 LEASE_LOST', async () => {
    const fixture = await createFixture();
    const first = await seedVersion(fixture, 1, { finalize: true });
    setChapterFactProvider(stubProvider(sampleFacts(fixture)));

    // 旧版本：存在更新的版本 2，但请求版本 1
    const second = await seedVersion(fixture, 2);
    const stale = await extract(fixture, { sourceVersionId: first.versionId });
    expect(stale.status).toBe(409);
    expect((stale.json['error'] as { code: string }).code).toBe('CONTINUITY_SOURCE_VERSION_STALE');

    // 进行中：手工留下一份未过期的 running
    await db.chapterFactRun.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        sourceVersionId: second.versionId,
        agentName: 'continuity.extractor',
        agentVersion: '1.0.0',
        provider: 'p',
        model: 'm',
        status: 'running',
      },
    });
    const running = await extract(fixture, { sourceVersionId: second.versionId });
    expect(running.status).toBe(409);
    expect((running.json['error'] as { code: string }).code).toBe(
      'CONTINUITY_EXTRACTION_IN_PROGRESS',
    );

    // 未定稿（先清掉进行中的 run，否则会被 IN_PROGRESS 抢先）
    await db.chapter.update({ where: { id: fixture.chapterId }, data: { status: 'in_review' } });
    await db.$executeRawUnsafe('ALTER TABLE chapter_fact_runs DISABLE TRIGGER USER');
    await db.chapterFactRun.deleteMany({ where: { workId: fixture.workId } });
    await db.$executeRawUnsafe('ALTER TABLE chapter_fact_runs ENABLE TRIGGER USER');
    const notFinalized = await extract(fixture, { sourceVersionId: second.versionId });
    expect(notFinalized.status).toBe(409);
    expect((notFinalized.json['error'] as { code: string }).code).toBe(
      'CONTINUITY_CHAPTER_NOT_FINALIZED',
    );

    // 被接管：模型调用期间另一路请求接管同一 run
    await db.chapter.update({ where: { id: fixture.chapterId }, data: { status: 'finalized' } });
    const takeover = stubProvider(sampleFacts(fixture));
    takeover.mode = 'takeover';
    takeover.takeoverWorkId = fixture.workId;
    setChapterFactProvider(takeover);
    const leased = await extract(fixture, { sourceVersionId: second.versionId });
    expect(leased.status).toBe(409);
    expect((leased.json['error'] as { code: string }).code).toBe(
      'CONTINUITY_EXTRACTION_LEASE_LOST',
    );
  });

  it('校验：未知字段 / null / 非法 UUID / 缺 Origin / 401 / 403 / 404', async () => {
    const fixture = await createFixture();
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    setChapterFactProvider(stubProvider(sampleFacts(fixture)));

    const unknown = await extract(fixture, { sourceVersionId: versionId, foo: 1 });
    expect(unknown.status).toBe(400);
    expect((unknown.json['error'] as { code: string }).code).toBe('VALIDATION_FAILED');

    const nullValue = await extract(fixture, { sourceVersionId: null });
    expect(nullValue.status).toBe(400);

    const missing = await extract(fixture, {});
    expect(missing.status).toBe(400);

    const badUuid = await extract(fixture, { sourceVersionId: 'not-a-uuid' });
    expect(badUuid.status).toBe(400);

    const noOrigin = await extract(fixture, { sourceVersionId: versionId }, { origin: null });
    expect(noOrigin.status).toBe(403);

    const anonymous = await extract(fixture, { sourceVersionId: versionId }, { token: '' });
    expect(anonymous.status).toBe(401);

    const admin = await extract(
      fixture,
      { sourceVersionId: versionId },
      { token: fixture.adminToken },
    );
    expect(admin.status).toBe(403);

    const stranger = await extract(
      fixture,
      { sourceVersionId: versionId },
      { token: fixture.token, workId: fixture.strangerWorkId, chapterId: fixture.chapterId },
    );
    expect(stranger.status).toBe(404);

    // 跨章节：章节不属于该作品 → 404（同作品的另一章节则是"未定稿" 409）
    const crossChapter = await extract(
      fixture,
      { sourceVersionId: versionId },
      { chapterId: fixture.otherChapterId },
    );
    expect(crossChapter.status).toBe(404);
    const randomChapter = await extract(
      fixture,
      { sourceVersionId: versionId },
      { chapterId: randomUUID() },
    );
    expect(randomChapter.status).toBe(404);
    // 同作品的另一章节：存在但未定稿 → 409
    const siblingChapter = await extract(
      fixture,
      { sourceVersionId: versionId },
      { chapterId: fixture.chapter2Id },
    );
    expect(siblingChapter.status).toBe(409);
  });

  it('响应不含正文 / prompt / attemptToken', async () => {
    const fixture = await createFixture();
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    setChapterFactProvider(stubProvider(sampleFacts(fixture)));

    const response = await extract(fixture, { sourceVersionId: versionId });
    expect(response.status).toBe(201);
    expect(response.text).not.toContain(MARKER);
    expect(response.text).not.toContain('attemptToken');
    expect(response.text).not.toContain('attempt_token');
    expect(response.text).not.toContain('prompt');
    // 响应里没有任何 key 是 attemptToken（大小写之外的变体）
    expect(Object.keys(response.json['extraction'] as object)).not.toContain('attemptToken');
  });
});

describe('GET 候选列表', () => {
  it('返回全部候选，按 createdAt desc → id desc；支持六类过滤', async () => {
    const fixture = await createFixture();
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    setChapterFactProvider(stubProvider(sampleFacts(fixture)));
    const created = await extract(fixture, { sourceVersionId: versionId });
    expect(created.status).toBe(201);
    const runId = (created.json['extraction'] as { runId: string }).runId;

    const all = await listFacts(fixture);
    expect(all.status).toBe(200);
    const facts = all.json['facts'] as { id: string; factType: string; runId: string }[];
    expect(facts).toHaveLength(3);
    expect(all.json['total']).toBe(3);
    expect(all.json['truncated']).toBe(false);
    expect(facts.every((fact) => fact.runId === runId)).toBe(true);

    // 排序：createdAt desc，同毫秒时 id desc
    const rows = await db.chapterFactCandidate.findMany({
      where: { workId: fixture.workId },
      select: { id: true, createdAt: true },
    });
    const expected = [...rows]
      .sort((left, right) => {
        const delta = right.createdAt.getTime() - left.createdAt.getTime();
        return delta !== 0 ? delta : right.id.localeCompare(left.id);
      })
      .map((row) => row.id);
    expect(facts.map((fact) => fact.id)).toEqual(expected);

    for (const factType of [
      'character_state',
      'relationship_change',
      'item_change',
      'realm_progress',
      'plot_thread',
      'location_change',
    ]) {
      const filtered = await listFacts(fixture, `?factType=${factType}`);
      expect(filtered.status).toBe(200);
      const list = filtered.json['facts'] as { factType: string }[];
      expect(list.every((fact) => fact.factType === factType)).toBe(true);
      expect(filtered.json['total']).toBe(list.length);
    }
  });

  it('未知 factType / 重复 query / 其它 query → 400', async () => {
    const fixture = await createFixture();
    await seedVersion(fixture, 1, { finalize: true });

    const unknownType = await listFacts(fixture, '?factType=unknown_kind');
    expect(unknownType.status).toBe(400);
    expect((unknownType.json['error'] as { code: string }).code).toBe('VALIDATION_FAILED');

    const duplicated = await listFacts(fixture, '?factType=plot_thread&factType=item_change');
    expect(duplicated.status).toBe(400);

    const otherQuery = await listFacts(fixture, '?limit=10');
    expect(otherQuery.status).toBe(400);

    const emptyValue = await listFacts(fixture, '?factType=');
    expect(emptyValue.status).toBe(400);
  });

  it('超过 200 条时返回 truncated=true 与完整 total（不静默截断）', async () => {
    const fixture = await createFixture();
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    setChapterFactProvider(stubProvider([]));
    const created = await extract(fixture, { sourceVersionId: versionId });
    expect(created.status).toBe(201);
    const runId = (created.json['extraction'] as { runId: string }).runId;

    await db.chapterFactCandidate.createMany({
      data: Array.from({ length: 205 }, (_, index) => ({
        runId,
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        sourceVersionId: versionId,
        factType: 'plot_thread',
        payload: { factType: 'plot_thread', summary: `线索 ${index}`, reason: '批量种子' },
      })),
    });

    const listed = await listFacts(fixture);
    expect(listed.status).toBe(200);
    expect((listed.json['facts'] as unknown[]).length).toBe(200);
    expect(listed.json['total']).toBe(205);
    expect(listed.json['truncated']).toBe(true);
  });

  it('空候选列表：facts=[] / total=0 / truncated=false', async () => {
    const fixture = await createFixture();
    await seedVersion(fixture, 1, { finalize: true });

    const listed = await listFacts(fixture, '', { chapterId: fixture.chapter2Id });
    expect(listed.status).toBe(200);
    expect(listed.json).toEqual({ facts: [], total: 0, truncated: false });
  });

  it('只读：列表不写审计、不改 run 与候选', async () => {
    const fixture = await createFixture();
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    setChapterFactProvider(stubProvider(sampleFacts(fixture)));
    await extract(fixture, { sourceVersionId: versionId });

    const before = {
      audits: await db.auditLog.count({ where: { targetId: fixture.chapterId } }),
      run: await db.chapterFactRun.findFirstOrThrow({ where: { workId: fixture.workId } }),
      candidates: await db.chapterFactCandidate.findMany({
        where: { workId: fixture.workId },
        orderBy: { id: 'asc' },
      }),
    };

    await listFacts(fixture);
    const rows = await db.chapterFactCandidate.findMany({ where: { workId: fixture.workId } });
    await factDetail(fixture, rows[0]?.id ?? '');
    await factRun(fixture, before.run.id);

    const after = {
      audits: await db.auditLog.count({ where: { targetId: fixture.chapterId } }),
      run: await db.chapterFactRun.findFirstOrThrow({ where: { workId: fixture.workId } }),
      candidates: await db.chapterFactCandidate.findMany({
        where: { workId: fixture.workId },
        orderBy: { id: 'asc' },
      }),
    };
    expect(after.audits).toBe(before.audits);
    expect(after.run).toEqual(before.run);
    expect(after.candidates).toEqual(before.candidates);
  });

  it('未登录 401；管理员 403；他人作品 404；跨章节 404', async () => {
    const fixture = await createFixture();
    await seedVersion(fixture, 1, { finalize: true });

    expect((await listFacts(fixture, '', { token: '' })).status).toBe(401);
    expect((await listFacts(fixture, '', { token: fixture.adminToken })).status).toBe(403);
    expect((await listFacts(fixture, '', { workId: fixture.strangerWorkId })).status).toBe(404);
    // 同一作品不存在的章节
    expect((await listFacts(fixture, '', { chapterId: randomUUID() })).status).toBe(404);
  });
});

describe('GET 候选详情与 run', () => {
  it('返回候选与 run 元信息；跨章节 / 跨作品 / 随机 id → 404', async () => {
    const fixture = await createFixture();
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    setChapterFactProvider(stubProvider(sampleFacts(fixture)));
    const created = await extract(fixture, { sourceVersionId: versionId });
    const runId = (created.json['extraction'] as { runId: string }).runId;
    const candidate = await db.chapterFactCandidate.findFirstOrThrow({
      where: { workId: fixture.workId, factType: 'plot_thread' },
    });

    const detail = await factDetail(fixture, candidate.id);
    expect(detail.status).toBe(200);
    const fact = detail.json['fact'] as Record<string, unknown>;
    expect(fact).toMatchObject({
      id: candidate.id,
      runId,
      sourceVersionId: versionId,
      sourceVersionNo: 1,
      factType: 'plot_thread',
      threadStatus: 'new',
      subjectId: null,
      objectId: null,
      name: null,
    });
    const run = detail.json['run'] as Record<string, unknown>;
    expect(run).toMatchObject({
      runId,
      status: 'succeeded',
      agentName: 'continuity.extractor',
      agentVersion: '1.0.0',
      provider: 'stub',
      model: 'stub-model',
      factCount: 3,
    });
    expect(detail.text).not.toContain(MARKER);
    expect(detail.text).not.toContain('attemptToken');
    expect(detail.text).not.toContain('attempt_token');

    // 跨章节 / 跨作品 / 随机 id
    expect(
      (await factDetail(fixture, candidate.id, { chapterId: fixture.chapter2Id })).status,
    ).toBe(404);
    expect(
      (await factDetail(fixture, candidate.id, { workId: fixture.strangerWorkId })).status,
    ).toBe(404);
    expect((await factDetail(fixture, randomUUID())).status).toBe(404);

    // run 详情
    const runResponse = await factRun(fixture, runId);
    expect(runResponse.status).toBe(200);
    expect(runResponse.json['run']).toMatchObject({
      runId,
      sourceVersionId: versionId,
      sourceVersionNo: 1,
      status: 'succeeded',
      errorCode: null,
      factCount: 3,
    });
    expect(runResponse.text).not.toContain('attemptToken');
    expect(runResponse.text).not.toContain('attempt_token');
    expect(runResponse.text).not.toContain(MARKER);
    expect((await factRun(fixture, runId, { chapterId: fixture.chapter2Id })).status).toBe(404);
    expect((await factRun(fixture, runId, { workId: fixture.strangerWorkId })).status).toBe(404);
    expect((await factRun(fixture, randomUUID())).status).toBe(404);
    expect((await factRun(fixture, 'not-a-uuid')).status).toBe(400);
  });

  it('run 详情不返回 attemptToken；失败 run 只暴露稳定 errorCode', async () => {
    const fixture = await createFixture();
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    const provider = stubProvider(sampleFacts(fixture));
    setChapterFactProvider(provider);
    provider.mode = 'throw';
    await extract(fixture, { sourceVersionId: versionId });

    const run = await db.chapterFactRun.findFirstOrThrow({ where: { workId: fixture.workId } });
    const response = await factRun(fixture, run.id);
    expect(response.status).toBe(200);
    const view = response.json['run'] as Record<string, unknown>;
    expect(view).toMatchObject({
      status: 'failed',
      errorCode: 'CONTINUITY_EXTRACTION_FAILED',
      factCount: 0,
    });
    expect(view['finishedAt']).not.toBeNull();
    expect(view).not.toHaveProperty('attemptToken');
    expect(view).not.toHaveProperty('error');
  });
});

/* -------------------------------------------------------------------------- */
/* A2-B-REV-01：默认 Mock Provider、配置错误映射、列表快照一致性                  */
/* -------------------------------------------------------------------------- */

const MODEL_ENV_KEYS = [
  'MODEL_PROVIDER',
  'MODEL_BASE_URL',
  'MODEL_API_KEY',
  'MODEL_NAME',
  'MODEL_TIMEOUT_MS',
] as const;

type ModelEnvKey = (typeof MODEL_ENV_KEYS)[number];

function snapshotModelEnv(): Map<ModelEnvKey, string | undefined> {
  return new Map(MODEL_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function setModelEnv(values: Partial<Record<ModelEnvKey, string>>): void {
  for (const key of MODEL_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreModelEnv(snapshot: Map<ModelEnvKey, string | undefined>): void {
  for (const key of MODEL_ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('默认 Mock Provider（A2-B-REV-01）', () => {
  it('MODEL_PROVIDER=mock 走真实路由：201、run=mock/mock-model、facts 合法且为空、同版本 200', async () => {
    const fixture = await createFixture();
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    const snapshot = snapshotModelEnv();
    setChapterFactProvider(null);
    // 同时给出会被误用的 Key / Base URL：mock 绝不能读取或联网
    setModelEnv({
      MODEL_PROVIDER: 'mock',
      MODEL_API_KEY: 'sk-mock-must-not-be-read',
      MODEL_BASE_URL: 'http://127.0.0.1:1',
    });

    try {
      const first = await extract(fixture, { sourceVersionId: versionId });
      expect(first.status).toBe(201);
      const extraction = first.json['extraction'] as Record<string, unknown>;
      expect(extraction).toMatchObject({
        created: true,
        sourceVersionId: versionId,
        sourceVersionNo: 1,
        provider: 'mock',
        model: 'mock-model',
        factCount: 0,
      });
      expect(extraction['factTypeCounts']).toEqual({});

      const run = await db.chapterFactRun.findFirstOrThrow({
        where: { workId: fixture.workId },
      });
      expect(run).toMatchObject({
        provider: 'mock',
        model: 'mock-model',
        agentName: 'continuity.extractor',
        status: 'succeeded',
      });
      expect(run.errorCode).toBeNull();

      // Mock 输出 {"facts": []} 合法：0 候选、成功审计 1 条
      expect(await db.chapterFactCandidate.count({ where: { workId: fixture.workId } })).toBe(0);
      expect(
        await db.auditLog.count({
          where: { action: 'continuity.facts_extracted', targetId: fixture.chapterId },
        }),
      ).toBe(1);

      const second = await extract(fixture, { sourceVersionId: versionId });
      expect(second.status).toBe(200);
      expect((second.json['extraction'] as { created: boolean }).created).toBe(false);
      expect(await db.chapterFactRun.count({ where: { workId: fixture.workId } })).toBe(1);
    } finally {
      restoreModelEnv(snapshot);
      setChapterFactProvider(null);
    }
  });
});

describe('Provider 配置错误（A2-B-REV-01）', () => {
  it('配置不完整 → 502 CONTINUITY_EXTRACTION_FAILED，不建 run / 候选 / 审计，不泄露配置', async () => {
    const fixture = await createFixture();
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    const snapshot = snapshotModelEnv();
    setChapterFactProvider(null);
    setModelEnv({
      MODEL_PROVIDER: 'openai-compatible',
      MODEL_BASE_URL: '',
      MODEL_NAME: '',
      MODEL_API_KEY: 'sk-should-not-leak-9f3c',
    });

    try {
      const response = await extract(fixture, { sourceVersionId: versionId });
      expect(response.status).toBe(502);
      expect((response.json['error'] as { code: string }).code).toBe(
        'CONTINUITY_EXTRACTION_FAILED',
      );

      // 配置错误发生在任何数据库写入之前
      expect(await db.chapterFactRun.count({ where: { workId: fixture.workId } })).toBe(0);
      expect(await db.chapterFactCandidate.count({ where: { workId: fixture.workId } })).toBe(0);
      expect(
        await db.auditLog.count({
          where: { action: 'continuity.facts_extracted', targetId: fixture.chapterId },
        }),
      ).toBe(0);

      // 不回显 Key / 环境变量名 / URL / 底层异常
      expect(response.text).not.toContain('sk-should-not-leak-9f3c');
      expect(response.text).not.toContain('MODEL_');
      expect(response.text).not.toContain('http');
      expect(response.text).not.toContain('模型服务');
    } finally {
      restoreModelEnv(snapshot);
      setChapterFactProvider(null);
    }
  });
});

describe('列表快照一致性（A2-B-REV-01）', () => {
  it('并发提交新候选时，total / facts / truncated 始终自洽', async () => {
    const fixture = await createFixture();
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    setChapterFactProvider(stubProvider([]));
    const created = await extract(fixture, { sourceVersionId: versionId });
    expect(created.status).toBe(201);
    const runId = (created.json['extraction'] as { runId: string }).runId;

    const seed = (index: number) => ({
      runId,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: versionId,
      factType: 'plot_thread',
      payload: { factType: 'plot_thread', summary: `并发线索 ${index}`, reason: '快照测试' },
    });

    // 起始 150 条：并发插入期间 total 会跨越 200 的截断边界
    await db.chapterFactCandidate.createMany({
      data: Array.from({ length: 150 }, (_, index) => seed(index)),
    });

    let closed = false;
    let inserted = 0;
    const writer = (async () => {
      for (let index = 150; index < 210 && !closed; index += 1) {
        await db.chapterFactCandidate.create({ data: seed(index) });
        inserted += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();

    try {
      // 多轮读取：每一次响应内统计与集合必须自洽
      for (let round = 0; round < 40; round += 1) {
        const listed = await listFacts(fixture);
        expect(listed.status).toBe(200);
        const facts = listed.json['facts'] as unknown[];
        const total = listed.json['total'] as number;
        const truncated = listed.json['truncated'] as boolean;
        expect(facts.length).toBeLessThanOrEqual(200);
        expect(total).toBeGreaterThanOrEqual(facts.length);
        expect(truncated).toBe(total > facts.length);
      }
    } finally {
      closed = true;
      await writer;
    }

    expect(inserted).toBeGreaterThan(0);
    // 收尾：最终总量与返回集合一致
    const final = await listFacts(fixture);
    const finalTotal = final.json['total'] as number;
    const finalFacts = final.json['facts'] as unknown[];
    expect(finalTotal).toBe(150 + inserted);
    expect(finalFacts.length).toBe(Math.min(200, finalTotal));
    expect(final.json['truncated']).toBe(finalTotal > finalFacts.length);
  });
});

describe('决策回显（A2-F-B）', () => {
  /** 提取一批候选（stub Provider，3 条），按 createdAt 排序返回。 */
  async function seedFacts(fixture: Fixture) {
    const { versionId } = await seedVersion(fixture, 1, { finalize: true });
    setChapterFactProvider(stubProvider(sampleFacts(fixture)));
    const created = await extract(fixture, { sourceVersionId: versionId });
    expect(created.status).toBe(201);
    return db.chapterFactCandidate.findMany({
      where: { workId: fixture.workId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, factType: true },
    });
  }

  it('未决定 → 列表与详情的 decision 都是 null', async () => {
    const fixture = await createFixture();
    const candidates = await seedFacts(fixture);

    const list = await listFacts(fixture);
    expect(list.status).toBe(200);
    const facts = list.json['facts'] as { id: string; decision: unknown }[];
    expect(facts).toHaveLength(3);
    expect(facts.every((fact) => fact.decision === null)).toBe(true);

    const detail = await factDetail(fixture, candidates[0]?.id ?? '');
    expect(detail.status).toBe(200);
    expect((detail.json['fact'] as { decision: unknown }).decision).toBeNull();
  });

  it('accepted / rejected 回显 value 与 ISO 时间，且不含 decidedBy', async () => {
    const fixture = await createFixture();
    const candidates = await seedFacts(fixture);
    const accepted = candidates[0];
    const rejected = candidates[1];
    expect(accepted).toBeDefined();
    expect(rejected).toBeDefined();

    const acceptedAt = new Date('2026-11-06T04:00:00.000Z');
    const rejectedAt = new Date('2026-11-06T05:00:00.000Z');
    await db.chapterFactDecision.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        sourceVersionId: (
          await db.chapterFactCandidate.findUniqueOrThrow({
            where: { id: accepted?.id ?? '' },
            select: { sourceVersionId: true },
          })
        ).sourceVersionId,
        candidateId: accepted?.id ?? '',
        decision: 'accepted',
        decidedBy: fixture.authorId,
        decidedAt: acceptedAt,
      },
    });
    await db.chapterFactDecision.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        sourceVersionId: (
          await db.chapterFactCandidate.findUniqueOrThrow({
            where: { id: rejected?.id ?? '' },
            select: { sourceVersionId: true },
          })
        ).sourceVersionId,
        candidateId: rejected?.id ?? '',
        decision: 'rejected',
        decidedBy: fixture.authorId,
        decidedAt: rejectedAt,
      },
    });

    const list = await listFacts(fixture);
    const facts = list.json['facts'] as {
      id: string;
      decision: { value: string; decidedAt: string } | null;
    }[];
    const byId = new Map(facts.map((fact) => [fact.id, fact.decision]));
    expect(byId.get(accepted?.id ?? '')).toEqual({
      value: 'accepted',
      decidedAt: acceptedAt.toISOString(),
    });
    expect(byId.get(rejected?.id ?? '')).toEqual({
      value: 'rejected',
      decidedAt: rejectedAt.toISOString(),
    });
    expect(facts.filter((fact) => fact.decision === null)).toHaveLength(1);

    // 响应与详情都不得出现 decidedBy / payload 副本
    const text = JSON.stringify(list.json);
    expect(text).not.toContain('decidedBy');
    expect(text).not.toContain('decided_by');

    const detail = await factDetail(fixture, accepted?.id ?? '');
    expect((detail.json['fact'] as { decision: unknown }).decision).toEqual({
      value: 'accepted',
      decidedAt: acceptedAt.toISOString(),
    });
    expect(Object.keys(detail.json['fact'] as object)).not.toContain('payload');
    expect(JSON.stringify(detail.json)).not.toContain('decidedBy');
  });

  it('过滤后仍带 decision，total / truncated 语义不变', async () => {
    const fixture = await createFixture();
    const candidates = await seedFacts(fixture);
    const target = candidates.find((candidate) => candidate.factType === 'plot_thread');
    expect(target).toBeDefined();
    const sourceVersionId = (
      await db.chapterFactCandidate.findUniqueOrThrow({
        where: { id: target?.id ?? '' },
        select: { sourceVersionId: true },
      })
    ).sourceVersionId;
    await db.chapterFactDecision.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        sourceVersionId,
        candidateId: target?.id ?? '',
        decision: 'accepted',
        decidedBy: fixture.authorId,
      },
    });

    const filtered = await listFacts(fixture, '?factType=plot_thread');
    expect(filtered.status).toBe(200);
    expect(filtered.json['total']).toBe(1);
    expect(filtered.json['truncated']).toBe(false);
    const facts = filtered.json['facts'] as {
      id: string;
      decision: { value: string } | null;
    }[];
    expect(facts).toHaveLength(1);
    expect(facts[0]?.id).toBe(target?.id);
    expect(facts[0]?.decision?.value).toBe('accepted');

    // 其它类型仍为未决定
    const others = await listFacts(fixture, '?factType=character_state');
    const otherFacts = others.json['facts'] as { decision: unknown }[];
    expect(otherFacts.every((fact) => fact.decision === null)).toBe(true);
  });
});
