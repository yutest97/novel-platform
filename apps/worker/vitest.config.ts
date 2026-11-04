import { defineConfig } from 'vitest/config';

/**
 * Worker 测试配置。
 *
 * `fileParallelism: false`：
 * - 空库恢复用例会临时改写 `process.env.DATABASE_URL` 并创建/删除数据库；
 * - 健康检查用例共享同一个 Prisma 单例。
 * 并行执行会互相干扰，串行换取确定性。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
