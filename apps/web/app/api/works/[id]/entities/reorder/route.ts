import { assertTrustedOrigin, readClientIp } from '@novel/auth';
import { ALLOWED_ENTITY_TYPE, reorderEntities } from '@novel/works';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { rejectImmutableFields, requireStringArray } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 排序接口里不允许出现的字段。
 *
 * 注意 `entityType` **不在**其中：它指明要排序哪一类实体（第一版只有
 * realm_level），由业务层校验取值；作品归属类字段才是不可提交的。
 */
const IMMUTABLE_REORDER_FIELDS = [
  'id',
  'workId',
  'work_id',
  'authorId',
  'author_id',
  'createdAt',
  'created_at',
] as const;

/**
 * PUT /api/works/:id/entities/reorder —— 调整实体顺序。
 *
 * - 只允许**完整、无重复、且全部属于当前作品**的实体集合；
 * - 更新 order_index 与 `entity.reordered` 审计同事务。
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id } = await context.params;

    const body = await readJsonObject(request);
    rejectImmutableFields(body, IMMUTABLE_REORDER_FIELDS);

    const entityType =
      typeof body['entityType'] === 'string' ? body['entityType'] : ALLOWED_ENTITY_TYPE;
    const entityIds = requireStringArray(body, 'entityIds');

    const entities = await reorderEntities(db(), {
      workId: id,
      authorId: author.id,
      entityType,
      entityIds,
      meta: {
        ip: readClientIp(request),
        userAgent: request.headers.get('user-agent'),
      },
    });

    return authJson({ entities }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
