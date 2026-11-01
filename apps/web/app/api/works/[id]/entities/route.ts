import { assertTrustedOrigin, readClientIp } from '@novel/auth';
import { DEFAULT_ENTITY_TYPE, createEntity, listEntities } from '@novel/works';

import { authErrorResponse, authJson, readJsonObject, requireString } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { ENTITY_CREATE_FIELDS, rejectUnknownFields, requireRecord } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:id/entities —— 列出作品内的实体。
 *
 * - 只允许作品所有者访问；
 * - 只接受规则包声明且本轮已实现 CRUD 的类型
 *   （`realm_level` / `faction` / `character` / `item` / `technique`）：其它 entityType 一律 400
 *   （`ENTITY_TYPE_NOT_ALLOWED`），不接受任意类型；
 * - 按 order_index 升序返回未删除的实体。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id } = await context.params;

    const url = new URL(request.url);
    const entityType = url.searchParams.get('type') ?? DEFAULT_ENTITY_TYPE;

    const entities = await listEntities(db(), {
      workId: id,
      authorId: author.id,
      entityType,
    });
    return authJson({ entities }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}

/**
 * POST /api/works/:id/entities —— 新建实体（境界 / 势力 / 人物 / 物品 / 功法）。
 *
 * - 请求体是**严格白名单**：只接受 entityType / name / attributes，
 *   出现任何其它字段（id / workId / authorId / 时间戳 / orderIndex……）一律 400；
 * - **排序值由服务端独占**：新建自动追加到"最大未删除 order_index + 1"，
 *   客户端不能指定；调整顺序只能走 `PUT /entities/reorder`；
 * - 属性按规则包的 field_schema 校验；
 * - 创建 + 第一版快照 + `entity.created` 审计同事务；
 * - 同作品同类型重名 → 稳定错误码 `ENTITY_NAME_TAKEN`。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id } = await context.params;

    const body = await readJsonObject(request);
    rejectUnknownFields(body, ENTITY_CREATE_FIELDS);

    const entityType = requireString(body, 'entityType');
    const name = requireString(body, 'name');
    const attributes = requireRecord(body, 'attributes');

    const entity = await createEntity(db(), {
      workId: id,
      authorId: author.id,
      entityType,
      name,
      attributes,
      meta: {
        ip: readClientIp(request),
        userAgent: request.headers.get('user-agent'),
      },
    });

    return authJson({ entity }, 201);
  } catch (error) {
    return authErrorResponse(error);
  }
}
