import { probeDatabase } from '@novel/db';
import { APP_VERSION, STAGE, createHealthReport, toComponent } from '@novel/shared';
import type { HealthReport } from '@novel/shared';

/**
 * 组装 web 应用的健康报告。
 *
 * 与 worker 的差异：web 的应用层状态恒为 ok，但**同样探测数据库** ——
 * 数据库不可用时健康检查必须返回失败（503），不得永远返回 OK。
 */
export async function buildWebHealthReport(): Promise<HealthReport> {
  const database = await probeDatabase();

  return createHealthReport({
    service: 'web',
    version: APP_VERSION,
    components: [toComponent('app', 'ok', `stage=${STAGE}`), database],
    uptimeSeconds: Math.floor(process.uptime()),
  });
}
