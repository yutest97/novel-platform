import { assertTrustedOrigin, readClientIp } from '@novel/auth';
import { appendItemEvent, listItemEvents } from '@novel/works';

import { authErrorResponse, authJson, readJsonObject, requireString } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import {
  ITEM_EVENT_CREATE_FIELDS,
  optionalNonNegativeInteger,
  optionalNullableString,
  optionalPositiveInteger,
} from '@/item-events-http';
import { rejectUnknownFields } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:id/items/:itemId/events —— 事件列表。
 *
 * - `afterSeq` 游标分页（seq 升序），`limit` 1–100，缺省 50；
 * - 软删除的物品**仍然可读**（历史不能因为物品归档而消失）；
 * - 只返回定位信息（id / 名称 / deleted），不含人物属性或秘密。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, itemId } = await context.params;
    const url = new URL(request.url);

    const afterSeq = optionalNonNegativeInteger(url.searchParams, 'afterSeq');
    const limit = optionalPositiveInteger(url.searchParams, 'limit');

    const page = await listItemEvents(db(), {
      workId: id,
      authorId: author.id,
      itemId,
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(limit === undefined ? {} : { limit }),
    });

    return authJson({ ...page }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}

/**
 * POST /api/works/:id/items/:itemId/events —— 追加事件。
 *
 * - 白名单只有 eventType / toHolder / note / idempotencyKey；
 *   **提交 fromHolder 一律 400**（转出方由服务端推导）；
 * - `idempotencyKey` 必填：同键同内容返回既有事件（`deduplicated: true`，HTTP 200），
 *   同键不同内容 409；
 * - 状态机、引用校验、seq 分配、审计全部在作品级锁 + 同一事务内完成。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id, itemId } = await context.params;

    const body = await readJsonObject(request);
    rejectUnknownFields(body, ITEM_EVENT_CREATE_FIELDS);

    const eventType = requireString(body, 'eventType');
    const toHolder = optionalNullableString(body, 'toHolder');
    const note = optionalNullableString(body, 'note');
    const idempotencyKey = requireString(body, 'idempotencyKey');

    const result = await appendItemEvent(db(), {
      workId: id,
      authorId: author.id,
      itemId,
      eventType,
      toHolder: toHolder ?? null,
      note: note ?? null,
      idempotencyKey,
      meta: {
        ip: readClientIp(request),
        userAgent: request.headers.get('user-agent'),
      },
    });

    return authJson({ ...result }, result.deduplicated ? 200 : 201);
  } catch (error) {
    return authErrorResponse(error);
  }
}
