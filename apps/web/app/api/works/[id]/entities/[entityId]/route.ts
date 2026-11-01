import { assertTrustedOrigin, readClientIp } from '@novel/auth';
import { deleteEntity, updateEntity } from '@novel/works';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import {
  ENTITY_PATCH_FIELDS,
  optionalInteger,
  optionalString,
  rejectUnknownFields,
  requireRecord,
} from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/works/:id/entities/:entityId —— 编辑实体。
 *
 * - 只允许修改当前作品内的实体；他人作品 → 404；
 * - 请求体是**严格白名单**：只接受 name / orderIndex / attributes。
 *   出现 id / workId / authorId / entityType / createdAt / updatedAt /
 *   deletedAt（或任何未知字段）一律 400 VALIDATION_FAILED，
 *   不静默忽略；
 * - 更新属性后追加新版本快照，旧版本保留；
 * - 与 `entity.updated` 审计同事务；
 * - 归属、未删除状态与版本号计算都在作品级锁 + 同一事务内完成。
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; entityId: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id, entityId } = await context.params;

    const body = await readJsonObject(request);
    rejectUnknownFields(body, ENTITY_PATCH_FIELDS);

    const name = optionalString(body, 'name');
    const orderIndex = optionalInteger(body, 'orderIndex');
    const attributes =
      body['attributes'] === undefined ? undefined : requireRecord(body, 'attributes');

    const entity = await updateEntity(db(), {
      workId: id,
      authorId: author.id,
      entityId,
      ...(name === undefined ? {} : { name }),
      ...(orderIndex === undefined ? {} : { orderIndex }),
      ...(attributes === undefined ? {} : { attributes }),
      meta: {
        ip: readClientIp(request),
        userAgent: request.headers.get('user-agent'),
      },
    });

    return authJson({ entity }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}

/**
 * DELETE /api/works/:id/entities/:entityId —— 软删除实体。
 *
 * - 第一版只做 realm_level 的软删除；
 * - 被同作品内其它实体引用时返回 `ENTITY_IN_USE`，不删除；
 * - 软删除与 `entity.deleted` 审计同事务；
 * - 归属、未删除状态与引用检查都在作品级锁 + 同一事务内重新执行，
 *   因此"删除后又被并发编辑"不会产生新的版本或审计。
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; entityId: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id, entityId } = await context.params;

    await deleteEntity(db(), {
      workId: id,
      authorId: author.id,
      entityId,
      meta: {
        ip: readClientIp(request),
        userAgent: request.headers.get('user-agent'),
      },
    });

    return authJson({ deleted: true }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
