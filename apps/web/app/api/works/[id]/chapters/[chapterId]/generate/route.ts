import { assertTrustedOrigin } from '@novel/auth';
import { createModelProvider, readProviderConfig, startChapterDraft } from '@novel/workflow';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import {
  CHAPTER_GENERATE_FIELDS,
  optionalStyle,
  optionalTargetWords,
  requireRequestId,
} from '@/chapter-http';
import { rejectUnknownFields } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/works/:workId/chapters/:chapterId/generate —— 提交章节生成任务（A1-3B）。
 *
 * - 严格白名单 `requestId / targetWords / style`：
 *   `provider` / `model` / `authorId` / `status` 一律 400；
 * - provider 与 model **只来自服务端配置**（`MODEL_PROVIDER` / `MODEL_NAME`），
 *   这里只把配置解析出的名称写进任务行，不接触 Key；
 * - `input_snapshot` 只含 `targetWords` / `style`；
 * - 同一 `requestId` 同内容返回既有任务（200），不同内容返回 `TASK_REQUEST_CONFLICT`（409）；
 * - 只创建任务，不在这里执行工作流（由 Worker 领取）。
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
    rejectUnknownFields(body, CHAPTER_GENERATE_FIELDS);

    const requestId = requireRequestId(body);
    const targetWords = optionalTargetWords(body);
    const style = optionalStyle(body);

    // 只读配置并构造 Provider（不发起任何网络请求）；
    // 名称与实际默认模型都来自服务端，客户端无法覆盖。
    const provider = createModelProvider(readProviderConfig());

    const { task, created } = await startChapterDraft({
      db: db(),
      workId: id,
      authorId: author.id,
      chapterId,
      requestId,
      provider: provider.name,
      model: provider.defaultModel,
      ...(targetWords === undefined ? {} : { targetWords }),
      ...(style === undefined ? {} : { style }),
    });

    return authJson({ task }, created ? 201 : 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
