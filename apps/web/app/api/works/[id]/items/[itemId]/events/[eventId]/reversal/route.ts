import { assertTrustedOrigin, readClientIp } from '@novel/auth';
import { reverseItemEvent } from '@novel/works';

import { authErrorResponse, authJson, readJsonObject, requireString } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { ITEM_EVENT_REVERSAL_FIELDS, optionalNullableString } from '@/item-events-http';
import { rejectUnknownFields } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/works/:id/items/:itemId/events/:eventId/reversal —— 冲正。
 *
 * - 请求体只接受 note / idempotencyKey；
 *   反向事件类型与双方持有人**全部由服务端推导**；
 * - 只允许冲正当前最新、且未被冲正过的普通事件；
 * - 冲正通过追加一条反向事件完成，历史行一个字都不改；
 * - 与 `item.event_reversed` 审计同事务。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; itemId: string; eventId: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id, itemId, eventId } = await context.params;

    const body = await readJsonObject(request);
    rejectUnknownFields(body, ITEM_EVENT_REVERSAL_FIELDS);

    const note = optionalNullableString(body, 'note');
    const idempotencyKey = requireString(body, 'idempotencyKey');

    const result = await reverseItemEvent(db(), {
      workId: id,
      authorId: author.id,
      itemId,
      eventId,
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
