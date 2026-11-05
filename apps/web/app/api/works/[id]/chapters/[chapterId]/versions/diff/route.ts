import { diffChapterVersions } from '@novel/workflow';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { readDiffVersionIds } from '@/chapter-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:workId/chapters/:chapterId/versions/diff
 *   ?fromVersionId=<uuid>&toVersionId=<uuid>
 *
 * 两个正式版本之间的**只读**行级 diff（A1-4B-C-A）。
 *
 * - 只允许 GET；只读接口不校验 Origin；
 * - 未登录 401；管理员 403；他人作品 / 章节 / 版本统一 404；
 * - 两个版本都必须属于该作品 + 该章节；跨作品 / 跨章节与"不存在"不可区分；
 * - 两个 id 相同 → 返回全 equal（不是错误）；
 * - 响应只含版本元信息与 diff 行，**不含两份完整正文**、作者 id 或内部字段；
 * - 非法 UUID / 缺参 / 重复传参 / 未知参数 → 400 `VALIDATION_FAILED`；
 * - 正文规模超出对比上限 → 400 `CHAPTER_DIFF_TOO_LARGE`。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, chapterId } = await context.params;
    const { fromVersionId, toVersionId } = readDiffVersionIds(request);

    const diff = await diffChapterVersions({
      db: db(),
      workId: id,
      chapterId,
      authorId: author.id,
      fromVersionId,
      toVersionId,
    });

    return authJson({ diff }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
