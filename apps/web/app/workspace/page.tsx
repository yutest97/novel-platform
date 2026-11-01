'use client';

/**
 * 作者工作台（M2-A）：账号信息 + 我的作品列表 + 创建作品。
 *
 * 约束：
 * - 只有 active、已改密的**作者**能进入（管理员会被送回 /admin/users）；
 * - 作品列表只来自服务端接口，前端不缓存、不做任何跨作者查询；
 * - 不提供人物、章节、境界、AI 生成等本阶段之外的入口。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  createWork,
  fetchRulePackages,
  fetchWorks,
  formatDateTime,
  messageOf,
  roleLabel,
  type WorkSummary,
} from '@/lib/api';
import { handleSessionError } from '@/lib/session-errors';
import { logoutAndRedirect, useRequireSession } from '@/lib/use-session';

const DEFAULT_RULE_PACKAGE_CODE = 'xuanhuan';
const DEFAULT_RULE_PACKAGE_NAME = '玄幻升级';

export default function WorkspacePage(): React.ReactElement {
  const router = useRouter();
  const { state, refreshSession } = useRequireSession({ role: 'author' });

  const [works, setWorks] = useState<WorkSummary[]>([]);
  const [listError, setListError] = useState('');
  const [listLoading, setListLoading] = useState(true);

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [targetChapters, setTargetChapters] = useState('10');
  const [targetWords, setTargetWords] = useState('3000');
  const [rulePackageCode, setRulePackageCode] = useState(DEFAULT_RULE_PACKAGE_CODE);
  const [rulePackageName, setRulePackageName] = useState(DEFAULT_RULE_PACKAGE_NAME);

  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const [notice, setNotice] = useState('');

  const loadWorks = useCallback(async (): Promise<void> => {
    try {
      const list = await fetchWorks();
      setWorks(list);
      setListError('');
      // 列表加载成功 = 作者仍在活跃使用：续期会话
      void refreshSession();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setListError(messageOf(caught));
    } finally {
      setListLoading(false);
    }
  }, [refreshSession, router]);

  useEffect(() => {
    if (state.status === 'ready') {
      void loadWorks();
    }
  }, [state.status, loadWorks]);

  useEffect(() => {
    if (state.status !== 'ready') {
      return;
    }
    void (async () => {
      try {
        const packages = await fetchRulePackages();
        const first = packages[0];
        if (first !== undefined) {
          setRulePackageCode(first.code);
          setRulePackageName(first.name);
        }
      } catch {
        // 题材列表读取失败时回退到默认题材（第一版只有玄幻升级）
      }
    })();
  }, [state.status]);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (createBusy) {
      return;
    }
    setCreateBusy(true);
    setCreateError('');
    setNotice('');

    // 本地先做一次范围校验：给用户具体的中文提示，
    // 而不是等服务端返回按错误码映射的通用文案。
    const chapters = Number.parseInt(targetChapters, 10);
    if (!Number.isInteger(chapters) || chapters < 1 || chapters > 100) {
      setCreateError('目标章数必须在 1—100 之间');
      setCreateBusy(false);
      return;
    }
    const words = Number.parseInt(targetWords, 10);
    if (!Number.isInteger(words) || words < 1200 || words > 10000) {
      setCreateError('单章目标字数必须在 1200—10000 之间');
      setCreateBusy(false);
      return;
    }

    try {
      const work = await createWork({
        title,
        ...(summary === '' ? {} : { summary }),
        targetChapters: chapters,
        targetWordsPerChapter: words,
        genreRulePackage: rulePackageCode,
      });
      setTitle('');
      setSummary('');
      setNotice(`《${work.title}》已创建。`);
      void refreshSession();
      await loadWorks();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setCreateError(messageOf(caught));
    } finally {
      setCreateBusy(false);
    }
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

  const { user, session } = state.session;

  return (
    <main className="page">
      <div className="toolbar">
        <div>
          <h1>写作台</h1>
          <p className="subtitle">管理我的作品。</p>
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
        <h2>创建作品</h2>
        <form onSubmit={(event) => void handleCreate(event)} noValidate>
          <div className="field">
            <label htmlFor="work-title">标题</label>
            <input
              id="work-title"
              name="title"
              type="text"
              required
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              data-testid="work-title-input"
            />
          </div>

          <div className="field">
            <label htmlFor="work-summary">简介</label>
            <textarea
              id="work-summary"
              name="summary"
              rows={3}
              maxLength={2000}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              data-testid="work-summary-input"
            />
          </div>

          <div className="field">
            <label htmlFor="work-chapters">目标章数</label>
            <input
              id="work-chapters"
              name="targetChapters"
              type="number"
              min={1}
              max={100}
              required
              value={targetChapters}
              onChange={(event) => setTargetChapters(event.target.value)}
              data-testid="work-chapters-input"
            />
          </div>

          <div className="field">
            <label htmlFor="work-words">单章目标字数</label>
            <input
              id="work-words"
              name="targetWordsPerChapter"
              type="number"
              min={1200}
              max={10000}
              required
              value={targetWords}
              onChange={(event) => setTargetWords(event.target.value)}
              data-testid="work-words-input"
            />
          </div>

          <div className="field">
            <span className="label-like">题材</span>
            <p className="readonly-value" data-testid="work-genre">
              {rulePackageName}
            </p>
            <span className="hint">第一版仅支持玄幻升级题材，暂不支持选择其他题材。</span>
          </div>

          {createError === '' ? null : (
            <p className="alert alert--error" role="alert" data-testid="work-create-error">
              {createError}
            </p>
          )}
          {notice === '' ? null : (
            <p className="alert alert--ok" role="status" data-testid="work-notice">
              {notice}
            </p>
          )}

          <button
            type="submit"
            className="btn-primary"
            disabled={createBusy}
            aria-busy={createBusy}
            data-testid="work-create-submit"
          >
            {createBusy ? '创建中…' : '创建作品'}
          </button>
        </form>
      </div>

      <div className="card">
        <h2>我的作品</h2>

        {listError === '' ? null : (
          <p className="alert alert--error" role="alert" data-testid="works-list-error">
            {listError}
          </p>
        )}

        {listLoading ? (
          <p className="hint" role="status">
            正在加载作品…
          </p>
        ) : works.length === 0 ? (
          <div className="empty-state" data-testid="works-empty">
            <p>你还没有创建任何作品。</p>
            <p className="hint">使用上方的表单创建第一本作品。</p>
          </div>
        ) : (
          <ul className="work-list" data-testid="works-list">
            {works.map((work) => (
              <li key={work.id}>
                <Link href={`/works/${work.id}`} className="work-card" data-testid="work-card">
                  <h3>{work.title}</h3>
                  {work.summary === '' ? null : <p className="work-card-summary">{work.summary}</p>}
                  <p className="work-card-meta">
                    目标 {work.targetChapters} 章 · 单章 {work.targetWordsPerChapter} 字 · 更新于{' '}
                    {formatDateTime(work.updatedAt)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>后续阶段</h2>
        <p>人物、境界、卷纲与章节创作将在后续阶段开放。</p>
        <p className="hint">本阶段不提供 AI 生成入口。</p>
      </div>
    </main>
  );
}
