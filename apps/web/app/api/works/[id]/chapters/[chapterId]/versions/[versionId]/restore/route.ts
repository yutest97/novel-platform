import { assertTrustedOrigin } from '@novel/auth';
import { restoreChapterVersion } from '@novel/workflow';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { RESTORE_VERSION_FIELDS, requireRestoreBaseVersionId } from '@/chapter-http';
import { rejectUnknownFields } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/works/:workId/chapters/:chapterId/versions/:versionId/restore —— 历史版本恢复（A1-4B-C-B）。
 *
 * 语义：
 * - `:versionId` 是**准备恢复的历史版本**，只读：不会被修改或删除；
 * - 请求体只有 `baseVersionId`（恢复前的最新版本 id），**必须显式出现且不允许 null**；
 * - 新版本正文 / 字数原样复制历史版本，`parentVersionId = baseVersionId`，
 *   `source = human`，章节状态按人工保存语义进入 `in_review`；
 * - 作品级 advisory lock + 章节行锁，与人工保存共用同一串行化边界；
 * - 审计 `chapter.version_restored` 只记 ids / 版本号 / 字数，**不含正文**，
 *   审计失败整体回滚。
 *
 * 状态码：成功 201；已是最新版本 → 409 `CHAPTER_VERSION_ALREADY_LATEST`；
 * 基线过期 → 409 `CHAPTER_VERSION_CONFLICT`；已废弃 → 409
 * `CHAPTER_STATE_INVALID_FOR_SAVE`；版本不属于该章节 / 作品 → 404；
 * 缺字段 / null / 非法 UUID / 未知字段 → 400。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string; versionId: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id, chapterId, versionId } = await context.params;

    const body = await readJsonObject(request);
    rejectUnknownFields(body, RESTORE_VERSION_FIELDS);
    const baseVersionId = requireRestoreBaseVersionId(body);

    const restored = await restoreChapterVersion({
      db: db(),
      workId: id,
      chapterId,
      authorId: author.id,
      sourceVersionId: versionId,
      baseVersionId,
    });

    return authJson(
      {
        version: {
          versionId: restored.versionId,
          versionNo: restored.versionNo,
          wordCount: restored.wordCount,
          source: restored.source,
          parentVersionId: restored.parentVersionId,
          restoredFromVersionId: restored.restoredFromVersionId,
          chapterStatus: restored.chapterStatus,
        },
      },
      201,
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
