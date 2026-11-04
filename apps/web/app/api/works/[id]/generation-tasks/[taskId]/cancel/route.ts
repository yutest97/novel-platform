import { assertTrustedOrigin } from '@novel/auth';
import { requestTaskCancellationForAuthor, toTaskSummary } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/works/:workId/generation-tasks/:taskId/cancel —— 请求取消（A1-3B）。
 *
 * - `queued`：直接进入 `cancelled`；
 * - `processing`：只写 `cancel_requested_at`，Worker 在下一步之前停止；
 * - 终态：幂等返回当前状态，不复活任务；
 * - 他人作品 404；管理员 403；缺少 Origin 403。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; taskId: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id, taskId } = await context.params;

    const task = await requestTaskCancellationForAuthor(db(), {
      authorId: author.id,
      workId: id,
      taskId,
    });

    return authJson({ task: toTaskSummary(task) }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
