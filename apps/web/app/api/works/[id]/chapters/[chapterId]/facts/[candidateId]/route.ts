import { getChapterFactCandidate } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:workId/chapters/:chapterId/facts/:candidateId
 *
 * 单条连续性事实候选 + 所属 run 的安全元信息（A2-B，**只读**）。
 *
 * - candidate 必须同时属于该作品与该章节；跨作品 / 跨章节 / 随机 id 统一 404；
 * - 只读接口不校验 Origin；未登录 401、管理员 403；
 * - 不返回正文、prompt、模型原始输出或 `attemptToken`；不修改任何数据。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string; candidateId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, chapterId, candidateId } = await context.params;

    const detail = await getChapterFactCandidate({
      db: db(),
      workId: id,
      chapterId,
      authorId: author.id,
      candidateId,
    });
    return authJson(detail, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
