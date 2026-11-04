import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { APP_VERSION, STAGE, readIntEnv } from '@novel/shared';

import { buildWorkerHealthReport, healthStatusCode } from './health.js';
import type { WorkerLoopSnapshot } from './supervisor.js';

/** worker 健康检查默认端口。 */
export const DEFAULT_WORKER_PORT = 3001;

export interface WorkerHealthServerOptions {
  /**
   * 读取当前循环状态。
   *
   * 未提供时健康检查按 fail-closed 处理（queueLoop=failed → 503），
   * 绝不默认返回 healthy。
   */
  readonly loopState?: () => WorkerLoopSnapshot;
}

/**
 * 启动 worker 的健康检查 HTTP 服务。
 *
 * 与任务轮询并发运行：`/healthz` 只反映进程、循环与数据库状态，不参与任务领取。
 * 停止时由进程入口调用 `server.close()` 释放端口。
 */
export function startHealthServer(
  port: number = readIntEnv(process.env, 'WORKER_PORT', DEFAULT_WORKER_PORT),
  options: WorkerHealthServerOptions = {},
): Server {
  const server = createServer((request, response) => {
    const url = request.url ?? '/';

    if (url === '/healthz' || url.startsWith('/healthz?')) {
      void buildWorkerHealthReport(options.loopState?.()).then((report) => {
        const body = JSON.stringify({ ...report, stage: STAGE });
        response.writeHead(healthStatusCode(report), {
          'content-type': 'application/json; charset=utf-8',
        });
        response.end(body);
      });
      return;
    }

    if (url === '/' || url === '/info') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ service: 'worker', version: APP_VERSION, stage: STAGE }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[worker] 健康检查服务已启动： http://0.0.0.0:${port}/healthz`);
  });

  return server;
}
