/**
 * 事实候选决策 API（A2-F-A）。
 *
 * 覆盖：
 * - 首次 accepted / rejected → 201，响应只有 4 个字段；
 * - 同决定重复 → 200 deduplicated=true（不新增行 / 审计）；
 * - 不同决定 → 409 `CONTINUITY_FACT_ALREADY_DECIDED`（不翻转）；
 * - 非定稿 / 非最新版本 → 409 `CONTINUITY_FACT_DECISION_STALE`；
 * - 失败 run 的候选、跨作品、跨章节、随机 id → 404；
 * - 未登录 401、管理员 403、缺 Origin 403、未知字段 / 非法 decision → 400；
 * - 审计一条且不含 payload；响应脱敏；
 * - 决定不修改任何实体 / 物品事件。
 */

import { randomUUID } from 'node:crypto';

import { AUDIT_ACTIONS, SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as decisionPost } from '../app/api/works/[id]/chapters/[chapterId]/facts/[candidateId]/decision/route.js';

const ORIGIN = 'http://127.0.0.1:3000';
const MARKER = `决策机密-${randomUUID().slice(0, 8)}`;

let db: PrismaClient;

interface Fixture {
  readonly authorId: string;
  readonly token: string;
  readonly adminToken: string;
  readonly workId: string;
  readonly chapterId: string;
  readonly chapter2Id: string;
}

const works: string[] = [];

async function createUser(role: 'author' | 'admin'): Promise<{ id: string; token: string }> {
  const user = await db.user.create({
    data: {
      email: `fact-decision-${role}-${randomUUID()}@example.test`,
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

async function createFixture(): Promise<Fixture> {
  const author = await createUser('author');
  const admin = await createUser('admin');
  const work = await db.work.create({
    data: {
      authorId: author.id,
      title: `决策作品-${randomUUID().slice(0, 8)}`,
      genreRulePackage: 'xuanhuan',
    },
    select: { id: true },
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
    adminToken: admin.token,
    workId: work.id,
    chapterId: chapter.id,
    chapter2Id: chapter2.id,
  };
}

interface Seeded {
  readonly versionId: string;
  readonly runId: string;
  readonly candidateId: string;
}

/** 造版本 + 成功 run + 候选；`finalize` 控制章节是否定稿。 */
async function seedCandidate(
  fixture: Fixture,
  options: {
    readonly versionNo?: number;
    readonly finalize?: boolean;
    readonly runStatus?: 'succeeded' | 'failed';
    readonly chapterId?: string;
  } = {},
): Promise<Seeded> {
  const chapterId = options.chapterId ?? fixture.chapterId;
  const versionNo = options.versionNo ?? 1;
  const content = `${MARKER}-v${versionNo}，${'雪落在青瓦上。'.repeat(200)}`;
  const version = await db.chapterVersion.create({
    data: {
      workId: fixture.workId,
      chapterId,
      versionNo,
      content,
      wordCount: content.length,
      source: 'human',
      createdBy: fixture.authorId,
    },
    select: { id: true },
  });
  if (options.finalize !== false) {
    await db.chapter.update({ where: { id: chapterId }, data: { status: 'finalized' } });
  }
  const status = options.runStatus ?? 'succeeded';
  const run = await db.chapterFactRun.create({
    data: {
      workId: fixture.workId,
      chapterId,
      sourceVersionId: version.id,
      agentName: 'continuity.extractor',
      agentVersion: '1.0.0',
      provider: 'mock',
      model: 'mock-model',
      status,
      finishedAt: new Date(),
      ...(status === 'failed' ? { errorCode: 'CONTINUITY_EXTRACTION_FAILED' } : {}),
    },
    select: { id: true },
  });
  const candidate = await db.chapterFactCandidate.create({
    data: {
      runId: run.id,
      workId: fixture.workId,
      chapterId,
      sourceVersionId: version.id,
      factType: 'character_state',
      payload: { summary: `${MARKER}：主角受了内伤`, reason: `${MARKER}：正文写到他咳血` },
    },
    select: { id: true },
  });
  return { versionId: version.id, runId: run.id, candidateId: candidate.id };
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

interface HttpResult {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly text: string;
}

async function read(response: Response): Promise<HttpResult> {
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as Record<string, unknown>, text };
}

async function decide(
  fixture: Fixture,
  candidateId: string,
  body: Record<string, unknown>,
  options: {
    token?: string;
    origin?: string | null;
    workId?: string;
    chapterId?: string;
  } = {},
): Promise<HttpResult> {
  const workId = options.workId ?? fixture.workId;
  const chapterId = options.chapterId ?? fixture.chapterId;
  const token = options.token === undefined ? fixture.token : options.token;
  return read(
    await decisionPost(
      postRequest(
        `/api/works/${workId}/chapters/${chapterId}/facts/${candidateId}/decision`,
        body,
        options.origin === undefined ? { token } : { token, origin: options.origin },
      ),
      { params: Promise.resolve({ id: workId, chapterId, candidateId }) },
    ),
  );
}

function decisionOf(result: HttpResult): Record<string, unknown> {
  return result.json['decision'] as Record<string, unknown>;
}

async function decisionCount(workId: string): Promise<number> {
  return db.chapterFactDecision.count({ where: { workId } });
}

async function audits(candidateId: string) {
  return db.auditLog.findMany({
    where: { action: AUDIT_ACTIONS.CONTINUITY_FACT_DECIDED, targetId: candidateId },
  });
}

beforeAll(async () => {
  db = getPrismaClient();
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

describe('首次决定', () => {
  it('accepted → 201，响应只有 4 个字段', async () => {
    const fixture = await createFixture();
    const seeded = await seedCandidate(fixture);

    const result = await decide(fixture, seeded.candidateId, { decision: 'accepted' });
    expect(result.status).toBe(201);
    expect(Object.keys(result.json)).toEqual(['decision']);
    expect(Object.keys(decisionOf(result)).sort()).toEqual(
      ['candidateId', 'decidedAt', 'decision', 'deduplicated'].sort(),
    );
    expect(decisionOf(result)).toMatchObject({
      candidateId: seeded.candidateId,
      decision: 'accepted',
      deduplicated: false,
    });
    expect(Number.isNaN(Date.parse(String(decisionOf(result)['decidedAt'])))).toBe(false);

    const rows = await db.chapterFactDecision.findMany({ where: { workId: fixture.workId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      candidateId: seeded.candidateId,
      decision: 'accepted',
      decidedBy: fixture.authorId,
    });
    expect(await audits(seeded.candidateId)).toHaveLength(1);
  });

  it('rejected → 201，语义由 decision 区分', async () => {
    const fixture = await createFixture();
    const seeded = await seedCandidate(fixture);

    const result = await decide(fixture, seeded.candidateId, { decision: 'rejected' });
    expect(result.status).toBe(201);
    expect(decisionOf(result)['decision']).toBe('rejected');
  });

  it('响应与审计脱敏：不含 payload 文本 / provider', async () => {
    const fixture = await createFixture();
    const seeded = await seedCandidate(fixture);

    const result = await decide(fixture, seeded.candidateId, { decision: 'accepted' });
    expect(result.text).not.toContain(MARKER);
    expect(result.text).not.toContain('mock-model');
    expect(result.text).not.toContain('provider');

    const rows = await audits(seeded.candidateId);
    expect(rows[0]?.detail).toEqual({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: seeded.versionId,
      candidateId: seeded.candidateId,
      decision: 'accepted',
    });
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
  });
});

describe('幂等与冲突', () => {
  it('同决定重复提交 → 200 deduplicated=true，只有一行、一条审计', async () => {
    const fixture = await createFixture();
    const seeded = await seedCandidate(fixture);

    const first = await decide(fixture, seeded.candidateId, { decision: 'accepted' });
    const second = await decide(fixture, seeded.candidateId, { decision: 'accepted' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(decisionOf(second)).toMatchObject({ deduplicated: true });
    expect(decisionOf(second)['decidedAt']).toBe(decisionOf(first)['decidedAt']);
    expect(await decisionCount(fixture.workId)).toBe(1);
    expect(await audits(seeded.candidateId)).toHaveLength(1);
  });

  it('不同决定 → 409 CONTINUITY_FACT_ALREADY_DECIDED，不翻转', async () => {
    const fixture = await createFixture();
    const seeded = await seedCandidate(fixture);

    await decide(fixture, seeded.candidateId, { decision: 'accepted' });
    const conflict = await decide(fixture, seeded.candidateId, { decision: 'rejected' });

    expect(conflict.status).toBe(409);
    expect((conflict.json['error'] as { code: string }).code).toBe(
      'CONTINUITY_FACT_ALREADY_DECIDED',
    );
    const rows = await db.chapterFactDecision.findMany({ where: { workId: fixture.workId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe('accepted');
    expect(await audits(seeded.candidateId)).toHaveLength(1);
  });
});

describe('过期与归属', () => {
  it('章节不再是 finalized → 409 STALE，不写数据', async () => {
    const fixture = await createFixture();
    const seeded = await seedCandidate(fixture);
    await db.chapter.update({ where: { id: fixture.chapterId }, data: { status: 'in_review' } });

    const result = await decide(fixture, seeded.candidateId, { decision: 'accepted' });
    expect(result.status).toBe(409);
    expect((result.json['error'] as { code: string }).code).toBe('CONTINUITY_FACT_DECISION_STALE');
    expect(await decisionCount(fixture.workId)).toBe(0);
  });

  it('候选不是当前最新版本 → 409 STALE', async () => {
    const fixture = await createFixture();
    const seeded = await seedCandidate(fixture);
    const content = `${MARKER}-v2，${'风穿过廊下。'.repeat(220)}`;
    await db.chapterVersion.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        versionNo: 2,
        content,
        wordCount: content.length,
        source: 'human',
        createdBy: fixture.authorId,
      },
    });

    const result = await decide(fixture, seeded.candidateId, { decision: 'accepted' });
    expect(result.status).toBe(409);
    expect((result.json['error'] as { code: string }).code).toBe('CONTINUITY_FACT_DECISION_STALE');
  });

  it('失败 run 的候选 → 404', async () => {
    const fixture = await createFixture();
    const seeded = await seedCandidate(fixture, { runStatus: 'failed' });

    const result = await decide(fixture, seeded.candidateId, { decision: 'accepted' });
    expect(result.status).toBe(404);
  });

  it('跨章节 / 随机候选 → 404', async () => {
    const fixture = await createFixture();
    const seeded = await seedCandidate(fixture);

    // 用第二章的路径访问第一章的候选
    const crossChapter = await decide(
      fixture,
      seeded.candidateId,
      { decision: 'accepted' },
      { chapterId: fixture.chapter2Id },
    );
    expect(crossChapter.status).toBe(404);

    const randomCandidate = await decide(fixture, randomUUID(), { decision: 'accepted' });
    expect(randomCandidate.status).toBe(404);

    expect(await decisionCount(fixture.workId)).toBe(0);
  });

  it('他人作品 → 404', async () => {
    const mine = await createFixture();
    const other = await createFixture();
    const otherSeeded = await seedCandidate(other);

    // 别人的作品路径：作品归属校验先拒绝
    const otherWork = await decide(
      mine,
      otherSeeded.candidateId,
      { decision: 'accepted' },
      { workId: other.workId, chapterId: other.chapterId },
    );
    expect(otherWork.status).toBe(404);

    // 我的作品 + 我的章节 + 别人的候选：只有 candidate 归属条件能拒绝
    const otherCandidate = await decide(mine, otherSeeded.candidateId, {
      decision: 'accepted',
    });
    expect(otherCandidate.status).toBe(404);

    expect(await decisionCount(other.workId)).toBe(0);
    expect(await decisionCount(mine.workId)).toBe(0);
  });
});

describe('权限与校验', () => {
  it('未登录 401、管理员 403', async () => {
    const fixture = await createFixture();
    const seeded = await seedCandidate(fixture);

    const anonymous = await decide(
      fixture,
      seeded.candidateId,
      { decision: 'accepted' },
      { token: '' },
    );
    expect(anonymous.status).toBe(401);

    const admin = await decide(
      fixture,
      seeded.candidateId,
      { decision: 'accepted' },
      { token: fixture.adminToken },
    );
    expect(admin.status).toBe(403);
    expect(await decisionCount(fixture.workId)).toBe(0);
  });

  it('缺 Origin → 403 INVALID_ORIGIN（写接口必须校验来源）', async () => {
    const fixture = await createFixture();
    const seeded = await seedCandidate(fixture);

    const result = await decide(
      fixture,
      seeded.candidateId,
      { decision: 'accepted' },
      { origin: null },
    );
    expect(result.status).toBe(403);
    expect((result.json['error'] as { code: string }).code).toBe('INVALID_ORIGIN');
    expect(await decisionCount(fixture.workId)).toBe(0);
  });

  it('未知字段 / 缺 decision / 非法值 → 400，且不写数据', async () => {
    const fixture = await createFixture();
    const seeded = await seedCandidate(fixture);

    const cases: Record<string, unknown>[] = [
      { decision: 'accepted', candidateId: seeded.candidateId },
      { decision: 'accepted', note: '顺便写回实体' },
      {},
      { decision: null },
      { decision: 'maybe' },
      { decision: 'ACCEPTED' },
      { decision: 1 },
      { decision: { value: 'accepted' } },
    ];
    for (const body of cases) {
      const result = await decide(fixture, seeded.candidateId, body);
      expect(result.status).toBe(400);
      expect((result.json['error'] as { code: string }).code).toBe('VALIDATION_FAILED');
    }
    expect(await decisionCount(fixture.workId)).toBe(0);
    expect(await audits(seeded.candidateId)).toHaveLength(0);
  });
});

describe('数据边界', () => {
  it('决定后实体与物品事件不变，且不新增任何实体', async () => {
    const fixture = await createFixture();
    await db.entity.create({
      data: { workId: fixture.workId, entityType: 'character', name: '李青', orderIndex: 1 },
    });
    const seeded = await seedCandidate(fixture);

    const before = {
      entities: await db.entity.count({ where: { workId: fixture.workId } }),
      attributes: await db.entityAttribute.count({ where: { entity: { workId: fixture.workId } } }),
      itemEvents: await db.itemEvent.count({ where: { workId: fixture.workId } }),
      versions: await db.chapterVersion.count({ where: { workId: fixture.workId } }),
    };

    const result = await decide(fixture, seeded.candidateId, { decision: 'accepted' });
    expect(result.status).toBe(201);

    expect({
      entities: await db.entity.count({ where: { workId: fixture.workId } }),
      attributes: await db.entityAttribute.count({ where: { entity: { workId: fixture.workId } } }),
      itemEvents: await db.itemEvent.count({ where: { workId: fixture.workId } }),
      versions: await db.chapterVersion.count({ where: { workId: fixture.workId } }),
    }).toEqual(before);
  });
});
