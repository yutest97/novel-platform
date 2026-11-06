/**
 * 连续性事实面板的纯展示逻辑（A2-E）。
 *
 * 与 `chapter-summary-panel.ts` / `chapter-review-panel.ts` 同一分工：
 * 只负责标签、文案、空态、截断提示与"能否提取"的判定，
 * 不依赖 React、不发请求、不写存储，可直接单测。
 *
 * 硬边界：
 * - 不展示正文、prompt、模型原始响应、`attemptToken`、provider / model；
 * - 未知 factType / threadStatus / 错误码一律回退到安全文案，不暴露内部枚举；
 * - 不提供接受 / 拒绝 / 写回实体等任何会修改数据的动作。
 */

import type { ChapterFactListItem } from './api';

/** 列表硬上限（与 `listChapterFacts` 的 `MAX_CHAPTER_FACT_LIST` 一致）。 */
export const FACTS_LIST_LIMIT = 200;

/** 六类事实的中文标签（与 `CHAPTER_FACT_TYPES` 白名单一致）。 */
export const FACT_TYPE_LABELS: Readonly<Record<string, string>> = {
  character_state: '人物状态',
  relationship_change: '关系变化',
  item_change: '物品变化',
  realm_progress: '境界进展',
  plot_thread: '情节线索',
  location_change: '人物位置',
};

/** 未知类型的安全回退文案。 */
export const FACT_TYPE_FALLBACK = '其它事实';

/** 过滤值 `all` 表示不带 `factType` 查询参数。 */
export const FACT_FILTER_ALL = 'all';

export interface FactFilterOption {
  readonly value: string;
  readonly label: string;
}

/**
 * 过滤项（顺序固定）：全部 + 六类。
 *
 * 值直接使用 `factType` 白名单，避免"客户端自造过滤条件"。
 */
export const FACT_FILTER_OPTIONS: readonly FactFilterOption[] = [
  { value: FACT_FILTER_ALL, label: '全部' },
  { value: 'character_state', label: '人物状态' },
  { value: 'relationship_change', label: '关系变化' },
  { value: 'item_change', label: '物品变化' },
  { value: 'realm_progress', label: '境界进展' },
  { value: 'plot_thread', label: '情节线索' },
  { value: 'location_change', label: '人物位置' },
];

/** 线索状态中文标签。 */
export const FACT_THREAD_STATUS_LABELS: Readonly<Record<string, string>> = {
  new: '新线索',
  advanced: '有推进',
  resolved: '已解决',
};

export const FACT_THREAD_STATUS_FALLBACK = '状态未知';

export function factTypeLabel(factType: string): string {
  return FACT_TYPE_LABELS[factType] ?? FACT_TYPE_FALLBACK;
}

export function factFilterLabel(filter: string): string {
  return FACT_FILTER_OPTIONS.find((option) => option.value === filter)?.label ?? '全部';
}

export function factThreadStatusLabel(status: string): string {
  return FACT_THREAD_STATUS_LABELS[status] ?? FACT_THREAD_STATUS_FALLBACK;
}

/**
 * 过滤值 → 请求参数。
 *
 * `all`（或未知值）不传 `factType`：过滤只在服务端做，客户端不裁剪结果。
 */
export function factFilterQuery(filter: string): string | undefined {
  const known = FACT_FILTER_OPTIONS.some(
    (option) => option.value === filter && option.value !== FACT_FILTER_ALL,
  );
  return known ? filter : undefined;
}

/** 面板的加载状态。 */
export type FactsLoadState = 'idle' | 'loading' | 'ready' | 'error';

/** 总数文案：`共 12 条候选` / `当前筛选共 3 条候选`。 */
export function factsTotalLabel(total: number, filter: string): string {
  const safe = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  return filter === FACT_FILTER_ALL ? `共 ${safe} 条候选` : `当前筛选共 ${safe} 条候选`;
}

/**
 * 截断提示：绝不静默丢结果。
 *
 * 服务端最多返回 `FACTS_LIST_LIMIT` 条并在 `truncated` 上标记；
 * 这里同时给出完整 `total`，让作者知道被隐藏了多少。
 */
export function factsTruncatedNotice(total: number): string {
  const safe = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  return `结果较多：共 ${safe} 条候选，仅显示最近 ${FACTS_LIST_LIMIT} 条。`;
}

export interface FactsEmptyView {
  readonly title: string;
  readonly detail: string;
}

/**
 * 空结果文案（两种成因必须区分）。
 *
 * - 完全没有候选（`allTotal === 0`）：提示去提取；
 * - 只是当前筛选为空（`allTotal > 0`）：提示切换筛选；
 * - `allTotal === null`（"全部"那次读取没成功过）：不声称"没有任何候选"。
 */
export function factsEmptyView(input: {
  readonly filter: string;
  readonly allTotal: number | null;
}): FactsEmptyView {
  if (input.filter === FACT_FILTER_ALL) {
    return {
      title: '还没有事实候选',
      detail:
        '章节定稿后可以提取连续性事实候选；提取只产生候选，不会修改人物、物品、势力、关系或境界。',
    };
  }
  if (input.allTotal === 0) {
    return {
      title: '还没有事实候选',
      detail: '该章节还没有任何事实候选，可以先提取事实。',
    };
  }
  return {
    title: '当前筛选下没有候选',
    detail: `「${factFilterLabel(input.filter)}」下没有候选，可以切换到「全部」查看。`,
  };
}

/** 提取失败的稳定中文文案（只认六类连续性错误码）。 */
export const FACT_EXTRACT_ERROR_TEXTS: Readonly<Record<string, string>> = {
  CONTINUITY_CHAPTER_NOT_FINALIZED: '章节尚未定稿，不能提取连续性事实。',
  CONTINUITY_SOURCE_VERSION_STALE: '章节最新版本已变化，请重新选择最新版本再提取。',
  CONTINUITY_EXTRACTION_IN_PROGRESS: '该版本正在提取连续性事实，请稍后重试。',
  CONTINUITY_EXTRACTION_LEASE_LOST: '提取任务已由新的尝试接管，请重新读取现有候选。',
  CONTINUITY_FACTS_INVALID: '模型输出的事实不合法，本次没有写入任何候选。',
  CONTINUITY_EXTRACTION_FAILED: '连续性事实提取失败，请稍后重试。',
};

export const FACT_EXTRACT_ERROR_FALLBACK = '提取失败，请稍后重试。';

/**
 * 提取失败文案。
 *
 * `code === null` 表示不是可识别的 API 错误（网络 / 解析失败），
 * 与未知错误码一样回退到通用文案，不回显原始异常。
 */
export function factExtractErrorText(code: string | null): string {
  if (code === null) {
    return FACT_EXTRACT_ERROR_FALLBACK;
  }
  return FACT_EXTRACT_ERROR_TEXTS[code] ?? FACT_EXTRACT_ERROR_FALLBACK;
}

/** 提取成功提示：`created=false` 表示读到的是既有结果。 */
export function factExtractNotice(created: boolean, factCount: number): string {
  const safe = Number.isFinite(factCount) && factCount > 0 ? Math.trunc(factCount) : 0;
  return created
    ? `已提取 ${safe} 条候选，仅作审阅，不会自动修改设定。`
    : `已读取既有结果（${safe} 条候选），本次没有新增。`;
}

/**
 * 只有**最新序号**的响应可以落地。
 *
 * 过滤值本身不足以区分新旧请求：快速在「人物状态 → 全部 → 人物状态」之间切换时，
 * 首尾两次请求的参数完全相同，只有序号能识别谁才是当前请求。
 */
export function isCurrentFactRequest(seq: number, current: number): boolean {
  return seq === current;
}

/** 简短 id：只展示前 8 位，避免整串 uuid 占据版面。 */
export function shortFactId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

/**
 * 候选的引用标签（安全名称或简短 id）。
 *
 * - `subjectId` / `objectId` 是上下文里的实体 id，这里绝不展开成正文；
 * - `name` 只有地点变更会用到；
 * - `threadStatus` 只展示中文语义，不回显原始枚举。
 */
export function factRefLabels(fact: ChapterFactListItem): readonly string[] {
  const labels: string[] = [];
  if (fact.subjectId !== null && fact.subjectId !== '') {
    labels.push(`主体 ${shortFactId(fact.subjectId)}`);
  }
  if (fact.objectId !== null && fact.objectId !== '') {
    labels.push(`客体 ${shortFactId(fact.objectId)}`);
  }
  if (fact.name !== null && fact.name !== '') {
    labels.push(`${fact.factType === 'location_change' ? '地点' : '名称'} ${fact.name}`);
  }
  if (fact.threadStatus !== null && fact.threadStatus !== '') {
    labels.push(`线索${factThreadStatusLabel(fact.threadStatus)}`);
  }
  return labels;
}

export interface CanExtractFactsInput {
  /** 章节状态（来自章节详情；未加载时为 `null`）。 */
  readonly chapterStatus: string | null;
  readonly selectedVersionId: string | null;
  readonly latestVersionId: string | null;
  /** 正在读取另一个版本：此时 `selectedVersion` 仍是旧值。 */
  readonly versionLoading: boolean;
  readonly extracting: boolean;
}

/**
 * 是否显示「提取事实」。
 *
 * 必须同时满足：章节已定稿、选中的是**当前最新**正式版本、没有在读取别的版本、
 * 没有正在提取。提取只针对最新正式版本，旧版本没有意义。
 */
export function canExtractFacts(input: CanExtractFactsInput): boolean {
  return (
    input.chapterStatus === 'finalized' &&
    !input.versionLoading &&
    !input.extracting &&
    input.selectedVersionId !== null &&
    input.latestVersionId !== null &&
    input.selectedVersionId === input.latestVersionId
  );
}

/**
 * 提取入口不可用时的说明（`canExtract` 为 false 时展示）。
 *
 * 只解释"为什么现在不能提取"，不暗示任何自动动作。
 */
export function factsExtractHint(input: {
  readonly chapterStatus: string | null;
  readonly selectedVersionId: string | null;
  readonly latestVersionId: string | null;
  readonly versionLoading: boolean;
}): string {
  if (input.chapterStatus === null) {
    return '正在读取章节状态…';
  }
  if (input.chapterStatus !== 'finalized') {
    return '章节定稿后才能提取连续性事实候选。';
  }
  if (
    input.selectedVersionId !== null &&
    input.latestVersionId !== null &&
    input.selectedVersionId !== input.latestVersionId
  ) {
    return '提取仅针对最新正式版本，请先选择最新版本。';
  }
  return '';
}
