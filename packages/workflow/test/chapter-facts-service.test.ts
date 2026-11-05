/**
 * 连续性事实提取服务（A2-A / A2-A-REV-01）。
 *
 * 覆盖：
 * - 只允许定稿章节与当前最新版本；
 * - 成功时 run / 候选 / 审计的数量与字段；
 * - 同一版本幂等复用、并发只产生一个 run；
 * - **提交阶段二次校验**（模型调用期间的新 revision 必须被拒绝）；
 * - **候选与 run 的复合归属**（数据库层拒绝跨 run 组合）；
 * - **running 租约**（崩溃恢复、并发接管、只允许一个成功）；
 * - **重试元数据**（provider / model 以本次实际成功为准）；
 * - 失败不写半成品、可重试；
 * - 审计失败整体回滚；
 * - 正文与 secret 不进入数据库 / 模型输出摘要；
 * - 上下文按类型截断；
 * - 候选 append-only；不自动修改任何实体。
 */

import { randomUUID } from 'node:crypto';

import { AUDIT_ACTIONS, type AuthError } from '@novel/auth';
import type { PrismaClient } from '@novel/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  FACT_RUN_LEASE_MS,
  MAX_FACT_CONTEXT_ENTITIES,
  extractChapterFacts,
} from '../src/chapter/facts.js';
import { saveHumanChapterVersion } from '../src/chapter/human.js';
import type { ModelJsonInput, ModelProvider } from '../src/model-types.js';
import { createChapterFixture, lastUserContent, type ChapterFixture } from './helpers/chapter.js';
import { cleanupWork, closeTestDb, testDb } from './helpers/db.js';

let db: PrismaClient;
let fixtures: ChapterFixture[] = [];

const MARKER = '连续性机密';

interface StubProvider extends ModelProvider {
  readonly calls: ModelJsonInput[];
  /** 下一次 `generateJson` 的行为。 */
  mode: 'ok' | 'throw' | 'invalid';
}

function stubProvider(facts: unknown): StubProvider {
  const provider: StubProvider = {
    name: 'stub',
    defaultModel: 'stub-model',
    calls: [],
    mode: 'ok',
    async generateJson(input) {
      provider.calls.push(input);
      if (provider.mode === 'throw') {
        throw new Error('stub provider failure');
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

beforeAll(() => {
  db = testDb();
});

afterEach(async () => {
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_block_facts_audit_trigger ON audit_logs');
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_block_facts_audit()');
  for (const fixture of fixtures) {
    await cleanupWork(db, fixture.workId);
  }
  fixtures = [];
});

afterAll(async () => {
  await closeTestDb();
});

async function newFixture(): Promise<ChapterFixture> {
  const fixture = await createChapterFixture(db, { tag: `facts-${randomUUID().slice(0, 8)}` });
  fixtures.push(fixture);
  return fixture;
}

/** 插入一个 1200+ 字的正式版本并把章节定稿。 */
async function seedFinalizedVersion(
  fixture: ChapterFixture,
  versionNo = 1,
): Promise<{ versionId: string; content: string }> {
  const content = `${MARKER}-版本${versionNo}，${'雨落在青瓦上，他数着更声。'.repeat(120)}`;
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
  await db.chapter.update({ where: { id: fixture.chapterId }, data: { status: 'finalized' } });
  return { versionId: version.id, content };
}

function extract(
  fixture: ChapterFixture,
  provider: ModelProvider,
  options: { sourceVersionId?: string; workId?: string; chapterId?: string } = {},
) {
  return extractChapterFacts({
    db,
    provider,
    authorId: fixture.authorId,
    workId: options.workId ?? fixture.workId,
    chapterId: options.chapterId ?? fixture.chapterId,
    ...(options.sourceVersionId === undefined ? {} : { sourceVersionId: options.sourceVersionId }),
  });
}

function sampleFacts(fixture: ChapterFixture): unknown[] {
  const character = fixture.characters[0];
  return [
    {
      factType: 'character_state',
      subjectId: character?.id ?? '',
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
      factType: 'location_change',
      subjectId: character?.id ?? '',
      name: '后山灵泉',
      summary: '主角前往后山灵泉',
      reason: '正文写到他在泉边',
    },
  ];
}

async function runCount(workId: string): Promise<number> {
  return db.chapterFactRun.count({ where: { workId } });
}

async function candidateCount(workId: string): Promise<number> {
  return db.chapterFactCandidate.count({ where: { workId } });
}

async function factsAuditCount(chapterId: string): Promise<number> {
  return db.auditLog.count({
    where: { action: AUDIT_ACTIONS.CONTINUITY_FACTS_EXTRACTED, targetId: chapterId },
  });
}

describe('前置校验', () => {
  it('非定稿章节 → 409 CONTINUITY_CHAPTER_NOT_FINALIZED，不建 run', async () => {
    const fixture = await newFixture();
    const content = `${MARKER}，${'雨落在青瓦上。'.repeat(200)}`;
    await db.chapterVersion.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        versionNo: 1,
        content,
        wordCount: content.length,
        source: 'human',
        createdBy: fixture.authorId,
      },
    });

    await expect(extract(fixture, stubProvider([]))).rejects.toMatchObject({
      code: 'CONTINUITY_CHAPTER_NOT_FINALIZED',
    });
    expect(await runCount(fixture.workId)).toBe(0);
  });

  it('指定旧版本 → 409 CONTINUITY_SOURCE_VERSION_STALE', async () => {
    const fixture = await newFixture();
    const first = await seedFinalizedVersion(fixture, 1);
    // 追加版本 2 并保持定稿
    const content2 = `${MARKER}-版本2，${'风穿过廊下。'.repeat(220)}`;
    await db.chapterVersion.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        versionNo: 2,
        content: content2,
        wordCount: content2.length,
        source: 'human',
        createdBy: fixture.authorId,
      },
    });

    await expect(
      extract(fixture, stubProvider([]), { sourceVersionId: first.versionId }),
    ).rejects.toMatchObject({ code: 'CONTINUITY_SOURCE_VERSION_STALE' });
    expect(await runCount(fixture.workId)).toBe(0);
  });

  it('他人作品 → 404；章节不属于该作品 → 404', async () => {
    const fixture = await newFixture();
    const other = await newFixture();
    await seedFinalizedVersion(fixture);

    await expect(
      extractChapterFacts({
        db,
        provider: stubProvider([]),
        authorId: other.authorId,
        workId: fixture.workId,
        chapterId: fixture.chapterId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      extract(fixture, stubProvider([]), {
        workId: fixture.workId,
        chapterId: other.chapterId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('成功路径', () => {
  it('写入 run / 候选 / 审计，且正文不落库', async () => {
    const fixture = await newFixture();
    const { versionId } = await seedFinalizedVersion(fixture);
    const provider = stubProvider(sampleFacts(fixture));

    const result = await extract(fixture, provider);
    expect(result.created).toBe(true);
    expect(result.facts).toHaveLength(3);
    expect(result.factTypeCounts).toEqual({
      character_state: 1,
      plot_thread: 1,
      location_change: 1,
    });
    expect(result.sourceVersionId).toBe(versionId);
    expect(result.sourceVersionNo).toBe(1);

    expect(await runCount(fixture.workId)).toBe(1);
    expect(await candidateCount(fixture.workId)).toBe(3);

    const run = await db.chapterFactRun.findFirstOrThrow({ where: { workId: fixture.workId } });
    expect(run).toMatchObject({
      status: 'succeeded',
      agentName: 'continuity.extractor',
      agentVersion: '1.0.0',
      provider: 'stub',
      model: 'stub-model',
      sourceVersionId: versionId,
      errorCode: null,
    });
    expect(run.finishedAt).not.toBeNull();

    const candidates = await db.chapterFactCandidate.findMany({
      where: { workId: fixture.workId },
      orderBy: { createdAt: 'asc' },
    });
    expect(candidates.every((row) => row.status === 'candidate')).toBe(true);
    expect(candidates.every((row) => row.sourceVersionId === versionId)).toBe(true);

    const audits = await db.auditLog.findMany({
      where: { action: AUDIT_ACTIONS.CONTINUITY_FACTS_EXTRACTED, targetId: fixture.chapterId },
    });
    expect(audits).toHaveLength(1);
    const detail = audits[0]?.detail as unknown as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(
      [
        'agentName',
        'agentVersion',
        'chapterId',
        'factCount',
        'factTypeCounts',
        'model',
        'provider',
        'runId',
        'sourceVersionId',
        'workId',
      ].sort(),
    );
    expect(detail['factCount']).toBe(3);

    // 正文不进入 run / 候选 / 审计
    const dump = JSON.stringify({ run, candidates, detail });
    expect(dump).not.toContain(MARKER);
    // 候选 payload 也不含 prompt / 原始响应
    expect(dump).not.toContain('stub provider failure');
  });

  it('空事实：成功、0 候选、审计 factCount=0', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);

    const result = await extract(fixture, stubProvider([]));
    expect(result.created).toBe(true);
    expect(result.facts).toHaveLength(0);
    expect(result.factTypeCounts).toEqual({});
    expect(await candidateCount(fixture.workId)).toBe(0);
    expect(await factsAuditCount(fixture.chapterId)).toBe(1);
  });

  it('secret / secretKnownBy 不进入模型输入', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);
    const character = fixture.characters[0];
    expect(character).toBeDefined();
    await db.entityAttribute.create({
      data: {
        entityId: character?.id ?? '',
        attrKey: 'secret',
        attrValue: '他其实是前朝皇子',
        schemaRef: 'xuanhuan.character@1',
      },
    });

    const provider = stubProvider([]);
    await extract(fixture, provider);
    expect(provider.calls).toHaveLength(1);
    const sent = JSON.stringify(provider.calls[0]);
    expect(sent).not.toContain('他其实是前朝皇子');
    // 其它公开摘要仍应进入上下文
    expect(sent).toContain('character');
  });

  it('不自动修改任何实体（前后实体与版本数一致）', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);
    const before = {
      entities: await db.entity.count({ where: { workId: fixture.workId } }),
      versions: await db.entityVersion.count({
        where: { entity: { workId: fixture.workId } },
      }),
      itemEvents: await db.itemEvent.count({ where: { workId: fixture.workId } }),
    };

    await extract(fixture, stubProvider(sampleFacts(fixture)));

    const after = {
      entities: await db.entity.count({ where: { workId: fixture.workId } }),
      versions: await db.entityVersion.count({
        where: { entity: { workId: fixture.workId } },
      }),
      itemEvents: await db.itemEvent.count({ where: { workId: fixture.workId } }),
    };
    expect(after).toEqual(before);
  });
});

describe('幂等与并发', () => {
  it('同一版本重复提取 → 复用既有 run，不新增候选与审计', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);
    const provider = stubProvider(sampleFacts(fixture));

    const first = await extract(fixture, provider);
    expect(first.created).toBe(true);

    const second = await extract(fixture, stubProvider(sampleFacts(fixture)));
    expect(second.created).toBe(false);
    expect(second.runId).toBe(first.runId);
    expect(second.facts).toHaveLength(first.facts.length);
    expect(await runCount(fixture.workId)).toBe(1);
    expect(await candidateCount(fixture.workId)).toBe(3);
    expect(await factsAuditCount(fixture.chapterId)).toBe(1);
  });

  it('并发同版本只产生一个 run，候选不重复', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);

    const results = await Promise.allSettled([
      extract(fixture, stubProvider(sampleFacts(fixture))),
      extract(fixture, stubProvider(sampleFacts(fixture))),
      extract(fixture, stubProvider(sampleFacts(fixture))),
    ]);

    const fulfilled = results.filter(
      (item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof extract>>> =>
        item.status === 'fulfilled',
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(await runCount(fixture.workId)).toBe(1);
    expect(await candidateCount(fixture.workId)).toBe(3);
    expect(await factsAuditCount(fixture.chapterId)).toBe(1);

    for (const rejected of results.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    )) {
      expect(['CONTINUITY_EXTRACTION_IN_PROGRESS', 'CONTINUITY_SOURCE_VERSION_STALE']).toContain(
        (rejected.reason as AuthError).code,
      );
    }
  });
});

describe('失败与重试', () => {
  it('Provider 抛错 → run failed、无候选；重试复用同一 run 成功', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);
    const provider = stubProvider(sampleFacts(fixture));
    provider.mode = 'throw';

    await expect(extract(fixture, provider)).rejects.toMatchObject({
      code: 'CONTINUITY_EXTRACTION_FAILED',
    });
    expect(await candidateCount(fixture.workId)).toBe(0);
    const failed = await db.chapterFactRun.findFirstOrThrow({ where: { workId: fixture.workId } });
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('CONTINUITY_EXTRACTION_FAILED');

    provider.mode = 'ok';
    const retried = await extract(fixture, provider);
    expect(retried.created).toBe(true);
    expect(await runCount(fixture.workId)).toBe(1);
    expect(await candidateCount(fixture.workId)).toBe(3);
    const succeeded = await db.chapterFactRun.findFirstOrThrow({
      where: { workId: fixture.workId },
    });
    expect(succeeded.id).toBe(failed.id);
    expect(succeeded.status).toBe('succeeded');
    expect(succeeded.errorCode).toBeNull();
  });

  it('模型输出不合法 → CONTINUITY_FACTS_INVALID，不写候选，可重试', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);
    const provider = stubProvider([]);
    provider.mode = 'invalid';

    await expect(extract(fixture, provider)).rejects.toMatchObject({
      code: 'CONTINUITY_FACTS_INVALID',
    });
    expect(await candidateCount(fixture.workId)).toBe(0);
    expect(
      (await db.chapterFactRun.findFirstOrThrow({ where: { workId: fixture.workId } })).status,
    ).toBe('failed');

    provider.mode = 'ok';
    const retried = await extract(fixture, stubProvider(sampleFacts(fixture)));
    expect(retried.created).toBe(true);
    expect(await candidateCount(fixture.workId)).toBe(3);
  });

  it('未知人物 id → 不可重试错误，不写候选', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);
    const provider = stubProvider([
      {
        factType: 'character_state',
        subjectId: '99999999-9999-4999-8999-999999999999',
        summary: 'x',
        reason: 'y',
      },
    ]);

    await expect(extract(fixture, provider)).rejects.toMatchObject({
      code: 'CONTINUITY_FACTS_INVALID',
    });
    expect(await candidateCount(fixture.workId)).toBe(0);
  });

  it('审计写入失败 → 候选与 run 终态整体回滚，重试后成功', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_block_facts_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'continuity.facts_extracted' THEN
          RAISE EXCEPTION 'test: blocked facts audit';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER test_block_facts_audit_trigger
        BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION test_block_facts_audit()
    `);

    try {
      await expect(extract(fixture, stubProvider(sampleFacts(fixture)))).rejects.toMatchObject({
        code: 'CONTINUITY_EXTRACTION_FAILED',
      });
    } finally {
      await db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_block_facts_audit_trigger ON audit_logs',
      );
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_block_facts_audit()');
    }

    expect(await candidateCount(fixture.workId)).toBe(0);
    expect(
      (await db.chapterFactRun.findFirstOrThrow({ where: { workId: fixture.workId } })).status,
    ).toBe('failed');

    const retried = await extract(fixture, stubProvider(sampleFacts(fixture)));
    expect(retried.created).toBe(true);
    expect(await candidateCount(fixture.workId)).toBe(3);
    expect(await factsAuditCount(fixture.chapterId)).toBe(1);
  });
});

describe('数据库约束', () => {
  it('候选不可 UPDATE / DELETE（append-only）', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);
    await extract(fixture, stubProvider(sampleFacts(fixture)));
    const candidate = await db.chapterFactCandidate.findFirstOrThrow({
      where: { workId: fixture.workId },
    });

    await expect(
      db.chapterFactCandidate.update({
        where: { id: candidate.id },
        data: { status: 'candidate' },
      }),
    ).rejects.toThrow();
    await expect(db.chapterFactCandidate.delete({ where: { id: candidate.id } })).rejects.toThrow();
  });

  it('run 成功后不可再修改；DELETE 被拒绝', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);
    await extract(fixture, stubProvider(sampleFacts(fixture)));
    const run = await db.chapterFactRun.findFirstOrThrow({ where: { workId: fixture.workId } });

    await expect(
      db.chapterFactRun.update({ where: { id: run.id }, data: { status: 'failed' } }),
    ).rejects.toThrow();
    await expect(db.chapterFactRun.delete({ where: { id: run.id } })).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* A2-A-REV-01：提交阶段二次校验、复合归属、running 租约、重试元数据、上下文截断      */
/* -------------------------------------------------------------------------- */

/** 可挂起的 Provider：第一次调用进入后停住，由测试决定何时放行。 */
function gatedProvider(facts: unknown): {
  readonly provider: ModelProvider;
  readonly calls: ModelJsonInput[];
  /** 第一次 `generateJson` 已进入（此时 run 必定已是 running）。 */
  readonly entered: Promise<void>;
  release: () => void;
} {
  const calls: ModelJsonInput[] = [];
  let notifyEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    notifyEntered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;

  const provider: ModelProvider = {
    name: 'gated',
    defaultModel: 'gated-model',
    async generateJson(input) {
      calls.push(input);
      if (!started) {
        started = true;
        notifyEntered();
        await gate;
      }
      return {
        json: { facts },
        provider: 'gated',
        model: 'gated-model',
        usage: { promptTokens: 1, completionTokens: 1 },
        latencyMs: 1,
      };
    },
    async generateText() {
      throw new Error('未使用');
    },
  };

  return { provider, calls, entered, release };
}

/** 带身份与失败模式的 Provider（用于验证重试元数据）。 */
function identityProvider(input: {
  name: string;
  defaultModel: string;
  /** Provider 实际返回的 model（可以不同于 defaultModel）。 */
  actualModel: string;
  facts: unknown;
  mode: 'ok' | 'throw';
}): ModelProvider {
  return {
    name: input.name,
    defaultModel: input.defaultModel,
    async generateJson() {
      if (input.mode === 'throw') {
        throw new Error('stub provider failure');
      }
      return {
        json: { facts: input.facts },
        provider: input.name,
        model: input.actualModel,
        usage: { promptTokens: 1, completionTokens: 1 },
        latencyMs: 1,
      };
    },
    async generateText() {
      throw new Error('未使用');
    },
  };
}

/**
 * 直接插入一条 run（绕过服务层）。
 *
 * 用来模拟「进程崩溃留下的 running」：INSERT 不触发 run 的状态触发器，
 * 因此可以指定过去的 `started_at`。
 */
async function insertRun(input: {
  workId: string;
  chapterId: string;
  sourceVersionId: string;
  provider?: string;
  model?: string;
  /** 相对当前时间的偏移（负数表示过去）。 */
  startedAtOffsetMs?: number;
}): Promise<string> {
  const id = randomUUID();
  const offset = input.startedAtOffsetMs ?? 0;
  await db.$executeRaw`
    INSERT INTO "chapter_fact_runs"
      ("id", "work_id", "chapter_id", "source_version_id",
       "agent_name", "agent_version", "provider", "model", "status", "started_at")
    VALUES (
      ${id}::uuid, ${input.workId}::uuid, ${input.chapterId}::uuid, ${input.sourceVersionId}::uuid,
      'continuity.extractor', '1.0.0',
      ${input.provider ?? 'crashed'}, ${input.model ?? 'crashed-model'}, 'running',
      clock_timestamp() + (${offset}::int * interval '1 millisecond')
    )
  `;
  return id;
}

/** 直接用 raw SQL 插候选（绕过服务层与 Prisma 模型，验证数据库约束）。 */
async function rawInsertCandidate(input: {
  runId: string;
  workId: string;
  chapterId: string;
  sourceVersionId: string;
}): Promise<number> {
  return db.$executeRawUnsafe(
    `INSERT INTO "chapter_fact_candidates"
       ("id", "run_id", "work_id", "chapter_id", "source_version_id", "fact_type", "payload")
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'plot_thread', $6::jsonb)`,
    randomUUID(),
    input.runId,
    input.workId,
    input.chapterId,
    input.sourceVersionId,
    JSON.stringify({ factType: 'plot_thread', summary: '线索', reason: '依据' }),
  );
}

describe('提交阶段二次校验（A2-A-REV-01）', () => {
  it('模型调用期间保存新 revision → STALE，且无候选 / 无成功审计', async () => {
    const fixture = await newFixture();
    const { versionId } = await seedFinalizedVersion(fixture);
    const gated = gatedProvider(sampleFacts(fixture));

    const pending = extract(fixture, gated.provider);
    await gated.entered;

    const running = await db.chapterFactRun.findFirstOrThrow({
      where: { workId: fixture.workId },
    });
    expect(running.status).toBe('running');

    // 作者在模型调用期间保存 revision：章节回到 in_review，并产生新的最新版本
    const saved = await saveHumanChapterVersion({
      db,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      content: `${MARKER}-修订，${'雪落在剑鞘上。'.repeat(200)}`,
      baseVersionId: versionId,
    });
    expect(saved.versionNo).toBe(2);

    gated.release();
    await expect(pending).rejects.toMatchObject({ code: 'CONTINUITY_SOURCE_VERSION_STALE' });

    // 事务回滚：没有候选、没有成功 run、没有成功审计
    expect(await candidateCount(fixture.workId)).toBe(0);
    expect(
      await db.chapterFactRun.count({ where: { workId: fixture.workId, status: 'succeeded' } }),
    ).toBe(0);
    expect(await factsAuditCount(fixture.chapterId)).toBe(0);

    const failed = await db.chapterFactRun.findFirstOrThrow({ where: { workId: fixture.workId } });
    expect(failed.id).toBe(running.id);
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('CONTINUITY_SOURCE_VERSION_STALE');

    // 新版本重新定稿后再次提取：走**新的 run**
    await db.chapter.update({ where: { id: fixture.chapterId }, data: { status: 'finalized' } });
    const retried = await extract(fixture, stubProvider(sampleFacts(fixture)));
    expect(retried.created).toBe(true);
    expect(retried.runId).not.toBe(failed.id);
    expect(retried.sourceVersionId).toBe(saved.versionId);
    expect(await candidateCount(fixture.workId)).toBe(3);
    expect(await runCount(fixture.workId)).toBe(2);
  });
});

describe('候选与 run 的复合归属（A2-A-REV-01）', () => {
  it('run 与 work / chapter / version 不一致的候选被数据库拒绝', async () => {
    const fixture = await newFixture();
    const first = await seedFinalizedVersion(fixture, 1);
    const content2 = `${MARKER}-版本2，${'风穿过廊下。'.repeat(220)}`;
    const second = await db.chapterVersion.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        versionNo: 2,
        content: content2,
        wordCount: content2.length,
        source: 'human',
        createdBy: fixture.authorId,
      },
      select: { id: true },
    });

    // run 指向版本 1
    const runId = await insertRun({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: first.versionId,
    });

    // 候选挂在 run 上，却把 version 指向版本 2（本身是合法的章节 / 作品 / 版本组合，
    // 因此只有复合 run 外键能拒绝它 —— 证明不是服务层拦截）。
    const error = await rawInsertCandidate({
      runId,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: second.id,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(/chapter_fact_candidates_run_fkey|23503/);
    expect(await candidateCount(fixture.workId)).toBe(0);

    // 与 run 完全一致时正常插入
    const inserted = await rawInsertCandidate({
      runId,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: first.versionId,
    });
    expect(inserted).toBe(1);
    expect(await candidateCount(fixture.workId)).toBe(1);
  });
});

describe('running 租约与恢复（A2-A-REV-01）', () => {
  it('租约未到期 → 409 CONTINUITY_EXTRACTION_IN_PROGRESS', async () => {
    const fixture = await newFixture();
    const { versionId } = await seedFinalizedVersion(fixture);
    await insertRun({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: versionId,
      startedAtOffsetMs: 0,
    });

    await expect(extract(fixture, stubProvider([]))).rejects.toMatchObject({
      code: 'CONTINUITY_EXTRACTION_IN_PROGRESS',
    });
    expect(await candidateCount(fixture.workId)).toBe(0);
    // 未到期的 running 不会被改写
    const run = await db.chapterFactRun.findFirstOrThrow({ where: { workId: fixture.workId } });
    expect(run.status).toBe('running');
  });

  it('租约已到期 → 接管同一条 run（不产生第二条）并成功', async () => {
    const fixture = await newFixture();
    const { versionId } = await seedFinalizedVersion(fixture);
    const runId = await insertRun({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: versionId,
      provider: 'crashed',
      model: 'crashed-model',
      startedAtOffsetMs: -(FACT_RUN_LEASE_MS + 60_000),
    });

    const result = await extract(fixture, stubProvider(sampleFacts(fixture)));
    expect(result.created).toBe(true);
    expect(result.runId).toBe(runId);
    expect(await runCount(fixture.workId)).toBe(1);
    expect(await candidateCount(fixture.workId)).toBe(3);

    const run = await db.chapterFactRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('succeeded');
    expect(run.errorCode).toBeNull();
    // started_at 被刷新为本次尝试的开始时间
    expect(run.startedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('两个并发接管只允许一个成功', async () => {
    const fixture = await newFixture();
    const { versionId } = await seedFinalizedVersion(fixture);
    const runId = await insertRun({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: versionId,
      startedAtOffsetMs: -(FACT_RUN_LEASE_MS + 60_000),
    });

    const gated = gatedProvider(sampleFacts(fixture));
    const outcomes: string[] = [];
    const track = (promise: Promise<unknown>): Promise<void> =>
      promise.then(
        () => {
          outcomes.push('ok');
        },
        (error: unknown) => {
          outcomes.push((error as AuthError).code);
        },
      );

    const first = track(extract(fixture, gated.provider));
    const second = track(extract(fixture, gated.provider));

    // 一个请求已接管并进入模型；另一个必然在准备阶段被拒
    await gated.entered;
    await expect.poll(() => outcomes.length, { timeout: 10_000 }).toBe(1);
    gated.release();
    await Promise.all([first, second]);

    expect(outcomes.filter((item) => item === 'ok')).toHaveLength(1);
    expect(outcomes.filter((item) => item === 'CONTINUITY_EXTRACTION_IN_PROGRESS')).toHaveLength(1);
    // 租约接管复用同一行，不产生第二个 run
    expect(await runCount(fixture.workId)).toBe(1);
    expect(await db.chapterFactRun.count({ where: { workId: fixture.workId, id: runId } })).toBe(1);
    expect(await candidateCount(fixture.workId)).toBe(3);
    expect(await factsAuditCount(fixture.chapterId)).toBe(1);
  });
});

describe('重试元数据（A2-A-REV-01）', () => {
  it('第二次尝试成功后，run 与审计记录第二次的 provider / model', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);

    await expect(
      extract(
        fixture,
        identityProvider({
          name: 'provider-a',
          defaultModel: 'model-a',
          actualModel: 'model-a',
          facts: sampleFacts(fixture),
          mode: 'throw',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONTINUITY_EXTRACTION_FAILED' });

    const afterFirst = await db.chapterFactRun.findFirstOrThrow({
      where: { workId: fixture.workId },
    });
    expect(afterFirst).toMatchObject({
      status: 'failed',
      provider: 'provider-a',
      model: 'model-a',
    });
    const firstStartedAt = afterFirst.startedAt.getTime();

    // 第二次：provider / 默认 model 都换了，且 Provider 实际返回的 model 又不同
    const result = await extract(
      fixture,
      identityProvider({
        name: 'provider-b',
        defaultModel: 'default-b',
        actualModel: 'model-b-actual',
        facts: sampleFacts(fixture),
        mode: 'ok',
      }),
    );
    expect(result.created).toBe(true);
    expect(result.provider).toBe('provider-b');
    expect(result.model).toBe('model-b-actual');

    const afterSecond = await db.chapterFactRun.findFirstOrThrow({
      where: { workId: fixture.workId },
    });
    expect(afterSecond.id).toBe(afterFirst.id);
    expect(afterSecond.status).toBe('succeeded');
    // 以实际返回的 model 落库，不沿用第一次失败 attempt 的配置
    expect(afterSecond.provider).toBe('provider-b');
    expect(afterSecond.model).toBe('model-b-actual');
    // 重试刷新了本次尝试的开始时间
    expect(afterSecond.startedAt.getTime()).toBeGreaterThanOrEqual(firstStartedAt);

    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.CONTINUITY_FACTS_EXTRACTED, targetId: fixture.chapterId },
    });
    expect(audit.detail).toMatchObject({ provider: 'provider-b', model: 'model-b-actual' });
  });
});

describe('上下文截断（A2-A-REV-01）', () => {
  it('每类实体独立上限：人物过多也不会挤掉物品与势力', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);

    // 420 个人物（orderIndex 很小），物品 / 势力 orderIndex 很大：
    // 旧的「全局 take 后按类型切」会在这里把物品与势力整类丢掉。
    await db.entity.createMany({
      data: Array.from({ length: 420 }, (_, index) => ({
        workId: fixture.workId,
        entityType: 'character',
        name: `群演-${fixture.tag}-${String(index).padStart(3, '0')}`,
        orderIndex: 10 + index,
      })),
    });
    const item = await db.entity.create({
      data: {
        workId: fixture.workId,
        entityType: 'item',
        name: `玄铁剑-${fixture.tag}`,
        orderIndex: 9000,
      },
      select: { id: true, name: true },
    });
    const faction = await db.entity.create({
      data: {
        workId: fixture.workId,
        entityType: 'faction',
        name: `血月教-${fixture.tag}`,
        orderIndex: 9001,
      },
      select: { id: true, name: true },
    });

    const provider = stubProvider([]);
    await extract(fixture, provider);
    expect(provider.calls).toHaveLength(1);
    const sent = JSON.parse(lastUserContent(provider.calls[0] as ModelJsonInput)) as {
      characters: { id: string; name: string }[];
      items: { id: string; name: string }[];
      realms: { id: string; name: string }[];
      factions: { id: string; name: string }[];
    };

    // 人物被截断到上限，物品 / 势力仍然完整出现
    expect(sent.characters).toHaveLength(MAX_FACT_CONTEXT_ENTITIES);
    expect(sent.items.map((entity) => entity.name)).toContain(item.name);
    expect(sent.factions.map((entity) => entity.name)).toContain(faction.name);
    expect(sent.realms.length).toBe(fixture.realms.length);
    expect(sent.characters.every((entity) => entity.id !== item.id)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* A2-A-REV-02：attempt fencing（租约 + attempt_token 双层）                     */
/* -------------------------------------------------------------------------- */

interface AttemptPlan {
  readonly facts: unknown;
  /** 该 attempt 的 Provider 返回身份（用于验证不被旧 attempt 覆盖）。 */
  readonly provider?: string;
  readonly model?: string;
  /** 该 attempt 直接抛错（模拟模型失败）。 */
  readonly fail?: boolean;
}

/** 按调用顺序分派的 Provider：每次调用各自挂起，由测试逐个放行。 */
function sequencedProvider(plans: readonly AttemptPlan[]): {
  readonly provider: ModelProvider;
  readonly waitEntered: (index: number) => Promise<void>;
  readonly release: (index: number) => void;
} {
  let cursor = 0;
  const gates = plans.map(() => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  });
  const entered = plans.map(() => {
    let notify!: () => void;
    const promise = new Promise<void>((resolve) => {
      notify = resolve;
    });
    return { promise, notify };
  });

  const provider: ModelProvider = {
    name: 'gated',
    defaultModel: 'gated-model',
    async generateJson() {
      const index = cursor;
      cursor += 1;
      const plan = plans[index];
      entered[index]?.notify();
      await gates[index]?.promise;
      if (plan?.fail === true) {
        throw new Error('stub provider failure');
      }
      return {
        json: { facts: plan?.facts ?? [] },
        provider: plan?.provider ?? 'gated',
        model: plan?.model ?? 'gated-model',
        usage: { promptTokens: 1, completionTokens: 1 },
        latencyMs: 1,
      };
    },
    async generateText() {
      throw new Error('未使用');
    },
  };

  return {
    provider,
    waitEntered: async (index) => {
      await entered[index]?.promise;
    },
    release: (index) => {
      gates[index]?.release();
    },
  };
}

/**
 * 把本次尝试推到租约之外（模拟"进程卡住 / 崩溃"）。
 *
 * 触发器只允许在重试时刷新 `started_at`，因此夹具必须临时关闭用户触发器；
 * 这是测试夹具手段，不是应用路径。
 */
async function expireRunLease(runId: string): Promise<void> {
  await db.$executeRawUnsafe('ALTER TABLE chapter_fact_runs DISABLE TRIGGER USER');
  try {
    await db.$executeRaw`
      UPDATE "chapter_fact_runs"
      SET "started_at" = clock_timestamp() - (${FACT_RUN_LEASE_MS + 60_000}::int * interval '1 millisecond')
      WHERE "id" = ${runId}::uuid
    `;
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE chapter_fact_runs ENABLE TRIGGER USER');
  }
}

async function currentRun(fixture: ChapterFixture) {
  return db.chapterFactRun.findFirstOrThrow({ where: { workId: fixture.workId } });
}

describe('attempt fencing（A2-A-REV-02）', () => {
  it('旧 attempt 成功返回被拒绝：不写候选 / 审计，不覆盖新 attempt', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);
    const character = fixture.characters[0];
    const factsB = sampleFacts(fixture);
    const gated = sequencedProvider([
      {
        facts: [
          {
            factType: 'character_state',
            subjectId: character?.id ?? '',
            summary: '旧尝试的事实',
            reason: '旧依据',
          },
        ],
        provider: 'stub-a',
        model: 'model-a',
      },
      { facts: factsB, provider: 'stub-b', model: 'model-b' },
    ]);

    // A：创建 running attempt 并进入模型
    const attemptA = extract(fixture, gated.provider);
    await gated.waitEntered(0);
    const runA = await currentRun(fixture);
    expect(runA.status).toBe('running');
    const tokenA = runA.attemptToken;

    // 租约到期 → B 接管同一 run，拿到新的 attempt_token
    await expireRunLease(runA.id);
    const attemptB = extract(fixture, gated.provider);
    await gated.waitEntered(1);
    const runB = await currentRun(fixture);
    expect(runB.id).toBe(runA.id);
    expect(runB.status).toBe('running');
    expect(runB.attemptToken).not.toBe(tokenA);

    // 旧 A 先成功返回：必须被 fence 掉
    gated.release(0);
    await expect(attemptA).rejects.toMatchObject({
      code: 'CONTINUITY_EXTRACTION_LEASE_LOST',
    });

    expect(await candidateCount(fixture.workId)).toBe(0);
    expect(await factsAuditCount(fixture.chapterId)).toBe(0);
    const afterA = await currentRun(fixture);
    expect(afterA.status).toBe('running');
    expect(afterA.attemptToken).toBe(runB.attemptToken);
    // 旧 attempt 不得覆盖 provider / model（仍是 B 的配置值）
    expect(afterA.provider).toBe('gated');
    expect(afterA.model).toBe('gated-model');

    // B 正常完成：候选与审计只来自 B
    gated.release(1);
    const resultB = await attemptB;
    expect(resultB.created).toBe(true);
    expect(resultB.provider).toBe('stub-b');
    expect(resultB.model).toBe('model-b');

    const finalRun = await currentRun(fixture);
    expect(finalRun.status).toBe('succeeded');
    expect(finalRun.provider).toBe('stub-b');
    expect(finalRun.model).toBe('model-b');
    expect(await candidateCount(fixture.workId)).toBe(factsB.length);
    expect(await factsAuditCount(fixture.chapterId)).toBe(1);

    const candidates = await db.chapterFactCandidate.findMany({
      where: { workId: fixture.workId },
    });
    const dump = JSON.stringify(candidates);
    expect(dump).not.toContain('旧尝试的事实');
  });

  it('旧 attempt 抛错不能杀死新 attempt', async () => {
    const fixture = await newFixture();
    await seedFinalizedVersion(fixture);
    const gated = sequencedProvider([
      { facts: [], fail: true },
      { facts: sampleFacts(fixture), provider: 'stub-b', model: 'model-b' },
    ]);

    const attemptA = extract(fixture, gated.provider);
    await gated.waitEntered(0);
    const runA = await currentRun(fixture);
    await expireRunLease(runA.id);

    const attemptB = extract(fixture, gated.provider);
    await gated.waitEntered(1);
    const runB = await currentRun(fixture);
    const tokenB = runB.attemptToken;
    expect(tokenB).not.toBe(runA.attemptToken);

    // A 的 Provider 抛错：markRunFailed 必须因 token 不匹配而 0 行
    gated.release(0);
    await expect(attemptA).rejects.toMatchObject({
      code: 'CONTINUITY_EXTRACTION_LEASE_LOST',
    });

    const afterA = await currentRun(fixture);
    expect(afterA.status).toBe('running');
    expect(afterA.attemptToken).toBe(tokenB);
    expect(afterA.errorCode).toBeNull();

    // B 不受影响，仍然成功
    gated.release(1);
    await expect(attemptB).resolves.toMatchObject({ created: true, provider: 'stub-b' });
    const finalRun = await currentRun(fixture);
    expect(finalRun.status).toBe('succeeded');
    expect(finalRun.attemptToken).toBe(tokenB);
    expect(await factsAuditCount(fixture.chapterId)).toBe(1);
    expect(await candidateCount(fixture.workId)).toBe(3);
    expect(await runCount(fixture.workId)).toBe(1);
  });

  it('attempt_token 数据库约束：新建必有、重试必换、成功不可改', async () => {
    const fixture = await newFixture();
    const first = await seedFinalizedVersion(fixture, 1);
    const content2 = `${MARKER}-版本2，${'风穿过廊下。'.repeat(220)}`;
    const second = await db.chapterVersion.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        versionNo: 2,
        content: content2,
        wordCount: content2.length,
        source: 'human',
        createdBy: fixture.authorId,
      },
      select: { id: true },
    });

    // 新建：不传 attempt_token，由数据库默认生成
    const run = await db.chapterFactRun.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        sourceVersionId: first.versionId,
        agentName: 'continuity.extractor',
        agentVersion: '1.0.0',
        provider: 'p',
        model: 'm',
        status: 'running',
      },
    });
    expect(run.attemptToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // 复合 run 外键仍然生效：版本不一致的候选被拒绝
    const mismatchBefore = await rawInsertCandidate({
      runId: run.id,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: second.id,
    }).catch((caught: unknown) => caught);
    expect(String((mismatchBefore as Error).message)).toMatch(/23503/);

    // 结束第一次尝试
    await db.$executeRaw`
      UPDATE "chapter_fact_runs"
      SET "status" = 'failed',
          "error_code" = 'CONTINUITY_EXTRACTION_FAILED',
          "finished_at" = clock_timestamp()
      WHERE "id" = ${run.id}::uuid
    `;

    // failed → running 必须轮换 token：沿用旧 token 被触发器拒绝
    const sameToken = await db.$executeRaw`
      UPDATE "chapter_fact_runs"
      SET "status" = 'running',
          "error_code" = NULL,
          "finished_at" = NULL,
          "started_at" = clock_timestamp(),
          "attempt_token" = ${run.attemptToken}::uuid
      WHERE "id" = ${run.id}::uuid
    `.catch((caught: unknown) => caught);
    expect(sameToken).toBeInstanceOf(Error);
    expect((await currentRun(fixture)).status).toBe('failed');

    // 轮换后允许重试
    const rotated = await db.$executeRaw`
      UPDATE "chapter_fact_runs"
      SET "status" = 'running',
          "error_code" = NULL,
          "finished_at" = NULL,
          "started_at" = clock_timestamp(),
          "attempt_token" = gen_random_uuid()
      WHERE "id" = ${run.id}::uuid
    `;
    expect(rotated).toBe(1);
    const afterRetry = await currentRun(fixture);
    expect(afterRetry.status).toBe('running');
    expect(afterRetry.attemptToken).not.toBe(run.attemptToken);

    // 换 token 之后，复合外键约束依旧生效
    const mismatchAfter = await rawInsertCandidate({
      runId: run.id,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: second.id,
    }).catch((caught: unknown) => caught);
    expect(String((mismatchAfter as Error).message)).toMatch(/23503/);
    const matched = await rawInsertCandidate({
      runId: run.id,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: first.versionId,
    });
    expect(matched).toBe(1);

    // running → succeeded 不允许同时改 token
    const tokenOnSuccess = await db.$executeRaw`
      UPDATE "chapter_fact_runs"
      SET "status" = 'succeeded',
          "finished_at" = clock_timestamp(),
          "attempt_token" = gen_random_uuid()
      WHERE "id" = ${run.id}::uuid
    `.catch((caught: unknown) => caught);
    expect(tokenOnSuccess).toBeInstanceOf(Error);

    const succeeded = await db.$executeRaw`
      UPDATE "chapter_fact_runs"
      SET "status" = 'succeeded', "finished_at" = clock_timestamp()
      WHERE "id" = ${run.id}::uuid
    `;
    expect(succeeded).toBe(1);
    const succeededRow = await currentRun(fixture);
    expect(succeededRow.attemptToken).toBe(afterRetry.attemptToken);

    // succeeded 之后不可修改（含尝试改 token）
    const afterSuccess = await db.$executeRaw`
      UPDATE "chapter_fact_runs"
      SET "attempt_token" = gen_random_uuid()
      WHERE "id" = ${run.id}::uuid
    `.catch((caught: unknown) => caught);
    expect(afterSuccess).toBeInstanceOf(Error);
  });
});
