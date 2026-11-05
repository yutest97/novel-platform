'use client';

/**
 * 章节工作台（A1-4A / A1-4B-B / A1-4B-C）。
 *
 * 作者在这里完成：提交生成 → 查看进度/取消 → 预览候选 → 采纳 → 阅读正式正文
 * → 手工编辑 Markdown 并保存为新的 human 版本 → 对比版本差异 / 恢复历史版本 → 定稿。
 *
 * 边界：
 * - 只读正文用 `pre-wrap` 纯文本渲染，Markdown 编辑器是 textarea，
 *   全程不使用 `dangerouslySetInnerHTML`，不渲染任何用户输入的 HTML；
 * - 候选正文只在点击某个候选后才请求，避免一次加载所有长文；
 * - requestId 只存在组件内存（useRef），同一内容重复点击复用同一个 id；
 *   任务进入终态或**取消成功**后立即作废，下一次生成必定换新 id；
 * - 编辑草稿只存在组件内存：不写 URL / localStorage / sessionStorage，
 *   有未保存修改时取消需二次确认，离开页面有 beforeunload 提示；
 * - 只允许编辑**最新**正式版本：旧版本只读，不能把旧版本 id 当作 baseVersionId；
 * - 版本对比只读、按需展开；历史版本恢复只新增版本，不修改 / 删除旧版本；
 * - 定稿只锁定当前最新正式版本；定稿后生成 / 采纳 / 恢复被拒绝，
 *   人工保存 revision 会回到待定稿，需要重新定稿；
 * - 仍不提供撤销定稿与版本删除。
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
  fetchChapterVersionDiff,
  fetchChapterVersions,
  fetchGenerationTask,
  fetchWork,
  finalizeChapter,
  formatDateTime,
  messageOf,
  restoreChapterVersion,
  saveHumanChapterVersion,
  startChapterGeneration,
  type ChapterCandidateDetail,
  type ChapterDetail,
  type ChapterVersionDetail,
  type ChapterVersionDiff,
  type ChapterVersionListItem,
  type WorkDetail,
} from '@/lib/api';
import {
  defaultDiffSelection,
  diffLineClass,
  diffLineLabel,
  diffStatsLabel,
  diffVersionLabel,
  isIdenticalDiff,
  lineNoPlaceholder,
  restoreConfirmMessage,
  restoredNotice,
} from '@/lib/chapter-diff-view';
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
import {
  MAX_HUMAN_CONTENT_CHARS,
  canEditSelectedVersion,
  draftMetrics,
  editorErrorNotice,
  editorMetricsLabel,
  editorTarget,
  SENTINEL_STATE_KEY,
  backStepsToLeave,
  hasEarlierEntry,
  isDraftDirty,
  leaveConfirmLabel,
  leaveConfirmMessage,
  needsReloadConfirmation,
  pendingLeaveFor,
  sentinelTransition,
  type EditorErrorNotice,
  type LeaveKind,
  type PendingLeave,
} from '@/lib/chapter-editor';
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
  const [actionNotice, setActionNotice] = useState('');

  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');

  const [selectedCandidate, setSelectedCandidate] = useState<ChapterCandidateDetail | null>(null);
  const [candidateLoadingId, setCandidateLoadingId] = useState<string | null>(null);
  const [candidateError, setCandidateError] = useState('');

  const [adoptTargetId, setAdoptTargetId] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState('');

  // 人工编辑器（A1-4B-B）：草稿只存在组件内存，不写 URL / localStorage / sessionStorage。
  const [editor, setEditor] = useState<{
    readonly baseVersionId: string | null;
    readonly baseline: string;
    readonly versionNo: number | null;
  } | null>(null);
  const [draft, setDraft] = useState('');
  const [savingVersion, setSavingVersion] = useState(false);
  const [editorError, setEditorError] = useState<EditorErrorNotice | null>(null);
  const [closingEditor, setClosingEditor] = useState(false);
  const [reloadingLatest, setReloadingLatest] = useState(false);
  // 应用内离开保护：Link / 浏览器后退 / 退出登录都不会触发 beforeunload。
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  /** 当前是否压着后退哨兵（0 / 1）。释放必须抵消这次 pushState。 */
  const sentinelRef = useRef(0);
  /** 压哨兵**之前**的历史条目数：用来判断前面还有没有真实页面可退。 */
  const baseHistoryLengthRef = useRef(0);
  /** 当前的 popstate 监听（释放哨兵时先摘掉，避免自己拦自己）。 */
  const guardListenerRef = useRef<(() => void) | null>(null);
  /** 已确认的离开正在执行：期间任何 popstate 都不再弹窗。 */
  const leavingRef = useRef(false);

  // 版本对比（A1-4B-C-B）：默认折叠，展开后才请求 diff；只读，不改选中版本 / 编辑器。
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareFromId, setCompareFromId] = useState('');
  const [compareToId, setCompareToId] = useState('');
  const [compareDiff, setCompareDiff] = useState<ChapterVersionDiff | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<ApiError | null>(null);
  /**
   * diff 请求的单调序号（请求身份）。
   *
   * 选择器组合**不是**请求身份：收起后再展开会产生完全相同的 from/to，
   * 仅靠它无法区分"相同选择器的旧请求"和"当前请求"。
   * 每次展开 / 切换 / 收起都自增，只有拿到最新序号的那次请求可以落盘；
   * 旧请求（哪怕先发后到）必须完全静默，也不能提前关闭 loading。
   */
  const compareRequestSeqRef = useRef(0);
  // 历史版本恢复（A1-4B-C-B）
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<ApiError | null>(null);
  // 章节定稿（A1-4B-C-C）
  const [finalizeConfirmOpen, setFinalizeConfirmOpen] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<ApiError | null>(null);

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
        // 换版本后，上一条恢复 / 定稿错误不再对应当前选择。
        setRestoreError(null);
        setFinalizeError(null);
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

  /**
   * 开始一次新的 diff 请求：自增序号，使所有在途请求立即失效。
   *
   * 返回的 token 是这次请求的**唯一身份**，只有它能在响应 / 异常 / finally 中落地。
   */
  const beginCompareRequest = useCallback((): number => {
    compareRequestSeqRef.current += 1;
    return compareRequestSeqRef.current;
  }, []);

  /**
   * 请求一次 diff（`token` 由 `beginCompareRequest` 分配）。
   *
   * - 请求前立即清空旧结果：切换选择器时绝不显示上一次的过期 diff；
   * - 响应 / 错误 / finally 都先比对 token：不是当前请求就**完全静默**
   *   —— 不写 diff、不写 error、不关闭 loading、不改选择器；
   * - 会话错误只在当前请求上处理；旧请求的 401 不触发跳转。
   */
  const loadDiff = useCallback(
    async (token: number, fromId: string, toId: string): Promise<void> => {
      if (fromId === '' || toId === '') {
        return;
      }
      if (token !== compareRequestSeqRef.current) {
        return;
      }
      setCompareLoading(true);
      setCompareError(null);
      setCompareDiff(null);
      try {
        const diff = await fetchChapterVersionDiff(workId, chapterId, fromId, toId);
        if (token !== compareRequestSeqRef.current) {
          return;
        }
        setCompareDiff(diff);
      } catch (caught) {
        if (token !== compareRequestSeqRef.current) {
          return;
        }
        if (handleSessionError(caught, router)) {
          return;
        }
        setCompareError(caught instanceof ApiError ? caught : new ApiError('INTERNAL_ERROR', 500));
      } finally {
        // 只有当前请求可以关闭 loading：旧请求的 finally 不能提前结束新请求的加载态。
        if (token === compareRequestSeqRef.current) {
          setCompareLoading(false);
        }
      }
    },
    [workId, chapterId, router],
  );

  /** 展开对比面板：此时才发第一次请求（页面加载不预取 diff）。 */
  const openCompare = useCallback((): void => {
    const selection = defaultDiffSelection(versions);
    if (selection === null) {
      return;
    }
    const token = beginCompareRequest();
    setCompareOpen(true);
    setCompareFromId(selection.fromVersionId);
    setCompareToId(selection.toVersionId);
    void loadDiff(token, selection.fromVersionId, selection.toVersionId);
  }, [versions, beginCompareRequest, loadDiff]);

  const closeCompare = useCallback((): void => {
    // 收起同样使在途请求失效：迟到的响应不能把面板重新点亮。
    beginCompareRequest();
    setCompareOpen(false);
    setCompareDiff(null);
    setCompareError(null);
    setCompareLoading(false);
  }, [beginCompareRequest]);

  const changeCompareFrom = useCallback(
    (value: string): void => {
      const token = beginCompareRequest();
      setCompareFromId(value);
      void loadDiff(token, value, compareToId);
    },
    [compareToId, beginCompareRequest, loadDiff],
  );

  const changeCompareTo = useCallback(
    (value: string): void => {
      const token = beginCompareRequest();
      setCompareToId(value);
      void loadDiff(token, compareFromId, value);
    },
    [compareFromId, beginCompareRequest, loadDiff],
  );

  /** 打开恢复确认（只在选中历史版本时可用）。 */
  const requestRestore = useCallback((): void => {
    if (selectedVersion === null || versions.length < 2) {
      return;
    }
    setRestoreError(null);
    setRestoreConfirmOpen(true);
  }, [selectedVersion, versions.length]);

  /**
   * 确认恢复：基于**当前最大版本**创建新版本。
   *
   * - 成功后关闭对比状态、提示「已从版本 N 恢复为版本 M」、刷新并选中最新版本；
   * - 冲突保留原状态（页面不动），提示 + 「载入最新版本」；
   * - 已是当前最新 → 直接刷新列表，让恢复按钮自然消失。
   */
  const confirmRestore = useCallback(async (): Promise<void> => {
    const source = selectedVersion;
    const latest = versions[0];
    if (source === null || latest === undefined) {
      setRestoreConfirmOpen(false);
      return;
    }
    setRestoring(true);
    setRestoreError(null);
    try {
      const restored = await restoreChapterVersion(workId, chapterId, source.id, {
        baseVersionId: latest.id,
      });
      setRestoreConfirmOpen(false);
      closeCompare();
      setActionNotice(restoredNotice(source.versionNo, restored.versionNo));
      await refreshDetailAndVersions({ selectLatest: true });
    } catch (caught) {
      setRestoreConfirmOpen(false);
      if (handleSessionError(caught, router)) {
        return;
      }
      const apiError = caught instanceof ApiError ? caught : new ApiError('INTERNAL_ERROR', 500);
      setRestoreError(apiError);
      if (apiError.code === 'CHAPTER_VERSION_ALREADY_LATEST') {
        // 页面上的"最新版本"已经变了：刷新列表，恢复入口对最新版本本来就不显示。
        await refreshDetailAndVersions();
      }
    } finally {
      setRestoring(false);
    }
  }, [workId, chapterId, selectedVersion, versions, closeCompare, refreshDetailAndVersions]);

  /** 冲突后「载入最新版本」：刷新列表并选中最新（不覆盖任何历史版本）。 */
  const reloadLatestAfterRestoreConflict = useCallback(async (): Promise<void> => {
    setRestoreError(null);
    await refreshDetailAndVersions({ selectLatest: true });
  }, [refreshDetailAndVersions]);

  /**
   * 打开定稿确认。
   *
   * 定稿只锁定**数据库中的当前最新正式版本**，不包含编辑器里的未保存草稿，
   * 因此以下任一情况都必须拒绝（UI 也会隐藏入口）：
   * - 编辑器打开（无论是否有未保存修改）；
   * - 正在读取其它版本（`versionLoading`）——此时 `selectedVersion` 还是旧值；
   * - 正在恢复历史版本 / 正在保存 / 正在定稿；
   * - 选中的不是最新版本，或章节详情尚未加载完成。
   */
  const requestFinalize = useCallback((): void => {
    const latest = versions[0];
    if (
      detail === null ||
      detail.chapter.status !== 'in_review' ||
      editor !== null ||
      versionLoading ||
      restoring ||
      savingVersion ||
      finalizing ||
      selectedVersion === null ||
      latest === undefined ||
      latest.id !== selectedVersion.id
    ) {
      return;
    }
    setFinalizeError(null);
    setFinalizeConfirmOpen(true);
  }, [
    detail,
    editor,
    versionLoading,
    restoring,
    savingVersion,
    finalizing,
    selectedVersion,
    versions,
  ]);

  /**
   * 确认定稿：锁定当前最新版本。
   *
   * - 成功：提示「章节已定稿，版本 N」、刷新章节与版本、保持选中最新；
   * - 版本冲突：保留页面状态 + 「载入最新版本」；
   * - 状态不允许：稳定提示并刷新章节状态（可能已被其它操作改变）。
   */
  const confirmFinalize = useCallback(async (): Promise<void> => {
    const latest = versions[0];
    if (latest === undefined) {
      setFinalizeConfirmOpen(false);
      return;
    }
    setFinalizing(true);
    setFinalizeError(null);
    try {
      const result = await finalizeChapter(workId, chapterId, latest.id);
      setFinalizeConfirmOpen(false);
      setActionNotice(`章节已定稿，版本 ${result.versionNo}`);
      await refreshDetailAndVersions({ selectLatest: true });
    } catch (caught) {
      setFinalizeConfirmOpen(false);
      if (handleSessionError(caught, router)) {
        return;
      }
      const apiError = caught instanceof ApiError ? caught : new ApiError('INTERNAL_ERROR', 500);
      setFinalizeError(apiError);
      if (apiError.code === 'CHAPTER_STATE_INVALID_FOR_FINALIZE') {
        // 状态已被其它操作改变：把最新的章节状态拉回来，按钮按新状态显示。
        await refreshDetailAndVersions();
      }
    } finally {
      setFinalizing(false);
    }
  }, [workId, chapterId, versions, refreshDetailAndVersions]);

  /** 定稿冲突后「载入最新版本」：刷新列表并选中最新（不覆盖任何版本）。 */
  const reloadLatestAfterFinalizeConflict = useCallback(async (): Promise<void> => {
    setFinalizeError(null);
    await refreshDetailAndVersions({ selectLatest: true });
  }, [refreshDetailAndVersions]);

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
    actionNotice === '' ? generationNotice(latestTask) : { text: actionNotice, tone: 'ok' };

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

  /* ----------------------------- 人工编辑 ----------------------------- */
  const draftDirty = editor !== null && isDraftDirty(draft, editor.baseline);

  // 有未保存修改时离开页面要提示；草稿本身不落任何存储，刷新即丢失。
  useEffect(() => {
    if (!draftDirty) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // 现代浏览器忽略自定义文案，但仍需要 returnValue 才会弹确认。
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [draftDirty]);

  /** 摘掉后退监听（释放哨兵前必须先摘，否则自己压的 back 会被自己拦住）。 */
  function detachGuard(): void {
    if (guardListenerRef.current !== null) {
      window.removeEventListener('popstate', guardListenerRef.current);
      guardListenerRef.current = null;
    }
  }

  /**
   * 后退哨兵：`beforeunload` 对同文档导航不生效，只能压一条历史记录来拦后退。
   *
   * 生命周期由 `sentinelTransition` 统一定义：
   * - dirty 且未压 → `arm`（pushState）；
   * - dirty 且已压 → `keep`；
   * - **不 dirty 且已压 → `release`**：撤销回原文、载入最新版本后 dirty 归零都在这里兜住。
   *
   * 只移除监听而不释放哨兵，第一次后退会停在同 URL（看起来没反应），
   * 确认离开后还会把哨兵留在历史里，形成重复的章节 URL。
   */
  useEffect(() => {
    const action = sentinelTransition(sentinelRef.current > 0, draftDirty);
    if (action === 'release') {
      releaseSentinel();
    } else if (action === 'arm') {
      // 记录压栈前的条目数：1 表示这是标签页里的第一条，前面没有真实页面。
      baseHistoryLengthRef.current = window.history.length;
      window.history.pushState({ ...window.history.state, [SENTINEL_STATE_KEY]: true }, '');
      sentinelRef.current = 1;
    }
    if (!draftDirty) {
      return;
    }
    const onPopState = (): void => {
      if (leavingRef.current) {
        return;
      }
      // 后退已经发生：先把哨兵补回去，避免直接离开页面
      window.history.pushState({ ...window.history.state, [SENTINEL_STATE_KEY]: true }, '');
      sentinelRef.current = 1;
      setPendingLeave({ kind: 'back', href: null });
    };
    guardListenerRef.current = onPopState;
    window.addEventListener('popstate', onPopState);
    return () => {
      detachGuard();
    };
  }, [draftDirty]);

  /**
   * 消费哨兵：摘掉监听后 back 一次，抵消 arm 时的 pushState。
   *
   * 不猜测"多久之后应该正常"——这里只负责把历史恢复到只有真实页面的状态；
   * 需要"先释放再导航"的场景（确认离开）由 `performLeave` 等 popstate 回调再继续。
   */
  function releaseSentinel(): void {
    if (sentinelRef.current === 0) {
      return;
    }
    sentinelRef.current = 0;
    detachGuard();
    window.history.back();
  }

  /** 执行已经确认过的离开动作（必要时先消费哨兵，再离开）。 */
  function performLeave(pending: PendingLeave): void {
    if (leavingRef.current) {
      return;
    }
    leavingRef.current = true;

    const baseLength = baseHistoryLengthRef.current;
    const go = (armed: boolean): void => {
      if (pending.kind === 'logout') {
        void logoutAndRedirect(router);
        return;
      }
      if (pending.kind === 'navigate') {
        if (pending.href !== null) {
          router.push(pending.href);
        }
        return;
      }
      // 后退：没有更早的真实页面（直接打开链接）就回落章节列表，
      // 否则跨过哨兵（若有）+ 当前页，回到真正的上一页。
      if (!hasEarlierEntry(baseLength)) {
        router.push(`/works/${workId}/chapters`);
        return;
      }
      window.history.go(-backStepsToLeave(armed));
    };

    if (sentinelRef.current === 0) {
      go(false);
      return;
    }

    // 已压哨兵：先 back 一次把它消费掉，等 popstate 确认后再执行真正的离开。
    // 这样 router.push 之后历史里不会再躺着一条同 URL 的哨兵。
    sentinelRef.current = 0;
    baseHistoryLengthRef.current = 0;
    detachGuard();
    let settled = false;
    const afterRelease = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener('popstate', afterRelease);
      go(false);
    };
    window.addEventListener('popstate', afterRelease);
    window.history.back();
    // 兜底：历史被外部替换时不产生 popstate，直接离开而不是卡住。
    window.setTimeout(afterRelease, 300);
  }

  /** 所有应用内离开入口的唯一入口：脏则确认，否则直接离开。 */
  function requestLeave(kind: LeaveKind, href: string | null = null): void {
    const pending = pendingLeaveFor(kind, draftDirty, href);
    if (pending === null) {
      performLeave({ kind, href: kind === 'navigate' ? href : null });
      return;
    }
    setPendingLeave(pending);
  }

  const openEditor = useCallback(async (): Promise<void> => {
    const target = editorTarget(versions);
    setEditorError(null);
    if (target.mode === 'first') {
      setEditor({ baseVersionId: null, baseline: '', versionNo: null });
      setDraft('');
      return;
    }
    const latestId = target.baseVersionId;
    if (latestId === null) {
      return;
    }
    try {
      // 已经打开过最新版本时直接复用，避免重复拉长文。
      const version =
        selectedVersion?.id === latestId
          ? selectedVersion
          : await fetchChapterVersion(workId, chapterId, latestId);
      setSelectedVersion(version);
      selectedVersionIdRef.current = version.id;
      setEditor({
        baseVersionId: latestId,
        baseline: version.content,
        versionNo: version.versionNo,
      });
      setDraft(version.content);
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setLoadError(messageOf(caught));
    }
  }, [versions, selectedVersion, workId, chapterId, router]);

  function requestCloseEditor(): void {
    if (savingVersion) {
      return;
    }
    if (editor !== null && isDraftDirty(draft, editor.baseline)) {
      setClosingEditor(true);
      return;
    }
    setEditor(null);
    setDraft('');
    setEditorError(null);
    releaseSentinel();
  }

  async function handleSaveDraft(): Promise<void> {
    if (editor === null || savingVersion) {
      return;
    }
    // 客户端只做预览校验；字数与正文合法性以服务端为准。
    if (!draftMetrics(draft).canSave) {
      setEditorError({ text: '章节正文不合法，请检查字数和内容', reloadable: false });
      return;
    }
    setSavingVersion(true);
    setEditorError(null);
    try {
      const saved = await saveHumanChapterVersion(workId, chapterId, {
        content: draft,
        baseVersionId: editor.baseVersionId,
      });
      setEditor(null);
      setDraft('');
      setClosingEditor(false);
      // 编辑器已关闭且没有离开页面：清掉后退哨兵
      releaseSentinel();
      setActionNotice(`已保存正式版本 ${saved.versionNo}`);
      await refreshDetailAndVersions({ selectLatest: true });
      void refreshSession();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      // 失败保留草稿：作者写下的内容不能因为一次冲突就丢掉。
      const code = caught instanceof ApiError ? caught.code : '';
      setEditorError(editorErrorNotice(code, messageOf(caught)));
    } finally {
      setSavingVersion(false);
    }
  }

  /** 基线冲突后重新载入最新版本（草稿被替换，需作者确认后手动再改）。 */
  async function handleReloadLatest(): Promise<void> {
    if (reloadingLatest || savingVersion) {
      return;
    }
    setReloadingLatest(true);
    try {
      const nextVersions = await fetchChapterVersions(workId, chapterId);
      setVersions(nextVersions);
      const target = editorTarget(nextVersions);
      if (target.mode === 'first' || target.baseVersionId === null) {
        setEditor({ baseVersionId: null, baseline: '', versionNo: null });
        setDraft('');
        setEditorError(null);
        return;
      }
      const version = await fetchChapterVersion(workId, chapterId, target.baseVersionId);
      setSelectedVersion(version);
      selectedVersionIdRef.current = version.id;
      setEditor({
        baseVersionId: version.id,
        baseline: version.content,
        versionNo: version.versionNo,
      });
      setDraft(version.content);
      setEditorError(null);
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setEditorError({ text: messageOf(caught), reloadable: true });
    } finally {
      setReloadingLatest(false);
    }
  }

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
    setActionNotice('');
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
      setActionNotice(
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
  const latestVersion = versions[0] ?? null;
  const editorMetrics = draftMetrics(draft);
  const canEditCurrentVersion = canEditSelectedVersion(selectedVersion?.id ?? null, versions);
  const editingVersionNo = editor?.versionNo ?? null;

  return (
    <main className="page">
      <div className="toolbar">
        <div>
          <Link
            href={`/works/${workId}/chapters`}
            className="back-link"
            onClick={(event) => {
              // 客户端导航不触发 beforeunload：有未保存草稿时先拦下来确认。
              // 没有修改时交给 Link 自己导航，避免多压一条历史记录。
              if (!draftDirty) {
                return;
              }
              event.preventDefault();
              requestLeave('navigate', `/works/${workId}/chapters`);
            }}
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
          onClick={() => requestLeave('logout')}
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
          <Link
            href={`/works/${workId}/chapters`}
            className="btn-secondary"
            onClick={(event) => {
              if (!draftDirty) {
                return;
              }
              event.preventDefault();
              requestLeave('navigate', `/works/${workId}/chapters`);
            }}
          >
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
                generatable ? (
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
                ) : (
                  <p className="alert alert--error" data-testid="candidate-adopt-closed">
                    章节已定稿或已废弃，不能采纳候选。
                  </p>
                )
              ) : null}
              {adoptError === '' ? null : (
                <p className="alert alert--error" role="alert" data-testid="adopt-error">
                  {adoptError}
                </p>
              )}
            </div>
          )}

          <div className="card">
            <div className="status-row">
              <h2>正式版本</h2>
              {editor !== null ? null : versions.length === 0 ? (
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  onClick={() => void openEditor()}
                  data-testid="editor-open"
                >
                  手动创建第一版
                </button>
              ) : canEditCurrentVersion ? (
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  onClick={() => void openEditor()}
                  data-testid="editor-open"
                >
                  编辑最新版本（版本 {latestVersion?.versionNo ?? ''}）
                </button>
              ) : null}
            </div>
            {versions.length === 0 ? (
              <p className="hint" data-testid="versions-empty">
                还没有正式版本。采纳候选后会生成版本 1，也可以手动创建第一版。
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
                      disabled={editor !== null}
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

            {detail !== null && detail.chapter.status === 'in_review' ? (
              editor !== null ? (
                // 定稿只锁数据库里的最新正式版本，编辑器草稿不在其中：
                // 编辑器打开时既不给按钮，也明确告诉作者该怎么做。
                <p className="hint" data-testid="finalize-editor-hint">
                  请先保存当前正文或关闭编辑器，再定稿。
                </p>
              ) : selectedVersion === null ? null : selectedVersion.id === versions[0]?.id ? (
                // 读取版本期间 `selectedVersion` 还是上一个值：直接不渲染入口，
                // 避免用旧版本信息发起定稿；提交中也不显示（确认弹窗里有进度）。
                versionLoading || finalizing ? null : (
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn-primary btn-small"
                      onClick={requestFinalize}
                      disabled={restoring || savingVersion}
                      data-testid="finalize-open"
                    >
                      定稿最新版本（版本 {selectedVersion.versionNo}）
                    </button>
                  </div>
                )
              ) : versionLoading ? null : (
                <p className="hint" data-testid="finalize-history-hint">
                  定稿仅支持最新版本，请先选择最新版本。
                </p>
              )
            ) : null}

            {finalizeError === null ? null : (
              <div className="alert alert--error" role="alert" data-testid="finalize-error">
                <p>{finalizeError.message}</p>
                {finalizeError.code === 'CHAPTER_VERSION_CONFLICT' ? (
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={() => void reloadLatestAfterFinalizeConflict()}
                    data-testid="finalize-reload-latest"
                  >
                    载入最新版本
                  </button>
                ) : null}
              </div>
            )}

            {versions.length > 0 &&
            !canEditCurrentVersion &&
            editor === null &&
            detail?.chapter.status !== 'finalized' ? (
              <>
                <p className="hint" data-testid="version-readonly-hint">
                  历史版本只读，请先选择最新版本再编辑。
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={() => {
                      const latest = versions[0];
                      if (latest !== undefined) {
                        void openVersion(latest.id);
                      }
                    }}
                    data-testid="version-select-latest"
                  >
                    选择最新版本
                  </button>
                </p>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={requestRestore}
                    disabled={restoring}
                    data-testid="version-restore"
                  >
                    {restoring ? '恢复中…' : '恢复此版本为新版本'}
                  </button>
                </div>
              </>
            ) : null}

            {restoreError === null ? null : (
              <div className="alert alert--error" role="alert" data-testid="restore-error">
                <p>{restoreError.message}</p>
                {restoreError.code === 'CHAPTER_VERSION_CONFLICT' ? (
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={() => void reloadLatestAfterRestoreConflict()}
                    data-testid="restore-reload-latest"
                  >
                    载入最新版本
                  </button>
                ) : null}
              </div>
            )}

            {versions.length > 0 && editor === null ? (
              <div className="row-actions">
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  onClick={compareOpen ? closeCompare : openCompare}
                  aria-expanded={compareOpen}
                  data-testid="compare-toggle"
                >
                  {compareOpen ? '收起版本对比' : '版本对比'}
                </button>
              </div>
            ) : null}

            {!compareOpen || versions.length === 0 ? null : (
              <section className="compare-panel" aria-label="版本对比" data-testid="compare-panel">
                <div className="compare-selectors">
                  <label className="compare-field">
                    <span>起始版本</span>
                    <select
                      value={compareFromId}
                      onChange={(event) => changeCompareFrom(event.target.value)}
                      disabled={compareLoading}
                      data-testid="compare-from"
                    >
                      {versions.map((version) => (
                        <option key={version.id} value={version.id}>
                          版本 {version.versionNo}（{versionSourceLabel(version.source)}）
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="compare-field">
                    <span>目标版本</span>
                    <select
                      value={compareToId}
                      onChange={(event) => changeCompareTo(event.target.value)}
                      disabled={compareLoading}
                      data-testid="compare-to"
                    >
                      {versions.map((version) => (
                        <option key={version.id} value={version.id}>
                          版本 {version.versionNo}（{versionSourceLabel(version.source)}）
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {compareLoading ? (
                  <p className="hint" role="status" data-testid="compare-loading">
                    正在对比…
                  </p>
                ) : null}

                {compareError === null ? null : (
                  <p className="alert alert--error" role="alert" data-testid="compare-error">
                    {compareError.message}
                  </p>
                )}

                {compareDiff === null || compareLoading ? null : (
                  <div data-testid="compare-result">
                    <div className="compare-meta">
                      <span data-testid="compare-from-meta">
                        {diffVersionLabel(compareDiff.fromVersion, versionSourceLabel)}
                      </span>
                      <span aria-hidden="true">→</span>
                      <span data-testid="compare-to-meta">
                        {diffVersionLabel(compareDiff.toVersion, versionSourceLabel)}
                      </span>
                    </div>
                    <p className="hint" data-testid="compare-stats">
                      {diffStatsLabel(compareDiff.stats)}
                    </p>
                    {isIdenticalDiff(compareDiff.stats) ? (
                      <p className="alert alert--ok" data-testid="compare-identical">
                        两个版本内容一致。
                      </p>
                    ) : null}
                    <ol className="diff-view" data-testid="diff-lines">
                      {compareDiff.lines.map((line, index) => (
                        <li
                          key={`${line.kind}-${line.oldLineNo ?? 'x'}-${line.newLineNo ?? 'x'}-${index}`}
                          className={diffLineClass(line.kind)}
                          data-kind={line.kind}
                          data-testid="diff-line"
                        >
                          <span className="diff-line__no" aria-hidden="true">
                            {lineNoPlaceholder(line.oldLineNo)}
                          </span>
                          <span className="diff-line__no" aria-hidden="true">
                            {lineNoPlaceholder(line.newLineNo)}
                          </span>
                          <span className="diff-line__label">{diffLineLabel(line.kind)}</span>
                          <span className="diff-line__text">{line.text}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </section>
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
              </div>
            )}
          </div>

          {editor === null ? null : (
            <div className="card" data-testid="chapter-editor">
              <div className="status-row">
                <h2>
                  {editingVersionNo === null
                    ? '手动创建第一版'
                    : `编辑版本 ${editingVersionNo}（将保存为新版本）`}
                </h2>
                <span className="badge" data-testid="editor-dirty">
                  {draftDirty ? '有未保存修改' : '无修改'}
                </span>
              </div>
              <p className="hint" data-testid="editor-metrics">
                {editorMetricsLabel(editorMetrics)}
              </p>
              <textarea
                className="editor-textarea"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                    event.preventDefault();
                    void handleSaveDraft();
                  }
                }}
                disabled={savingVersion}
                maxLength={MAX_HUMAN_CONTENT_CHARS + 1}
                spellCheck={false}
                aria-label="章节正文（Markdown 纯文本）"
                data-testid="editor-textarea"
              />
              <p className="hint">
                纯文本 Markdown：换行与符号按原样保存，不会渲染 HTML。草稿只存在于本页内存，
                刷新或取消后丢失。
              </p>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void handleSaveDraft()}
                  disabled={savingVersion}
                  aria-busy={savingVersion}
                  data-testid="editor-save"
                >
                  {savingVersion ? '保存中…' : '保存为新的正式版本'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={requestCloseEditor}
                  disabled={savingVersion}
                  data-testid="editor-cancel"
                >
                  取消
                </button>
                {editorError?.reloadable === true ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      // 载入会用最新正文覆盖草稿：有未保存修改时先确认。
                      if (needsReloadConfirmation(draftDirty)) {
                        setReloadConfirm(true);
                        return;
                      }
                      void handleReloadLatest();
                    }}
                    disabled={savingVersion || reloadingLatest}
                    data-testid="editor-reload"
                  >
                    {reloadingLatest ? '载入中…' : '载入最新版本'}
                  </button>
                ) : null}
              </div>
              {editorError === null ? null : (
                <p className="alert alert--error" role="alert" data-testid="editor-error">
                  {editorError.text}
                </p>
              )}
            </div>
          )}
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

      {restoreConfirmOpen && selectedVersion !== null ? (
        <ConfirmDialog
          title="恢复历史版本"
          message={restoreConfirmMessage(selectedVersion.versionNo)}
          confirmLabel={restoring ? '恢复中…' : '确认恢复'}
          busy={restoring}
          onConfirm={() => void confirmRestore()}
          onCancel={() => {
            if (!restoring) {
              setRestoreConfirmOpen(false);
            }
          }}
        />
      ) : null}

      {finalizeConfirmOpen && selectedVersion !== null ? (
        <ConfirmDialog
          title="定稿章节"
          message={`定稿版本 ${selectedVersion.versionNo} 会锁定当前正文；之后人工修订会重新进入待定稿。`}
          confirmLabel={finalizing ? '定稿中…' : '确认定稿'}
          busy={finalizing}
          onConfirm={() => void confirmFinalize()}
          onCancel={() => {
            if (!finalizing) {
              setFinalizeConfirmOpen(false);
            }
          }}
        />
      ) : null}

      {closingEditor && editor !== null ? (
        <ConfirmDialog
          title="放弃未保存的修改"
          message="当前正文还没有保存，取消后草稿会丢失。确认放弃？"
          confirmLabel="放弃修改"
          danger
          busy={savingVersion}
          onConfirm={() => {
            setClosingEditor(false);
            setEditor(null);
            setDraft('');
            setEditorError(null);
            releaseSentinel();
          }}
          onCancel={() => setClosingEditor(false)}
        />
      ) : null}

      {pendingLeave === null ? null : (
        <ConfirmDialog
          title="放弃未保存的修改"
          message={leaveConfirmMessage(pendingLeave)}
          confirmLabel={leaveConfirmLabel(pendingLeave)}
          danger
          onConfirm={() => {
            const pending = pendingLeave;
            setPendingLeave(null);
            performLeave(pending);
          }}
          onCancel={() => setPendingLeave(null)}
        />
      )}

      {reloadConfirm ? (
        <ConfirmDialog
          title="载入最新版本"
          message="载入将替换当前未保存草稿，确认继续？"
          confirmLabel={reloadingLatest ? '载入中…' : '载入最新版本'}
          danger
          busy={reloadingLatest}
          onConfirm={() => {
            setReloadConfirm(false);
            void handleReloadLatest();
          }}
          onCancel={() => {
            if (!reloadingLatest) {
              setReloadConfirm(false);
            }
          }}
        />
      ) : null}
    </main>
  );
}
