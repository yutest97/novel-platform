import { getChapterReviewForAuthor } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:workId/chapters/:chapterId/candidates/:candidateId/review
 *
 * 候选对应的 `chapter.review` 任务状态、review run 与 issues（A2-C-D，**只读**）。
 *
 * - 只读：不触发审阅、不重试、不采纳、不写审计，响应 `Cache-Control: no-store`；
 * - 候选必须同时属于该作品与该章节；跨作品 / 跨章节 / 错候选 / 没有审阅任务
 *   一律 404 `REVIEW_NOT_FOUND`（不通过错误码泄露存在性）；
 * - 任务已入队但 run 尚未创建 → 200 且 `run = null`，供前端轮询；
 * - 管理员 403、未登录 401；
 * - 不返回正文全文、prompt、模型原始响应、provider / model、租约、
 *   `inputSnapshot` / `inputHash` / `requestId`。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string; candidateId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, chapterId, candidateId } = await context.params;

    const review = await getChapterReviewForAuthor({
      db: db(),
      workId: id,
      authorId: author.id,
      chapterId,
      candidateId,
    });

    return authJson({ review }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
