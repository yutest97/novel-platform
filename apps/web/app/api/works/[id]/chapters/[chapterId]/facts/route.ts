import { listChapterFacts } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { readFactListFilter } from '@/chapter-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:workId/chapters/:chapterId/facts
 *   ?factType=<六类之一>
 *
 * 当前章节的连续性事实候选（A2-B，**只读**）。
 *
 * - 只返回**成功 run** 的候选，默认 `createdAt desc → id desc`；
 * - `factType` 可选，取值必须是六类事实之一；其它 query / 重复传参 → 400；
 * - 最多 200 条；被截断时响应带 `truncated: true` 与完整 `total`（不静默截断）；
 * - 只读接口不校验 Origin；未登录 401、管理员 403、他人作品 / 跨章节 404；
 * - 响应不含正文、prompt、模型原始响应或 `attemptToken`。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, chapterId } = await context.params;
    const filter = readFactListFilter(request);

    const result = await listChapterFacts({
      db: db(),
      workId: id,
      chapterId,
      authorId: author.id,
      ...(filter.factType === undefined ? {} : { factType: filter.factType }),
    });
    return authJson(result, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
