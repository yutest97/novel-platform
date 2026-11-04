/**
 * Worker 运行配置（A1-3C）。
 *
 * 只测纯函数：不连数据库、不构造 Provider。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKER_LEASE_MS,
  DEFAULT_WORKER_POLL_MS,
  DEFAULT_WORKER_PORT,
  DEFAULT_WORKER_SWEEP_MS,
  WorkerConfigError,
  readWorkerRuntimeConfig,
} from '../src/config.js';

function configWith(env: Record<string, string>): ReturnType<typeof readWorkerRuntimeConfig> {
  return readWorkerRuntimeConfig(env);
}

describe('readWorkerRuntimeConfig', () => {
  it('缺省值：lease 30s / poll 1s / sweep 5s / port 3001，心跳交由 WorkerRunner 计算', () => {
    const config = configWith({});
    expect(config).toEqual({
      workerId: undefined,
      leaseMs: DEFAULT_WORKER_LEASE_MS,
      heartbeatIntervalMs: undefined,
      pollIntervalMs: DEFAULT_WORKER_POLL_MS,
      sweepIntervalMs: DEFAULT_WORKER_SWEEP_MS,
      port: DEFAULT_WORKER_PORT,
    });
  });

  it('合法显式值全部生效', () => {
    const config = configWith({
      WORKER_ID: ' worker-a ',
      WORKER_LEASE_MS: '60000',
      WORKER_HEARTBEAT_MS: '20000',
      WORKER_POLL_MS: '500',
      WORKER_SWEEP_MS: '2500',
      WORKER_PORT: '3999',
    });
    expect(config).toEqual({
      workerId: 'worker-a',
      leaseMs: 60_000,
      heartbeatIntervalMs: 20_000,
      pollIntervalMs: 500,
      sweepIntervalMs: 2_500,
      port: 3_999,
    });
  });

  it('空白 WORKER_ID 视为未设置', () => {
    expect(configWith({ WORKER_ID: '   ' }).workerId).toBeUndefined();
  });

  it.each([
    ['WORKER_LEASE_MS', '0'],
    ['WORKER_LEASE_MS', '99'],
    ['WORKER_LEASE_MS', '3600001'],
    ['WORKER_LEASE_MS', '1.5'],
    ['WORKER_LEASE_MS', 'abc'],
    ['WORKER_LEASE_MS', '1e3'],
    ['WORKER_POLL_MS', '0'],
    ['WORKER_POLL_MS', '600001'],
    ['WORKER_SWEEP_MS', '0'],
    ['WORKER_SWEEP_MS', '600001'],
    ['WORKER_HEARTBEAT_MS', '0'],
    ['WORKER_PORT', '0'],
    ['WORKER_PORT', '65536'],
  ])('%s=%s → WorkerConfigError（字段名稳定）', (field, value) => {
    expect(() => configWith({ [field]: value })).toThrowError(WorkerConfigError);
    try {
      configWith({ [field]: value });
    } catch (error) {
      expect((error as WorkerConfigError).field).toBe(field);
      // 消息只含字段名与范围，不含环境里的其它值
      expect((error as Error).message).toContain(field);
    }
  });

  it('心跳必须严格小于租约', () => {
    expect(() =>
      configWith({ WORKER_LEASE_MS: '30000', WORKER_HEARTBEAT_MS: '30000' }),
    ).toThrowError(/必须小于 WORKER_LEASE_MS/);
    expect(() =>
      configWith({ WORKER_LEASE_MS: '30000', WORKER_HEARTBEAT_MS: '40000' }),
    ).toThrowError(/必须小于 WORKER_LEASE_MS/);
  });

  it('WORKER_ID 超过 128 字符 → 拒绝', () => {
    expect(() => configWith({ WORKER_ID: 'w'.repeat(129) })).toThrowError(/128/);
    expect(configWith({ WORKER_ID: 'w'.repeat(128) }).workerId).toHaveLength(128);
  });

  it('配置错误不回显同环境的其它变量（含 API Key）', () => {
    const marker = 'sk-live-worker-config-must-not-leak';
    try {
      configWith({
        WORKER_LEASE_MS: '0',
        MODEL_API_KEY: marker,
        DATABASE_URL: `postgresql://user:${marker}@127.0.0.1:1/db`,
      });
      throw new Error('应当抛出 WorkerConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerConfigError);
      expect((error as Error).message).not.toContain(marker);
    }
  });
});
