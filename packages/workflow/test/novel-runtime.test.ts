/**
 * Coordinator Runtime 真实 PostgreSQL 集成测试（C1-A）。
 *
 * 覆盖：动态问答推进、回答幂等 / 冲突、取消、工具白名单与语义失败、
 * 模型输出重试、循环熔断、步数 / token 预算、租约丢失与过期接管、
 * append-only 触发器、每次实际调用一条日志。
 */

import type { PrismaClient } from '@novel/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  ModelJsonInput,
  ModelJsonResult,
  ModelProvider,
  ModelTextResult,
} from '../src/model-types.js';
import { MockProvider, type MockJsonValue } from '../src/providers/mock.js';
import { createNovelCoordinatorMockProvider } from '../src/novel/coordinator-mock-provider.js';
import { NovelCoordinatorWorker } from '../src/novel/runtime.js';
import {
  answerNovelRun,
  cancelNovelRun,
  readNovelRun,
  startNovelRun,
} from '../src/novel/service.js';
import { cleanupUser, closeTestDb, createTestUser, testDb } from './helpers/db.js';

let db: PrismaClient;
let authorId: string;
const createdRuns: string[] = [];

beforeAll(async () => {
  db = testDb();
  const author = await createTestUser(db, 'author');
  authorId = author.id;
});

beforeEach(() => {
  createdRuns.length = 0;
});

afterEach(async () => {
  if (createdRuns.length === 0) {
    return;
  }
  // 三张表都有 append-only / 不可删除触发器；测试清理在事务内临时禁用，
  // 失败回滚后触发器仍然生效（与该仓库其它集成测试一致）。
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "novel_agent_calls" DISABLE TRIGGER USER');
      await tx.$executeRawUnsafe('ALTER TABLE "novel_run_steps" DISABLE TRIGGER USER');
      await tx.$executeRawUnsafe('ALTER TABLE "novel_runs" DISABLE TRIGGER USER');
      await tx.novelAgentCall.deleteMany({ where: { runId: { in: createdRuns } } });
      await tx.novelRunStep.deleteMany({ where: { runId: { in: createdRuns } } });
      await tx.novelRun.deleteMany({ where: { id: { in: createdRuns } } });
      await tx.$executeRawUnsafe('ALTER TABLE "novel_runs" ENABLE TRIGGER USER');
      await tx.$executeRawUnsafe('ALTER TABLE "novel_run_steps" ENABLE TRIGGER USER');
      await tx.$executeRawUnsafe('ALTER TABLE "novel_agent_calls" ENABLE TRIGGER USER');
    },
    { maxWait: 15_000, timeout: 30_000 },
  );
});

afterAll(async () => {
  await cleanupUser(db, authorId);
  await closeTestDb();
});

const ASK_ACTION = {
  action: 'ask_user',
  objective: '确定题材',
  input: {
    question: '你想写哪一种题材的小说？',
    options: ['东方玄幻', '都市异能'],
    finishReason: null,
  },
  decisionSummary: '先确认题材。',
} as const;

function fixedProvider(action: unknown): MockProvider {
  return new MockProvider({ json: action as MockJsonValue, model: 'mock-coordinator' });
}

function coordinatorWorker(
  provider: ModelProvider,
  overrides: Partial<ConstructorParameters<typeof NovelCoordinatorWorker>[1]> = {},
): NovelCoordinatorWorker {
  return new NovelCoordinatorWorker(db, {
    provider,
    workerId: 'test-worker',
    leaseMs: 5_000,
    heartbeatIntervalMs: 1_000,
    sweepIntervalMs: 1,
    ...overrides,
  });
}

async function trackRun(requestText: string): Promise<string> {
  const created = await startNovelRun(db, { authorId, requestText });
  createdRuns.push(created.runId);
  return created.runId;
}

async function counts(
  runId: string,
): Promise<{ steps: number; calls: number; succeededCalls: number }> {
  const [steps, calls, succeededCalls] = await Promise.all([
    db.novelRunStep.count({ where: { runId } }),
    db.novelAgentCall.count({ where: { runId } }),
    db.novelAgentCall.count({ where: { runId, success: true } }),
  ]);
  return { steps, calls, succeededCalls };
}

async function rawStatus(
  runId: string,
): Promise<{ status: string; version: number; lockedBy: string | null }> {
  const row = await db.novelRun.findUniqueOrThrow({
    where: { id: runId },
    select: { status: true, stateVersion: true, lockedBy: true },
  });
  return { status: row.status, version: row.stateVersion, lockedBy: row.lockedBy };
}

/** 返回 Schema 非法再返回合法 action；用于验证"每次实际调用恰好一条日志"。 */
class FlakySchemaProvider implements ModelProvider {
  readonly name = 'flaky';
  readonly defaultModel = 'flaky-model';
  calls = 0;

  generateJson(input: ModelJsonInput): Promise<ModelJsonResult> {
    this.calls += 1;
    const json = this.calls === 1 ? { unexpected: true } : ASK_ACTION;
    return Promise.resolve({
      json,
      provider: this.name,
      model: input.model,
      usage: { promptTokens: 10, completionTokens: 10 },
      latencyMs: 0,
    });
  }

  generateText(): Promise<ModelTextResult> {
    throw new Error('不支持文本输出');
  }
}

/** 可阻塞的真实调用：用于旧 Worker 晚返回。 */
class GatedProvider implements ModelProvider {
  readonly name = 'gated';
  readonly defaultModel = 'gated-model';
  private releaseGate: (() => void) | null = null;
  readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  release(): void {
    this.releaseGate?.();
  }

  generateJson(input: ModelJsonInput): Promise<ModelJsonResult> {
    return this.gate.then(() => ({
      json: ASK_ACTION,
      provider: this.name,
      model: input.model,
      usage: { promptTokens: 10, completionTokens: 10 },
      latencyMs: 0,
    }));
  }

  generateText(): Promise<ModelTextResult> {
    throw new Error('不支持文本输出');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await sleep(10);
  }
  throw new Error('等待超时');
}

describe('动态问答主路径', () => {
  it('queued → waiting_user：只写一个问题，并记录一次调用', async () => {
    const runId = await trackRun('写一个东方玄幻故事');
    const before = await readNovelRun(db, { authorId, runId });
    expect(before.status).toBe('queued');
    expect(before.version).toBe(0);
    expect(before.question).toBeNull();

    const outcome = await coordinatorWorker(createNovelCoordinatorMockProvider()).runOnce();
    expect(outcome).toBe('waiting_user');

    const after = await readNovelRun(db, { authorId, runId });
    expect(after.status).toBe('waiting_user');
    expect(after.version).toBe(1);
    expect(after.stepCount).toBe(1);
    expect(after.question).not.toBeNull();
    expect(after.options.length).toBeGreaterThan(0);
    expect(after.currentGoal.length).toBeGreaterThan(0);

    const callRows = await counts(runId);
    expect(callRows.steps).toBe(1);
    expect(callRows.calls).toBe(1);
    expect(callRows.succeededCalls).toBe(1);
    const call = await db.novelAgentCall.findFirstOrThrow({ where: { runId } });
    expect(call.stepId).not.toBeNull();
    expect(call.callKind).toBe('coordinator');
    expect(call.agentName).toBe('novel.coordinator');
    expect(call.provider).toBe('mock');
    expect(call.model).toBe('mock-coordinator');
  });

  it('回答推进到下一问，明确结束口令进入 completed', async () => {
    const runId = await trackRun('写一个东方玄幻故事');
    const worker = coordinatorWorker(createNovelCoordinatorMockProvider());
    expect(await worker.runOnce()).toBe('waiting_user');

    const firstQuestion = (await readNovelRun(db, { authorId, runId })).question;
    const queued = await answerNovelRun(db, {
      authorId,
      runId,
      expectedVersion: 1,
      answer: '东方玄幻',
    });
    expect(queued.status).toBe('queued');
    expect(queued.version).toBe(2);

    expect(await worker.runOnce()).toBe('waiting_user');
    const second = await readNovelRun(db, { authorId, runId });
    expect(second.version).toBe(3);
    expect(second.question).not.toBe(firstQuestion);
    expect(second.stepCount).toBe(2);

    const queuedAgain = await answerNovelRun(db, {
      authorId,
      runId,
      expectedVersion: second.version,
      answer: '先到这里',
    });
    expect(queuedAgain.status).toBe('queued');
    expect(queuedAgain.version).toBe(4);

    expect(await worker.runOnce()).toBe('completed');
    const completed = await readNovelRun(db, { authorId, runId });
    expect(completed.status).toBe('completed');
    expect(completed.version).toBe(5);
    expect(completed.stepCount).toBe(3);
    expect(completed.question).toBeNull();
  });

  it('同版本同答案幂等；同版本不同答案 409；旧版本 409', async () => {
    const runId = await trackRun('写一个悬疑故事');
    const worker = coordinatorWorker(createNovelCoordinatorMockProvider());
    await worker.runOnce();
    const queued = await answerNovelRun(db, {
      authorId,
      runId,
      expectedVersion: 1,
      answer: '悬疑推理',
    });
    await worker.runOnce();

    const current = await readNovelRun(db, { authorId, runId });
    const repeat = await answerNovelRun(db, {
      authorId,
      runId,
      expectedVersion: 1,
      answer: '悬疑推理',
    });
    expect(repeat.status).toBe(current.status);
    expect(repeat.version).toBe(current.version);

    await expect(
      answerNovelRun(db, { authorId, runId, expectedVersion: 1, answer: '都市异能' }),
    ).rejects.toMatchObject({ code: 'NOVEL_RUN_ANSWER_CONFLICT' });
    await expect(
      answerNovelRun(db, { authorId, runId, expectedVersion: 0, answer: '悬疑推理' }),
    ).rejects.toMatchObject({ code: 'NOVEL_RUN_VERSION_CONFLICT' });
    expect(queued.version).toBe(2);
  });

  it('非 waiting_user 状态回答返回 NOVEL_RUN_INVALID_STATE', async () => {
    const runId = await trackRun('写一个故事');
    await expect(
      answerNovelRun(db, { authorId, runId, expectedVersion: 0, answer: '随便' }),
    ).rejects.toMatchObject({ code: 'NOVEL_RUN_INVALID_STATE' });
  });
});

describe('取消与越权', () => {
  it('queued / waiting_user 可取消，终态取消幂等', async () => {
    const runId = await trackRun('写一个故事');
    const queuedCancel = await cancelNovelRun(db, { authorId, runId });
    expect(queuedCancel.status).toBe('cancelled');
    expect(queuedCancel.version).toBe(1);
    const row = await db.novelRun.findUniqueOrThrow({
      where: { id: runId },
      select: { completedAt: true, cancelRequestedAt: true },
    });
    expect(row.completedAt).not.toBeNull();
    expect(row.cancelRequestedAt).not.toBeNull();

    const again = await cancelNovelRun(db, { authorId, runId });
    expect(again.status).toBe('cancelled');
    expect(again.version).toBe(1);
  });

  it('他人 run 与畸形 id 一律 NOVEL_RUN_NOT_FOUND', async () => {
    const runId = await trackRun('写一个故事');
    const other = await createTestUser(db, 'author');
    try {
      await expect(readNovelRun(db, { authorId: other.id, runId })).rejects.toMatchObject({
        code: 'NOVEL_RUN_NOT_FOUND',
      });
      await expect(readNovelRun(db, { authorId, runId: 'not-a-uuid' })).rejects.toMatchObject({
        code: 'NOVEL_RUN_NOT_FOUND',
      });
    } finally {
      await cleanupUser(db, other.id);
    }
  });
});

describe('工具白名单、语义失败与预算', () => {
  it('语义非法的 action 使用剩余 attempt 重试，耗尽后 failed 并记录失败调用', async () => {
    const runId = await trackRun('写一个故事');
    const badAction = {
      ...ASK_ACTION,
      input: { ...ASK_ACTION.input, question: 'SELECT * FROM novel_runs' },
    };
    const worker = coordinatorWorker(fixedProvider(badAction), { maxAttempts: 3 });

    expect(await worker.runOnce()).toBe('failed');
    const view = await readNovelRun(db, { authorId, runId });
    expect(view.status).toBe('failed');
    expect(view.version).toBe(1);

    const rows = await counts(runId);
    expect(rows.calls).toBe(3);
    expect(rows.succeededCalls).toBe(0);
    expect(rows.steps).toBe(1);
    const step = await db.novelRunStep.findFirstOrThrow({ where: { runId } });
    expect(step.status).toBe('failed');
    expect(step.errorCode).toBe('AGENT_OUTPUT_INVALID');
  });

  it('每次实际模型调用恰好一条日志：Schema 非法一次 + 成功一次', async () => {
    const runId = await trackRun('写一个故事');
    const provider = new FlakySchemaProvider();
    const worker = coordinatorWorker(provider);
    expect(await worker.runOnce()).toBe('waiting_user');
    expect(provider.calls).toBe(2);

    const calls = await db.novelAgentCall.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.success).toBe(false);
    expect(calls[0]?.errorCode).toBe('AGENT_OUTPUT_INVALID');
    expect(calls[1]?.success).toBe(true);
    expect(await db.novelRunStep.count({ where: { runId } })).toBe(1);
  });

  it('连续重复同一 action 触发 COORDINATOR_LOOP_DETECTED', async () => {
    const runId = await trackRun('写一个故事');
    const worker = coordinatorWorker(fixedProvider(ASK_ACTION));
    expect(await worker.runOnce()).toBe('waiting_user');
    await answerNovelRun(db, { authorId, runId, expectedVersion: 1, answer: '继续' });
    expect(await worker.runOnce()).toBe('waiting_user');
    await answerNovelRun(db, { authorId, runId, expectedVersion: 3, answer: '继续' });
    expect(await worker.runOnce()).toBe('failed');

    const view = await readNovelRun(db, { authorId, runId });
    expect(view.status).toBe('failed');
    const step = await db.novelRunStep.findFirstOrThrow({
      where: { runId },
      orderBy: { stepNo: 'desc' },
    });
    expect(step.errorCode).toBe('COORDINATOR_LOOP_DETECTED');
    expect(await db.novelRunStep.count({ where: { runId } })).toBe(3);
  });

  it('token 预算耗尽后 failed，不调用模型、不新增调用日志', async () => {
    const runId = await trackRun('写一个故事');
    const worker = coordinatorWorker(createNovelCoordinatorMockProvider(), { tokenBudget: 1 });
    expect(await worker.runOnce()).toBe('waiting_user');
    await answerNovelRun(db, { authorId, runId, expectedVersion: 1, answer: '东方玄幻' });

    expect(await worker.runOnce()).toBe('failed');
    const view = await readNovelRun(db, { authorId, runId });
    expect(view.status).toBe('failed');
    const step = await db.novelRunStep.findFirstOrThrow({
      where: { runId },
      orderBy: { stepNo: 'desc' },
    });
    expect(step.errorCode).toBe('NOVEL_RUN_BUDGET_EXCEEDED');
    expect(await db.novelAgentCall.count({ where: { runId } })).toBe(1);
  });

  it('步数预算耗尽时 failed，不写超过 max_steps 的步骤', async () => {
    // max_steps 不可变，预算用例只能从创建时指定。
    const created = await db.novelRun.create({
      data: { authorId, status: 'queued', requestText: '写一个故事', maxSteps: 1 },
      select: { id: true },
    });
    createdRuns.push(created.id);
    const runId = created.id;

    const worker = coordinatorWorker(createNovelCoordinatorMockProvider());
    expect(await worker.runOnce()).toBe('waiting_user');
    await answerNovelRun(db, { authorId, runId, expectedVersion: 1, answer: '东方玄幻' });

    expect(await worker.runOnce()).toBe('failed');
    const view = await readNovelRun(db, { authorId, runId });
    expect(view.status).toBe('failed');
    const rows = await counts(runId);
    expect(rows.steps).toBe(1);
    expect(rows.calls).toBe(1);
  });
});

describe('租约与并发', () => {
  it('旧 Worker 晚返回丢弃提交，不写 step / call / 状态', async () => {
    const runId = await trackRun('写一个故事');
    const provider = new GatedProvider();
    const worker = coordinatorWorker(provider, {
      workerId: 'worker-old',
      heartbeatIntervalMs: 5_000,
    });

    const pending = worker.runOnce();
    await waitFor(async () => (await rawStatus(runId)).lockedBy === 'worker-old');

    // 模拟另一个 Worker 接管：只改 locked_by，不改状态与版本。
    await db.$executeRaw`
      UPDATE "novel_runs" SET "locked_by" = 'worker-thief' WHERE "id" = ${runId}::uuid
    `;
    provider.release();

    expect(await pending).toBe('lease-lost');
    const rows = await counts(runId);
    expect(rows.steps).toBe(0);
    expect(rows.calls).toBe(0);
    const view = await readNovelRun(db, { authorId, runId });
    expect(view.status).toBe('running');
    expect(view.version).toBe(0);
    expect(view.question).toBeNull();
  });

  it('过期租约被回收后由新 Worker 接管', async () => {
    const runId = await trackRun('写一个故事');
    await db.$executeRaw`
      UPDATE "novel_runs"
         SET "status" = 'running',
             "locked_by" = 'dead-worker',
             "lease_until" = clock_timestamp() - interval '1 second',
             "heartbeat_at" = clock_timestamp() - interval '1 minute'
       WHERE "id" = ${runId}::uuid
    `;

    const worker = coordinatorWorker(createNovelCoordinatorMockProvider(), {
      workerId: 'new-worker',
      sweepIntervalMs: 1,
    });
    expect(await worker.runOnce()).toBe('waiting_user');

    const row = await db.novelRun.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true, lockedBy: true, completedAt: true },
    });
    expect(row.status).toBe('waiting_user');
    expect(row.lockedBy).toBeNull();
    expect(row.completedAt).toBeNull();
    const view = await readNovelRun(db, { authorId, runId });
    expect(view.version).toBe(2);
  });
});

describe('append-only 与不可变字段', () => {
  it('step 与 call 的 UPDATE / DELETE 被触发器拒绝', async () => {
    const runId = await trackRun('写一个故事');
    await coordinatorWorker(createNovelCoordinatorMockProvider()).runOnce();

    const step = await db.novelRunStep.findFirstOrThrow({ where: { runId } });
    const call = await db.novelAgentCall.findFirstOrThrow({ where: { runId } });

    await expect(
      db.novelRunStep.update({ where: { id: step.id }, data: { toolName: 'finish' } }),
    ).rejects.toThrow();
    await expect(db.novelRunStep.delete({ where: { id: step.id } })).rejects.toThrow();
    await expect(
      db.novelAgentCall.update({ where: { id: call.id }, data: { success: false } }),
    ).rejects.toThrow();
    await expect(db.novelAgentCall.delete({ where: { id: call.id } })).rejects.toThrow();
  });

  it('非法状态迁移与请求文本改写被 CHECK / 触发器拒绝', async () => {
    const runId = await trackRun('写一个故事');
    await coordinatorWorker(createNovelCoordinatorMockProvider()).runOnce();

    await expect(
      db.$executeRaw`UPDATE "novel_runs" SET "status" = 'failed' WHERE "id" = ${runId}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE "novel_runs" SET "request_text" = '改写' WHERE "id" = ${runId}::uuid`,
    ).rejects.toThrow();
  });
});
