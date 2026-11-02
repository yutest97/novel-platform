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

/**
 * 校验并规范化 UUID：先做形态校验，再统一转小写（M2-B3-B1-REV-02）。
 *
 * 为什么必须小写：PostgreSQL 的 `uuid` 类型比较时大小写不敏感，
 * 但**应用层有两处是字符串比较** ——
 * 1. 幂等内容比较（同一请求重试时大小写可能变）；
 * 2. advisory lock 的哈希键（`hashtextextended(workId::text, 0)`）。
 * 不统一大小写会导致「同一个 id、两把锁」以及幂等失效。
 *
 * 放在公共模块的原因：锁入口、实体写路径、物品事件写路径必须用**同一套**规则，
 * 否则任何一处漏掉就会重新引入"大小写不同 = 不同锁/不同资源"的漏洞。
 *
 * 错误语义与 `assertUuid` 完全一致：畸形值抛 400 `VALIDATION_FAILED`。
 */
export function normalizeUuid(value: unknown, field: string): string {
  assertUuid(value, field);
  return value.toLowerCase();
}
