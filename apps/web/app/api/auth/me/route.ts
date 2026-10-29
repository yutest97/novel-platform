import { getCurrentUser, readSessionToken } from '@novel/auth';

import { authJson, authErrorResponse } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/auth/me
 *
 * - 未登录 / 会话过期 → 401
 * - 账号停用 → 403（并同时吊销其全部会话）
 * - 首登未改密 → 403 PASSWORD_CHANGE_REQUIRED（此时只放行改密与退出）
 * - 正常 → 200 + 公开用户信息与会话有效期
 */
export async function GET(request: Request): Promise<Response> {
  const config = authConfig();

  try {
    const context = await getCurrentUser(db(), {
      token: readSessionToken(request, config),
      config,
    });

    return authJson(
      {
        user: context.user,
        session: {
          absoluteExpiresAt: context.absoluteExpiresAt.toISOString(),
          idleExpiresAt: context.idleExpiresAt.toISOString(),
        },
      },
      200,
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
