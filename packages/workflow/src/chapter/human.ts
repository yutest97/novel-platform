/**
 * 人工章节版本保存与历史恢复（A1-4B-A / A1-4B-C-B）。
 *
 * 人工保存 = 作者把一段正式正文写成**新的人类版本**：
 *
 * ```
 * chapter_versions(source=human, source_candidate_id=NULL,
 *                  parent_version_id=baseVersionId, version_no=max+1)
 *   └─ 章节 status → in_review（finalized 也回到 in_review）
 * ```
 *
 * 历史恢复 = 把某个旧版本的正文**原样复制**成一个新的 human 版本，
 * 旧版本不被修改或删除（append-only）；并发语义与人工保存完全一致。
 *
 * 与"采纳候选"不同：
 * - 不写候选表（`chapter_candidates` 只有 AI 生成物）；
 * - 不覆盖任何旧版本：版本表 append-only，旧版本永久保留；
 * - 并发控制靠 `baseVersionId`（乐观并发）+ 章节行锁（悲观串行）双重保证。
 *
 * 事务边界（同一个 `runWorkWrite` 事务）：
 * 1. 作品级 advisory lock（与设定 / 生成 / 采纳共用一把锁）；
 * 2. 事务内 `requireOwnedWork` —— authorId 只来自会话，他人作品 404；
 * 3. `SELECT ... FOR UPDATE` 锁章节行；
 * 4. 读当前最大版本，与 `baseVersionId` 比对（不一致 → 409，绝不 last-write-wins）；
 * 5. 插入新版本、推进章节状态、写审计；
 * 6. 任一步失败（含审计写入失败）整体回滚 —— 不会留下"章节动了但没有版本"的半成品。
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

import { countWords } from './agents.js';
import {
  MAX_DRAFT_CHARS,
  MIN_DRAFT_WORDS,
  SAVED_CHAPTER_STATUS,
  isChapterOpenForSave,
} from './types.js';

/** 保存人工版本的输入。 */
export interface SaveHumanChapterVersionInput {
  readonly db: PrismaClient;
  readonly workId: string;
  readonly chapterId: string;
  /** 只能来自会话；管理员不是作者，同样 404。 */
  readonly authorId: string;
  /** 待保存的正文（服务端会 trim 并重新计算字数）。 */
  readonly content: string;
  /**
   * 期望的基线版本；**必须显式提交**。
   *
   * - `null`：预期章节当前没有正式版本（因此新版本是第 1 版）；
   * - 非空：必须等于当前最大版本 id，否则 409 `CHAPTER_VERSION_CONFLICT`。
   */
  readonly baseVersionId: string | null;
}

/** 保存结果（**不含正文**）。 */
export interface SavedHumanChapterVersion {
  readonly versionId: string;
  readonly versionNo: number;
  readonly wordCount: number;
  readonly source: 'human';
  readonly parentVersionId: string | null;
  readonly chapterStatus: string;
}

interface LockedChapterRow {
  status: string;
}

/** 规范化后的正文与字数（服务端重新计算，不信任客户端）。 */
interface NormalizedContent {
  readonly content: string;
  readonly wordCount: number;
}

/**
 * 校验并规范化人工正文。
 *
 * - `trim` 后为空 → 拒绝（空白正文不是"短正文"）；
 * - 超过 200000 字符 → 拒绝（与数据库 CHECK 一致）；
 * - 少于 1200 个非空白字符 → 拒绝（与 AI 候选同一口径，见 `countWords`）。
 *
 * 三类失败统一 `CHAPTER_CONTENT_INVALID`（400），文案只提示"字数和内容"，
 * 不回显正文、不提示具体差多少字。
 */
export function normalizeHumanContent(raw: unknown): NormalizedContent {
  if (typeof raw !== 'string') {
    throw new AuthError('CHAPTER_CONTENT_INVALID');
  }
  const content = raw.trim();
  if (content === '') {
    throw new AuthError('CHAPTER_CONTENT_INVALID');
  }
  if (content.length > MAX_DRAFT_CHARS) {
    throw new AuthError('CHAPTER_CONTENT_INVALID');
  }
  const wordCount = countWords(content);
  if (wordCount < MIN_DRAFT_WORDS) {
    throw new AuthError('CHAPTER_CONTENT_INVALID');
  }
  return { content, wordCount };
}

/**
 * 锁章节行（`FOR UPDATE`），同时校验章节属于该作品。
 *
 * 与采纳（adoption.ts）同一手法：跨作品 / 跨章节一律 404，不泄露存在性。
 */
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
    throw new AuthError('NOT_FOUND', '章节不存在');
  }
  return row;
}

/**
 * 把数据库层的写冲突翻译成稳定错误码。
 *
 * - 唯一约束（`chapter_id + version_no`）→ `CHAPTER_VERSION_CONFLICT`（409）；
 * - 死锁 / 序列化失败 → `CONCURRENT_MODIFICATION`（409，可重试）；
 * - 业务错误原样抛出。
 */
function translateSaveError(error: unknown): unknown {
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
 * 把章节推进到 `in_review`（人工保存 / 历史恢复共用）。
 *
 * `finalized` 也会被拉回 `in_review`（定稿后修订的既有语义）；
 * 用 `updateMany + status` 做条件更新，避免覆盖并发修改后的状态。
 */
async function advanceChapterToInReview(
  tx: Prisma.TransactionClient,
  workId: string,
  chapterId: string,
  currentStatus: string,
): Promise<string> {
  if (currentStatus === SAVED_CHAPTER_STATUS) {
    return currentStatus;
  }
  const moved = await tx.chapter.updateMany({
    where: { id: chapterId, workId, status: currentStatus },
    data: { status: SAVED_CHAPTER_STATUS },
  });
  if (moved.count !== 1) {
    throw new AuthError('CONCURRENT_MODIFICATION', '章节状态已被其它操作修改');
  }
  return SAVED_CHAPTER_STATUS;
}

/**
 * 保存人工章节版本。
 *
 * @throws AuthError
 * - `CHAPTER_CONTENT_INVALID`：正文空白 / 过短 / 超长；
 * - `NOT_FOUND`：作品 / 章节不属于当前作者；
 * - `CHAPTER_STATE_INVALID_FOR_SAVE`：章节已废弃（finalized 允许，保存后回到 in_review）；
 * - `CHAPTER_VERSION_CONFLICT`：`baseVersionId` 不是当前最大版本，或版本号唯一冲突；
 * - `CONCURRENT_MODIFICATION`：数据库层死锁 / 序列化失败（可重试）。
 */
export async function saveHumanChapterVersion(
  input: SaveHumanChapterVersionInput,
): Promise<SavedHumanChapterVersion> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  // baseVersionId 必须由调用方显式给出（null 表示"预期无版本"），
  // 这里再规范化一次，非法 UUID 直接按格式错误拒绝。
  const baseVersionId =
    input.baseVersionId === null ? null : normalizeUuid(input.baseVersionId, 'baseVersionId');
  const { content, wordCount } = normalizeHumanContent(input.content);

  try {
    return await runWorkWrite(input.db, workId, async (tx) => {
      await requireOwnedWork(tx, workId, input.authorId);

      // 章节行锁：同一章节的保存请求在这里串行化，版本号不会撞号。
      const chapter = await lockChapter(tx, workId, chapterId);
      if (!isChapterOpenForSave(chapter.status)) {
        throw new AuthError('CHAPTER_STATE_INVALID_FOR_SAVE', '章节已废弃，不能保存人工版本');
      }

      // ---- 基线比对：只用"当前最大版本"，绝不做 last-write-wins ----
      const latest = await tx.chapterVersion.findFirst({
        where: { workId, chapterId },
        orderBy: { versionNo: 'desc' },
        select: { id: true, versionNo: true },
      });
      if (latest === null) {
        if (baseVersionId !== null) {
          // 客户端以为有版本，实际没有：可能被回滚或看的是别的章节
          throw new AuthError('CHAPTER_VERSION_CONFLICT', '章节尚无正式版本');
        }
      } else if (baseVersionId !== latest.id) {
        // 包括 baseVersionId=null（已有版本却按"无版本"提交）与旧 id 两种情况
        throw new AuthError('CHAPTER_VERSION_CONFLICT');
      }

      const versionNo = (latest?.versionNo ?? 0) + 1;

      // ---- 新版本：source=human，来源候选为 NULL，父版本=基线 ----
      const version = await tx.chapterVersion.create({
        data: {
          workId,
          chapterId,
          versionNo,
          content,
          wordCount,
          source: 'human',
          sourceCandidateId: null,
          parentVersionId: baseVersionId,
          createdBy: input.authorId,
        },
        select: { id: true, versionNo: true, wordCount: true },
      });

      // ---- 章节状态：推进或保持 in_review（finalized 也回到 in_review）----
      const chapterStatus = await advanceChapterToInReview(tx, workId, chapterId, chapter.status);

      // ---- 审计：只记 ids / 版本号 / 来源 / 字数 / 父版本，**不含正文** ----
      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.CHAPTER_VERSION_CREATED,
        actorId: input.authorId,
        targetType: 'chapter',
        targetId: chapterId,
        detail: {
          workId,
          chapterId,
          versionId: version.id,
          versionNo: version.versionNo,
          source: 'human',
          wordCount: version.wordCount,
          parentVersionId: baseVersionId,
        },
      });

      return {
        versionId: version.id,
        versionNo: version.versionNo,
        wordCount: version.wordCount,
        source: 'human' as const,
        parentVersionId: baseVersionId,
        chapterStatus,
      };
    });
  } catch (error) {
    throw translateSaveError(error);
  }
}

/** 历史版本恢复的输入。 */
export interface RestoreChapterVersionInput {
  readonly db: PrismaClient;
  readonly workId: string;
  readonly chapterId: string;
  /** 只能来自会话；管理员不是作者，作品归属校验会 404。 */
  readonly authorId: string;
  /** 准备恢复的历史版本：只读取，不会被修改或删除。 */
  readonly sourceVersionId: string;
  /**
   * 恢复前的最新版本 id。**必须显式给出且非空**：
   * 恢复永远基于"当前最大版本"创建新版本，用它与实际 latest 比对做乐观并发。
   */
  readonly baseVersionId: string;
}

/** 恢复结果（**不含正文**）。 */
export interface RestoredChapterVersion {
  readonly versionId: string;
  readonly versionNo: number;
  readonly wordCount: number;
  readonly source: 'human';
  /** 新版本的父版本 = 恢复时的最新版本。 */
  readonly parentVersionId: string;
  /** 正文来源的历史版本 id（原版本保持不变）。 */
  readonly restoredFromVersionId: string;
  readonly chapterStatus: string;
}

/**
 * 把历史版本恢复为**新的**人工正式版本（A1-4B-C-B）。
 *
 * 语义：
 * - `sourceVersionId` 只读：正文 / 字数原样复制，旧版本永远不会被修改或删除；
 * - 新版本 `source='human'`、`parentVersionId=baseVersionId`、`versionNo=latest+1`；
 * - 章节状态按人工保存的既有语义推进 / 保持 `in_review`；
 * - 作品级 advisory lock + 章节行锁，同一章节的恢复与保存互相串行；
 * - 并发同 base：恰好一个成功，另一个 `CHAPTER_VERSION_CONFLICT`；
 * - 恢复目标已是当前最新 → `CHAPTER_VERSION_ALREADY_LATEST`（不产生无意义的新版本）。
 *
 * @throws AuthError
 * - `VALIDATION_FAILED`：任一 id 不是合法 UUID / `baseVersionId` 为空；
 * - `NOT_FOUND`：作品 / 章节不属于当前作者，或历史版本不属于该作品 + 章节；
 * - `CHAPTER_STATE_INVALID_FOR_SAVE`：章节已废弃；
 * - `CHAPTER_VERSION_CONFLICT`：`baseVersionId` 不是当前最大版本（含章节尚无版本）；
 * - `CHAPTER_VERSION_ALREADY_LATEST`：`sourceVersionId` 就是当前最新版本；
 * - `CONCURRENT_MODIFICATION`：数据库层死锁 / 序列化失败（可重试）。
 */
export async function restoreChapterVersion(
  input: RestoreChapterVersionInput,
): Promise<RestoredChapterVersion> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const sourceVersionId = normalizeUuid(input.sourceVersionId, '历史版本 id');
  const baseVersionId = normalizeUuid(input.baseVersionId, 'baseVersionId');

  try {
    return await runWorkWrite(input.db, workId, async (tx) => {
      await requireOwnedWork(tx, workId, input.authorId);

      const chapter = await lockChapter(tx, workId, chapterId);
      if (!isChapterOpenForSave(chapter.status)) {
        throw new AuthError('CHAPTER_STATE_INVALID_FOR_SAVE', '章节已废弃，不能恢复历史版本');
      }

      // 历史版本必须同时属于该作品与章节：跨作品 / 跨章节 / 不存在统一 404。
      const source = await tx.chapterVersion.findFirst({
        where: { id: sourceVersionId, workId, chapterId },
        select: { id: true, content: true, wordCount: true },
      });
      if (source === null) {
        throw new AuthError('NOT_FOUND', '版本不存在');
      }

      // ---- 基线比对：必须基于当前最大版本，绝不做 last-write-wins ----
      const latest = await tx.chapterVersion.findFirst({
        where: { workId, chapterId },
        orderBy: { versionNo: 'desc' },
        select: { id: true, versionNo: true },
      });
      if (latest === null || baseVersionId !== latest.id) {
        throw new AuthError('CHAPTER_VERSION_CONFLICT');
      }
      if (sourceVersionId === latest.id) {
        // 恢复最新版本只会产生一份内容相同的新版本：拒绝，避免无意义重复。
        throw new AuthError('CHAPTER_VERSION_ALREADY_LATEST');
      }

      const versionNo = latest.versionNo + 1;

      // ---- 新版本：正文 / 字数原样复制，父版本=恢复时的最新版本 ----
      const version = await tx.chapterVersion.create({
        data: {
          workId,
          chapterId,
          versionNo,
          content: source.content,
          wordCount: source.wordCount,
          source: 'human',
          sourceCandidateId: null,
          parentVersionId: baseVersionId,
          createdBy: input.authorId,
        },
        select: { id: true, versionNo: true, wordCount: true },
      });

      const chapterStatus = await advanceChapterToInReview(tx, workId, chapterId, chapter.status);

      // ---- 审计：只记 ids / 版本号 / 字数，**不含正文** ----
      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.CHAPTER_VERSION_RESTORED,
        actorId: input.authorId,
        targetType: 'chapter',
        targetId: chapterId,
        detail: {
          workId,
          chapterId,
          versionId: version.id,
          versionNo: version.versionNo,
          sourceVersionId: source.id,
          parentVersionId: baseVersionId,
          wordCount: version.wordCount,
        },
      });

      return {
        versionId: version.id,
        versionNo: version.versionNo,
        wordCount: version.wordCount,
        source: 'human' as const,
        parentVersionId: baseVersionId,
        restoredFromVersionId: source.id,
        chapterStatus,
      };
    });
  } catch (error) {
    throw translateSaveError(error);
  }
}
