/**
 * 物品事件接口的请求体解析（M2-B3-B1）。
 *
 * 全部走**严格白名单**：出现任何未声明字段（尤其是 `fromHolder` /
 * `from_holder` / `workId` / 时间戳）一律 400，不静默忽略。
 *
 * `fromHolder` 永远不接受客户端提交 —— 它由服务端按当前状态推导，
 * 客户端能决定的只有"事件类型 + 转给谁 + 备注 + 幂等键"。
 */

import { AuthError } from '@novel/auth';

/** 追加事件的允许字段。 */
export const ITEM_EVENT_CREATE_FIELDS = [
  'eventType',
  'toHolder',
  'note',
  'idempotencyKey',
] as const;

/**
 * 冲正的允许字段。
 *
 * 刻意不含 `eventType` / `fromHolder` / `toHolder`：
 * 反向事件类型与双方持有人全部由服务端推导，不给客户端任何改写空间。
 * `reversalOf` 也不在其中 —— 目标事件由 URL 路径决定。
 */
export const ITEM_EVENT_REVERSAL_FIELDS = ['note', 'idempotencyKey'] as const;

/**
 * 读取可空的字符串字段。
 *
 * - 键不存在 → undefined（"未提供"）；
 * - 显式 `null` 或空串 → null（"清空"）；
 * - 其它类型 → 400。
 */
export function optionalNullableString(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in body)) {
    return undefined;
  }
  const value = body[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new AuthError('VALIDATION_FAILED', `字段 ${key} 必须是字符串`);
  }
  return value === '' ? null : value;
}

/** 读取非负整数查询参数（缺省返回 undefined）。 */
export function optionalNonNegativeInteger(
  params: URLSearchParams,
  key: string,
): number | undefined {
  const raw = params.get(key);
  if (raw === null || raw === '') {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new AuthError('VALIDATION_FAILED', `参数 ${key} 必须是非负整数`);
  }
  return Number.parseInt(raw, 10);
}

/** 读取正整数查询参数（缺省返回 undefined）。 */
export function optionalPositiveInteger(params: URLSearchParams, key: string): number | undefined {
  const value = optionalNonNegativeInteger(params, key);
  if (value === undefined) {
    return undefined;
  }
  if (value < 1) {
    throw new AuthError('VALIDATION_FAILED', `参数 ${key} 必须是正整数`);
  }
  return value;
}
