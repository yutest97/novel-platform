import {
  assertTrustedOrigin,
  buildClearedSessionCookie,
  logout,
  readClientIp,
  readSessionToken,
} from '@novel/auth';

import { authJson, authErrorResponse } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/auth/logout
 *
 * 幂等：无论会话是否有效都返回 200，并清除 Cookie。
 */
export async function POST(request: Request): Promise<Response> {
  const config = authConfig();

  try {
    assertTrustedOrigin(request, config);

    await logout(db(), {
      token: readSessionToken(request, config),
      meta: { ip: readClientIp(request), userAgent: request.headers.get('user-agent') },
    });

    return authJson({ ok: true }, 200, [buildClearedSessionCookie(config)]);
  } catch (error) {
    return authErrorResponse(error);
  }
}
