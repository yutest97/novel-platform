/**
 * 章节版本摘要的展示层解析（A2-D-D）。
 *
 * 与 `@novel/workflow` 的 `summary-read.ts` 分工不同：这里**不查库**，只负责
 * 严格解析只读摘要接口的响应（形状不对就整份拒绝，绝不把半截数据画到界面上）。
 *
 * 不依赖 React、不写任何存储，可直接单测。
 */

/** 一条版本摘要（与 `GET /versions/:versionId/summary` 的 `summary` 字段一致）。 */
export interface ChapterSummaryRecord {
  readonly id: string;
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly versionNo: number;
  readonly summary: string;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly createdAt: string;
}

/** 摘要正文上限（与数据库 CHECK 和 `summarizer.chapter` 输出契约一致）。 */
export const MAX_SUMMARY_TEXT_CHARS = 1_000;

/** 响应形状不合法（调用方转成稳定错误码，不向用户暴露细节）。 */
export class SummaryPayloadError extends Error {
  constructor() {
    super('章节摘要响应格式不正确');
    this.name = 'SummaryPayloadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw new SummaryPayloadError();
  }
  return value;
}

function requirePositiveInteger(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SummaryPayloadError();
  }
  return value;
}

function requireTimestamp(source: Record<string, unknown>, key: string): string {
  const value = requireString(source, key);
  if (Number.isNaN(Date.parse(value))) {
    throw new SummaryPayloadError();
  }
  return value;
}

/**
 * 解析 `GET /versions/:versionId/summary` 的响应体。
 *
 * 任何字段缺失、类型不符、摘要为空或超长、时间戳不可解析都整份拒绝，
 * 调用方据此返回稳定错误码，不展示半截摘要。
 */
export function parseChapterVersionSummary(body: unknown): ChapterSummaryRecord {
  if (!isRecord(body)) {
    throw new SummaryPayloadError();
  }
  const summary = body['summary'];
  if (!isRecord(summary)) {
    throw new SummaryPayloadError();
  }

  const text = requireString(summary, 'summary');
  // 数据库 CHECK 是 1..1000；这里再确认一次，避免异常数据被当成正常摘要展示。
  if (text.length > MAX_SUMMARY_TEXT_CHARS) {
    throw new SummaryPayloadError();
  }

  return {
    id: requireString(summary, 'id'),
    chapterId: requireString(summary, 'chapterId'),
    sourceVersionId: requireString(summary, 'sourceVersionId'),
    versionNo: requirePositiveInteger(summary, 'versionNo'),
    summary: text,
    agentName: requireString(summary, 'agentName'),
    agentVersion: requireString(summary, 'agentVersion'),
    createdAt: requireTimestamp(summary, 'createdAt'),
  };
}
