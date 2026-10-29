/**
 * 账号相关的写操作：初始管理员、停用/启用、管理员重置密码。
 *
 * 两条硬约束（REV-01）：
 * 1. **授权**：所有管理员操作必须先经过 `requireActiveAdmin`，
 *    作者 / 已停用的管理员 / 不存在的操作者一律拒绝。
 * 2. **原子性**：业务修改与 audit_logs 写入在同一事务内完成；
 *    审计写失败时业务修改必须回滚（不留下"改了但没审计"的状态）。
 */

import type { PrismaClient } from '@novel/db';

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
 * 统一的管理员授权检查。
 *
 * 依次校验：actor 存在 → status=active → role=admin。
 * 任一条不满足都抛出错误，**不返回任何业务数据**。
 *
 * 注意：三种失败原因对外都表现为 403（"操作者不存在"也用 FORBIDDEN，
 * 避免通过错误码探测某个 id 是否为真实账号）。
 */
export async function requireActiveAdmin(db: PrismaClient, actorId: string): Promise<PublicUser> {
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

  return toPublicUser(actor);
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
 * 前置授权：`requireActiveAdmin`。
 * 停用时立即吊销该账号全部会话（配合每次请求的状态校验，
 * 保证停用后不能继续使用任何已有 Cookie）。
 * 状态变更、会话吊销与审计在同一事务内完成。
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
  await requireActiveAdmin(db, input.actorId);

  if (!UUID_PATTERN.test(input.userId)) {
    throw new AuthError('NOT_FOUND', '账号不存在');
  }

  const existing = await db.user.findUnique({
    where: { id: input.userId },
    select: { status: true },
  });
  if (existing === null) {
    throw new AuthError('NOT_FOUND', '账号不存在');
  }

  const updated = await db.$transaction(async (tx) => {
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
      detail: { from: existing.status, to: input.status },
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });

    return user;
  });

  return toPublicUser(updated);
}

/**
 * 管理员重置他人密码。
 *
 * 前置授权：`requireActiveAdmin`。
 * 重置后：mustChangePassword 置为 true，吊销该账号全部会话。
 * 密码更新、会话吊销与审计在同一事务内完成。
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
  await requireActiveAdmin(db, input.actorId);

  if (!UUID_PATTERN.test(input.userId)) {
    throw new AuthError('NOT_FOUND', '账号不存在');
  }

  const existing = await db.user.findUnique({ where: { id: input.userId }, select: { id: true } });
  if (existing === null) {
    throw new AuthError('NOT_FOUND', '账号不存在');
  }

  assertAcceptableInitialPassword(input.newPassword);
  const passwordHash = await hashPassword(input.newPassword);

  await db.$transaction(async (tx) => {
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
