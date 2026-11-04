import { assertTrustedOrigin, readClientIp } from '@novel/auth';
import { createChapter } from '@novel/workflow';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { CHAPTER_CREATE_FIELDS, requireChapterTitle, requirePositiveInteger } from '@/chapter-http';
import { rejectUnknownFields } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/works/:workId/chapters —— 创建章节（A1-3B）。
 *
 * - 只有作品作者可以创建；管理员 403、他人作品 404；
 * - 严格白名单 `chapterNo / title`：`status` / `createdAt` / `authorId` 等一律 400；
 * - 章号在作品内唯一，重复返回 `CHAPTER_NO_TAKEN`（409）；
 * - 初始 `status = planned`，创建与 `chapter.created` 审计同事务。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id } = await context.params;

    const body = await readJsonObject(request);
    rejectUnknownFields(body, CHAPTER_CREATE_FIELDS);

    const chapterNo = requirePositiveInteger(body, 'chapterNo');
    const title = requireChapterTitle(body);

    const chapter = await createChapter({
      db: db(),
      workId: id,
      authorId: author.id,
      chapterNo,
      title,
      meta: { ip: readClientIp(request), userAgent: request.headers.get('user-agent') },
    });

    return authJson({ chapter }, 201);
  } catch (error) {
    return authErrorResponse(error);
  }
}
