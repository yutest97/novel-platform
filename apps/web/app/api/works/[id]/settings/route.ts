import { assertTrustedOrigin, readClientIp } from '@novel/auth';
import { getSettingsCenter, updateDirection } from '@novel/works';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { IMMUTABLE_SETTING_FIELDS, rejectImmutableFields, requireRecord } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:id/settings —— 设定中心。
 *
 * 只允许作品所有者访问；他人一律 404（不泄露作品是否存在）。
 * 返回：作品方向、xuanhuan 规则包的公开 schema 摘要、境界体系实体列表。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id } = await context.params;

    const settings = await getSettingsCenter(db(), { workId: id, authorId: author.id });
    return authJson({ settings }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}

/**
 * PATCH /api/works/:id/settings —— 更新作品方向。
 *
 * - 字段必须符合该作品题材的 field_schema；
 * - 客户端不能修改规则包 code 或 schema_ref；
 * - 与 `settings.updated` 审计同事务。
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id } = await context.params;

    const body = await readJsonObject(request);
    rejectImmutableFields(body, IMMUTABLE_SETTING_FIELDS);

    const values = requireRecord(body, 'direction');

    const direction = await updateDirection(db(), {
      workId: id,
      authorId: author.id,
      values,
      meta: {
        ip: readClientIp(request),
        userAgent: request.headers.get('user-agent'),
      },
    });

    return authJson({ direction }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
