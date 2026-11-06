/**
 * 事实候选决策服务（A2-F-A）。
 *
 * 覆盖：
 * - accepted / rejected 首次写入：201 语义（deduplicated=false）、单行、单审计；
 * - 同决定幂等（deduplicated=true，不新增行 / 审计，decidedAt 不变）；
 * - 不同决定冲突（不翻转）；
 * - 章节不再定稿 / 候选不是最新版本 → STALE；
 * - 失败 run 的候选 / 跨作品 / 跨章节 / 随机 id → 404；
 * - 并发同决定单行单审计、并发不同决定一个成功一个冲突；
 * - 数据库 append-only（UPDATE / DELETE 拒绝）、UNIQUE(candidate_id)、
 *   复合外键拒绝错版本组合；
 * - 响应与审计脱敏（不含 payload / 正文）；
 * - **决定后实体、属性、物品事件全部不变**。
 */

import { randomUUID } from 'node:crypto';

import { AUDIT_ACTIONS } from '@novel/auth';
import type { PrismaClient } from '@novel/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { decideChapterFact } from '../src/chapter/fact-decision.js';
import type { ChapterFixture } from './helpers/chapter.js';
import { createChapterFixture } from './helpers/chapter.js';
import { cleanupWork, closeTestDb, testDb } from './helpers/db.js';

let db: PrismaClient;
let fixtures: ChapterFixture[] = [];

/** 正文里唯一可搜索的标记：用来证明它没有进入审计。 */
const MARKER = '决策机密';

beforeAll(() => {
  db = testDb();
});

afterEach(async () => {
  for (const fixture of fixtures) {
    await cleanupWork(db, fixture.workId);
  }
  fixtures = [];
});

afterAll(async () => {
  await closeTestDb();
});

async function newFixture(): Promise<ChapterFixture> {
  const fixture = await createChapterFixture(db, { tag: `decision-${randomUUID().slice(0, 8)}` });
  fixtures.push(fixture);
  return fixture;
}

interface Seeded {
  readonly versionId: string;
  readonly runId: string;
  readonly candidateId: string;
}

/**
 * 造一个正式版本 +（默认成功且定稿的）run + 一条候选。
 *
 * 直接写库而不是跑真实提取：本卡只测决策，候选的来源不影响语义，
 * 且需要精确控制 run 状态（failed run 的候选只有构造得出来）。
 */
async function seedCandidate(
  fixture: ChapterFixture,
  options: {
    readonly versionNo?: number;
    readonly finalize?: boolean;
    readonly runStatus?: 'succeeded' | 'failed' | 'running';
    readonly factType?: string;
    readonly summary?: string;
    readonly chapterId?: string;
  } = {},
): Promise<Seeded> {
  const chapterId = options.chapterId ?? fixture.chapterId;
  const versionNo = options.versionNo ?? 1;
  const content = `${MARKER}-v${versionNo}，${'雪落在青瓦上，他数着更声。'.repeat(120)}`;
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
      ...(status === 'running'
        ? {}
        : {
            finishedAt: new Date(),
            ...(status === 'failed' ? { errorCode: 'CONTINUITY_EXTRACTION_FAILED' } : {}),
          }),
    },
    select: { id: true },
  });

  const candidate = await db.chapterFactCandidate.create({
    data: {
      runId: run.id,
      workId: fixture.workId,
      chapterId,
      sourceVersionId: version.id,
      factType: options.factType ?? 'character_state',
      payload: {
        factType: options.factType ?? 'character_state',
        summary: options.summary ?? `${MARKER}：主角受了内伤`,
        reason: `${MARKER}：正文写到他咳血`,
        subjectId: fixture.characters[0]?.id ?? randomUUID(),
      },
    },
    select: { id: true },
  });

  return { versionId: version.id, runId: run.id, candidateId: candidate.id };
}

function decide(
  fixture: ChapterFixture,
  candidateId: string,
  decision: 'accepted' | 'rejected',
  options: { workId?: string; chapterId?: string; authorId?: string } = {},
) {
  return decideChapterFact({
    db,
    authorId: options.authorId ?? fixture.authorId,
    workId: options.workId ?? fixture.workId,
    chapterId: options.chapterId ?? fixture.chapterId,
    candidateId,
    decision,
  });
}

async function decisionRows(workId: string) {
  return db.chapterFactDecision.findMany({ where: { workId }, orderBy: { decidedAt: 'asc' } });
}

async function decisionAudits(candidateId: string) {
  return db.auditLog.findMany({
    where: { action: AUDIT_ACTIONS.CONTINUITY_FACT_DECIDED, targetId: candidateId },
  });
}

describe('首次决定', () => {
  it('accepted：写一行决定 + 一条审计，响应脱敏', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);

    const result = await decide(fixture, seeded.candidateId, 'accepted');

    expect(result).toMatchObject({
      candidateId: seeded.candidateId,
      decision: 'accepted',
      deduplicated: false,
    });
    expect(Number.isNaN(Date.parse(result.decidedAt))).toBe(false);
    expect(Object.keys(result).sort()).toEqual(
      ['candidateId', 'decidedAt', 'decision', 'deduplicated'].sort(),
    );

    const rows = await decisionRows(fixture.workId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      candidateId: seeded.candidateId,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: seeded.versionId,
      decision: 'accepted',
      decidedBy: fixture.authorId,
    });
    expect(rows[0]?.decidedAt.toISOString()).toBe(result.decidedAt);
  });

  it('rejected：同样是终态决定，语义由 decision 区分', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);

    const result = await decide(fixture, seeded.candidateId, 'rejected');
    expect(result.decision).toBe('rejected');
    expect(result.deduplicated).toBe(false);
    expect((await decisionRows(fixture.workId))[0]?.decision).toBe('rejected');
  });

  it('审计 detail 只有 ids 与 decision，不含 payload / 正文', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);

    await decide(fixture, seeded.candidateId, 'accepted');

    const audits = await decisionAudits(seeded.candidateId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: fixture.authorId,
      targetType: 'chapter_fact_candidate',
      targetId: seeded.candidateId,
    });
    expect(audits[0]?.detail).toEqual({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: seeded.versionId,
      candidateId: seeded.candidateId,
      decision: 'accepted',
    });
    // 序列化后的审计行不得包含候选 payload 里的文本
    expect(JSON.stringify(audits[0])).not.toContain(MARKER);
  });
});

describe('幂等与冲突', () => {
  it('同决定重复提交 → deduplicated=true，不新增行、不新增审计', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);

    const first = await decide(fixture, seeded.candidateId, 'accepted');
    const second = await decide(fixture, seeded.candidateId, 'accepted');

    expect(second.deduplicated).toBe(true);
    expect(second.decidedAt).toBe(first.decidedAt);
    expect(await decisionRows(fixture.workId)).toHaveLength(1);
    expect(await decisionAudits(seeded.candidateId)).toHaveLength(1);
  });

  it('不同决定 → 409 CONTINUITY_FACT_ALREADY_DECIDED，不翻转', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);

    await decide(fixture, seeded.candidateId, 'accepted');
    await expect(decide(fixture, seeded.candidateId, 'rejected')).rejects.toMatchObject({
      code: 'CONTINUITY_FACT_ALREADY_DECIDED',
    });

    const rows = await decisionRows(fixture.workId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe('accepted');
    expect(await decisionAudits(seeded.candidateId)).toHaveLength(1);
  });

  it('已拒绝后再次拒绝 → 幂等；改为接受 → 冲突', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);

    await decide(fixture, seeded.candidateId, 'rejected');
    await expect(decide(fixture, seeded.candidateId, 'rejected')).resolves.toMatchObject({
      deduplicated: true,
    });
    await expect(decide(fixture, seeded.candidateId, 'accepted')).rejects.toMatchObject({
      code: 'CONTINUITY_FACT_ALREADY_DECIDED',
    });
    expect(await decisionRows(fixture.workId)).toHaveLength(1);
  });
});

describe('过期与归属', () => {
  it('章节不再是 finalized → STALE，不写任何数据', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);
    await db.chapter.update({ where: { id: fixture.chapterId }, data: { status: 'in_review' } });

    await expect(decide(fixture, seeded.candidateId, 'accepted')).rejects.toMatchObject({
      code: 'CONTINUITY_FACT_DECISION_STALE',
    });
    expect(await decisionRows(fixture.workId)).toHaveLength(0);
    expect(await decisionAudits(seeded.candidateId)).toHaveLength(0);
  });

  it('候选不是当前最新版本 → STALE', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);
    // 追加版本 2（章节仍是 finalized）
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

    await expect(decide(fixture, seeded.candidateId, 'accepted')).rejects.toMatchObject({
      code: 'CONTINUITY_FACT_DECISION_STALE',
    });
    expect(await decisionRows(fixture.workId)).toHaveLength(0);
  });

  it('失败 run 的候选 → 404（只允许成功 run）', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture, { runStatus: 'failed' });

    await expect(decide(fixture, seeded.candidateId, 'accepted')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await decisionRows(fixture.workId)).toHaveLength(0);
  });

  it('随机 candidateId → 404', async () => {
    const fixture = await newFixture();
    await seedCandidate(fixture);

    await expect(decide(fixture, randomUUID(), 'accepted')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('跨章节：候选属于同作品的另一章 → 404', async () => {
    const fixture = await newFixture();
    const otherChapter = await db.chapter.create({
      data: { workId: fixture.workId, chapterNo: 2, title: '第二章' },
      select: { id: true },
    });
    const seeded = await seedCandidate(fixture, { chapterId: otherChapter.id });

    // 用第一章的路径访问第二章的候选
    await expect(decide(fixture, seeded.candidateId, 'accepted')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('跨作品 / 他人作品 → 404', async () => {
    const mine = await newFixture();
    const other = await newFixture();
    const otherSeeded = await seedCandidate(other);

    // 用我的作品 + 我的章节 + 别人的候选：只有 candidate 归属条件能拒绝
    await expect(decide(mine, otherSeeded.candidateId, 'accepted')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // 用我的作品 id + 别人的章节 + 别人的候选
    await expect(
      decide(mine, otherSeeded.candidateId, 'accepted', { chapterId: other.chapterId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // 用别人的作品 + 我的作者身份（作品归属校验先拒绝）
    await expect(
      decide(mine, otherSeeded.candidateId, 'accepted', {
        workId: other.workId,
        chapterId: other.chapterId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await decisionRows(other.workId)).toHaveLength(0);
  });
});

describe('并发', () => {
  it('并发同决定：单行决定、单条审计，结果一个首次一个幂等', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);

    const results = await Promise.all([
      decide(fixture, seeded.candidateId, 'accepted'),
      decide(fixture, seeded.candidateId, 'accepted'),
    ]);

    expect(results.filter((row) => row.deduplicated === false)).toHaveLength(1);
    expect(results.filter((row) => row.deduplicated === true)).toHaveLength(1);
    expect(await decisionRows(fixture.workId)).toHaveLength(1);
    expect(await decisionAudits(seeded.candidateId)).toHaveLength(1);
  });

  it('并发不同决定：一个成功、一个 ALREADY_DECIDED，仍只有一行', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);

    const settled = await Promise.allSettled([
      decide(fixture, seeded.candidateId, 'accepted'),
      decide(fixture, seeded.candidateId, 'rejected'),
    ]);

    const fulfilled = settled.filter((row) => row.status === 'fulfilled');
    const rejected = settled.filter((row) => row.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason as { code?: string }).toMatchObject({
      code: 'CONTINUITY_FACT_ALREADY_DECIDED',
    });
    expect(await decisionRows(fixture.workId)).toHaveLength(1);
    expect(await decisionAudits(seeded.candidateId)).toHaveLength(1);
  });
});

describe('数据库层约束', () => {
  it('append-only：UPDATE / DELETE 一律拒绝', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);
    const result = await decide(fixture, seeded.candidateId, 'accepted');
    void result;

    await expect(
      db.$executeRawUnsafe(
        `UPDATE "chapter_fact_decisions" SET "decision" = 'rejected' WHERE "candidate_id" = $1::uuid`,
        seeded.candidateId,
      ),
    ).rejects.toThrow(/不可修改或删除/u);

    await expect(
      db.$executeRawUnsafe(
        `DELETE FROM "chapter_fact_decisions" WHERE "candidate_id" = $1::uuid`,
        seeded.candidateId,
      ),
    ).rejects.toThrow(/不可修改或删除/u);
  });

  it('UNIQUE(candidate_id)：同一候选不能有两条决定', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);
    await decide(fixture, seeded.candidateId, 'accepted');

    await expect(
      db.chapterFactDecision.create({
        data: {
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          sourceVersionId: seeded.versionId,
          candidateId: seeded.candidateId,
          decision: 'rejected',
          decidedBy: fixture.authorId,
        },
      }),
    ).rejects.toThrow();
  });

  it('复合外键：版本 / 章节与候选不一致时直接拒绝', async () => {
    const fixture = await newFixture();
    const first = await seedCandidate(fixture, { versionNo: 1 });
    const second = await seedCandidate(fixture, { versionNo: 2 });

    // 候选属于版本 1，却把 source_version_id 写成版本 2
    await expect(
      db.chapterFactDecision.create({
        data: {
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          sourceVersionId: second.versionId,
          candidateId: first.candidateId,
          decision: 'accepted',
          decidedBy: fixture.authorId,
        },
      }),
    ).rejects.toThrow();
  });

  it('decision 白名单由数据库兜底', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "chapter_fact_decisions"
           ("id", "work_id", "chapter_id", "source_version_id", "candidate_id", "decision", "decided_by")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'maybe', $5::uuid)`,
        fixture.workId,
        fixture.chapterId,
        seeded.versionId,
        seeded.candidateId,
        fixture.authorId,
      ),
    ).rejects.toThrow();
  });
});

describe('数据边界：决定不写回任何实体', () => {
  it('接受后人物 / 物品 / 势力 / 境界 / 属性 / 物品事件全部不变', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(fixture);

    const snapshot = async () => ({
      entities: await db.entity.findMany({
        where: { workId: fixture.workId },
        orderBy: { id: 'asc' },
        select: { id: true, entityType: true, name: true, orderIndex: true, deletedAt: true },
      }),
      attributes: await db.entityAttribute.findMany({
        where: { entity: { workId: fixture.workId } },
        orderBy: { id: 'asc' },
        select: { id: true, attrKey: true, attrValue: true },
      }),
      itemEvents: await db.itemEvent.count({ where: { workId: fixture.workId } }),
      chapters: await db.chapter.findMany({
        where: { workId: fixture.workId },
        orderBy: { id: 'asc' },
        select: { id: true, status: true, updatedAt: true },
      }),
      versions: await db.chapterVersion.count({ where: { workId: fixture.workId } }),
    });

    const before = await snapshot();
    await decide(fixture, seeded.candidateId, 'accepted');
    const after = await snapshot();

    expect(after).toEqual(before);
    // 决定本身只有一行
    expect(await decisionRows(fixture.workId)).toHaveLength(1);
  });
});
