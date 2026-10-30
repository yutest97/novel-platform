'use client';

/**
 * 管理员 · 账号管理。
 *
 * 能力：列表、新建作者、重置密码、停用/启用、退出登录。
 * 约束：
 * - 仅 active 且已改密的管理员可进入（守卫 + 服务端接口双重校验）；
 * - 一次性口令只在弹窗里显示一次，关闭即清空组件状态，刷新后无法再从接口取回；
 * - 不提供删除账号；按钮按角色显示，但服务端仍是最终权限边界。
 */

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { OneTimeSecret } from '@/components/one-time-secret';
import {
  apiRequest,
  formatDateTime,
  messageOf,
  roleLabel,
  statusLabel,
  type AdminUser,
} from '@/lib/api';
import { handleSessionError } from '@/lib/session-errors';
import { logoutAndRedirect, useRequireSession } from '@/lib/use-session';

interface ListResponse {
  readonly users: AdminUser[];
}

interface CreateResponse {
  readonly user: AdminUser;
  readonly initialPassword?: string;
}

interface ResetResponse {
  readonly user: AdminUser;
  readonly newPassword?: string;
}

interface OneTimeState {
  readonly title: string;
  readonly secret: string;
  readonly notice: string;
}

interface ConfirmState {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly run: () => Promise<void>;
}

export default function AdminUsersPage(): React.ReactElement {
  const router = useRouter();
  const { state, refreshSession } = useRequireSession({ role: 'admin' });

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');

  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const [oneTime, setOneTime] = useState<OneTimeState | null>(null);
  // 弹窗关闭后再刷新列表：弹窗打开期间重渲染会替换触发按钮节点，导致焦点无法回归
  const refreshAfterModalRef = useRef(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);

  const loadUsers = useCallback(async (): Promise<void> => {
    try {
      const { body } = await apiRequest('/api/admin/users');
      setUsers((body as ListResponse).users);
      setListError('');
      // 列表加载成功 = 管理员仍在活跃使用：刷新会话到期时间（滑动续期）
      void refreshSession();
    } catch (caught) {
      // 会话类错误（未登录/停用/待改密）必须立即跳转，不能只显示错误文本
      if (handleSessionError(caught, router)) {
        return;
      }
      setListError(messageOf(caught));
    }
  }, [refreshSession, router]);

  useEffect(() => {
    if (state.status === 'ready') {
      void loadUsers();
    }
  }, [state.status, loadUsers]);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (createBusy) {
      return;
    }
    setCreateBusy(true);
    setActionError('');
    setNotice('');

    try {
      const { body } = await apiRequest('/api/admin/users', {
        method: 'POST',
        body: {
          email: createEmail.trim(),
          ...(createPassword === '' ? {} : { initialPassword: createPassword }),
        },
      });
      const created = body as CreateResponse;
      setCreateEmail('');
      setCreatePassword('');
      void refreshSession();

      if (created.initialPassword !== undefined) {
        refreshAfterModalRef.current = true;
        setOneTime({
          title: '作者账号已创建',
          secret: created.initialPassword,
          notice:
            '这是服务器生成的初始密码，只会显示这一次。请立即复制并交给作者；关闭后无法再次查看，只能重置密码。',
        });
      } else {
        await loadUsers();
        setNotice('作者账号已创建。你设置了初始密码，系统不会再次显示它；对方首次登录需要改密。');
      }
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setActionError(messageOf(caught));
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleReset(user: AdminUser): Promise<void> {
    setRowBusyId(user.id);
    setActionError('');
    setNotice('');
    try {
      const { body } = await apiRequest(`/api/admin/users/${user.id}/reset-password`, {
        method: 'POST',
        body: {},
      });
      const result = body as ResetResponse;
      void refreshSession();

      if (result.newPassword !== undefined) {
        refreshAfterModalRef.current = true;
        setOneTime({
          title: '新密码已生成',
          secret: result.newPassword,
          notice:
            '该账号的旧会话已全部失效，对方需要用此密码重新登录并再次改密。密码只会显示这一次。',
        });
      } else {
        await loadUsers();
        setNotice('密码已重置，对方的旧会话已全部失效。');
      }
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setActionError(messageOf(caught));
    } finally {
      setRowBusyId(null);
    }
  }

  async function applyStatus(user: AdminUser, status: 'active' | 'disabled'): Promise<void> {
    try {
      await apiRequest(`/api/admin/users/${user.id}/status`, {
        method: 'PATCH',
        body: { status },
      });
      setNotice(status === 'disabled' ? '账号已停用，其所有会话已失效。' : '账号已启用。');
      void refreshSession();
      await loadUsers();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setActionError(messageOf(caught));
    } finally {
      setRowBusyId(null);
    }
  }

  function requestStatusChange(user: AdminUser, status: 'active' | 'disabled'): void {
    if (status === 'active') {
      setRowBusyId(user.id);
      void applyStatus(user, 'active');
      return;
    }
    setConfirm({
      title: '停用账号',
      message: `确定要停用 ${user.email} 吗？停用后该账号的会话立即失效，且无法登录。`,
      confirmLabel: '确认停用',
      run: () => applyStatus(user, 'disabled'),
    });
  }

  if (state.status === 'loading') {
    return (
      <main className="page">
        <p className="hint" role="status">
          正在加载…
        </p>
      </main>
    );
  }

  const isFull = users.length >= 10;

  return (
    <main className="page">
      <div className="toolbar">
        <div>
          <h1>账号管理</h1>
          <p className="subtitle">
            当前登录：{state.session.user.email}（{roleLabel(state.session.user.role)}）
          </p>
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

      {actionError === '' ? null : (
        <p className="alert alert--error" role="alert" data-testid="action-error">
          {actionError}
        </p>
      )}
      {notice === '' ? null : (
        <p className="alert alert--ok" role="status" data-testid="admin-notice">
          {notice}
        </p>
      )}

      <section className="card" aria-labelledby="create-title">
        <h2 id="create-title">新建作者账号</h2>
        <p className="hint">
          账号总数上限 10 个（含已停用）。不填写初始密码时，由服务器生成一次性强密码。
        </p>
        <form onSubmit={(event) => void handleCreate(event)} noValidate>
          <div className="field">
            <label htmlFor="create-email">邮箱</label>
            <input
              id="create-email"
              name="email"
              type="email"
              required
              autoComplete="off"
              value={createEmail}
              onChange={(event) => setCreateEmail(event.target.value)}
              data-testid="create-email"
            />
          </div>
          <div className="field">
            <label htmlFor="create-password">初始密码（可选）</label>
            <input
              id="create-password"
              name="initialPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={createPassword}
              onChange={(event) => setCreatePassword(event.target.value)}
              data-testid="create-password"
            />
            <span className="hint">填写后系统不会显示该密码；留空则由服务器生成并一次性展示。</span>
          </div>
          <button
            type="submit"
            className="btn-primary"
            disabled={createBusy}
            aria-busy={createBusy}
            data-testid="create-submit"
          >
            {createBusy ? '创建中…' : '创建作者'}
          </button>
          {isFull ? (
            <p className="hint" role="status" style={{ marginTop: '0.5rem' }}>
              账号数量已达上限（10 个），无法继续创建。
            </p>
          ) : null}
        </form>
      </section>

      <section className="card" aria-labelledby="list-title">
        <h2 id="list-title">账号列表</h2>
        {listError === '' ? null : (
          <p className="alert alert--error" role="alert">
            {listError}
          </p>
        )}

        <div className="table-wrap">
          <table data-testid="users-table">
            <caption className="visually-hidden">
              账号列表：邮箱、角色、状态、是否待首次改密、创建时间
            </caption>
            <thead>
              <tr>
                <th scope="col">邮箱</th>
                <th scope="col">角色</th>
                <th scope="col">状态</th>
                <th scope="col">待首次改密</th>
                <th scope="col">创建时间</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} data-testid="user-row">
                  <td>{user.email}</td>
                  <td>{roleLabel(user.role)}</td>
                  <td>
                    <span
                      className={`badge ${user.status === 'active' ? 'badge--ok' : 'badge--danger'}`}
                    >
                      {statusLabel(user.status)}
                    </span>
                  </td>
                  <td>
                    {user.mustChangePassword ? (
                      <span className="badge badge--warn">待改密</span>
                    ) : (
                      <span className="hint">—</span>
                    )}
                  </td>
                  <td>{formatDateTime(user.createdAt)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        disabled={rowBusyId === user.id}
                        onClick={() => void handleReset(user)}
                      >
                        重置密码
                      </button>
                      {user.status === 'active' ? (
                        <button
                          type="button"
                          className="btn-danger btn-small"
                          disabled={rowBusyId === user.id}
                          onClick={() => requestStatusChange(user, 'disabled')}
                        >
                          停用
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-secondary btn-small"
                          disabled={rowBusyId === user.id}
                          onClick={() => requestStatusChange(user, 'active')}
                        >
                          启用
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint" style={{ marginTop: '0.75rem' }}>
          共 {users.length} / 10 个账号。本系统不提供删除账号。
        </p>
      </section>

      {oneTime === null ? null : (
        <OneTimeSecret
          title={oneTime.title}
          secret={oneTime.secret}
          notice={oneTime.notice}
          onConfirm={() => {
            setOneTime(null);
            if (refreshAfterModalRef.current) {
              refreshAfterModalRef.current = false;
              void loadUsers();
            }
          }}
        />
      )}

      {confirm === null ? null : (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger
          busy={confirmBusy}
          onCancel={() => {
            setConfirm(null);
          }}
          onConfirm={() => {
            setConfirmBusy(true);
            void confirm.run().finally(() => {
              setConfirmBusy(false);
              setConfirm(null);
            });
          }}
        />
      )}
    </main>
  );
}
