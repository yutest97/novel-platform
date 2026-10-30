/**
 * 管理接口的会话守卫。
 *
 * 规则（M1-B2）：
 * - actor 一律来自**当前会话 Cookie**，绝不接受客户端传入的 actorId；
 * - 复用 `getCurrentUser` 的既有语义：未登录 401、账号停用 403（并吊销会话）、
 *   首登未改密 403（PASSWORD_CHANGE_REQUIRED）；
 * - 再校验 role=admin，否则 403 FORBIDDEN。
 *
 * 注意：这里的检查只用于"快速拒绝"与读取 actor 身份；
 * 真正的写操作授权由 `runAdminGovernance` 在事务内重新校验（锁后重读 actor）。
 */

import { AuthError, getCurrentUser, readSessionToken, type PublicUser } from '@novel/auth';

import { authConfig, db } from './auth-runtime';

/** 校验请求具备有效管理员会话，返回 actor 信息。 */
export async function requireAdminSession(request: Request): Promise<PublicUser> {
  const config = authConfig();
  const context = await getCurrentUser(db(), {
    token: readSessionToken(request, config),
    config,
  });

  if (context.user.role !== 'admin') {
    throw new AuthError('FORBIDDEN', '需要管理员权限');
  }

  return context.user;
}
