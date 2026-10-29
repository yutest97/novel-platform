import type { HealthReport } from '@novel/shared';
import { APP_VERSION, STAGE, createHealthReport, httpStatusFor, toComponent } from '@novel/shared';
import { probeDatabase } from '@novel/db';

/**
 * 组装 worker 的健康报告。
 *
 * 与 web 的差异：worker 明确区分"worker 自身状态"与"数据库连接状态"两个组件，
 * 任何一项失败整体即为 error（HTTP 503）。
 */
export async function buildWorkerHealthReport(): Promise<HealthReport> {
  const database = await probeDatabase();

  return createHealthReport({
    service: 'worker',
    version: APP_VERSION,
    components: [toComponent('worker', 'ok', `stage=${STAGE}`), database],
    uptimeSeconds: Math.floor(process.uptime()),
  });
}

/** 健康报告对应的 HTTP 状态码。 */
export function healthStatusCode(report: HealthReport): number {
  return httpStatusFor(report.status);
}
