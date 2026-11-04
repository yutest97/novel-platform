/**
 * 章节人工编辑器（A1-4B-B）的纯逻辑。
 *
 * 全部为纯函数：不访问网络、不读浏览器存储、不碰 DOM，供页面与单测共用。
 * 服务端仍是正文校验与并发控制的最终边界；这里只做**预览**与**交互判定**：
 * - 字数预览与下限提示（提交给 API 的仍只有正文与 baseVersionId，**不提交字数**）；
 * - 编辑基线（有版本时只能编辑最新版本，首版只能 baseVersionId=null）；
 * - dirty 判定（用于取消确认与 beforeunload）；
 * - 保存失败时的稳定文案映射（含"载入最新版本"按钮的展示条件）。
 */

/** 服务端允许保存的最少非空白字符（与 `countWords` 同一口径）。 */
export const MIN_HUMAN_CONTENT_CHARS = 1_200;
/** 服务端允许保存的最大字符数（与数据库 CHECK 一致）。 */
export const MAX_HUMAN_CONTENT_CHARS = 200_000;

/**
 * 非空白字符数（预览用）。
 *
 * 与服务端 `countWords` 完全一致：按码点计数并忽略所有空白字符，
 * 保证"页面显示够 1200"与"服务端接受"不会出现口径漂移。
 */
export function countDraftChars(text: string): number {
  return Array.from(text.replace(/\s/gu, '')).length;
}

export interface DraftMetrics {
  /** 非空白字符数。 */
  readonly chars: number;
  /** 距下限还差多少（已达下限为 0）。 */
  readonly shortfall: number;
  /** 是否超过上限。 */
  readonly overLimit: boolean;
  /** 是否满足保存条件（下限 ~ 上限之间）。 */
  readonly canSave: boolean;
}

/** 计算编辑器当前正文的预览指标。 */
export function draftMetrics(text: string): DraftMetrics {
  const chars = countDraftChars(text);
  const shortfall = Math.max(0, MIN_HUMAN_CONTENT_CHARS - chars);
  const overLimit = chars > MAX_HUMAN_CONTENT_CHARS;
  return {
    chars,
    shortfall,
    overLimit,
    canSave: shortfall === 0 && !overLimit,
  };
}

/** 编辑器指标文案（实时显示在当前正文下方）。 */
export function editorMetricsLabel(metrics: DraftMetrics): string {
  const base = `非空白字符 ${metrics.chars}`;
  if (metrics.overLimit) {
    return `${base} · 超过上限 ${metrics.chars - MAX_HUMAN_CONTENT_CHARS} 字`;
  }
  if (metrics.shortfall > 0) {
    return `${base} · 还需 ${metrics.shortfall} 字`;
  }
  return `${base} · 已达可保存下限`;
}

/** 是否有未保存修改（与基线逐字符比较，不做 trim 归一，避免隐藏改动）。 */
export function isDraftDirty(draft: string, baseline: string): boolean {
  return draft !== baseline;
}

/** 版本摘要的最小结构（与 `ChapterVersionListItem` 兼容）。 */
export interface VersionOption {
  readonly id: string;
  readonly versionNo: number;
}

/** 编辑目标：首版 or 基于最新版本的修订。 */
export interface EditorTarget {
  /** 提交给 API 的 `baseVersionId`：首版为 null。 */
  readonly baseVersionId: string | null;
  /** 作为基线的版本号；首版为 null。 */
  readonly versionNo: number | null;
  readonly mode: 'first' | 'latest';
}

/**
 * 由版本列表（按 versionNo 倒序，最新在前）推导编辑目标。
 *
 * 只允许编辑**最新版本**：旧版本永远不能作为 baseVersionId，
 * 否则保存会以旧版本为基线并覆盖别人的更新（服务端也会 409）。
 */
export function editorTarget(versions: readonly VersionOption[]): EditorTarget {
  const latest = versions[0];
  if (latest === undefined) {
    return { baseVersionId: null, versionNo: null, mode: 'first' };
  }
  return { baseVersionId: latest.id, versionNo: latest.versionNo, mode: 'latest' };
}

/** 当前选中的版本是否就是最新版本（只有它可编辑）。 */
export function canEditSelectedVersion(
  selectedVersionId: string | null,
  versions: readonly VersionOption[],
): boolean {
  const latest = versions[0];
  if (latest === undefined || selectedVersionId === null) {
    return false;
  }
  return latest.id === selectedVersionId;
}

/** 保存失败时的展示模型。 */
export interface EditorErrorNotice {
  readonly text: string;
  /** 是否提供「载入最新版本」按钮（只有基线冲突需要）。 */
  readonly reloadable: boolean;
}

/**
 * 稳定错误码 → 编辑器内提示。
 *
 * 冲突类错误必须**保留草稿**并引导重新载入，不能静默丢弃作者写下的内容；
 * 未知错误回落到统一文案（不透出服务端原始消息）。
 */
export function editorErrorNotice(code: string, fallback: string): EditorErrorNotice {
  switch (code) {
    case 'CHAPTER_CONTENT_INVALID':
      return { text: '章节正文不合法，请检查字数和内容', reloadable: false };
    case 'CHAPTER_STATE_INVALID_FOR_SAVE':
      return { text: '章节当前状态不允许保存人工版本', reloadable: false };
    case 'CHAPTER_VERSION_CONFLICT':
      return { text: '正文已被其他操作更新，请重新载入最新版本', reloadable: true };
    case 'CONCURRENT_MODIFICATION':
      return { text: '数据已被其他操作修改，请重试', reloadable: false };
    default:
      return { text: fallback, reloadable: false };
  }
}
