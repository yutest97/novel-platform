'use client';

/**
 * 登录页（中文）。
 *
 * - 不提供注册入口（账号只能由管理员创建）；
 * - 登录失败只显示统一文案（邮箱或密码不正确），不区分账号是否存在；
 * - 429 显示「尝试过于频繁，请稍后再试」；
 * - 成功后按响应分流：待改密 → /change-password；管理员 → /admin/users；作者 → /workspace。
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { apiRequest, messageOf, type SessionUser } from '@/lib/api';
import { homeFor } from '@/lib/use-session';

interface LoginResponse {
  readonly user: SessionUser;
}

export default function LoginPage(): React.ReactElement {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
    // 来自守卫跳转的提示（停用/异常）；只认固定取值，不回显任意文本
    const reason = new URLSearchParams(window.location.search).get('reason');
    if (reason === 'disabled') {
      setError('账号已停用，请联系管理员');
    } else if (reason === 'expired') {
      setError('会话已过期，请重新登录');
    } else if (reason === 'error') {
      setError('会话校验失败，请重新登录');
    }
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setError('');

    try {
      const { body } = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { email: email.trim(), password },
      });
      const user = (body as LoginResponse).user;
      if (user.mustChangePassword) {
        router.replace('/change-password');
      } else {
        router.replace(homeFor(user));
      }
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
    }
  }

  return (
    <main className="page page--narrow">
      <div className="card">
        <h1>登录</h1>
        <p className="subtitle">请输入管理员为你创建的账号。本系统不开放注册。</p>

        {error === '' ? null : (
          <p className="alert alert--error" role="alert" data-testid="login-error">
            {error}
          </p>
        )}

        <form onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="field">
            <label htmlFor="email">邮箱</label>
            <input
              ref={emailRef}
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="password">密码</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <button type="submit" className="btn-primary" disabled={busy} aria-busy={busy}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </main>
  );
}
