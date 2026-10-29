import { NextResponse } from 'next/server';

import { STAGE, httpStatusFor } from '@novel/shared';

import { buildWebHealthReport } from '@/health';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Web 应用健康检查。
 *
 * - 返回应用状态（服务名、版本、运行时长）。
 * - 同时探测数据库：数据库连接失败时必须返回 503，不得永远返回 OK。
 */
export async function GET(): Promise<NextResponse> {
  const report = await buildWebHealthReport();

  return NextResponse.json({ ...report, stage: STAGE }, { status: httpStatusFor(report.status) });
}
