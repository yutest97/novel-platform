/**
 * 章节工作台的纯展示逻辑（A1-4A）。
 *
 * 全部为纯函数：不访问网络、不读浏览器存储，供页面与单测共用。
 * 服务端仍是状态与权限的最终边界；这里只决定文案、徽标与轮询节奏。
 */

import type { ChapterListItem, GenerationTaskSummary } from './api';

/** 章节可生成状态（与 workflow `isChapterOpenForGeneration` 保持一致）。 */
const OPEN_CHAPTER_STATUSES: ReadonlySet<string> = new Set([
  'planned',
  'outlined',
  'drafting',
  'in_review',
]);

/** 生成表单允许的单章目标字数下限（与服务端合同一致）。 */
export const MIN_CHAPTER_TARGET_WORDS = 2_500;
/** 生成表单允许的单章目标字数上限。 */
export const MAX_CHAPTER_TARGET_WORDS = 4_000;
/** 非法输入时的回落值。 */
export const DEFAULT_CHAPTER_TARGET_WORDS = 3_000;

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'muted';

export interface StatusBadge {
  readonly label: string;
  readonly tone: BadgeTone;
}

/** 章节状态是否可以提交生成。 */
export function canGenerateChapter(status: string): boolean {
  return OPEN_CHAPTER_STATUSES.has(status);
}

/** 章节状态中文。 */
export function chapterStatusLabel(status: string): string {
  switch (status) {
    case 'planned':
      return '待生成';
    case 'outlined':
      return '已规划';
    case 'drafting':
      return '撰写中';
    case 'in_review':
      return '待定稿';
    case 'finalized':
      return '已完成';
    case 'abandoned':
      return '已废弃';
    default:
      return '未知状态';
  }
}

/** 列表徽标：生成中的任务优先于章节状态。 */
export function chapterBadge(item: ChapterListItem): StatusBadge {
  if (item.latestTaskStatus === 'queued' || item.latestTaskStatus === 'processing') {
    return { label: '生成中', tone: 'warn' };
  }
  if (item.latestTaskStatus === 'failed') {
    return { label: '生成失败', tone: 'danger' };
  }
  switch (item.status) {
    case 'finalized':
      return { label: '已完成', tone: 'ok' };
    case 'abandoned':
      return { label: '已废弃', tone: 'danger' };
    case 'in_review':
      return { label: '待定稿', tone: 'warn' };
    case 'drafting':
      return { label: '撰写中', tone: 'warn' };
    case 'outlined':
      return { label: '已规划', tone: 'muted' };
    default:
      return { label: '待生成', tone: 'muted' };
  }
}

/** 任务状态中文。 */
export function taskStatusLabel(status: string): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'processing':
      return '生成中';
    case 'succeeded':
      return '已完成';
    case 'failed':
      return '生成失败';
    case 'cancelled':
      return '已取消';
    default:
      return '未知状态';
  }
}

/** `current_step` → 步骤名词（不含「正在」前缀）。 */
const STEP_NOUNS: Readonly<Record<string, string>> = {
  assemble_context: '装配设定',
  plan_chapter: '规划章节',
  validate_and_freeze_contract: '冻结合同',
  write_draft: '写正文',
  validate_draft: '校验正文',
  persist_candidate: '保存候选',
};

function stepNoun(step: string): string {
  return STEP_NOUNS[step] ?? step;
}

/**
 * `current_step` → 中文**进行中**文案（未知步骤原样显示，便于发现新增步骤）。
 *
 * 只适用于 `queued` / `processing`；终态请用 `taskStepLabelForStatus`。
 */
export function taskStepLabel(step: string | null): string | null {
  if (step === null || step === '') {
    return null;
  }
  const noun = STEP_NOUNS[step];
  return noun === undefined ? step : `正在${noun}`;
}

/**
 * 依任务状态给出步骤文案。
 *
 * 终态任务的 `current_step` 会保留最后一次检查点（例如 `persist_candidate`），
 * 直接复用进行中文案会出现「已完成 · 正在保存候选」这种自相矛盾的展示，
 * 因此终态统一改成「最后步骤：…」。
 */
export function taskStepLabelForStatus(step: string | null, status: string): string | null {
  if (step === null || step === '') {
    return null;
  }
  const noun = stepNoun(step);
  return shouldPollTask(status) ? `正在${noun}` : `最后步骤：${noun}`;
}

/**
 * 把作品的目标字数收敛成生成表单可用的值。
 *
 * 小于下限取 2500、大于上限取 4000；合法整数原样返回；
 * 非有限值或非整数回落为 3000（不静默四舍五入，避免把 3000.5 变成 3001）。
 */
export function clampChapterTargetWords(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return DEFAULT_CHAPTER_TARGET_WORDS;
  }
  if (value < MIN_CHAPTER_TARGET_WORDS) {
    return MIN_CHAPTER_TARGET_WORDS;
  }
  if (value > MAX_CHAPTER_TARGET_WORDS) {
    return MAX_CHAPTER_TARGET_WORDS;
  }
  return value;
}

/** 是否处于需要轮询的状态。 */
export function shouldPollTask(status: string | null): boolean {
  return status === 'queued' || status === 'processing';
}

/** 任务是否终态（用于恢复生成按钮）。 */
export function isTerminalTaskStatus(status: string | null): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** 轮询间隔：1s 起，每次 +1s，最大 5s。 */
export function nextPollDelay(previousMs: number): number {
  const base = Number.isFinite(previousMs) ? Math.max(0, Math.floor(previousMs)) : 0;
  return Math.min(base + 1_000, 5_000);
}

/** 任务进度文案（优先当前步骤）。 */
export function taskProgressLabel(task: GenerationTaskSummary | null): string {
  if (task === null) {
    return '尚未提交生成任务';
  }
  const step = taskStepLabel(task.currentStep);
  if (shouldPollTask(task.status)) {
    return step ?? taskStatusLabel(task.status);
  }
  return taskStatusLabel(task.status);
}

/** 正式版本来源中文。 */
export function versionSourceLabel(source: string): string {
  return source === 'human' ? '人工' : 'AI';
}

/** 结构化计划的展示模型。 */
export interface DisplayPlan {
  readonly goal: string;
  readonly mustInclude: readonly string[];
  readonly scenes: readonly {
    readonly purpose: string;
    readonly location: string;
    readonly conflict: string;
    readonly outcome: string;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/**
 * 从候选 `structured_plan` 中安全提取可展示字段。
 *
 * 不认识的结构一律返回 null（页面显示“计划不可用”），不做任何猜测。
 */
export function displayPlan(value: unknown): DisplayPlan | null {
  if (!isRecord(value)) {
    return null;
  }
  const goal = textOf(value['goal']);
  if (goal.trim() === '') {
    return null;
  }

  const scenes: DisplayPlan['scenes'][number][] = [];
  if (Array.isArray(value['scenes'])) {
    for (const scene of value['scenes']) {
      if (!isRecord(scene)) {
        continue;
      }
      scenes.push({
        purpose: textOf(scene['purpose']),
        location: textOf(scene['location']),
        conflict: textOf(scene['conflict']),
        outcome: textOf(scene['outcome']),
      });
    }
  }

  return {
    goal,
    mustInclude: stringList(value['mustInclude']),
    scenes,
  };
}
