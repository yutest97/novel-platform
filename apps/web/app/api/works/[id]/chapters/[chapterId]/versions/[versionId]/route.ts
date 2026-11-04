import { getChapterVersion } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:workId/chapters/:chapterId/versions/:versionId —— 正式正文（A1-4A）。
 *
 * - 版本必须同时属于该作品与章节，否则 404；
 * - 只返回正文与版本元信息，不含候选、任务快照、prompt 或 Key；
 * - 管理员 403；未登录 401。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string; versionId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, chapterId, versionId } = await context.params;

    const version = await getChapterVersion({
      db: db(),
      workId: id,
      authorId: author.id,
      chapterId,
      versionId,
    });
    return authJson({ version }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
