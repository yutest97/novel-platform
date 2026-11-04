/**
 * 章节候选采纳（A1-3A）。
 *
 * 采纳 = 把"这一次生成的正文候选"升级为**正式章节版本**：
 *
 * ```
 * chapter_candidates(status=candidate)
 *   ├─ 插入 chapter_versions(source=ai, source_candidate_id=候选, parent=上一版)
 *   ├─ 候选 status: candidate → adopted（唯一允许的状态迁移）
 *   └─ 章节 status → in_review
 * ```
 *
 * 事务边界（全部在**同一个** `runWorkWrite` 事务里）：
 * 1. 取作品级 advisory lock（与设定 / 物品事件 / 生成任务共用同一把锁）；
 * 2. 事务内重读作品归属 —— `authorId` 只来自会话，他人作品 / 管理员一律 404；
 * 3. `SELECT ... FOR UPDATE` 锁章节行与候选行；
 * 4. 分配 `version_no = max + 1`、写入正式版本、迁移候选状态、推进章节状态、写审计；
 * 5. 任何一步失败（包括审计写入失败）整体回滚 —— 不会出现
 *    "候选已 adopted 但没有正式版本"或"有版本但候选还是 candidate"的半成品。
 *
 * 幂等：同一候选重复采纳返回既有版本（`deduplicated=true`），不新增版本、不写审计。
 * 并发：作品级锁把采纳串行化，同候选只会产生一个版本；同章节不同候选得到连续版本号。
 */

import { AUDIT_ACTIONS, AuthError, writeAuditLog } from '@novel/auth';
import type { Prisma, PrismaClient } from '@novel/db';
import {
  isConcurrencyError,
  normalizeUuid,
  requireOwnedWork,
  runWorkWrite,
  uniqueConstraintMarker,
} from '@novel/works';

import { isChapterOpenForGeneration } from './types.js';

/** 采纳后章节进入的状态。 */
const ADOPTED_CHAPTER_STATUS = 'in_review';

/** 采纳调用的可选元信息。 */
export interface AdoptionMeta {
  /**
   * 调用方请求标识。
   *
   * 预留给 A1-3B 的 HTTP 层做请求关联：**不落库、不进审计、不参与幂等判断**，
   * 采纳结果只由 `(workId, chapterId, candidateId)` 决定。
   */
  readonly requestId?: string;
}

/** 采纳输入。 */
export interface AdoptChapterCandidateInput {
  readonly db: PrismaClient;
  readonly workId: string;
  readonly chapterId: string;
  readonly candidateId: string;
  /** 只能来自会话；管理员不是作者，同样 404。 */
  readonly authorId: string;
  readonly meta?: AdoptionMeta;
}

/** 采纳结果。 */
export interface AdoptedChapterVersion {
  readonly versionId: string;
  readonly versionNo: number;
  readonly wordCount: number;
  /** 调用结束后章节的实际状态。 */
  readonly chapterStatus: string;
  /** true 表示幂等重放：未新建版本、未写审计。 */
  readonly deduplicated: boolean;
}

interface LockedChapterRow {
  status: string;
}

interface LockedCandidateRow {
  id: string;
  work_id: string;
  chapter_id: string;
  content: string;
  word_count: number;
  status: string;
}

/** 校验可选的 meta（不接受空 requestId，避免日志里出现无意义的空串）。 */
function assertMeta(meta: AdoptionMeta | undefined): void {
  if (meta === undefined || meta.requestId === undefined) {
    return;
  }
  const requestId = meta.requestId;
  if (typeof requestId !== 'string' || requestId.trim() === '' || requestId.length > 128) {
    throw new AuthError('VALIDATION_FAILED', 'requestId 不合法');
  }
}

/** 锁章节行（`FOR UPDATE`），确认章节属于该作品。 */
async function lockChapter(
  tx: Prisma.TransactionClient,
  workId: string,
  chapterId: string,
): Promise<LockedChapterRow> {
  const rows = await tx.$queryRaw<LockedChapterRow[]>`
    SELECT status
      FROM chapters
     WHERE id = ${chapterId} AND work_id = ${workId}
     FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined) {
    // 章节不属于该作品（或不存在）：与"作品不属于你"同样 404，不泄露存在性
    throw new AuthError('NOT_FOUND', '章节不存在');
  }
  return row;
}

/**
 * 锁候选行（`FOR UPDATE`）。
 *
 * 查询条件同时带 `work_id` 与 `chapter_id`：
 * 跨作品或跨章节的候选一律 404，而不是先读到再判断。
 */
async function lockCandidate(
  tx: Prisma.TransactionClient,
  workId: string,
  chapterId: string,
  candidateId: string,
): Promise<LockedCandidateRow> {
  const rows = await tx.$queryRaw<LockedCandidateRow[]>`
    SELECT id, work_id, chapter_id, content, word_count, status
      FROM chapter_candidates
     WHERE id = ${candidateId}
       AND work_id = ${workId}
       AND chapter_id = ${chapterId}
     FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new AuthError('CHAPTER_CANDIDATE_NOT_FOUND');
  }
  return row;
}

/**
 * 把数据库层的写冲突翻译成稳定错误码。
 *
 * - 唯一约束（`chapter_id + version_no` 或 `source_candidate_id`）→ 版本冲突 409；
 * - 死锁 / 序列化失败 → 并发冲突 409（可重试）；
 * - 已经是 `AuthError` 的原样抛出（业务拒绝）。
 */
function translateAdoptionError(error: unknown): unknown {
  if (error instanceof AuthError) {
    return error;
  }
  if (isConcurrencyError(error)) {
    return new AuthError('CONCURRENT_MODIFICATION');
  }
  if (uniqueConstraintMarker(error) !== null) {
    return new AuthError('CHAPTER_VERSION_CONFLICT');
  }
  return error;
}

/**
 * 采纳章节候选，生成正式章节版本。
 *
 * @throws AuthError
 * - `NOT_FOUND`：作品 / 章节不属于当前作者；
 * - `CHAPTER_CANDIDATE_NOT_FOUND`：候选不存在，或不在该作品该章节；
 * - `CHAPTER_CANDIDATE_NOT_ADOPTABLE`：候选状态已不是 candidate；
 * - `CHAPTER_STATE_INVALID_FOR_ADOPTION`：章节 finalized / abandoned；
 * - `CHAPTER_VERSION_CONFLICT`：版本号或来源候选唯一冲突；
 * - `CONCURRENT_MODIFICATION`：数据库层死锁 / 序列化失败（可重试）。
 */
export async function adoptChapterCandidate(
  input: AdoptChapterCandidateInput,
): Promise<AdoptedChapterVersion> {
  const { db, authorId } = input;
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const candidateId = normalizeUuid(input.candidateId, '候选 id');
  assertMeta(input.meta);

  try {
    return await runWorkWrite(db, workId, async (tx) => {
      await requireOwnedWork(tx, workId, authorId);

      const chapter = await lockChapter(tx, workId, chapterId);
      const candidate = await lockCandidate(tx, workId, chapterId, candidateId);

      // ---- 幂等分支：已采纳且版本存在 → 原样返回 ----
      // 判断放在章节状态之前：章节后来被定稿（finalized）也不影响"重复采纳"的幂等性。
      if (candidate.status === 'adopted') {
        const existing = await tx.chapterVersion.findUnique({
          where: { sourceCandidateId: candidateId },
          select: { id: true, versionNo: true, wordCount: true },
        });
        if (existing === null) {
          // 候选 adopted 却没有正式版本：只能是被绕过服务层的写入破坏。
          throw new AuthError('CHAPTER_VERSION_CONFLICT', '候选已采纳但正式版本缺失');
        }
        return {
          versionId: existing.id,
          versionNo: existing.versionNo,
          wordCount: existing.wordCount,
          chapterStatus: chapter.status,
          deduplicated: true,
        };
      }

      if (candidate.status !== 'candidate') {
        throw new AuthError('CHAPTER_CANDIDATE_NOT_ADOPTABLE');
      }

      // 与生成共用同一份"章节开放状态"白名单（types.ts），
      // 但错误码保持独立：采纳是 CHAPTER_STATE_INVALID_FOR_ADOPTION。
      if (!isChapterOpenForGeneration(chapter.status)) {
        throw new AuthError('CHAPTER_STATE_INVALID_FOR_ADOPTION', '章节已定稿或已废弃');
      }

      // ---- 版本号：章节行已加锁，max+1 不会撞号 ----
      const latest = await tx.chapterVersion.findFirst({
        where: { chapterId, workId },
        orderBy: { versionNo: 'desc' },
        select: { id: true, versionNo: true },
      });
      const versionNo = (latest?.versionNo ?? 0) + 1;
      const parentVersionId = latest?.id ?? null;

      // ---- 正式版本：正文与字数**原样复制**，不做任何改写 ----
      const version = await tx.chapterVersion.create({
        data: {
          workId,
          chapterId,
          versionNo,
          content: candidate.content,
          wordCount: candidate.word_count,
          source: 'ai',
          sourceCandidateId: candidateId,
          parentVersionId,
          createdBy: authorId,
        },
        select: { id: true, versionNo: true, wordCount: true },
      });

      // ---- 候选：唯一允许的状态迁移（数据库触发器兜底只放行 candidate → adopted）----
      const adopted = await tx.chapterCandidate.updateMany({
        where: { id: candidateId, workId, chapterId, status: 'candidate' },
        data: { status: 'adopted' },
      });
      if (adopted.count !== 1) {
        // 锁内不应发生；发生了说明数据被绕过服务层改过，按版本冲突处理并整体回滚
        throw new AuthError('CHAPTER_VERSION_CONFLICT', '候选状态已被其它写入改变');
      }

      // ---- 章节状态：只前进，不降级 ----
      let chapterStatus = chapter.status;
      if (chapterStatus !== ADOPTED_CHAPTER_STATUS) {
        const moved = await tx.chapter.updateMany({
          where: { id: chapterId, workId, status: chapterStatus },
          data: { status: ADOPTED_CHAPTER_STATUS },
        });
        if (moved.count !== 1) {
          throw new AuthError('CONCURRENT_MODIFICATION', '章节状态已被其它操作修改');
        }
        await writeAuditLog(tx, {
          action: AUDIT_ACTIONS.CHAPTER_STATUS_CHANGED,
          actorId: authorId,
          targetType: 'chapter',
          targetId: chapterId,
          detail: {
            workId,
            chapterId,
            fromStatus: chapterStatus,
            toStatus: ADOPTED_CHAPTER_STATUS,
          },
        });
        chapterStatus = ADOPTED_CHAPTER_STATUS;
      }

      // ---- 审计：只记 ids / 版本号 / 字数，不含正文 ----
      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.CHAPTER_CANDIDATE_ADOPTED,
        actorId: authorId,
        targetType: 'chapter',
        targetId: chapterId,
        detail: {
          workId,
          chapterId,
          candidateId,
          versionId: version.id,
          versionNo: version.versionNo,
          wordCount: version.wordCount,
        },
      });

      return {
        versionId: version.id,
        versionNo: version.versionNo,
        wordCount: version.wordCount,
        chapterStatus,
        deduplicated: false,
      };
    });
  } catch (error) {
    throw translateAdoptionError(error);
  }
}
