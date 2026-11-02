/**
 * 作品归属校验（M2-B3-B1 抽取）。
 *
 * 实体写（`entities.ts`）与物品事件写（`item-events.ts`）都需要
 * "这个作品确实是当前作者的"这一步。抽出来是为了保证两处语义完全一致：
 *
 * - `authorId` **只来自会话**，永远不接受请求体里的作者字段；
 * - 非所有者一律 404（不区分"不存在"与"不属于你"，避免探测他人作品是否存在）。
 */

import { AuthError } from '@novel/auth';
import type { PrismaClient } from '@novel/db';

/** 作品上下文（只取后续校验真正需要的列）。 */
export interface WorkContext {
  readonly id: string;
  readonly title: string;
  readonly genreRulePackage: string;
}

/** 读取作品所需的最小数据库能力（PrismaClient 与事务客户端都满足）。 */
export type WorkReader = Pick<PrismaClient, 'work'>;

/**
 * 读取作品上下文（并确认属于当前作者）。
 *
 * 必须在作品级锁内、事务内调用：锁外读到的归属可能在写之前被改变。
 */
export async function requireOwnedWork(
  db: WorkReader,
  workId: string,
  authorId: string,
): Promise<WorkContext> {
  const work = await db.work.findFirst({
    where: { id: workId, authorId },
    select: { id: true, title: true, genreRulePackage: true },
  });
  if (work === null) {
    throw new AuthError('NOT_FOUND', '作品不存在');
  }
  return work;
}
