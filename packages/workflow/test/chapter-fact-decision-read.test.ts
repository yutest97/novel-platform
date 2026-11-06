/**
 * 事实决策状态读取模型（A2-F-B）。
 *
 * 覆盖：
 * - 未决定 → `decision = null`；accepted / rejected 回显且时间 ISO；
 * - 列表混合已决 / 未决；filter + total / truncated 与 decision 同时正确；
 * - 候选详情回显 decision；跨作品 / 跨章节 / 随机 id → 404；
 * - 别的章节 / 别的作品的决定不会串到当前章节；
 * - 列表是**单条 SQL + LEFT JOIN**（无 N+1：不访问 chapterFactDecision 代理）；
 * - 只读：不写审计、不改 decision / candidate / run；
 * - 视图不暴露 decidedBy、payload 副本或任何内部字段；
 * - 异常 decision 值 / 缺 decidedAt 按"未决定"处理。
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@novel/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ChapterFactType } from '../src/chapter/facts.js';
import { decideChapterFact } from '../src/chapter/fact-decision.js';
import {
  getChapterFactCandidate,
  listChapterFacts,
  toFactDecisionView,
} from '../src/chapter/fact-read.js';
import type { ChapterFixture } from './helpers/chapter.js';
import { createChapterFixture } from './helpers/chapter.js';
import { cleanupWork, closeTestDb, testDb } from './helpers/db.js';

let db: PrismaClient;
let fixtures: ChapterFixture[] = [];

const MARKER = '决策读取机密';

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
  const fixture = await createChapterFixture(db, {
    tag: `decision-read-${randomUUID().slice(0, 8)}`,
  });
  fixtures.push(fixture);
  return fixture;
}

interface SeededChapter {
  readonly chapterId: string;
  readonly versionId: string;
  readonly runId: string;
}

/** 造一个正式版本 + 成功 run（同一 run 下的候选共享它，符合 UNIQUE(source_version_id)）。 */
async function seedChapter(
  fixture: ChapterFixture,
  options: { readonly chapterId?: string; readonly versionNo?: number } = {},
): Promise<SeededChapter> {
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
  await db.chapter.update({ where: { id: chapterId }, data: { status: 'finalized' } });
  const run = await db.chapterFactRun.create({
    data: {
      workId: fixture.workId,
      chapterId,
      sourceVersionId: version.id,
      agentName: 'continuity.extractor',
      agentVersion: '1.0.0',
      provider: 'mock',
      model: 'mock-model',
      status: 'succeeded',
      finishedAt: new Date(),
    },
    select: { id: true },
  });
  return { chapterId, versionId: version.id, runId: run.id };
}

async function addCandidate(
  fixture: ChapterFixture,
  seeded: SeededChapter,
  options: { readonly factType?: string; readonly summary?: string } = {},
): Promise<string> {
  const candidate = await db.chapterFactCandidate.create({
    data: {
      runId: seeded.runId,
      workId: fixture.workId,
      chapterId: seeded.chapterId,
      sourceVersionId: seeded.versionId,
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
  return candidate.id;
}

function decide(fixture: ChapterFixture, candidateId: string, decision: 'accepted' | 'rejected') {
  return decideChapterFact({
    db,
    authorId: fixture.authorId,
    workId: fixture.workId,
    chapterId: fixture.chapterId,
    candidateId,
    decision,
  });
}

function list(fixture: ChapterFixture, options: { factType?: ChapterFactType } = {}) {
  return listChapterFacts({
    db,
    workId: fixture.workId,
    chapterId: fixture.chapterId,
    authorId: fixture.authorId,
    ...(options.factType === undefined ? {} : { factType: options.factType }),
  });
}

/**
 * 计数代理：用于证明列表是单条 SQL 且不逐个读决定。
 *
 * - `$queryRaw` 的访问次数 = 列表 SQL 的条数（本项目所有原生查询都用它）；
 * - `chapterFactDecision` 的访问次数 = 是否发生了按候选逐条查决定（N+1）。
 */
function countingClient(real: PrismaClient): {
  readonly db: PrismaClient;
  readonly rawQueries: () => number;
  readonly decisionAccess: () => number;
} {
  let rawQueries = 0;
  let decisionAccess = 0;
  const proxy = new Proxy(real, {
    get(target, prop) {
      if (prop === '$queryRaw') {
        rawQueries += 1;
      }
      if (prop === 'chapterFactDecision') {
        decisionAccess += 1;
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return {
    db: proxy,
    rawQueries: () => rawQueries,
    decisionAccess: () => decisionAccess,
  };
}

describe('列表读取', () => {
  it('未决定 → decision=null', async () => {
    const fixture = await newFixture();
    const seeded = await seedChapter(fixture);
    await addCandidate(fixture, seeded);

    const result = await list(fixture);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.decision).toBeNull();
  });

  it('accepted / rejected 正确回显，时间是 ISO', async () => {
    const fixture = await newFixture();
    const seeded = await seedChapter(fixture);
    const acceptedId = await addCandidate(fixture, seeded, { summary: '第一条' });
    const rejectedId = await addCandidate(fixture, seeded, { summary: '第二条' });

    const accepted = await decide(fixture, acceptedId, 'accepted');
    const rejected = await decide(fixture, rejectedId, 'rejected');

    const result = await list(fixture);
    const byId = new Map(result.facts.map((fact) => [fact.id, fact]));
    expect(byId.get(acceptedId)?.decision).toEqual({
      value: 'accepted',
      decidedAt: accepted.decidedAt,
    });
    expect(byId.get(rejectedId)?.decision).toEqual({
      value: 'rejected',
      decidedAt: rejected.decidedAt,
    });
    expect(Number.isNaN(Date.parse(byId.get(acceptedId)?.decision?.decidedAt ?? ''))).toBe(false);
  });

  it('列表混合已决 / 未决：只有已决的带 decision', async () => {
    const fixture = await newFixture();
    const seeded = await seedChapter(fixture);
    const decidedId = await addCandidate(fixture, seeded, { summary: '已决' });
    await addCandidate(fixture, seeded, { summary: '未决' });
    await decide(fixture, decidedId, 'accepted');

    const result = await list(fixture);
    expect(result.facts).toHaveLength(2);
    const decided = result.facts.filter((fact) => fact.decision !== null);
    expect(decided).toHaveLength(1);
    expect(decided[0]?.id).toBe(decidedId);
    expect(decided[0]?.decision?.value).toBe('accepted');
  });

  it('filter + total + truncated 与 decision 同时正确', async () => {
    const fixture = await newFixture();
    const seeded = await seedChapter(fixture);
    // 200 条人物状态 + 1 条情节线索 = 201 条，触发 truncated
    const bulk = Array.from({ length: 200 }, (_, index) => ({
      runId: seeded.runId,
      workId: fixture.workId,
      chapterId: seeded.chapterId,
      sourceVersionId: seeded.versionId,
      factType: 'character_state',
      payload: { summary: `批量-${String(index)}`, reason: '批量' },
    }));
    await db.chapterFactCandidate.createMany({ data: bulk });
    const threadId = await addCandidate(fixture, seeded, { factType: 'plot_thread' });
    await decide(fixture, threadId, 'rejected');

    const all = await list(fixture);
    expect(all.total).toBe(201);
    expect(all.truncated).toBe(true);
    expect(all.facts).toHaveLength(200);
    // 已决的那条在 all 里也带 decision
    const decidedInPage = all.facts.find((fact) => fact.id === threadId);
    expect(decidedInPage?.decision?.value).toBe('rejected');

    const filtered = await list(fixture, { factType: 'plot_thread' });
    expect(filtered.total).toBe(1);
    expect(filtered.truncated).toBe(false);
    expect(filtered.facts).toHaveLength(1);
    expect(filtered.facts[0]?.decision?.value).toBe('rejected');

    const emptyFilter = await list(fixture, { factType: 'item_change' });
    expect(emptyFilter.total).toBe(0);
    expect(emptyFilter.truncated).toBe(false);
    expect(emptyFilter.facts).toEqual([]);
  });

  it('单条 SQL + LEFT JOIN：访问 1 次 $queryRaw、0 次 chapterFactDecision', async () => {
    const fixture = await newFixture();
    const seeded = await seedChapter(fixture);
    // 12 条候选：N+1 实现会产生 12 次决定查询
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      ids.push(await addCandidate(fixture, seeded, { summary: `候选-${String(index)}` }));
    }
    await decide(fixture, ids[0] ?? '', 'accepted');
    await decide(fixture, ids[5] ?? '', 'rejected');

    const probe = countingClient(db);
    const result = await listChapterFacts({
      db: probe.db,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
    });

    expect(result.facts).toHaveLength(12);
    expect(result.facts.filter((fact) => fact.decision !== null)).toHaveLength(2);
    expect(probe.rawQueries()).toBe(1);
    expect(probe.decisionAccess()).toBe(0);
  });
});

describe('候选详情读取', () => {
  it('详情回显 decision；未决定为 null', async () => {
    const fixture = await newFixture();
    const seeded = await seedChapter(fixture);
    const decidedId = await addCandidate(fixture, seeded, { summary: '已决' });
    const undecidedId = await addCandidate(fixture, seeded, { summary: '未决' });
    const decision = await decide(fixture, decidedId, 'accepted');

    const decided = await getChapterFactCandidate({
      db,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      candidateId: decidedId,
    });
    expect(decided.fact.decision).toEqual({
      value: 'accepted',
      decidedAt: decision.decidedAt,
    });

    const undecided = await getChapterFactCandidate({
      db,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      candidateId: undecidedId,
    });
    expect(undecided.fact.decision).toBeNull();
  });

  it('详情：跨章节 / 随机 id / 他人作品 → 404', async () => {
    const fixture = await newFixture();
    const other = await newFixture();
    const seeded = await seedChapter(fixture);
    const candidateId = await addCandidate(fixture, seeded);
    const otherChapter = await db.chapter.create({
      data: { workId: fixture.workId, chapterNo: 2, title: '第二章' },
      select: { id: true },
    });

    await expect(
      getChapterFactCandidate({
        db,
        workId: fixture.workId,
        chapterId: otherChapter.id,
        authorId: fixture.authorId,
        candidateId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      getChapterFactCandidate({
        db,
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        authorId: fixture.authorId,
        candidateId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      getChapterFactCandidate({
        db,
        workId: other.workId,
        chapterId: other.chapterId,
        authorId: other.authorId,
        candidateId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('详情：别的章节的决定不会串到当前候选', async () => {
    const fixture = await newFixture();
    const chapterA = await seedChapter(fixture);
    const chapterB = await seedChapter(fixture, {
      chapterId: (
        await db.chapter.create({
          data: { workId: fixture.workId, chapterNo: 2, title: '第二章' },
          select: { id: true },
        })
      ).id,
      versionNo: 1,
    });
    const candidateA = await addCandidate(fixture, chapterA);
    const candidateB = await addCandidate(fixture, chapterB);
    await decideChapterFact({
      db,
      authorId: fixture.authorId,
      workId: fixture.workId,
      chapterId: chapterB.chapterId,
      candidateId: candidateB,
      decision: 'rejected',
    });

    const detailA = await getChapterFactCandidate({
      db,
      workId: fixture.workId,
      chapterId: chapterA.chapterId,
      authorId: fixture.authorId,
      candidateId: candidateA,
    });
    expect(detailA.fact.decision).toBeNull();

    // 列表也按章节隔离
    const listA = await listChapterFacts({
      db,
      workId: fixture.workId,
      chapterId: chapterA.chapterId,
      authorId: fixture.authorId,
    });
    expect(listA.facts.map((fact) => fact.id)).toEqual([candidateA]);
    expect(listA.facts[0]?.decision).toBeNull();
  });
});

describe('只读与脱敏', () => {
  it('读取不写审计、不改 decision / candidate / run', async () => {
    const fixture = await newFixture();
    const seeded = await seedChapter(fixture);
    const candidateId = await addCandidate(fixture, seeded);
    await decide(fixture, candidateId, 'accepted');

    const snapshot = async () => ({
      audits: await db.auditLog.count({ where: { actorId: fixture.authorId } }),
      decisions: await db.chapterFactDecision.findMany({
        where: { workId: fixture.workId },
        orderBy: { id: 'asc' },
      }),
      candidates: await db.chapterFactCandidate.findMany({
        where: { workId: fixture.workId },
        orderBy: { id: 'asc' },
      }),
      runs: await db.chapterFactRun.findMany({
        where: { workId: fixture.workId },
        orderBy: { id: 'asc' },
      }),
    });

    const before = await snapshot();
    await list(fixture);
    await getChapterFactCandidate({
      db,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      candidateId,
    });
    const after = await snapshot();

    expect(after).toEqual(before);
  });

  it('视图只有固定字段：不含 decidedBy / payload / provider', async () => {
    const fixture = await newFixture();
    const seeded = await seedChapter(fixture);
    const candidateId = await addCandidate(fixture, seeded);
    await decide(fixture, candidateId, 'rejected');

    const result = await list(fixture);
    const fact = result.facts[0];
    expect(fact).toBeDefined();
    expect(Object.keys(fact ?? {}).sort()).toEqual(
      [
        'createdAt',
        'decision',
        'factType',
        'id',
        'name',
        'objectId',
        'reason',
        'runId',
        'sourceVersionId',
        'sourceVersionNo',
        'subjectId',
        'summary',
        'threadStatus',
      ].sort(),
    );
    expect(Object.keys(fact?.decision ?? {}).sort()).toEqual(['decidedAt', 'value']);
    expect(result.facts).toHaveLength(1);
    // summary / reason 本来就是 payload 的公开字段；这里断言的是
    // "没有额外的 payload 副本 / decidedBy / provider"。
    expect(Object.keys(fact ?? {})).not.toContain('payload');
    expect(JSON.stringify(fact?.decision)).not.toContain(MARKER);
    const text = JSON.stringify(result);
    expect(text).not.toContain('mock-model');
    expect(text).not.toContain('decidedBy');
    expect(text).not.toContain('decided_by');
  });
});

describe('异常值处理', () => {
  it('只接受 accepted / rejected；其它值或缺时间一律按未决定处理', () => {
    const decidedAt = new Date('2026-11-06T03:00:00.000Z');
    expect(toFactDecisionView('accepted', decidedAt)).toEqual({
      value: 'accepted',
      decidedAt: '2026-11-06T03:00:00.000Z',
    });
    expect(toFactDecisionView('rejected', decidedAt)?.value).toBe('rejected');
    expect(toFactDecisionView('maybe', decidedAt)).toBeNull();
    expect(toFactDecisionView('ACCEPTED', decidedAt)).toBeNull();
    expect(toFactDecisionView('', decidedAt)).toBeNull();
    expect(toFactDecisionView(null, decidedAt)).toBeNull();
    expect(toFactDecisionView('accepted', null)).toBeNull();
  });
});
