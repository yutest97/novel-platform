import { assertTrustedOrigin } from '@novel/auth';
import { listChapterVersions, saveHumanChapterVersion } from '@novel/workflow';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import {
  HUMAN_VERSION_BODY_MAX_LENGTH,
  HUMAN_VERSION_FIELDS,
  requireBaseVersionId,
  requireVersionContent,
} from '@/chapter-http';
import { rejectUnknownFields } from '@/settings-http';
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

/**
 * POST /api/works/:workId/chapters/:chapterId/versions —— 保存人工版本（A1-4B-A）。
 *
 * 严格白名单：只有 `content` 与 `baseVersionId`。
 * - `baseVersionId` **必须显式提交**：`null` 表示首版，非空必须等于当前最大版本 id；
 * - `source` / `versionNo` / `createdBy` / 章节与作品 id / 时间戳都由服务端决定；
 * - 版本号、父子关系、章节状态与审计全部由 `saveHumanChapterVersion`
 *   在作品级锁 + 章节行锁的同一事务里完成；
 * - 响应**不含正文**：正文由 GET `/versions/:versionId` 读取。
 *
 * 状态码：成功 201；`baseVersionId` 与当前最大版本不一致 → 409
 * `CHAPTER_VERSION_CONFLICT`；章节已废弃 → 409 `CHAPTER_STATE_INVALID_FOR_SAVE`；
 * 正文空白 / 过短 / 超长 → 400 `CHAPTER_CONTENT_INVALID`。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id, chapterId } = await context.params;

    // 正文可到 20 万字符：这里放宽请求体上限，长度校验交给服务层统一报错。
    const body = await readJsonObject(request, { maxLength: HUMAN_VERSION_BODY_MAX_LENGTH });
    rejectUnknownFields(body, HUMAN_VERSION_FIELDS);
    const content = requireVersionContent(body);
    const baseVersionId = requireBaseVersionId(body);

    const saved = await saveHumanChapterVersion({
      db: db(),
      workId: id,
      chapterId,
      authorId: author.id,
      content,
      baseVersionId,
    });

    return authJson(
      {
        version: {
          versionId: saved.versionId,
          versionNo: saved.versionNo,
          wordCount: saved.wordCount,
          source: saved.source,
          parentVersionId: saved.parentVersionId,
          chapterStatus: saved.chapterStatus,
        },
      },
      201,
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
