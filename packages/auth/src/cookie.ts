/**
 * 会话 Cookie 的构建与解析。
 *
 * 属性要求（M1-B1）：
 * - `HttpOnly`：页面脚本不可读；
 * - `Secure`：仅 HTTPS 传输（本地 http 调试需显式关闭）；
 * - `SameSite=Lax`：阻断跨站 POST 携带；
 * - `Path=/`：全站生效。
 */

import type { AuthConfig } from './config.js';

/** 构建签发会话的 Set-Cookie 字符串。 */
export function buildSessionCookie(token: string, config: AuthConfig): string {
  const maxAgeSeconds = Math.floor(config.sessionAbsoluteTtlMs / 1000);
  const parts = [
    `${config.cookieName}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.cookieSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/** 构建清除会话的 Set-Cookie 字符串。 */
export function buildClearedSessionCookie(config: AuthConfig): string {
  const parts = [
    `${config.cookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (config.cookieSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/** 从请求头读取会话令牌（不解析 JSON，不允许其它来源注入）。 */
export function readSessionToken(request: Request, config: AuthConfig): string | null {
  const header = request.headers.get('cookie');
  if (header === null || header.trim() === '') {
    return null;
  }

  for (const segment of header.split(';')) {
    const index = segment.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const name = segment.slice(0, index).trim();
    if (name !== config.cookieName) {
      continue;
    }
    const value = segment.slice(index + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}
