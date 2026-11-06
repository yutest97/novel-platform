/**
 * C1-A：小说创作问答的服务层。
 *
 * 边界：
 * - `authorId` 只来自会话；任何函数都不接受请求体里的作者字段；
 * - 他人运行统一 404（不区分"不存在"与"不属于你"），管理员在路由层 403；
 * - 创建只接受 `requestText`，不写 provider / model / Key / prompt；
 * - 回答使用 `expectedVersion` 做乐观并发：同版本同答案幂等，同版本不同答案冲突；
 * - 取消对所有非终态幂等，终态原样返回；
 * - 读取不返回 `state_summary`、prompt、原始响应或模型调用日志。
 */

import { AuthError } from '@novel/auth';
import type { Prisma, PrismaClient } from '@novel/db';
import { isUuid } from '@novel/works';

import {
  DEFAULT_NOVEL_MAX_STEPS,
  INITIAL_NOVEL_STATE_SUMMARY,
  MAX_NOVEL_ANSWER_LENGTH,
  MAX_NOVEL_REQUEST_LENGTH,
  isNovelRunStatus,
  isNovelTerminalStatus,
  parseNovelStateSummary,
  type NovelRunCreated,
  type NovelRunStatus,
  type NovelRunStateSummary,
  type NovelRunView,
} from './types.js';

interface NovelRunRow {
  readonly id: string;
  readonly status: string;
  readonly state_version: number;
  readonly request_text: string;
  readonly current_goal: string;
  readonly last_decision_summary: string;
  readonly step_count: number;
  readonly max_steps: number;
  readonly state_summary: unknown;
  readonly completed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function normalizeRequestText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthError('VALIDATION_FAILED', 'requestText 必须是字符串');
  }
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_NOVEL_REQUEST_LENGTH) {
    throw new AuthError(
      'VALIDATION_FAILED',
      `requestText 长度必须在 1..${MAX_NOVEL_REQUEST_LENGTH}`,
    );
  }
  return text;
}

function normalizeAnswer(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthError('VALIDATION_FAILED', 'answer 必须是字符串');
  }
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_NOVEL_ANSWER_LENGTH) {
    throw new AuthError('VALIDATION_FAILED', `answer 长度必须在 1..${MAX_NOVEL_ANSWER_LENGTH}`);
  }
  return text;
}

function normalizeExpectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AuthError('VALIDATION_FAILED', 'expectedVersion 必须是非负整数');
  }
  return value;
}

function statusOf(row: { readonly status: string }): NovelRunStatus {
  if (!isNovelRunStatus(row.status)) {
    throw new AuthError('NOVEL_RUN_INVALID_STATE');
  }
  return row.status;
}

function questionOf(outputSummary: unknown): { question: string; options: string[] } | null {
  if (typeof outputSummary !== 'object' || outputSummary === null || Array.isArray(outputSummary)) {
    return null;
  }
  const record = outputSummary as Record<string, unknown>;
  if (record['kind'] !== 'question') {
    return null;
  }
  const question =
    typeof record['question'] === 'string' && record['question'].length > 0
      ? record['question']
      : null;
  if (question === null) {
    return null;
  }
  const options = Array.isArray(record['options'])
    ? record['options'].filter((item): item is string => typeof item === 'string')
    : [];
  return { question, options };
}

async function toView(
  db: PrismaClient,
  row: {
    readonly id: string;
    readonly status: string;
    readonly state_version: number;
    readonly current_goal: string;
    readonly last_decision_summary: string;
    readonly step_count: number;
    readonly created_at: Date;
    readonly updated_at: Date;
  },
): Promise<NovelRunView> {
  const status = statusOf(row);
  let question: string | null = null;
  let options: readonly string[] = [];
  if (status === 'waiting_user') {
    const step = await db.novelRunStep.findFirst({
      where: { runId: row.id, status: 'succeeded' },
      orderBy: { stepNo: 'desc' },
      select: { outputSummary: true },
    });
    const pending = questionOf(step?.outputSummary);
    if (pending !== null) {
      question = pending.question;
      options = pending.options;
    }
  }
  return {
    runId: row.id,
    status,
    version: row.state_version,
    currentGoal: row.current_goal,
    decisionSummary: row.last_decision_summary,
    question,
    options,
    stepCount: row.step_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * runId 只允许合法 UUID。
 *
 * 任意畸形 / 随机 id 与"他人 run"使用同一个 404 `NOVEL_RUN_NOT_FOUND`，
 * 避免通过错误码探测资源是否存在。
 */
function normalizeRunId(value: unknown): string {
  if (!isUuid(value)) {
    throw new AuthError('NOVEL_RUN_NOT_FOUND');
  }
  return value.toLowerCase();
}

async function lockRun(
  tx: Prisma.TransactionClient,
  runId: string,
  authorId: string,
): Promise<NovelRunRow | null> {
  const rows = await tx.$queryRaw<NovelRunRow[]>`
    SELECT
      "id",
      "status",
      "state_version",
      "request_text",
      "current_goal",
      "last_decision_summary",
      "step_count",
      "max_steps",
      "state_summary",
      "completed_at",
      "created_at",
      "updated_at"
    FROM "novel_runs"
    WHERE "id" = ${runId}::uuid
      AND "author_id" = ${authorId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** 创建一轮作者问答。 */
export async function startNovelRun(
  db: PrismaClient,
  input: { readonly authorId: string; readonly requestText: unknown },
): Promise<NovelRunCreated> {
  const requestText = normalizeRequestText(input.requestText);
  const run = await db.novelRun.create({
    data: {
      authorId: input.authorId,
      workId: null,
      status: 'queued',
      requestText,
      stateSummary: INITIAL_NOVEL_STATE_SUMMARY as unknown as Prisma.InputJsonValue,
      stateVersion: 0,
      currentGoal: '理解作者的创作目标',
      lastDecisionSummary: '',
      stepCount: 0,
      maxSteps: DEFAULT_NOVEL_MAX_STEPS,
    },
    select: { id: true, status: true, stateVersion: true },
  });
  return {
    runId: run.id,
    status: statusOf({ status: run.status }),
    version: run.stateVersion,
  };
}

/** 读取当前作者的一轮问答；他人一律 404。 */
export async function readNovelRun(
  db: PrismaClient,
  input: { readonly authorId: string; readonly runId: unknown },
): Promise<NovelRunView> {
  const runId = normalizeRunId(input.runId);
  const row = await db.novelRun.findFirst({
    where: { id: runId, authorId: input.authorId },
    select: {
      id: true,
      status: true,
      stateVersion: true,
      currentGoal: true,
      lastDecisionSummary: true,
      stepCount: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (row === null) {
    throw new AuthError('NOVEL_RUN_NOT_FOUND');
  }
  return toView(db, {
    id: row.id,
    status: row.status,
    state_version: row.stateVersion,
    current_goal: row.currentGoal,
    last_decision_summary: row.lastDecisionSummary,
    step_count: row.stepCount,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

/**
 * 作者回答。
 *
 * 幂等规则：
 * - `lastAnsweredVersion === expectedVersion` 且答案相同 → 原样返回当前视图；
 * - 同版本不同答案 → `NOVEL_RUN_ANSWER_CONFLICT`；
 * - 版本已变化 → `NOVEL_RUN_VERSION_CONFLICT`；
 * - 当前不是 `waiting_user` → `NOVEL_RUN_INVALID_STATE`。
 */
export async function answerNovelRun(
  db: PrismaClient,
  input: {
    readonly authorId: string;
    readonly runId: unknown;
    readonly expectedVersion: unknown;
    readonly answer: unknown;
  },
): Promise<NovelRunView> {
  const runId = normalizeRunId(input.runId);
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
  const answer = normalizeAnswer(input.answer);

  await db.$transaction(async (tx) => {
    const row = await lockRun(tx, runId, input.authorId);
    if (row === null) {
      throw new AuthError('NOVEL_RUN_NOT_FOUND');
    }
    const summary = parseNovelStateSummary(row.state_summary);
    if (summary.lastAnsweredVersion === expectedVersion) {
      if (summary.lastAnswer === answer) {
        return;
      }
      throw new AuthError('NOVEL_RUN_ANSWER_CONFLICT');
    }
    if (row.state_version !== expectedVersion) {
      throw new AuthError('NOVEL_RUN_VERSION_CONFLICT');
    }
    if (row.status !== 'waiting_user') {
      throw new AuthError('NOVEL_RUN_INVALID_STATE');
    }

    const nextSummary: NovelRunStateSummary = {
      ...summary,
      openQuestions: [],
      nextAllowedTools: ['ask_user', 'finish'],
      latestAnswer: answer,
      lastAnsweredVersion: expectedVersion,
      lastAnswer: answer,
    };
    await tx.novelRun.update({
      where: { id: runId },
      data: {
        status: 'queued',
        stateVersion: row.state_version + 1,
        stateSummary: nextSummary as unknown as Prisma.InputJsonValue,
        lockedBy: null,
        leaseUntil: null,
        heartbeatAt: null,
      },
    });
  });

  return readNovelRun(db, { authorId: input.authorId, runId });
}

/** 取消：所有非终态幂等，终态原样返回。 */
export async function cancelNovelRun(
  db: PrismaClient,
  input: { readonly authorId: string; readonly runId: unknown },
): Promise<NovelRunView> {
  const runId = normalizeRunId(input.runId);
  await db.$transaction(async (tx) => {
    const row = await lockRun(tx, runId, input.authorId);
    if (row === null) {
      throw new AuthError('NOVEL_RUN_NOT_FOUND');
    }
    if (isNovelTerminalStatus(row.status)) {
      return;
    }
    const summary = parseNovelStateSummary(row.state_summary);
    await tx.novelRun.update({
      where: { id: runId },
      data: {
        status: 'cancelled',
        stateVersion: row.state_version + 1,
        stateSummary: {
          ...summary,
          openQuestions: [],
          nextAllowedTools: [],
          latestAnswer: null,
        },
        lockedBy: null,
        leaseUntil: null,
        heartbeatAt: null,
        cancelRequestedAt: new Date(),
        completedAt: new Date(),
      },
    });
  });
  return readNovelRun(db, { authorId: input.authorId, runId });
}
