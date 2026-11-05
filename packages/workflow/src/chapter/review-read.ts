/**
 * Reviewer 结果的只读查询（A2-C-D）。
 *
 * 定位：
 * - 只读：**不触发审阅、不重试、不采纳、不写审计**，也不修改 task / run / issue；
 * - 只暴露稳定 DTO，不把 Prisma row 直接交给 HTTP 层；
 * - 不返回正文全文、prompt、模型原始响应、provider / model、租约或 attempt token，
 *   也不返回 inputSnapshot / inputHash / requestId 等内部任务字段；
 * - 跨作品 / 跨章节 / 错候选 / 没有审阅任务一律 404，不通过错误码泄露存在性。
 */

import { AuthError } from '@novel/auth';
import { Prisma, type PrismaClient } from '@novel/db';
import { normalizeUuid, requireOwnedWork } from '@novel/works';

import { NonRetryableTaskError } from '../errors.js';
import { reviewTaskRequestId } from './persistence.js';
import { MAX_REVIEW_ISSUES } from './reviewer.js';
import { requireChapterInWork } from './service.js';
import { CHAPTER_REVIEW_TASK_TYPE } from './types.js';

export { MAX_REVIEW_ISSUES };

/** `chapter.review` 任务的公开状态（数据库 CHECK 同集合）。 */
export const REVIEW_TASK_STATUSES = [
  'queued',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type ReviewTaskStatus = (typeof REVIEW_TASK_STATUSES)[number];

/** `chapter.review` 的固定三步；其它步骤名一律不对外回显。 */
export const REVIEW_TASK_STEPS = [
  'load_review_input',
  'run_reviewer',
  'persist_review_result',
] as const;

export type ReviewTaskStep = (typeof REVIEW_TASK_STEPS)[number];

/** review run 的状态（数据库 CHECK 同集合）。 */
export const REVIEW_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;

export type ReviewRunStatus = (typeof REVIEW_RUN_STATUSES)[number];

/** 审阅任务的公开视图（不含 requestId / inputSnapshot / inputHash / 租约）。 */
export interface ChapterReviewTaskView {
  readonly id: string;
  readonly status: ReviewTaskStatus;
  readonly currentStep: ReviewTaskStep | null;
  readonly attemptCount: number;
  /** 只回显稳定错误码；内部 / 历史值一律 null。 */
  readonly errorCode: string | null;
}

/** 一条审阅问题的公开视图（evidence 就是问题证据，按已落库内容返回）。 */
export interface ChapterReviewIssueView {
  readonly id: string;
  readonly ordinal: number;
  readonly severity: string;
  readonly type: string;
  readonly evidence: string;
  readonly suggestion: string;
}

/** 一次审阅运行的公开视图。 */
export interface ChapterReviewRunView {
  readonly id: string;
  readonly status: ReviewRunStatus;
  /** 只有 `succeeded` 才有结论；`running` / `failed` 为 null。 */
  readonly passed: boolean | null;
  readonly issueCount: number;
  readonly errorCode: string | null;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** `ordinal` 升序；`succeeded` 之前为空数组。 */
  readonly issues: readonly ChapterReviewIssueView[];
}

/** 候选对应的审阅结果。`run === null` 表示任务已入队但审阅尚未开始（可轮询）。 */
export interface ChapterReviewView {
  readonly candidateId: string;
  readonly task: ChapterReviewTaskView;
  readonly run: ChapterReviewRunView | null;
}

/**
 * 允许回显给客户端的审阅错误码白名单。
 *
 * 与 `chapter.review` 实际可能落库的稳定码一致；任何不在表内的值（历史遗留、
 * 未经审核的新码）一律收敛成 null，避免把内部细节当成契约。
 */
const STABLE_REVIEW_ERROR_CODES = new Set([
  'MODEL_NOT_CONFIGURED',
  'MODEL_NETWORK_ERROR',
  'MODEL_TIMEOUT',
  'MODEL_ABORTED',
  'MODEL_HTTP_ERROR',
  'MODEL_INVALID_RESPONSE',
  'AGENT_INPUT_INVALID',
  'AGENT_OUTPUT_INVALID',
  'TASK_INPUT_INVALID',
  'TASK_VALIDATION_FAILED',
  'TASK_MODEL_CONFIG_MISMATCH',
  'TASK_LEASE_LOST',
  'TASK_CANCELLED',
  'WORKFLOW_NOT_REGISTERED',
  'WORKFLOW_STEP_FAILED',
  'WORKFLOW_INTERNAL_ERROR',
]);

export interface GetChapterReviewInput {
  readonly db: PrismaClient;
  readonly workId: string;
  readonly authorId: string;
  readonly chapterId: string;
  readonly candidateId: string;
}

/**
 * 读取候选对应的审阅任务状态、run 与 issues（只读）。
 *
 * 一致读取：候选归属、任务、run、issues 在**同一个 RepeatableRead 事务**里查完，
 * 避免出现"task 已 succeeded、run 还是上一 attempt 的 running"这类跨快照组合。
 *
 * 404 语义（统一 `REVIEW_NOT_FOUND`，不区分"不存在"与"不是你的"）：
 * - 候选不属于该作品 / 该章节；
 * - 候选没有 `chapter.review` 任务（A2-C-B 之前的历史候选）；
 * - 任务快照与路径候选不一致（数据异常）。
 */
export async function getChapterReviewForAuthor(
  input: GetChapterReviewInput,
): Promise<ChapterReviewView> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const candidateId = normalizeUuid(input.candidateId, '候选 id');

  await requireOwnedWork(input.db, workId, input.authorId);
  await requireChapterInWork(input.db, workId, chapterId);

  return input.db.$transaction(
    async (tx) => {
      const candidate = await tx.chapterCandidate.findFirst({
        where: { id: candidateId, workId, chapterId },
        select: { id: true },
      });
      if (candidate === null) {
        throw reviewNotFound();
      }

      // 任务通过**确定性 requestId + taskType** 定位：作者显式创建的任务也可以
      // 使用任意 requestId，只看 requestId 会把 chapter.draft 任务当成审阅任务。
      const task = await tx.generationTask.findFirst({
        where: {
          workId,
          chapterId,
          taskType: CHAPTER_REVIEW_TASK_TYPE,
          requestId: reviewTaskRequestId(candidateId),
        },
        select: {
          id: true,
          status: true,
          currentStep: true,
          attemptCount: true,
          errorCode: true,
          inputSnapshot: true,
        },
      });
      if (task === null || !taskBelongsToCandidate(task.inputSnapshot, candidateId)) {
        throw reviewNotFound();
      }

      const run = await tx.chapterReviewRun.findFirst({
        where: { candidateId, generationTaskId: task.id, workId, chapterId },
        select: {
          id: true,
          status: true,
          passed: true,
          issueCount: true,
          errorCode: true,
          agentName: true,
          agentVersion: true,
          startedAt: true,
          finishedAt: true,
        },
      });

      const issues =
        run !== null && run.status === 'succeeded'
          ? await tx.chapterReviewIssue.findMany({
              where: { runId: run.id, candidateId, workId, chapterId },
              orderBy: { ordinal: 'asc' },
              take: MAX_REVIEW_ISSUES,
              select: {
                id: true,
                ordinal: true,
                severity: true,
                type: true,
                evidence: true,
                suggestion: true,
              },
            })
          : [];

      return {
        candidateId,
        task: {
          id: task.id,
          status: toTaskStatus(task.status),
          currentStep: toTaskStep(task.currentStep),
          attemptCount: task.attemptCount,
          errorCode: toStableErrorCode(task.errorCode),
        },
        run:
          run === null
            ? null
            : {
                id: run.id,
                status: toRunStatus(run.status),
                passed: run.passed,
                issueCount: run.issueCount,
                errorCode: toStableErrorCode(run.errorCode),
                agentName: run.agentName,
                agentVersion: run.agentVersion,
                startedAt: run.startedAt.toISOString(),
                finishedAt: run.finishedAt?.toISOString() ?? null,
                issues: issues.map(toIssueView),
              },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** 统一的 404：不区分"候选不存在"、"不是你的"与"没有审阅任务"。 */
function reviewNotFound(): AuthError {
  return new AuthError('REVIEW_NOT_FOUND');
}

/**
 * 任务快照里的 `candidateId` 必须与路径候选一致。
 *
 * `requestId` 由作者可控的任务也能使用，因此不能只凭 requestId 认定归属。
 */
function taskBelongsToCandidate(snapshot: Prisma.JsonValue, candidateId: string): boolean {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return false;
  }
  const value = (snapshot as Record<string, unknown>)['candidateId'];
  return typeof value === 'string' && value.toLowerCase() === candidateId;
}

function toTaskStatus(value: string): ReviewTaskStatus {
  for (const status of REVIEW_TASK_STATUSES) {
    if (status === value) {
      return status;
    }
  }
  // 数据库 CHECK 保证不会出现；真出现说明数据被绕过服务层写入，按内部错误处理，
  // 不伪装成 404（否则会被误读成"没有审阅结果"）。
  throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '审阅任务状态不合法');
}

function toTaskStep(value: string | null): ReviewTaskStep | null {
  if (value === null) {
    return null;
  }
  for (const step of REVIEW_TASK_STEPS) {
    if (step === value) {
      return step;
    }
  }
  // 未知步骤名（未来工作流或数据异常）不对外回显。
  return null;
}

function toRunStatus(value: string): ReviewRunStatus {
  for (const status of REVIEW_RUN_STATUSES) {
    if (status === value) {
      return status;
    }
  }
  throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '审阅运行状态不合法');
}

/** 只返回稳定错误码；其它（历史 / 内部）值一律 null。 */
function toStableErrorCode(value: string | null): string | null {
  return value !== null && STABLE_REVIEW_ERROR_CODES.has(value) ? value : null;
}

function toIssueView(row: {
  readonly id: string;
  readonly ordinal: number;
  readonly severity: string;
  readonly type: string;
  readonly evidence: string;
  readonly suggestion: string;
}): ChapterReviewIssueView {
  return {
    id: row.id,
    ordinal: row.ordinal,
    severity: row.severity,
    type: row.type,
    evidence: row.evidence,
    suggestion: row.suggestion,
  };
}
