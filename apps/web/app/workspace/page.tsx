'use client';

/**
 * 作者工作台（第一版占位）。
 *
 * 仅展示当前账号与会话信息，并提供退出；不包含任何伪造的小说功能入口。
 */

import { useRouter } from 'next/navigation';

import { formatDateTime, roleLabel } from '@/lib/api';
import { logoutAndRedirect, useRequireSession } from '@/lib/use-session';

export default function WorkspacePage(): React.ReactElement {
  const router = useRouter();
  const state = useRequireSession();

  if (state.status === 'loading') {
    return (
      <main className="page page--narrow">
        <p className="hint" role="status">
          正在加载…
        </p>
      </main>
    );
  }

  const { user, session } = state.session;

  return (
    <main className="page">
      <div className="toolbar">
        <div>
          <h1>写作台</h1>
          <p className="subtitle">当前阶段仅提供账号与会话信息。</p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void logoutAndRedirect(router)}
          data-testid="logout"
        >
          退出登录
        </button>
      </div>

      <div className="card">
        <h2>账号信息</h2>
        <dl className="kv">
          <dt>邮箱</dt>
          <dd data-testid="workspace-email">{user.email}</dd>
          <dt>角色</dt>
          <dd data-testid="workspace-role">{roleLabel(user.role)}</dd>
          <dt>会话有效期</dt>
          <dd>
            绝对到期 {formatDateTime(session.absoluteExpiresAt)} · 空闲到期{' '}
            {formatDateTime(session.idleExpiresAt)}
          </dd>
        </dl>
      </div>

      <div className="card">
        <h2>小说创作功能</h2>
        <p>小说创作功能将在下一阶段开放。</p>
        <p className="hint">本阶段不包含作品、章节或 AI 生成相关入口。</p>
      </div>
    </main>
  );
}
