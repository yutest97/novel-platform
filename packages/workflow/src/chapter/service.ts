/**
 * 章节 / 生成任务 / 候选的服务层（A1-3B）。
 *
 * 边界：
 * - `authorId` 只来自会话，任何函数都不接受请求体里的作者字段；
 * - 他人作品一律 404（不区分"不存在"与"不属于你"），管理员在路由层就 403；
 * - 章节创建走作品级 advisory lock：章号唯一由数据库兜底，冲突翻译成
 *   `CHAPTER_NO_TAKEN`；
 * - 生成任务只写 `input_snapshot = { targetWords?, style? }`，
 *   **不含** provider / model / Key / prompt；
 * - 候选读取只返回正文、字数、结构化计划与状态，不返回任务快照或模型内部信息。
 */

import { AUDIT_ACTIONS, AuthError, writeAuditLog } from '@novel/auth';
import type { PrismaClient } from '@novel/db';
import {
  normalizeUuid,
  requireOwnedWork,
  runWorkWrite,
  uniqueConstraintMarker,
} from '@novel/works';

import { createGenerationTask, toGenerationTaskView, type GenerationTaskView } from '../queue.js';
import { CHAPTER_DRAFT_TASK_TYPE, isChapterOpenForGeneration, type ChapterStyle } from './types.js';

/** 章节标题上限（与数据库 CHECK 一致）。 */
export const MAX_CHAPTER_TITLE_LENGTH = 200;

/** 章号上限：只是把 int32 溢出挡在服务层，业务上足够。 */
export const MAX_CHAPTER_NO = 1_000_000;

/** 章节摘要。 */
export interface ChapterSummaryView {
  readonly id: string;
  readonly workId: string;
  readonly chapterNo: number;
  readonly title: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 生成任务摘要（**不含** inputSnapshot / inputHash / requestId / 租约字段）。 */
export interface ChapterTaskSummaryView {
  readonly id: string;
  readonly chapterId: string | null;
  readonly status: string;
  readonly currentStep: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly cancelRequestedAt: string | null;
  readonly errorCode: string | null;
  /** 服务端映射后的安全文案；永不包含模型原始错误。 */
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 章节详情里的一条候选摘要（不含正文）。 */
export interface ChapterCandidateSummaryView {
  readonly id: string;
  readonly status: string;
  readonly wordCount: number;
  readonly createdAt: string;
}

/** 章节详情：章节 + 最新任务摘要 + 候选摘要列表。 */
export interface ChapterDetailView {
  readonly chapter: ChapterSummaryView;
  readonly latestTask: ChapterTaskSummaryView | null;
  readonly candidates: readonly ChapterCandidateSummaryView[];
}

/** 候选详情（含正文与结构化计划）。 */
export interface ChapterCandidateDetailView {
  readonly id: string;
  readonly chapterId: string;
  readonly contractId: string;
  readonly status: string;
  readonly wordCount: number;
  readonly content: string;
  readonly structuredPlan: unknown;
  readonly createdAt: string;
}

interface ChapterRow {
  id: string;
  workId: string;
  chapterNo: number;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

function toChapterView(row: ChapterRow): ChapterSummaryView {
  return {
    id: row.id,
    workId: row.workId,
    chapterNo: row.chapterNo,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 任务视图 → API 摘要。
 *
 * 刻意**丢掉** `inputSnapshot` / `inputHash` / `requestId` / `lockedBy` /
 * `leaseUntil` / `heartbeatAt`：这些是服务端调度与幂等内部字段，
 * 不需要、也不应该出现在作者界面上。
 */
export function toTaskSummary(task: GenerationTaskView): ChapterTaskSummaryView {
  return {
    id: task.id,
    chapterId: task.chapterId,
    status: task.status,
    currentStep: task.currentStep,
    attemptCount: task.attemptCount,
    maxAttempts: task.maxAttempts,
    cancelRequestedAt: task.cancelRequestedAt,
    errorCode: task.errorCode,
    errorMessage: task.errorMessageSanitized,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function assertChapterNo(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CHAPTER_NO) {
    throw new AuthError('VALIDATION_FAILED', `chapterNo 必须是 1..${MAX_CHAPTER_NO} 的整数`);
  }
  return value;
}

function normalizeChapterTitle(value: string): string {
  const title = value.trim();
  if (title === '') {
    throw new AuthError('VALIDATION_FAILED', 'title 不能为空');
  }
  if (title.length > MAX_CHAPTER_TITLE_LENGTH) {
    throw new AuthError('VALIDATION_FAILED', `title 不能超过 ${MAX_CHAPTER_TITLE_LENGTH} 个字符`);
  }
  return title;
}

export interface CreateChapterInput {
  readonly db: PrismaClient;
  readonly workId: string;
  readonly authorId: string;
  readonly chapterNo: number;
  readonly title: string;
  readonly meta?: { readonly ip?: string | null; readonly userAgent?: string | null };
}

/**
 * 创建章节。
 *
 * - 只有作品作者可以创建（他人作品 404）；
 * - 初始 `status = planned`，状态与时间戳都不接受客户端提交；
 * - 章号在作品内唯一，冲突返回稳定 `CHAPTER_NO_TAKEN`（409）；
 * - 创建 + `chapter.created` 审计同事务，审计 detail 只含 workId/chapterId/chapterNo。
 */
export async function createChapter(input: CreateChapterInput): Promise<ChapterSummaryView> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterNo = assertChapterNo(input.chapterNo);
  const title = normalizeChapterTitle(input.title);

  try {
    return await runWorkWrite(input.db, workId, async (tx) => {
      await requireOwnedWork(tx, workId, input.authorId);

      const created = await tx.chapter.create({
        data: { workId, chapterNo, title, status: 'planned' },
        select: {
          id: true,
          workId: true,
          chapterNo: true,
          title: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.CHAPTER_CREATED,
        actorId: input.authorId,
        targetType: 'chapter',
        targetId: created.id,
        detail: { workId, chapterId: created.id, chapterNo },
        ip: input.meta?.ip ?? null,
        userAgent: input.meta?.userAgent ?? null,
      });

      return toChapterView(created);
    });
  } catch (error) {
    // 同作品章号唯一索引；锁内正常不会撞，数据库仍是最后一道闸门。
    if (uniqueConstraintMarker(error) !== null) {
      throw new AuthError('CHAPTER_NO_TAKEN');
    }
    throw error;
  }
}

/** 读取章节详情（章节 + 最新任务摘要 + 候选摘要列表）。 */
export async function getChapterDetail(input: {
  readonly db: PrismaClient;
  readonly workId: string;
  readonly authorId: string;
  readonly chapterId: string;
}): Promise<ChapterDetailView> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');

  await requireOwnedWork(input.db, workId, input.authorId);

  const chapter = await input.db.chapter.findFirst({
    where: { id: chapterId, workId },
    select: {
      id: true,
      workId: true,
      chapterNo: true,
      title: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (chapter === null) {
    throw new AuthError('NOT_FOUND', '章节不存在');
  }

  const [latestTask, candidates] = await Promise.all([
    input.db.generationTask.findFirst({
      where: { chapterId, workId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    input.db.chapterCandidate.findMany({
      where: { chapterId, workId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true, wordCount: true, createdAt: true },
    }),
  ]);

  return {
    chapter: toChapterView(chapter),
    latestTask: latestTask === null ? null : toTaskSummary(toGenerationTaskView(latestTask)),
    candidates: candidates.map((row) => ({
      id: row.id,
      status: row.status,
      wordCount: row.wordCount,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/**
 * 读取候选详情。
 *
 * - 候选必须属于**当前作品 + 当前章节**；跨作品 / 跨章节一律 `CHAPTER_CANDIDATE_NOT_FOUND`；
 * - 已 adopted 的候选仍可读取（用于确认正式版本来源）；
 * - 只返回正文、字数、结构化计划与状态，不含任务快照、prompt 或模型原始响应。
 */
export async function getChapterCandidate(input: {
  readonly db: PrismaClient;
  readonly workId: string;
  readonly authorId: string;
  readonly chapterId: string;
  readonly candidateId: string;
}): Promise<ChapterCandidateDetailView> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const candidateId = normalizeUuid(input.candidateId, '候选 id');

  await requireOwnedWork(input.db, workId, input.authorId);

  const chapter = await input.db.chapter.findFirst({
    where: { id: chapterId, workId },
    select: { id: true },
  });
  if (chapter === null) {
    throw new AuthError('NOT_FOUND', '章节不存在');
  }

  const candidate = await input.db.chapterCandidate.findFirst({
    where: { id: candidateId, workId, chapterId },
    select: {
      id: true,
      chapterId: true,
      contractId: true,
      status: true,
      wordCount: true,
      content: true,
      structuredPlan: true,
      createdAt: true,
    },
  });
  if (candidate === null) {
    throw new AuthError('CHAPTER_CANDIDATE_NOT_FOUND');
  }

  return {
    id: candidate.id,
    chapterId: candidate.chapterId,
    contractId: candidate.contractId,
    status: candidate.status,
    wordCount: candidate.wordCount,
    content: candidate.content,
    structuredPlan: candidate.structuredPlan,
    createdAt: candidate.createdAt.toISOString(),
  };
}

export interface StartChapterDraftInput {
  readonly db: PrismaClient;
  readonly workId: string;
  readonly authorId: string;
  readonly chapterId: string;
  readonly requestId: string;
  readonly targetWords?: number;
  readonly style?: Partial<ChapterStyle>;
  /** 服务端配置解析出的 provider 名称（客户端不可提交）。 */
  readonly provider: string;
  /** 服务端配置解析出的实际模型名（客户端不可提交）。 */
  readonly model: string;
}

/**
 * 创建 `chapter.draft` 生成任务。
 *
 * - `input_snapshot` 只含 `targetWords` / `style`；
 * - provider / model 由调用方从**服务端配置**解析后传入，请求体永远不参与；
 * - **状态闸门**：`finalized / abandoned` 章节直接 409，不建任务、不写审计；
 *   Worker 侧还有第二道检查，覆盖"排队期间被定稿"的竞态；
 * - 同一 `(workId, requestId)` 同内容返回既有任务（`created=false`），
 *   不同内容由 `createGenerationTask` 返回 `TASK_REQUEST_CONFLICT`。
 */
export async function startChapterDraft(
  input: StartChapterDraftInput,
): Promise<{ readonly task: ChapterTaskSummaryView; readonly created: boolean }> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');

  // 先校验作品归属：非作者不能通过状态码探测他人章节是否存在。
  await requireOwnedWork(input.db, workId, input.authorId);
  const chapter = await input.db.chapter.findFirst({
    where: { id: chapterId, workId },
    select: { status: true },
  });
  if (chapter === null) {
    throw new AuthError('NOT_FOUND', '章节不存在');
  }
  if (!isChapterOpenForGeneration(chapter.status)) {
    throw new AuthError('CHAPTER_STATE_INVALID_FOR_GENERATION');
  }

  const snapshot: { targetWords?: number; style?: Partial<ChapterStyle> } = {};
  if (input.targetWords !== undefined) {
    snapshot.targetWords = input.targetWords;
  }
  if (input.style !== undefined) {
    snapshot.style = input.style;
  }

  const { task, created } = await createGenerationTask(input.db, {
    authorId: input.authorId,
    workId,
    chapterId,
    requestId: input.requestId,
    taskType: CHAPTER_DRAFT_TASK_TYPE,
    inputSnapshot: snapshot,
    provider: input.provider,
    model: input.model,
  });

  return { task: toTaskSummary(task), created };
}
