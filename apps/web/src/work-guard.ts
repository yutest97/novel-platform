/**
 * 作品接口的会话守卫（M2-A）。
 *
 * 规则：
 * - 身份一律来自**当前会话 Cookie**，绝不接受客户端传入 authorId / role；
 * - 复用 `getCurrentUser` 的既有语义：未登录 401、账号停用 403（并吊销会话）、
 *   首登未改密 403（PASSWORD_CHANGE_REQUIRED）—— 即"每次请求重新校验
 *   账号 active 与 mustChangePassword"；
 * - 再校验 role=author：**管理员默认不能通过作品接口读取或修改作者作品**。
 *
 * 作品归属校验在业务层完成（查询条件带 author_id），
 * 这里只负责确定"你是谁、你有没有作者身份"。
 */

import { AuthError, getCurrentUser, readSessionToken, type PublicUser } from '@novel/auth';

import { authConfig, db } from './auth-runtime';

/** 校验请求具备有效作者会话，返回作者信息。 */
export async function requireAuthorSession(request: Request): Promise<PublicUser> {
  const config = authConfig();
  const context = await getCurrentUser(db(), {
    token: readSessionToken(request, config),
    config,
  });

  if (context.user.role !== 'author') {
    throw new AuthError('FORBIDDEN', '需要作者身份');
  }

  return context.user;
}
