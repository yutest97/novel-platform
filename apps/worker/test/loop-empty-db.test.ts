/**
 * 空库启动 → retrying（P2021）→ 迁移 → ready 的集成测试（A1-3C-REV-01）。
 *
 * 使用真实 PostgreSQL + 一个**只创建、不迁移**的临时数据库：
 * 1. 第一次 runOnce 因 generation_tasks 不存在抛 P2021；
 * 2. supervisor 进入 retrying，进程不退出，health=503；
 * 3. 执行 prisma migrate deploy；
 * 4. 下一轮 runOnce 正常返回，ready + health=200。
 */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createPrismaClient, disconnectPrisma, getPrismaClient } from '@novel/db';
import type { WorkerLogger } from '@novel/workflow';
import { afterAll, describe, expect, it } from 'vitest';

import { buildWorkerHealthReport, healthStatusCode } from '../src/health.js';
import { createWorkerRuntime } from '../src/runtime.js';
import { WorkerLoopSupervisor } from '../src/supervisor.js';

const ORIGINAL_DATABASE_URL = process.env['DATABASE_URL'];
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const DATABASE_NAME = `novel_wloop_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error('集成测试需要真实 PostgreSQL：请设置 DATABASE_URL');
  }
  return url;
}

const DATABASE_URL = requireDatabaseUrl();

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  url.searchParams.set('schema', 'public');
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await sleep(25);
  }
  throw new Error('等待超时');
}

const silentLogger: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const adminUrl = withDatabase(DATABASE_URL, 'postgres');

const admin = createPrismaClient({ connectionString: adminUrl });

afterAll(async () => {
  if (ORIGINAL_DATABASE_URL === undefined) {
    delete process.env['DATABASE_URL'];
  } else {
    process.env['DATABASE_URL'] = ORIGINAL_DATABASE_URL;
  }
  await admin.$disconnect();
});

describe('空库启动与迁移恢复', () => {
  it('P2021 → retrying + health 503；迁移后自动 ready + 200', async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
    const emptyUrl = withDatabase(DATABASE_URL, DATABASE_NAME);
    process.env['DATABASE_URL'] = emptyUrl;

    const supervisor = new WorkerLoopSupervisor({
      runner: createWorkerRuntime(getPrismaClient(), {
        MODEL_PROVIDER: 'mock',
        WORKER_LEASE_MS: '30000',
        WORKER_POLL_MS: '50',
      }).runner,
      pollIntervalMs: 50,
      minRetryMs: 100,
      maxRetryMs: 200,
      logger: silentLogger,
    });

    let settled = false;
    const run = supervisor.run().then((result) => {
      settled = true;
      return result;
    });

    try {
      // ---- 1. 空库：P2021 → retrying，进程（supervisor）仍存活 ----
      await waitFor(
        () =>
          supervisor.snapshot().state === 'retrying' && supervisor.snapshot().errorCode === 'P2021',
      );
      expect(supervisor.snapshot().consecutiveFailures).toBeGreaterThanOrEqual(1);
      expect(supervisor.snapshot().nextRetryMs).toBeGreaterThanOrEqual(100);
      expect(settled).toBe(false);

      const failingReport = await buildWorkerHealthReport(supervisor.snapshot());
      expect(failingReport.status).toBe('error');
      expect(healthStatusCode(failingReport)).toBe(503);
      expect(
        failingReport.components.find((component) => component.name === 'queueLoop')?.detail,
      ).toContain('code=P2021');

      // ---- 2. 迁移（独立进程，与 worker 连接池无关）----
      const migration = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['--filter', '@novel/db', 'migrate:deploy'],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: emptyUrl },
          encoding: 'utf8',
          shell: process.platform === 'win32',
        },
      );
      // 不回显 stdout/stderr：可能包含连接串。
      expect(migration.status, `migrate deploy exit=${String(migration.status)}`).toBe(0);

      // ---- 3. 下一轮自动 ready + 200 ----
      await waitFor(() => supervisor.snapshot().state === 'ready', 30_000);
      expect(supervisor.snapshot().consecutiveFailures).toBe(0);
      expect(supervisor.snapshot().errorCode).toBeNull();

      const recoveredReport = await buildWorkerHealthReport(supervisor.snapshot());
      expect(recoveredReport.status).toBe('ok');
      expect(healthStatusCode(recoveredReport)).toBe(200);
    } finally {
      supervisor.stop();
      await run.catch(() => undefined);
      await disconnectPrisma();
      // FORCE：即使还有残留连接也删除测试库
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
    }
  }, 60_000);
});
