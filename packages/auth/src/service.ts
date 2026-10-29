/**
 * 认证服务：登录、退出、改密、当前用户。
 *
 * 这一层不含任何 HTTP 细节（不读 Request、不写 Response），
 * 便于被路由、seed 脚本与测试直接复用。
 */

import type { PrismaClient } from '@novel/db';

import { AUDIT_ACTIONS, writeAuditLog } from './audit.js';
import type { AuthConfig } from './config.js';
import { AuthError } from './errors.js';
import { hashSessionToken } from './token.js';
import {
  assertPasswordPolicy,
  hashPassword,
  verifyAbsentUserPassword,
  verifyPassword,
} from './password.js';
import type { FixedWindowRateLimiter } from './ratelimit.js';
import { loginIpRateLimitKey, loginRateLimitKey } from './ratelimit.js';
import {
  authenticateToken,
  createSession,
  findSessionByToken,
  revokeAllSessions,
  revokeSessionById,
  toPublicUser,
  type AuthContext,
  type IssuedSession,
  type PublicUser,
} from './sessions.js';
import type { RequestMeta } from './types.js';
import { normalizeEmail } from './users.js';

/** 登录结果。 */
export interface LoginResult extends IssuedSession {
  readonly user: PublicUser;
}

/** 登录输入。 */
export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly config: AuthConfig;
  readonly meta: RequestMeta;
  readonly now?: Date;
  /** 已存在的会话令牌（用于登录时轮换掉旧会话）。 */
  readonly previousToken?: string | null;
}

/**
 * 邮箱 + 密码登录。
 *
 * 失败语义统一为 `INVALID_CREDENTIALS`（401），
 * 账号不存在与密码错误在**响应体、状态码与耗时**上都不可区分。
 * 账号已停用单独返回 403（这是产品明确要求的区分）。
 */
export async function loginWithPassword(
  db: PrismaClient,
  limiter: FixedWindowRateLimiter,
  input: LoginInput,
): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const now = input.now ?? new Date();
  const key = loginRateLimitKey(email, input.meta.ip);
  const ipKey = loginIpRateLimitKey(input.meta.ip);

  // 1) 限流前置检查（不消耗配额）：已被限流则直接拒绝。
  for (const candidate of [key, ipKey]) {
    const state = limiter.inspect(candidate);
    if (!state.allowed) {
      throw new AuthError('RATE_LIMITED', `请 ${state.retryAfterSeconds} 秒后重试`);
    }
  }

  const user = await db.user.findUnique({ where: { email } });

  // 2) 账号不存在：执行等时校验，再返回与"密码错误"完全一致的错误。
  if (user === null) {
    await verifyAbsentUserPassword(input.password);
    limiter.consume(key);
    limiter.consume(ipKey);
    await writeAuditLog(db, {
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      actorId: null,
      targetType: 'user',
      targetId: null,
      // 只记录原因，不记录提交的密码、也不记录提交的邮箱。
      detail: { reason: 'unknown_account' },
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });
    throw new AuthError('INVALID_CREDENTIALS');
  }

  // 3) 账号已停用：直接 403（不校验密码，也不泄露密码是否正确）。
  if (user.status === 'disabled') {
    limiter.consume(key);
    limiter.consume(ipKey);
    await writeAuditLog(db, {
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      actorId: user.id,
      targetType: 'user',
      targetId: user.id,
      detail: { reason: 'account_disabled' },
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });
    throw new AuthError('ACCOUNT_DISABLED');
  }

  // 4) 校验密码。
  const passwordOk = await verifyPassword(user.passwordHash, input.password);
  if (!passwordOk) {
    limiter.consume(key);
    limiter.consume(ipKey);
    await writeAuditLog(db, {
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      actorId: user.id,
      targetType: 'user',
      targetId: user.id,
      detail: { reason: 'bad_password' },
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });
    throw new AuthError('INVALID_CREDENTIALS');
  }

  // 5) 登录成功：清空该邮箱的失败计数。
  limiter.reset(key);

  // 6) 轮换：把此前同一浏览器持有的会话吊销，再签发新会话。
  if (input.previousToken !== null && input.previousToken !== undefined) {
    const previous = await findSessionByToken(db, input.previousToken);
    if (previous !== null) {
      await revokeSessionById(db, previous.id);
    }
  }

  const issued = await createSession(db, { userId: user.id, config: input.config, now });

  await writeAuditLog(db, {
    action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
    actorId: user.id,
    targetType: 'session',
    targetId: issued.sessionId,
    detail: { role: user.role, mustChangePassword: user.mustChangePassword },
    ip: input.meta.ip,
    userAgent: input.meta.userAgent,
  });

  return { ...issued, user: toPublicUser(user) };
}

/**
 * 退出登录。
 *
 * 幂等：令牌无效或缺失时同样返回成功（并清除 Cookie）。
 * 只有确实存在会话时才写审计，避免无效令牌刷日志。
 */
export async function logout(
  db: PrismaClient,
  input: { token: string | null; meta: RequestMeta },
): Promise<{ loggedOut: boolean }> {
  if (input.token === null || input.token === '') {
    return { loggedOut: false };
  }

  const session = await findSessionByToken(db, input.token);
  if (session === null) {
    return { loggedOut: false };
  }

  await revokeSessionById(db, session.id);

  await writeAuditLog(db, {
    action: AUDIT_ACTIONS.LOGOUT,
    actorId: session.userId,
    targetType: 'session',
    targetId: session.id,
    detail: { tokenHashPrefix: hashSessionToken(input.token).slice(0, 8) },
    ip: input.meta.ip,
    userAgent: input.meta.userAgent,
  });

  return { loggedOut: true };
}

/** 改密输入。 */
export interface ChangePasswordInput {
  readonly token: string | null;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly config: AuthConfig;
  readonly meta: RequestMeta;
  readonly now?: Date;
}

/**
 * 修改自己的密码。
 *
 * - 必须已登录（首登未改密状态也允许调用，否则无法解锁）；
 * - 校验当前密码；
 * - 成功后**轮换会话**：吊销该账号全部会话，再签发一个新的。
 */
export async function changePassword(
  db: PrismaClient,
  input: ChangePasswordInput,
): Promise<LoginResult> {
  const now = input.now ?? new Date();

  const context = await authenticateToken(db, input.token ?? '', input.config, {
    now,
    allowPasswordChangePending: true,
  });

  const user = await db.user.findUnique({ where: { id: context.user.id } });
  if (user === null) {
    throw new AuthError('UNAUTHENTICATED');
  }

  const currentOk = await verifyPassword(user.passwordHash, input.currentPassword);
  if (!currentOk) {
    throw new AuthError('VALIDATION_FAILED', '当前密码不正确');
  }

  assertPasswordPolicy(input.newPassword, input.currentPassword);
  const passwordHash = await hashPassword(input.newPassword);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false, updatedAt: now },
    });
    // 改密后所有旧会话立即失效。
    await tx.session.deleteMany({ where: { userId: user.id } });
  });

  // 轮换：为当前设备签发新会话。
  const issued = await createSession(db, { userId: user.id, config: input.config, now });

  await writeAuditLog(db, {
    action: AUDIT_ACTIONS.PASSWORD_CHANGED,
    actorId: user.id,
    targetType: 'user',
    targetId: user.id,
    detail: { sessionsRevoked: true, rotated: true },
    ip: input.meta.ip,
    userAgent: input.meta.userAgent,
  });

  return {
    ...issued,
    user: { ...toPublicUser(user), mustChangePassword: false },
  };
}

/**
 * 读取当前登录用户。
 *
 * 默认**不放行**"必须改密"状态：首登未改密时该接口返回 403，
 * 只有改密与退出接口可用。
 */
export async function getCurrentUser(
  db: PrismaClient,
  input: { token: string | null; config: AuthConfig; now?: Date },
): Promise<AuthContext> {
  return authenticateToken(db, input.token ?? '', input.config, {
    ...(input.now === undefined ? {} : { now: input.now }),
    allowPasswordChangePending: false,
  });
}

/** 吊销某账号全部会话（供管理员操作复用）。 */
export async function revokeUserSessions(db: PrismaClient, userId: string): Promise<void> {
  await revokeAllSessions(db, userId);
}
