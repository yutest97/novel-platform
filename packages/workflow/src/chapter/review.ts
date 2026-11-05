/**
 * 章节候选审阅的上下文装配与运行持久化（A2-C-B）。
 *
 * 定位：
 * - 把「不可变候选正文 + 冻结合同 + 安全实体摘要」装成 Reviewer 输入；
 * - 管理 `chapter_review_runs` 的生命周期（running → succeeded / failed，
 *   failed → running 复用同一行）；
 * - 所有写入都用 `chapter.review` 任务的行锁 + `locked_by` 做 fencing：
 *   旧 Worker、丢租约、取消后晚返回都写不进问题、也覆盖不了 run。
 *
 * 数据边界：
 * - 正文只进入模型请求，**不写入 run / issues / task_contexts / 日志 / 审计**；
 * - `secret*` 属性永不进入摘要；
 * - issues 只存 Reviewer 输出的 evidence / suggestion，不另存 draft 副本。
 */

import type { Prisma, PrismaClient } from '@novel/db';
import { runWorkWrite } from '@novel/works';

import { NonRetryableTaskError } from '../errors.js';
import { assertTaskFence, asScenes, asStringArray, type TaskFenceScope } from './persistence.js';
import {
  MAX_REVIEW_ENTITIES_PER_TYPE,
  MAX_REVIEW_PRIOR_SUMMARIES,
  REVIEWER_CHAPTER_AGENT,
} from './reviewer.js';
import type { ChapterReviewerInput, ChapterReviewerOutput } from './reviewer.js';
import { loadSafeEntityGroups, toSafeEntityRefs, type SafeEntityRow } from './safe-entities.js';
import { CHAPTER_REVIEW_TASK_TYPE, type ContextSource } from './types.js';

export { CHAPTER_REVIEW_TASK_TYPE };

/** Reviewer 实体摘要上限（与 `reviewer.chapter` 输入 Schema 一致）。 */
export const MAX_REVIEW_ENTITY_SUMMARY_CHARS = 500;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const RANK_CHAPTER = 1;
const RANK_CONTRACT = 2;
const RANK_CANDIDATE = 3;
const RANK_PRIOR_SUMMARY_BASE = 10;
const RANK_CHARACTER_BASE = 100;
const RANK_ITEM_BASE = 200;
const RANK_REALM_BASE = 300;
const RANK_FACTION_BASE = 400;

/** 审阅任务输入：只允许 `candidateId`。 */
export interface ChapterReviewTaskInput {
  readonly candidateId: string;
}

/**
 * 解析 `chapter.review` 任务输入。
 *
 * 未知字段、非 UUID、缺少 candidateId 一律拒绝（不可重试：任务行是内部产生的，
 * 输入非法说明任务被绕过服务层写入）。
 */
export function parseChapterReviewTaskInput(value: unknown): ChapterReviewTaskInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NonRetryableTaskError('TASK_INPUT_INVALID', 'review 任务输入必须是对象');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'candidateId') {
      throw new NonRetryableTaskError('TASK_INPUT_INVALID', `不支持的输入字段 ${key}`);
    }
  }
  const candidateId = record['candidateId'];
  if (typeof candidateId !== 'string' || !UUID_PATTERN.test(candidateId)) {
    throw new NonRetryableTaskError('TASK_INPUT_INVALID', 'candidateId 必须是 UUID');
  }
  return { candidateId: candidateId.toLowerCase() };
}

/** 审阅任务的归属信息（在 `TaskFenceScope` 之上补充候选）。 */
export interface ReviewTaskFence extends TaskFenceScope {
  readonly candidateId: string;
}

/** 装配好的审阅上下文（`input` 含正文，只在内存中流转）。 */
export interface ChapterReviewContext {
  readonly candidateId: string;
  readonly chapterId: string;
  readonly workId: string;
  readonly contractId: string;
  readonly draft: string;
  readonly input: ChapterReviewerInput;
  readonly sources: readonly ContextSource[];
}

interface LoadReviewInput {
  readonly db: Prisma.TransactionClient;
  readonly workId: string;
  readonly chapterId: string;
  readonly candidateId: string;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 装配 Reviewer 输入。
 *
 * 校验顺序（任一失败都不写任何行）：
 * 1. 候选属于该作品 + 该章节；
 * 2. 合同属于同一作品 / 章节，且就是候选冻结的那一份；
 * 3. 章节属于该作品（定稿 / 已采纳都允许读：review 不修改章节状态）。
 */
export async function buildChapterReviewContext(
  input: LoadReviewInput,
): Promise<ChapterReviewContext> {
  const { db, workId, chapterId, candidateId } = input;

  const candidate = await db.chapterCandidate.findFirst({
    where: { id: candidateId, workId, chapterId },
    select: {
      id: true,
      workId: true,
      chapterId: true,
      contractId: true,
      generationTaskId: true,
      content: true,
      wordCount: true,
    },
  });
  if (candidate === null) {
    throw new NonRetryableTaskError('TASK_INPUT_INVALID', '候选不存在');
  }

  const chapter = await db.chapter.findFirst({
    where: { id: chapterId, workId },
    select: { id: true, chapterNo: true, title: true },
  });
  if (chapter === null) {
    throw new NonRetryableTaskError('TASK_INPUT_INVALID', '章节不存在');
  }

  const contract = await db.chapterContract.findFirst({
    where: { id: candidate.contractId, workId, chapterId },
    select: {
      id: true,
      workId: true,
      chapterId: true,
      generationTaskId: true,
      versionNo: true,
      goal: true,
      mustInclude: true,
      mustNotInclude: true,
      sceneBeats: true,
      targetWords: true,
    },
  });
  if (contract === null) {
    throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '候选的冻结合同不存在');
  }
  if (contract.generationTaskId !== candidate.generationTaskId) {
    throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '候选与合同的任务归属不一致');
  }

  const scenes = asScenes(
    typeof contract.sceneBeats === 'object' && contract.sceneBeats !== null
      ? (contract.sceneBeats as Record<string, unknown>)['scenes']
      : null,
  );
  const goal = contract.goal;
  if (goal.trim() === '' || scenes.length === 0) {
    throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '章节合同数据不完整');
  }

  const groups = await loadSafeEntityGroups(db, workId, {
    limit: MAX_REVIEW_ENTITIES_PER_TYPE,
    summaryMax: MAX_REVIEW_ENTITY_SUMMARY_CHARS,
  });

  // A2-D-C：同作品、前序、当前仍定稿且摘要对应当前最新正式版本的前章摘要。
  const priorRows = await loadPriorSummaries(db, {
    workId,
    chapterNo: chapter.chapterNo,
  });

  const reviewerInput: ChapterReviewerInput = {
    chapter: {
      id: chapter.id,
      chapterNo: chapter.chapterNo,
      title: chapter.title,
    },
    contract: {
      goal,
      mustInclude: asStringArray(contract.mustInclude),
      mustNotInclude: asStringArray(contract.mustNotInclude),
      scenes,
    },
    draft: candidate.content,
    characters: toSafeEntityRefs(groups.characters),
    items: toSafeEntityRefs(groups.items),
    realms: toSafeEntityRefs(groups.realms),
    factions: toSafeEntityRefs(groups.factions),
    // 只用真实存在、仍对应当前最新正式版本的前章摘要；缺失时不猜测、不用正文补。
    priorSummaries: priorRows.map((row) => ({
      chapterNo: row.chapterNo,
      summary: row.summary,
    })),
  };

  return {
    candidateId,
    chapterId,
    workId,
    contractId: contract.id,
    draft: candidate.content,
    input: reviewerInput,
    sources: buildContextSources({
      chapterId,
      chapterNo: chapter.chapterNo,
      chapterTitle: chapter.title,
      contractId: contract.id,
      contractVersion: contract.versionNo,
      contractTargetWords: contract.targetWords,
      sceneCount: scenes.length,
      candidateId,
      candidateWordCount: candidate.wordCount,
      groups,
      priorSummaries: priorRows,
    }),
  };
}

/** 前章摘要行（只含选择所需字段）。 */
interface PriorSummaryRow {
  readonly chapterNo: number;
  readonly summaryId: string;
  readonly summary: string;
}

interface LoadPriorSummariesInput {
  readonly workId: string;
  readonly chapterNo: number;
}

/**
 * 读取可以进入 Reviewer 输入的前章摘要。
 *
 * 固定规则（与服务层文档一致）：
 * - `chapter_no < 当前章`：不含当前章与未来章节；
 * - 前序章节 `status = 'finalized'`：人工 revision 后（回到 `in_review`）旧摘要立即失效；
 * - 摘要的 `source_version_id` 必须是该前序章节**当前最新**正式版本：
 *   重新定稿后只有新版本摘要可见；
 * - 同作品（显式 `work_id`），每个章节最多一条（`UNIQUE(source_version_id)` +
 *   最新版本条件共同保证）；
 * - 按 `chapter_no` 倒序取最近 20 条，再反转为升序，保持叙事时间顺序。
 */
async function loadPriorSummaries(
  db: Prisma.TransactionClient,
  input: LoadPriorSummariesInput,
): Promise<PriorSummaryRow[]> {
  const rows = await db.$queryRaw<{ chapter_no: number; summary_id: string; summary: string }[]>`
    SELECT c."chapter_no" AS chapter_no,
           s."id" AS summary_id,
           s."summary" AS summary
      FROM "chapters" c
      JOIN "chapter_summaries" s
        ON s."chapter_id" = c."id"
       AND s."work_id" = c."work_id"
     WHERE c."work_id" = ${input.workId}::uuid
       AND c."chapter_no" < ${input.chapterNo}
       AND c."status" = 'finalized'
       AND s."source_version_id" = (
             SELECT v."id"
               FROM "chapter_versions" v
              WHERE v."chapter_id" = c."id"
                AND v."work_id" = c."work_id"
              ORDER BY v."version_no" DESC
              LIMIT 1
           )
     ORDER BY c."chapter_no" DESC
     LIMIT ${MAX_REVIEW_PRIOR_SUMMARIES}
  `;

  return rows
    .map((row) => ({
      chapterNo: row.chapter_no,
      summaryId: row.summary_id,
      summary: row.summary,
    }))
    .reverse();
}

interface ContextSourceInput {
  readonly chapterId: string;
  readonly chapterNo: number;
  readonly chapterTitle: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly contractTargetWords: number;
  readonly sceneCount: number;
  readonly candidateId: string;
  readonly candidateWordCount: number;
  readonly groups: Awaited<ReturnType<typeof loadSafeEntityGroups>>;
  readonly priorSummaries: readonly PriorSummaryRow[];
}

/**
 * task_contexts 的确定性来源（只记 id 与安全摘要）。
 *
 * 不含正文、evidence、prompt 或模型响应；rank 固定，便于回答"模型看到了什么"。
 */
const ENTITY_LABELS: Readonly<Record<string, string>> = {
  character: '人物',
  item: '物品',
  realm_level: '境界',
  faction: '势力',
};

function buildContextSources(input: ContextSourceInput): ContextSource[] {
  const entitySources = (
    rows: readonly SafeEntityRow[],
    label: string,
    base: number,
  ): ContextSource[] =>
    rows.map((entity, index) => ({
      contextType: label,
      refId: entity.id,
      snippet: truncate(
        `${entity.name}（${ENTITY_LABELS[label] ?? label}）：${entity.summary === '' ? '未填写' : entity.summary}`,
        500,
      ),
      rank: base + index,
    }));

  return [
    {
      contextType: 'chapter',
      refId: input.chapterId,
      snippet: truncate(`第${input.chapterNo}章《${input.chapterTitle}》`, 500),
      rank: RANK_CHAPTER,
    },
    {
      contextType: 'chapter_contract',
      refId: input.contractId,
      snippet: truncate(
        `冻结合同 v${input.contractVersion}｜目标 ${input.contractTargetWords} 字｜场景 ${input.sceneCount} 个`,
        500,
      ),
      rank: RANK_CONTRACT,
    },
    {
      contextType: 'chapter_candidate',
      refId: input.candidateId,
      snippet: truncate(`候选正文 ${input.candidateWordCount} 字`, 500),
      rank: RANK_CANDIDATE,
    },
    ...entitySources(input.groups.characters, 'character', RANK_CHARACTER_BASE),
    ...entitySources(input.groups.items, 'item', RANK_ITEM_BASE),
    ...entitySources(input.groups.realms, 'realm_level', RANK_REALM_BASE),
    ...entitySources(input.groups.factions, 'faction', RANK_FACTION_BASE),
    // 前章摘要只记 summary id 与前章号，不复制摘要正文。
    ...input.priorSummaries.map((row, index) => ({
      contextType: 'chapter_summary',
      refId: row.summaryId,
      snippet: `第${row.chapterNo}章摘要`,
      rank: RANK_PRIOR_SUMMARY_BASE + index,
    })),
  ];
}

/** run 的结构视图（只声明服务层用到的字段）。 */
export interface ChapterReviewRunRow {
  readonly id: string;
  readonly workId: string;
  readonly chapterId: string;
  readonly candidateId: string;
  readonly generationTaskId: string;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly passed: boolean | null;
  readonly issueCount: number;
  readonly errorCode: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface PrepareReviewRunInput {
  readonly db: PrismaClient;
  readonly fence: ReviewTaskFence;
  /** 本次任务记录的 provider / model（来自 Worker 当前配置）。 */
  readonly provider: string;
  readonly model: string;
}

export interface PreparedReviewRun {
  readonly context: ChapterReviewContext;
  readonly runId: string;
  /** `true` 表示已有成功的 run：跳过模型调用与写入。 */
  readonly skip: boolean;
}

/**
 * 准备审阅运行（`load_review_input`）。
 *
 * 同一事务内完成：
 * 1. 任务行锁 + `locked_by` fencing；
 * 2. 装配上下文并重写 task_contexts（先删后插，重试不重复）；
 * 3. 复用 / 创建 run：
 *    - succeeded → `skip=true`（不再调用模型，后续步骤空转）；
 *    - running → 上一 attempt 已失去任务租约：先标 failed 再复用同一行重新 running；
 *    - failed → 复用同一行置回 running（刷新 started_at 与本次 provider/model）；
 *    - 不存在 → 新建 running。
 */
export async function prepareReviewRun(input: PrepareReviewRunInput): Promise<PreparedReviewRun> {
  const { db, fence, provider, model } = input;
  return runWorkWrite(db, fence.workId, async (tx) => {
    await assertTaskFence(tx, fence);

    const context = await buildChapterReviewContext({
      db: tx,
      workId: fence.workId,
      chapterId: fence.chapterId,
      candidateId: fence.candidateId,
    });

    await tx.taskContext.deleteMany({ where: { taskId: fence.taskId } });
    if (context.sources.length > 0) {
      await tx.taskContext.createMany({
        data: context.sources.map((source) => ({
          taskId: fence.taskId,
          contextType: source.contextType,
          refId: source.refId,
          snippet: source.snippet,
          rank: source.rank,
        })),
      });
    }

    const existing = await tx.chapterReviewRun.findUnique({
      where: { generationTaskId: fence.taskId },
      select: { id: true, status: true, candidateId: true, workId: true, chapterId: true },
    });

    if (existing !== null) {
      if (
        existing.candidateId !== fence.candidateId ||
        existing.workId !== fence.workId ||
        existing.chapterId !== fence.chapterId
      ) {
        throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '审阅 run 归属不一致');
      }
      if (existing.status === 'succeeded') {
        return { context, runId: existing.id, skip: true };
      }
      if (existing.status === 'running') {
        // 能走到这里说明任务已经重新被领取：上一条 running 的 attempt 已被放弃。
        const abandoned = await tx.$executeRaw`
          UPDATE "chapter_review_runs"
          SET "status" = 'failed',
              "error_code" = 'TASK_LEASE_LOST',
              "finished_at" = clock_timestamp()
          WHERE "id" = ${existing.id}::uuid AND "status" = 'running'
        `;
        if (abandoned !== 1) {
          throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '审阅 run 状态已变化');
        }
      }
      const restarted = await tx.$executeRaw`
        UPDATE "chapter_review_runs"
        SET "status" = 'running',
            "error_code" = NULL,
            "finished_at" = NULL,
            "passed" = NULL,
            "issue_count" = 0,
            "started_at" = clock_timestamp(),
            "provider" = ${provider},
            "model" = ${model}
        WHERE "id" = ${existing.id}::uuid AND "status" = 'failed'
      `;
      if (restarted !== 1) {
        throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '审阅 run 无法重新开始');
      }
      return { context, runId: existing.id, skip: false };
    }

    const created = await tx.chapterReviewRun.create({
      data: {
        workId: fence.workId,
        chapterId: fence.chapterId,
        candidateId: fence.candidateId,
        generationTaskId: fence.taskId,
        agentName: REVIEWER_CHAPTER_AGENT.name,
        agentVersion: REVIEWER_CHAPTER_AGENT.promptVersion,
        provider,
        model,
        status: 'running',
      },
      select: { id: true },
    });
    return { context, runId: created.id, skip: false };
  });
}

export interface PersistReviewResultInput {
  readonly db: PrismaClient;
  readonly fence: ReviewTaskFence;
  readonly output: ChapterReviewerOutput;
  /** 本次实际成功的 provider / model（可能被路由 / 降级）。 */
  readonly provider: string;
  readonly model: string;
}

/**
 * 写入审阅结果（`persist_review_result`）。
 *
 * - 任务行锁 + `locked_by` fencing 通过后才写 issue；
 * - issues、run 终态、passed、issue_count、finished_at 同一事务提交；
 * - run 已是 succeeded → 直接返回（不重复插 issue）；
 * - 不写 audit_logs：review run 与 issues 本身就是记录。
 */
export async function persistReviewResult(input: PersistReviewResultInput): Promise<void> {
  const { db, fence, output, provider, model } = input;
  const issueCount = output.issues.length;
  if (issueCount > 20) {
    // Schema 已挡；这里只是防御，避免绕过校验写入超量问题。
    throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '审阅问题数量超出上限');
  }

  await runWorkWrite(db, fence.workId, async (tx) => {
    await assertTaskFence(tx, fence);

    const run = await tx.chapterReviewRun.findUnique({
      where: { generationTaskId: fence.taskId },
      select: {
        id: true,
        workId: true,
        chapterId: true,
        candidateId: true,
        status: true,
      },
    });
    if (run === null) {
      throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '审阅 run 不存在');
    }
    if (
      run.workId !== fence.workId ||
      run.chapterId !== fence.chapterId ||
      run.candidateId !== fence.candidateId
    ) {
      throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '审阅 run 归属不一致');
    }
    if (run.status === 'succeeded') {
      return;
    }
    if (run.status !== 'running') {
      throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '审阅 run 不在可写入状态');
    }

    for (const [ordinal, issue] of output.issues.entries()) {
      await tx.chapterReviewIssue.create({
        data: {
          runId: run.id,
          workId: fence.workId,
          chapterId: fence.chapterId,
          candidateId: fence.candidateId,
          ordinal,
          severity: issue.severity,
          type: issue.type,
          evidence: issue.evidence,
          suggestion: issue.suggestion,
        },
        select: { id: true },
      });
    }

    const updated = await tx.$executeRaw`
      UPDATE "chapter_review_runs"
      SET "status" = 'succeeded',
          "passed" = ${output.passed},
          "issue_count" = ${issueCount},
          "finished_at" = clock_timestamp(),
          "error_code" = NULL,
          "provider" = ${provider},
          "model" = ${model}
      WHERE "id" = ${run.id}::uuid AND "status" = 'running'
    `;
    if (updated !== 1) {
      // 整个事务回滚（问题一并撤销）：调用方按内部错误处理。
      throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '审阅 run 状态已变化');
    }
  });
}

/**
 * 把 run 标为失败（best-effort，且**必须仍持有任务 fence**）。
 *
 * - 任务租约已丢 → 不写（旧 Worker 不得覆盖新 attempt 的 run），保留原始错误；
 * - 写库异常 → 吞掉（原始错误更重要；run 停 running 时由下次重试接管）；
 * - 不修改候选、合同、章节、采纳状态与 draft 任务。
 */
export async function markReviewRunFailed(input: {
  readonly db: PrismaClient;
  readonly fence: ReviewTaskFence;
  readonly errorCode: string;
}): Promise<void> {
  const { db, fence, errorCode } = input;
  try {
    await runWorkWrite(db, fence.workId, async (tx) => {
      await assertTaskFence(tx, fence);
      await tx.$executeRaw`
        UPDATE "chapter_review_runs"
        SET "status" = 'failed',
            "error_code" = ${errorCode},
            "finished_at" = clock_timestamp()
        WHERE "generation_task_id" = ${fence.taskId}::uuid
          AND "status" = 'running'
      `;
    });
  } catch {
    // 忽略：租约丢失 / 连接失败都不应掩盖原始错误。
  }
}

/** 读取任务对应的 run（测试与后续只读模型使用；不做作者校验）。 */
export async function getReviewRunByTaskId(
  db: Pick<PrismaClient, 'chapterReviewRun'>,
  taskId: string,
): Promise<ChapterReviewRunRow | null> {
  const row = await db.chapterReviewRun.findUnique({ where: { generationTaskId: taskId } });
  return row === null ? null : toReviewRunRow(row);
}

function toReviewRunRow(row: {
  readonly id: string;
  readonly workId: string;
  readonly chapterId: string;
  readonly candidateId: string;
  readonly generationTaskId: string;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly passed: boolean | null;
  readonly issueCount: number;
  readonly errorCode: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}): ChapterReviewRunRow {
  return {
    id: row.id,
    workId: row.workId,
    chapterId: row.chapterId,
    candidateId: row.candidateId,
    generationTaskId: row.generationTaskId,
    provider: row.provider,
    model: row.model,
    status: row.status,
    passed: row.passed,
    issueCount: row.issueCount,
    errorCode: row.errorCode,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
