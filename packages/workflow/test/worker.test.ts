/**
 * Worker 端到端（A1-1）。
 *
 * 使用真实 PostgreSQL + 测试工作流，不接 Planner/Writer。
 * 覆盖：成功、并发领取、租约恢复、心跳、重试、次数用尽、不可重试、
 * 取消、错误脱敏、Agent 集成（MockProvider + LLM 日志）。
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@novel/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRunner, DETERMINISTIC_TEST_AGENT } from '../src/agent.js';
import { NonRetryableTaskError, RetryableTaskError } from '../src/errors.js';
import { WorkflowKernel, WorkflowRegistry } from '../src/kernel.js';
import { MockProvider } from '../src/providers/mock.js';
import {
  createGenerationTask,
  recordLlmCall,
  requestTaskCancellationForAuthor,
} from '../src/queue.js';
import {
  cleanupUser,
  cleanupWork,
  closeTestDb,
  createTestChapter,
  createTestUser,
  createTestWork,
  silentLogger,
  testDb,
} from './helpers/db.js';
import { WorkerRunner, type WorkerLogger } from '../src/worker.js';

let db: PrismaClient;
let authorId: string;
let workId: string;
let chapterId: string;

async function expireLeaseForTest(taskId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE generation_tasks
       SET lease_until = clock_timestamp() - interval '1 second'
     WHERE id = ${taskId}
  `;
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

function createTask(requestId = `req-${randomUUID()}`, maxAttempts = 3) {
  return createGenerationTask(db, {
    authorId,
    workId,
    chapterId,
    requestId,
    taskType: 'test.flow',
    inputSnapshot: { question: '你好' },
    provider: 'mock',
    model: 'mock-model',
    maxAttempts,
  });
}

function runnerWith(
  steps: { name: string; run: () => Promise<void> }[],
  options: {
    workerId?: string;
    leaseMs?: number;
    heartbeatIntervalMs?: number;
    logger?: WorkerLogger;
  } = {},
): WorkerRunner {
  const registry = new WorkflowRegistry();
  registry.register({ taskType: 'test.flow', steps });
  return new WorkerRunner(db, new WorkflowKernel(registry), {
    workerId: options.workerId ?? 'worker-a',
    leaseMs: options.leaseMs ?? 5_000,
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    pollIntervalMs: 10,
    sweepIntervalMs: 10,
    logger: options.logger ?? silentLogger,
  });
}

beforeAll(async () => {
  db = testDb();
  const author = await createTestUser(db, 'author');
  authorId = author.id;
});

beforeEach(async () => {
  const work = await createTestWork(db, authorId);
  workId = work.id;
  const chapter = await createTestChapter(db, workId, 1);
  chapterId = chapter.id;
});

afterEach(async () => {
  await cleanupWork(db, workId);
});

afterAll(async () => {
  await cleanupUser(db, authorId);
  await closeTestDb();
});

describe('WorkerRunner', () => {
  it('领取并执行固定步骤，写 current_step 并完成', async () => {
    const calls: string[] = [];
    const runner = runnerWith([
      { name: 'one', run: async () => void calls.push('one') },
      { name: 'two', run: async () => void calls.push('two') },
    ]);
    const { task } = await createTask();

    await expect(runner.runOnce()).resolves.toBe('succeeded');

    expect(calls).toEqual(['one', 'two']);
    const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('succeeded');
    expect(row.currentStep).toBe('two');
    expect(row.attemptCount).toBe(1);
    expect(row.lockedBy).toBeNull();
    expect(row.leaseUntil).toBeNull();
  });

  it('start/stop：循环消费任务，stop 后退出', async () => {
    const runner = runnerWith([{ name: 'only', run: async () => undefined }]);
    const { task } = await createTask();

    const loop = runner.start();
    await waitFor(async () => {
      const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
      return row.status === 'succeeded';
    });
    runner.stop();
    await expect(loop).resolves.toBeUndefined();
  });

  it('两个 Worker 并发执行：只有一个领到任务', async () => {
    const a = runnerWith([{ name: 'only', run: async () => undefined }], { workerId: 'worker-a' });
    const b = runnerWith([{ name: 'only', run: async () => undefined }], { workerId: 'worker-b' });
    await createTask();

    const outcomes = await Promise.all([a.runOnce(), b.runOnce()]);
    expect(outcomes.filter((outcome) => outcome === 'idle')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'succeeded')).toHaveLength(1);

    const rows = await db.generationTask.findMany({ where: { workId } });
    expect(rows[0]?.attemptCount).toBe(1);
  });

  it('租约过期后由另一个 Worker 恢复（崩溃不留永久 processing）', async () => {
    const runnerB = runnerWith([{ name: 'only', run: async () => undefined }], {
      workerId: 'worker-b',
    });
    const { task } = await createTask();

    // A 领取后"崩溃"：不执行、不心跳
    const claimed = await db.$queryRaw<{ id: string }[]>`
      WITH candidate AS (
        SELECT id FROM generation_tasks
         WHERE status = 'queued' AND cancel_requested_at IS NULL AND attempt_count < max_attempts
         ORDER BY created_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE generation_tasks AS t
         SET status = 'processing', locked_by = 'crashed-worker',
             lease_until = clock_timestamp() + interval '100 milliseconds',
             heartbeat_at = clock_timestamp(), attempt_count = t.attempt_count + 1,
             updated_at = clock_timestamp()
        FROM candidate WHERE t.id = candidate.id
      RETURNING t.id
    `;
    expect(claimed[0]?.id).toBe(task.id);

    await expireLeaseForTest(task.id);
    await expect(runnerB.runOnce()).resolves.toBe('succeeded');

    const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('succeeded');
    expect(row.attemptCount).toBe(2);
    expect(row.lockedBy).toBeNull();
  });

  it('执行期间定期心跳（租约被续期）', async () => {
    let heartbeatObserved = false;
    const runner = runnerWith(
      [
        {
          name: 'slow',
          run: async () => {
            const initial = await db.generationTask.findUniqueOrThrow({ where: { id: taskId } });
            const initialHeartbeat = initial.heartbeatAt?.getTime() ?? 0;
            const deadline = Date.now() + 3_000;
            while (Date.now() < deadline) {
              await sleep(10);
              const current = await db.generationTask.findUniqueOrThrow({
                where: { id: taskId },
              });
              if ((current.heartbeatAt?.getTime() ?? 0) > initialHeartbeat) {
                heartbeatObserved = true;
                return;
              }
            }
            throw new Error('未观察到心跳');
          },
        },
      ],
      { heartbeatIntervalMs: 20, leaseMs: 600 },
    );
    let taskId = '';
    const { task } = await createTask();
    taskId = task.id;

    await expect(runner.runOnce()).resolves.toBe('succeeded');
    expect(heartbeatObserved).toBe(true);
  });

  it('可重试错误：第一次 requeued，第二次成功', async () => {
    let attempts = 0;
    const runner = runnerWith([
      {
        name: 'flaky',
        run: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new RetryableTaskError('MODEL_TIMEOUT', '模型服务超时');
          }
        },
      },
    ]);
    const { task } = await createTask(`req-${randomUUID()}`, 3);

    await expect(runner.runOnce()).resolves.toBe('retried');
    let row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('queued');
    expect(row.errorCode).toBe('MODEL_TIMEOUT');

    await expect(runner.runOnce()).resolves.toBe('succeeded');
    row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('succeeded');
    expect(row.attemptCount).toBe(2);
  });

  it('重试次数用尽后 failed', async () => {
    const runner = runnerWith([
      {
        name: 'always',
        run: async () => {
          throw new RetryableTaskError('MODEL_TIMEOUT', '模型服务超时');
        },
      },
    ]);
    const { task } = await createTask(`req-${randomUUID()}`, 2);

    await expect(runner.runOnce()).resolves.toBe('retried');
    await expect(runner.runOnce()).resolves.toBe('failed');
    await expect(runner.runOnce()).resolves.toBe('idle');

    const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('failed');
    expect(row.attemptCount).toBe(2);
  });

  it('不可重试错误一次即 failed', async () => {
    const runner = runnerWith([
      {
        name: 'reject',
        run: async () => {
          throw new NonRetryableTaskError('TASK_INPUT_INVALID', '输入不合法');
        },
      },
    ]);
    const { task } = await createTask(`req-${randomUUID()}`, 5);

    await expect(runner.runOnce()).resolves.toBe('failed');
    const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('failed');
    expect(row.attemptCount).toBe(1);
    expect(row.errorCode).toBe('TASK_INPUT_INVALID');
  });

  it('取消后停止后续步骤并进入 cancelled', async () => {
    let secondRan = false;
    let taskId = '';
    const runner = runnerWith([
      {
        name: 'first',
        run: async () => {
          await db.generationTask.update({
            where: { id: taskId },
            data: { cancelRequestedAt: new Date() },
          });
        },
      },
      { name: 'second', run: async () => void (secondRan = true) },
    ]);
    const { task } = await createTask();
    taskId = task.id;

    await expect(runner.runOnce()).resolves.toBe('cancelled');
    expect(secondRan).toBe(false);
    const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('cancelled');
    expect(row.cancelRequestedAt).not.toBeNull();
  });

  it('queued 阶段取消后不会被领取', async () => {
    const run = vi.fn(async () => undefined);
    const runner = runnerWith([{ name: 'never', run }]);
    const { task } = await createTask();

    await requestTaskCancellationForAuthor(db, { authorId, workId, taskId: task.id });
    await expect(runner.runOnce()).resolves.toBe('idle');
    expect(run).not.toHaveBeenCalled();
  });

  it('未知异常落库时被脱敏，不含 prompt / Key', async () => {
    const runner = runnerWith(
      [
        {
          name: 'leak',
          run: async () => {
            throw new Error('sk-live-SECRET 这是 prompt 正文');
          },
        },
      ],
      {},
    );
    const { task } = await createTask(`req-${randomUUID()}`, 1);

    // 未知异常按可重试处理：maxAttempts=1 → 直接 failed
    await expect(runner.runOnce()).resolves.toBe('failed');
    const row = await db.generationTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('WORKFLOW_INTERNAL_ERROR');
    expect(row.errorMessageSanitized).toBe('步骤 leak 执行失败');
    expect(row.errorMessageSanitized).not.toContain('sk-live-SECRET');
    expect(row.errorMessageSanitized).not.toContain('正文');
  });

  it('Worker 日志只含定位字段，不含 Key / prompt / 正文', async () => {
    const entries: string[] = [];
    const logger: WorkerLogger = {
      info: (message, meta) => entries.push(`${message}${JSON.stringify(meta ?? {})}`),
      warn: (message, meta) => entries.push(`${message}${JSON.stringify(meta ?? {})}`),
      error: (message, meta) => entries.push(`${message}${JSON.stringify(meta ?? {})}`),
    };
    const runner = runnerWith(
      [
        {
          name: 'leak',
          run: async () => {
            throw new Error('sk-live-SECRET prompt 正文');
          },
        },
      ],
      { logger },
    );
    const { task } = await createTask(`req-${randomUUID()}`, 1);
    await expect(runner.runOnce()).resolves.toBe('failed');

    const text = entries.join('\n');
    expect(text).toContain(task.id);
    expect(text).not.toContain('sk-live-SECRET');
    expect(text).not.toContain('正文');
  });

  it('Agent 集成：MockProvider → 输出校验 → LLM 日志', async () => {
    let taskId = '';
    const agentRunner = new AgentRunner(new MockProvider({ json: { answer: '你好' } }));
    const runner = runnerWith([
      {
        name: 'agent',
        run: async () => {
          const result = await agentRunner.run(DETERMINISTIC_TEST_AGENT, { question: '你好' });
          await recordLlmCall(db, {
            taskId,
            stage: `agent:${result.agentName}@${result.promptVersion}`,
            provider: result.provider,
            model: result.model,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            latencyMs: result.latencyMs,
            success: true,
          });
        },
      },
    ]);
    const { task } = await createTask();
    taskId = task.id;

    await expect(runner.runOnce()).resolves.toBe('succeeded');

    const logs = await db.llmCallLog.findMany({ where: { taskId: task.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.stage).toBe('agent:test.echo@1.0.0');
    expect(logs[0]?.success).toBe(true);
    expect(logs[0]?.promptTokens).toBeGreaterThan(0);
  });
});
