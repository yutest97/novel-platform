/**
 * 版本对比的展示层纯逻辑（A1-4B-C-B）。
 *
 * 与 `@novel/workflow` 的 `diff.ts` 不同：这里**不做 diff 计算**，
 * 只负责：
 * - 严格解析 diff API 的响应（形状不对就拒绝，绝不把半截数据画到界面上）；
 * - 选择器默认值；
 * - 行标签 / 统计文案 / 类名（added / removed 必须有中文标签，不能只靠颜色）；
 * - 空 diff 与恢复确认文案。
 *
 * 本模块不依赖 React、不写任何存储，可直接单测。
 */

/** 行级 diff 的类型（与后端 `ChapterDiffLineKind` 一致）。 */
export type ChapterDiffLineKind = 'equal' | 'added' | 'removed';

/** 一行 diff。`equal` 两侧都有行号；`added` / `removed` 只有一侧。 */
export interface ChapterDiffLine {
  readonly kind: ChapterDiffLineKind;
  readonly oldLineNo: number | null;
  readonly newLineNo: number | null;
  readonly text: string;
}

/** 参与对比的版本元信息（不含正文）。 */
export interface ChapterDiffVersionRef {
  readonly id: string;
  readonly versionNo: number;
  readonly source: string;
  readonly wordCount: number;
}

export interface ChapterDiffStats {
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
}

/** 对比结果（与 `GET /versions/diff` 的 `diff` 字段一致）。 */
export interface ChapterVersionDiff {
  readonly fromVersion: ChapterDiffVersionRef;
  readonly toVersion: ChapterDiffVersionRef;
  readonly lines: readonly ChapterDiffLine[];
  readonly stats: ChapterDiffStats;
}

/** 响应形状不合法（调用方转成稳定错误码，不向用户暴露细节）。 */
export class DiffPayloadError extends Error {
  constructor() {
    super('版本对比响应格式不正确');
    this.name = 'DiffPayloadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw new DiffPayloadError();
  }
  return value;
}

function requireInteger(source: Record<string, unknown>, key: string, min: number): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new DiffPayloadError();
  }
  return value;
}

function requireLineNo(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new DiffPayloadError();
  }
  return value;
}

function parseVersionRef(payload: unknown): ChapterDiffVersionRef {
  if (!isRecord(payload)) {
    throw new DiffPayloadError();
  }
  return {
    id: requireString(payload, 'id'),
    versionNo: requireInteger(payload, 'versionNo', 1),
    source: requireString(payload, 'source'),
    wordCount: requireInteger(payload, 'wordCount', 0),
  };
}

function parseLine(payload: unknown): ChapterDiffLine {
  if (!isRecord(payload)) {
    throw new DiffPayloadError();
  }
  const kind = requireString(payload, 'kind');
  if (kind !== 'equal' && kind !== 'added' && kind !== 'removed') {
    throw new DiffPayloadError();
  }
  const oldLineNo = requireLineNo(payload['oldLineNo']);
  const newLineNo = requireLineNo(payload['newLineNo']);
  // 行号必须与 kind 自洽：否则前端会出现"新增行带旧行号"这类错位。
  if (kind === 'equal' && (oldLineNo === null || newLineNo === null)) {
    throw new DiffPayloadError();
  }
  if (kind === 'removed' && (oldLineNo === null || newLineNo !== null)) {
    throw new DiffPayloadError();
  }
  if (kind === 'added' && (oldLineNo !== null || newLineNo === null)) {
    throw new DiffPayloadError();
  }
  const text = payload['text'];
  if (typeof text !== 'string') {
    throw new DiffPayloadError();
  }
  return { kind, oldLineNo, newLineNo, text };
}

/**
 * 严格解析 `{ diff: { fromVersion, toVersion, lines, stats } }`。
 *
 * 任何字段缺失 / 类型不符 / 行号与 kind 不自洽 / stats 与实际行数不一致，
 * 都抛 `DiffPayloadError` —— UI 只显示稳定错误，不渲染半截结果。
 */
export function parseChapterVersionDiff(payload: unknown): ChapterVersionDiff {
  if (!isRecord(payload) || !isRecord(payload['diff'])) {
    throw new DiffPayloadError();
  }
  const diff = payload['diff'];
  const fromVersion = parseVersionRef(diff['fromVersion']);
  const toVersion = parseVersionRef(diff['toVersion']);

  const rawLines = diff['lines'];
  if (!Array.isArray(rawLines)) {
    throw new DiffPayloadError();
  }
  const lines = rawLines.map((line) => parseLine(line));

  if (!isRecord(diff['stats'])) {
    throw new DiffPayloadError();
  }
  const stats = {
    added: requireInteger(diff['stats'], 'added', 0),
    removed: requireInteger(diff['stats'], 'removed', 0),
    unchanged: requireInteger(diff['stats'], 'unchanged', 0),
  };

  const counted = countLineKinds(lines);
  if (
    counted.added !== stats.added ||
    counted.removed !== stats.removed ||
    counted.unchanged !== stats.unchanged
  ) {
    // 服务端统计与行内容矛盾：宁可报错，也不显示互相打架的数字。
    throw new DiffPayloadError();
  }

  return { fromVersion, toVersion, lines, stats };
}

function countLineKinds(lines: readonly ChapterDiffLine[]): ChapterDiffStats {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const line of lines) {
    if (line.kind === 'added') {
      added += 1;
    } else if (line.kind === 'removed') {
      removed += 1;
    } else {
      unchanged += 1;
    }
  }
  return { added, removed, unchanged };
}

/** 选择器的默认值：目标=最新，起始=上一版；只有一个版本时自己比自己。 */
export function defaultDiffSelection(
  versions: readonly { readonly id: string }[],
): { readonly fromVersionId: string; readonly toVersionId: string } | null {
  const latest = versions[0];
  if (latest === undefined) {
    return null;
  }
  const previous = versions[1] ?? latest;
  return { fromVersionId: previous.id, toVersionId: latest.id };
}

/** 两个版本内容一致（至少一行为 equal，且没有增删）。 */
export function isIdenticalDiff(stats: ChapterDiffStats): boolean {
  return stats.added === 0 && stats.removed === 0;
}

/** 统计文案（中文，不依赖颜色）。 */
export function diffStatsLabel(stats: ChapterDiffStats): string {
  return `新增 ${stats.added} 行 · 删除 ${stats.removed} 行 · 未变化 ${stats.unchanged} 行`;
}

/** 行标签：`added` / `removed` 必须有文字，`equal` 留空避免噪音。 */
export function diffLineLabel(kind: ChapterDiffLineKind): string {
  if (kind === 'added') {
    return '新增';
  }
  if (kind === 'removed') {
    return '删除';
  }
  return '';
}

/** 行样式类名（颜色只是辅助，标签才是主要信息）。 */
export function diffLineClass(kind: ChapterDiffLineKind): string {
  return `diff-line diff-line--${kind}`;
}

/** 行号占位：无对应侧显示 `·`（不用空白，避免列宽塌陷）。 */
export function lineNoPlaceholder(value: number | null): string {
  return value === null ? '·' : String(value);
}

/** 版本元信息文案（版本号 · 来源 · 字数）。 */
export function diffVersionLabel(
  version: ChapterDiffVersionRef,
  sourceLabel: (source: string) => string,
): string {
  return `版本 ${version.versionNo} · ${sourceLabel(version.source)} · ${version.wordCount} 字`;
}

/** 恢复确认文案：明确"创建新版本、不删除历史"。 */
export function restoreConfirmMessage(versionNo: number): string {
  return `确认从版本 ${versionNo} 恢复为新版本？这会基于当前最新版本创建一个新版本，版本 ${versionNo} 不会被删除或修改。`;
}

/** 恢复成功提示。 */
export function restoredNotice(sourceVersionNo: number, newVersionNo: number): string {
  return `已从版本 ${sourceVersionNo} 恢复为版本 ${newVersionNo}`;
}
