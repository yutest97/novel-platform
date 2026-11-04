/**
 * PostgreSQL 任务队列（A1-1）。
 *
 * 覆盖：创建幂等、作品/章节隔离、领取互斥、心跳续租、fencing、
 * 重试与终态、取消、过期回收、上下文与 LLM 日志不存敏感内容。
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@novel/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  claimNextTask,
  completeTask,
  createGenerationTask,
  failTask,
  getGenerationTaskForAuthor,
  heartbeatTask,
  listTaskContexts,
  markTaskCancelled,
  recordLlmCall,
  requestTaskCancellationForAuthor,
  sweepExpiredTasks,
  upsertTaskContext,
} from '../src/queue.js';
import {
  cleanupUser,
  cleanupWork,
  closeTestDb,
  createTestChapter,
  createTestUser,
  createTestWork,
  testDb,
} from './helpers/db.js';

let db: PrismaClient;
let authorId: string;
let otherAuthorId: string;
let adminId: string;
let workId: string;
let chapterId: string;
/** 单个用例内额外创建的作品（afterEach 一并清理）。 */
let extraWorkIds: string[] = [];

const WORKER_A = 'worker-a';
const WORKER_B = 'worker-b';

function taskInput(overrides: Partial<Parameters<typeof createGenerationTask>[1]> = {}) {
  return {
    authorId,
    workId,
    chapterId,
    requestId: `req-${randomUUID()}`,
    taskType: 'test.flow',
    inputSnapshot: { chapterNo: 1 },
    provider: 'mock',
    model: 'mock-model',
    ...overrides,
  };
}

async function expireLease(taskId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE generation_tasks
       SET lease_until = clock_timestamp() - interval '1 second'
     WHERE id = ${taskId}
  `;
}

beforeAll(async () => {
  db = testDb();
  const author = await createTestUser(db, 'author');
  const other = await createTestUser(db, 'author');
  const admin = await createTestUser(db, 'admin');
  authorId = author.id;
  otherAuthorId = other.id;
  adminId = admin.id;
});

/**
 * 每个用例独立作品：`claimNextTask` 按 created_at 取最早 queued，
 * 共用作品会让上个用例遗留的 queued 任务被错误领取。
 */
beforeEach(async () => {
  extraWorkIds = [];
  const work = await createTestWork(db, authorId);
  workId = work.id;
  const chapter = await createTestChapter(db, workId, 1);
  chapterId = chapter.id;
});

afterEach(async () => {
  await cleanupWork(db, workId);
  for (const extra of extraWorkIds) {
    await cleanupWork(db, extra);
  }
});

afterAll(async () => {
  await cleanupUser(db, authorId);
  await cleanupUser(db, otherAuthorId);
  await cleanupUser(db, adminId);
  await closeTestDb();
});

describe('创建任务（幂等 + 权限）', () => {
  it('同 work_id + request_id 并发创建只产生一行', async () => {
    const requestId = `req-${randomUUID()}`;
    const [first, second] = await Promise.all([
      createGenerationTask(db, taskInput({ requestId })),
      createGenerationTask(db, taskInput({ requestId })),
    ]);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(first.task.id).toBe(second.task.id);
    const count = await db.generationTask.count({ where: { workId, requestId } });
    expect(count).toBe(1);
    expect(first.task.status).toBe('queued');
    expect(first.task.attemptCount).toBe(0);
  });

  it('非作品所有者 / 管理员一律 404', async () => {
    await expect(
      createGenerationTask(db, taskInput({ authorId: otherAuthorId })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createGenerationTask(db, taskInput({ authorId: adminId }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('章节必须属于同一作品', async () => {
    const foreignWork = await createTestWork(db, otherAuthorId);
    extraWorkIds.push(foreignWork.id);
    const foreignChapter = await createTestChapter(db, foreignWork.id, 1);
    await expect(
      createGenerationTask(db, taskInput({ chapterId: foreignChapter.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('参数与快照大小受限', async () => {
    await expect(createGenerationTask(db, taskInput({ requestId: '' }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      createGenerationTask(db, taskInput({ inputSnapshot: { text: 'x'.repeat(70_000) } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('作者读取：本人可见，他人 / 管理员 404', async () => {
    const { task } = await createGenerationTask(db, taskInput());
    await expect(
      getGenerationTaskForAuthor(db, { authorId, workId, taskId: task.id }),
    ).resolves.toMatchObject({ id: task.id });
    await expect(
      getGenerationTaskForAuthor(db, { authorId: otherAuthorId, workId, taskId: task.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      getGenerationTaskForAuthor(db, { authorId: adminId, workId, taskId: task.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('request_id + input_hash 幂等', () => {
  it('同 requestId + 同内容（key 顺序不同）返回既有任务', async () => {
    const requestId = `req-${randomUUID()}`;
    const first = await createGenerationTask(
      db,
      taskInput({
        requestId,
        inputSnapshot: { chapterNo: 1, options: { tone: 'plain', length: 100 } },
      }),
    );
    const second = await createGenerationTask(
      db,
      taskInput({
        requestId,
        inputSnapshot: { options: { length: 100, tone: 'plain' }, chapterNo: 1 },
      }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.inputHash).toBe(first.task.inputHash);
    expect(first.task.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await db.generationTask.count({ where: { workId, requestId } })).toBe(1);
  });

  it('六个语义字段任一变化 → TASK_REQUEST_CONFLICT，不覆盖也不新建', async () => {
    const requestId = `req-${randomUUID()}`;
    const base: Parameters<typeof createGenerationTask>[1] = taskInput({
      requestId,
      inputSnapshot: { alpha: 1, beta: { gamma: 2 } },
    });
    const first = await createGenerationTask(db, base);

    const variants: { label: string; overrides: Partial<typeof base> }[] = [
      { label: 'chapterId', overrides: { chapterId: null } },
      { label: 'taskType', overrides: { taskType: 'test.other' } },
      { label: 'inputSnapshot', overrides: { inputSnapshot: { alpha: 2 } } },
      { label: 'provider', overrides: { provider: 'openai-compatible' } },
      { label: 'model', overrides: { model: 'other-model' } },
      { label: 'maxAttempts', overrides: { maxAttempts: 5 } },
    ];

    for (const { label, overrides } of variants) {
      await expect(
        createGenerationTask(db, { ...base, ...overrides }),
        label,
      ).rejects.toMatchObject({ code: 'TASK_REQUEST_CONFLICT' });
    }

    const row = await db.generationTask.findUniqueOrThrow({ where: { id: first.task.id } });
    expect(row.inputHash).toBe(first.task.inputHash);
    expect(row.inputSnapshot).toEqual({ alpha: 1, beta: { gamma: 2 } });
    expect(await db.generationTask.count({ where: { workId, requestId } })).toBe(1);
  });

  it('并发同 requestId + 不同内容：只有一行任务与一个冲突', async () => {
    const requestId = `req-${randomUUID()}`;
    const results = await Promise.allSettled([
      createGenerationTask(db, taskInput({ requestId, inputSnapshot: { variant: 'a' } })),
      createGenerationTask(db, taskInput({ requestId, inputSnapshot: { variant: 'b' } })),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toMatchObject({ code: 'TASK_REQUEST_CONFLICT' });
    }
    expect(await db.generationTask.count({ where: { workId, requestId } })).toBe(1);
  });

  it('input_hash 只存 64 位摘要；不可稳定序列化的快照被拒绝且不建行', async () => {
    const requestId = `req-${randomUUID()}`;
    const { task } = await createGenerationTask(
      db,
      taskInput({ requestId, inputSnapshot: { secret: 'sk-live-SECRET' } }),
    );

    expect(task.inputHash).toHaveLength(64);
    const rows = await db.$queryRaw<{ hash: string; len: number }[]>`
      SELECT input_hash AS hash, char_length(input_hash)::int AS len
        FROM generation_tasks WHERE id = ${task.id}
    `;
    expect(rows[0]?.len).toBe(64);
    expect(rows[0]?.hash).toBe(task.inputHash);
    expect(rows[0]?.hash).not.toContain('sk-live');

    // 数据库兜底：长度不是 64 的摘要不能落库
    await expect(
      db.$executeRaw`UPDATE generation_tasks SET input_hash = 'too-short' WHERE id = ${task.id}`,
    ).rejects.toThrow();

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const snapshot of [{ a: undefined }, { fn: () => 1 }, { n: 1n }, cyclic]) {
      await expect(
        createGenerationTask(
          db,
          taskInput({ requestId: `req-${randomUUID()}`, inputSnapshot: snapshot }),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(await db.generationTask.count({ where: { workId, requestId } })).toBe(1);
  });
});

describe('章节与作品的隔离', () => {
  it('同一作品内章号唯一；不同作品可有相同章号', async () => {
    await expect(createTestChapter(db, workId, 1)).rejects.toThrow();
    const foreignWork = await createTestWork(db, otherAuthorId);
    extraWorkIds.push(foreignWork.id);
    const other = await createTestChapter(db, foreignWork.id, 1);
    expect(other.chapterNo).toBe(1);
  });

  it('按 work_id 查询只返回本作品的章节', async () => {
    const foreignWork = await createTestWork(db, otherAuthorId);
    extraWorkIds.push(foreignWork.id);
    await createTestChapter(db, foreignWork.id, 1);

    const rows = await db.chapter.findMany({ where: { workId } });
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.workId === workId)).toBe(true);
  });
});

describe('领取 / 心跳 / 完成（fencing）', () => {
  it('两个 Worker 并发领取同一任务只有一个成功', async () => {
    await createGenerationTask(db, taskInput());
    const [a, b] = await Promise.all([
      claimNextTask(db, { workerId: WORKER_A, leaseMs: 5_000 }),
      claimNextTask(db, { workerId: WORKER_B, leaseMs: 5_000 }),
    ]);
    const claimed = [a, b].filter((task) => task !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('processing');
    expect(claimed[0]?.attemptCount).toBe(1);
  });

  it('心跳延长租约；租约被抢占后旧 Worker 的写入全部失败', async () => {
    const { task } = await createGenerationTask(db, taskInput());
    const claimed = await claimNextTask(db, { workerId: WORKER_A, leaseMs: 2_000 });
    expect(claimed?.id).toBe(task.id);

    const before = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    await heartbeatTask(db, { taskId: task.id, workerId: WORKER_A, leaseMs: 5_000 });
    const after = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.heartbeatAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
      before.heartbeatAt?.getTime() ?? 0,
    );
    expect(after.leaseUntil?.getTime() ?? 0).toBeGreaterThan(
      (before.leaseUntil?.getTime() ?? 0) + 2_000,
    );

    // 模拟租约过期 → 被 B 接管
    await expireLease(task.id);
    const swept = await sweepExpiredTasks(db);
    expect(swept.requeued).toBeGreaterThanOrEqual(1);
    const reclaimed = await claimNextTask(db, { workerId: WORKER_B, leaseMs: 5_000 });
    expect(reclaimed?.id).toBe(task.id);

    // A 的 fencing 写入全部 0 行
    await expect(
      heartbeatTask(db, { taskId: task.id, workerId: WORKER_A, leaseMs: 5_000 }),
    ).resolves.toBe(false);
    await expect(completeTask(db, { taskId: task.id, workerId: WORKER_A })).resolves.toBe('lost');
    await expect(markTaskCancelled(db, { taskId: task.id, workerId: WORKER_A })).resolves.toBe(
      false,
    );
    await expect(
      failTask(db, {
        taskId: task.id,
        workerId: WORKER_A,
        errorCode: 'WORKFLOW_STEP_FAILED',
        message: 'x',
        retryable: false,
      }),
    ).resolves.toBe('lost');
  });

  it('完成后进入终态，且不可再修改', async () => {
    const { task } = await createGenerationTask(db, taskInput());
    await claimNextTask(db, { workerId: WORKER_A, leaseMs: 5_000 });
    await expect(completeTask(db, { taskId: task.id, workerId: WORKER_A })).resolves.toBe(
      'succeeded',
    );

    const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('succeeded');
    expect(row.lockedBy).toBeNull();
    expect(row.leaseUntil).toBeNull();

    await expect(
      db.generationTask.update({ where: { id: task.id }, data: { errorCode: 'X' } }),
    ).rejects.toThrow();
  });
});

describe('状态机', () => {
  it('queued → succeeded 非法迁移被数据库拒绝', async () => {
    const { task } = await createGenerationTask(db, taskInput());
    await expect(
      db.$executeRaw`UPDATE generation_tasks SET status = 'succeeded' WHERE id = ${task.id}`,
    ).rejects.toThrow();
  });

  it('queued → cancelled 合法（作者取消，尚未领取）', async () => {
    const { task } = await createGenerationTask(db, taskInput());
    const cancelled = await requestTaskCancellationForAuthor(db, {
      authorId,
      workId,
      taskId: task.id,
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelRequestedAt).not.toBeNull();
  });

  it('processing 时取消只写标志，Worker 确认后才进入 cancelled', async () => {
    const { task } = await createGenerationTask(db, taskInput());
    await claimNextTask(db, { workerId: WORKER_A, leaseMs: 5_000 });

    const requested = await requestTaskCancellationForAuthor(db, {
      authorId,
      workId,
      taskId: task.id,
    });
    expect(requested.status).toBe('processing');
    expect(requested.cancelRequestedAt).not.toBeNull();

    await expect(markTaskCancelled(db, { taskId: task.id, workerId: WORKER_B })).resolves.toBe(
      false,
    );
    await expect(markTaskCancelled(db, { taskId: task.id, workerId: WORKER_A })).resolves.toBe(
      true,
    );
    const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('cancelled');
  });
});

describe('重试与失败', () => {
  it('可重试错误在次数用尽前回到 queued，用尽后 failed', async () => {
    const { task } = await createGenerationTask(db, taskInput({ maxAttempts: 2 }));

    await claimNextTask(db, { workerId: WORKER_A, leaseMs: 5_000 });
    await expect(
      failTask(db, {
        taskId: task.id,
        workerId: WORKER_A,
        errorCode: 'MODEL_TIMEOUT',
        message: '模型服务超时',
        retryable: true,
      }),
    ).resolves.toBe('queued');

    let row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('queued');
    expect(row.attemptCount).toBe(1);
    expect(row.errorCode).toBe('MODEL_TIMEOUT');

    await claimNextTask(db, { workerId: WORKER_A, leaseMs: 5_000 });
    await expect(
      failTask(db, {
        taskId: task.id,
        workerId: WORKER_A,
        errorCode: 'MODEL_TIMEOUT',
        message: '模型服务超时',
        retryable: true,
      }),
    ).resolves.toBe('failed');

    row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('failed');
    expect(row.attemptCount).toBe(2);
    expect(row.lockedBy).toBeNull();
  });

  it('不可重试错误一次即 failed', async () => {
    const { task } = await createGenerationTask(db, taskInput({ maxAttempts: 5 }));
    await claimNextTask(db, { workerId: WORKER_A, leaseMs: 5_000 });
    await expect(
      failTask(db, {
        taskId: task.id,
        workerId: WORKER_A,
        errorCode: 'TASK_INPUT_INVALID',
        message: '输入不合法',
        retryable: false,
      }),
    ).resolves.toBe('failed');
    const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('failed');
    expect(row.attemptCount).toBe(1);
  });
});

describe('取消优先于完成与失败', () => {
  it('processing 中取消后 completeTask → cancelled，不写 succeeded', async () => {
    const { task } = await createGenerationTask(db, taskInput());
    await claimNextTask(db, { workerId: WORKER_A, leaseMs: 5_000 });
    await requestTaskCancellationForAuthor(db, { authorId, workId, taskId: task.id });

    await expect(completeTask(db, { taskId: task.id, workerId: WORKER_A })).resolves.toBe(
      'cancelled',
    );

    const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('cancelled');
    expect(row.lockedBy).toBeNull();
    expect(row.leaseUntil).toBeNull();
    expect(row.errorCode).toBeNull();
    expect(row.errorMessageSanitized).toBeNull();
  });

  it('取消标志下 failTask 即使可重试且仍有次数也进入 cancelled，不 requeue', async () => {
    const { task } = await createGenerationTask(db, taskInput({ maxAttempts: 5 }));
    await claimNextTask(db, { workerId: WORKER_A, leaseMs: 5_000 });
    await requestTaskCancellationForAuthor(db, { authorId, workId, taskId: task.id });

    await expect(
      failTask(db, {
        taskId: task.id,
        workerId: WORKER_A,
        errorCode: 'MODEL_TIMEOUT',
        message: '模型服务超时',
        retryable: true,
      }),
    ).resolves.toBe('cancelled');

    const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('cancelled');
    expect(row.attemptCount).toBe(1);
    expect(row.errorCode).toBeNull();
    expect(row.errorMessageSanitized).toBeNull();
    expect(row.lockedBy).toBeNull();
    expect(row.leaseUntil).toBeNull();

    // 不会重新进入队列
    await expect(claimNextTask(db, { workerId: WORKER_B, leaseMs: 5_000 })).resolves.toBeNull();
  });

  it('取消 + 租约过期 → sweep 进入 cancelled，不留下永久 processing', async () => {
    const { task } = await createGenerationTask(db, taskInput());
    await claimNextTask(db, { workerId: WORKER_A, leaseMs: 5_000 });
    await requestTaskCancellationForAuthor(db, { authorId, workId, taskId: task.id });
    await expireLease(task.id);

    const swept = await sweepExpiredTasks(db);
    expect(swept.cancelled).toBeGreaterThanOrEqual(1);

    const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('cancelled');
    expect(row.lockedBy).toBeNull();
    expect(row.leaseUntil).toBeNull();
    expect(row.errorCode).toBeNull();
  });
});

describe('过期租约回收', () => {
  it('取消优先 → 次数用尽失败 → 其余重新排队', async () => {
    const cancelled = await createGenerationTask(db, taskInput());
    const exhausted = await createGenerationTask(db, taskInput({ maxAttempts: 1 }));
    const retryable = await createGenerationTask(db, taskInput({ maxAttempts: 5 }));

    for (const [index, item] of [cancelled, exhausted, retryable].entries()) {
      await claimNextTask(db, { workerId: `sweep-${index}`, leaseMs: 5_000 });
      await expireLease(item.task.id);
    }

    await db.generationTask.update({
      where: { id: cancelled.task.id },
      data: { cancelRequestedAt: new Date() },
    });

    const result = await sweepExpiredTasks(db);
    expect(result.cancelled).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.requeued).toBeGreaterThanOrEqual(1);

    const cancelRow = await db.generationTask.findUniqueOrThrow({
      where: { id: cancelled.task.id },
    });
    expect(cancelRow.status).toBe('cancelled');
    expect(cancelRow.lockedBy).toBeNull();

    const failedRow = await db.generationTask.findUniqueOrThrow({
      where: { id: exhausted.task.id },
    });
    expect(failedRow.status).toBe('failed');
    expect(failedRow.errorCode).toBe('LEASE_EXHAUSTED');

    const retryRow = await db.generationTask.findUniqueOrThrow({
      where: { id: retryable.task.id },
    });
    expect(retryRow.status).toBe('queued');
    expect(retryRow.errorCode).toBe('LEASE_EXPIRED');
    expect(retryRow.attemptCount).toBe(1);
  });
});

describe('上下文与 LLM 日志', () => {
  it('上下文按 (task, type, ref) 覆盖写，按 rank 排序', async () => {
    const { task } = await createGenerationTask(db, taskInput());
    const refId = randomUUID();
    await upsertTaskContext(db, {
      taskId: task.id,
      contextType: 'character',
      refId,
      snippet: '旧摘要',
      rank: 2,
    });
    await upsertTaskContext(db, {
      taskId: task.id,
      contextType: 'character',
      refId,
      snippet: '新摘要',
      rank: 1,
    });
    await upsertTaskContext(db, { taskId: task.id, contextType: 'work', snippet: '作品摘要' });

    const rows = await listTaskContexts(db, task.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.snippet).toBe('作品摘要');
    expect(rows[1]?.snippet).toBe('新摘要');
  });

  it('snippet 超长被拒绝', async () => {
    const { task } = await createGenerationTask(db, taskInput());
    await expect(
      upsertTaskContext(db, {
        taskId: task.id,
        contextType: 'chapter',
        snippet: 'x'.repeat(501),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('LLM 日志只存计量与稳定错误码；表里没有 prompt/正文列', async () => {
    const { task } = await createGenerationTask(db, taskInput());
    await recordLlmCall(db, {
      taskId: task.id,
      stage: 'agent:test.echo@1.0.0',
      provider: 'mock',
      model: 'mock-model',
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 3,
      success: true,
    });
    await recordLlmCall(db, {
      taskId: task.id,
      stage: 'agent:test.echo@1.0.0',
      provider: 'mock',
      model: 'mock-model',
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 1,
      success: false,
      errorCode: 'MODEL_TIMEOUT',
    });

    const logs = await db.llmCallLog.findMany({ where: { taskId: task.id } });
    expect(logs).toHaveLength(2);
    expect(logs.some((log) => log.errorCode === 'MODEL_TIMEOUT')).toBe(true);

    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'llm_call_logs'
    `;
    const names = columns.map((column) => column.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'prompt_tokens',
        'completion_tokens',
        'latency_ms',
        'success',
        'error_code',
      ]),
    );
    for (const forbidden of ['prompt', 'prompt_text', 'content', 'response', 'response_text']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('成功调用不允许携带 errorCode', async () => {
    const { task } = await createGenerationTask(db, taskInput());
    await expect(
      recordLlmCall(db, {
        taskId: task.id,
        stage: 'x',
        provider: 'mock',
        model: 'm',
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        success: true,
        errorCode: 'MODEL_TIMEOUT',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
