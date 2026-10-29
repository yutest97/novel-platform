import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { disconnectPrisma, getPrismaClient } from '../src/client.js';
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

describe('Prisma 客户端复用（生产连接泄漏回归测试）', () => {
  const originalDatabaseUrl = process.env['DATABASE_URL'];
  const originalNodeEnv = process.env['NODE_ENV'];

  beforeEach(async () => {
    // 每个用例前断开并复位，保证 creations 计数从确定状态开始。
    await disconnectPrisma();
    process.env['DATABASE_URL'] =
      'postgresql://novel:novel@127.0.0.1:1/novel?schema=public&connect_timeout=1';
  });

  afterEach(async () => {
    await disconnectPrisma();
    if (originalDatabaseUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = originalDatabaseUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
  });

  it('production 环境下多次调用返回同一实例', () => {
    process.env['NODE_ENV'] = 'production';

    const first = getPrismaClient();
    const second = getPrismaClient();
    const third = getPrismaClient();

    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('production 环境下连续多次健康检查只创建一次客户端', async () => {
    process.env['NODE_ENV'] = 'production';

    // 重置模块，得到全新的计数（从 0 开始），断言可精确化。
    vi.resetModules();
    const clientModule = await import('../src/client.js');
    const healthModule = await import('../src/health.js');

    expect(clientModule.getPrismaClientStats().creations).toBe(0);

    for (let i = 0; i < 5; i += 1) {
      await healthModule.probeDatabase(200);
    }

    // 5 次健康检查：首次创建客户端，其余 4 次复用同一实例 → 恰好创建 1 个。
    expect(clientModule.getPrismaClientStats().creations).toBe(1);
    expect(clientModule.getPrismaClient()).toBe(clientModule.getPrismaClient());

    await clientModule.disconnectPrisma();
  });

  it('development 环境下同样复用同一实例', () => {
    process.env['NODE_ENV'] = 'development';

    expect(getPrismaClient()).toBe(getPrismaClient());
  });

  it('断开连接后允许重新创建', async () => {
    const first = getPrismaClient();
    await disconnectPrisma();

    const second = getPrismaClient();
    expect(second).not.toBe(first);
  });
});
