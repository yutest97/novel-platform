import { listChapterVersions } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:workId/chapters/:chapterId/versions —— 正式版本摘要（A1-4A）。
 *
 * - 按 versionNo 倒序（最新在前）；
 * - 只返回 id / versionNo / source / wordCount / createdAt，**不含正文**；
 * - 只允许作品作者；跨作品 / 跨章节 404；管理员 403。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, chapterId } = await context.params;

    const versions = await listChapterVersions({
      db: db(),
      workId: id,
      authorId: author.id,
      chapterId,
    });
    return authJson({ versions }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
