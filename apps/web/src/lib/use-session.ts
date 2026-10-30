'use client';

/**
 * 会话守卫 Hook。
 *
 * 规则（M1-B3 / REV-01 / REV-02）：
 * - 认证只依赖 HttpOnly Cookie：这里只请求 `/api/auth/me`，不读取任何令牌；
 * - 会话类错误统一交给 `handleSessionError`（未登录 / 停用 / 待改密），
 *   并发失败时只跳转一次；
 * - 依据最近一次 `idleExpiresAt` / `absoluteExpiresAt` 设置自动退出计时器；
 * - 页面重新可见（visibilitychange）或重新获得焦点时重新校验会话；
 * - 提供 `refreshSession()`：业务操作成功后调用，重新读取会话并用**新的**
 *   到期时间重置计时器（活跃用户的滑动续期；不改变服务端任何有效期配置）。
 *
 * 客户端跳转只是体验层，服务端接口仍是最终权限边界。
 */

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchSession, type SessionInfo, type SessionUser } from './api';
import { handleSessionError } from './session-errors';

/** 会话状态。 */
export type SessionState =
  { readonly status: 'loading' } | { readonly status: 'ready'; readonly session: SessionInfo };

/** 账号的默认首页。 */
export function homeFor(user: Pick<SessionUser, 'role'>): string {
  return user.role === 'admin' ? '/admin/users' : '/workspace';
}

/** setTimeout 允许的最大延迟（超过会立即触发）。 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Hook 的返回值：当前状态 + 主动续期能力。 */
export interface RequireSession {
  readonly state: SessionState;
  /**
   * 重新读取会话并用新的到期时间重置自动退出计时器。
   *
   * 业务操作成功后调用即可实现"活跃续期"：服务端在每次校验时会滑动空闲有效期，
   * 前端拿到新的 `idleExpiresAt` / `absoluteExpiresAt` 后重置计时器。
   * 若到期时间没有变化，则**不**更新状态，避免重复计时器与无谓重渲染。
   */
  readonly refreshSession: () => Promise<void>;
}

/**
 * 要求已登录（可选要求管理员）。
 *
 * 返回 `loading` 时页面应渲染骨架，避免闪烁未授权内容。
 */
export function useRequireSession(options: { role?: 'admin' } = {}): RequireSession {
  const router = useRouter();
  const requiredRole = options.role;
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  // 到期跳转只做一次，避免计时器与重校验同时触发
  const expiringRef = useRef(false);

  const expire = useCallback((): void => {
    if (expiringRef.current) {
      return;
    }
    expiringRef.current = true;
    router.replace('/login?reason=expired');
  }, [router]);

  const revalidate = useCallback(
    async (initial: boolean): Promise<void> => {
      try {
        const session = await fetchSession();
        if (requiredRole === 'admin' && session.user.role !== 'admin') {
          router.replace('/workspace');
          return;
        }
        setState({ status: 'ready', session });
      } catch (error) {
        if (handleSessionError(error, router)) {
          return;
        }
        if (initial) {
          router.replace('/login?reason=error');
        }
      }
    },
    [requiredRole, router],
  );

  /**
   * 主动续期：业务操作成功后调用。
   *
   * - 到期时间确实变了 → 更新 state → 自动退出计时器按新时间重置；
   * - 到期时间没变   → 保持原 state（不重置计时器，避免重复计时器）；
   * - 会话已失效     → 走统一的会话错误跳转；
   * - 其它失败       → 忽略（业务操作本身已经成功，不应因此打断用户）。
   */
  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      const session = await fetchSession();
      if (requiredRole === 'admin' && session.user.role !== 'admin') {
        router.replace('/workspace');
        return;
      }
      setState((previous) => {
        if (
          previous.status === 'ready' &&
          previous.session.session.idleExpiresAt === session.session.idleExpiresAt &&
          previous.session.session.absoluteExpiresAt === session.session.absoluteExpiresAt
        ) {
          return previous;
        }
        return { status: 'ready', session };
      });
    } catch (error) {
      handleSessionError(error, router);
    }
  }, [requiredRole, router]);

  // 首次校验
  useEffect(() => {
    void revalidate(true);
  }, [revalidate]);

  // 重新可见 / 重新获得焦点时校验（防止后台标签页里会话已过期）
  useEffect(() => {
    const check = (): void => {
      if (document.visibilityState === 'visible') {
        void revalidate(false);
      }
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [revalidate]);

  // 到期自动退出：取空闲与绝对到期时间中较早的一个
  useEffect(() => {
    if (state.status !== 'ready') {
      return;
    }
    const idle = Date.parse(state.session.session.idleExpiresAt);
    const absolute = Date.parse(state.session.session.absoluteExpiresAt);
    const deadline = Math.min(idle, absolute);
    if (Number.isNaN(deadline)) {
      return;
    }

    const delay = deadline - Date.now();
    if (delay <= 0) {
      expire();
      return;
    }

    const timer = setTimeout(expire, Math.min(delay, MAX_TIMEOUT_MS));
    return () => {
      clearTimeout(timer);
    };
  }, [state, expire]);

  return { state, refreshSession };
}

/** 退出登录并回到登录页。 */
export async function logoutAndRedirect(router: {
  replace: (path: string) => void;
}): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  } finally {
    router.replace('/login');
  }
}
