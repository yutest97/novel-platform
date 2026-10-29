import { describe, expect, it } from 'vitest';

import { healthStatusCode } from '../src/health.js';
import { createHealthReport } from '@novel/shared';

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
