import { assertTrustedOrigin, readClientIp, resetUserPassword } from '@novel/auth';

import { requireAdminSession } from '@/admin-guard';
import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/users/:id/reset-password
 *
 * 请求体：{ newPassword? }
 * - 未提供 newPassword 时由服务器生成并一次性返回；
 * - 重置后 mustChangePassword=true，并吊销该账号全部会话；
 * - 响应不含密码哈希（只含公开字段 + 一次性口令）。
 * - 不提供"查看原密码"能力（库里只有 argon2id 哈希，不可逆）。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const config = authConfig();

  try {
    assertTrustedOrigin(request, config);
    const actor = await requireAdminSession(request);

    const { id } = await context.params;
    const body = await readJsonObject(request);
    const newPasswordRaw = body['newPassword'];
    const newPassword =
      typeof newPasswordRaw === 'string' && newPasswordRaw !== '' ? newPasswordRaw : undefined;

    const result = await resetUserPassword(db(), {
      actorId: actor.id,
      userId: id,
      newPassword,
      meta: { ip: readClientIp(request), userAgent: request.headers.get('user-agent') },
    });

    return authJson(
      {
        user: result.user,
        ...(result.newPassword === null ? {} : { newPassword: result.newPassword }),
      },
      200,
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
