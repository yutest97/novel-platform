import { defineConfig } from 'vitest/config';

/**
 * works 包测试配置。
 *
 * `fileParallelism: false`：这些用例共享同一个 PostgreSQL，
 * 且包含"审计写失败时作品回滚"等需要临时触发器的故障注入用例，
 * 并行执行会互相干扰。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
