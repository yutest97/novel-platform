import {
  assertTrustedOrigin,
  assertValidEmail,
  buildSessionCookie,
  loginWithPassword,
  normalizeEmail,
  readClientIp,
  readSessionToken,
} from '@novel/auth';

import { authJson, authErrorResponse, readJsonObject, requireString } from '@/auth-http';
import { authConfig, db, loginLimiter } from '@/auth-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/auth/login
 *
 * 请求体：{ email, password }
 * 成功：200 + 会话 Cookie（HttpOnly/Secure/SameSite=Lax），响应体只含公开用户信息。
 * 失败：
 * - 账号不存在 / 密码错误 → 401，文案完全一致；
 * - 账号停用 → 403；
 * - 触发限流 → 429；
 * - 来源不受信任 → 403。
 */
export async function POST(request: Request): Promise<Response> {
  const config = authConfig();

  try {
    assertTrustedOrigin(request, config);

    const body = await readJsonObject(request);
    const email = normalizeEmail(requireString(body, 'email'));
    const password = requireString(body, 'password');
    assertValidEmail(email);

    const result = await loginWithPassword(db(), loginLimiter, {
      email,
      password,
      config,
      meta: { ip: readClientIp(request), userAgent: request.headers.get('user-agent') },
      previousToken: readSessionToken(request, config),
    });

    return authJson(
      {
        user: result.user,
        expiresAt: result.absoluteExpiresAt.toISOString(),
      },
      200,
      [buildSessionCookie(result.token, config)],
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
