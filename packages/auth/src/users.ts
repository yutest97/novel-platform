/**
 * 账号相关的写操作：初始管理员、停用/启用、管理员重置密码。
 *
 * 三条硬约束（REV-01 / REV-02）：
 * 1. **授权**：管理员写操作一律走 `runAdminGovernance`，
 *    在事务内取固定 advisory lock 后**重新读取** actor 再判定
 *    （存在 / active / admin / 已改密）。
 * 2. **原子性**：业务修改、会话吊销与 audit_logs 写入在同一事务内完成；
 *    审计写失败时业务修改必须回滚。
 * 3. **最后管理员保护**：停用 active admin 前统计其他可用管理员，
 *    为 0 时返回稳定错误 `LAST_ADMIN_PROTECTED`，且不产生任何副作用。
 */

import type { Prisma, PrismaClient } from '@novel/db';

import { AUDIT_ACTIONS, writeAuditLog } from './audit.js';
import { AuthError } from './errors.js';
import { assertPasswordPolicy, hashPassword } from './password.js';
import { toPublicUser, type PublicUser } from './sessions.js';
import type { RequestMeta } from './types.js';

/** 邮箱格式校验（宽松但足以拦截明显非法输入）。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** UUID 形态校验：避免把非法 id 传给 Prisma 触发底层类型错误。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 已知的示例/占位口令。
 *
 * seed 脚本与 `createInitialAdmin` 都拒绝这些值，
 * 避免把 `.env.example` 里的占位串直接当成真实管理员口令。
 */
const PLACEHOLDER_PASSWORDS = new Set([
  'change-me-in-local-env-only',
  'change-me-local-only',
  'change-me',
  'changeme',
  'placeholder',
  'placeholder-not-a-real-key',
  'password',
  'admin',
  'initial-password',
  'your-password-here',
]);

/** 占位口令的模糊匹配（大小写不敏感）。 */
const PLACEHOLDER_PATTERN = /(^|[-_])(change[-_]?me|placeholder|example|changeme)([-_]|$)/i;

/**
 * 规范化邮箱：去首尾空白并转小写。
 *
 * 数据库另有 CHECK 约束（email = lower(email)）作为最后防线。
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 校验邮箱格式，不合法时抛出 VALIDATION_FAILED。 */
export function assertValidEmail(email: string): void {
  if (!EMAIL_PATTERN.test(email)) {
    throw new AuthError('VALIDATION_FAILED', '邮箱格式不正确');
  }
}

/**
 * 校验"可用的初始/重置口令"。
 *
 * 拒绝：空值、已知占位值、不符合密码策略的值。
 */
export function assertAcceptableInitialPassword(password: string): void {
  if (typeof password !== 'string' || password.trim() === '') {
    throw new AuthError('VALIDATION_FAILED', '必须设置管理员初始密码');
  }
  if (
    PLACEHOLDER_PASSWORDS.has(password.trim().toLowerCase()) ||
    PLACEHOLDER_PATTERN.test(password)
  ) {
    throw new AuthError('VALIDATION_FAILED', '初始密码不得使用示例占位值');
  }
  assertPasswordPolicy(password);
}

/** 按邮箱查找账号（自动规范化）。 */
export async function findUserByEmail(db: PrismaClient, email: string) {
  return db.user.findUnique({ where: { email: normalizeEmail(email) } });
}

/**
 * 管理员治理的固定 advisory lock 键。
 *
 * 取固定值（而非按 actor/目标哈希）是刻意的：
 * 「最后一个可用管理员」这类约束是**全局**的，只有把所有管理员治理操作
 * 串行化到同一把锁，并发互相停用时才可能得到正确结果。
 * 键值写成字面量常量，不参与任何字符串拼接。
 */
const ADMIN_GOVERNANCE_LOCK_KEY = 7212076401n;

/** 单条 SQL 的锁语句（pg_advisory_xact_lock 返回 void，Prisma 无法反序列化，
 *  故用子查询返回整数，避免 P2010 UnsupportedNativeDataType）。 */
const ADMIN_GOVERNANCE_LOCK_SQL = `SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(${ADMIN_GOVERNANCE_LOCK_KEY.toString()}::bigint)) AS lock_acquired`;

/** 在事务内获取管理员治理锁。 */
export async function lockAdminGovernance(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRawUnsafe(ADMIN_GOVERNANCE_LOCK_SQL);
}

/** 仅需 user 委托的最小数据库能力（PrismaClient 与 TransactionClient 都满足）。 */
export type UserReader = Pick<PrismaClient, 'user'>;

/**
 * 管理员授权检查的核心实现。
 *
 * 依次校验：actor 存在 → status=active → role=admin → mustChangePassword=false。
 * 首登未改密的管理员不能执行任何管理操作。
 */
async function assertActiveAdmin(db: UserReader, actorId: string): Promise<PublicUser> {
  if (typeof actorId !== 'string' || !UUID_PATTERN.test(actorId)) {
    throw new AuthError('FORBIDDEN', '操作者无效');
  }

  const actor = await db.user.findUnique({
    where: { id: actorId },
    select: { id: true, email: true, role: true, status: true, mustChangePassword: true },
  });

  if (actor === null) {
    throw new AuthError('FORBIDDEN', '操作者不存在');
  }
  if (actor.status === 'disabled') {
    throw new AuthError('ACCOUNT_DISABLED', '操作者账号已停用');
  }
  if (actor.role !== 'admin') {
    throw new AuthError('FORBIDDEN', '需要管理员权限');
  }
  // 首登未改密的管理员：必须先自己改密，才能操作他人。
  if (actor.mustChangePassword) {
    throw new AuthError('PASSWORD_CHANGE_REQUIRED', '管理员必须先修改初始密码');
  }

  return toPublicUser(actor);
}

/**
 * 事务内的管理员授权检查（**必须**在事务内、拿到治理锁之后调用）。
 */
export const requireActiveAdminInTx = assertActiveAdmin;

/**
 * 只读的管理员授权检查（**不允许**据此继续执行写操作）。
 *
 * 任何写操作都必须走 `runAdminGovernance`，在事务内重新读取 actor ——
 * 否则会出现"事务外判定通过、事务内 actor 已被停用"的时间窗口。
 */
export const requireActiveAdmin = assertActiveAdmin;

/**
 * 管理员治理事务。
 *
 * 顺序固定为：开事务 → 取固定 advisory lock → **在事务内重新读取并校验 actor**
 * → 由回调读取目标、执行更新/吊销会话/写审计。
 * 任何一步抛错都会让整个事务回滚（不留下"改了没审计"或"审计了没改"）。
 */
export async function runAdminGovernance<T>(
  db: PrismaClient,
  actorId: string,
  work: (tx: Prisma.TransactionClient, actor: PublicUser) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await lockAdminGovernance(tx);
    const actor = await requireActiveAdminInTx(tx, actorId);
    return work(tx, actor);
  });
}

/**
 * 统计"除 targetId 之外"的可用管理员数量。
 *
 * 用于最后管理员保护：停用某个 active admin 前必须确认还有别人可用。
 */
export async function countOtherActiveAdmins(
  tx: Prisma.TransactionClient,
  targetId: string,
): Promise<number> {
  return tx.user.count({
    where: { role: 'admin', status: 'active', id: { not: targetId } },
  });
}

/** 初始管理员的创建结果。 */
export interface CreatedAdmin {
  readonly created: boolean;
  readonly userId: string;
  readonly email: string;
}

/**
 * 创建初始管理员（一次性 seed 使用）。
 *
 * - 幂等：已存在同邮箱账号时不覆盖、不改密码，返回 created=false。
 * - 必须改密：mustChangePassword 恒为 true。
 * - 审计 actorId 为 null（此时系统内还没有任何已认证操作者）。
 * - 账号创建与审计写入在同一事务：审计失败则账号不会被创建。
 */
export async function createInitialAdmin(
  db: PrismaClient,
  input: { email: string; password: string; meta: RequestMeta },
): Promise<CreatedAdmin> {
  const email = normalizeEmail(input.email);
  assertValidEmail(email);
  assertAcceptableInitialPassword(input.password);

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (existing !== null) {
    return { created: false, userId: existing.id, email };
  }

  const passwordHash = await hashPassword(input.password);

  const created = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        passwordHash,
        role: 'admin',
        status: 'active',
        mustChangePassword: true,
      },
      select: { id: true },
    });

    await writeAuditLog(tx, {
      action: AUDIT_ACTIONS.ADMIN_CREATED,
      actorId: null,
      targetType: 'user',
      targetId: user.id,
      detail: { email, role: 'admin', mustChangePassword: true },
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });

    return user;
  });

  return { created: true, userId: created.id, email };
}

/**
 * 停用 / 启用账号。
 *
 * 全程在管理员治理事务内完成：固定 advisory lock → 事务内重读 actor →
 * 事务内读目标 → 最后管理员检查 → 更新 → 吊销会话 → 写审计。
 * 停用时立即吊销该账号全部会话（配合每次请求的状态校验，
 * 保证停用后不能继续使用任何已有 Cookie）。
 */
export async function setUserStatus(
  db: PrismaClient,
  input: {
    actorId: string;
    userId: string;
    status: 'active' | 'disabled';
    meta: RequestMeta;
  },
): Promise<PublicUser> {
  return runAdminGovernance(db, input.actorId, async (tx) => {
    if (!UUID_PATTERN.test(input.userId)) {
      throw new AuthError('NOT_FOUND', '账号不存在');
    }

    const target = await tx.user.findUnique({
      where: { id: input.userId },
      select: { id: true, role: true, status: true },
    });
    if (target === null) {
      throw new AuthError('NOT_FOUND', '账号不存在');
    }

    // 最后管理员保护：只有在"确实会因为这次操作减少可用管理员"时才检查。
    if (input.status === 'disabled' && target.role === 'admin' && target.status === 'active') {
      const others = await countOtherActiveAdmins(tx, target.id);
      if (others === 0) {
        throw new AuthError('LAST_ADMIN_PROTECTED');
      }
    }

    const user = await tx.user.update({
      where: { id: input.userId },
      data: { status: input.status },
    });

    if (input.status === 'disabled') {
      await tx.session.deleteMany({ where: { userId: input.userId } });
    }

    await writeAuditLog(tx, {
      action:
        input.status === 'disabled' ? AUDIT_ACTIONS.USER_DISABLED : AUDIT_ACTIONS.USER_ENABLED,
      actorId: input.actorId,
      targetType: 'user',
      targetId: input.userId,
      detail: { from: target.status, to: input.status },
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });

    return toPublicUser(user);
  });
}

/**
 * 管理员重置他人密码。
 *
 * 同样走管理员治理事务（锁 → 事务内重读 actor → 事务内读目标 → 更新 → 吊销 → 审计）。
 * 重置后：mustChangePassword 置为 true，吊销该账号全部会话。
 */
export async function adminResetPassword(
  db: PrismaClient,
  input: {
    actorId: string;
    userId: string;
    newPassword: string;
    meta: RequestMeta;
  },
): Promise<void> {
  assertAcceptableInitialPassword(input.newPassword);

  return runAdminGovernance(db, input.actorId, async (tx) => {
    if (!UUID_PATTERN.test(input.userId)) {
      throw new AuthError('NOT_FOUND', '账号不存在');
    }

    const target = await tx.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (target === null) {
      throw new AuthError('NOT_FOUND', '账号不存在');
    }

    const passwordHash = await hashPassword(input.newPassword);

    await tx.user.update({
      where: { id: input.userId },
      data: { passwordHash, mustChangePassword: true },
    });
    await tx.session.deleteMany({ where: { userId: input.userId } });

    await writeAuditLog(tx, {
      action: AUDIT_ACTIONS.ADMIN_PASSWORD_RESET,
      actorId: input.actorId,
      targetType: 'user',
      targetId: input.userId,
      detail: { mustChangePassword: true, sessionsRevoked: true },
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });
  });
}
