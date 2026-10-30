import {
  AuthError,
  assertTrustedOrigin,
  isUserStatus,
  readClientIp,
  setUserStatus,
} from '@novel/auth';

import { requireAdminSession } from '@/admin-guard';
import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/admin/users/:id/status
 *
 * 请求体：{ status: 'active' | 'disabled' }
 * - 停用：立即吊销该账号全部会话；
 * - 继续执行最后管理员保护（停用唯一 active admin → 403 LAST_ADMIN_PROTECTED）；
 * - 不提供删除账号接口。
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const config = authConfig();

  try {
    assertTrustedOrigin(request, config);
    const actor = await requireAdminSession(request);

    const { id } = await context.params;
    const body = await readJsonObject(request);
    const status = body['status'];
    if (!isUserStatus(status)) {
      throw new AuthError('VALIDATION_FAILED', 'status 必须为 active 或 disabled');
    }

    const user = await setUserStatus(db(), {
      actorId: actor.id,
      userId: id,
      status,
      meta: { ip: readClientIp(request), userAgent: request.headers.get('user-agent') },
    });

    return authJson({ user }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
