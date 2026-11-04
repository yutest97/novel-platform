import { getGenerationTaskForAuthor, toTaskSummary } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:workId/generation-tasks/:taskId —— 任务状态（A1-3B）。
 *
 * 只返回状态、检查点、尝试次数与**安全错误文案**；
 * 不返回 `input_snapshot`、`input_hash`、`request_id`、租约或任何模型内部信息。
 * 他人作品 404；管理员 403。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; taskId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, taskId } = await context.params;

    const task = await getGenerationTaskForAuthor(db(), {
      authorId: author.id,
      workId: id,
      taskId,
    });

    return authJson({ task: toTaskSummary(task) }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
