'use client';

/**
 * 首页：按会话状态分流。
 *
 * - 未登录 / 停用 / 会话失效 → /login
 * - 首登未改密 → /change-password
 * - 管理员 → /admin/users，作者 → /workspace
 */

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { ApiError, fetchSession } from '@/lib/api';
import { homeFor } from '@/lib/use-session';

export default function HomePage(): React.ReactElement {
  const router = useRouter();

  useEffect(() => {
    let active = true;
    void fetchSession()
      .then((session) => {
        if (active) {
          router.replace(homeFor(session.user));
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
        router.replace(code === 'PASSWORD_CHANGE_REQUIRED' ? '/change-password' : '/login');
      });
    return () => {
      active = false;
    };
  }, [router]);

  return (
    <main className="page page--narrow">
      <p className="hint" role="status">
        正在检查登录状态…
      </p>
    </main>
  );
}
