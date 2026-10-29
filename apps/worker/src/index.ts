import { disconnectPrisma } from '@novel/db';

import { startHealthServer } from './server.js';

function main(): void {
  console.log('[worker] 启动中……');
  console.log('[worker] M1-A 阶段：不消费任务、不接入模型 API、不创建业务表。');

  const server = startHealthServer();

  const shutdown = (signal: string): void => {
    console.log(`[worker] 收到 ${signal}，开始优雅退出……`);
    server.close(() => {
      void disconnectPrisma().finally(() => {
        process.exit(0);
      });
    });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

try {
  main();
} catch (error: unknown) {
  console.error('[worker] 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
}
