/**
 * 会话的创建、校验、轮换与吊销。
 *
 * 安全约束（M1-B1）：
 * - 数据库只存 token 的 SHA-256 哈希。
 * - 同时具备绝对有效期与空闲有效期。
 * - 每账号最多 maxActiveSessions 个活跃会话，超出时淘汰**最旧**会话。
 * - 每次请求都重新读取账号状态（不信任 Cookie 中的任何信息）。
 * - 账号停用后，其所有会话立即失效。
 */

import type { PrismaClient } from '@novel/db';

import type { AuthConfig } from './config.js';
import { MAX_ACTIVE_SESSIONS } from './config.js';
import { AuthError } from './errors.js';
import { generateSessionToken, hashSessionToken } from './token.js';

/** 会话有效期组合。 */
export interface SessionExpiries {
  readonly absoluteExpiresAt: Date;
  readonly idleExpiresAt: Date;
}

/** 新签发的会话。 */
export interface IssuedSession extends SessionExpiries {
  /** 明文令牌，仅用于写入 Cookie；**不得**落库或写日志。 */
  readonly token: string;
  readonly sessionId: string;
}

/** 对外可见的用户信息（不含密码哈希）。 */
export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly role: 'admin' | 'author';
  readonly status: 'active' | 'disabled';
  readonly mustChangePassword: boolean;
}

/** 通过校验的请求上下文。 */
export interface AuthContext {
  readonly user: PublicUser;
  readonly sessionId: string;
  readonly absoluteExpiresAt: Date;
  readonly idleExpiresAt: Date;
}

/** 计算新的有效期：绝对有效期固定，空闲有效期随活动滑动但不超过绝对上限。 */
export function computeExpiries(config: AuthConfig, now: Date): SessionExpiries {
  const absoluteExpiresAt = new Date(now.getTime() + config.sessionAbsoluteTtlMs);
  const idleExpiresAt = new Date(
    Math.min(now.getTime() + config.sessionIdleTtlMs, absoluteExpiresAt.getTime()),
  );
  return { absoluteExpiresAt, idleExpiresAt };
}

/** 判断会话是否已过期（绝对或空闲任一到期即失效）。 */
export function isSessionExpired(
  session: { absoluteExpiresAt: Date; idleExpiresAt: Date },
  now: Date,
): boolean {
  return (
    session.absoluteExpiresAt.getTime() <= now.getTime() ||
    session.idleExpiresAt.getTime() <= now.getTime()
  );
}

/** 从数据库行构造对外用户信息。 */
export function toPublicUser(user: {
  id: string;
  email: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
}): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role === 'admin' ? 'admin' : 'author',
    status: user.status === 'disabled' ? 'disabled' : 'active',
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * 创建新会话。
 *
 * 在同一事务内：清理该账号已过期的会话 → 若活跃会话已达上限，
 * 淘汰最旧的若干个（保留最新的 maxActiveSessions-1 个）→ 写入新会话。
 */
export async function createSession(
  db: PrismaClient,
  input: { userId: string; config: AuthConfig; now?: Date },
): Promise<IssuedSession> {
  const now = input.now ?? new Date();
  const { absoluteExpiresAt, idleExpiresAt } = computeExpiries(input.config, now);
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const maxSessions = input.config.maxActiveSessions || MAX_ACTIVE_SESSIONS;

  const session = await db.$transaction(async (tx) => {
    // 0) 串行化同一账号的并发建会话请求。
    //    仅靠 "先 count 再 insert" 在并发下会突破上限（多个事务同时读到同样的数量）。
    //    这里用 PostgreSQL 事务级 advisory lock（按 user_id 哈希），
    //    锁随事务提交/回滚自动释放，不需要额外的表或基础设施。
    //    注意：pg_advisory_xact_lock 返回 void，Prisma 无法反序列化（P2010
    //    UnsupportedNativeDataType），因此用子查询把结果转成可读的整数。
    await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${input.userId})::bigint)) AS lock_acquired`;

    // 1) 顺手清理过期会话，避免它们占用上限名额。
    await tx.session.deleteMany({
      where: {
        userId: input.userId,
        OR: [{ absoluteExpiresAt: { lte: now } }, { idleExpiresAt: { lte: now } }],
      },
    });

    // 2) 淘汰最旧会话，保证插入后不超过上限。
    const existing = await tx.session.findMany({
      where: { userId: input.userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    const keepBeforeInsert = Math.max(maxSessions - 1, 0);
    const overflow = existing.length - keepBeforeInsert;
    if (overflow > 0) {
      const evicted = existing.slice(0, overflow).map((item) => item.id);
      await tx.session.deleteMany({ where: { id: { in: evicted } } });
    }

    // 3) 写入新会话。
    return tx.session.create({
      data: {
        userId: input.userId,
        tokenHash,
        absoluteExpiresAt,
        idleExpiresAt,
        lastActivityAt: now,
        createdAt: now,
      },
      select: { id: true },
    });
  });

  return { token, sessionId: session.id, absoluteExpiresAt, idleExpiresAt };
}

/** 按明文令牌查找会话（内部使用，返回含哈希的行）。 */
export async function findSessionByToken(db: PrismaClient, token: string) {
  if (token === '') {
    return null;
  }
  return db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });
}

/** 吊销单个会话。 */
export async function revokeSessionById(db: PrismaClient, sessionId: string): Promise<void> {
  await db.session.deleteMany({ where: { id: sessionId } });
}

/** 吊销某账号的全部会话（停用账号、改密、重置密码时使用）。 */
export async function revokeAllSessions(db: PrismaClient, userId: string): Promise<void> {
  await db.session.deleteMany({ where: { userId } });
}

/** 刷新会话的最近活动时间与空闲有效期。 */
export async function touchSession(
  db: PrismaClient,
  session: { id: string; absoluteExpiresAt: Date },
  config: AuthConfig,
  now: Date,
): Promise<Date> {
  const idleExpiresAt = new Date(
    Math.min(now.getTime() + config.sessionIdleTtlMs, session.absoluteExpiresAt.getTime()),
  );
  await db.session.update({
    where: { id: session.id },
    data: { lastActivityAt: now, idleExpiresAt },
  });
  return idleExpiresAt;
}

/**
 * 校验会话令牌并返回请求上下文。
 *
 * 每一步都重新查库：过期检查、账号是否存在、账号是否停用、是否必须先改密。
 * Cookie 只提供令牌，不提供任何受信任的状态。
 */
export async function authenticateToken(
  db: PrismaClient,
  token: string,
  config: AuthConfig,
  options?: { now?: Date; allowPasswordChangePending?: boolean },
): Promise<AuthContext> {
  const now = options?.now ?? new Date();
  const session = await findSessionByToken(db, token);

  if (session === null) {
    throw new AuthError('UNAUTHENTICATED');
  }

  if (isSessionExpired(session, now)) {
    await revokeSessionById(db, session.id);
    throw new AuthError('UNAUTHENTICATED');
  }

  // 每次请求重新校验账号状态，不只依赖 Cookie。
  if (session.user.status === 'disabled') {
    await revokeAllSessions(db, session.userId);
    throw new AuthError('ACCOUNT_DISABLED');
  }

  if (session.user.mustChangePassword && options?.allowPasswordChangePending !== true) {
    throw new AuthError('PASSWORD_CHANGE_REQUIRED');
  }

  const idleExpiresAt = await touchSession(db, session, config, now);

  return {
    user: toPublicUser(session.user),
    sessionId: session.id,
    absoluteExpiresAt: session.absoluteExpiresAt,
    idleExpiresAt,
  };
}
