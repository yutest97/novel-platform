/**
 * 定稿章节摘要的输入装配与持久化（A2-D-B）。
 *
 * 定位：
 * - 把「当前定稿的最新正式版本正文」装成 `summarizer.chapter` 输入；
 * - `chapter.summarize` 任务由 `finalizeChapter` 在同一事务内入队；
 * - 摘要按 `source_version_id` 幂等落库，append-only、可追溯；
 * - 所有写入都用任务行锁 + `locked_by` 做 fencing：旧 Worker、丢租约、取消后
 *   晚返回都写不进摘要。
 *
 * 边界：
 * - 正文只在内存与模型请求中存在，不进入任务快照、task_contexts、日志或摘要行；
 * - 摘要不修改章节状态、正式版本、候选、合同或采纳权；
 * - 不写 audit_logs：任务、`llm_call_logs` 与摘要行就是追溯记录。
 */

import type { Prisma, PrismaClient } from '@novel/db';
import { runWorkWrite } from '@novel/works';

import { NonRetryableTaskError } from '../errors.js';
import {
  assertTaskFence,
  ensureDeterministicTask,
  type ModelTaskSpec,
  type TaskFenceScope,
} from './persistence.js';
import {
  assertSummarizerInput,
  SUMMARIZER_CHAPTER_AGENT,
  type ChapterSummarizerInput,
  type ChapterSummarizerOutput,
} from './summarizer.js';
import {
  CHAPTER_SUMMARY_TASK_TYPE,
  FINALIZED_CHAPTER_STATUS,
  type ContextSource,
} from './types.js';

/** 摘要任务 requestId（确定性、总长 ≤128）。 */
export function summaryTaskRequestId(sourceVersionId: string): string {
  return `summary:${sourceVersionId}`;
}

/** 在**当前事务内**幂等确保 `chapter.summarize` 任务存在。 */
export async function ensureSummaryTask(
  tx: Prisma.TransactionClient,
  input: {
    readonly workId: string;
    readonly chapterId: string;
    readonly sourceVersionId: string;
    readonly spec: ModelTaskSpec;
  },
): Promise<{ readonly taskId: string; readonly created: boolean }> {
  return ensureDeterministicTask(tx, {
    workId: input.workId,
    chapterId: input.chapterId,
    taskType: CHAPTER_SUMMARY_TASK_TYPE,
    requestId: summaryTaskRequestId(input.sourceVersionId),
    inputSnapshot: { sourceVersionId: input.sourceVersionId },
    spec: input.spec,
  });
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 摘要任务的归属信息。 */
export interface SummaryTaskFence extends TaskFenceScope {
  readonly sourceVersionId: string;
}

/** 任务输入：只允许 `sourceVersionId`。 */
export interface ChapterSummaryTaskInput {
  readonly sourceVersionId: string;
}

/**
 * 解析 `chapter.summarize` 任务输入。
 *
 * 未知字段、非 UUID、缺少 sourceVersionId 一律拒绝（不可重试：任务行由服务端
 * 产生，输入非法说明任务被绕过服务层写入）。
 */
export function parseChapterSummaryTaskInput(value: unknown): ChapterSummaryTaskInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NonRetryableTaskError('TASK_INPUT_INVALID', 'summary 任务输入必须是对象');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'sourceVersionId') {
      throw new NonRetryableTaskError('TASK_INPUT_INVALID', `不支持的输入字段 ${key}`);
    }
  }
  const sourceVersionId = record['sourceVersionId'];
  if (typeof sourceVersionId !== 'string' || !UUID_PATTERN.test(sourceVersionId)) {
    throw new NonRetryableTaskError('TASK_INPUT_INVALID', 'sourceVersionId 必须是 UUID');
  }
  return { sourceVersionId: sourceVersionId.toLowerCase() };
}

/** 装配好的摘要上下文（`agentInput.chapterText` 含正文，只在内存中流转）。 */
export interface ChapterSummaryContext {
  readonly sourceVersionId: string;
  readonly versionNo: number;
  readonly wordCount: number;
  readonly agentInput: ChapterSummarizerInput;
  readonly sources: readonly ContextSource[];
}

const RANK_CHAPTER = 1;
const RANK_VERSION = 2;

/**
 * 读取并校验摘要输入。
 *
 * 校验顺序（任一失败都不写任何行）：
 * 1. 章节属于该作品，且当前 `status = 'finalized'`；
 * 2. `sourceVersionId` 是该章节当前最新正式版本（人工 revision / 再定稿会让它变 stale）；
 * 3. 版本正文用于模型输入，不落库、不记日志。
 */
export async function loadChapterSummaryContext(
  db: Prisma.TransactionClient,
  input: { readonly workId: string; readonly chapterId: string; readonly sourceVersionId: string },
): Promise<ChapterSummaryContext> {
  const { workId, chapterId, sourceVersionId } = input;

  const chapter = await db.chapter.findFirst({
    where: { id: chapterId, workId },
    select: { id: true, chapterNo: true, title: true, status: true },
  });
  if (chapter === null) {
    throw new NonRetryableTaskError('TASK_INPUT_INVALID', '章节不存在');
  }
  if (chapter.status !== FINALIZED_CHAPTER_STATUS) {
    throw new NonRetryableTaskError('SUMMARY_CHAPTER_NOT_FINALIZED');
  }

  const latest = await db.chapterVersion.findFirst({
    where: { workId, chapterId },
    orderBy: { versionNo: 'desc' },
    select: { id: true, versionNo: true, wordCount: true, content: true },
  });
  if (latest === null) {
    throw new NonRetryableTaskError('SUMMARY_CHAPTER_NOT_FINALIZED');
  }
  if (latest.id !== sourceVersionId) {
    throw new NonRetryableTaskError('SUMMARY_SOURCE_VERSION_STALE');
  }

  const agentInput: ChapterSummarizerInput = {
    chapter: {
      id: chapter.id,
      chapterNo: chapter.chapterNo,
      title: chapter.title,
    },
    sourceVersion: {
      id: latest.id,
      versionNo: latest.versionNo,
    },
    chapterText: latest.content,
  };
  // 与工作流步骤共用同一套输入契约（标题 trim、正文长度等）。
  assertSummarizerInput(agentInput);

  return {
    sourceVersionId: latest.id,
    versionNo: latest.versionNo,
    wordCount: latest.wordCount,
    agentInput,
    sources: [
      {
        contextType: 'chapter',
        refId: chapter.id,
        snippet: `第${chapter.chapterNo}章《${chapter.title}》`,
        rank: RANK_CHAPTER,
      },
      {
        contextType: 'chapter_version',
        refId: latest.id,
        snippet: `正式版本 v${latest.versionNo}｜${latest.wordCount} 字`,
        rank: RANK_VERSION,
      },
    ],
  };
}

/** 摘要是否已存在（幂等读取；同版本只生成一次）。 */
export async function findExistingSummary(
  db: Pick<PrismaClient, 'chapterSummary'>,
  sourceVersionId: string,
): Promise<{ readonly id: string } | null> {
  const row = await db.chapterSummary.findUnique({
    where: { sourceVersionId },
    select: { id: true },
  });
  return row === null ? null : { id: row.id };
}

export interface PersistChapterSummaryInput {
  readonly db: PrismaClient;
  readonly fence: SummaryTaskFence;
  readonly output: ChapterSummarizerOutput;
  /** 本次实际 Provider 返回的 provider / model。 */
  readonly provider: string;
  readonly model: string;
}

/**
 * 写入摘要（`persist_summary`）。
 *
 * - 任务行锁 + `locked_by` fencing 通过后才写；
 * - 同一事务内**再次**校验章节仍定稿、sourceVersion 仍是最新（模型调用期间可能
 *   发生人工 revision / 再定稿）；
 * - 已存在同版本摘要 → 直接返回（不重复插入）；
 * - 不修改章节、版本、候选、合同或采纳状态，不写 audit_logs。
 */
export async function persistChapterSummary(input: PersistChapterSummaryInput): Promise<void> {
  const { db, fence, output, provider, model } = input;
  await runWorkWrite(db, fence.workId, async (tx) => {
    await assertTaskFence(tx, fence);

    const chapter = await tx.chapter.findFirst({
      where: { id: fence.chapterId, workId: fence.workId },
      select: { status: true },
    });
    if (chapter === null) {
      throw new NonRetryableTaskError('TASK_INPUT_INVALID', '章节不存在');
    }

    // 先判版本、再判定稿：人工 revision 会同时造成"章节回到 in_review"和
    // "出现更新的版本"，此时「版本过期」是更具体、更可操作的错误。
    const latest = await tx.chapterVersion.findFirst({
      where: { workId: fence.workId, chapterId: fence.chapterId },
      orderBy: { versionNo: 'desc' },
      select: { id: true },
    });
    if (latest === null) {
      throw new NonRetryableTaskError('SUMMARY_CHAPTER_NOT_FINALIZED');
    }
    if (latest.id !== fence.sourceVersionId) {
      throw new NonRetryableTaskError('SUMMARY_SOURCE_VERSION_STALE');
    }
    if (chapter.status !== FINALIZED_CHAPTER_STATUS) {
      throw new NonRetryableTaskError('SUMMARY_CHAPTER_NOT_FINALIZED');
    }

    const existing = await tx.chapterSummary.findUnique({
      where: { sourceVersionId: fence.sourceVersionId },
      select: { id: true },
    });
    if (existing !== null) {
      return;
    }

    await tx.chapterSummary.create({
      data: {
        workId: fence.workId,
        chapterId: fence.chapterId,
        sourceVersionId: fence.sourceVersionId,
        agentName: SUMMARIZER_CHAPTER_AGENT.name,
        agentVersion: SUMMARIZER_CHAPTER_AGENT.promptVersion,
        provider,
        model,
        summary: output.summary,
      },
      select: { id: true },
    });
  });
}
