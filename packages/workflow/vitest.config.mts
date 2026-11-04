import { defineConfig } from 'vitest/config';

/**
 * workflow 包测试配置。
 *
 * `fileParallelism: false`：队列/租约用例共享同一个 PostgreSQL，
 * 且包含"锁过期、并发领取"等需要精确控制时序的用例，并行会互相干扰。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    // 与其它后端包一致：慢主机上的建库/锁等待只用于检测挂起，不是性能断言。
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
