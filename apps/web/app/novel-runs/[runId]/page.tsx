'use client';

/**
 * 动态问答页（C1-A）。
 *
 * 行为边界：
 * - 轮询节奏 1s → 2s → 5s；页面隐藏时暂停，重新可见时立即刷新并重置退避；
 * - 单调序号 + AbortController：旧响应晚返回不得覆盖新状态；
 * - 回答提交使用 `version` 乐观并发：409 只提示并重新拉取，不用本地输入覆盖服务端状态；
 * - 问题 / 选项 / 说明全部按纯文本渲染，不使用 `dangerouslySetInnerHTML`；
 * - 不把目标、回答、runId 之外的内部字段写入 URL / localStorage。
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import {
  ApiError,
  cancelNovelRun,
  fetchNovelRun,
  formatDateTime,
  messageOf,
  submitNovelRunAnswer,
  type NovelRunView,
} from '@/lib/api';
import {
  canCancelNovelRun,
  isPageHidden,
  isTerminalNovelStatus,
  nextNovelPollDelay,
  novelStatusLabel,
  novelStatusNotice,
  shouldPollNovelRun,
} from '@/lib/novel-run-view';
import { handleSessionError } from '@/lib/session-errors';
import { useRequireSession } from '@/lib/use-session';

const MAX_ANSWER_LENGTH = 2000;

export default function NovelRunPage(): React.ReactElement {
  const router = useRouter();
  const params = useParams<{ runId: string }>();
  const runId = params.runId;
  const { state } = useRequireSession({ role: 'author' });

  const [run, setRun] = useState<NovelRunView | null>(null);
  const [loadError, setLoadError] = useState('');
  /** 回答提交成功后自增：重启轮询循环（等待 Worker 接手）。 */
  const [pollNonce, setPollNonce] = useState(0);

  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [notice, setNotice] = useState('');
  const submitInFlightRef = useRef(false);

  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const cancelInFlightRef = useRef(false);

  useEffect(() => {
    if (state.status !== 'ready') {
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let attempt = 0;
    let seq = 0;

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleNext = (): void => {
      // 隐藏时不排新 timer：恢复可见由 visibilitychange 立即补一次并重置退避。
      if (isPageHidden()) {
        return;
      }
      timer = setTimeout(() => {
        attempt += 1;
        void tick();
      }, nextNovelPollDelay(attempt));
    };

    const tick = async (): Promise<void> => {
      clearTimer();
      // 初始 tick 与每次 timer 触发前都检查可见性；隐藏时不发起请求。
      if (isPageHidden()) {
        return;
      }
      controller?.abort();
      const current = ++seq;
      controller = new AbortController();
      try {
        const view = await fetchNovelRun(runId, { signal: controller.signal });
        if (disposed || current !== seq) {
          return;
        }
        setRun(view);
        setLoadError('');
        if (shouldPollNovelRun(view.status)) {
          scheduleNext();
        }
      } catch (error) {
        if (disposed || current !== seq) {
          return;
        }
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }
        if (handleSessionError(error, router)) {
          return;
        }
        setLoadError(messageOf(error));
        scheduleNext();
      }
    };

    const onVisibility = (): void => {
      if (isPageHidden()) {
        clearTimer();
        return;
      }
      // 恢复可见：立即拉取一次，并重置 1s → 2s → 5s 退避。
      attempt = 0;
      void tick();
    };

    void tick();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      seq += 1;
      controller?.abort();
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [state.status, runId, pollNonce, router]);

  const handleSubmit = async (): Promise<void> => {
    if (run === null || submitting || submitInFlightRef.current) {
      return;
    }
    const text = answer.trim();
    if (text === '') {
      setSubmitError('请先填写回答');
      return;
    }
    if (text.length > MAX_ANSWER_LENGTH) {
      setSubmitError(`回答不能超过 ${MAX_ANSWER_LENGTH} 个字符`);
      return;
    }

    submitInFlightRef.current = true;
    setSubmitting(true);
    setSubmitError('');
    try {
      const view = await submitNovelRunAnswer(runId, {
        expectedVersion: run.version,
        answer: text,
      });
      setRun(view);
      setAnswer('');
      setNotice('回答已提交，等待 Coordinator 处理。');
      setPollNonce((value) => value + 1);
    } catch (error) {
      if (handleSessionError(error, router)) {
        return;
      }
      if (
        error instanceof ApiError &&
        (error.code === 'NOVEL_RUN_VERSION_CONFLICT' ||
          error.code === 'NOVEL_RUN_ANSWER_CONFLICT' ||
          error.code === 'NOVEL_RUN_INVALID_STATE')
      ) {
        // 冲突不覆盖当前状态：重新拉取服务端版本，由服务端成为唯一事实源。
        setSubmitError(messageOf(error));
        setPollNonce((value) => value + 1);
      } else {
        setSubmitError(messageOf(error));
      }
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const handleCancel = async (): Promise<void> => {
    if (run === null || cancelling || cancelInFlightRef.current) {
      return;
    }
    cancelInFlightRef.current = true;
    setCancelling(true);
    setCancelError('');
    try {
      const view = await cancelNovelRun(runId);
      setRun(view);
      setNotice('已取消本轮创作准备。');
      setPollNonce((value) => value + 1);
    } catch (error) {
      if (handleSessionError(error, router)) {
        return;
      }
      setCancelError(messageOf(error));
    } finally {
      cancelInFlightRef.current = false;
      setCancelling(false);
    }
  };

  if (state.status === 'loading') {
    return (
      <main className="page">
        <p className="hint" role="status">
          正在加载…
        </p>
      </main>
    );
  }

  const waiting = run !== null && run.status === 'waiting_user';
  const terminal = run !== null && isTerminalNovelStatus(run.status);
  const canCancel = run !== null && canCancelNovelRun(run.status);

  return (
    <main className="page">
      <div className="toolbar">
        <div>
          <Link href="/workspace" className="back-link" data-testid="back-to-workspace">
            ← 返回工作台
          </Link>
          <h1 data-testid="novel-run-heading">写新小说</h1>
          <p className="subtitle" data-testid="novel-run-status">
            {run === null ? '' : novelStatusLabel(run.status)}
          </p>
        </div>
        {canCancel ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              void handleCancel();
            }}
            disabled={cancelling}
            data-testid="novel-cancel"
          >
            {cancelling ? '取消中…' : '取消本轮'}
          </button>
        ) : null}
      </div>

      {loadError === '' ? null : (
        <p className="error" role="alert" data-testid="novel-load-error">
          {loadError}
        </p>
      )}
      {cancelError === '' ? null : (
        <p className="error" role="alert" data-testid="novel-cancel-error">
          {cancelError}
        </p>
      )}
      {notice === '' ? null : (
        <p className="hint" role="status" data-testid="novel-notice">
          {notice}
        </p>
      )}

      {run === null ? null : (
        <>
          <div className="card" data-testid="novel-goal-card">
            <h2>当前目标</h2>
            <p data-testid="novel-current-goal">{run.currentGoal}</p>
            {run.decisionSummary === '' ? null : (
              <p className="hint" data-testid="novel-decision-summary">
                {run.decisionSummary}
              </p>
            )}
            <p className="hint">
              已进行 {run.stepCount} 步 · 更新于 {formatDateTime(run.updatedAt)}
            </p>
            <p className="hint">{novelStatusNotice(run.status)}</p>
          </div>

          {waiting ? (
            <div className="card" data-testid="novel-question-card">
              <h2>需要你的回答</h2>
              <p data-testid="novel-question" style={{ whiteSpace: 'pre-wrap' }}>
                {run.question ?? ''}
              </p>
              {run.options.length === 0 ? null : (
                <div className="toolbar" data-testid="novel-options">
                  {run.options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        setAnswer(option);
                        setSubmitError('');
                      }}
                      disabled={submitting}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}
              <label className="hint" htmlFor="novel-answer">
                你的回答（纯文本）
              </label>
              <textarea
                id="novel-answer"
                className="input"
                rows={4}
                maxLength={MAX_ANSWER_LENGTH}
                value={answer}
                onChange={(event) => {
                  setAnswer(event.target.value);
                  setSubmitError('');
                }}
                disabled={submitting}
                data-testid="novel-answer"
              />
              {submitError === '' ? null : (
                <p className="error" role="alert" data-testid="novel-submit-error">
                  {submitError}
                </p>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void handleSubmit();
                }}
                disabled={submitting || answer.trim() === ''}
                data-testid="novel-submit"
              >
                {submitting ? '提交中…' : '提交回答'}
              </button>
            </div>
          ) : null}

          {run.status === 'queued' || run.status === 'running' ? (
            <p className="hint" role="status" data-testid="novel-progress">
              {novelStatusNotice(run.status)}
            </p>
          ) : null}

          {terminal ? (
            <div className="card" data-testid="novel-terminal-card">
              <h2>{novelStatusLabel(run.status)}</h2>
              <p>{novelStatusNotice(run.status)}</p>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
