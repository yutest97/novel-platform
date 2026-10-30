'use client';

/**
 * 强制改密页（首次登录/被重置密码后）。
 *
 * - 前端先校验两次新密码一致；
 * - 提交调用 /api/auth/change-password，成功后服务端已轮换 Cookie，
 *   直接按角色进入对应首页；
 * - 密码只存在于组件内存，不写 URL / localStorage / sessionStorage / 日志。
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ApiError, apiRequest, messageOf, type SessionUser } from '@/lib/api';
import { homeFor } from '@/lib/use-session';

interface ChangePasswordResponse {
  readonly user: SessionUser;
}

export default function ChangePasswordPage(): React.ReactElement {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) {
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    if (newPassword.length < 12) {
      setError('新密码至少 12 个字符');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const { body } = await apiRequest('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      const user = (body as ChangePasswordResponse).user;
      // 服务端已吊销旧会话并下发新 Cookie，这里直接进入角色首页
      router.replace(homeFor(user));
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'UNAUTHENTICATED') {
        router.replace('/login');
        return;
      }
      setError(messageOf(caught));
      setBusy(false);
    }
  }

  return (
    <main className="page page--narrow">
      <div className="card">
        <h1>修改密码</h1>
        <p className="subtitle">首次登录或密码被管理员重置后，必须先设置新密码。</p>

        {error === '' ? null : (
          <p className="alert alert--error" role="alert" data-testid="change-password-error">
            {error}
          </p>
        )}

        <form onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="field">
            <label htmlFor="current-password">当前密码</label>
            <input
              id="current-password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="new-password">新密码</label>
            <input
              id="new-password"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <span className="hint">至少 12 个字符，可使用任意字符。</span>
          </div>

          <div className="field">
            <label htmlFor="confirm-password">确认新密码</label>
            <input
              id="confirm-password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </div>

          <button type="submit" className="btn-primary" disabled={busy} aria-busy={busy}>
            {busy ? '提交中…' : '提交'}
          </button>
        </form>
      </div>
    </main>
  );
}
