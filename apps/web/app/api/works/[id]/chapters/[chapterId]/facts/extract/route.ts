import { assertTrustedOrigin } from '@novel/auth';
import { extractChapterFacts } from '@novel/workflow';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { FACT_EXTRACT_FIELDS, requireFactSourceVersionId } from '@/chapter-http';
import { chapterFactProvider } from '@/fact-provider';
import { rejectUnknownFields } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/works/:workId/chapters/:chapterId/facts/extract
 *   手动触发当前定稿版本的连续性事实提取（A2-B）。
 *
 * 请求体严格白名单：只有 `sourceVersionId`，必须显式出现且非空（不允许 null）。
 *
 * - 章节必须 `finalized`，且 `sourceVersionId` 必须是当前最新正式版本；
 * - 同一版本已有成功 run → 200 且 `created=false`（幂等，不新增候选与审计）；
 * - 同一版本正在提取 → 409 `CONTINUITY_EXTRACTION_IN_PROGRESS`；
 * - 本次尝试已被接管 → 409 `CONTINUITY_EXTRACTION_LEASE_LOST`；
 * - Provider / 模型输出错误 → 稳定错误码（502 / 422），不是 500；
 * - 响应**不含正文、prompt、模型原始响应、attemptToken**。
 *
 * 只产生候选：不写回人物 / 物品 / 势力 / 关系 / 境界，不自动采纳。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id, chapterId } = await context.params;

    const body = await readJsonObject(request);
    rejectUnknownFields(body, FACT_EXTRACT_FIELDS);
    const sourceVersionId = requireFactSourceVersionId(body);

    const result = await extractChapterFacts({
      db: db(),
      provider: chapterFactProvider(),
      authorId: author.id,
      workId: id,
      chapterId,
      sourceVersionId,
    });

    return authJson(
      {
        extraction: {
          runId: result.runId,
          created: result.created,
          sourceVersionId: result.sourceVersionId,
          sourceVersionNo: result.sourceVersionNo,
          agentName: result.agentName,
          agentVersion: result.agentVersion,
          provider: result.provider,
          model: result.model,
          factCount: result.facts.length,
          factTypeCounts: result.factTypeCounts,
        },
      },
      result.created ? 201 : 200,
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
