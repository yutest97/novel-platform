import { assertTrustedOrigin } from '@novel/auth';
import { adoptChapterCandidate } from '@novel/workflow';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { CANDIDATE_ADOPT_FIELDS, optionalRequestId } from '@/chapter-http';
import { rejectUnknownFields } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/works/:workId/chapters/:chapterId/candidates/:candidateId/adopt —— 采纳候选（A1-3B）。
 *
 * - 严格白名单，只允许可选的 `requestId`（只用于追踪，不参与幂等）；
 * - 归属、候选状态、章节状态与版本号全部由 `adoptChapterCandidate` 在
 *   作品级锁 + 同一事务里校验与写入；
 * - 首次采纳 201，重复采纳 200 且 `deduplicated=true`；
 * - **不返回正文**：正文由后续的章节 / 版本读取接口提供。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string; candidateId: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id, chapterId, candidateId } = await context.params;

    const body = await readJsonObject(request);
    rejectUnknownFields(body, CANDIDATE_ADOPT_FIELDS);
    const requestId = optionalRequestId(body);

    const result = await adoptChapterCandidate({
      db: db(),
      workId: id,
      chapterId,
      candidateId,
      authorId: author.id,
      ...(requestId === undefined ? {} : { meta: { requestId } }),
    });

    return authJson(
      {
        version: {
          versionId: result.versionId,
          versionNo: result.versionNo,
          wordCount: result.wordCount,
          chapterStatus: result.chapterStatus,
          deduplicated: result.deduplicated,
        },
      },
      result.deduplicated ? 200 : 201,
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
