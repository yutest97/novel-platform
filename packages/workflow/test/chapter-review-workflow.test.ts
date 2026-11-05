/**
 * 章节候选审阅工作流（A2-C-B）。
 *
 * 使用真实 PostgreSQL + MockProvider + WorkerRunner，不接 HTTP / UI。
 * 覆盖：自动入队与任务输入边界、默认 Mock 成功、问题落库与归属约束、
 * 非法输出 / Provider 失败 / 重试复用、旧 Worker 与取消隔离、
 * 上下文安全（secret / 上限 / 排序 / priorSummaries）、LLM 日志、
 * 章节详情与列表不被审阅任务污染、以及数据库层面的不可变约束。
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@novel/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createChapterMockProvider } from '../src/chapter/mock.js';
import { normalizePlannerOutput, prepareDraftText } from '../src/chapter/agents.js';
import { freezeChapterContract, persistChapterCandidate } from '../src/chapter/persistence.js';
import {
  buildChapterReviewContext,
  getReviewRunByTaskId,
  parseChapterReviewTaskInput,
  persistReviewResult,
  prepareReviewRun,
  type ReviewTaskFence,
} from '../src/chapter/review.js';
import { saveHumanChapterVersion } from '../src/chapter/human.js';
import { createChapterReviewWorkflow } from '../src/chapter/review-workflow.js';
import {
  CHAPTER_REVIEW_ISSUE_TYPES,
  REVIEWER_CHAPTER_AGENT,
  type ChapterReviewIssue,
} from '../src/chapter/reviewer.js';
import { getChapterDetail, listChapters } from '../src/chapter/service.js';
import { CHAPTER_DRAFT_TASK_TYPE, CHAPTER_REVIEW_TASK_TYPE } from '../src/chapter/types.js';
import { createChapterDraftWorkflow } from '../src/chapter/workflow.js';
import { WorkflowKernel, WorkflowRegistry } from '../src/kernel.js';
import { ModelProviderError, type ModelJsonInput, type ModelProvider } from '../src/model-types.js';
import {
  claimNextTask,
  completeTask,
  createGenerationTask,
  DEFAULT_MAX_ATTEMPTS,
  failTask,
  requestTaskCancellationForAuthor,
  listTaskContexts,
} from '../src/queue.js';
import { WorkerRunner } from '../src/worker.js';
import {
  addCharacters,
  createChapterFixture,
  createChapterProvider,
  defaultPlannerOutput,
  lastUserContent,
  longDraft,
  type ChapterFixture,
  type ChapterProvider,
  type ChapterProviderHandlers,
} from './helpers/chapter.js';
import { cleanupWork, closeTestDb, silentLogger, testDb } from './helpers/db.js';

let db: PrismaClient;
let fixtures: ChapterFixture[] = [];

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

async function newFixture(tag?: string): Promise<ChapterFixture> {
  const fixture = await createChapterFixture(db, tag === undefined ? {} : { tag });
  fixtures.push(fixture);
  return fixture;
}

/** 生产装配的镜像：同一个 Worker 同时注册 draft 与 review。 */
function runnerFor(provider: ModelProvider): WorkerRunner {
  const registry = new WorkflowRegistry();
  registry.register(createChapterDraftWorkflow({ db, provider }));
  registry.register(createChapterReviewWorkflow({ db, provider }));
  return new WorkerRunner(db, new WorkflowKernel(registry), {
    provider,
    workerId: 'review-worker',
    leaseMs: 5_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 10,
    sweepIntervalMs: 10,
    logger: silentLogger,
  });
}

async function createDraftTask(fixture: ChapterFixture) {
  return createGenerationTask(db, {
    authorId: fixture.authorId,
    workId: fixture.workId,
    chapterId: fixture.chapterId,
    requestId: `req-${randomUUID()}`,
    taskType: CHAPTER_DRAFT_TASK_TYPE,
    inputSnapshot: { targetWords: 3000 },
    provider: 'mock',
    model: 'mock-model',
    maxAttempts: 3,
  });
}

interface DraftedFixture {
  readonly candidateId: string;
  readonly candidateContent: string;
  readonly draftTaskId: string;
  readonly reviewTaskId: string;
  readonly provider: ChapterProvider;
}

/**
 * 跑完一次正文生成，返回候选与随之入队的审阅任务。
 *
 * plan 在 fixture 建好之后才能确定，因此这里延迟构造 provider。
 */
async function draftCandidate(
  fixture: ChapterFixture,
  handlers: ChapterProviderHandlers = {},
  draft = longDraft(),
): Promise<DraftedFixture> {
  const provider = createChapterProvider(handlers, {
    plan: defaultPlannerOutput(fixture),
    text: draft,
  });
  const { task } = await createDraftTask(fixture);
  await expect(runnerFor(provider.provider).runOnce()).resolves.toBe('succeeded');

  const candidate = await db.chapterCandidate.findUniqueOrThrow({
    where: { generationTaskId: task.id },
  });
  const reviewTask = await db.generationTask.findUniqueOrThrow({
    where: {
      workId_requestId: { workId: fixture.workId, requestId: `review:${candidate.id}` },
    },
  });
  return {
    candidateId: candidate.id,
    candidateContent: candidate.content,
    draftTaskId: task.id,
    reviewTaskId: reviewTask.id,
    provider,
  };
}

async function reviewTaskRow(taskId: string) {
  return db.generationTask.findUniqueOrThrow({ where: { id: taskId } });
}

function fenceFor(input: {
  readonly reviewTaskId: string;
  readonly workId: string;
  readonly chapterId: string;
  readonly candidateId: string;
  readonly workerId: string;
}): ReviewTaskFence {
  return {
    taskId: input.reviewTaskId,
    workId: input.workId,
    chapterId: input.chapterId,
    candidateId: input.candidateId,
    workerId: input.workerId,
  };
}

/** 从正文里取若干互不相同的片段，作为合法的 evidence。 */
function evidenceSlices(draft: string, count: number): string[] {
  const slices: string[] = [];
  const step = Math.max(1, Math.floor(draft.length / (count + 2)));
  for (let index = 0; index < count; index += 1) {
    const raw = draft.slice(index * step, index * step + 12).trim();
    const text = raw === '' ? draft.slice(0, 12) : raw;
    slices.push(text);
  }
  return slices;
}

describe('自动入队与任务输入边界', () => {
  it('Writer 候选保存后自动创建唯一的 chapter.review 任务', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);

    const reviewTasks = await db.generationTask.findMany({
      where: { chapterId: fixture.chapterId, taskType: CHAPTER_REVIEW_TASK_TYPE },
    });
    expect(reviewTasks).toHaveLength(1);

    const row = reviewTasks[0];
    expect(row?.id).toBe(drafted.reviewTaskId);
    expect(row).toMatchObject({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      requestId: `review:${drafted.candidateId}`,
      taskType: CHAPTER_REVIEW_TASK_TYPE,
      status: 'queued',
      attemptCount: 0,
      lockedBy: null,
      provider: 'mock',
      model: 'mock-model',
    });
    expect(row?.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(row?.requestId.length).toBeLessThanOrEqual(128);
    expect(row?.inputHash).toMatch(/^[0-9a-f]{64}$/);

    // 正文任务仍然成功结束：审阅只是另一个任务
    const draftTask = await reviewTaskRow(drafted.draftTaskId);
    expect(draftTask.status).toBe('succeeded');
    expect(draftTask.currentStep).toBe('persist_candidate');

    // 候选本身未被审阅影响
    const candidate = await db.chapterCandidate.findUniqueOrThrow({
      where: { id: drafted.candidateId },
    });
    expect(candidate.status).toBe('candidate');
  });

  it('任务输入只有 candidateId，不含正文 / prompt / evidence', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);
    const row = await reviewTaskRow(drafted.reviewTaskId);

    expect(row.inputSnapshot).toEqual({ candidateId: drafted.candidateId });
    const serialized = JSON.stringify(row.inputSnapshot);
    expect(serialized).not.toContain(drafted.candidateContent.slice(0, 24));
    expect(serialized.toLowerCase()).not.toContain('prompt');
    expect(serialized).not.toContain('evidence');
    expect(serialized).not.toContain('draft');
  });

  it('未知字段 / 非 UUID / 缺少 candidateId 一律拒绝', () => {
    expect(() => parseChapterReviewTaskInput({ candidateId: 'not-a-uuid' })).toThrow(/candidateId/);
    expect(() => parseChapterReviewTaskInput({})).toThrow(/candidateId/);
    expect(() => parseChapterReviewTaskInput({ candidateId: randomUUID(), extra: 1 })).toThrow(
      /不支持的输入字段/,
    );
    expect(() => parseChapterReviewTaskInput([])).toThrow(/对象/);
    const id = randomUUID();
    expect(parseChapterReviewTaskInput({ candidateId: id })).toEqual({ candidateId: id });
  });

  it('已有候选时复盘不会重复入队；任务被删掉（崩溃恢复）会补齐一次', async () => {
    const fixture = await newFixture();
    const { task } = await createDraftTask(fixture);
    const claimed = await claimNextTask(db, { workerId: 'manual-worker', leaseMs: 5_000 });
    expect(claimed?.id).toBe(task.id);

    const plan = defaultPlannerOutput(fixture);
    const fence = {
      taskId: task.id,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      workerId: 'manual-worker',
      authorId: fixture.authorId,
    };
    const normalized = normalizePlannerOutput(plan as never, {
      allowedCharacters: fixture.characters.map((entity) => entity.name),
      targetWords: 3000,
    });
    const contract = await freezeChapterContract({ db, fence, plan: normalized });
    const input = {
      db,
      fence,
      contract,
      draft: prepareDraftText(longDraft()),
      plan: normalized,
      review: { provider: 'mock', model: 'mock-model' },
    };

    const first = await persistChapterCandidate(input);
    expect(await db.generationTask.count({ where: { chapterId: fixture.chapterId } })).toBe(2);

    // 重复调用：命中已有候选分支，review task 不重复创建
    await persistChapterCandidate(input);
    const reviewAfter = await db.generationTask.findMany({
      where: { chapterId: fixture.chapterId, taskType: CHAPTER_REVIEW_TASK_TYPE },
    });
    expect(reviewAfter).toHaveLength(1);

    // 崩溃恢复：候选存在但任务缺失 → 同一事务内补齐，且只补一次
    await db.generationTask.delete({ where: { id: reviewAfter[0]?.id ?? '' } });
    await persistChapterCandidate(input);
    const recovered = await db.generationTask.findMany({
      where: { chapterId: fixture.chapterId, taskType: CHAPTER_REVIEW_TASK_TYPE },
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.inputSnapshot).toEqual({ candidateId: first.id });
  });
});

describe('审阅运行与问题落库', () => {
  it('默认 Mock 审阅成功：run succeeded、passed=true、issue_count=0', async () => {
    const fixture = await newFixture();
    // 生产 Mock：planner / writer / reviewer 都由 createChapterMockProvider 分派
    const provider = createChapterMockProvider();
    const { task } = await createDraftTask(fixture);
    const runner = runnerFor(provider);

    await expect(runner.runOnce()).resolves.toBe('succeeded');
    await expect(runner.runOnce()).resolves.toBe('succeeded');

    const candidate = await db.chapterCandidate.findUniqueOrThrow({
      where: { generationTaskId: task.id },
    });
    const reviewTask = await db.generationTask.findUniqueOrThrow({
      where: {
        workId_requestId: { workId: fixture.workId, requestId: `review:${candidate.id}` },
      },
    });
    expect(reviewTask.status).toBe('succeeded');
    expect(reviewTask.currentStep).toBe('persist_review_result');

    const run = await getReviewRunByTaskId(db, reviewTask.id);
    expect(run).toMatchObject({
      candidateId: candidate.id,
      status: 'succeeded',
      passed: true,
      issueCount: 0,
      errorCode: null,
      provider: 'mock',
      model: 'mock-model',
    });
    expect(run?.finishedAt).not.toBeNull();
    expect(await db.chapterReviewIssue.count({ where: { candidateId: candidate.id } })).toBe(0);

    // 审阅不改变章节与候选状态
    expect((await db.chapter.findUniqueOrThrow({ where: { id: fixture.chapterId } })).status).toBe(
      'in_review',
    );
  });

  it('七类问题与三档严重级别按输出顺序落库', async () => {
    const fixture = await newFixture();
    const draft = longDraft();
    const evidences = evidenceSlices(draft, 7);
    const issues: ChapterReviewIssue[] = evidences.map((evidence, index) => ({
      severity: (['high', 'medium', 'low'] as const)[index % 3] ?? 'low',
      type: CHAPTER_REVIEW_ISSUE_TYPES[index] ?? 'prose_quality',
      evidence,
      suggestion: `建议第 ${index + 1} 处改写`,
    }));
    const drafted = await draftCandidate(
      fixture,
      { reviewer: () => ({ passed: false, issues }) },
      draft,
    );
    await expect(runnerFor(drafted.provider.provider).runOnce()).resolves.toBe('succeeded');

    const run = await getReviewRunByTaskId(db, drafted.reviewTaskId);
    expect(run).toMatchObject({ status: 'succeeded', passed: false, issueCount: issues.length });

    const rows = await db.chapterReviewIssue.findMany({
      where: { runId: run?.id ?? '' },
      orderBy: { ordinal: 'asc' },
    });
    expect(rows.map((row) => row.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(rows.map((row) => row.type)).toEqual(issues.map((issue) => issue.type));
    expect(rows.map((row) => row.severity)).toEqual(issues.map((issue) => issue.severity));
    expect(rows.map((row) => row.evidence)).toEqual(issues.map((issue) => issue.evidence));
    expect(new Set(rows.map((row) => row.type)).size).toBe(7);
    // 归属：每条问题都带回 run / 候选 / 章节 / 作品
    for (const row of rows) {
      expect(row).toMatchObject({
        runId: run?.id,
        candidateId: drafted.candidateId,
        chapterId: fixture.chapterId,
        workId: fixture.workId,
      });
    }
  });

  it('问题表的归属与顺序由数据库兜底（复合外键 / UNIQUE / CHECK）', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);
    const claimed = await claimNextTask(db, { workerId: 'constraint-worker', leaseMs: 5_000 });
    expect(claimed?.id).toBe(drafted.reviewTaskId);
    await prepareReviewRun({
      db,
      fence: fenceFor({
        reviewTaskId: drafted.reviewTaskId,
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        candidateId: drafted.candidateId,
        workerId: 'constraint-worker',
      }),
      provider: 'mock',
      model: 'mock-model',
    });
    const run = await getReviewRunByTaskId(db, drafted.reviewTaskId);
    expect(run?.status).toBe('running');

    const inserted = await db.chapterReviewIssue.create({
      data: {
        runId: run?.id ?? '',
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        candidateId: drafted.candidateId,
        ordinal: 0,
        severity: 'low',
        type: 'prose_quality',
        evidence: '新增问题',
        suggestion: '仅用于约束测试',
      },
      select: { id: true },
    });

    // 同一 run + ordinal 重复
    await expect(
      db.chapterReviewIssue.create({
        data: {
          runId: run?.id ?? '',
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          candidateId: drafted.candidateId,
          ordinal: 0,
          severity: 'low',
          type: 'prose_quality',
          evidence: '重复序号',
          suggestion: '仅用于约束测试',
        },
      }),
    ).rejects.toThrow();

    // 跨作品的 issue 归属被复合外键拒绝
    const other = await newFixture();
    await expect(
      db.chapterReviewIssue.create({
        data: {
          runId: run?.id ?? '',
          workId: other.workId,
          chapterId: other.chapterId,
          candidateId: drafted.candidateId,
          ordinal: 1,
          severity: 'low',
          type: 'prose_quality',
          evidence: '跨作品',
          suggestion: '仅用于约束测试',
        },
      }),
    ).rejects.toThrow();

    // severity / type / 长度白名单
    await expect(
      db.chapterReviewIssue.create({
        data: {
          runId: run?.id ?? '',
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          candidateId: drafted.candidateId,
          ordinal: 2,
          severity: 'urgent',
          type: 'prose_quality',
          evidence: '非法级别',
          suggestion: '仅用于约束测试',
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.chapterReviewIssue.create({
        data: {
          runId: run?.id ?? '',
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          candidateId: drafted.candidateId,
          ordinal: 3,
          severity: 'low',
          type: 'made_up_type',
          evidence: '非法类型',
          suggestion: '仅用于约束测试',
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.chapterReviewIssue.create({
        data: {
          runId: run?.id ?? '',
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          candidateId: drafted.candidateId,
          ordinal: 4,
          severity: 'low',
          type: 'prose_quality',
          evidence: 'x'.repeat(301),
          suggestion: '仅用于约束测试',
        },
      }),
    ).rejects.toThrow();

    // 清理这条测试插入的问题，避免影响后续断言（触发器只在 UPDATE/DELETE 时拦截，
    // 这里用受控禁用清理，仅测试库）
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "chapter_review_issues" DISABLE TRIGGER USER');
      await tx.chapterReviewIssue.deleteMany({ where: { id: inserted.id } });
      await tx.$executeRawUnsafe('ALTER TABLE "chapter_review_issues" ENABLE TRIGGER USER');
    });
  });

  it('running 结束后不能再追加问题（成功 / 失败终态均拒绝）', async () => {
    const fixture = await newFixture();
    const succeeded = await draftCandidate(fixture);
    await expect(runnerFor(succeeded.provider.provider).runOnce()).resolves.toBe('succeeded');
    const succeededRun = await getReviewRunByTaskId(db, succeeded.reviewTaskId);
    expect(succeededRun?.status).toBe('succeeded');

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "chapter_review_issues"
           ("id", "run_id", "work_id", "chapter_id", "candidate_id",
            "ordinal", "severity", "type", "evidence", "suggestion")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                 0, 'low', 'prose_quality', '成功后的追加', '不应写入')`,
        succeededRun?.id ?? '',
        fixture.workId,
        fixture.chapterId,
        succeeded.candidateId,
      ),
    ).rejects.toThrow(/只有 running/);

    const failed = await draftCandidate(fixture, {
      reviewer: () => ({ passed: false, issues: [] }),
    });
    await expect(runnerFor(failed.provider.provider).runOnce()).resolves.toBe('failed');
    const failedRun = await getReviewRunByTaskId(db, failed.reviewTaskId);
    expect(failedRun?.status).toBe('failed');

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "chapter_review_issues"
           ("id", "run_id", "work_id", "chapter_id", "candidate_id",
            "ordinal", "severity", "type", "evidence", "suggestion")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                 0, 'low', 'prose_quality', '失败后的追加', '不应写入')`,
        failedRun?.id ?? '',
        fixture.workId,
        fixture.chapterId,
        failed.candidateId,
      ),
    ).rejects.toThrow(/只有 running/);
  });

  it('问题 append-only，成功的 run 不可改、不可删，非法迁移被拒绝', async () => {
    const fixture = await newFixture();
    const evidence = evidenceSlices(longDraft(), 1)[0] ?? '第1段';
    const drafted = await draftCandidate(fixture, {
      reviewer: () => ({
        passed: false,
        issues: [
          {
            severity: 'high',
            type: 'contract_violation',
            evidence,
            suggestion: '补上场景',
          },
        ],
      }),
    });
    await expect(runnerFor(drafted.provider.provider).runOnce()).resolves.toBe('succeeded');
    const run = await getReviewRunByTaskId(db, drafted.reviewTaskId);
    const issue = await db.chapterReviewIssue.findFirstOrThrow({ where: { runId: run?.id ?? '' } });

    await expect(
      db.$executeRawUnsafe(
        `UPDATE "chapter_review_issues" SET "severity" = 'low' WHERE "id" = $1`,
        issue.id,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.$executeRawUnsafe(`DELETE FROM "chapter_review_issues" WHERE "id" = $1`, issue.id),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "chapter_review_runs" SET "passed" = true WHERE "id" = $1`,
        run?.id ?? '',
      ),
    ).rejects.toThrow(/不可再修改/);
    await expect(
      db.$executeRawUnsafe(`DELETE FROM "chapter_review_runs" WHERE "id" = $1`, run?.id ?? ''),
    ).rejects.toThrow(/不可删除/);
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "chapter_review_runs" SET "status" = 'queued' WHERE "id" = $1`,
        run?.id ?? '',
      ),
    ).rejects.toThrow();
  });
});

describe('失败隔离与重试', () => {
  it('语义非法的 Reviewer 输出使 review 任务失败，候选与正文任务不受损', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture, {
      // passed 与 issues 数量矛盾：Schema 通过、语义校验拒绝
      reviewer: () => ({ passed: false, issues: [] }),
    });

    await expect(runnerFor(drafted.provider.provider).runOnce()).resolves.toBe('failed');

    const row = await reviewTaskRow(drafted.reviewTaskId);
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('AGENT_OUTPUT_INVALID');

    const run = await getReviewRunByTaskId(db, drafted.reviewTaskId);
    expect(run).toMatchObject({ status: 'failed', passed: null, issueCount: 0 });
    expect(run?.errorCode).toBe('AGENT_OUTPUT_INVALID');
    expect(run?.finishedAt).not.toBeNull();
    expect(await db.chapterReviewIssue.count({ where: { runId: run?.id ?? '' } })).toBe(0);

    // 候选与正文任务完全不受影响
    const candidate = await db.chapterCandidate.findUniqueOrThrow({
      where: { id: drafted.candidateId },
    });
    expect(candidate.content).toBe(drafted.candidateContent);
    const draftTask = await reviewTaskRow(drafted.draftTaskId);
    expect(draftTask.status).toBe('succeeded');
    expect((await db.chapter.findUniqueOrThrow({ where: { id: fixture.chapterId } })).status).toBe(
      'in_review',
    );
  });

  it('Provider 失败可重试，重试复用同一个 run 且不重复写问题', async () => {
    const fixture = await newFixture();
    let reviewCalls = 0;
    const withPlan = createChapterProvider(
      {
        reviewer: () => {
          reviewCalls += 1;
          if (reviewCalls === 1) {
            throw new ModelProviderError('MODEL_NETWORK_ERROR', '网络不可用', { retryable: true });
          }
          return { passed: true, issues: [] };
        },
      },
      { plan: defaultPlannerOutput(fixture), text: longDraft() },
    );

    const { task } = await createDraftTask(fixture);
    const runner = runnerFor(withPlan.provider);
    await expect(runner.runOnce()).resolves.toBe('succeeded');

    const candidate = await db.chapterCandidate.findUniqueOrThrow({
      where: { generationTaskId: task.id },
    });
    const reviewTask = await db.generationTask.findUniqueOrThrow({
      where: {
        workId_requestId: { workId: fixture.workId, requestId: `review:${candidate.id}` },
      },
    });

    await expect(runner.runOnce()).resolves.toBe('retried');
    const failedRun = await getReviewRunByTaskId(db, reviewTask.id);
    expect(failedRun?.status).toBe('failed');
    const firstRunId = failedRun?.id ?? '';
    expect(failedRun?.errorCode).toBe('MODEL_NETWORK_ERROR');

    await expect(runner.runOnce()).resolves.toBe('succeeded');

    const finalRun = await getReviewRunByTaskId(db, reviewTask.id);
    expect(finalRun?.id).toBe(firstRunId);
    expect(finalRun).toMatchObject({ status: 'succeeded', passed: true, issueCount: 0 });
    expect(await db.chapterReviewRun.count({ where: { candidateId: candidate.id } })).toBe(1);
    expect(await db.chapterReviewIssue.count({ where: { candidateId: candidate.id } })).toBe(0);
    expect((await reviewTaskRow(reviewTask.id)).attemptCount).toBe(2);
  });

  it('旧 Worker 晚返回不能写问题、也覆盖不了已成功的 run', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);
    await expect(runnerFor(drafted.provider.provider).runOnce()).resolves.toBe('succeeded');
    const run = await getReviewRunByTaskId(db, drafted.reviewTaskId);

    await expect(
      persistReviewResult({
        db,
        fence: fenceFor({
          reviewTaskId: drafted.reviewTaskId,
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          candidateId: drafted.candidateId,
          workerId: 'stale-worker',
        }),
        output: {
          passed: false,
          issues: [
            {
              severity: 'high',
              type: 'setting_contradiction',
              evidence: '旧的晚返回',
              suggestion: '不应写入',
            },
          ],
        },
        provider: 'mock',
        model: 'mock-model',
      }),
    ).rejects.toMatchObject({ code: 'TASK_LEASE_LOST' });

    const after = await getReviewRunByTaskId(db, drafted.reviewTaskId);
    expect(after).toMatchObject({ status: 'succeeded', passed: true, issueCount: 0 });
    expect(await db.chapterReviewIssue.count({ where: { runId: run?.id ?? '' } })).toBe(0);
  });

  it('取消不会留下永久 running 的 run', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);

    const claimed = await claimNextTask(db, { workerId: 'cancel-worker', leaseMs: 5_000 });
    expect(claimed?.id).toBe(drafted.reviewTaskId);
    const prepared = await prepareReviewRun({
      db,
      fence: fenceFor({
        reviewTaskId: drafted.reviewTaskId,
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        candidateId: drafted.candidateId,
        workerId: 'cancel-worker',
      }),
      provider: 'mock',
      model: 'mock-model',
    });
    expect(prepared.skip).toBe(false);
    expect((await getReviewRunByTaskId(db, drafted.reviewTaskId))?.status).toBe('running');

    await requestTaskCancellationForAuthor(db, {
      authorId: fixture.authorId,
      workId: fixture.workId,
      taskId: drafted.reviewTaskId,
    });
    await expect(
      completeTask(db, { taskId: drafted.reviewTaskId, workerId: 'cancel-worker' }),
    ).resolves.toBe('cancelled');

    const run = await getReviewRunByTaskId(db, drafted.reviewTaskId);
    expect(run?.status).toBe('failed');
    expect(run?.errorCode).toBe('TASK_CANCELLED');
    expect(run?.finishedAt).not.toBeNull();
    expect(await db.chapterReviewIssue.count({ where: { candidateId: drafted.candidateId } })).toBe(
      0,
    );
  });

  it('任务以 failed 终态关闭仍为 running 的 run', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);

    const claimed = await claimNextTask(db, { workerId: 'failed-worker', leaseMs: 5_000 });
    expect(claimed?.id).toBe(drafted.reviewTaskId);
    await prepareReviewRun({
      db,
      fence: fenceFor({
        reviewTaskId: drafted.reviewTaskId,
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        candidateId: drafted.candidateId,
        workerId: 'failed-worker',
      }),
      provider: 'mock',
      model: 'mock-model',
    });
    expect((await getReviewRunByTaskId(db, drafted.reviewTaskId))?.status).toBe('running');

    await expect(
      failTask(db, {
        taskId: drafted.reviewTaskId,
        workerId: 'failed-worker',
        errorCode: 'TASK_VALIDATION_FAILED',
        message: '任务不可重试失败',
        retryable: false,
      }),
    ).resolves.toBe('failed');

    const task = await reviewTaskRow(drafted.reviewTaskId);
    expect(task).toMatchObject({
      status: 'failed',
      errorCode: 'TASK_VALIDATION_FAILED',
      lockedBy: null,
    });
    const run = await getReviewRunByTaskId(db, drafted.reviewTaskId);
    expect(run).toMatchObject({
      status: 'failed',
      errorCode: 'TASK_VALIDATION_FAILED',
      passed: null,
      issueCount: 0,
    });
    expect(run?.finishedAt).not.toBeNull();
    expect(await db.chapterReviewIssue.count({ where: { candidateId: drafted.candidateId } })).toBe(
      0,
    );
    expect(
      (await db.chapterCandidate.findUniqueOrThrow({ where: { id: drafted.candidateId } })).content,
    ).toBe(drafted.candidateContent);
  });

  it('租约丢失后重新领取会接管同一个 run（不会新建第二行）', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);

    await claimNextTask(db, { workerId: 'worker-a', leaseMs: 5_000 });
    const first = await prepareReviewRun({
      db,
      fence: fenceFor({
        reviewTaskId: drafted.reviewTaskId,
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        candidateId: drafted.candidateId,
        workerId: 'worker-a',
      }),
      provider: 'mock',
      model: 'mock-model',
    });

    // 模拟心跳丢失后任务被重新排队
    await expect(
      failTask(db, {
        taskId: drafted.reviewTaskId,
        workerId: 'worker-a',
        errorCode: 'TASK_LEASE_LOST',
        message: '任务租约已失效',
        retryable: true,
      }),
    ).resolves.toBe('queued');

    const reclaimed = await claimNextTask(db, { workerId: 'worker-b', leaseMs: 5_000 });
    expect(reclaimed?.id).toBe(drafted.reviewTaskId);
    const second = await prepareReviewRun({
      db,
      fence: fenceFor({
        reviewTaskId: drafted.reviewTaskId,
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        candidateId: drafted.candidateId,
        workerId: 'worker-b',
      }),
      provider: 'mock',
      model: 'mock-model',
    });

    expect(second.runId).toBe(first.runId);
    expect(second.skip).toBe(false);
    expect(await db.chapterReviewRun.count({ where: { candidateId: drafted.candidateId } })).toBe(
      1,
    );
    expect((await getReviewRunByTaskId(db, drafted.reviewTaskId))?.status).toBe('running');
  });
});

describe('跨作品与错候选隔离', () => {
  it('跨作品的候选被拒绝，且不创建 run', async () => {
    const fixture = await newFixture();
    const other = await newFixture();
    // 另一个作品里也有一份合法的候选
    const otherDrafted = await draftCandidate(other);
    // 该作品自动入队的审阅任务会干扰 claimNextTask，先删掉（本用例只借它的候选 id）
    await db.generationTask.delete({ where: { id: otherDrafted.reviewTaskId } });

    const { task } = await createGenerationTask(db, {
      authorId: fixture.authorId,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      requestId: `req-${randomUUID()}`,
      taskType: CHAPTER_REVIEW_TASK_TYPE,
      inputSnapshot: { candidateId: otherDrafted.candidateId },
      provider: 'mock',
      model: 'mock-model',
    });
    await claimNextTask(db, { workerId: 'cross-worker', leaseMs: 5_000 });

    await expect(
      prepareReviewRun({
        db,
        fence: fenceFor({
          reviewTaskId: task.id,
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          candidateId: otherDrafted.candidateId,
          workerId: 'cross-worker',
        }),
        provider: 'mock',
        model: 'mock-model',
      }),
    ).rejects.toMatchObject({ code: 'TASK_INPUT_INVALID' });

    expect(await db.chapterReviewRun.count({ where: { generationTaskId: task.id } })).toBe(0);
  });

  it('同作品但错章节 / 错候选被拒绝', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);
    // 清掉自动入队的审阅任务，保证 claimNextTask 领到本用例新建的任务
    await db.generationTask.delete({ where: { id: drafted.reviewTaskId } });
    const extra = await db.chapter.create({
      data: { workId: fixture.workId, chapterNo: 2, title: '第二章' },
      select: { id: true },
    });

    const { task } = await createGenerationTask(db, {
      authorId: fixture.authorId,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      requestId: `req-${randomUUID()}`,
      taskType: CHAPTER_REVIEW_TASK_TYPE,
      inputSnapshot: { candidateId: drafted.candidateId },
      provider: 'mock',
      model: 'mock-model',
    });
    await claimNextTask(db, { workerId: 'strict-worker', leaseMs: 5_000 });

    // 错章节：任务行锁的归属校验先拒绝（不会读到别的章节）
    await expect(
      prepareReviewRun({
        db,
        fence: fenceFor({
          reviewTaskId: task.id,
          workId: fixture.workId,
          chapterId: extra.id,
          candidateId: drafted.candidateId,
          workerId: 'strict-worker',
        }),
        provider: 'mock',
        model: 'mock-model',
      }),
    ).rejects.toMatchObject({ code: 'TASK_LEASE_LOST' });

    // 真实章节但错候选（同作品、同章节范围内查不到）
    await expect(
      prepareReviewRun({
        db,
        fence: fenceFor({
          reviewTaskId: task.id,
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          candidateId: randomUUID(),
          workerId: 'strict-worker',
        }),
        provider: 'mock',
        model: 'mock-model',
      }),
    ).rejects.toMatchObject({ code: 'TASK_INPUT_INVALID' });

    expect(await db.chapterReviewRun.count({ where: { generationTaskId: task.id } })).toBe(0);
  });
});

describe('审阅上下文安全与确定性', () => {
  it('secret / secretKnownBy 不进入 Reviewer 输入与 task_contexts', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);
    await expect(runnerFor(drafted.provider.provider).runOnce()).resolves.toBe('succeeded');

    const reviewerCall = drafted.provider.calls.reviewer[0];
    expect(reviewerCall).toBeDefined();
    const payload = JSON.parse(lastUserContent(reviewerCall as ModelJsonInput)) as Record<
      string,
      unknown
    >;
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(`他其实是${fixture.tag}界的转世`);
    expect(serialized.toLowerCase()).not.toContain('secret');

    const contexts = await listTaskContexts(db, drafted.reviewTaskId);
    const contextText = contexts.map((row) => row.snippet ?? '').join('\n');
    expect(contextText).not.toContain(`他其实是${fixture.tag}界的转世`);
    expect(contexts.map((row) => row.contextType)).toEqual(
      expect.arrayContaining(['chapter', 'chapter_contract', 'chapter_candidate']),
    );
  });

  it('四类实体每类最多 100 条，顺序为 orderIndex → createdAt → id', async () => {
    const fixture = await newFixture();
    const extra = await addCharacters(db, fixture, 105);
    const drafted = await draftCandidate(fixture);
    await expect(runnerFor(drafted.provider.provider).runOnce()).resolves.toBe('succeeded');

    const reviewerCall = drafted.provider.calls.reviewer[0] as ModelJsonInput;
    const payload = JSON.parse(lastUserContent(reviewerCall)) as {
      characters: { id: string }[];
      items: { id: string }[];
      realms: { id: string }[];
      factions: { id: string }[];
      priorSummaries: unknown[];
    };

    expect(payload.characters).toHaveLength(100);
    // fixture 的前两个人物 orderIndex 是 1 / 2，排在新增群演（100+）之前
    expect(payload.characters.slice(0, 2).map((entity) => entity.id)).toEqual(
      fixture.characters.map((entity) => entity.id),
    );
    expect(payload.characters.some((entity) => entity.id === extra[104]?.id)).toBe(false);
    expect(payload.realms.map((entity) => entity.id)).toEqual(fixture.realms.map((r) => r.id));
    expect(payload.factions.map((entity) => entity.id)).toEqual(fixture.factions.map((f) => f.id));
    expect(payload.items).toEqual([]);
    // priorSummaries 固定为空（A2-D 未实现）
    expect(payload.priorSummaries).toEqual([]);
    // orderIndex 不允许出现在 Reviewer 输入里
    expect(JSON.stringify(payload.characters[0])).not.toContain('orderIndex');
  });
});

describe('LLM 日志与审计边界', () => {
  it('成功调用写且只写一条 llm_call_logs，不含正文', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);
    await expect(runnerFor(drafted.provider.provider).runOnce()).resolves.toBe('succeeded');

    const logs = await db.llmCallLog.findMany({
      where: { taskId: drafted.reviewTaskId },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      stage: `agent:${REVIEWER_CHAPTER_AGENT.name}@${REVIEWER_CHAPTER_AGENT.promptVersion}`,
      provider: 'mock',
      model: 'mock-model',
      success: true,
      errorCode: null,
    });
    expect(logs[0]?.promptTokens).toBeGreaterThan(0);
    // 日志表没有正文字段，这里再确认落库内容不含正文片段
    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain(drafted.candidateContent.slice(0, 24));
  });

  it('语义失败也写一条 success=false 的日志，且不含 evidence', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture, {
      reviewer: () => ({ passed: true, issues: [{ severity: 'low', type: 'prose_quality' }] }),
    });
    await expect(runnerFor(drafted.provider.provider).runOnce()).resolves.toBe('failed');

    const logs = await db.llmCallLog.findMany({ where: { taskId: drafted.reviewTaskId } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ success: false, errorCode: 'AGENT_OUTPUT_INVALID' });
    expect(JSON.stringify(logs[0])).not.toContain('evidence');
  });

  it('审阅成功与失败都不新增审计行', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);
    const before = await db.auditLog.count({ where: { targetId: fixture.chapterId } });

    await expect(runnerFor(drafted.provider.provider).runOnce()).resolves.toBe('succeeded');
    expect(await db.auditLog.count({ where: { targetId: fixture.chapterId } })).toBe(before);

    const failing = await draftCandidate(fixture, {
      reviewer: () => ({ passed: false, issues: [] }),
    });
    const afterDraft = await db.auditLog.count({ where: { targetId: fixture.chapterId } });
    await expect(runnerFor(failing.provider.provider).runOnce()).resolves.toBe('failed');
    expect(await db.auditLog.count({ where: { targetId: fixture.chapterId } })).toBe(afterDraft);
  });
});

describe('作者侧读接口与 Worker 编排', () => {
  it('章节详情 / 列表不会把 review 任务当成最新正文任务', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);

    // 审阅任务已入队且创建时间晚于正文任务
    const detail = await getChapterDetail({
      db,
      workId: fixture.workId,
      authorId: fixture.authorId,
      chapterId: fixture.chapterId,
    });
    expect(detail.latestTask?.id).toBe(drafted.draftTaskId);
    expect(detail.latestTask?.status).toBe('succeeded');

    await expect(runnerFor(drafted.provider.provider).runOnce()).resolves.toBe('succeeded');
    const afterReview = await getChapterDetail({
      db,
      workId: fixture.workId,
      authorId: fixture.authorId,
      chapterId: fixture.chapterId,
    });
    expect(afterReview.latestTask?.id).toBe(drafted.draftTaskId);
    expect(afterReview.latestTask?.currentStep).toBe('persist_candidate');

    const list = await listChapters({
      db,
      workId: fixture.workId,
      authorId: fixture.authorId,
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      latestTaskStatus: 'succeeded',
      latestTaskStep: 'persist_candidate',
    });
  });

  it('同一个 Worker 的 runOnce 能依次完成 draft 与 review', async () => {
    const fixture = await newFixture();
    const drafted = await draftCandidate(fixture);
    const runner = runnerFor(drafted.provider.provider);

    await expect(runner.runOnce()).resolves.toBe('succeeded');
    expect((await reviewTaskRow(drafted.reviewTaskId)).status).toBe('succeeded');
    // 队列已空
    await expect(runner.runOnce()).resolves.toBe('idle');

    const run = await getReviewRunByTaskId(db, drafted.reviewTaskId);
    expect(run).toMatchObject({ status: 'succeeded', passed: true, issueCount: 0 });
    // 正文任务与候选保持不变
    expect((await reviewTaskRow(drafted.draftTaskId)).status).toBe('succeeded');
    expect(await db.chapterCandidate.count({ where: { chapterId: fixture.chapterId } })).toBe(1);
  });
});

/**
 * A2-D-C：Reviewer 前章摘要接线。
 *
 * 只选「同作品 + 前序章节 + 当前 finalized + 摘要对应当前最新正式版本」的摘要，
 * 按 chapterNo 升序、最多 20 条；缺失时为 []，不用正文补。
 */
async function reviewedChapter(
  fixture: ChapterFixture,
  chapterNo = 10,
): Promise<{ chapterId: string; candidateId: string; reviewTaskId: string }> {
  const chapter = await db.chapter.create({
    data: { workId: fixture.workId, chapterNo, title: `第${chapterNo}章` },
    select: { id: true },
  });
  const { provider } = createChapterProvider(
    {},
    { plan: defaultPlannerOutput(fixture), text: longDraft() },
  );
  const { task } = await createGenerationTask(db, {
    authorId: fixture.authorId,
    workId: fixture.workId,
    chapterId: chapter.id,
    requestId: `req-${randomUUID()}`,
    taskType: CHAPTER_DRAFT_TASK_TYPE,
    inputSnapshot: { targetWords: 3000 },
    provider: 'mock',
    model: 'mock-model',
  });
  await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');

  const candidate = await db.chapterCandidate.findUniqueOrThrow({
    where: { generationTaskId: task.id },
  });
  const reviewTask = await db.generationTask.findUniqueOrThrow({
    where: {
      workId_requestId: { workId: fixture.workId, requestId: `review:${candidate.id}` },
    },
  });
  return { chapterId: chapter.id, candidateId: candidate.id, reviewTaskId: reviewTask.id };
}

interface PriorChapterSeed {
  readonly chapterId: string;
  readonly versionId: string;
  readonly summaryId: string | null;
}

/** 造一个前序章节：一版正式版本 +（可选）摘要 + 可选 finalized。 */
async function priorChapter(
  fixture: ChapterFixture,
  chapterNo: number,
  summaryText: string | null,
  finalized = true,
): Promise<PriorChapterSeed> {
  const chapter = await db.chapter.create({
    data: { workId: fixture.workId, chapterNo, title: `第${chapterNo}章` },
    select: { id: true },
  });
  const version = await saveHumanChapterVersion({
    db,
    workId: fixture.workId,
    chapterId: chapter.id,
    authorId: fixture.authorId,
    content: longDraft(`第${chapterNo}章`),
    baseVersionId: null,
  });
  if (finalized) {
    await db.chapter.update({ where: { id: chapter.id }, data: { status: 'finalized' } });
  }
  let summaryId: string | null = null;
  if (summaryText !== null) {
    const row = await db.chapterSummary.create({
      data: {
        workId: fixture.workId,
        chapterId: chapter.id,
        sourceVersionId: version.versionId,
        agentName: 'summarizer.chapter',
        agentVersion: '1.0.0',
        provider: 'mock',
        model: 'mock-model',
        summary: summaryText,
      },
      select: { id: true },
    });
    summaryId = row.id;
  }
  return { chapterId: chapter.id, versionId: version.versionId, summaryId };
}

/** 在事务内装配审阅上下文（与工作流同一入口）。 */
async function readReviewContext(workId: string, chapterId: string, candidateId: string) {
  return db.$transaction(async (tx) =>
    buildChapterReviewContext({ db: tx, workId, chapterId, candidateId }),
  );
}

describe('前章摘要接线（A2-D-C）', () => {
  it('两个前序定稿章节摘要按 chapterNo 升序进入 Reviewer 输入', async () => {
    const fixture = await newFixture();
    const reviewed = await reviewedChapter(fixture);
    await priorChapter(fixture, 2, '第二章摘要：主角入门。');
    await priorChapter(fixture, 3, '第三章摘要：初次比试。');

    const context = await readReviewContext(
      fixture.workId,
      reviewed.chapterId,
      reviewed.candidateId,
    );

    expect(context.input.priorSummaries).toEqual([
      { chapterNo: 2, summary: '第二章摘要：主角入门。' },
      { chapterNo: 3, summary: '第三章摘要：初次比试。' },
    ]);
    // 当前章与实体照常装配
    expect(context.input.chapter.chapterNo).toBe(10);
    expect(context.input.characters.length).toBeGreaterThan(0);
  });

  it('当前章节自己的摘要不被选中', async () => {
    const fixture = await newFixture();
    const reviewed = await reviewedChapter(fixture);
    await priorChapter(fixture, 2, '第二章摘要。');

    // 给当前章节也造一版 + 摘要：chapterNo 不小于自己，必须排除
    const own = await saveHumanChapterVersion({
      db,
      workId: fixture.workId,
      chapterId: reviewed.chapterId,
      authorId: fixture.authorId,
      content: longDraft('当前章'),
      baseVersionId: null,
    });
    await db.chapterSummary.create({
      data: {
        workId: fixture.workId,
        chapterId: reviewed.chapterId,
        sourceVersionId: own.versionId,
        agentName: 'summarizer.chapter',
        agentVersion: '1.0.0',
        provider: 'mock',
        model: 'mock-model',
        summary: '当前章节自己的摘要',
      },
    });

    const context = await readReviewContext(
      fixture.workId,
      reviewed.chapterId,
      reviewed.candidateId,
    );
    expect(context.input.priorSummaries.map((row) => row.chapterNo)).toEqual([2]);
    expect(JSON.stringify(context.input.priorSummaries)).not.toContain('当前章节自己的摘要');
  });

  it('未来章节摘要不被选中', async () => {
    const fixture = await newFixture();
    const reviewed = await reviewedChapter(fixture);
    await priorChapter(fixture, 2, '第二章摘要。');
    await priorChapter(fixture, 20, '第二十章摘要（未来）。');

    const context = await readReviewContext(
      fixture.workId,
      reviewed.chapterId,
      reviewed.candidateId,
    );
    expect(context.input.priorSummaries.map((row) => row.chapterNo)).toEqual([2]);
  });

  it('其它作品的摘要不被选中', async () => {
    const fixture = await newFixture();
    const other = await newFixture();
    const reviewed = await reviewedChapter(fixture);
    await priorChapter(fixture, 2, '本作第二章摘要。');
    await priorChapter(other, 2, '别的作品第二章摘要。');

    const context = await readReviewContext(
      fixture.workId,
      reviewed.chapterId,
      reviewed.candidateId,
    );
    expect(context.input.priorSummaries).toEqual([{ chapterNo: 2, summary: '本作第二章摘要。' }]);
  });

  it('前序章节 revision 后（非 finalized）旧摘要不进入', async () => {
    const fixture = await newFixture();
    const reviewed = await reviewedChapter(fixture);
    const prior = await priorChapter(fixture, 2, '第二章旧摘要。');

    // 人工 revision：章节回到 in_review
    await saveHumanChapterVersion({
      db,
      workId: fixture.workId,
      chapterId: prior.chapterId,
      authorId: fixture.authorId,
      content: longDraft('第二章修订'),
      baseVersionId: prior.versionId,
    });
    expect((await db.chapter.findUniqueOrThrow({ where: { id: prior.chapterId } })).status).toBe(
      'in_review',
    );

    const context = await readReviewContext(
      fixture.workId,
      reviewed.chapterId,
      reviewed.candidateId,
    );
    expect(context.input.priorSummaries).toEqual([]);
  });

  it('前序章节状态不是 finalized 时（版本仍最新）旧摘要不进入', async () => {
    const fixture = await newFixture();
    const reviewed = await reviewedChapter(fixture);
    const prior = await priorChapter(fixture, 2, '第二章摘要。');

    // 只改状态、不产生新版本：验证 finalized 条件是独立的一道闸门
    await db.chapter.update({ where: { id: prior.chapterId }, data: { status: 'in_review' } });
    const latest = await db.chapterVersion.findFirstOrThrow({
      where: { chapterId: prior.chapterId },
      orderBy: { versionNo: 'desc' },
      select: { id: true },
    });
    expect(latest.id).toBe(prior.versionId);

    const context = await readReviewContext(
      fixture.workId,
      reviewed.chapterId,
      reviewed.candidateId,
    );
    expect(context.input.priorSummaries).toEqual([]);
  });

  it('前序章节重新定稿并有新摘要后，使用新摘要', async () => {
    const fixture = await newFixture();
    const reviewed = await reviewedChapter(fixture);
    const prior = await priorChapter(fixture, 2, '第二章旧摘要。');

    const revised = await saveHumanChapterVersion({
      db,
      workId: fixture.workId,
      chapterId: prior.chapterId,
      authorId: fixture.authorId,
      content: longDraft('第二章修订'),
      baseVersionId: prior.versionId,
    });
    await db.chapter.update({ where: { id: prior.chapterId }, data: { status: 'finalized' } });
    await db.chapterSummary.create({
      data: {
        workId: fixture.workId,
        chapterId: prior.chapterId,
        sourceVersionId: revised.versionId,
        agentName: 'summarizer.chapter',
        agentVersion: '1.0.0',
        provider: 'mock',
        model: 'mock-model',
        summary: '第二章新摘要。',
      },
    });

    const context = await readReviewContext(
      fixture.workId,
      reviewed.chapterId,
      reviewed.candidateId,
    );
    expect(context.input.priorSummaries).toEqual([{ chapterNo: 2, summary: '第二章新摘要。' }]);
  });

  it('同一章节的历史摘要只取对应当前最新版本的一条', async () => {
    const fixture = await newFixture();
    const reviewed = await reviewedChapter(fixture);
    const prior = await priorChapter(fixture, 2, '第二章 v1 摘要。');

    const revised = await saveHumanChapterVersion({
      db,
      workId: fixture.workId,
      chapterId: prior.chapterId,
      authorId: fixture.authorId,
      content: longDraft('第二章修订'),
      baseVersionId: prior.versionId,
    });
    await db.chapter.update({ where: { id: prior.chapterId }, data: { status: 'finalized' } });
    await db.chapterSummary.create({
      data: {
        workId: fixture.workId,
        chapterId: prior.chapterId,
        sourceVersionId: revised.versionId,
        agentName: 'summarizer.chapter',
        agentVersion: '1.0.0',
        provider: 'mock',
        model: 'mock-model',
        summary: '第二章 v2 摘要。',
      },
    });

    // 两版摘要都在表里，但只应选中 v2
    expect(await db.chapterSummary.count({ where: { chapterId: prior.chapterId } })).toBe(2);
    const context = await readReviewContext(
      fixture.workId,
      reviewed.chapterId,
      reviewed.candidateId,
    );
    expect(context.input.priorSummaries).toHaveLength(1);
    expect(context.input.priorSummaries[0]?.summary).toBe('第二章 v2 摘要。');
  });

  it('21 个前序摘要只取最近 20 章，并按 chapterNo 升序', async () => {
    const fixture = await newFixture();
    const reviewed = await reviewedChapter(fixture, 30);
    for (let chapterNo = 2; chapterNo <= 22; chapterNo += 1) {
      await priorChapter(fixture, chapterNo, `第${chapterNo}章摘要。`);
    }

    const context = await readReviewContext(
      fixture.workId,
      reviewed.chapterId,
      reviewed.candidateId,
    );
    const summaryRows = context.input.priorSummaries;
    expect(summaryRows).toHaveLength(20);
    // 最近 20 章 = 3..22（丢弃最早的第 2 章），仍按升序
    expect(summaryRows[0]?.chapterNo).toBe(3);
    expect(summaryRows[19]?.chapterNo).toBe(22);
    expect(summaryRows.map((row) => row.chapterNo)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 3),
    );
  });

  it('没有前章摘要时 priorSummaries 为 []', async () => {
    const fixture = await newFixture();
    const reviewed = await reviewedChapter(fixture);
    await priorChapter(fixture, 2, null);

    const context = await readReviewContext(
      fixture.workId,
      reviewed.chapterId,
      reviewed.candidateId,
    );
    expect(context.input.priorSummaries).toEqual([]);
  });

  it('task_contexts 只记 summary id 与前章号，不含摘要正文', async () => {
    const fixture = await newFixture();
    const reviewed = await reviewedChapter(fixture);
    const secretSummary = '前章摘要机密：主角其实是转世之身。';
    const prior = await priorChapter(fixture, 2, secretSummary);

    await expect(runnerFor(createChapterMockProvider()).runOnce()).resolves.toBe('succeeded');

    const contexts = await listTaskContexts(db, reviewed.reviewTaskId);
    const summaryContexts = contexts.filter((row) => row.contextType === 'chapter_summary');
    expect(summaryContexts).toHaveLength(1);
    expect(summaryContexts[0]?.refId).toBe(prior.summaryId);
    expect(summaryContexts[0]?.snippet).toBe('第2章摘要');

    const allText = contexts.map((row) => row.snippet ?? '').join('\n');
    expect(allText).not.toContain('前章摘要机密');
    // 其余来源仍在
    expect(contexts.map((row) => row.contextType)).toEqual(
      expect.arrayContaining(['chapter', 'chapter_contract', 'chapter_candidate']),
    );
  });

  it('有前章摘要时，非法 Reviewer 输出仍按原语义失败且不回滚候选', async () => {
    const fixture = await newFixture();
    await priorChapter(fixture, 2, '第二章摘要。');
    const reviewed = await reviewedChapter(fixture);

    // reviewedChapter 已消费掉一次 draft 任务；这里直接换一个会返回非法输出的 provider
    const { provider } = createChapterProvider(
      { reviewer: () => ({ passed: false, issues: [] }) },
      { plan: {}, text: longDraft() },
    );
    await expect(runnerFor(provider).runOnce()).resolves.toBe('failed');

    const run = await getReviewRunByTaskId(db, reviewed.reviewTaskId);
    expect(run).toMatchObject({ status: 'failed', errorCode: 'AGENT_OUTPUT_INVALID' });
    expect(
      await db.chapterReviewIssue.count({ where: { candidateId: reviewed.candidateId } }),
    ).toBe(0);
    expect(await db.chapterCandidate.count({ where: { id: reviewed.candidateId } })).toBe(1);
  });
});
