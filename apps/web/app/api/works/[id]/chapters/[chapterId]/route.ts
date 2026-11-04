import { getChapterDetail } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:workId/chapters/:chapterId —— 章节详情（A1-3B）。
 *
 * 返回章节本身 + 最新生成任务摘要 + 候选摘要列表（**不含正文**）。
 * 他人作品 / 不存在的章节一律 404；管理员 403。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, chapterId } = await context.params;

    const detail = await getChapterDetail({
      db: db(),
      workId: id,
      authorId: author.id,
      chapterId,
    });

    return authJson(detail, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
