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

/**
 * 章节列表项（A1-4A）。
 *
 * 只含徽标所需的章节状态与最新任务状态，**不含正文 / 候选 / 版本**。
 */
export interface ChapterListItemView {
  readonly id: string;
  readonly workId: string;
  readonly chapterNo: number;
  readonly title: string;
  readonly status: string;
  readonly latestTaskStatus: string | null;
  readonly latestTaskStep: string | null;
  readonly updatedAt: string;
}

/** 正式版本摘要（列表用，**不含正文**）。 */
export interface ChapterVersionSummaryView {
  readonly id: string;
  readonly versionNo: number;
  /** `ai` | `human`。 */
  readonly source: string;
  readonly wordCount: number;
  readonly createdAt: string;
}

/** 正式版本详情（含正文；不含任务快照 / prompt / Key）。 */
export interface ChapterVersionDetailView extends ChapterVersionSummaryView {
  readonly chapterId: string;
  readonly content: string;
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
      // 只暴露正文生成任务：`chapter.review` 是内部任务，不能变成"最新正文任务"，
      // 否则章节详情 / 列表的徽标会被审阅任务的步骤与状态覆盖。
      where: { chapterId, workId, taskType: CHAPTER_DRAFT_TASK_TYPE },
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
 * 读取作品下的章节列表（A1-4A）。
 *
 * - 按 `chapterNo` 升序；不含正文、候选或版本内容；
 * - 只返回最新任务的 `status / currentStep`，供列表徽标使用；
 * - 他人作品 404（不区分存在性），管理员在路由层 403。
 */
export async function listChapters(input: {
  readonly db: PrismaClient;
  readonly workId: string;
  readonly authorId: string;
}): Promise<readonly ChapterListItemView[]> {
  const workId = normalizeUuid(input.workId, '作品 id');
  await requireOwnedWork(input.db, workId, input.authorId);

  const [chapters, tasks] = await Promise.all([
    input.db.chapter.findMany({
      where: { workId },
      orderBy: [{ chapterNo: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        workId: true,
        chapterNo: true,
        title: true,
        status: true,
        updatedAt: true,
      },
    }),
    input.db.generationTask.findMany({
      // 同上：列表徽标只反映正文生成，不受内部审阅任务影响。
      where: { workId, taskType: CHAPTER_DRAFT_TASK_TYPE },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { chapterId: true, status: true, currentStep: true },
    }),
  ]);

  const latestTask = new Map<string, { status: string; currentStep: string | null }>();
  for (const task of tasks) {
    if (task.chapterId !== null && !latestTask.has(task.chapterId)) {
      latestTask.set(task.chapterId, { status: task.status, currentStep: task.currentStep });
    }
  }

  return chapters.map((chapter) => {
    const task = latestTask.get(chapter.id) ?? null;
    return {
      id: chapter.id,
      workId: chapter.workId,
      chapterNo: chapter.chapterNo,
      title: chapter.title,
      status: chapter.status,
      latestTaskStatus: task?.status ?? null,
      latestTaskStep: task?.currentStep ?? null,
      updatedAt: chapter.updatedAt.toISOString(),
    };
  });
}

/**
 * 章节必须属于该作品；不存在与跨作品同样 404。
 *
 * 对包内其它模块（如版本 diff）导出，避免各自复制归属校验导致语义漂移。
 */
export async function requireChapterInWork(
  db: PrismaClient,
  workId: string,
  chapterId: string,
): Promise<void> {
  const chapter = await db.chapter.findFirst({
    where: { id: chapterId, workId },
    select: { id: true },
  });
  if (chapter === null) {
    throw new AuthError('NOT_FOUND', '章节不存在');
  }
}

/**
 * 读取章节的正式版本摘要列表（A1-4A）。
 *
 * - 按 `versionNo` 倒序（最新在前）；
 * - 只返回 id / versionNo / source / wordCount / createdAt，**不含正文**；
 * - 只允许作品作者；跨作品 / 跨章节 404。
 */
export async function listChapterVersions(input: {
  readonly db: PrismaClient;
  readonly workId: string;
  readonly authorId: string;
  readonly chapterId: string;
}): Promise<readonly ChapterVersionSummaryView[]> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  await requireOwnedWork(input.db, workId, input.authorId);
  await requireChapterInWork(input.db, workId, chapterId);

  const versions = await input.db.chapterVersion.findMany({
    where: { workId, chapterId },
    orderBy: [{ versionNo: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      versionNo: true,
      source: true,
      wordCount: true,
      createdAt: true,
    },
  });

  return versions.map((version) => ({
    id: version.id,
    versionNo: version.versionNo,
    source: version.source,
    wordCount: version.wordCount,
    createdAt: version.createdAt.toISOString(),
  }));
}

/**
 * 读取正式版本正文（A1-4A）。
 *
 * - 版本必须属于当前作品 + 当前章节，否则 404；
 * - 只返回正文与版本元信息，不含候选、任务快照、prompt、Key；
 * - `pre-wrap` 阅读由前端负责，本接口不做任何 HTML 处理。
 */
export async function getChapterVersion(input: {
  readonly db: PrismaClient;
  readonly workId: string;
  readonly authorId: string;
  readonly chapterId: string;
  readonly versionId: string;
}): Promise<ChapterVersionDetailView> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const versionId = normalizeUuid(input.versionId, '版本 id');
  await requireOwnedWork(input.db, workId, input.authorId);
  await requireChapterInWork(input.db, workId, chapterId);

  const version = await input.db.chapterVersion.findFirst({
    where: { id: versionId, workId, chapterId },
    select: {
      id: true,
      chapterId: true,
      versionNo: true,
      source: true,
      wordCount: true,
      content: true,
      createdAt: true,
    },
  });
  if (version === null) {
    throw new AuthError('NOT_FOUND', '版本不存在');
  }

  return {
    id: version.id,
    chapterId: version.chapterId,
    versionNo: version.versionNo,
    source: version.source,
    wordCount: version.wordCount,
    content: version.content,
    createdAt: version.createdAt.toISOString(),
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
 * - **幂等优先于状态**：同一 `(workId, requestId)` 已存在任务时**不检查章节状态**，
 *   直接由 `createGenerationTask` 比较 `input_hash`：
 *   同内容返回既有任务（`created=false`），异内容 `TASK_REQUEST_CONFLICT`；
 * - **只有新请求**才受章节状态限制：`finalized / abandoned` → 409
 *   `CHAPTER_STATE_INVALID_FOR_GENERATION`，不建任务、不写审计；
 * - 新请求创建过程中章节被并发关闭的竞态，仍由 Worker 侧
 *   （`buildChapterDraftContext` / `ensureChapterStatus`）兜底。
 */
export async function startChapterDraft(
  input: StartChapterDraftInput,
): Promise<{ readonly task: ChapterTaskSummaryView; readonly created: boolean }> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const requestId = assertRequestId(input.requestId);

  // 先校验作品归属：非作者不能通过任何错误码探测他人作品 / 章节。
  await requireOwnedWork(input.db, workId, input.authorId);

  const snapshot: { targetWords?: number; style?: Partial<ChapterStyle> } = {};
  if (input.targetWords !== undefined) {
    snapshot.targetWords = input.targetWords;
  }
  if (input.style !== undefined) {
    snapshot.style = input.style;
  }

  // 幂等优先：已有同 requestId 的任务时跳过章节状态检查。
  // 这里不自己比较 input_hash，统一交给 createGenerationTask ——
  // 避免两条路径的哈希口径漂移（尤其是旧任务）。
  const existing = await input.db.generationTask.findUnique({
    where: { workId_requestId: { workId, requestId } },
    select: { id: true },
  });
  if (existing === null) {
    // 只有新请求才受章节关闭限制。
    await assertChapterOpenForGeneration(input.db, workId, chapterId);
  }

  const { task, created } = await createGenerationTask(input.db, {
    authorId: input.authorId,
    workId,
    chapterId,
    requestId,
    taskType: CHAPTER_DRAFT_TASK_TYPE,
    inputSnapshot: snapshot,
    provider: input.provider,
    model: input.model,
  });

  return { task: toTaskSummary(task), created };
}

/** 读取 requestId 并校验长度（1..128，与数据库 CHECK 一致）。 */
function assertRequestId(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new AuthError('VALIDATION_FAILED', 'requestId 长度必须在 1..128');
  }
  return value;
}

/** 新请求的章节状态闸门：章节必须存在且处于开放状态。 */
async function assertChapterOpenForGeneration(
  db: PrismaClient,
  workId: string,
  chapterId: string,
): Promise<void> {
  const chapter = await db.chapter.findFirst({
    where: { id: chapterId, workId },
    select: { status: true },
  });
  if (chapter === null) {
    throw new AuthError('NOT_FOUND', '章节不存在');
  }
  if (!isChapterOpenForGeneration(chapter.status)) {
    throw new AuthError('CHAPTER_STATE_INVALID_FOR_GENERATION');
  }
}
