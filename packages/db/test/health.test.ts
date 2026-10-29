import { afterEach, describe, expect, it } from 'vitest';

import { describeError, probeDatabase, withTimeout } from '../src/health.js';

describe('数据库健康探测的错误处理', () => {
  const originalDatabaseUrl = process.env['DATABASE_URL'];

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = originalDatabaseUrl;
    }
  });

  it('异常被转换为不含堆栈的描述', () => {
    const description = describeError(new Error('第一行\n第二行'));
    expect(description).toBe('Error: 第一行');
  });

  it('非 Error 值也能得到描述', () => {
    expect(describeError('boom')).toBe('未知错误');
  });

  it('超时会被拒绝', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 500));
    await expect(withTimeout(slow, 20)).rejects.toThrow(/超时/);
  });

  it('正常完成的 Promise 会被解析', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });
});

describe('数据库不可用时的健康检查行为', () => {
  it('缺少 DATABASE_URL 时返回 error 状态而不是抛出异常', async () => {
    delete process.env['DATABASE_URL'];

    const component = await probeDatabase(200);

    expect(component.status).toBe('error');
    expect(component.name).toBe('database');
    expect(component.detail).toContain('DATABASE_URL');
  });

  it('指向不可达地址时返回 error 状态', async () => {
    process.env['DATABASE_URL'] =
      'postgresql://novel:novel@127.0.0.1:1/novel?schema=public&connect_timeout=1';

    const component = await probeDatabase(2000);

    expect(component.status).toBe('error');
  });
});
