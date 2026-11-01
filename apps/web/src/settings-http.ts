import { AuthError } from '@novel/auth';

import { authJson } from './auth-http';

/**
 * 设定中心与实体接口的 HTTP 适配层。
 */

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

/** 读取可选整数段（缺失时返回 undefined；null 视为显式清空）。 */
export function optionalInteger(
  body: Record<string, unknown>,
  key: string,
): number | undefined | null {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AuthError('VALIDATION_FAILED', `字段 ${key} 必须是整数`);
  }
  return value;
}

/** 读取一个字符串字典字段（如 attributes / direction）。 */
export function requireRecord(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuthError('VALIDATION_FAILED', `字段 ${key} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

/** 读取一个字符串数组字段（如排序列表）。 */
export function requireStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AuthError('VALIDATION_FAILED', `字段 ${key} 必须是字符串数组`);
  }
  return value as string[];
}

/**
 * **严格允许列表**：请求体里只允许出现给定的字段。
 *
 * 只要出现任何其它字段（无论是 id / workId 这类服务端字段，
 * 还是完全陌生的字段），一律 400 VALIDATION_FAILED ——
 * 不静默忽略，避免客户端误以为"提交成功"。
 *
 * 与 `rejectImmutableFields` 的区别：那个函数只拒绝一份黑名单，
 * 这个函数是白名单，黑名单之外的一切都拒绝。
 */
export function rejectUnknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowSet = new Set(allowed);
  for (const key of Object.keys(body)) {
    if (!allowSet.has(key)) {
      throw new AuthError('VALIDATION_FAILED', `字段 ${key} 不可提交`);
    }
  }
}

/**
 * 拒绝出现在请求体里的**不可变字段**。
 *
 * 作品方向与实体的归属、类型、标识都由服务端掌握；
 * 出现这些字段一律 400，不静默忽略。
 */
export function rejectImmutableFields(
  body: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const key of fields) {
    if (key in body) {
      throw new AuthError('VALIDATION_FAILED', `字段 ${key} 不可修改`);
    }
  }
}

/** 设定中心不可变字段。 */
export const IMMUTABLE_SETTING_FIELDS = [
  'workId',
  'work_id',
  'authorId',
  'author_id',
  'rulePackage',
  'rule_package',
  'genreRulePackage',
  'genre_rule_package',
  'schemaRef',
  'schema_ref',
] as const;

/** 设定中心 PATCH 的允许字段（严格白名单）。 */
export const SETTINGS_PATCH_FIELDS = ['direction'] as const;

/** 实体 PATCH 的允许字段（严格白名单）。 */
export const ENTITY_PATCH_FIELDS = ['name', 'orderIndex', 'attributes'] as const;

/** 实体 POST 的允许字段（严格白名单）。 */
export const ENTITY_CREATE_FIELDS = ['entityType', 'name', 'orderIndex', 'attributes'] as const;

/** 设定中心响应。 */
export function settingsResponse(payload: unknown): Response {
  return authJson(payload, 200);
}
