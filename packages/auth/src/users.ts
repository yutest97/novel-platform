/**
 * 账号相关的写操作：初始管理员、停用/启用、管理员重置密码。
 *
 * 所有这些操作都会写入 append-only 审计，且都不记录密码明文或哈希。
 */

import type { PrismaClient } from '@novel/db';

import { AUDIT_ACTIONS, writeAuditLog } from './audit.js';
import { AuthError } from './errors.js';
import { hashPassword } from './password.js';
import { toPublicUser, type PublicUser } from './sessions.js';
import { revokeAllSessions } from './sessions.js';
import type { RequestMeta } from './types.js';

/** 邮箱格式校验（宽松但足以拦截明显非法输入）。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/** 按邮箱查找账号（自动规范化）。 */
export async function findUserByEmail(db: PrismaClient, email: string) {
  return db.user.findUnique({ where: { email: normalizeEmail(email) } });
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
 */
export async function createInitialAdmin(
  db: PrismaClient,
  input: { email: string; password: string; meta: RequestMeta },
): Promise<CreatedAdmin> {
  const email = normalizeEmail(input.email);
  assertValidEmail(email);

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (existing !== null) {
    return { created: false, userId: existing.id, email };
  }

  const passwordHash = await hashPassword(input.password);
  const user = await db.user.create({
    data: {
      email,
      passwordHash,
      role: 'admin',
      status: 'active',
      mustChangePassword: true,
    },
    select: { id: true },
  });

  await writeAuditLog(db, {
    action: AUDIT_ACTIONS.ADMIN_CREATED,
    actorId: null,
    targetType: 'user',
    targetId: user.id,
    detail: { email, role: 'admin', mustChangePassword: true },
    ip: input.meta.ip,
    userAgent: input.meta.userAgent,
  });

  return { created: true, userId: user.id, email };
}

/**
 * 停用 / 启用账号。
 *
 * 停用时立即吊销该账号的全部会话（配合每次请求的状态校验，
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
  const existing = await db.user.findUnique({ where: { id: input.userId } });
  if (existing === null) {
    throw new AuthError('NOT_FOUND', '账号不存在');
  }

  const user = await db.user.update({
    where: { id: input.userId },
    data: { status: input.status },
  });

  if (input.status === 'disabled') {
    await revokeAllSessions(db, input.userId);
  }

  await writeAuditLog(db, {
    action: input.status === 'disabled' ? AUDIT_ACTIONS.USER_DISABLED : AUDIT_ACTIONS.USER_ENABLED,
    actorId: input.actorId,
    targetType: 'user',
    targetId: input.userId,
    detail: { from: existing.status, to: input.status },
    ip: input.meta.ip,
    userAgent: input.meta.userAgent,
  });

  return toPublicUser(user);
}

/**
 * 管理员重置他人密码。
 *
 * 重置后：mustChangePassword 置为 true，并吊销该账号全部会话。
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
  const existing = await db.user.findUnique({ where: { id: input.userId }, select: { id: true } });
  if (existing === null) {
    throw new AuthError('NOT_FOUND', '账号不存在');
  }

  const passwordHash = await hashPassword(input.newPassword);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: input.userId },
      data: { passwordHash, mustChangePassword: true },
    });
    await tx.session.deleteMany({ where: { userId: input.userId } });
  });

  await writeAuditLog(db, {
    action: AUDIT_ACTIONS.ADMIN_PASSWORD_RESET,
    actorId: input.actorId,
    targetType: 'user',
    targetId: input.userId,
    detail: { mustChangePassword: true, sessionsRevoked: true },
    ip: input.meta.ip,
    userAgent: input.meta.userAgent,
  });
}
