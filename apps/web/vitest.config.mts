import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Web 包测试配置。
 *
 * 路由处理器使用 `@/...` 别名（与 tsconfig 的 paths 一致），
 * 这里补上解析规则；测试直接调用路由函数，不需要启动 Next 服务器。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 这些用例共享同一个 PostgreSQL：并行跑不同文件会互相影响
    //（例如统计账号总数、依赖登录限流计数），因此串行执行。
    fileParallelism: false,
  },
});
