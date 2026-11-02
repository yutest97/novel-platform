/**
 * 写路径错误的统一识别（M2-B3-B1）。
 *
 * 实体写与物品事件写共享同一套"数据库层冲突 → 稳定错误码"的判断，
 * 避免两边各写一份、慢慢漂移。
 */

/** Prisma 的写冲突 / 死锁错误。 */
const WRITE_CONFLICT_CODE = 'P2034';
/** PostgreSQL 的死锁与序列化失败。 */
const NATIVE_CONFLICT_CODES = new Set(['40P01', '40001']);

/**
 * 判断是否为并发写冲突（死锁 / 序列化失败）。
 *
 * 这些情况应当是稳定的 409，而不是 500 —— 调用方可以重试。
 */
export function isConcurrencyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; meta?: Record<string, unknown> };
  if (candidate.code === WRITE_CONFLICT_CODE) {
    return true;
  }
  const nativeCode = candidate.meta?.['code'];
  return typeof nativeCode === 'string' && NATIVE_CONFLICT_CODES.has(nativeCode);
}

/**
 * 取出唯一约束冲突命中的索引名（Prisma P2002）。
 *
 * 非唯一约束冲突返回 null。索引名用于区分"到底是哪条唯一约束"，
 * 因为不同约束对应不同的对外错误码。
 */
export function uniqueConstraintMarker(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const candidate = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { constraint?: { index?: unknown } } } };
  };
  if (candidate.code !== 'P2002') {
    return null;
  }
  const index = candidate.meta?.driverAdapterError?.cause?.constraint?.index;
  return typeof index === 'string' ? index : '';
}
