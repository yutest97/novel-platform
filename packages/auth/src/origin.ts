/**
 * 来源（Origin）校验，用于所有修改数据的接口。
 *
 * 为什么用 Origin 而不是自己发明 CSRF token：
 * 浏览器对跨站 POST 一定带 `Origin` 头，且该头**不能**被页面脚本伪造；
 * 服务端只要断言 Origin 属于本站，就能阻断跨站表单提交与跨站 fetch。
 *
 * 对非浏览器客户端（脚本、curl）的要求：显式发送 `Origin`。
 * 这是刻意的严格策略——宁可让脚本多写一行，也不接受"没有 Origin 就放行"。
 */

import type { AuthConfig } from './config.js';
import { AuthError } from './errors.js';

/** 只读方法不需要 Origin 校验。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 归一化来源字符串（去尾斜杠、小写 scheme/host）。 */
function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * 推断当前请求的站点来源。
 *
 * 不能只用 `new URL(request.url).origin`：框架层（如 Next 的 route handler）
 * 可能把 request.url 规范化为内部地址，导致与浏览器发送的 Origin 不一致。
 * 这里以 `Host` 头（反向代理场景配合 `X-Forwarded-Proto`）为准。
 */
function requestOrigin(request: Request): string {
  const host = request.headers.get('host');
  if (host === null || host.trim() === '') {
    return new URL(request.url).origin;
  }
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const protocol =
    forwardedProto !== null && forwardedProto.trim() !== ''
      ? (forwardedProto.split(',')[0]?.trim() ?? 'https')
      : new URL(request.url).protocol.replace(':', '');
  return `${protocol}://${host.trim()}`;
}

/**
 * 断言请求来源可信。
 *
 * @throws AuthError INVALID_ORIGIN（403）——缺少 Origin 或不匹配。
 */
export function assertTrustedOrigin(request: Request, config: AuthConfig): void {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) {
    return;
  }

  const origin = request.headers.get('origin');
  if (origin === null || origin.trim() === '' || origin === 'null') {
    throw new AuthError('INVALID_ORIGIN', '缺少 Origin 头');
  }

  const expected =
    config.appOrigin === undefined ? requestOrigin(request) : normalizeOrigin(config.appOrigin);

  if (normalizeOrigin(origin) !== normalizeOrigin(expected)) {
    throw new AuthError('INVALID_ORIGIN', 'Origin 与站点不一致');
  }
}

/** 从请求头解析客户端 IP（取反向代理最常见的一跳）。 */
export function readClientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null && forwarded.trim() !== '') {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first !== '') {
      return first;
    }
  }
  return request.headers.get('x-real-ip');
}
