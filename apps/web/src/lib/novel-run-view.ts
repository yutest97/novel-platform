/**
 * 动态问答页的纯展示 / 轮询策略（C1-A）。
 *
 * 这些函数不依赖 DOM，便于单测固定轮询节奏与状态文案；
 * 页面只负责定时器、可见性与请求生命周期。
 */

import type { NovelRunStatus } from './api';

/** 轮询退避：1s → 2s → 5s，之后固定 5s。 */
export const NOVEL_POLL_DELAYS_MS = [1_000, 2_000, 5_000] as const;

/**
 * 页面是否处于隐藏状态。
 *
 * 隐藏时必须真正暂停轮询：初始 tick 前、每次成功/失败安排下一次 timer 前，
 * 都必须经过这个判定。
 */
export function isPageHidden(
  documentLike: { readonly visibilityState: string } | null | undefined = typeof document ===
  'undefined'
    ? null
    : document,
): boolean {
  return documentLike !== null && documentLike !== undefined
    ? documentLike.visibilityState === 'hidden'
    : false;
}

/** 只有 queued / running 需要继续拉取；waiting_user 等待作者输入。 */
export function shouldPollNovelRun(status: NovelRunStatus): boolean {
  return status === 'queued' || status === 'running';
}

/** 终态：completed / failed / cancelled。 */
export function isTerminalNovelStatus(status: NovelRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** 取第 attempt 次轮询的等待时间（attempt 从 0 开始，超出后固定 5s）。 */
export function nextNovelPollDelay(attempt: number): number {
  const index = Math.max(0, Math.min(attempt, NOVEL_POLL_DELAYS_MS.length - 1));
  return NOVEL_POLL_DELAYS_MS[index] ?? 5_000;
}

/** 状态中文标签。 */
export function novelStatusLabel(status: NovelRunStatus): string {
  switch (status) {
    case 'queued':
      return '已排队';
    case 'running':
      return '整理中';
    case 'waiting_user':
      return '等待你的回答';
    case 'completed':
      return '已结束';
    case 'failed':
      return '已失败';
    case 'cancelled':
      return '已取消';
  }
}

/** 状态说明（不含模型原始输出或错误详情）。 */
export function novelStatusNotice(status: NovelRunStatus): string {
  switch (status) {
    case 'queued':
      return '已提交，正在等待 Worker 处理。';
    case 'running':
      return 'Coordinator 正在整理下一步问题，请稍候。';
    case 'waiting_user':
      return '请回答问题；你的回答只用于本轮创作准备。';
    case 'completed':
      return '本轮创作准备已结束。';
    case 'failed':
      return '本轮创作准备失败，请重新发起。';
    case 'cancelled':
      return '本轮创作准备已取消。';
  }
}

/** 是否允许取消：所有非终态都可以取消。 */
export function canCancelNovelRun(status: NovelRunStatus): boolean {
  return !isTerminalNovelStatus(status);
}
