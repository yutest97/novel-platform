/**
 * 标识符校验（M2-B1-REV-01）。
 *
 * 目的：`work_id` / `entity_id` 在数据库里都是 UUID 列。
 * 把畸形 ID 直接交给 Prisma 会触发底层类型错误（HTTP 500），
 * 因此**进入 Prisma 之前**必须先校验形态，畸形 ID 一律 400（稳定错误码）。
 *
 * 注意：校验形态**不改变**权限语义 ——
 * 合法但不属于自己的资源仍然是 404（"他人资源一律按不存在处理"）。
 */

import { AuthError } from '@novel/auth';

/** UUID 形态（大小写不敏感的 8-4-4-4-12 十六进制）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 判断字符串是否为合法 UUID 形态。 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * 断言 ID 是合法 UUID；否则抛 400 VALIDATION_FAILED。
 *
 * @param value 待校验的 ID
 * @param field 字段名（用于错误文案，不对外暴露细节）
 */
export function assertUuid(value: unknown, field: string): asserts value is string {
  if (!isUuid(value)) {
    throw new AuthError('VALIDATION_FAILED', `${field} 不是合法的标识符`);
  }
}
