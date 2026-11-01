import { assertTrustedOrigin, readClientIp } from '@novel/auth';
import { DEFAULT_ENTITY_TYPE, reorderEntities } from '@novel/works';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { rejectUnknownFields, optionalStrictString, requireStringArray } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 排序接口的允许字段（严格白名单）。
 *
 * `entityType` 在其中：它指明要排序哪一类实体，取值由业务层校验
 * （必须是规则包声明且本轮支持的类型）。作品归属类字段
 * （id / workId / authorId / 时间戳……）一律不允许提交。
 */
const REORDER_FIELDS = ['entityType', 'entityIds'] as const;

/**
 * PUT /api/works/:id/entities/reorder —— 调整实体顺序。
 *
 * - 请求体是严格白名单：只接受 entityType / entityIds；
 * - `entityType` **未提供**时默认 realm_level（兼容旧调用方）；
 *   一旦出现就必须是非空字符串 —— 数字 / null / 数组 / 对象
 *   一律 400 VALIDATION_FAILED，绝不被静默当成默认类型；
 * - 只允许**完整、无重复、且全部属于当前作品同类型**的实体集合；
 * - 集合校验在作品级锁 + 同一事务内重新执行，
 *   因此并发排序不会写出混合顺序，也不会把死锁暴露为 500；
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
    rejectUnknownFields(body, REORDER_FIELDS);

    const entityType = optionalStrictString(body, 'entityType', DEFAULT_ENTITY_TYPE);
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
