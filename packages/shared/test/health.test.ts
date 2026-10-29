import { describe, expect, it } from 'vitest';

import {
  APP_VERSION,
  CONFIG_KEYS,
  SERVICE_NAMES,
  STAGE,
  createHealthReport,
  httpStatusFor,
  isHealthy,
  overallStatus,
  readIntEnv,
  requireEnv,
  toComponent,
} from '../src/index.js';

describe('shared 包导出', () => {
  it('导出版本与阶段常量', () => {
    expect(APP_VERSION).toBe('0.1.0');
    expect(STAGE).toBe('M1-A');
  });

  it('导出服务名与配置键', () => {
    expect(SERVICE_NAMES.web).toBe('web');
    expect(SERVICE_NAMES.worker).toBe('worker');
    expect(CONFIG_KEYS.DATABASE_URL).toBe('DATABASE_URL');
  });
});

describe('健康状态聚合', () => {
  it('全部 ok 时整体为 ok', () => {
    const components = [toComponent('app', 'ok'), toComponent('database', 'ok')];
    expect(overallStatus(components)).toBe('ok');
  });

  it('任一组件 error 时整体为 error', () => {
    const components = [toComponent('app', 'ok'), toComponent('database', 'error')];
    expect(overallStatus(components)).toBe('error');
  });

  it('存在 degraded 且无 error 时整体为 degraded', () => {
    const components = [toComponent('app', 'ok'), toComponent('database', 'degraded')];
    expect(overallStatus(components)).toBe('degraded');
  });

  it('空组件列表视为 ok', () => {
    expect(overallStatus([])).toBe('ok');
  });
});

describe('健康状态到 HTTP 状态码的映射', () => {
  it('error 映射为 503', () => {
    expect(httpStatusFor('error')).toBe(503);
  });

  it('ok 与 degraded 映射为 200', () => {
    expect(httpStatusFor('ok')).toBe(200);
    expect(httpStatusFor('degraded')).toBe(200);
  });
});

describe('健康报告', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('数据库连接失败时报告为 error 且判定为不健康', () => {
    const report = createHealthReport({
      service: 'worker',
      version: APP_VERSION,
      components: [toComponent('worker', 'ok'), toComponent('database', 'error', '连接失败')],
      uptimeSeconds: 12,
      now,
    });

    expect(report.status).toBe('error');
    expect(isHealthy(report)).toBe(false);
    expect(report.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(report.service).toBe('worker');
  });

  it('全部正常时判定为健康', () => {
    const report = createHealthReport({
      service: 'web',
      version: APP_VERSION,
      components: [toComponent('app', 'ok'), toComponent('database', 'ok')],
      uptimeSeconds: 3,
      now,
    });

    expect(report.status).toBe('ok');
    expect(isHealthy(report)).toBe(true);
  });

  it('组件条目保留 detail 与 latencyMs', () => {
    const component = toComponent('database', 'ok', '连接正常', 12);
    expect(component).toEqual({
      name: 'database',
      status: 'ok',
      detail: '连接正常',
      latencyMs: 12,
    });
  });
});

describe('环境变量读取', () => {
  it('缺少必需变量时抛出明确错误', () => {
    expect(() => requireEnv({}, 'DATABASE_URL')).toThrow(/DATABASE_URL/);
  });

  it('空白值同样视为缺失', () => {
    expect(() => requireEnv({ DATABASE_URL: '   ' }, 'DATABASE_URL')).toThrow(/DATABASE_URL/);
  });

  it('存在时返回原值', () => {
    expect(requireEnv({ DATABASE_URL: 'postgres://x' }, 'DATABASE_URL')).toBe('postgres://x');
  });

  it('整数读取在非法或缺失时回退默认值', () => {
    expect(readIntEnv({}, 'WORKER_PORT', 3001)).toBe(3001);
    expect(readIntEnv({ WORKER_PORT: 'abc' }, 'WORKER_PORT', 3001)).toBe(3001);
    expect(readIntEnv({ WORKER_PORT: '4000' }, 'WORKER_PORT', 3001)).toBe(4000);
  });
});
