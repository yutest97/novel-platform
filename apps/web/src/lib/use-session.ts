'use client';

/**
 * 会话守卫 Hook。
 *
 * 规则（M1-B3）：
 * - 认证只依赖 HttpOnly Cookie：这里只请求 `/api/auth/me`，不读取任何令牌；
 * - 未登录 → /login；账号停用 → /login?reason=disabled；
 *   首登未改密 → /change-password；角色不符 → /workspace；
 * - 客户端跳转只是体验层，服务端接口仍是最终权限边界。
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiError, fetchSession, type SessionInfo, type SessionUser } from './api';

/** 会话状态。 */
export type SessionState =
  { readonly status: 'loading' } | { readonly status: 'ready'; readonly session: SessionInfo };

/** 账号的默认首页。 */
export function homeFor(user: Pick<SessionUser, 'role'>): string {
  return user.role === 'admin' ? '/admin/users' : '/workspace';
}

/**
 * 要求已登录（可选要求管理员）。
 *
 * 返回 `loading` 时页面应渲染骨架，避免闪烁未授权内容。
 */
export function useRequireSession(options: { role?: 'admin' } = {}): SessionState {
  const router = useRouter();
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  // 解构出原始值，作为 effect 依赖（options 对象每次渲染都是新引用）
  const requiredRole = options.role;

  useEffect(() => {
    let active = true;

    void fetchSession()
      .then((session) => {
        if (!active) {
          return;
        }
        if (requiredRole === 'admin' && session.user.role !== 'admin') {
          router.replace('/workspace');
          return;
        }
        setState({ status: 'ready', session });
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
        if (code === 'UNAUTHENTICATED') {
          router.replace('/login');
        } else if (code === 'ACCOUNT_DISABLED') {
          router.replace('/login?reason=disabled');
        } else if (code === 'PASSWORD_CHANGE_REQUIRED') {
          router.replace('/change-password');
        } else if (code === 'FORBIDDEN') {
          router.replace('/workspace');
        } else {
          router.replace('/login?reason=error');
        }
      });

    return () => {
      active = false;
    };
  }, [requiredRole, router]);

  return state;
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
