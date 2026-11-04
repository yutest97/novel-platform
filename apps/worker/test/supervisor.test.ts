/**
 * Worker 循环 supervisor（A1-3C-REV-01）。
 *
 * 用脚本化 runner 精确控制失败序列，不连数据库。
 */

import { Prisma } from '@novel/db';
import type { WorkerLogger, WorkerRunOutcome } from '@novel/workflow';
import { describe, expect, it, vi } from 'vitest';

import {
  WorkerLoopSupervisor,
  type WorkerLoopExit,
  type WorkerLoopState,
} from '../src/supervisor.js';

type Step = () => Promise<WorkerRunOutcome>;

function prismaError(code: string): Error {
  return new Prisma.PrismaClientKnownRequestError('原始错误 postgresql://user:secret@host/db', {
    code,
    clientVersion: 'test',
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await sleep(5);
  }
  throw new Error('等待超时');
}

interface Harness {
  supervisor: WorkerLoopSupervisor;
  runner: { runOnce: ReturnType<typeof vi.fn> };
  logs: string[];
  run: Promise<WorkerLoopExit>;
  calls: () => number;
}

function start(
  steps: Step[],
  options: { pollIntervalMs?: number; minRetryMs?: number; maxRetryMs?: number } = {},
): Harness {
  let index = 0;
  const runner = {
    runOnce: vi.fn(async () => {
      const step = steps[Math.min(index, steps.length - 1)] ?? (async () => 'idle');
      index += 1;
      return step();
    }),
  };
  const logs: string[] = [];
  const logger: WorkerLogger = {
    info: (message, meta) => logs.push(`${message}${JSON.stringify(meta ?? {})}`),
    warn: (message, meta) => logs.push(`${message}${JSON.stringify(meta ?? {})}`),
    error: (message, meta) => logs.push(`${message}${JSON.stringify(meta ?? {})}`),
  };
  const supervisor = new WorkerLoopSupervisor({
    runner,
    pollIntervalMs: options.pollIntervalMs ?? 5,
    minRetryMs: options.minRetryMs ?? 5,
    maxRetryMs: options.maxRetryMs ?? 20,
    logger,
    now: () => 1_700_000_000_000,
  });
  const run: Promise<WorkerLoopExit> = supervisor.run();
  return { supervisor, runner, logs, run, calls: () => index };
}

describe('WorkerLoopSupervisor 状态', () => {
  it('初始为 starting；首次正常返回后为 ready，lastSuccessAt 由注入时钟写入', async () => {
    const harness = start([async () => 'idle'], { pollIntervalMs: 10_000 });
    expect(harness.supervisor.snapshot()).toMatchObject({
      state: 'starting',
      consecutiveFailures: 0,
      errorCode: null,
      nextRetryMs: null,
      lastSuccessAt: null,
    });

    await waitFor(() => harness.supervisor.snapshot().state === 'ready');
    expect(harness.supervisor.snapshot()).toEqual({
      state: 'ready',
      consecutiveFailures: 0,
      errorCode: null,
      nextRetryMs: null,
      lastSuccessAt: new Date(1_700_000_000_000).toISOString(),
    });

    harness.supervisor.stop();
    await harness.run;
  });

  it('idle / succeeded / retried / failed / cancelled / lease-lost 都算循环健康', async () => {
    const outcomes: WorkerRunOutcome[] = [
      'succeeded',
      'retried',
      'failed',
      'cancelled',
      'lease-lost',
      'idle',
    ];
    const harness = start(
      outcomes.map((outcome) => async () => outcome),
      { pollIntervalMs: 1 },
    );

    await waitFor(() => harness.calls() >= outcomes.length);
    await waitFor(() => harness.supervisor.snapshot().state === 'ready');

    expect(harness.supervisor.snapshot()).toMatchObject({
      state: 'ready',
      consecutiveFailures: 0,
      errorCode: null,
      nextRetryMs: null,
    });
    expect(harness.logs.some((entry) => entry.includes('failed permanently'))).toBe(false);

    harness.supervisor.stop();
    await harness.run;
  });
});

describe('瞬态错误 → retrying', () => {
  it('P2021 → retrying → 下一轮成功 → ready', async () => {
    let first = true;
    const harness = start(
      [
        async () => {
          if (first) {
            first = false;
            throw prismaError('P2021');
          }
          return 'idle';
        },
      ],
      { pollIntervalMs: 10_000, minRetryMs: 5 },
    );

    await waitFor(() => harness.supervisor.snapshot().state === 'retrying');
    expect(harness.supervisor.snapshot()).toMatchObject({
      state: 'retrying',
      consecutiveFailures: 1,
      errorCode: 'P2021',
      nextRetryMs: 5,
    });

    await waitFor(() => harness.supervisor.snapshot().state === 'ready', 3_000);
    expect(harness.supervisor.snapshot()).toMatchObject({
      state: 'ready',
      consecutiveFailures: 0,
      errorCode: null,
      nextRetryMs: null,
    });

    harness.supervisor.stop();
    await harness.run;
  });

  it('ECONNREFUSED → retrying；退避 10 → 20 → 25（上限）', async () => {
    let attempts = 0;
    const harness = start(
      [
        async () => {
          attempts += 1;
          if (attempts <= 3) {
            throw Object.assign(new Error('连接被拒绝 postgresql://user:secret@host/db'), {
              code: 'ECONNREFUSED',
            });
          }
          return 'idle';
        },
      ],
      { pollIntervalMs: 10_000, minRetryMs: 10, maxRetryMs: 25 },
    );

    await waitFor(() => harness.supervisor.snapshot().state === 'ready', 3_000);
    const retries = harness.logs.filter((entry) => entry.includes('worker loop retrying'));
    expect(retries).toHaveLength(3);
    expect(retries[0]).toContain('"nextRetryMs":10');
    expect(retries[1]).toContain('"nextRetryMs":20');
    expect(retries[2]).toContain('"nextRetryMs":25');

    harness.supervisor.stop();
    await harness.run;
  });

  it('健康轮询后连续失败数归零（再次失败从 1 开始）', async () => {
    let phase = 0;
    const harness = start(
      [
        async () => {
          phase += 1;
          if (phase === 1 || phase === 3) {
            throw prismaError('P2021');
          }
          return 'idle';
        },
      ],
      { pollIntervalMs: 1, minRetryMs: 5, maxRetryMs: 5 },
    );

    // 失败 → 成功 → 失败 → 成功；连续失败计数必须在中间的健康轮询后归零。
    await waitFor(() => harness.calls() >= 4, 3_000);
    await waitFor(() => harness.supervisor.snapshot().state === 'ready');

    const retries = harness.logs.filter((entry) => entry.includes('worker loop retrying'));
    expect(retries).toHaveLength(2);
    for (const retry of retries) {
      expect(retry).toContain('"failures":1');
    }
    expect(retries.some((entry) => entry.includes('"failures":2'))).toBe(false);
    expect(harness.supervisor.snapshot().consecutiveFailures).toBe(0);

    harness.supervisor.stop();
    await harness.run;
  });
});

describe('永久错误 → failed，不重试', () => {
  it('TypeError → failed，退出结果带 TYPE_ERROR，只调用一次', async () => {
    const harness = start([
      async () => {
        throw new TypeError('x is not a function postgresql://user:secret@host/db');
      },
    ]);

    await expect(harness.run).resolves.toEqual({ status: 'failed', errorCode: 'TYPE_ERROR' });
    expect(harness.supervisor.snapshot()).toMatchObject({
      state: 'failed',
      errorCode: 'TYPE_ERROR',
      nextRetryMs: null,
    });

    await sleep(50);
    expect(harness.calls()).toBe(1);
  });

  it('ReferenceError / 未知 Error → failed', async () => {
    for (const error of [new ReferenceError('missing'), new Error('未知 postgresql://secret')]) {
      const harness = start([
        async () => {
          throw error;
        },
      ]);
      const result = await harness.run;
      expect(result.status).toBe('failed');
      expect(harness.calls()).toBe(1);
      expect(harness.supervisor.snapshot().state).toBe('failed');
    }
  });

  it('Prisma P2022 缺列 → failed，不无限重试', async () => {
    const harness = start([
      async () => {
        throw prismaError('P2022');
      },
    ]);

    await expect(harness.run).resolves.toEqual({ status: 'failed', errorCode: 'P2022' });
    expect(harness.calls()).toBe(1);
  });

  it('Prisma 非瞬态已知错误（P2002）→ failed', async () => {
    const harness = start([
      async () => {
        throw prismaError('P2002');
      },
    ]);
    await expect(harness.run).resolves.toEqual({ status: 'failed', errorCode: 'P2002' });
    expect(harness.calls()).toBe(1);
  });
});

describe('停止', () => {
  it('stop 立即打断 10s 退避 sleep，且不再启动 runOnce', async () => {
    const harness = start(
      [
        async () => {
          throw prismaError('P2021');
        },
      ],
      { minRetryMs: 10_000, maxRetryMs: 10_000 },
    );

    await waitFor(() => harness.supervisor.snapshot().state === 'retrying');
    const startedAt = Date.now();
    harness.supervisor.stop();
    await expect(harness.run).resolves.toEqual({ status: 'stopped' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(harness.supervisor.snapshot().state).toBe('stopping');
    expect(harness.calls()).toBe(1);
  });

  it('in-flight runOnce 结束后不再进入下一轮', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = start([
      async () => {
        await gate;
        return 'succeeded';
      },
    ]);

    await waitFor(() => harness.calls() === 1);
    harness.supervisor.stop();
    release();

    await expect(harness.run).resolves.toEqual({ status: 'stopped' });
    expect(harness.supervisor.snapshot().state).toBe('stopping');
    expect(harness.calls()).toBe(1);
  });

  it('failed 状态不会被 stop 覆盖成 stopping', async () => {
    const harness = start([
      async () => {
        throw new TypeError('boom');
      },
    ]);
    await harness.run;
    harness.supervisor.stop();
    expect(harness.supervisor.snapshot().state).toBe('failed');
  });
});

describe('日志脱敏', () => {
  it('retrying / failed 日志只含 code / 次数 / 延迟，不含 message 或连接串', async () => {
    const marker = 'sk-live-SUPERVISOR-SECRET';
    const harness = start(
      [
        async () => {
          throw Object.assign(
            new Error(`${marker} postgresql://user:db-password@host/db prompt 正文`),
            { code: 'ECONNREFUSED' },
          );
        },
      ],
      { minRetryMs: 5, maxRetryMs: 5 },
    );

    await waitFor(() => harness.supervisor.snapshot().consecutiveFailures >= 2);
    harness.supervisor.stop();
    await harness.run;

    const text = harness.logs.join('\n');
    expect(text).toContain('ECONNREFUSED');
    expect(text).toContain('nextRetryMs');
    expect(text).not.toContain(marker);
    expect(text).not.toContain('postgresql://');
    expect(text).not.toContain('db-password');
    expect(text).not.toContain('正文');
  });
});

describe('构造校验', () => {
  it('非法间隔 / 退避参数直接拒绝', () => {
    const runner = { runOnce: async () => 'idle' as WorkerRunOutcome };
    const logger: WorkerLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    for (const options of [
      { pollIntervalMs: 0 },
      { pollIntervalMs: 1, minRetryMs: 0 },
      { pollIntervalMs: 1, minRetryMs: 10, maxRetryMs: 5 },
    ]) {
      expect(
        () => new WorkerLoopSupervisor({ runner, logger, ...options }),
        JSON.stringify(options),
      ).toThrow();
    }
  });
});

// 类型层面确保状态联合没有被放宽
const states: WorkerLoopState[] = ['starting', 'ready', 'retrying', 'stopping', 'failed'];
void states;
