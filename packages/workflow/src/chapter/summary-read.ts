/**
 * 章节版本摘要的只读查询（A2-D-D）。
 *
 * 定位：
 * - 只读：不触发摘要任务、不重试、不重建，也不写审计；
 * - 按 **sourceVersionId** 定位摘要，避免把"当前最新版本"的摘要当成历史版本的；
 * - 只暴露稳定 DTO，不返回正文、generation task、provider / model 或 prompt；
 * - 跨作品 / 跨章节 / 随机版本 id / 尚未生成，一律 404 `SUMMARY_NOT_FOUND`，
 *   不通过错误码泄露存在性。
 */

import { AuthError } from '@novel/auth';
import type { PrismaClient } from '@novel/db';
import { normalizeUuid, requireOwnedWork } from '@novel/works';

import { requireChapterInWork } from './service.js';

/** 一条版本摘要的对外视图（不含正文、任务、provider / model）。 */
export interface ChapterSummaryRecordView {
  readonly id: string;
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly versionNo: number;
  readonly summary: string;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly createdAt: string;
}

export interface GetChapterVersionSummaryInput {
  readonly db: PrismaClient;
  readonly workId: string;
  /** 只能来自会话；管理员不是作者，作品归属校验会 404。 */
  readonly authorId: string;
  readonly chapterId: string;
  /** 摘要的**来源正式版本**，不是"当前最新版本"。 */
  readonly versionId: string;
}

/**
 * 读取某个正式版本已成功生成的摘要（只读）。
 *
 * 一次 JOIN 同时取摘要与版本号：`chapter_summaries` 的复合外键
 * `(source_version_id, chapter_id, work_id)` 保证版本、章节、作品三者一致，
 * 因此不需要先查版本再查摘要，也不存在"版本属于 A 章、摘要属于 B 章"的组合。
 *
 * 404 语义（统一 `SUMMARY_NOT_FOUND`）：
 * - 版本不属于该作品 / 该章节；
 * - 该版本还没有成功落库的摘要（含任务仍在排队、失败、被取消）；
 * - 随机 UUID。
 */
export async function getChapterVersionSummaryForAuthor(
  input: GetChapterVersionSummaryInput,
): Promise<ChapterSummaryRecordView> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const versionId = normalizeUuid(input.versionId, '版本 id');

  await requireOwnedWork(input.db, workId, input.authorId);
  await requireChapterInWork(input.db, workId, chapterId);

  const row = await input.db.chapterSummary.findFirst({
    // 三个条件缺一不可：只按 sourceVersionId 会让跨章节 / 跨作品读到别人的摘要
    where: { sourceVersionId: versionId, chapterId, workId },
    select: {
      id: true,
      chapterId: true,
      sourceVersionId: true,
      summary: true,
      agentName: true,
      agentVersion: true,
      createdAt: true,
      sourceVersion: { select: { versionNo: true } },
    },
  });
  if (row === null) {
    throw new AuthError('SUMMARY_NOT_FOUND');
  }

  return {
    id: row.id,
    chapterId: row.chapterId,
    sourceVersionId: row.sourceVersionId,
    versionNo: row.sourceVersion.versionNo,
    summary: row.summary,
    agentName: row.agentName,
    agentVersion: row.agentVersion,
    createdAt: row.createdAt.toISOString(),
  };
}
