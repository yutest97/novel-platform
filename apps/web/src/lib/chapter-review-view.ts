/**
 * Reviewer 结果的展示层纯逻辑（A2-C-D）。
 *
 * 与 `@novel/workflow` 的 `review-read.ts` 不同：这里**不查库**，只负责：
 * - 严格解析只读审查接口的响应（形状不对就整份拒绝，绝不把半截数据画到界面上）；
 * - 提供与后端一致的类型（任务状态 / 步骤 / 运行状态 / 问题）。
 *
 * 本模块不依赖 React、不写任何存储，可直接单测。
 */

/** `chapter.review` 任务状态（与后端一致）。 */
export type ReviewTaskStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';

/** `chapter.review` 的三步（与后端一致）。 */
export type ReviewTaskStep = 'load_review_input' | 'run_reviewer' | 'persist_review_result';

/** review run 状态（与后端一致）。 */
export type ReviewRunStatus = 'running' | 'succeeded' | 'failed';

const TASK_STATUSES: readonly ReviewTaskStatus[] = [
  'queued',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
];

const TASK_STEPS: readonly ReviewTaskStep[] = [
  'load_review_input',
  'run_reviewer',
  'persist_review_result',
];

const RUN_STATUSES: readonly ReviewRunStatus[] = ['running', 'succeeded', 'failed'];

/** 一条审阅问题（`evidence` 是正文原句，属于问题证据本身）。 */
export interface ChapterReviewIssueView {
  readonly id: string;
  readonly ordinal: number;
  readonly severity: string;
  readonly type: string;
  readonly evidence: string;
  readonly suggestion: string;
}

/** 审阅任务（不含 requestId / inputSnapshot / 租约）。 */
export interface ChapterReviewTaskView {
  readonly id: string;
  readonly status: ReviewTaskStatus;
  readonly currentStep: ReviewTaskStep | null;
  readonly attemptCount: number;
  readonly errorCode: string | null;
}

/** 一次审阅运行。`passed` 只有 `succeeded` 时非 null。 */
export interface ChapterReviewRunView {
  readonly id: string;
  readonly status: ReviewRunStatus;
  readonly passed: boolean | null;
  readonly issueCount: number;
  readonly errorCode: string | null;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly issues: readonly ChapterReviewIssueView[];
}

/** 候选对应的审阅结果（`run === null` 表示尚未开始，可轮询）。 */
export interface ChapterReviewView {
  readonly candidateId: string;
  readonly task: ChapterReviewTaskView;
  readonly run: ChapterReviewRunView | null;
}

/** 响应形状不合法（调用方转成稳定错误码，不向用户暴露细节）。 */
export class ReviewPayloadError extends Error {
  constructor() {
    super('审阅结果响应格式不正确');
    this.name = 'ReviewPayloadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (!isRecord(value)) {
    throw new ReviewPayloadError();
  }
  return value;
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw new ReviewPayloadError();
  }
  return value;
}

function requireNullableString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ReviewPayloadError();
  }
  return value;
}

function requireNonNegativeInteger(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ReviewPayloadError();
  }
  return value;
}

function requireNullableBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'boolean') {
    throw new ReviewPayloadError();
  }
  return value;
}

/** ISO-8601 时间戳（只检查可解析性，不重排格式）。 */
function requireTimestamp(source: Record<string, unknown>, key: string): string {
  const value = requireString(source, key);
  if (Number.isNaN(Date.parse(value))) {
    throw new ReviewPayloadError();
  }
  return value;
}

function requireNullableTimestamp(source: Record<string, unknown>, key: string): string | null {
  if (source[key] === null) {
    return null;
  }
  return requireTimestamp(source, key);
}

function toTaskStatus(value: unknown): ReviewTaskStatus {
  for (const status of TASK_STATUSES) {
    if (status === value) {
      return status;
    }
  }
  throw new ReviewPayloadError();
}

function toTaskStep(value: unknown): ReviewTaskStep | null {
  if (value === null) {
    return null;
  }
  for (const step of TASK_STEPS) {
    if (step === value) {
      return step;
    }
  }
  throw new ReviewPayloadError();
}

function toRunStatus(value: unknown): ReviewRunStatus {
  for (const status of RUN_STATUSES) {
    if (status === value) {
      return status;
    }
  }
  throw new ReviewPayloadError();
}

function parseTask(value: unknown): ChapterReviewTaskView {
  if (!isRecord(value)) {
    throw new ReviewPayloadError();
  }
  return {
    id: requireString(value, 'id'),
    status: toTaskStatus(value['status']),
    currentStep: toTaskStep(value['currentStep']),
    attemptCount: requireNonNegativeInteger(value, 'attemptCount'),
    errorCode: requireNullableString(value, 'errorCode'),
  };
}

function parseIssues(value: unknown): ChapterReviewIssueView[] {
  if (!Array.isArray(value)) {
    throw new ReviewPayloadError();
  }
  const issues: ChapterReviewIssueView[] = [];
  let previousOrdinal = -1;
  for (const item of value) {
    if (!isRecord(item)) {
      throw new ReviewPayloadError();
    }
    const ordinal = requireNonNegativeInteger(item, 'ordinal');
    // 严格升序：顺序是契约的一部分（UI 直接按顺序展示）。
    if (ordinal <= previousOrdinal) {
      throw new ReviewPayloadError();
    }
    previousOrdinal = ordinal;
    issues.push({
      id: requireString(item, 'id'),
      ordinal,
      severity: requireString(item, 'severity'),
      type: requireString(item, 'type'),
      evidence: requireString(item, 'evidence'),
      suggestion: requireString(item, 'suggestion'),
    });
  }
  return issues;
}

function parseRun(value: unknown): ChapterReviewRunView | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new ReviewPayloadError();
  }
  const status = toRunStatus(value['status']);
  const passed = requireNullableBoolean(value, 'passed');
  const issues = parseIssues(value['issues']);
  const issueCount = requireNonNegativeInteger(value, 'issueCount');

  // 结论自洽：成功才有 passed，且 issueCount 必须等于本次返回的问题数。
  if (status === 'succeeded') {
    if (passed === null || issueCount !== issues.length) {
      throw new ReviewPayloadError();
    }
  } else if (passed !== null || issues.length > 0 || issueCount !== 0) {
    throw new ReviewPayloadError();
  }

  return {
    id: requireString(value, 'id'),
    status,
    passed,
    issueCount,
    errorCode: requireNullableString(value, 'errorCode'),
    agentName: requireString(value, 'agentName'),
    agentVersion: requireString(value, 'agentVersion'),
    startedAt: requireTimestamp(value, 'startedAt'),
    finishedAt: requireNullableTimestamp(value, 'finishedAt'),
    issues,
  };
}

/**
 * 解析 `GET /candidates/:candidateId/review` 的响应体。
 *
 * 任何字段缺失、类型不符或结论不自洽都整份拒绝（`ReviewPayloadError`），
 * 调用方据此返回稳定错误码，不展示半截审阅结果。
 */
export function parseChapterReview(body: unknown): ChapterReviewView {
  if (!isRecord(body)) {
    throw new ReviewPayloadError();
  }
  const review = requireRecord(body, 'review');
  return {
    candidateId: requireString(review, 'candidateId'),
    task: parseTask(review['task']),
    run: parseRun(review['run']),
  };
}
