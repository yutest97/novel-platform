/**
 * 正式版本之间的行级 diff（A1-4B-C-A）。
 *
 * 目标：给"版本对比"提供**只读、确定、有界**的数据，不返回两份完整正文。
 *
 * 算法取舍（不引入第三方 diff 依赖）：
 * - 先归一化换行（CRLF / CR → LF）并按行切分；末尾换行不额外产生空行，
 *   因此 `"a\nb\n"` 与 `"a\nb"` 视为同一组行（章节正文里换行符不是内容）。
 * - 先去掉公共前缀 / 后缀，再对中间段跑 **Myers O(ND)** 最短编辑脚本，
 *   回溯时按 `trace` 逐层还原 equal / added / removed。
 * - 规模保护：单侧行数上限 20000、编辑距离上限 500。超出编辑距离上限时
 *   退化为"中间段整体删除 + 整体新增"（仍是确定结果，只是不是最小脚本）；
 *   行数或字符数超限时抛 `CHAPTER_DIFF_TOO_LARGE`（400），避免无界内存与
 *   超大响应。章节正文本身由数据库 CHECK 限制在 1200..200000 字符。
 * - 同样输入必得同样输出：公共前后缀 + Myers 的固定 tie-break 都是确定性的。
 *
 * 只读：不写审计、不改任何表；正文只在内存里参与比较，不落日志。
 */

import { AuthError } from '@novel/auth';
import type { PrismaClient } from '@novel/db';
import { normalizeUuid, requireOwnedWork } from '@novel/works';

import { requireChapterInWork } from './service.js';

/** 单侧正文的字符上限（与 `chapter_versions_content_length_check` 一致）。 */
export const MAX_DIFF_CONTENT_CHARS = 200_000;
/** 单侧行数上限：超出后拒绝，避免 O(N·D) 与超大响应。 */
export const MAX_DIFF_LINES_PER_SIDE = 20_000;
/** Myers 的编辑距离上限：超出后退化为整段替换。 */
export const MAX_DIFF_EDIT_DISTANCE = 500;

/** diff 行类型（按 version A → version B 的方向）。 */
export type ChapterDiffLineKind = 'equal' | 'added' | 'removed';

/** 一行 diff。`equal` 两侧都有行号；`added` 只有新行号；`removed` 只有旧行号。 */
export interface ChapterDiffLine {
  readonly kind: ChapterDiffLineKind;
  /** 旧版本中的行号（1 起）；`added` 为 null。 */
  readonly oldLineNo: number | null;
  /** 新版本中的行号（1 起）；`removed` 为 null。 */
  readonly newLineNo: number | null;
  /** 行内容（不含换行符）。 */
  readonly text: string;
}

/** diff 两侧的版本元信息（**不含正文**）。 */
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

export interface ChapterVersionDiffView {
  readonly fromVersion: ChapterDiffVersionRef;
  readonly toVersion: ChapterDiffVersionRef;
  readonly lines: readonly ChapterDiffLine[];
  readonly stats: ChapterDiffStats;
}

interface DiffOp {
  readonly kind: ChapterDiffLineKind;
  readonly text: string;
}

/**
 * 按行切分正文。
 *
 * - 统一 CRLF / CR 为 LF；
 * - 末尾换行不产生额外空行（`"a\n"` → `["a"]`）；
 * - 中间的空行保留（`"a\n\nb"` → `["a", "", "b"]`）；
 * - 空字符串 → 空数组。
 */
export function splitDiffLines(content: string): string[] {
  if (content === '') {
    return [];
  }
  const normalized = content.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** 统计各类行数（与 `lines` 完全一致，便于前端直接展示）。 */
export function summarizeDiff(lines: readonly ChapterDiffLine[]): ChapterDiffStats {
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

/**
 * 比较两段正文，返回行级 diff。
 *
 * 方向固定为 `fromContent → toContent`：`removed` 只出现在旧版本，
 * `added` 只出现在新版本；调用方交换参数即可得到反向结果（added/removed 互换）。
 */
export function diffTextLines(fromContent: string, toContent: string): readonly ChapterDiffLine[] {
  assertDiffSize(fromContent);
  assertDiffSize(toContent);
  return buildDiff(splitDiffLines(fromContent), splitDiffLines(toContent));
}

/** 规模保护：字符数 / 行数超限直接拒绝（400），不做部分 diff。 */
function assertDiffSize(content: string): void {
  if (content.length > MAX_DIFF_CONTENT_CHARS) {
    throw new AuthError('CHAPTER_DIFF_TOO_LARGE', '章节正文规模超出对比上限');
  }
}

/** 由行数组构建 diff（公共前后缀 + Myers + 退化路径）。 */
function buildDiff(fromLines: readonly string[], toLines: readonly string[]): ChapterDiffLine[] {
  if (fromLines.length > MAX_DIFF_LINES_PER_SIDE || toLines.length > MAX_DIFF_LINES_PER_SIDE) {
    throw new AuthError('CHAPTER_DIFF_TOO_LARGE', '章节正文规模超出对比上限');
  }

  let prefix = 0;
  while (
    prefix < fromLines.length &&
    prefix < toLines.length &&
    fromLines[prefix] === toLines[prefix]
  ) {
    prefix += 1;
  }
  let fromEnd = fromLines.length;
  let toEnd = toLines.length;
  while (fromEnd > prefix && toEnd > prefix && fromLines[fromEnd - 1] === toLines[toEnd - 1]) {
    fromEnd -= 1;
    toEnd -= 1;
  }

  const ops: DiffOp[] = [];
  for (let index = 0; index < prefix; index += 1) {
    ops.push({ kind: 'equal', text: fromLines[index] as string });
  }

  const middleFrom = fromLines.slice(prefix, fromEnd);
  const middleTo = toLines.slice(prefix, toEnd);
  const script = myers(middleFrom, middleTo, MAX_DIFF_EDIT_DISTANCE);
  if (script === null) {
    // 编辑距离超限：整体替换，保持确定性与有界工作量
    for (const text of middleFrom) {
      ops.push({ kind: 'removed', text });
    }
    for (const text of middleTo) {
      ops.push({ kind: 'added', text });
    }
  } else {
    for (const op of script) {
      ops.push(op);
    }
  }

  for (let index = fromEnd; index < fromLines.length; index += 1) {
    ops.push({ kind: 'equal', text: fromLines[index] as string });
  }

  return numberLines(ops);
}

/** 给操作序列补上 1 起的行号。 */
function numberLines(ops: readonly DiffOp[]): ChapterDiffLine[] {
  let oldLineNo = 0;
  let newLineNo = 0;
  const lines: ChapterDiffLine[] = [];
  for (const op of ops) {
    if (op.kind === 'equal') {
      oldLineNo += 1;
      newLineNo += 1;
      lines.push({ kind: 'equal', oldLineNo, newLineNo, text: op.text });
      continue;
    }
    if (op.kind === 'removed') {
      oldLineNo += 1;
      lines.push({ kind: 'removed', oldLineNo, newLineNo: null, text: op.text });
      continue;
    }
    newLineNo += 1;
    lines.push({ kind: 'added', oldLineNo: null, newLineNo, text: op.text });
  }
  return lines;
}

/**
 * Myers 最短编辑脚本。
 *
 * 返回 `null` 表示编辑距离超过 `maxDistance`（调用方退化为整段替换）。
 * 内存为 O(maxDistance²) 的 trace 快照（500 → 约 2MB），
 * 时间为 O((N + M) · maxDistance)，两者都由常量上限兜住。
 */
function myers(
  fromLines: readonly string[],
  toLines: readonly string[],
  maxDistance: number,
): DiffOp[] | null {
  const n = fromLines.length;
  const m = toLines.length;
  if (n === 0) {
    return toLines.map((text) => ({ kind: 'added', text }));
  }
  if (m === 0) {
    return fromLines.map((text) => ({ kind: 'removed', text }));
  }

  const limit = Math.min(maxDistance, n + m);
  // k ∈ [-limit, limit]，多留一格给 k+1 / k-1 的边界访问
  const offset = limit + 1;
  const width = 2 * limit + 3;
  const v = new Int32Array(width);
  const trace: Int32Array[] = [];
  let found = false;

  for (let distance = 0; distance <= limit && !found; distance += 1) {
    trace.push(v.slice());
    for (let k = -distance; k <= distance; k += 2) {
      let x: number;
      if (
        k === -distance ||
        (k !== distance && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
      ) {
        // 从 k+1 下来（相当于在新版本里插入一行）
        x = v[offset + k + 1] as number;
      } else {
        // 从 k-1 向右（相当于从旧版本删除一行）
        x = (v[offset + k - 1] as number) + 1;
      }
      let y = x - k;
      while (x < n && y < m && fromLines[x] === toLines[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }

  if (!found) {
    return null;
  }

  // 回溯：按 trace 逐层还原，再反转成从前到后的顺序
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const snapshot = trace[distance] as Int32Array;
    const k = x - y;
    const prevK =
      k === -distance ||
      (k !== distance &&
        (snapshot[offset + k - 1] as number) < (snapshot[offset + k + 1] as number))
        ? k + 1
        : k - 1;
    const prevX = snapshot[offset + prevK] as number;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ kind: 'equal', text: fromLines[x - 1] as string });
      x -= 1;
      y -= 1;
    }

    if (distance > 0) {
      if (prevK === k + 1) {
        ops.push({ kind: 'added', text: toLines[prevY] as string });
      } else {
        ops.push({ kind: 'removed', text: fromLines[prevX] as string });
      }
      x = prevX;
      y = prevY;
    }
  }

  ops.reverse();
  return ops;
}

/** `diffChapterVersions` 的输入。 */
export interface DiffChapterVersionsInput {
  readonly db: PrismaClient;
  /** 只能来自会话；管理员不是作者，作品归属校验会 404。 */
  readonly authorId: string;
  readonly workId: string;
  readonly chapterId: string;
  readonly fromVersionId: string;
  readonly toVersionId: string;
}

interface VersionRow {
  readonly id: string;
  readonly versionNo: number;
  readonly source: string;
  readonly wordCount: number;
  readonly content: string;
}

/**
 * 读取两个正式版本并计算 diff。
 *
 * 权限与隔离：
 * - 先校验作品归属（他人作品 404），再校验章节属于该作品（跨作品 / 跨章节 404）；
 * - 两个版本都必须同时属于 `workId + chapterId`，任何一个不存在都统一 404，
 *   不泄露"这个 id 是否存在于别处"；
 * - 两个 id 相同 → 直接拿同一条记录，返回全 equal（不是错误）。
 *
 * 只读：单次 `findMany`，不改任何数据、不写审计、不记录正文。
 */
export async function diffChapterVersions(
  input: DiffChapterVersionsInput,
): Promise<ChapterVersionDiffView> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const fromVersionId = normalizeUuid(input.fromVersionId, '起始版本 id');
  const toVersionId = normalizeUuid(input.toVersionId, '目标版本 id');

  await requireOwnedWork(input.db, workId, input.authorId);
  await requireChapterInWork(input.db, workId, chapterId);

  const rows: VersionRow[] = await input.db.chapterVersion.findMany({
    where: {
      workId,
      chapterId,
      id: { in: fromVersionId === toVersionId ? [fromVersionId] : [fromVersionId, toVersionId] },
    },
    select: {
      id: true,
      versionNo: true,
      source: true,
      wordCount: true,
      content: true,
    },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  const from = byId.get(fromVersionId);
  const to = byId.get(toVersionId);
  if (from === undefined || to === undefined) {
    // 两个 id 都可能是"不存在 / 属于别的章节 / 属于别的作品"，统一同一句话
    throw new AuthError('NOT_FOUND', '版本不存在');
  }

  const lines = diffTextLines(from.content, to.content);
  return {
    fromVersion: toVersionRef(from),
    toVersion: toVersionRef(to),
    lines,
    stats: summarizeDiff(lines),
  };
}

function toVersionRef(row: VersionRow): ChapterDiffVersionRef {
  return {
    id: row.id,
    versionNo: row.versionNo,
    source: row.source,
    wordCount: row.wordCount,
  };
}
