import { assertTrustedOrigin } from '@novel/auth';
import { answerNovelRun } from '@novel/workflow';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { rejectUnknownFields } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 回答接口只接受乐观版本与纯文本回答。 */
const NOVEL_ANSWER_FIELDS = ['expectedVersion', 'answer'] as const;

/**
 * POST /api/novel-runs/:runId/answer —— 提交作者回答（C1-A）。
 *
 * - 需要 `expectedVersion` 与当前 `state_version` 一致，否则 409；
 * - 同版本同答案重复提交幂等，同版本不同答案 409 `NOVEL_RUN_ANSWER_CONFLICT`；
 * - 非 `waiting_user` 状态 409 `NOVEL_RUN_INVALID_STATE`；
 * - 回答只入库为纯文本，不触发任何模型调用（由 Worker 领取）。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { runId } = await context.params;

    const body = await readJsonObject(request);
    rejectUnknownFields(body, NOVEL_ANSWER_FIELDS);

    const view = await answerNovelRun(db(), {
      authorId: author.id,
      runId,
      expectedVersion: body['expectedVersion'],
      answer: body['answer'],
    });

    return authJson(view, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
