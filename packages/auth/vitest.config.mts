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
    // 超时是**挂起检测**，不是性能预算。
    //
    // 这里的 `admin-users` 用例每个都会新建一个 PostgreSQL 数据库
    //（账号上限是全局约束，只能在干净库里验证）。`CREATE DATABASE`
    // 需要复制模板库的全部关系文件，在开启实时病毒扫描的 Windows 主机上
    // 实测单个库要 ~48s（Linux/CI 上为百毫秒级），30s 会把"机器慢"误判成"用例挂死"。
    // 放宽到 120s 不会让任何断言变宽松。
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
