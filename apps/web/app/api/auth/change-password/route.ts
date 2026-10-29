import {
  assertTrustedOrigin,
  buildSessionCookie,
  changePassword,
  readClientIp,
  readSessionToken,
} from '@novel/auth';

import { authJson, authErrorResponse, readJsonObject, requireString } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/auth/change-password
 *
 * 请求体：{ currentPassword, newPassword }
 * 成功后：吊销该账号全部旧会话，并签发新会话（轮换）。
 * 该接口在"首登未改密"状态下仍然可用，否则用户无法解锁。
 */
export async function POST(request: Request): Promise<Response> {
  const config = authConfig();

  try {
    assertTrustedOrigin(request, config);

    const body = await readJsonObject(request);
    const currentPassword = requireString(body, 'currentPassword');
    const newPassword = requireString(body, 'newPassword');

    const result = await changePassword(db(), {
      token: readSessionToken(request, config),
      currentPassword,
      newPassword,
      config,
      meta: { ip: readClientIp(request), userAgent: request.headers.get('user-agent') },
    });

    return authJson({ user: result.user }, 200, [buildSessionCookie(result.token, config)]);
  } catch (error) {
    return authErrorResponse(error);
  }
}
