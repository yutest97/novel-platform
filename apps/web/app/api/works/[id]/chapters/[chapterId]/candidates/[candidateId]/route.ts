import { getChapterCandidate } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:workId/chapters/:chapterId/candidates/:candidateId —— 候选详情（A1-3B）。
 *
 * - 候选必须属于当前作品与章节；跨作品 / 跨章节返回 `CHAPTER_CANDIDATE_NOT_FOUND`（404）；
 * - 正文只对作品作者可见；管理员 403、他人作品 404；
 * - 已 adopted 的候选仍可读取（用于确认正式版本来源）；
 * - 响应不含 prompt、任务快照、API Key 或模型原始错误。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string; candidateId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, chapterId, candidateId } = await context.params;

    const candidate = await getChapterCandidate({
      db: db(),
      workId: id,
      authorId: author.id,
      chapterId,
      candidateId,
    });

    return authJson({ candidate }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
