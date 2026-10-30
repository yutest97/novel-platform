import { assertTrustedOrigin, createAuthorUser, listUsers, readClientIp } from '@novel/auth';

import { requireAdminSession } from '@/admin-guard';
import { authErrorResponse, authJson, readJsonObject, requireString } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/users
 *
 * 返回账号列表（创建时间正序，第一版不分页）。
 * 字段固定为 id/email/role/status/mustChangePassword/createdAt/updatedAt，
 * 永不包含 passwordHash、会话令牌或审计详情。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdminSession(request);
    const users = await listUsers(db());
    return authJson({ users }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}

/**
 * POST /api/admin/users
 *
 * 请求体：{ email, initialPassword? }（role 固定 author，不接受外部指定）
 * - 未提供 initialPassword 时由服务器生成 ≥20 字符高熵口令；
 * - 初始密码**只在本次响应中出现一次**，不入库明文、不写日志与审计；
 * - 成功返回 201；邮箱重复 409；账号数上限 409。
 */
export async function POST(request: Request): Promise<Response> {
  const config = authConfig();

  try {
    assertTrustedOrigin(request, config);
    const actor = await requireAdminSession(request);

    const body = await readJsonObject(request);
    const email = requireString(body, 'email');

    const initialPasswordRaw = body['initialPassword'];
    const initialPassword =
      typeof initialPasswordRaw === 'string' && initialPasswordRaw !== ''
        ? initialPasswordRaw
        : undefined;

    const result = await createAuthorUser(db(), {
      actorId: actor.id,
      email,
      initialPassword,
      meta: { ip: readClientIp(request), userAgent: request.headers.get('user-agent') },
    });

    return authJson(
      {
        user: result.user,
        // 仅当口令由服务器生成时一次性返回；管理员自己输入的不回显。
        ...(result.initialPassword === null ? {} : { initialPassword: result.initialPassword }),
      },
      201,
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
