import type { HealthComponent, HealthReport, HealthState } from '@novel/shared';
import { APP_VERSION, STAGE, createHealthReport, httpStatusFor, toComponent } from '@novel/shared';
import { probeDatabase } from '@novel/db';

import type { WorkerLoopSnapshot } from './supervisor.js';

/**
 * 循环状态缺失时的 fail-closed 快照。
 *
 * 健康检查宁可 503，也不能在没接入 supervisor 时伪装成 ready。
 */
const UNAVAILABLE_LOOP: WorkerLoopSnapshot = {
  state: 'failed',
  consecutiveFailures: 0,
  errorCode: 'WORKER_LOOP_STATE_UNAVAILABLE',
  nextRetryMs: null,
  lastSuccessAt: null,
};

/**
 * 循环状态 → 健康组件状态。
 *
 * - ready → ok；
 * - starting / retrying / failed → error（循环未就绪时 /healthz 必须是 503）；
 * - stopping → degraded（优雅关闭中，健康端口很快会关闭）。
 */
function loopHealthState(state: WorkerLoopSnapshot['state']): HealthState {
  switch (state) {
    case 'ready':
      return 'ok';
    case 'stopping':
      return 'degraded';
    case 'starting':
    case 'retrying':
    case 'failed':
      return 'error';
  }
}

/** 只输出状态、连续失败数、稳定 code 与下次重试毫秒。 */
function loopDetail(loop: WorkerLoopSnapshot): string {
  const parts = [`state=${loop.state}`, `failures=${loop.consecutiveFailures}`];
  if (loop.errorCode !== null) {
    parts.push(`code=${loop.errorCode}`);
  }
  if (loop.nextRetryMs !== null) {
    parts.push(`nextRetryMs=${loop.nextRetryMs}`);
  }
  return parts.join(' ');
}

/** 健康报告里的 queueLoop 组件（不含原始错误 message）。 */
export function buildQueueLoopComponent(loop: WorkerLoopSnapshot): HealthComponent {
  return toComponent('queueLoop', loopHealthState(loop.state), loopDetail(loop));
}

/**
 * 组装 worker 的健康报告。
 *
 * 与 web 的差异：worker 明确区分「进程」「任务循环」「数据库连接」三个组件；
 * 任一项 error 整体即为 error（HTTP 503）。数据库连接正常但循环 retrying 时
 * 同样是 503 —— 避免"数据库能 ping 通就健康"的假阳性。
 */
export async function buildWorkerHealthReport(
  loop: WorkerLoopSnapshot = UNAVAILABLE_LOOP,
): Promise<HealthReport> {
  const database = await probeDatabase();

  return createHealthReport({
    service: 'worker',
    version: APP_VERSION,
    components: [
      toComponent('worker', 'ok', `stage=${STAGE}`),
      buildQueueLoopComponent(loop),
      database,
    ],
    uptimeSeconds: Math.floor(process.uptime()),
  });
}

/** 健康报告对应的 HTTP 状态码。 */
export function healthStatusCode(report: HealthReport): number {
  return httpStatusFor(report.status);
}
