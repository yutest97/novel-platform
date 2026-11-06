/**
 * 章节版本摘要卡片的纯展示逻辑（A2-D-E）。
 *
 * 与 `chapter-summary-view.ts`（只做响应解析）分工不同：这里只负责
 * - 加载 / 缺失 / 失败的文案与色调；
 * - 摘要正文的展示化处理（统一换行、不做任何 HTML 处理）；
 * - 版本号 + 生成时间的元信息文案。
 *
 * 不依赖 React、不写存储、不做请求，可直接单测。
 */

/** 摘要卡片的加载状态。 */
export type SummaryLoadState = 'idle' | 'loading' | 'ready' | 'notfound' | 'error';

/** 卡片色调（与 `.badge--*` / `.alert--*` 的既有语义对齐）。 */
export type SummaryPanelTone = 'muted' | 'info' | 'ok' | 'danger';

export interface SummaryPanelView {
  readonly text: string;
  readonly detail: string;
  readonly tone: SummaryPanelTone;
  /** 只有本地读取失败 / 解析失败才需要「重新读取」。 */
  readonly canRetry: boolean;
}

export interface SummaryPanelInput {
  readonly state: SummaryLoadState;
  /** 本地错误文案（`state === 'error'` 时展示）。 */
  readonly errorText: string;
}

/**
 * 由加载状态推导卡片文案。
 *
 * 判定顺序固定：先看是否在加载，再看是否缺失，最后才是失败。
 * 未知状态回退到安全文案，不抛错、不暴露内部枚举。
 */
export function summaryPanelView(input: SummaryPanelInput): SummaryPanelView {
  const { state } = input;
  if (state === 'loading') {
    return { text: '正在读取版本摘要…', detail: '', tone: 'info', canRetry: false };
  }
  if (state === 'ready') {
    return { text: '版本摘要', detail: '', tone: 'ok', canRetry: false };
  }
  if (state === 'notfound') {
    return {
      text: '该版本暂无摘要',
      // 404 不能证明"正在生成"：把三种可能都说清楚，不误导作者等待。
      detail: '摘要可能仍在生成、生成失败，或定稿时模型未配置。',
      tone: 'muted',
      canRetry: false,
    };
  }
  if (state === 'error') {
    return {
      text: '版本摘要读取失败',
      detail: input.errorText === '' ? '请稍后重新读取。' : input.errorText,
      tone: 'danger',
      canRetry: true,
    };
  }
  if (state === 'idle') {
    return { text: '尚未读取版本摘要', detail: '', tone: 'muted', canRetry: false };
  }
  // 未知状态（未来新增枚举 / 脏数据）
  return { text: '版本摘要状态未知', detail: '', tone: 'muted', canRetry: false };
}

/**
 * 只有**最新序号**的响应可以落地。
 *
 * 页面在每次加载 / 切换 / 重试时自增序号；旧请求（序号更小）必须完全静默，
 * 否则 v2 → v1 → v2 快速切换时会被中间那次响应覆盖。
 */
export function isCurrentSummaryRequest(seq: number, current: number): boolean {
  return seq === current;
}

/**
 * 摘要正文的展示化处理。
 *
 * 只做换行统一（CRLF / CR → LF）：`white-space: pre-wrap` 依赖 `\n`，
 * 混入 `\r` 会在部分浏览器留下多余空行。**不转义、不截断、不做 Markdown / HTML**，
 * 中文与内部换行原样保留，渲染交给 React 文本节点。
 */
export function summaryBodyText(summary: string): string {
  return summary.replace(/\r\n?/g, '\n');
}

/** 版本号 + 生成时间（`createdAtLabel` 由调用方格式化，避免模块依赖日期实现）。 */
export function summaryMetaLabel(versionNo: number, createdAtLabel: string): string {
  return `版本 v${String(versionNo)} · 生成于 ${createdAtLabel}`;
}
