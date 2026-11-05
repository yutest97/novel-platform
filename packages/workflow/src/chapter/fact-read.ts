/**
 * 连续性事实候选的只读查询（A2-B）。
 *
 * 定位：
 * - 只读：**不写审计、不改 run / candidate**；
 * - 只暴露稳定 DTO，不把 Prisma row 直接交给 HTTP 层；
 * - 跨作品 / 跨章节 / 随机 id 与"不存在"一律 404，不泄露存在性；
 * - 永不返回正文、prompt、模型原始响应、`attempt_token` 或数据库错误。
 */

import { AuthError } from '@novel/auth';
import type { Prisma, PrismaClient } from '@novel/db';
import { normalizeUuid, requireOwnedWork } from '@novel/works';

import type { ChapterFactType } from './facts.js';
import { requireChapterInWork } from './service.js';

/**
 * 列表硬上限。
 *
 * 超过时**不静默截断**：响应带 `truncated: true` 与完整 `total`。
 */
export const MAX_CHAPTER_FACT_LIST = 200;

/** 一条候选的对外视图（不含正文 / prompt / attempt_token）。 */
export interface ChapterFactView {
  readonly id: string;
  readonly runId: string;
  readonly sourceVersionId: string;
  readonly sourceVersionNo: number;
  readonly factType: string;
  readonly summary: string;
  readonly reason: string;
  readonly subjectId: string | null;
  readonly objectId: string | null;
  readonly name: string | null;
  readonly threadStatus: string | null;
  readonly createdAt: string;
}

/** 候选列表结果。 */
export interface ChapterFactListResult {
  readonly facts: readonly ChapterFactView[];
  /** 过滤后的总数（不受 200 条上限影响）。 */
  readonly total: number;
  /** `true` 表示结果被 MAX_CHAPTER_FACT_LIST 截断。 */
  readonly truncated: boolean;
}

/** 候选详情对应的 run 安全元信息。 */
export interface ChapterFactRunSummary {
  readonly runId: string;
  readonly sourceVersionId: string;
  readonly sourceVersionNo: number;
  readonly status: string;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly errorCode: string | null;
  readonly factCount: number;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** 候选详情：候选本身 + 所属 run 的安全元信息。 */
export interface ChapterFactCandidateDetail {
  readonly fact: ChapterFactView;
  readonly run: ChapterFactRunSummary;
}

/** 只允许把稳定的连续性错误码暴露给客户端。 */
const STABLE_FACT_ERROR_CODES = new Set([
  'CONTINUITY_CHAPTER_NOT_FINALIZED',
  'CONTINUITY_SOURCE_VERSION_STALE',
  'CONTINUITY_EXTRACTION_IN_PROGRESS',
  'CONTINUITY_EXTRACTION_LEASE_LOST',
  'CONTINUITY_FACTS_INVALID',
  'CONTINUITY_EXTRACTION_FAILED',
]);

interface FactQueryInput {
  readonly db: PrismaClient;
  readonly workId: string;
  readonly chapterId: string;
  /** 只能来自会话；管理员不是作者，作品归属校验会 404。 */
  readonly authorId: string;
}

/**
 * 读取某章节的连续性事实候选（只读）。
 *
 * - 只返回**成功 run** 的候选；
 * - 默认 `createdAt desc → id desc`；
 * - 可按 `factType` 过滤（白名单由 HTTP 层与服务层共同保证）；
 * - 最多 `MAX_CHAPTER_FACT_LIST` 条，超出时 `truncated=true`。
 */
export async function listChapterFacts(
  input: FactQueryInput & { readonly factType?: ChapterFactType },
): Promise<ChapterFactListResult> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  await requireOwnedWork(input.db, workId, input.authorId);
  await requireChapterInWork(input.db, workId, chapterId);

  const where: Prisma.ChapterFactCandidateWhereInput = {
    workId,
    chapterId,
    ...(input.factType === undefined ? {} : { factType: input.factType }),
    // 候选只在成功的 run 上产生；这里再约束一次，避免将来出现历史脏数据
    run: { status: 'succeeded' },
  };

  const [total, rows] = await Promise.all([
    input.db.chapterFactCandidate.count({ where }),
    input.db.chapterFactCandidate.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_CHAPTER_FACT_LIST,
      select: {
        id: true,
        runId: true,
        sourceVersionId: true,
        factType: true,
        payload: true,
        createdAt: true,
      },
    }),
  ]);

  const versionNos = await loadVersionNos(
    input.db,
    workId,
    chapterId,
    rows.map((row) => row.sourceVersionId),
  );

  return {
    facts: rows.map((row) => toFactView(row, versionNos)),
    total,
    truncated: total > rows.length,
  };
}

/**
 * 读取单条候选（只读）。
 *
 * candidate 必须同时属于该作品与该章节；跨作品 / 跨章节 / 随机 id 统一 404。
 */
export async function getChapterFactCandidate(
  input: FactQueryInput & { readonly candidateId: string },
): Promise<ChapterFactCandidateDetail> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const candidateId = normalizeUuid(input.candidateId, '候选 id');
  await requireOwnedWork(input.db, workId, input.authorId);
  await requireChapterInWork(input.db, workId, chapterId);

  const candidate = await input.db.chapterFactCandidate.findFirst({
    where: { id: candidateId, workId, chapterId },
    select: {
      id: true,
      runId: true,
      sourceVersionId: true,
      factType: true,
      payload: true,
      createdAt: true,
      run: {
        select: {
          id: true,
          status: true,
          agentName: true,
          agentVersion: true,
          provider: true,
          model: true,
          errorCode: true,
          createdAt: true,
          startedAt: true,
          finishedAt: true,
          _count: { select: { candidates: true } },
        },
      },
    },
  });
  if (candidate === null) {
    throw new AuthError('NOT_FOUND', '候选不存在');
  }

  const versionNos = await loadVersionNos(input.db, workId, chapterId, [candidate.sourceVersionId]);

  return {
    fact: toFactView(candidate, versionNos),
    run: {
      runId: candidate.run.id,
      sourceVersionId: candidate.sourceVersionId,
      sourceVersionNo: versionNos.get(candidate.sourceVersionId) ?? 0,
      status: candidate.run.status,
      agentName: candidate.run.agentName,
      agentVersion: candidate.run.agentVersion,
      provider: candidate.run.provider,
      model: candidate.run.model,
      errorCode: toStableErrorCode(candidate.run.errorCode),
      factCount: candidate.run._count.candidates,
      createdAt: candidate.run.createdAt.toISOString(),
      startedAt: candidate.run.startedAt.toISOString(),
      finishedAt: candidate.run.finishedAt?.toISOString() ?? null,
    },
  };
}

/**
 * 读取一次提取运行的状态（只读）。
 *
 * 不返回 `attempt_token`、原始错误消息、正文或内部数据库细节。
 */
export async function getChapterFactRun(
  input: FactQueryInput & { readonly runId: string },
): Promise<ChapterFactRunSummary> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const runId = normalizeUuid(input.runId, '提取运行 id');
  await requireOwnedWork(input.db, workId, input.authorId);
  await requireChapterInWork(input.db, workId, chapterId);

  const run = await input.db.chapterFactRun.findFirst({
    where: { id: runId, workId, chapterId },
    select: {
      id: true,
      sourceVersionId: true,
      status: true,
      agentName: true,
      agentVersion: true,
      provider: true,
      model: true,
      errorCode: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      _count: { select: { candidates: true } },
    },
  });
  if (run === null) {
    throw new AuthError('NOT_FOUND', '提取运行不存在');
  }

  const versionNos = await loadVersionNos(input.db, workId, chapterId, [run.sourceVersionId]);

  return {
    runId: run.id,
    sourceVersionId: run.sourceVersionId,
    sourceVersionNo: versionNos.get(run.sourceVersionId) ?? 0,
    status: run.status,
    agentName: run.agentName,
    agentVersion: run.agentVersion,
    provider: run.provider,
    model: run.model,
    errorCode: toStableErrorCode(run.errorCode),
    factCount: run._count.candidates,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/** 批量取版本号（候选 / run 只存 id，版本号需关联读取）。 */
async function loadVersionNos(
  db: PrismaClient,
  workId: string,
  chapterId: string,
  versionIds: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(versionIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const versions = await db.chapterVersion.findMany({
    where: { id: { in: unique }, workId, chapterId },
    select: { id: true, versionNo: true },
  });
  return new Map(versions.map((version) => [version.id, version.versionNo]));
}

interface CandidateRow {
  readonly id: string;
  readonly runId: string;
  readonly sourceVersionId: string;
  readonly factType: string;
  readonly payload: unknown;
  readonly createdAt: Date;
}

/** 候选 payload → 稳定视图（字段固定，不夹带任何额外内容）。 */
function toFactView(row: CandidateRow, versionNos: ReadonlyMap<string, number>): ChapterFactView {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    runId: row.runId,
    sourceVersionId: row.sourceVersionId,
    sourceVersionNo: versionNos.get(row.sourceVersionId) ?? 0,
    factType: row.factType,
    summary: asString(payload['summary']),
    reason: asString(payload['reason']),
    subjectId: asNullableString(payload['subjectId']),
    objectId: asNullableString(payload['objectId']),
    name: asNullableString(payload['name']),
    threadStatus: asNullableString(payload['threadStatus']),
    createdAt: row.createdAt.toISOString(),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 只返回稳定错误码；其它（历史 / 内部）值一律 null。 */
function toStableErrorCode(value: string | null): string | null {
  return value !== null && STABLE_FACT_ERROR_CODES.has(value) ? value : null;
}
