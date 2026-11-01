import { assertTrustedOrigin, readClientIp } from '@novel/auth';
import { ALLOWED_ENTITY_TYPE, createEntity, listEntities } from '@novel/works';

import { authErrorResponse, authJson, readJsonObject, requireString } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { optionalInteger, requireRecord } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:id/entities?type=realm_level —— 列出作品内指定类型的实体。
 *
 * 只允许作品所有者访问；按 order_index 升序返回未删除的实体。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id } = await context.params;

    const url = new URL(request.url);
    const entityType = url.searchParams.get('type') ?? ALLOWED_ENTITY_TYPE;

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
 * POST /api/works/:id/entities —— 新建实体（第一版只开放 realm_level）。
 *
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
    const entityType = requireString(body, 'entityType');
    const name = requireString(body, 'name');
    const orderIndex = optionalInteger(body, 'orderIndex');
    const attributes = requireRecord(body, 'attributes');

    const entity = await createEntity(db(), {
      workId: id,
      authorId: author.id,
      entityType,
      name,
      ...(orderIndex === undefined ? {} : { orderIndex }),
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
