/**
 * 章节合同 / 候选的持久化（A1-2）。
 *
 * 每个写入型步骤都遵循同一套边界：
 * 1. `runWorkWrite` 开事务并取作品级 advisory lock（与设定 / 物品事件共用）；
 * 2. 事务内 `SELECT ... FOR UPDATE` 锁住 generation_task 并确认
 *    `locked_by = 当前 Worker`、`status = processing`、未被取消（fencing）；
 * 3. 合同 / 候选写入、章节状态变更、审计在**同一个事务**里提交；
 * 4. 重试时按 `generation_task_id` 复用既有行，不重复插入、不重复审计。
 */

import { AUDIT_ACTIONS, writeAuditLog } from '@novel/auth';
import type { Prisma, PrismaClient } from '@novel/db';
import { runWorkWrite } from '@novel/works';

import { NonRetryableTaskError, TaskLeaseLostError } from '../errors.js';
import type { FrozenContract, PlannerOutput, PlannerScene, ValidatedDraft } from './types.js';

/** 写入步骤的归属信息（全部来自当前任务，不接受请求体）。 */
export interface TaskFence {
  readonly taskId: string;
  readonly workId: string;
  readonly chapterId: string;
  readonly workerId: string;
  /** 作品作者；审计 actor。 */
  readonly authorId: string;
}

type ContractRow = {
  id: string;
  workId: string;
  chapterId: string;
  generationTaskId: string;
  versionNo: number;
  goal: string;
  mustInclude: unknown;
  mustNotInclude: unknown;
  sceneBeats: unknown;
  targetWords: number;
  status: string;
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asScenes(value: unknown): PlannerScene[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const scenes: PlannerScene[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const item = raw as Record<string, unknown>;
    const purpose = item['purpose'];
    const location = item['location'];
    const conflict = item['conflict'];
    const outcome = item['outcome'];
    if (
      typeof purpose === 'string' &&
      typeof location === 'string' &&
      typeof conflict === 'string' &&
      typeof outcome === 'string'
    ) {
      scenes.push({ purpose, location, conflict, outcome });
    }
  }
  return scenes;
}

function toFrozenContract(row: ContractRow): FrozenContract {
  const beats =
    typeof row.sceneBeats === 'object' && row.sceneBeats !== null
      ? (row.sceneBeats as Record<string, unknown>)
      : {};
  const contract: FrozenContract = {
    id: row.id,
    workId: row.workId,
    chapterId: row.chapterId,
    generationTaskId: row.generationTaskId,
    versionNo: row.versionNo,
    goal: row.goal,
    mustInclude: asStringArray(row.mustInclude),
    mustNotInclude: asStringArray(row.mustNotInclude),
    characters: asStringArray(beats['characters']),
    scenes: asScenes(beats['scenes']),
    targetWords: row.targetWords,
    status: 'frozen',
  };
  if (contract.goal === '' || contract.scenes.length === 0) {
    // 冻结行由本模块写入；读出不完整说明数据被绕过服务层改过。
    throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '章节合同数据不完整');
  }
  return contract;
}

/**
 * 事务内确认任务仍归当前 Worker。
 *
 * 锁住任务行（`FOR UPDATE`）直到事务结束：
 * - 租约被抢走 / 任务被取消 → 立即抛错，不写任何业务数据；
 * - 与 Worker 的 finalize UPDATE 互斥，避免"旧 Worker 写一半、新 Worker 已完成"。
 */
async function assertTaskFence(tx: Prisma.TransactionClient, fence: TaskFence): Promise<void> {
  const rows = await tx.$queryRaw<
    {
      status: string;
      locked_by: string | null;
      cancel_requested_at: Date | null;
      work_id: string;
      chapter_id: string | null;
    }[]
  >`
    SELECT status, locked_by, cancel_requested_at, work_id, chapter_id
      FROM generation_tasks
     WHERE id = ${fence.taskId}
     FOR UPDATE
  `;
  const row = rows[0];
  if (
    row === undefined ||
    row.work_id !== fence.workId ||
    row.chapter_id !== fence.chapterId ||
    row.status !== 'processing' ||
    row.locked_by !== fence.workerId
  ) {
    throw new TaskLeaseLostError();
  }
  if (row.cancel_requested_at !== null) {
    // failTask 会看到取消标记并落到 cancelled；这里先停手，避免继续写。
    throw new NonRetryableTaskError('TASK_VALIDATION_FAILED', '任务已取消，停止写入');
  }
}

/**
 * 章节状态迁移（只允许从白名单状态升级，不降级）。
 *
 * 状态真正变化时写一条 `chapter.status_changed` 审计。
 */
async function ensureChapterStatus(
  tx: Prisma.TransactionClient,
  fence: TaskFence,
  to: string,
  allowedFrom: readonly string[],
): Promise<void> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT status
      FROM chapters
     WHERE id = ${fence.chapterId} AND work_id = ${fence.workId}
     FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new NonRetryableTaskError('TASK_INPUT_INVALID', '章节不存在');
  }
  if (row.status === to || !allowedFrom.includes(row.status)) {
    return;
  }
  await tx.chapter.updateMany({
    where: { id: fence.chapterId, workId: fence.workId },
    data: { status: to },
  });
  await writeAuditLog(tx, {
    action: AUDIT_ACTIONS.CHAPTER_STATUS_CHANGED,
    actorId: fence.authorId,
    targetType: 'chapter',
    targetId: fence.chapterId,
    detail: {
      workId: fence.workId,
      chapterId: fence.chapterId,
      taskId: fence.taskId,
      fromStatus: row.status,
      toStatus: to,
    },
  });
}

/** 读取当前任务已冻结的合同（重试复用入口）。 */
export async function loadExistingContract(
  db: Pick<PrismaClient, 'chapterContract'>,
  taskId: string,
): Promise<FrozenContract | null> {
  const row = await db.chapterContract.findUnique({ where: { generationTaskId: taskId } });
  return row === null ? null : toFrozenContract(row);
}

/** 读取当前任务已写入的候选（重试复用入口）。 */
export async function loadExistingCandidate(
  db: Pick<PrismaClient, 'chapterCandidate'>,
  taskId: string,
): Promise<{ id: string; content: string; wordCount: number } | null> {
  const row = await db.chapterCandidate.findUnique({
    where: { generationTaskId: taskId },
    select: { id: true, content: true, wordCount: true },
  });
  return row === null ? null : { id: row.id, content: row.content, wordCount: row.wordCount };
}

/**
 * 冻结章节合同。
 *
 * - 同任务已有合同 → 直接复用（不插入、不审计）；
 * - 否则取 `max(version_no)+1` 插入，并把章节推进到 `outlined`；
 * - 合同、章节状态、审计同事务。
 */
export async function freezeChapterContract(input: {
  readonly db: PrismaClient;
  readonly fence: TaskFence;
  readonly plan: PlannerOutput;
}): Promise<FrozenContract> {
  const { db, fence, plan } = input;
  return runWorkWrite(db, fence.workId, async (tx) => {
    await assertTaskFence(tx, fence);

    const existing = await tx.chapterContract.findUnique({
      where: { generationTaskId: fence.taskId },
    });
    if (existing !== null) {
      if (existing.chapterId !== fence.chapterId || existing.workId !== fence.workId) {
        throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '章节合同归属不一致');
      }
      // 崩溃恢复场景：合同已提交但章节状态可能还没补上（正常路径同事务，不会发生）。
      await ensureChapterStatus(tx, fence, 'outlined', ['planned', 'outlined']);
      return toFrozenContract(existing);
    }

    const aggregate = await tx.chapterContract.aggregate({
      where: { chapterId: fence.chapterId },
      _max: { versionNo: true },
    });
    const versionNo = (aggregate._max.versionNo ?? 0) + 1;

    const created = await tx.chapterContract.create({
      data: {
        workId: fence.workId,
        chapterId: fence.chapterId,
        generationTaskId: fence.taskId,
        versionNo,
        goal: plan.goal,
        mustInclude: plan.mustInclude as never,
        mustNotInclude: plan.mustNotInclude as never,
        sceneBeats: {
          version: 1,
          characters: plan.characters,
          scenes: plan.scenes,
        } as never,
        targetWords: plan.targetWords,
        status: 'frozen',
      },
    });

    await ensureChapterStatus(tx, fence, 'outlined', ['planned', 'outlined']);
    await writeAuditLog(tx, {
      action: AUDIT_ACTIONS.CHAPTER_CONTRACT_FROZEN,
      actorId: fence.authorId,
      targetType: 'chapter',
      targetId: fence.chapterId,
      detail: {
        workId: fence.workId,
        chapterId: fence.chapterId,
        taskId: fence.taskId,
        contractId: created.id,
        versionNo,
        targetWords: plan.targetWords,
        sceneCount: plan.scenes.length,
      },
    });
    return toFrozenContract(created);
  });
}

/** Writer 开始：章节进入 `drafting`（与审计同事务）。 */
export async function markChapterDrafting(input: {
  readonly db: PrismaClient;
  readonly fence: TaskFence;
}): Promise<void> {
  const { db, fence } = input;
  await runWorkWrite(db, fence.workId, async (tx) => {
    await assertTaskFence(tx, fence);
    await ensureChapterStatus(tx, fence, 'drafting', ['planned', 'outlined', 'drafting']);
  });
}

/**
 * 写入正文候选。
 *
 * - 同任务已有候选 → 直接复用（不插入、不审计），章节状态兜底到 `in_review`；
 * - 否则插入候选，并把章节推进到 `in_review`；
 * - 候选、章节状态、审计同事务。
 */
export async function persistChapterCandidate(input: {
  readonly db: PrismaClient;
  readonly fence: TaskFence;
  readonly contract: FrozenContract;
  readonly draft: ValidatedDraft;
  readonly plan: PlannerOutput;
}): Promise<{ readonly id: string; readonly wordCount: number }> {
  const { db, fence, contract, draft, plan } = input;
  return runWorkWrite(db, fence.workId, async (tx) => {
    await assertTaskFence(tx, fence);

    const existing = await tx.chapterCandidate.findUnique({
      where: { generationTaskId: fence.taskId },
      select: { id: true, wordCount: true },
    });
    if (existing !== null) {
      await ensureChapterStatus(tx, fence, 'in_review', [
        'planned',
        'outlined',
        'drafting',
        'in_review',
      ]);
      return existing;
    }

    if (contract.chapterId !== fence.chapterId || contract.workId !== fence.workId) {
      throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '章节合同归属不一致');
    }

    const created = await tx.chapterCandidate.create({
      data: {
        workId: fence.workId,
        chapterId: fence.chapterId,
        generationTaskId: fence.taskId,
        contractId: contract.id,
        content: draft.text,
        wordCount: draft.wordCount,
        structuredPlan: {
          version: 1,
          contractId: contract.id,
          contractVersion: contract.versionNo,
          goal: plan.goal,
          mustInclude: plan.mustInclude,
          mustNotInclude: plan.mustNotInclude,
          characters: plan.characters,
          scenes: plan.scenes,
          targetWords: contract.targetWords,
        } as never,
        status: 'candidate',
      },
    });

    await ensureChapterStatus(tx, fence, 'in_review', [
      'planned',
      'outlined',
      'drafting',
      'in_review',
    ]);
    await writeAuditLog(tx, {
      action: AUDIT_ACTIONS.CHAPTER_CANDIDATE_CREATED,
      actorId: fence.authorId,
      targetType: 'chapter',
      targetId: fence.chapterId,
      detail: {
        workId: fence.workId,
        chapterId: fence.chapterId,
        taskId: fence.taskId,
        candidateId: created.id,
        contractId: contract.id,
        wordCount: draft.wordCount,
      },
    });
    return { id: created.id, wordCount: created.wordCount };
  });
}
