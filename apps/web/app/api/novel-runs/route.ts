import { assertTrustedOrigin } from '@novel/auth';
import { startNovelRun } from '@novel/workflow';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { rejectUnknownFields } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 创建接口只接受 `requestText`；作者、状态、provider、预算全部由服务端决定。 */
const NOVEL_START_FIELDS = ['requestText'] as const;

/**
 * POST /api/novel-runs —— 创建一轮 Coordinator 问答（C1-A）。
 *
 * - 只写 `request_text`，不创建 Work / 章节 / 候选；
 * - 初始状态 `queued`，由 Worker 领取；
 * - 响应只含 `runId / status / version`，不含目标、问题或模型信息。
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);

    const body = await readJsonObject(request);
    rejectUnknownFields(body, NOVEL_START_FIELDS);

    const created = await startNovelRun(db(), {
      authorId: author.id,
      requestText: body['requestText'],
    });

    return authJson(created, 201);
  } catch (error) {
    return authErrorResponse(error);
  }
}
