/**
 * 作品接口的 HTTP 适配层。
 *
 * 与认证接口共用 `authJson` / `authErrorResponse`：
 * 错误一律按**稳定错误码**返回，前端据此映射中文文案。
 */

import { AuthError } from '@novel/auth';

import { authJson } from './auth-http';

/** 读取可选字符串字段（缺失或非字符串时返回 undefined）。 */
export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new AuthError('VALIDATION_FAILED', `字段 ${key} 必须是字符串`);
  }
  return value;
}

/** 读取可选整数字段（缺失或非字符串时返回 undefined）。 */
export function optionalInteger(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AuthError('VALIDATION_FAILED', `字段 ${key} 必须是整数`);
  }
  return value;
}

/** 校验请求体里没有出现"服务端字段"（authorId / role 等）。 */
export function rejectServerOwnedFields(body: Record<string, unknown>): void {
  for (const key of ['authorId', 'author_id', 'role', 'id']) {
    if (key in body) {
      throw new AuthError('VALIDATION_FAILED', `字段 ${key} 由服务端决定，不能提交`);
    }
  }
}

/** 作品列表响应。 */
export function worksResponse(works: readonly unknown[]): Response {
  return authJson({ works }, 200);
}
