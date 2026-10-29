import { afterEach, describe, expect, it } from 'vitest';

import { buildWebHealthReport } from '../src/health.js';

describe('web 健康检查', () => {
  const originalDatabaseUrl = process.env['DATABASE_URL'];

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = originalDatabaseUrl;
    }
  });

  it('数据库不可用时整体状态为 error', async () => {
    delete process.env['DATABASE_URL'];

    const report = await buildWebHealthReport();

    expect(report.service).toBe('web');
    expect(report.status).toBe('error');
    const database = report.components.find((component) => component.name === 'database');
    expect(database?.status).toBe('error');
  });

  it('应用组件本身恒为 ok', async () => {
    delete process.env['DATABASE_URL'];

    const report = await buildWebHealthReport();

    const app = report.components.find((component) => component.name === 'app');
    expect(app?.status).toBe('ok');
  });
});
