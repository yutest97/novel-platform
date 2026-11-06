/**
 * Reviewer 结果面板的纯展示逻辑（A2-C-E）。
 *
 * 与 `chapter-review-view.ts`（只做响应解析）分工不同：这里只负责
 * - severity / type / 工作流步骤的中文标签（未知值一律回退到安全文案，不抛错）；
 * - 高 / 中 / 低统计；
 * - 由「加载状态 + 审阅结果」推导面板的色调与文案；
 * - 是否需要轮询、是否属于异常响应。
 *
 * 不依赖 React、不写存储、不做任何请求，可直接单测。
 */

import type { ChapterReviewView } from './chapter-review-view';

/** 面板的加载状态。 */
export type ReviewLoadState = 'idle' | 'loading' | 'ready' | 'notfound' | 'error';

/** 严重度中文标签。 */
export const REVIEW_SEVERITY_LABELS: Readonly<Record<string, string>> = {
  high: '高',
  medium: '中',
  low: '低',
};

/** 问题类型中文标签（与 `reviewer.chapter` 的七类白名单一致）。 */
export const REVIEW_TYPE_LABELS: Readonly<Record<string, string>> = {
  contract_violation: '合同偏离',
  setting_contradiction: '设定矛盾',
  timeline_conflict: '时间线冲突',
  item_state_conflict: '物品状态冲突',
  plot_thread_conflict: '情节线冲突',
  character_consistency: '人物一致性',
  prose_quality: '文风问题',
};

/** 审阅步骤文案（只覆盖 `chapter.review` 的三步）。 */
export const REVIEW_STEP_LABELS: Readonly<Record<string, string>> = {
  load_review_input: '准备审阅上下文…',
  run_reviewer: '模型审阅中…',
  persist_review_result: '保存审阅结果…',
};

/** 未知步骤 / 尚未记录步骤时的通用文案。 */
export const REVIEW_STEP_FALLBACK = '审阅中…';

/** 未知严重度 / 类型的安全回退文案。 */
export const REVIEW_SEVERITY_FALLBACK = '未标注严重度';
export const REVIEW_TYPE_FALLBACK = '其它问题';

/** 轮询退避序列：1s → 2s → 5s，之后保持 5s。 */
export const REVIEW_POLL_DELAYS = [1_000, 2_000, 5_000] as const;

export function reviewSeverityLabel(severity: string): string {
  return REVIEW_SEVERITY_LABELS[severity] ?? REVIEW_SEVERITY_FALLBACK;
}

export function reviewTypeLabel(type: string): string {
  return REVIEW_TYPE_LABELS[type] ?? REVIEW_TYPE_FALLBACK;
}

/** 严重度徽章色调：高 = 危险、中 = 警告、低 / 未知 = 中性（不放大严重度）。 */
export function reviewSeverityTone(severity: string): 'danger' | 'warn' | 'muted' {
  if (severity === 'high') {
    return 'danger';
  }
  if (severity === 'medium') {
    return 'warn';
  }
  return 'muted';
}

/** 步骤文案：`null` 或未知步骤都回退到「审阅中…」，不暴露内部步骤名。 */
export function reviewStepLabel(step: string | null): string {
  if (step === null) {
    return REVIEW_STEP_FALLBACK;
  }
  return REVIEW_STEP_LABELS[step] ?? REVIEW_STEP_FALLBACK;
}

/** 严重度统计（`other` 收纳历史 / 未知 severity，不外泄原始值）。 */
export interface ReviewSeverityCounts {
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly other: number;
  readonly total: number;
}

export function reviewSeverityCounts(
  issues: readonly { readonly severity: string }[],
): ReviewSeverityCounts {
  let high = 0;
  let medium = 0;
  let low = 0;
  let other = 0;
  for (const issue of issues) {
    if (issue.severity === 'high') {
      high += 1;
    } else if (issue.severity === 'medium') {
      medium += 1;
    } else if (issue.severity === 'low') {
      low += 1;
    } else {
      other += 1;
    }
  }
  return { high, medium, low, other, total: issues.length };
}

/** 统计文案：`高 1 · 中 2 · 低 0`（未知严重度有值时才出现）。 */
export function reviewCountsLabel(counts: ReviewSeverityCounts): string {
  const parts = [`高 ${counts.high}`, `中 ${counts.medium}`, `低 ${counts.low}`];
  if (counts.other > 0) {
    parts.push(`未标注 ${counts.other}`);
  }
  return parts.join(' · ');
}

/** 面板色调（与 `.badge--*` / `.alert--*` 的既有语义对齐）。 */
export type ReviewPanelTone = 'muted' | 'info' | 'ok' | 'warn' | 'danger';

export interface ReviewPanelView {
  /** 主文案（一句话状态）。 */
  readonly text: string;
  /** 补充说明（可为空字符串）。 */
  readonly detail: string;
  readonly tone: ReviewPanelTone;
  /** 是否展示「重新读取」：只有本地读取失败 / 异常响应才需要。 */
  readonly canRetry: boolean;
  /** 问题统计（仅 `succeeded` 且有问题时非 null）。 */
  readonly counts: ReviewSeverityCounts | null;
}

/**
 * 是否需要轮询审阅结果。
 *
 * - 任务 `queued` / `processing`：还可能有后续 attempt；
 * - run `running`：模型或落库进行中；
 * - 任务终态但 `run=null`（`succeeded` 却没有结果）属于**异常响应**：不轮询，
 *   否则会永远转圈；由面板给出可重试的稳定错误态。
 */
export function shouldPollReview(review: ChapterReviewView | null): boolean {
  if (review === null) {
    return false;
  }
  if (review.run !== null && review.run.status === 'running') {
    return true;
  }
  return review.task.status === 'queued' || review.task.status === 'processing';
}

/** 任务已 `succeeded` 但没有任何 run：数据异常，不是"还在审阅"。 */
export function isReviewAnomaly(review: ChapterReviewView | null): boolean {
  return review !== null && review.task.status === 'succeeded' && review.run === null;
}

/** 下一次轮询间隔：按固定序列退避（1s → 2s → 5s），末尾保持 5s；非法输入回到 1s。 */
export function nextReviewPollDelay(previousMs: number): number {
  const previous = Number.isFinite(previousMs) ? Math.max(0, previousMs) : 0;
  for (const delay of REVIEW_POLL_DELAYS) {
    if (delay > previous) {
      return delay;
    }
  }
  return REVIEW_POLL_DELAYS[REVIEW_POLL_DELAYS.length - 1]!;
}

export interface ReviewPanelInput {
  readonly state: ReviewLoadState;
  readonly review: ChapterReviewView | null;
  /** 本地错误文案（`state === 'error'` 时展示）。 */
  readonly errorText: string;
}

/**
 * 由加载状态与审阅结果推导面板展示模型。
 *
 * 判定顺序固定（先看"还在跑"，再看结论，最后才是失败 / 取消），
 * 因为 `processing` 期间 run 可能仍是上一次 attempt 的 `failed`。
 */
export function reviewPanelView(input: ReviewPanelInput): ReviewPanelView {
  const { state, review } = input;

  if (state === 'idle') {
    return panel('muted', '尚未选择候选', '', false, null);
  }
  if (state === 'loading') {
    return panel('info', '正在读取审阅结果…', '', false, null);
  }
  if (state === 'notfound') {
    return panel('muted', '暂无审阅结果', '该候选还没有审阅记录，不影响预览与采纳。', false, null);
  }
  if (state === 'error') {
    return panel(
      'danger',
      '审阅结果读取失败',
      input.errorText === '' ? '请稍后重新读取。' : input.errorText,
      true,
      null,
    );
  }
  if (review === null) {
    // 理论上不可达（ready 必有结果），保守给出可重试的安全态。
    return panel('danger', '审阅结果读取失败', '请稍后重新读取。', true, null);
  }

  const { task, run } = review;

  if (task.status === 'queued') {
    return panel('info', '等待审阅…', '候选已保存，正在排队等待 Worker 领取。', false, null);
  }
  if (task.status === 'processing') {
    return panel('info', reviewStepLabel(task.currentStep), '', false, null);
  }
  if (isReviewAnomaly(review)) {
    return panel(
      'danger',
      '审阅结果异常',
      '审阅任务已结束但没有结果，请稍后重新读取。',
      true,
      null,
    );
  }
  if (task.status === 'cancelled') {
    return panel('muted', '审阅已取消', '不影响当前候选预览与采纳。', false, null);
  }
  if (run === null) {
    return panel(
      'warn',
      '审阅未完成，不影响当前候选采纳',
      '这次审阅没有产生结论，可以稍后重新提交生成。',
      false,
      null,
    );
  }
  if (run.status === 'succeeded') {
    if (run.passed) {
      // 全部为 0 的统计是噪音：通过时只给结论，不显示分档计数。
      return panel(
        'ok',
        '未发现结构性问题',
        '检查结果仅供作者参考，不会自动修改正文。',
        false,
        null,
      );
    }
    const counts = reviewSeverityCounts(run.issues);
    return panel('warn', `发现 ${run.issueCount} 个问题`, reviewCountsLabel(counts), false, counts);
  }
  return panel(
    'warn',
    '审阅未完成，不影响当前候选采纳',
    '这次审阅没有产生结论，可以稍后重新提交生成。',
    false,
    null,
  );
}

function panel(
  tone: ReviewPanelTone,
  text: string,
  detail: string,
  canRetry: boolean,
  counts: ReviewSeverityCounts | null,
): ReviewPanelView {
  return { tone, text, detail, canRetry, counts };
}
