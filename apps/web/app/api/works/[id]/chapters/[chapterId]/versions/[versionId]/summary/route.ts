import { getChapterVersionSummaryForAuthor } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:workId/chapters/:chapterId/versions/:versionId/summary
 *
 * 某个正式版本已成功生成的章节摘要（A2-D-D，**只读**）。
 *
 * - 摘要按 `sourceVersionId` 定位：历史版本读到的是**那个版本**的摘要，
 *   不会被"当前最新版本"的摘要替换；
 * - 版本必须属于该作品与章节；跨作品 / 跨章节 / 随机 id / 尚未生成，
 *   一律 404 `SUMMARY_NOT_FOUND`（不通过错误码泄露存在性）；
 * - 管理员 403、未登录 401；
 * - 不触发摘要任务、不重试、不重建、不写审计；不返回正文、generation task、
 *   provider / model 或 prompt；响应 `Cache-Control: no-store`。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string; versionId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, chapterId, versionId } = await context.params;

    const summary = await getChapterVersionSummaryForAuthor({
      db: db(),
      workId: id,
      authorId: author.id,
      chapterId,
      versionId,
    });

    return authJson({ summary }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
