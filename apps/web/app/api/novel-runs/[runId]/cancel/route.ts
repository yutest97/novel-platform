import { assertTrustedOrigin } from '@novel/auth';
import { cancelNovelRun } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/novel-runs/:runId/cancel —— 取消一轮问答（C1-A）。
 *
 * - 所有非终态幂等：queued / running 直接 cancelled，等待中的问题作废；
 * - 已是终态时原样返回，不重复改版本；
 * - 不接收请求体字段，作者与会话绑定。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { runId } = await context.params;
    const view = await cancelNovelRun(db(), { authorId: author.id, runId });
    return authJson(view, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
