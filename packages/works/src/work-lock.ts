/**
 * 作品级写锁（M2-B3-B1 抽取）。
 *
 * 为什么抽成独立模块：实体写（entities.ts）与物品事件写（item-events.ts）
 * 必须落在**同一把锁**上，否则「转移给某人」与「删除该人物」这类跨对象
 * 不变量就没有串行化保证。复制两份锁逻辑迟早会漂移，因此统一到这里。
 *
 * 锁语义：
 * - 键 = `hashtextextended(<namespace> || workId::text, 0)`；
 * - 事务级（`pg_advisory_xact_lock`）→ 随事务提交/回滚自动释放，不会泄漏；
 * - 同一作品串行化，不同作品互不影响。
 */

import type { Prisma, PrismaClient } from '@novel/db';

/**
 * 锁命名空间。
 *
 * **值不得修改**（保持 `'entity:'`）：
 * 滚动部署期间新旧实例会同时在线，一旦改值，两代实例会落进不同的哈希空间，
 * 等于锁完全失效。改名可以，改值不行。
 */
export const WORK_LOCK_NAMESPACE = 'entity:';

/**
 * 取作品级写锁。
 *
 * 取锁语句包在子查询里：`pg_advisory_xact_lock` 返回 void，
 * Prisma 无法反序列化这种结果（会抛 P2010），
 * 用 `SELECT 1 FROM (…)` 把返回值换成可序列化的整数。
 */
export async function lockWork(tx: Prisma.TransactionClient, workId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended(${WORK_LOCK_NAMESPACE} || ${workId}::text, 0))) AS lock_acquired`;
}

/**
 * 作品级写事务的统一入口。
 *
 * 顺序固定为：开事务 → 取作品级锁 → **在事务内**做全部校验 → 写数据。
 * 任何一步抛错都会让整个事务回滚。
 *
 * 超时放宽到 30 秒：并发写会互相等待同一把锁，等待时间算在事务时限里。
 */
export async function runWorkWrite<T>(
  db: PrismaClient,
  workId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await lockWork(tx, workId);
      return work(tx);
    },
    { maxWait: 15000, timeout: 30000 },
  );
}
