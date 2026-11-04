'use client';

/**
 * 章节工作台（A1-4A）。
 *
 * 作者在这里完成：提交生成 → 查看进度/取消 → 预览候选 → 采纳 → 阅读正式正文。
 *
 * 边界：
 * - 只读正文用 `pre-wrap` 纯文本渲染，不使用 `dangerouslySetInnerHTML`；
 * - 候选正文只在点击某个候选后才请求，避免一次加载所有长文；
 * - requestId 只存在组件内存（useRef），同一内容重复点击复用同一个 id；
 *   任务进入终态或**取消成功**后立即作废，下一次生成必定换新 id；
 * - 目标字数默认值收敛到 2500..4000（页面仍显示作品原始目标）；
 * - 轮询只针对 queued/processing；页面隐藏时暂停，重新可见立即刷新一次；
 * - 不提供人工编辑、human 版本、diff 或版本恢复（A1-4B 起再评估）。
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  ApiError,
  adoptChapterCandidate,
  cancelGenerationTask,
  fetchChapter,
  fetchChapterCandidate,
  fetchChapterVersion,
  fetchChapterVersions,
  fetchGenerationTask,
  fetchWork,
  formatDateTime,
  messageOf,
  startChapterGeneration,
  type ChapterCandidateDetail,
  type ChapterDetail,
  type ChapterVersionDetail,
  type ChapterVersionListItem,
  type WorkDetail,
} from '@/lib/api';
import {
  MAX_CHAPTER_TARGET_WORDS,
  MIN_CHAPTER_TARGET_WORDS,
  canGenerateChapter,
  chapterStatusLabel,
  clampChapterTargetWords,
  displayPlan,
  generationNotice,
  isTerminalTaskStatus,
  nextPollDelay,
  shouldPollTask,
  taskProgressLabel,
  taskStatusLabel,
  taskStepLabelForStatus,
  versionSourceLabel,
  type WorkbenchNotice,
} from '@/lib/chapter-workbench';
import { handleSessionError } from '@/lib/session-errors';
import { logoutAndRedirect, useRequireSession } from '@/lib/use-session';

export default function ChapterWorkbenchPage(): React.ReactElement {
  const router = useRouter();
  const params = useParams<{ id: string; chapterId: string }>();
  const { state, refreshSession } = useRequireSession({ role: 'author' });
  const workId = params.id;
  const chapterId = params.chapterId;

  const [work, setWork] = useState<WorkDetail | null>(null);
  const [detail, setDetail] = useState<ChapterDetail | null>(null);
  const [versions, setVersions] = useState<readonly ChapterVersionListItem[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<ChapterVersionDetail | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [targetWords, setTargetWords] = useState('3000');
  const [tone, setTone] = useState('');
  const [pointOfView, setPointOfView] = useState('');
  const [pacing, setPacing] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  const [adoptionNotice, setAdoptionNotice] = useState('');

  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');

  const [selectedCandidate, setSelectedCandidate] = useState<ChapterCandidateDetail | null>(null);
  const [candidateLoadingId, setCandidateLoadingId] = useState<string | null>(null);
  const [candidateError, setCandidateError] = useState('');

  const [adoptTargetId, setAdoptTargetId] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState('');

  const targetInitialized = useRef(false);
  const selectedVersionIdRef = useRef<string | null>(null);
  const requestIdRef = useRef<{ readonly key: string; readonly id: string } | null>(null);
  const pollDelayRef = useRef(1_000);

  const openVersion = useCallback(
    async (versionId: string): Promise<void> => {
      setVersionLoading(true);
      try {
        const version = await fetchChapterVersion(workId, chapterId, versionId);
        setSelectedVersion(version);
        selectedVersionIdRef.current = version.id;
      } catch (caught) {
        if (handleSessionError(caught, router)) {
          return;
        }
        setLoadError(messageOf(caught));
      } finally {
        setVersionLoading(false);
      }
    },
    [workId, chapterId, router],
  );

  /** 刷新章节详情与版本列表；`selectLatest` 用于采纳后自动选中最大版本。 */
  const refreshDetailAndVersions = useCallback(
    async (options: { selectLatest?: boolean } = {}): Promise<void> => {
      const [nextDetail, nextVersions] = await Promise.all([
        fetchChapter(workId, chapterId),
        fetchChapterVersions(workId, chapterId),
      ]);
      setDetail(nextDetail);
      setVersions(nextVersions);

      const preferred =
        options.selectLatest === true
          ? nextVersions[0]
          : (nextVersions.find((version) => version.id === selectedVersionIdRef.current) ??
            nextVersions[0]);
      if (preferred === undefined) {
        setSelectedVersion(null);
        selectedVersionIdRef.current = null;
      } else {
        await openVersion(preferred.id);
      }
    },
    [workId, chapterId, openVersion],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const [nextWork, nextDetail, nextVersions] = await Promise.all([
        fetchWork(workId),
        fetchChapter(workId, chapterId),
        fetchChapterVersions(workId, chapterId),
      ]);
      setWork(nextWork);
      setDetail(nextDetail);
      setVersions(nextVersions);
      if (!targetInitialized.current) {
        // 作品的目标字数可能超出生成表单允许的区间（例如 1200 或 6000），
        // 表单默认值必须先收敛到合法范围，页面上仍展示作品的原始目标。
        setTargetWords(String(clampChapterTargetWords(nextWork.targetWordsPerChapter)));
        targetInitialized.current = true;
      }
      setLoadError('');
      void refreshSession();
      if (nextVersions[0] !== undefined) {
        await openVersion(nextVersions[0].id);
      }
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setLoadError(
        caught instanceof ApiError && caught.code === 'NOT_FOUND'
          ? '章节不存在，或不属于当前账号。'
          : messageOf(caught),
      );
    } finally {
      setLoading(false);
    }
  }, [workId, chapterId, openVersion, refreshSession, router]);

  useEffect(() => {
    if (state.status === 'ready') {
      void load();
    }
  }, [state.status, load]);

  /* ----------------------------- 轮询 ----------------------------- */
  const latestTask = detail?.latestTask ?? null;
  // 采纳提示优先于生成提示；生成提示完全由任务状态推导，不保留提交时的旧文案。
  const notice: WorkbenchNotice | null =
    adoptionNotice === '' ? generationNotice(latestTask) : { text: adoptionNotice, tone: 'ok' };

  useEffect(() => {
    if (latestTask === null || !shouldPollTask(latestTask.status)) {
      return;
    }
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (): void => {
      if (disposed || document.visibilityState === 'hidden') {
        return;
      }
      timer = setTimeout(() => {
        void poll();
      }, pollDelayRef.current);
    };

    const poll = async (): Promise<void> => {
      if (disposed || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const latest = await fetchGenerationTask(workId, latestTask.id);
        if (disposed) {
          return;
        }
        setDetail((previous) =>
          previous === null ? previous : { ...previous, latestTask: latest },
        );
        if (isTerminalTaskStatus(latest.status)) {
          // 终态后允许下一次生成使用新的 requestId
          requestIdRef.current = null;
          try {
            await refreshDetailAndVersions();
          } catch (caught) {
            if (!disposed) {
              handleSessionError(caught, router);
            }
          }
          return;
        }
        pollDelayRef.current = nextPollDelay(pollDelayRef.current);
        schedule();
      } catch (caught) {
        if (disposed) {
          return;
        }
        if (handleSessionError(caught, router)) {
          return;
        }
        // 网络抖动：继续轮询，但退避到最大 5 秒
        pollDelayRef.current = nextPollDelay(pollDelayRef.current);
        schedule();
      } finally {
        inFlight = false;
      }
    };

    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      void poll();
    };

    schedule();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [latestTask?.id, latestTask?.status, workId, router, refreshDetailAndVersions]);

  /* ----------------------------- 生成 ----------------------------- */
  async function handleGenerate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (generating || (latestTask !== null && shouldPollTask(latestTask.status))) {
      return;
    }
    const words = Number(targetWords);
    if (
      !Number.isInteger(words) ||
      words < MIN_CHAPTER_TARGET_WORDS ||
      words > MAX_CHAPTER_TARGET_WORDS
    ) {
      setGenerateError(
        `目标字数必须是 ${MIN_CHAPTER_TARGET_WORDS}..${MAX_CHAPTER_TARGET_WORDS} 的整数`,
      );
      return;
    }

    const style: { tone?: string; pointOfView?: string; pacing?: string } = {};
    if (tone.trim() !== '') {
      style.tone = tone.trim();
    }
    if (pointOfView.trim() !== '') {
      style.pointOfView = pointOfView.trim();
    }
    if (pacing.trim() !== '') {
      style.pacing = pacing.trim();
    }
    const formKey = JSON.stringify({ words, style });
    if (requestIdRef.current === null || requestIdRef.current.key !== formKey) {
      requestIdRef.current = { key: formKey, id: crypto.randomUUID() };
    }

    setGenerating(true);
    setGenerateError('');
    setCancelError('');
    setAdoptionNotice('');
    try {
      const task = await startChapterGeneration(workId, chapterId, {
        requestId: requestIdRef.current.id,
        targetWords: words,
        ...(Object.keys(style).length === 0 ? {} : { style }),
      });
      setDetail((previous) => (previous === null ? previous : { ...previous, latestTask: task }));
      pollDelayRef.current = 1_000;
      void refreshSession();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      if (caught instanceof ApiError && caught.code === 'TASK_REQUEST_CONFLICT') {
        // 同键异内容：换一个新的 requestId，下一次点击重新提交
        requestIdRef.current = null;
      }
      setGenerateError(messageOf(caught));
    } finally {
      setGenerating(false);
    }
  }

  async function handleCancel(): Promise<void> {
    if (latestTask === null || cancelling) {
      return;
    }
    setCancelling(true);
    setCancelError('');
    try {
      const task = await cancelGenerationTask(workId, latestTask.id);
      // 取消成功后立刻作废幂等键：即使服务端仍返回 processing + cancelRequestedAt，
      // 下一次生成也必须使用新的 requestId，否则会命中旧任务而永远看到 cancelled。
      requestIdRef.current = null;
      pollDelayRef.current = 1_000;
      setDetail((previous) => (previous === null ? previous : { ...previous, latestTask: task }));
      await refreshDetailAndVersions();
      void refreshSession();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setCancelError(messageOf(caught));
    } finally {
      setCancelling(false);
    }
  }

  /* ----------------------------- 候选 ----------------------------- */
  async function openCandidate(candidateId: string): Promise<void> {
    if (candidateLoadingId !== null) {
      return;
    }
    setCandidateLoadingId(candidateId);
    setCandidateError('');
    try {
      const candidate = await fetchChapterCandidate(workId, chapterId, candidateId);
      setSelectedCandidate(candidate);
      void refreshSession();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setCandidateError(messageOf(caught));
    } finally {
      setCandidateLoadingId(null);
    }
  }

  async function confirmAdopt(): Promise<void> {
    if (adoptTargetId === null || adopting) {
      return;
    }
    setAdopting(true);
    setAdoptError('');
    try {
      const adopted = await adoptChapterCandidate(workId, chapterId, adoptTargetId);
      setAdoptTargetId(null);
      setAdoptionNotice(
        adopted.deduplicated
          ? `正式版本 ${adopted.versionNo} 已存在`
          : `已生成正式版本 ${adopted.versionNo}`,
      );
      await refreshDetailAndVersions({ selectLatest: true });
      // 候选状态可能已变为 adopted：重新读取当前预览
      if (selectedCandidate?.id === adoptTargetId) {
        try {
          setSelectedCandidate(await fetchChapterCandidate(workId, chapterId, adoptTargetId));
        } catch {
          // 状态刷新失败不覆盖采纳成功提示
        }
      }
      void refreshSession();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setAdoptError(messageOf(caught));
    } finally {
      setAdopting(false);
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

  const generatable = detail === null ? false : canGenerateChapter(detail.chapter.status);
  const taskActive = latestTask !== null && shouldPollTask(latestTask.status);
  const plan = selectedCandidate === null ? null : displayPlan(selectedCandidate.structuredPlan);
  const adoptCandidate =
    detail?.candidates.find((candidate) => candidate.id === adoptTargetId) ?? null;

  return (
    <main className="page">
      <div className="toolbar">
        <div>
          <Link
            href={`/works/${workId}/chapters`}
            className="back-link"
            data-testid="back-to-chapters"
          >
            ← 返回章节列表
          </Link>
          <h1 data-testid="chapter-heading">
            {detail === null
              ? '章节'
              : `第 ${detail.chapter.chapterNo} 章 · ${detail.chapter.title}`}
          </h1>
          <p className="subtitle" data-testid="workbench-work-title">
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
          <p className="alert alert--error" role="alert" data-testid="chapter-load-error">
            {loadError}
          </p>
          <Link href={`/works/${workId}/chapters`} className="btn-secondary">
            返回章节列表
          </Link>
        </div>
      )}

      {loading ? (
        <p className="hint" role="status">
          正在加载章节…
        </p>
      ) : null}

      {notice === null ? null : (
        <p
          className={notice.tone === 'ok' ? 'alert alert--ok' : 'alert alert--warn'}
          role="status"
          data-testid="workbench-notice"
        >
          {notice.text}
        </p>
      )}

      {detail === null || loadError !== '' ? null : (
        <>
          <div className="card">
            <div className="status-row">
              <h2>章节状态</h2>
              <span className="badge" data-testid="chapter-status">
                {chapterStatusLabel(detail.chapter.status)}
              </span>
            </div>
            <dl className="kv">
              <dt>章号</dt>
              <dd>{detail.chapter.chapterNo}</dd>
              <dt>标题</dt>
              <dd>{detail.chapter.title}</dd>
              <dt>单章目标字数</dt>
              <dd data-testid="chapter-target-words">{work?.targetWordsPerChapter ?? '—'}</dd>
            </dl>
          </div>

          <div className="card">
            <h2>生成</h2>
            <p className="hint" data-testid="task-progress">
              {taskProgressLabel(latestTask)}
            </p>
            {latestTask === null ? null : (
              <p className="hint">
                任务状态：{taskStatusLabel(latestTask.status)} · 尝试 {latestTask.attemptCount}/
                {latestTask.maxAttempts}
                {latestTask.currentStep === null
                  ? ''
                  : ` · ${
                      taskStepLabelForStatus(latestTask.currentStep, latestTask.status) ??
                      latestTask.currentStep
                    }`}
              </p>
            )}

            {latestTask?.status === 'failed' ? (
              <p className="alert alert--error" role="alert" data-testid="task-error">
                {latestTask.errorCode ?? 'TASK_FAILED'}
                {latestTask.errorMessage === null ? '' : `：${latestTask.errorMessage}`}
              </p>
            ) : null}

            {taskActive ? (
              <div className="row-actions">
                <button
                  type="button"
                  className="btn-danger btn-small"
                  onClick={() => void handleCancel()}
                  disabled={cancelling}
                  aria-busy={cancelling}
                  data-testid="task-cancel"
                >
                  {cancelling ? '取消中…' : '取消生成'}
                </button>
              </div>
            ) : null}
            {cancelError === '' ? null : (
              <p className="alert alert--error" role="alert" data-testid="cancel-error">
                {cancelError}
              </p>
            )}

            {generatable ? (
              <form onSubmit={(event) => void handleGenerate(event)}>
                <div className="field">
                  <label htmlFor="generate-target-words">目标字数（2500–4000）</label>
                  <input
                    id="generate-target-words"
                    type="number"
                    min={MIN_CHAPTER_TARGET_WORDS}
                    max={MAX_CHAPTER_TARGET_WORDS}
                    step={100}
                    value={targetWords}
                    onChange={(event) => setTargetWords(event.target.value)}
                    data-testid="generate-target-words"
                  />
                </div>
                <div className="chapter-form">
                  <div className="field">
                    <label htmlFor="generate-tone">语气（可选）</label>
                    <input
                      id="generate-tone"
                      type="text"
                      maxLength={100}
                      value={tone}
                      onChange={(event) => setTone(event.target.value)}
                      placeholder="例如：克制"
                      data-testid="generate-tone"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="generate-pov">视角（可选）</label>
                    <input
                      id="generate-pov"
                      type="text"
                      maxLength={100}
                      value={pointOfView}
                      onChange={(event) => setPointOfView(event.target.value)}
                      placeholder="例如：第三人称限知"
                      data-testid="generate-poi"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="generate-pacing">节奏（可选）</label>
                    <input
                      id="generate-pacing"
                      type="text"
                      maxLength={100}
                      value={pacing}
                      onChange={(event) => setPacing(event.target.value)}
                      placeholder="例如：中速"
                      data-testid="generate-pacing"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={generating || taskActive}
                  aria-busy={generating}
                  data-testid="generate-submit"
                >
                  {generating ? '提交中…' : taskActive ? '生成中…' : '提交生成'}
                </button>
              </form>
            ) : (
              <p className="alert alert--error" data-testid="chapter-closed-hint">
                章节已定稿或已废弃，不能继续生成候选。
              </p>
            )}

            {generateError === '' ? null : (
              <p className="alert alert--error" role="alert" data-testid="generate-error">
                {generateError}
              </p>
            )}
          </div>

          <div className="card">
            <h2>候选</h2>
            {detail.candidates.length === 0 ? (
              <p className="hint" data-testid="candidates-empty">
                还没有候选。提交生成后，Worker 完成时会出现在这里。
              </p>
            ) : (
              <ul className="chapter-list" data-testid="candidate-list">
                {detail.candidates.map((candidate) => (
                  <li className="chapter-item" key={candidate.id} data-testid="candidate-item">
                    <div className="chapter-item__main">
                      <h3>
                        {candidate.status === 'adopted' ? '已采纳' : '待采纳'} ·{' '}
                        {candidate.wordCount} 字
                      </h3>
                      <p className="hint">生成时间：{formatDateTime(candidate.createdAt)}</p>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      onClick={() => void openCandidate(candidate.id)}
                      disabled={candidateLoadingId !== null}
                      data-testid="candidate-preview"
                    >
                      {candidateLoadingId === candidate.id ? '读取中…' : '预览'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {candidateError === '' ? null : (
              <p className="alert alert--error" role="alert" data-testid="candidate-error">
                {candidateError}
              </p>
            )}
          </div>

          {selectedCandidate === null ? null : (
            <div className="card" data-testid="candidate-panel">
              <div className="status-row">
                <h2>候选正文</h2>
                <span className="badge" data-testid="candidate-status">
                  {selectedCandidate.status === 'adopted' ? '已采纳' : '待采纳'}
                </span>
              </div>
              <dl className="kv">
                <dt>字数</dt>
                <dd data-testid="candidate-word-count">{selectedCandidate.wordCount}</dd>
                <dt>生成时间</dt>
                <dd data-testid="candidate-created-at">
                  {formatDateTime(selectedCandidate.createdAt)}
                </dd>
              </dl>

              {plan === null ? (
                <p className="hint">结构化计划不可用。</p>
              ) : (
                <details className="plan" data-testid="candidate-plan">
                  <summary>结构化计划</summary>
                  <p>
                    <strong>目标：</strong>
                    {plan.goal}
                  </p>
                  <p>
                    <strong>必须包含：</strong>
                    {plan.mustInclude.length === 0 ? '（未指定）' : plan.mustInclude.join('、')}
                  </p>
                  {plan.scenes.length === 0 ? null : (
                    <ol>
                      {plan.scenes.map((scene, index) => (
                        <li key={`${String(index)}:${scene.purpose}`}>
                          {scene.purpose}｜{scene.location}｜{scene.conflict}｜{scene.outcome}
                        </li>
                      ))}
                    </ol>
                  )}
                </details>
              )}

              <pre className="chapter-text" data-testid="candidate-content">
                {selectedCandidate.content}
              </pre>

              {selectedCandidate.status === 'candidate' ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    setAdoptError('');
                    setAdoptTargetId(selectedCandidate.id);
                  }}
                  data-testid="candidate-adopt"
                >
                  采纳为正式版本
                </button>
              ) : null}
              {adoptError === '' ? null : (
                <p className="alert alert--error" role="alert" data-testid="adopt-error">
                  {adoptError}
                </p>
              )}
            </div>
          )}

          <div className="card">
            <h2>正式版本</h2>
            {versions.length === 0 ? (
              <p className="hint" data-testid="versions-empty">
                还没有正式版本。采纳候选后会生成版本 1。
              </p>
            ) : (
              <ul className="version-list" data-testid="version-list">
                {versions.map((version) => (
                  <li key={version.id}>
                    <button
                      type="button"
                      className={
                        selectedVersion?.id === version.id
                          ? 'version-item version-item--active'
                          : 'version-item'
                      }
                      onClick={() => void openVersion(version.id)}
                      data-testid="version-item"
                    >
                      <span>版本 {version.versionNo}</span>
                      <span className="hint">
                        {versionSourceLabel(version.source)} · {version.wordCount} 字 ·{' '}
                        {formatDateTime(version.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {selectedVersion === null ? null : (
              <div data-testid="version-reader">
                <div className="status-row">
                  <h3>版本 {selectedVersion.versionNo}</h3>
                  <span className="badge badge--ok" data-testid="version-source">
                    {versionSourceLabel(selectedVersion.source)}
                  </span>
                </div>
                <p className="hint" data-testid="version-meta">
                  {selectedVersion.wordCount} 字 · 创建于{' '}
                  {formatDateTime(selectedVersion.createdAt)}
                </p>
                {versionLoading ? (
                  <p className="hint" role="status">
                    正在读取正文…
                  </p>
                ) : (
                  <pre className="chapter-text" data-testid="version-content">
                    {selectedVersion.content}
                  </pre>
                )}
                <p className="hint">人工编辑将在下一阶段开放。</p>
              </div>
            )}
          </div>
        </>
      )}

      {adoptTargetId === null ? null : (
        <ConfirmDialog
          title="采纳候选"
          message={`确认把该候选（${adoptCandidate?.wordCount ?? 0} 字）采纳为正式版本？采纳后章节会进入待定稿状态。`}
          confirmLabel={adopting ? '采纳中…' : '确认采纳'}
          busy={adopting}
          onConfirm={() => void confirmAdopt()}
          onCancel={() => {
            if (!adopting) {
              setAdoptTargetId(null);
            }
          }}
        />
      )}
    </main>
  );
}
