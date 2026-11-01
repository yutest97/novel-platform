/**
 * 测试辅助：直连 PostgreSQL 的原生客户端。
 *
 * 用途：构造**确定性的并发交错**。
 *
 * Prisma 的事务客户端只能"被动"等待，做不到"先卡住别人，再放行"。
 * 而要证明作品级 advisory lock 真的被写路径获取、或者证明数据库条件更新
 * （compare-and-set）真的能拦住已删除实体，必须能从**事务外部**精确控制
 * 锁的持有与释放 —— 这正是原生连接唯一能做的事。
 *
 * 因此这里的客户端与 Prisma 走的是另一条物理连接，互相看不到对方的
 * 未提交数据，正好用来构造真实交错。
 */

import { Client } from 'pg';

import { requireDatabaseUrl } from './db.js';

/**
 * 创建一个原生连接。
 *
 * `DATABASE_URL` 里可能带 `?schema=public` —— 那是 Prisma 专有的参数，
 * pg 驱动不认，会被当成未知连接参数，因此这里先剥掉。
 */
export async function createRawClient(): Promise<Client> {
  const url = new URL(requireDatabaseUrl());
  url.search = '';
  const client = new Client({
    host: url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  });
  await client.connect();
  return client;
}

/** 睡眠指定毫秒。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 持有"作品级实体写锁"，直到调用方提交或回滚事务。
 *
 * 锁键必须与业务实现完全一致：
 * `hashtextextended(<namespace> || <workId>::text, 0)`。
 * 只有这样，才能验证写路径**确实**去取了这把锁 —— 而不是碰巧被行锁挡住。
 *
 * 调用方负责 `COMMIT` / `ROLLBACK`。
 */
export async function holdWorkEntityLock(
  client: Client,
  namespace: string,
  workId: string,
): Promise<void> {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1 || $2::text, 0))', [
    namespace,
    workId,
  ]);
}

/**
 * 以 SHARE 模式锁住实体表。
 *
 * 效果：
 * - `SELECT`（AccessShare）仍然可用 → 应用层的"先查后写"照常执行；
 * - `INSERT` / `UPDATE`（RowExclusive）被挡住 → 应用的写入停在提交之前。
 *
 * 于是可以**确定性地**让多个并发写入都读到同一份旧快照，
 * 从而把"锁内重校验"与"锁外重校验"的差异变成可观测的结果。
 */
export async function holdEntitiesTableShareLock(client: Client): Promise<void> {
  await client.query('BEGIN');
  await client.query('LOCK TABLE entities IN SHARE MODE');
}

/**
 * 统计当前数据库里"正因等待锁而挂起"的会话数。
 *
 * 判定条件：`wait_event_type = 'Lock'` 且会话处于 active。
 * 这既包含等待表锁（relation）、行锁（tuple），也包含等待 advisory lock。
 */
export async function countBlockedSessions(client: Client): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND state = 'active'
        AND pid <> pg_backend_pid()`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

/**
 * 等待至少 `target` 个会话因等待锁而挂起。
 *
 * 这是"交错确实发生了"的证据：只有当并发写入真的卡在锁上时，
 * 后续的断言才有意义。
 */
export async function waitForBlockedSessions(
  client: Client,
  target: number,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let observed = 0;
  for (;;) {
    observed = await countBlockedSessions(client);
    if (observed >= target) {
      return observed;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${target} 个阻塞会话超时（实际 ${observed} 个）：并发交错没有发生`);
    }
    await sleep(25);
  }
}
