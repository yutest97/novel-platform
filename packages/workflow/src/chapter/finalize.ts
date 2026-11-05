/**
 * 章节定稿（A1-4B-C-C）。
 *
 * 语义：
 * - 只能锁定**当前最新正式版本**：不新增 `final_version_id`，也不写 migration，
 *   "定稿版本"由"定稿时的最新版本"隐含；旧版本仍 append-only；
 * - `in_review → finalized`；已定稿且传入同一最新版本 → **幂等成功**，
 *   不重复写审计；
 * - 状态白名单：只有 `in_review` 能进入定稿，其余（含未知状态）一律
 *   `CHAPTER_STATE_INVALID_FOR_FINALIZE`；已定稿但版本不同也用同一错误码，
 *   不通过 `CHAPTER_VERSION_CONFLICT` 泄露"该版本是否存在"；
 * - 定稿后生成 / 采纳 / 恢复都被拒绝；人工保存 revision 会把章节拉回
 *   `in_review`（既有语义），需要重新定稿。
 *
 * 事务与并发：与人工保存 / 恢复共用作品级 advisory lock + 章节行锁，
 * 因此并发定稿会串行化：一个首次写入，另一个幂等返回，审计最多一条。
 *
 * A2-D-B 起，定稿与 `chapter.summarize` 任务入队在**同一个事务**内完成：
 * 定稿提交即一定有摘要任务；幂等重复定稿只补齐缺失任务，不重复创建。
 */

import { AUDIT_ACTIONS, AuthError, writeAuditLog } from '@novel/auth';
import type { PrismaClient } from '@novel/db';
import { normalizeUuid, requireOwnedWork, runWorkWrite } from '@novel/works';

import { lockChapter, translateChapterWriteError } from './human.js';
import { ensureSummaryTask } from './summary.js';
import type { ModelTaskSpec } from './persistence.js';
import { FINALIZED_CHAPTER_STATUS, isChapterFinalizable } from './types.js';

/** 定稿输入。 */
export interface FinalizeChapterInput {
  readonly db: PrismaClient;
  /** 只能来自会话；管理员不是作者，作品归属校验会 404。 */
  readonly authorId: string;
  readonly workId: string;
  readonly chapterId: string;
  /** 必须等于当前最新正式版本 id。 */
  readonly versionId: string;
  /**
   * 摘要任务的 provider / model。
   *
   * 由 API 层在**服务端**按 `readProviderConfig()` / Provider 构造结果解析后传入；
   * 请求体永远不能提交这两个值，事务内也不读取环境。
   */
  readonly summary: ModelTaskSpec;
}

/** 定稿结果（**不含正文**）。 */
export interface FinalizedChapter {
  readonly chapterId: string;
  readonly status: 'finalized';
  readonly versionId: string;
  readonly versionNo: number;
  /** `true` 表示本次是幂等重试，没有新增审计。 */
  readonly deduplicated: boolean;
  /** 同事务入队的 `chapter.summarize` 任务（内部字段，不进入 HTTP 响应）。 */
  readonly summaryTaskId: string;
  /** `true` 表示本次新建了摘要任务（幂等重复定稿 / 恢复补齐时为 `false`）。 */
  readonly summaryTaskCreated: boolean;
}

/**
 * 把章节定稿到当前最新正式版本。
 *
 * @throws AuthError
 * - `VALIDATION_FAILED`：任一 id 不是合法 UUID；
 * - `NOT_FOUND`：作品 / 章节不属于当前作者；
 * - `CHAPTER_STATE_INVALID_FOR_FINALIZE`：无正式版本、状态不是 `in_review`，
 *   或已定稿但版本不是当前最新；
 * - `CHAPTER_VERSION_CONFLICT`：`versionId` 不是当前最新版本；
 * - `CONCURRENT_MODIFICATION`：数据库层死锁 / 序列化失败 / 状态被并发修改。
 */
export async function finalizeChapter(input: FinalizeChapterInput): Promise<FinalizedChapter> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const versionId = normalizeUuid(input.versionId, '版本 id');

  try {
    return await runWorkWrite(input.db, workId, async (tx) => {
      await requireOwnedWork(tx, workId, input.authorId);

      // 章节行锁：与保存 / 恢复 / 采纳串行，避免"边保存边定稿"的中间态。
      const chapter = await lockChapter(tx, workId, chapterId);

      const latest = await tx.chapterVersion.findFirst({
        where: { workId, chapterId },
        orderBy: { versionNo: 'desc' },
        select: { id: true, versionNo: true, wordCount: true },
      });

      // ---- 已定稿：同版本幂等；不同版本 / 无版本一律状态不允许 ----
      if (chapter.status === FINALIZED_CHAPTER_STATUS) {
        if (latest !== null && versionId === latest.id) {
          // 幂等重试也要补齐缺失的摘要任务（崩溃恢复），但绝不重复创建。
          const summaryTask = await ensureSummaryTask(tx, {
            workId,
            chapterId,
            sourceVersionId: latest.id,
            spec: input.summary,
          });
          return {
            chapterId,
            status: 'finalized' as const,
            versionId,
            versionNo: latest.versionNo,
            deduplicated: true,
            summaryTaskId: summaryTask.taskId,
            summaryTaskCreated: summaryTask.created,
          };
        }
        throw new AuthError('CHAPTER_STATE_INVALID_FOR_FINALIZE');
      }

      // ---- 只有 in_review 可以定稿（planned / outlined / drafting / abandoned / 未知 → 拒绝）----
      if (!isChapterFinalizable(chapter.status) || latest === null) {
        throw new AuthError('CHAPTER_STATE_INVALID_FOR_FINALIZE');
      }

      // ---- 必须锁定当前最新版本（旧版本 → 稳定冲突）----
      if (versionId !== latest.id) {
        throw new AuthError('CHAPTER_VERSION_CONFLICT');
      }

      const moved = await tx.chapter.updateMany({
        where: { id: chapterId, workId, status: chapter.status },
        data: { status: FINALIZED_CHAPTER_STATUS },
      });
      if (moved.count !== 1) {
        throw new AuthError('CONCURRENT_MODIFICATION', '章节状态已被其它操作修改');
      }

      // ---- 审计：只记 ids / 版本号 / 字数，**不含正文** ----
      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.CHAPTER_FINALIZED,
        actorId: input.authorId,
        targetType: 'chapter',
        targetId: chapterId,
        detail: {
          workId,
          chapterId,
          versionId: latest.id,
          versionNo: latest.versionNo,
          wordCount: latest.wordCount,
        },
      });

      // ---- 摘要在同一事务内入队：定稿提交即一定有对应摘要任务 ----
      const summaryTask = await ensureSummaryTask(tx, {
        workId,
        chapterId,
        sourceVersionId: latest.id,
        spec: input.summary,
      });

      return {
        chapterId,
        status: 'finalized' as const,
        versionId: latest.id,
        versionNo: latest.versionNo,
        deduplicated: false,
        summaryTaskId: summaryTask.taskId,
        summaryTaskCreated: summaryTask.created,
      };
    });
  } catch (error) {
    throw translateChapterWriteError(error);
  }
}
