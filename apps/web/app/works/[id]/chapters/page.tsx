'use client';

/**
 * 章节列表 / 创建（A1-4A）。
 *
 * - 只显示章节与最新任务状态徽标，**不加载任何正文**；
 * - 章号在作品内唯一，冲突显示稳定中文（`CHAPTER_NO_TAKEN`）；
 * - 创建成功后刷新列表并保留在列表页，由作者点击进入工作台；
 * - 不提供人工编辑、删除或排序（A1-4B 起再评估）。
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  createChapter,
  fetchChapters,
  fetchWork,
  messageOf,
  type ChapterListItem,
  type WorkDetail,
} from '@/lib/api';
import { chapterBadge, chapterStatusLabel, shouldPollTask } from '@/lib/chapter-workbench';
import { handleSessionError } from '@/lib/session-errors';
import { logoutAndRedirect, useRequireSession } from '@/lib/use-session';

export default function ChapterListPage(): React.ReactElement {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { state, refreshSession } = useRequireSession({ role: 'author' });
  const workId = params.id;

  const [work, setWork] = useState<WorkDetail | null>(null);
  const [chapters, setChapters] = useState<readonly ChapterListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [chapterNo, setChapterNo] = useState('1');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const [detail, list] = await Promise.all([fetchWork(workId), fetchChapters(workId)]);
      setWork(detail);
      setChapters(list);
      setChapterNo(String((list[list.length - 1]?.chapterNo ?? 0) + 1));
      setLoadError('');
      void refreshSession();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setLoadError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, [workId, refreshSession, router]);

  useEffect(() => {
    if (state.status === 'ready') {
      void load();
    }
  }, [state.status, load]);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (creating) {
      return;
    }
    const parsedNo = Number(chapterNo);
    if (!Number.isInteger(parsedNo) || parsedNo < 1) {
      setCreateError('章号必须是正整数');
      return;
    }
    const trimmedTitle = title.trim();
    if (trimmedTitle === '') {
      setCreateError('标题不能为空');
      return;
    }

    setCreating(true);
    setCreateError('');
    setNotice('');
    try {
      const created = await createChapter(workId, {
        chapterNo: parsedNo,
        title: trimmedTitle,
      });
      setNotice(`已创建第 ${created.chapterNo} 章`);
      setTitle('');
      await load();
      void refreshSession();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setCreateError(messageOf(caught));
    } finally {
      setCreating(false);
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

  return (
    <main className="page">
      <div className="toolbar">
        <div>
          <Link href={`/works/${workId}`} className="back-link" data-testid="back-to-work">
            ← 返回作品详情
          </Link>
          <h1>章节创作</h1>
          <p className="subtitle" data-testid="chapters-work-title">
            {work === null ? '' : `《${work.title}》`}
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

      {loadError === '' ? null : (
        <div className="card">
          <p className="alert alert--error" role="alert" data-testid="chapters-error">
            {loadError}
          </p>
          <p className="hint">作品不存在，或不属于当前账号。</p>
        </div>
      )}

      {loading ? (
        <p className="hint" role="status">
          正在加载章节…
        </p>
      ) : null}

      {loadError !== '' ? null : (
        <>
          <div className="card">
            <h2>新建章节</h2>
            <form className="chapter-form" onSubmit={(event) => void handleCreate(event)}>
              <div className="field">
                <label htmlFor="chapter-no">章号</label>
                <input
                  id="chapter-no"
                  type="number"
                  min={1}
                  step={1}
                  value={chapterNo}
                  onChange={(event) => setChapterNo(event.target.value)}
                  data-testid="chapter-create-no"
                />
              </div>
              <div className="field">
                <label htmlFor="chapter-title">标题</label>
                <input
                  id="chapter-title"
                  type="text"
                  maxLength={200}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="例如：初入青云"
                  data-testid="chapter-create-title"
                />
              </div>
              <button
                type="submit"
                className="btn-primary"
                disabled={creating}
                aria-busy={creating}
                data-testid="chapter-create-submit"
              >
                {creating ? '创建中…' : '创建章节'}
              </button>
            </form>
            {createError === '' ? null : (
              <p className="alert alert--error" role="alert" data-testid="chapter-create-error">
                {createError}
              </p>
            )}
            {notice === '' ? null : (
              <p className="alert alert--ok" role="status" data-testid="chapter-notice">
                {notice}
              </p>
            )}
          </div>

          <div className="card">
            <h2>章节列表</h2>
            {chapters.length === 0 ? (
              <p className="hint" data-testid="chapters-empty">
                还没有章节。先在上方创建第 1 章。
              </p>
            ) : (
              <ul className="chapter-list" data-testid="chapter-list">
                {chapters.map((chapter) => {
                  const badge = chapterBadge(chapter);
                  return (
                    <li className="chapter-item" key={chapter.id} data-testid="chapter-item">
                      <div className="chapter-item__main">
                        <h3>
                          第 {chapter.chapterNo} 章 · {chapter.title}
                        </h3>
                        <p className="hint">
                          章节状态：{chapterStatusLabel(chapter.status)}
                          {chapter.latestTaskStatus !== null &&
                          shouldPollTask(chapter.latestTaskStatus)
                            ? ' · 任务进行中'
                            : ''}
                        </p>
                      </div>
                      <span className={`badge badge--${badge.tone}`}>{badge.label}</span>
                      <Link
                        href={`/works/${workId}/chapters/${chapter.id}`}
                        className="btn-secondary btn-small"
                        data-testid="chapter-open"
                      >
                        打开
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </main>
  );
}
