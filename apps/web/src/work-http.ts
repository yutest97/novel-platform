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

/**
 * 校验请求体里没有出现"服务端字段"（authorId / role 等）。
 *
 * 用于 **POST 创建**：这些字段完全由服务端决定，客户端提交一律拒绝。
 * 注意 `genreRulePackage` 在创建时是**允许**的（要选择题材），
 * 但在更新时不可变 —— 见 `rejectImmutableWorkFields`。
 */
export function rejectServerOwnedFields(body: Record<string, unknown>): void {
  for (const key of SERVER_OWNED_FIELDS) {
    if (key in body) {
      throw new AuthError('VALIDATION_FAILED', `字段 ${key} 由服务端决定，不能提交`);
    }
  }
}

/**
 * 校验请求体里没有出现**不可变字段**（仅用于 PATCH 更新）。
 *
 * 作品的归属与题材在创建后**不可更改**；时间戳由服务端维护。
 * 这些字段一旦出现在请求体里，一律 400 —— **不静默忽略**，
 * 否则客户端会以为改动生效了。
 */
export function rejectImmutableWorkFields(body: Record<string, unknown>): void {
  for (const key of IMMUTABLE_WORK_FIELDS) {
    if (key in body) {
      throw new AuthError('VALIDATION_FAILED', `字段 ${key} 不可修改`);
    }
  }
}

/** 服务端决定、客户端不可提交的字段。 */
const SERVER_OWNED_FIELDS = ['authorId', 'author_id', 'role', 'id'] as const;

/** PATCH 时不可修改的字段（含题材与时间戳）。 */
const IMMUTABLE_WORK_FIELDS = [
  ...SERVER_OWNED_FIELDS,
  'genreRulePackage',
  'genre_rule_package',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
] as const;

/** 作品列表响应。 */
export function worksResponse(works: readonly unknown[]): Response {
  return authJson({ works }, 200);
}
