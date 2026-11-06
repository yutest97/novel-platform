import { assertTrustedOrigin } from '@novel/auth';
import { decideChapterFact } from '@novel/workflow';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { FACT_DECISION_FIELDS, requireFactDecision } from '@/chapter-http';
import { rejectUnknownFields } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/works/:workId/chapters/:chapterId/facts/:candidateId/decision
 *   记录作者对一条事实候选的决定（A2-F-A）。
 *
 * 请求体严格白名单：只有 `decision`（`accepted` | `rejected`）。
 *
 * - 作者必须拥有作品；跨作品 / 跨章节 / 随机候选 → 404；
 * - 只允许成功 run 的候选；
 * - 只允许当前定稿且候选所属版本仍是最新正式版本 → 否则 409
 *   `CONTINUITY_FACT_DECISION_STALE`；
 * - 同决定重复提交 → 200 且 `deduplicated=true`（不新增行、不新增审计）；
 * - 不同决定 → 409 `CONTINUITY_FACT_ALREADY_DECIDED`，不翻转、不提供改判；
 * - 首次决定 → 201。
 *
 * 决定**不写回任何实体或物品事件**：接受只表示"可作为后续写回输入"。
 * 响应只含 candidateId / decision / decidedAt / deduplicated，
 * 不含 payload、正文、prompt 或模型原始响应。
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
    rejectUnknownFields(body, FACT_DECISION_FIELDS);
    const decision = requireFactDecision(body);

    const result = await decideChapterFact({
      db: db(),
      authorId: author.id,
      workId: id,
      chapterId,
      candidateId,
      decision,
    });

    return authJson({ decision: result }, result.deduplicated ? 200 : 201);
  } catch (error) {
    return authErrorResponse(error);
  }
}
