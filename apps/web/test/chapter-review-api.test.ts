/**
 * Reviewer 结果只读 API（A2-C-D）。
 *
 * 覆盖：
 * - 任务状态：queued / processing / succeeded / failed / cancelled 的合法响应；
 * - run：null、running、succeeded（passed=true/false）、failed（稳定错误码）；
 * - issues：ordinal 升序、severity / type 原样回显；
 * - 404：无审阅任务、候选不属于作品 / 章节、其它作者作品、随机 candidateId；
 * - 权限：未登录 401、管理员 403；只读接口不依赖 Origin；
 * - 脱敏：不含正文、prompt、provider / model、inputSnapshot / requestId / 租约字段；
 * - 只读：不写 audit_logs、不改 task / run / issue、不写 llm_call_logs。
 */

import { createHash, randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as reviewGet } from '../app/api/works/[id]/chapters/[chapterId]/candidates/[candidateId]/review/route.js';

/** 正文里的机密标记：绝不能出现在审阅结果响应里。 */
const MARKER = `审阅机密-${randomUUID().slice(0, 8)}`;

/** 候选正文（远超 evidence 片段，确保"正文不返回"不是因为长度被截断）。 */
const CONTENT = `${MARKER}，风从演武场尽头吹来。${'他握紧了手中的剑。'.repeat(160)}`;

let db: PrismaClient;

interface Fixture {
  readonly authorId: string;
  readonly token: string;
  readonly adminToken: string;
  readonly workId: string;
  readonly chapterId: string;
  /** 同一作品的第二章（测错章节）。 */
  readonly chapterId2: string;
  /** 同一作者的另一个作品。 */
  readonly otherWorkId: string;
  readonly otherChapterId: string;
  /** 他人作品。 */
  readonly strangerWorkId: string;
  readonly strangerChapterId: string;
}

const works: string[] = [];

async function createUser(role: 'author' | 'admin'): Promise<{ id: string; token: string }> {
  const user = await db.user.create({
    data: {
      email: `chapter-review-${role}-${randomUUID()}@example.test`,
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
  const workId = await createWork(author.id, '审阅作品');
  const otherWorkId = await createWork(author.id, '审阅作品-另一部');
  const strangerWorkId = await createWork(stranger.id, '他人审阅作品');

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
    chapterId2: chapter2.id,
    otherWorkId,
    otherChapterId: otherChapter.id,
    strangerWorkId,
    strangerChapterId: strangerChapter.id,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface SeededCandidate {
  readonly candidateId: string;
  readonly draftTaskId: string;
  readonly workId: string;
  readonly chapterId: string;
}

/**
 * 造一个已保存的候选（含 draft 任务 + 冻结合同）。
 *
 * 直接插库而不是跑完整工作流：本卡只测只读接口，避免把 Worker 的行为耦进来。
 */
async function seedCandidate(options: {
  readonly workId: string;
  readonly chapterId: string;
}): Promise<SeededCandidate> {
  const { workId, chapterId } = options;
  const draftTask = await db.generationTask.create({
    data: {
      workId,
      chapterId,
      requestId: `draft-${randomUUID()}`,
      inputHash: hash(`draft-${randomUUID()}`),
      taskType: 'chapter.draft',
      status: 'succeeded',
      inputSnapshot: { targetWords: 3000 },
      provider: 'mock',
      model: 'mock-model',
      attemptCount: 1,
    },
    select: { id: true },
  });

  const contract = await db.chapterContract.create({
    data: {
      workId,
      chapterId,
      generationTaskId: draftTask.id,
      // 同一章节可以有多个候选，但合同版本号唯一
      versionNo: (await db.chapterContract.count({ where: { chapterId } })) + 1,
      goal: '主角在演武场证明自己',
      mustInclude: ['演武场'],
      mustNotInclude: [],
      sceneBeats: {
        scenes: [{ location: '演武场', goal: '证明实力', conflict: '同门质疑' }],
      },
      targetWords: 3000,
    },
    select: { id: true },
  });

  const candidate = await db.chapterCandidate.create({
    data: {
      workId,
      chapterId,
      generationTaskId: draftTask.id,
      contractId: contract.id,
      content: CONTENT,
      wordCount: CONTENT.length,
      structuredPlan: { scenes: [] },
    },
    select: { id: true },
  });

  return { candidateId: candidate.id, draftTaskId: draftTask.id, workId, chapterId };
}

interface ReviewTaskSeed {
  readonly status?: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  readonly currentStep?: string | null;
  readonly attemptCount?: number;
  readonly errorCode?: string | null;
  /** 覆盖 requestId（用于验证"只按 requestId 认领"是错的）。 */
  readonly requestId?: string;
  /** 覆盖 taskType（用于验证 taskType 条件是必需的）。 */
  readonly taskType?: string;
  /** 覆盖任务快照（用于验证快照 candidateId 校验）。 */
  readonly inputSnapshot?: unknown;
}

/** 造候选的 `chapter.review` 任务（requestId 与真实入队一致）。 */
async function seedReviewTask(
  candidate: SeededCandidate,
  seed: ReviewTaskSeed = {},
): Promise<string> {
  const status = seed.status ?? 'queued';
  const processing = status === 'processing';
  const task = await db.generationTask.create({
    data: {
      workId: candidate.workId,
      chapterId: candidate.chapterId,
      requestId: seed.requestId ?? `review:${candidate.candidateId}`,
      inputHash: hash(`review-${candidate.candidateId}-${randomUUID()}`),
      taskType: seed.taskType ?? 'chapter.review',
      status,
      currentStep: seed.currentStep === undefined ? null : seed.currentStep,
      inputSnapshot:
        seed.inputSnapshot === undefined
          ? { candidateId: candidate.candidateId }
          : (seed.inputSnapshot as object),
      provider: 'mock',
      model: 'mock-model',
      attemptCount: seed.attemptCount ?? (status === 'queued' ? 0 : 1),
      errorCode: seed.errorCode === undefined ? null : seed.errorCode,
      errorMessageSanitized: null,
      ...(processing
        ? { lockedBy: 'e2e-review-worker', leaseUntil: new Date(Date.now() + 60_000) }
        : {}),
    },
    select: { id: true },
  });
  return task.id;
}

/** 造一条 running 的 review run。 */
async function seedRunningRun(candidate: SeededCandidate, taskId: string): Promise<string> {
  const run = await db.chapterReviewRun.create({
    data: {
      workId: candidate.workId,
      chapterId: candidate.chapterId,
      candidateId: candidate.candidateId,
      generationTaskId: taskId,
      agentName: 'reviewer.chapter',
      agentVersion: '1.0.0',
      provider: 'openai-compatible',
      model: 'gpt-4o-mini-review',
      status: 'running',
    },
    select: { id: true },
  });
  return run.id;
}

interface IssueSeed {
  readonly severity: 'high' | 'medium' | 'low';
  readonly type: string;
  readonly evidence: string;
  readonly suggestion: string;
}

/** 把 run 结束为 succeeded，并按顺序写入问题（与工作流落库顺序一致）。 */
async function finishRunSucceeded(
  runId: string,
  options: { readonly passed: boolean; readonly issues: readonly IssueSeed[] },
): Promise<void> {
  const run = await db.chapterReviewRun.findUniqueOrThrow({ where: { id: runId } });
  for (const [ordinal, issue] of options.issues.entries()) {
    await db.chapterReviewIssue.create({
      data: {
        runId,
        workId: run.workId,
        chapterId: run.chapterId,
        candidateId: run.candidateId,
        ordinal,
        severity: issue.severity,
        type: issue.type,
        evidence: issue.evidence,
        suggestion: issue.suggestion,
      },
    });
  }
  await db.chapterReviewRun.update({
    where: { id: runId },
    data: {
      status: 'succeeded',
      passed: options.passed,
      issueCount: options.issues.length,
      finishedAt: new Date(),
    },
  });
}

beforeAll(() => {
  db = getPrismaClient();
});

afterAll(async () => {
  for (const workId of works) {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_review_issues" DISABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_review_runs" DISABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_candidates" DISABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_contracts" DISABLE TRIGGER USER');
        await tx.chapterReviewIssue.deleteMany({ where: { workId } });
        await tx.chapterReviewRun.deleteMany({ where: { workId } });
        await tx.chapterCandidate.deleteMany({ where: { workId } });
        await tx.chapterContract.deleteMany({ where: { workId } });
        await tx.taskContext.deleteMany({ where: { task: { workId } } });
        await tx.generationTask.deleteMany({ where: { workId } });
        await tx.chapter.deleteMany({ where: { workId } });
        await tx.work.deleteMany({ where: { id: workId } });
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_contracts" ENABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_candidates" ENABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_review_runs" ENABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_review_issues" ENABLE TRIGGER USER');
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
  }
});

function getRequest(path: string, options: { token?: string; origin?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
  }
  if (options.origin !== undefined) {
    headers['origin'] = options.origin;
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

async function fetchReview(
  fixture: Fixture,
  candidateId: string,
  options: { token?: string; workId?: string; chapterId?: string; origin?: string } = {},
): Promise<HttpResult> {
  const workId = options.workId ?? fixture.workId;
  const chapterId = options.chapterId ?? fixture.chapterId;
  const token = options.token === undefined ? fixture.token : options.token;
  const path = `/api/works/${workId}/chapters/${chapterId}/candidates/${candidateId}/review`;
  return read(
    await reviewGet(
      getRequest(
        path,
        options.origin === undefined ? { token } : { token, origin: options.origin },
      ),
      { params: Promise.resolve({ id: workId, chapterId, candidateId }) },
    ),
  );
}

interface ReviewBody {
  readonly review: {
    candidateId: string;
    task: {
      id: string;
      status: string;
      currentStep: string | null;
      attemptCount: number;
      errorCode: string | null;
    };
    run: {
      id: string;
      status: string;
      passed: boolean | null;
      issueCount: number;
      errorCode: string | null;
      agentName: string;
      agentVersion: string;
      startedAt: string;
      finishedAt: string | null;
      issues: readonly {
        id: string;
        ordinal: number;
        severity: string;
        type: string;
        evidence: string;
        suggestion: string;
      }[];
    } | null;
  };
}

function reviewOf(result: HttpResult): ReviewBody['review'] {
  return (result.json as unknown as ReviewBody).review;
}

describe('任务状态与 run 快照', () => {
  it('queued 任务 + 尚未创建 run → 200 且 run=null（可轮询）', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    const taskId = await seedReviewTask(candidate, { status: 'queued', attemptCount: 0 });

    const result = await fetchReview(fixture, candidate.candidateId);

    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const review = reviewOf(result);
    expect(review.candidateId).toBe(candidate.candidateId);
    expect(review.task).toEqual({
      id: taskId,
      status: 'queued',
      currentStep: null,
      attemptCount: 0,
      errorCode: null,
    });
    expect(review.run).toBeNull();
  });

  it('processing + running run → 200，passed=null、issues=[]、finishedAt=null', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    const taskId = await seedReviewTask(candidate, {
      status: 'processing',
      currentStep: 'run_reviewer',
    });
    const runId = await seedRunningRun(candidate, taskId);

    const review = reviewOf(await fetchReview(fixture, candidate.candidateId));

    expect(review.task).toMatchObject({
      id: taskId,
      status: 'processing',
      currentStep: 'run_reviewer',
      attemptCount: 1,
    });
    expect(review.run).toMatchObject({
      id: runId,
      status: 'running',
      passed: null,
      issueCount: 0,
      errorCode: null,
      agentName: 'reviewer.chapter',
      agentVersion: '1.0.0',
      finishedAt: null,
      issues: [],
    });
    // 只回显元信息，不泄露 provider / model
    expect(review.run).not.toHaveProperty('provider');
    expect(review.run).not.toHaveProperty('model');
    expect(Number.isNaN(Date.parse(review.run?.startedAt ?? ''))).toBe(false);
  });

  it('succeeded / passed=true → issues=[] 且 issueCount=0', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    const taskId = await seedReviewTask(candidate, {
      status: 'succeeded',
      currentStep: 'persist_review_result',
    });
    const runId = await seedRunningRun(candidate, taskId);
    await finishRunSucceeded(runId, { passed: true, issues: [] });

    const review = reviewOf(await fetchReview(fixture, candidate.candidateId));

    expect(review.task).toMatchObject({
      status: 'succeeded',
      currentStep: 'persist_review_result',
      errorCode: null,
    });
    expect(review.run).toMatchObject({
      status: 'succeeded',
      passed: true,
      issueCount: 0,
      errorCode: null,
      issues: [],
    });
    expect(review.run?.finishedAt).not.toBeNull();
  });

  it('succeeded / passed=false → issues 按 ordinal 升序且字段原样回显', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    const taskId = await seedReviewTask(candidate, { status: 'succeeded' });
    const runId = await seedRunningRun(candidate, taskId);
    await finishRunSucceeded(runId, {
      passed: false,
      issues: [
        {
          severity: 'high',
          type: 'setting_contradiction',
          evidence: '他握紧了手中的剑。',
          suggestion: '与上一章的弃剑设定冲突，请改写。',
        },
        {
          severity: 'medium',
          type: 'timeline_conflict',
          evidence: '风从演武场尽头吹来。',
          suggestion: '时间线需与前章衔接。',
        },
        {
          severity: 'low',
          type: 'prose_quality',
          evidence: '吹动了青石上的尘埃。',
          suggestion: '此处可减少重复描写。',
        },
      ],
    });

    const review = reviewOf(await fetchReview(fixture, candidate.candidateId));

    expect(review.run?.status).toBe('succeeded');
    expect(review.run?.passed).toBe(false);
    expect(review.run?.issueCount).toBe(3);
    const issues = review.run?.issues ?? [];
    expect(issues.map((issue) => issue.ordinal)).toEqual([0, 1, 2]);
    expect(issues.map((issue) => issue.severity)).toEqual(['high', 'medium', 'low']);
    expect(issues.map((issue) => issue.type)).toEqual([
      'setting_contradiction',
      'timeline_conflict',
      'prose_quality',
    ]);
    expect(issues[0]).toMatchObject({
      evidence: '他握紧了手中的剑。',
      suggestion: '与上一章的弃剑设定冲突，请改写。',
    });
    // 问题 id 是 UUID，不重复
    expect(new Set(issues.map((issue) => issue.id)).size).toBe(3);
  });

  it('failed run → passed=null、issues=[]、只回显稳定 errorCode', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    const taskId = await seedReviewTask(candidate, {
      status: 'failed',
      currentStep: 'run_reviewer',
      errorCode: 'MODEL_NETWORK_ERROR',
    });
    const runId = await seedRunningRun(candidate, taskId);
    await db.chapterReviewRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        errorCode: 'MODEL_NETWORK_ERROR',
        finishedAt: new Date(),
      },
    });

    const review = reviewOf(await fetchReview(fixture, candidate.candidateId));

    expect(review.task.status).toBe('failed');
    expect(review.task.errorCode).toBe('MODEL_NETWORK_ERROR');
    expect(review.run).toMatchObject({
      status: 'failed',
      passed: null,
      issueCount: 0,
      errorCode: 'MODEL_NETWORK_ERROR',
      issues: [],
    });
  });

  it('非白名单 errorCode（历史 / 内部值）收敛为 null', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    // 任务行是终态，事后无法改；直接以历史值插入
    const taskId = await seedReviewTask(candidate, {
      status: 'failed',
      errorCode: 'SOME_INTERNAL_DB_DETAIL',
    });
    const runId = await seedRunningRun(candidate, taskId);
    await db.chapterReviewRun.update({
      where: { id: runId },
      data: { status: 'failed', errorCode: 'SOME_INTERNAL_DB_DETAIL', finishedAt: new Date() },
    });

    const result = await fetchReview(fixture, candidate.candidateId);
    const review = reviewOf(result);

    expect(review.task.errorCode).toBeNull();
    expect(review.run?.errorCode).toBeNull();
    expect(result.text).not.toContain('SOME_INTERNAL_DB_DETAIL');
  });

  it('cancelled 任务 → 200，run 由兜底触发器标失败且 passed=null', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    // 取消不写错误码（completeTask 清空 error_code）
    const taskId = await seedReviewTask(candidate, { status: 'cancelled', errorCode: null });
    const runId = await seedRunningRun(candidate, taskId);
    await db.chapterReviewRun.update({
      where: { id: runId },
      data: { status: 'failed', errorCode: 'TASK_CANCELLED', finishedAt: new Date() },
    });

    const review = reviewOf(await fetchReview(fixture, candidate.candidateId));

    expect(review.task.status).toBe('cancelled');
    expect(review.task.errorCode).toBeNull();
    expect(review.run).toMatchObject({
      status: 'failed',
      passed: null,
      errorCode: 'TASK_CANCELLED',
      issues: [],
    });
  });
});

describe('404 与归属隔离', () => {
  it('候选没有审阅任务（A2-C-B 之前的历史候选）→ 404 REVIEW_NOT_FOUND', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);

    const result = await fetchReview(fixture, candidate.candidateId);

    expect(result.status).toBe(404);
    expect((result.json.error as { code: string }).code).toBe('REVIEW_NOT_FOUND');
  });

  it('候选属于另一作品 / 另一章节 → 404 REVIEW_NOT_FOUND', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    await seedReviewTask(candidate);

    // 用另一部作品 + 它的章节查这个候选
    const crossWork = await fetchReview(fixture, candidate.candidateId, {
      workId: fixture.otherWorkId,
      chapterId: fixture.otherChapterId,
    });
    expect(crossWork.status).toBe(404);
    expect((crossWork.json.error as { code: string }).code).toBe('REVIEW_NOT_FOUND');

    // 用同作品的另一章节查
    const crossChapter = await fetchReview(fixture, candidate.candidateId, {
      chapterId: fixture.chapterId2,
    });
    expect(crossChapter.status).toBe(404);
    expect((crossChapter.json.error as { code: string }).code).toBe('REVIEW_NOT_FOUND');
  });

  it('随机 candidateId → 404；非 UUID → 400', async () => {
    const fixture = await createFixture();

    const random = await fetchReview(fixture, randomUUID());
    expect(random.status).toBe(404);
    expect((random.json.error as { code: string }).code).toBe('REVIEW_NOT_FOUND');

    const invalid = await fetchReview(fixture, 'not-a-uuid');
    expect(invalid.status).toBe(400);
    expect((invalid.json.error as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('他人作品 → 404；其它作者访问 → 不存在', async () => {
    const fixture = await createFixture();
    const strangerUser = await createUser('author');
    const strangerWork = await createWork(strangerUser.id, '他人作品-再来一个');
    const strangerChapter = await db.chapter.create({
      data: { workId: strangerWork, chapterNo: 1, title: '他人章节' },
      select: { id: true },
    });
    const strangerCandidate = await seedCandidate({
      workId: strangerWork,
      chapterId: strangerChapter.id,
    });
    await seedReviewTask(strangerCandidate);

    // 作者拿自己的会话查别人的作品 / 候选
    const result = await fetchReview(fixture, strangerCandidate.candidateId, {
      workId: strangerWork,
      chapterId: strangerChapter.id,
    });
    expect(result.status).toBe(404);
    expect((result.json.error as { code: string }).code).toBe('NOT_FOUND');

    // 他人作品 id + 自己的章节
    const mixed = await fetchReview(fixture, strangerCandidate.candidateId, {
      workId: strangerWork,
      chapterId: fixture.chapterId2,
    });
    expect(mixed.status).toBe(404);
  });

  it('同 requestId 但不是 chapter.review 的任务 → 404（不能按 requestId 认领）', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    // 作者可以提交任意 requestId 的生成任务；这里造一个同 requestId 的 draft 任务
    await seedReviewTask(candidate, { status: 'succeeded', taskType: 'chapter.draft' });

    const result = await fetchReview(fixture, candidate.candidateId);

    expect(result.status).toBe(404);
    expect((result.json.error as { code: string }).code).toBe('REVIEW_NOT_FOUND');
  });

  it('任务快照与路径候选不一致 → 404（不返回别人的审阅结果）', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    const otherCandidate = await seedCandidate(fixture);
    await seedReviewTask(candidate, {
      status: 'succeeded',
      inputSnapshot: { candidateId: otherCandidate.candidateId },
    });

    const result = await fetchReview(fixture, candidate.candidateId);

    expect(result.status).toBe(404);
    expect((result.json.error as { code: string }).code).toBe('REVIEW_NOT_FOUND');
  });
});

describe('权限与响应边界', () => {
  it('未登录 → 401；管理员 → 403', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    await seedReviewTask(candidate);

    const anonymous = await fetchReview(fixture, candidate.candidateId, { token: '' });
    expect(anonymous.status).toBe(401);

    const admin = await fetchReview(fixture, candidate.candidateId, { token: fixture.adminToken });
    expect(admin.status).toBe(403);
  });

  it('只读 GET 不依赖 Origin（与其它只读接口一致，便于同源轮询）', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    await seedReviewTask(candidate);

    // GET 不是写操作，不做 CSRF Origin 校验：无 Origin 与带 Origin 都必须成功。
    const withoutOrigin = await fetchReview(fixture, candidate.candidateId);
    expect(withoutOrigin.status).toBe(200);

    const withOrigin = await fetchReview(fixture, candidate.candidateId, {
      origin: 'http://127.0.0.1:3000',
    });
    expect(withOrigin.status).toBe(200);
    expect(withOrigin.text).toBe(withoutOrigin.text);
  });

  it('响应不含正文、prompt、provider / model、inputSnapshot / requestId / 租约字段', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    const taskId = await seedReviewTask(candidate, {
      status: 'succeeded',
      currentStep: 'persist_review_result',
    });
    const runId = await seedRunningRun(candidate, taskId);
    await finishRunSucceeded(runId, {
      passed: false,
      issues: [
        {
          severity: 'high',
          type: 'contract_violation',
          evidence: '他握紧了手中的剑。',
          suggestion: '补上合同要求的场景。',
        },
      ],
    });

    const result = await fetchReview(fixture, candidate.candidateId);

    // 只允许 review { candidateId, task{5}, run{...} } 这些字段
    expect(Object.keys(result.json)).toEqual(['review']);
    const review = reviewOf(result);
    expect(Object.keys(review).sort()).toEqual(['candidateId', 'run', 'task']);
    expect(Object.keys(review.task).sort()).toEqual([
      'attemptCount',
      'currentStep',
      'errorCode',
      'id',
      'status',
    ]);
    expect(Object.keys(review.run ?? {}).sort()).toEqual([
      'agentName',
      'agentVersion',
      'errorCode',
      'finishedAt',
      'id',
      'issueCount',
      'issues',
      'passed',
      'startedAt',
      'status',
    ]);

    // 正文全文（含机密标记）绝不能出现；evidence 是问题证据，允许出现
    expect(result.text).not.toContain(MARKER);
    expect(result.text).not.toContain('他握紧了手中的剑。'.repeat(3));
    for (const forbidden of [
      'provider',
      'model',
      'openai-compatible',
      'gpt-4o-mini-review',
      'inputSnapshot',
      'inputHash',
      'requestId',
      'lockedBy',
      'leaseUntil',
      'attemptToken',
      'prompt',
      'scratchpad',
    ]) {
      expect(result.text).not.toContain(forbidden);
    }
  });

  it('只读请求不写审计、不改 task / run / issue、不写 LLM 日志', async () => {
    const fixture = await createFixture();
    const candidate = await seedCandidate(fixture);
    const taskId = await seedReviewTask(candidate, {
      status: 'succeeded',
      currentStep: 'persist_review_result',
    });
    const runId = await seedRunningRun(candidate, taskId);
    await finishRunSucceeded(runId, {
      passed: false,
      issues: [
        {
          severity: 'medium',
          type: 'character_consistency',
          evidence: '风从演武场尽头吹来。',
          suggestion: '人物语气与前章不一致。',
        },
      ],
    });

    const before = {
      audit: await db.auditLog.count({ where: { action: { startsWith: 'chapter.' } } }),
      task: await db.generationTask.findUniqueOrThrow({ where: { id: taskId } }),
      run: await db.chapterReviewRun.findUniqueOrThrow({ where: { id: runId } }),
      issues: await db.chapterReviewIssue.findMany({
        where: { runId },
        orderBy: { ordinal: 'asc' },
      }),
      llm: await db.llmCallLog.count({ where: { taskId } }),
    };

    const first = await fetchReview(fixture, candidate.candidateId);
    const second = await fetchReview(fixture, candidate.candidateId);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // 幂等：两次读取结果完全一致
    expect(second.text).toBe(first.text);

    const after = {
      audit: await db.auditLog.count({ where: { action: { startsWith: 'chapter.' } } }),
      task: await db.generationTask.findUniqueOrThrow({ where: { id: taskId } }),
      run: await db.chapterReviewRun.findUniqueOrThrow({ where: { id: runId } }),
      issues: await db.chapterReviewIssue.findMany({
        where: { runId },
        orderBy: { ordinal: 'asc' },
      }),
      llm: await db.llmCallLog.count({ where: { taskId } }),
    };

    expect(after.audit).toBe(before.audit);
    expect(after.llm).toBe(before.llm);
    expect(after.task).toEqual(before.task);
    expect(after.run).toEqual(before.run);
    expect(after.issues).toEqual(before.issues);
    // 没有新增任何 task / run
    expect(await db.chapterReviewRun.count({ where: { candidateId: candidate.candidateId } })).toBe(
      1,
    );
    expect(
      await db.generationTask.count({
        where: { chapterId: candidate.chapterId, taskType: 'chapter.review' },
      }),
    ).toBe(1);
  });
});
