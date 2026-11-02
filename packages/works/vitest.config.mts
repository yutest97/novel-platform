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
    // 同 `@novel/auth`：迁移用例逐个新建隔离数据库，
    // 慢主机上 `CREATE DATABASE` 可能耗到几十秒。超时只用于检测挂起。
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
