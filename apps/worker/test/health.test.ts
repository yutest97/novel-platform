import { createHealthReport } from '@novel/shared';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { healthStatusCode } from '../src/health.js';
import { startHealthServer } from '../src/server.js';
import type { WorkerLoopSnapshot } from '../src/supervisor.js';

function loopSnapshot(overrides: Partial<WorkerLoopSnapshot> = {}): WorkerLoopSnapshot {
  return {
    state: 'ready',
    consecutiveFailures: 0,
    errorCode: null,
    nextRetryMs: null,
    lastSuccessAt: null,
    ...overrides,
  };
}

describe('worker 健康状态映射', () => {
  it('数据库正常时返回 200', () => {
    const report = createHealthReport({
      service: 'worker',
      version: '0.1.0',
      components: [
        { name: 'worker', status: 'ok' },
        { name: 'database', status: 'ok' },
      ],
      uptimeSeconds: 1,
    });

    expect(healthStatusCode(report)).toBe(200);
  });

  it('数据库连接失败时返回 503', () => {
    const report = createHealthReport({
      service: 'worker',
      version: '0.1.0',
      components: [
        { name: 'worker', status: 'ok' },
        { name: 'database', status: 'error' },
      ],
      uptimeSeconds: 1,
    });

    expect(healthStatusCode(report)).toBe(503);
  });
});

describe('worker 健康检查 HTTP 服务', () => {
  let server: Server | undefined;

  async function start(loopState?: () => WorkerLoopSnapshot): Promise<number> {
    server = startHealthServer(0, loopState === undefined ? {} : { loopState });
    await new Promise<void>((resolve) => {
      server?.once('listening', () => resolve());
    });
    return (server.address() as AddressInfo).port;
  }

  async function fetchHealth(port: number): Promise<{
    status: number;
    body: {
      service: string;
      status: string;
      components: { name: string; status: string; detail?: string }[];
    };
  }> {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    return {
      status: response.status,
      body: (await response.json()) as {
        service: string;
        status: string;
        components: { name: string; status: string; detail?: string }[];
      },
    };
  }

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
      server = undefined;
    }
  });

  it('ready → 200，包含 worker / queueLoop / database 组件', async () => {
    const port = await start(() => loopSnapshot());
    const { status, body } = await fetchHealth(port);

    expect(status).toBe(200);
    expect(body.service).toBe('worker');
    expect(body.status).toBe('ok');
    expect(body.components.map((component) => component.name).sort()).toEqual([
      'database',
      'queueLoop',
      'worker',
    ]);
    expect(body.components.every((component) => component.status === 'ok')).toBe(true);

    const text = JSON.stringify(body);
    expect(text).not.toContain('postgresql://');
    expect(text).not.toContain('change-me-local-only');
  });

  it('starting / retrying / failed → 503（未 ready 不返回 200）', async () => {
    for (const [state, expectedDetail] of [
      ['starting', 'state=starting failures=0'],
      ['retrying', 'state=retrying failures=2 code=P2021 nextRetryMs=2000'],
      ['failed', 'state=failed failures=1 code=TYPE_ERROR'],
    ] as const) {
      const loop = loopSnapshot({
        state,
        consecutiveFailures: state === 'starting' ? 0 : state === 'retrying' ? 2 : 1,
        errorCode: state === 'retrying' ? 'P2021' : state === 'failed' ? 'TYPE_ERROR' : null,
        nextRetryMs: state === 'retrying' ? 2000 : null,
      });
      const port = await start(() => loop);
      const { status, body } = await fetchHealth(port);

      expect(status, state).toBe(503);
      expect(body.status, state).toBe('error');
      const queueLoop = body.components.find((component) => component.name === 'queueLoop');
      expect(queueLoop, state).toMatchObject({ status: 'error', detail: expectedDetail });

      // 只含安全字段，不含原始错误 / 连接串
      expect(JSON.stringify(body)).not.toContain('postgresql://');

      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
      server = undefined;
    }
  });

  it('数据库 ping 正常但循环 retrying 时仍为 503（不假健康）', async () => {
    const port = await start(() =>
      loopSnapshot({
        state: 'retrying',
        consecutiveFailures: 1,
        errorCode: 'P2021',
        nextRetryMs: 1000,
      }),
    );
    const { status, body } = await fetchHealth(port);

    expect(status).toBe(503);
    const database = body.components.find((component) => component.name === 'database');
    expect(database?.status).toBe('ok');
    const queueLoop = body.components.find((component) => component.name === 'queueLoop');
    expect(queueLoop?.status).toBe('error');
  });

  it('retrying → ready 后自动转回 200', async () => {
    let loop = loopSnapshot({
      state: 'retrying',
      consecutiveFailures: 1,
      errorCode: 'P2021',
      nextRetryMs: 1000,
    });
    const port = await start(() => loop);

    expect((await fetchHealth(port)).status).toBe(503);
    loop = loopSnapshot({ lastSuccessAt: new Date().toISOString() });
    const recovered = await fetchHealth(port);
    expect(recovered.status).toBe(200);
    expect(recovered.body.components.find((component) => component.name === 'queueLoop')).toEqual({
      name: 'queueLoop',
      status: 'ok',
      detail: 'state=ready failures=0',
    });
  });

  it('stopping → degraded / 200（优雅关闭中，端口随后释放）', async () => {
    const port = await start(() => loopSnapshot({ state: 'stopping' }));
    const { status, body } = await fetchHealth(port);

    expect(status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.components.find((component) => component.name === 'queueLoop')?.status).toBe(
      'degraded',
    );
  });

  it('未接入 loopState 时 fail-closed → 503', async () => {
    const port = await start();
    const { status, body } = await fetchHealth(port);

    expect(status).toBe(503);
    expect(body.components.find((component) => component.name === 'queueLoop')).toMatchObject({
      status: 'error',
      detail: 'state=failed failures=0 code=WORKER_LOOP_STATE_UNAVAILABLE',
    });
  });

  it('停止后端口释放', async () => {
    const port = await start(() => loopSnapshot());
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = undefined;

    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});
