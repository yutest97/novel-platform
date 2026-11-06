import { readNovelRun } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/novel-runs/:runId —— 读取当前作者的一轮问答（C1-A）。
 *
 * - 他人 run 与随机 / 畸形 id 一律 404 `NOVEL_RUN_NOT_FOUND`；
 * - 只回显状态、目标、最新说明、待答问题与选项，不返回 stateSummary、
 *   租约、provider、prompt 或模型调用日志。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { runId } = await context.params;
    const view = await readNovelRun(db(), { authorId: author.id, runId });
    return authJson(view, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
