import { createHealthReport } from '@novel/shared';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { healthStatusCode } from '../src/health.js';
import { startHealthServer } from '../src/server.js';

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

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
      server = undefined;
    }
  });

  it('/healthz 返回 worker / database 组件，且不泄露连接串', async () => {
    server = startHealthServer(0);
    await new Promise<void>((resolve) => {
      server?.once('listening', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = (await response.json()) as {
      service: string;
      status: string;
      components: { name: string; status: string; detail?: string }[];
    };

    expect(response.status).toBe(200);
    expect(body.service).toBe('worker');
    expect(body.status).toBe('ok');
    expect(body.components.map((component) => component.name).sort()).toEqual([
      'database',
      'worker',
    ]);
    expect(body.components.every((component) => component.status === 'ok')).toBe(true);

    const text = JSON.stringify(body);
    expect(text).not.toContain('postgresql://');
    expect(text).not.toContain('change-me-local-only');
  });

  it('停止后端口释放', async () => {
    server = startHealthServer(0);
    await new Promise<void>((resolve) => {
      server?.once('listening', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = undefined;

    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});
