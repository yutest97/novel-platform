import { defineConfig } from 'vitest/config';

/**
 * auth 包测试配置。
 *
 * `fileParallelism: false`：这些测试共享同一个 PostgreSQL，
 * 且包含"临时触发器做故障注入""并发建会话"等用例，
 * 并行跑不同文件会互相干扰（触发器会影响其它文件的审计写入）。
 * 串行执行换取确定性。
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
