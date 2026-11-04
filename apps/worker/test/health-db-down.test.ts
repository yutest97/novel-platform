/**
 * Worker 健康检查：数据库不可用时的行为（A1-3C）。
 *
 * 独立文件：Prisma 客户端按模块实例缓存，必须在**本文件**第一次探测前
 * 把 DATABASE_URL 指向不可达地址，避免影响其它用例。
 */

import { afterAll, describe, expect, it } from 'vitest';

import { buildWorkerHealthReport, healthStatusCode } from '../src/health.js';

const ORIGINAL_DATABASE_URL = process.env['DATABASE_URL'];
const PASSWORD_MARKER = 'health-probe-password-must-not-leak';

process.env['DATABASE_URL'] =
  `postgresql://novel:${PASSWORD_MARKER}@127.0.0.1:1/novel?schema=public&connect_timeout=1`;

afterAll(() => {
  if (ORIGINAL_DATABASE_URL === undefined) {
    delete process.env['DATABASE_URL'];
  } else {
    process.env['DATABASE_URL'] = ORIGINAL_DATABASE_URL;
  }
});

describe('数据库不可用', () => {
  it('健康报告为 error / HTTP 503，且不泄露连接串', async () => {
    const report = await buildWorkerHealthReport();

    expect(report.service).toBe('worker');
    expect(report.status).toBe('error');
    expect(healthStatusCode(report)).toBe(503);

    const database = report.components.find((component) => component.name === 'database');
    expect(database?.status).toBe('error');

    // worker 自身仍为 ok：数据库故障不应把进程状态也标成 error
    const worker = report.components.find((component) => component.name === 'worker');
    expect(worker?.status).toBe('ok');

    const text = JSON.stringify(report);
    expect(text).not.toContain(PASSWORD_MARKER);
    expect(text).not.toContain('postgresql://');
  });
});
