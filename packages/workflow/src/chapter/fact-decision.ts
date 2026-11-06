/**
 * 事实候选决策（A2-F-A）。
 *
 * 语义：
 * - 只记录作者对**成功 run 的候选**的终态决定（`accepted` / `rejected`）；
 * - **不写回任何实体或物品事件**：接受只表示"可作为后续写回输入"，
 *   人物 / 物品 / 势力 / 关系 / 境界 / 物品事件全部不变；
 * - 只允许**当前定稿且候选所属版本仍是最新正式版本**：人工 revision 后旧候选
 *   一律 `CONTINUITY_FACT_DECISION_STALE`，不能对已作废的候选做决定；
 * - `UNIQUE(candidate_id)` + append-only：同决定重复提交幂等（不写审计），
 *   不同决定 `CONTINUITY_FACT_ALREADY_DECIDED`，不翻转、不提供改判。
 *
 * 事务与并发：与人工保存 / 定稿 / 采纳共用作品级 advisory lock，
 * 因此同一作品的并发决定会串行化：首次写入 201，之后同决定 200 幂等，
 * 不同决定 409；数据库最多一行决定、审计最多一条。
 */

import { AUDIT_ACTIONS, AuthError, writeAuditLog } from '@novel/auth';
import type { PrismaClient } from '@novel/db';
import { isConcurrencyError, normalizeUuid, requireOwnedWork, runWorkWrite } from '@novel/works';

import { FINALIZED_CHAPTER_STATUS } from './types.js';

/** 允许的决策（稳定白名单，与数据库 CHECK 一致）。 */
export const CHAPTER_FACT_DECISIONS = ['accepted', 'rejected'] as const;

export type ChapterFactDecisionValue = (typeof CHAPTER_FACT_DECISIONS)[number];

/** 决策输入。 */
export interface DecideChapterFactInput {
  readonly db: PrismaClient;
  /** 只能来自会话；管理员不是作者，作品归属校验会 404。 */
  readonly authorId: string;
  readonly workId: string;
  readonly chapterId: string;
  readonly candidateId: string;
  readonly decision: ChapterFactDecisionValue;
}

/** 决策结果（**不含 payload / 正文**）。 */
export interface ChapterFactDecisionResult {
  readonly candidateId: string;
  readonly decision: ChapterFactDecisionValue;
  /** ISO-8601；首次决定为数据库时钟写入的时间。 */
  readonly decidedAt: string;
  /** `true` 表示同一决定的幂等重试，没有新增行、没有新增审计。 */
  readonly deduplicated: boolean;
}

/**
 * 记录作者对某条事实候选的决定。
 *
 * @throws AuthError
 * - `VALIDATION_FAILED`：任一 id 不是合法 UUID，或 decision 不在白名单；
 * - `NOT_FOUND`：作品 / 章节不属于当前作者，候选不存在或不属于该章节，
 *   候选所属 run 不是成功状态；
 * - `CONTINUITY_FACT_DECISION_STALE`：章节不再定稿，或候选不是当前最新正式版本的；
 * - `CONTINUITY_FACT_ALREADY_DECIDED`：该候选已做出相反决定；
 * - `CONCURRENT_MODIFICATION`：数据库层死锁 / 序列化失败。
 */
export async function decideChapterFact(
  input: DecideChapterFactInput,
): Promise<ChapterFactDecisionResult> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const candidateId = normalizeUuid(input.candidateId, '候选 id');
  if (!(CHAPTER_FACT_DECISIONS as readonly string[]).includes(input.decision)) {
    throw new AuthError('VALIDATION_FAILED', 'decision 必须是 accepted 或 rejected');
  }
  const decision = input.decision;

  try {
    return await runWorkWrite(input.db, workId, async (tx) => {
      await requireOwnedWork(tx, workId, input.authorId);

      // ---- 1. 候选归属：必须同时属于该作品与该章节 ----
      const candidate = await tx.chapterFactCandidate.findFirst({
        where: { id: candidateId, workId, chapterId },
        select: {
          id: true,
          sourceVersionId: true,
          run: { select: { status: true } },
        },
      });
      // 跨作品 / 跨章节 / 随机 id 统一 404，不泄露存在性
      if (candidate === null) {
        throw new AuthError('NOT_FOUND', '候选不存在');
      }
      // 只允许成功 run 的候选；失败 run 从不产生候选，这里是防御性拒绝
      if (candidate.run.status !== 'succeeded') {
        throw new AuthError('NOT_FOUND', '候选不存在');
      }

      // ---- 2. 只允许当前定稿的最新正式版本 ----
      const chapter = await tx.chapter.findFirst({
        where: { id: chapterId, workId },
        select: { status: true },
      });
      if (chapter === null) {
        throw new AuthError('NOT_FOUND', '章节不存在');
      }
      const latest = await tx.chapterVersion.findFirst({
        where: { workId, chapterId },
        orderBy: { versionNo: 'desc' },
        select: { id: true },
      });
      if (
        chapter.status !== FINALIZED_CHAPTER_STATUS ||
        latest === null ||
        latest.id !== candidate.sourceVersionId
      ) {
        throw new AuthError('CONTINUITY_FACT_DECISION_STALE');
      }

      // ---- 3. 幂等 / 冲突：决不允许翻转 ----
      const existing = await tx.chapterFactDecision.findUnique({
        where: { candidateId },
        select: { decision: true, decidedAt: true },
      });
      if (existing !== null) {
        if (existing.decision !== decision) {
          throw new AuthError('CONTINUITY_FACT_ALREADY_DECIDED');
        }
        return {
          candidateId,
          decision,
          decidedAt: existing.decidedAt.toISOString(),
          deduplicated: true,
        };
      }

      // ---- 4. 写入决定 + 审计（同一事务）----
      const created = await tx.chapterFactDecision.create({
        data: {
          workId,
          chapterId,
          sourceVersionId: candidate.sourceVersionId,
          candidateId,
          decision,
          decidedBy: input.authorId,
        },
        select: { decidedAt: true },
      });

      // 审计只记 ids 与 decision：不含 payload、summary / reason、正文或模型响应
      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.CONTINUITY_FACT_DECIDED,
        actorId: input.authorId,
        targetType: 'chapter_fact_candidate',
        targetId: candidateId,
        detail: {
          workId,
          chapterId,
          sourceVersionId: candidate.sourceVersionId,
          candidateId,
          decision,
        },
      });

      return {
        candidateId,
        decision,
        decidedAt: created.decidedAt.toISOString(),
        deduplicated: false,
      };
    });
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    if (isConcurrencyError(error)) {
      throw new AuthError('CONCURRENT_MODIFICATION');
    }
    throw error;
  }
}
