import { getChapterFactRun } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:workId/chapters/:chapterId/fact-runs/:runId
 *
 * 一次连续性事实提取运行的状态（A2-B，**只读**）。
 *
 * - run 必须同时属于该作品与该章节；跨作品 / 跨章节 / 随机 id 统一 404；
 * - 只读接口不校验 Origin；未登录 401、管理员 403；
 * - 只返回稳定 `errorCode`；不返回 `attemptToken`、原始错误消息、正文或内部细节；
 * - `deduplicated` 是提取响应的语义，不由本接口返回。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string; runId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, chapterId, runId } = await context.params;

    const run = await getChapterFactRun({
      db: db(),
      workId: id,
      chapterId,
      authorId: author.id,
      runId,
    });
    return authJson({ run }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
