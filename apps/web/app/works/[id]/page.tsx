'use client';

/**
 * 作品详情（M2-A）。
 *
 * 只显示作品基础信息与作品设定占位；
 * 人物、境界、卷纲与章节将在后续阶段开放 —— 这里**不提供**任何伪造的
 * 编辑器或生成按钮。
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { fetchWork, formatDateTime, messageOf, type WorkDetail } from '@/lib/api';
import { handleSessionError } from '@/lib/session-errors';
import { logoutAndRedirect, useRequireSession } from '@/lib/use-session';

export default function WorkDetailPage(): React.ReactElement {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { state, refreshSession } = useRequireSession({ role: 'author' });

  const [work, setWork] = useState<WorkDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const workId = params.id;

  const loadWork = useCallback(async (): Promise<void> => {
    try {
      const detail = await fetchWork(workId);
      setWork(detail);
      setError('');
      void refreshSession();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, [workId, refreshSession, router]);

  useEffect(() => {
    if (state.status === 'ready') {
      void loadWork();
    }
  }, [state.status, loadWork]);

  if (state.status === 'loading') {
    return (
      <main className="page">
        <p className="hint" role="status">
          正在加载…
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="toolbar">
        <div>
          <Link href="/workspace" className="back-link" data-testid="back-to-works">
            ← 返回作品列表
          </Link>
          <h1>{work?.title ?? '作品'}</h1>
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

      {error === '' ? null : (
        <div className="card">
          <p className="alert alert--error" role="alert" data-testid="work-detail-error">
            {error}
          </p>
          <p className="hint">作品不存在，或不属于当前账号。</p>
        </div>
      )}

      {loading ? (
        <p className="hint" role="status">
          正在加载作品…
        </p>
      ) : null}

      {work === null ? null : (
        <>
          <div className="card">
            <h2>基本信息</h2>
            <dl className="kv">
              <dt>标题</dt>
              <dd data-testid="work-detail-title">{work.title}</dd>
              <dt>简介</dt>
              <dd data-testid="work-detail-summary">
                {work.summary === '' ? '（未填写）' : work.summary}
              </dd>
              <dt>题材</dt>
              <dd data-testid="work-detail-genre">{work.genreRulePackage}</dd>
              <dt>目标章数</dt>
              <dd data-testid="work-detail-chapters">{work.targetChapters}</dd>
              <dt>单章目标字数</dt>
              <dd data-testid="work-detail-words">{work.targetWordsPerChapter}</dd>
              <dt>创建时间</dt>
              <dd>{formatDateTime(work.createdAt)}</dd>
              <dt>更新时间</dt>
              <dd>{formatDateTime(work.updatedAt)}</dd>
            </dl>
          </div>

          <div className="card">
            <h2>作品设定</h2>
            {work.settings.length === 0 ? (
              <p className="hint" data-testid="work-settings-empty">
                尚未设置任何作品设定。
              </p>
            ) : (
              <ul className="kv-list" data-testid="work-settings-list">
                {work.settings.map((setting) => (
                  <li key={`${setting.schemaRef}:${setting.settingKey}`}>
                    <strong>{setting.settingKey}</strong>
                    <span className="hint"> （schema: {setting.schemaRef}）</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2>设定中心</h2>
            <p className="hint">作品方向与境界体系已开放。</p>
            <Link
              href={`/works/${work.id}/settings`}
              className="btn-secondary"
              data-testid="open-settings"
            >
              进入设定中心
            </Link>
          </div>

          <div className="card">
            <h2>后续阶段</h2>
            <p>人物、势力、功法、物品、卷纲与章节创作将在后续阶段开放。</p>
            <p className="hint">本阶段不提供 AI 生成入口。</p>
          </div>
        </>
      )}
    </main>
  );
}
