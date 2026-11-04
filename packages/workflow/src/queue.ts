/**
 * PostgreSQL 任务队列（A1-1）。
 *
 * 状态机：
 *   queued ──claim──▶ processing ──complete──▶ succeeded
 *     │                   ├──retryable fail──▶ queued（attempt 未用尽）
 *     │                   ├──non-retryable───▶ failed
 *     │                   └──cancel──────────▶ cancelled
 *     └──cancel（尚未领取）──────────────────▶ cancelled
 *
 * 取消优先：一旦 `cancel_requested_at` 非空，无论当前步骤是成功还是失败
 * （含可重试错误），终态一律是 `cancelled`，不会回到 queued、不会写成 succeeded。
 * 该判断在 `completeTask` / `failTask` 的同一条 UPDATE 里原子完成。
 *
 * 幂等：`(work_id, request_id)` 唯一；`input_hash` 相同才视为同一请求，
 * 不同则 `TASK_REQUEST_CONFLICT`（不覆盖、不新建）。
 *
 * 关键不变量（数据库约束 + 触发器兜底，见迁移 SQL）：
 * - `(work_id, request_id)` 唯一：创建任务幂等；
 * - processing 必须持有 locked_by + lease_until；
 * - 终态不可修改；非法迁移被拒绝；
 * - 所有"Worker 写"都带 `locked_by = 当前 Worker` 作为 fencing，
 *   租约被抢占后旧 Worker 的写入会 0 行，而不是覆盖新 Worker。
 *
 * 权限边界：
 * - 面向作者的读写（create/get/cancel）必须传 authorId，并通过 `requireOwnedWork`；
 * - 管理员没有普通任务入口：把管理员 id 当 authorId 传只会 404；
 * - claim/heartbeat/complete/fail 是 Worker 内部接口，不接受作者身份。
 */

import { randomUUID } from 'node:crypto';

import { AuthError } from '@novel/auth';
import type { PrismaClient } from '@novel/db';
import { normalizeUuid, requireOwnedWork } from '@novel/works';

import { CanonicalJsonError, canonicalJsonStringify, hashTaskRequest } from './request-hash.js';

/** 任务状态（与数据库 CHECK 一致）。 */
export const TASK_STATUSES = ['queued', 'processing', 'succeeded', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 默认最大尝试次数（含首次执行）。 */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** 最大尝试次数上限（数据库 CHECK 同步）。 */
export const MAX_MAX_ATTEMPTS = 10;
/** 默认租约时长（毫秒）。 */
export const DEFAULT_LEASE_MS = 30_000;
/** 单次快照上限（字符数），避免把整章正文塞进任务表。 */
export const MAX_INPUT_SNAPSHOT_CHARS = 64 * 1024;
/** 上下文摘要上限（与数据库 CHECK 一致）。 */
export const MAX_CONTEXT_SNIPPET_CHARS = 500;

const TASK_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MIN_LEASE_MS = 100;
const MAX_LEASE_MS = 3_600_000;

/** 对外任务视图（时间统一 ISO 字符串）。 */
export interface GenerationTaskView {
  readonly id: string;
  readonly workId: string;
  readonly chapterId: string | null;
  readonly requestId: string;
  /** 请求内容的 SHA-256 指纹（64 位小写 hex），不含正文 / prompt。 */
  readonly inputHash: string;
  readonly taskType: string;
  readonly status: TaskStatus;
  readonly currentStep: string | null;
  readonly inputSnapshot: unknown;
  readonly provider: string;
  readonly model: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly lockedBy: string | null;
  readonly leaseUntil: string | null;
  readonly heartbeatAt: string | null;
  readonly cancelRequestedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessageSanitized: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 取任务所需的最小 Prisma 能力。 */
export type TaskReader = Pick<PrismaClient, 'work' | 'generationTask' | 'chapter'>;

/** 作者侧取消需要原生 UPDATE。 */
export type TaskCancelReader = TaskReader & Pick<PrismaClient, '$queryRaw'>;

/** Prisma 任务行（camelCase）：供同包内模块把已查询的行转成视图。 */
export interface GenerationTaskRowShape {
  id: string;
  workId: string;
  chapterId: string | null;
  requestId: string;
  inputHash: string;
  taskType: string;
  status: string;
  currentStep: string | null;
  inputSnapshot: unknown;
  provider: string;
  model: string;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  leaseUntil: Date | null;
  heartbeatAt: Date | null;
  cancelRequestedAt: Date | null;
  errorCode: string | null;
  errorMessageSanitized: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 原生 SQL 行（snake_case）。 */
interface RawTaskRow {
  id: string;
  work_id: string;
  chapter_id: string | null;
  request_id: string;
  input_hash: string;
  task_type: string;
  status: string;
  current_step: string | null;
  input_snapshot: unknown;
  provider: string;
  model: string;
  attempt_count: number;
  max_attempts: number;
  locked_by: string | null;
  lease_until: Date | null;
  heartbeat_at: Date | null;
  cancel_requested_at: Date | null;
  error_code: string | null;
  error_message_sanitized: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Prisma 行 → 对外任务视图。
 *
 * **不校验归属**：调用方必须已经做过作者 / 作品校验（见 `getGenerationTaskForAuthor`）。
 */
export function toGenerationTaskView(row: GenerationTaskRowShape): GenerationTaskView {
  return {
    id: row.id,
    workId: row.workId,
    chapterId: row.chapterId,
    requestId: row.requestId,
    inputHash: row.inputHash,
    taskType: row.taskType,
    status: row.status as TaskStatus,
    currentStep: row.currentStep,
    inputSnapshot: row.inputSnapshot,
    provider: row.provider,
    model: row.model,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    lockedBy: row.lockedBy,
    leaseUntil: row.leaseUntil?.toISOString() ?? null,
    heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    errorCode: row.errorCode,
    errorMessageSanitized: row.errorMessageSanitized,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function fromRaw(row: RawTaskRow): GenerationTaskView {
  return {
    id: row.id,
    workId: row.work_id,
    chapterId: row.chapter_id,
    requestId: row.request_id,
    inputHash: row.input_hash,
    taskType: row.task_type,
    status: row.status as TaskStatus,
    currentStep: row.current_step,
    inputSnapshot: row.input_snapshot,
    provider: row.provider,
    model: row.model,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lockedBy: row.locked_by,
    leaseUntil: row.lease_until?.toISOString() ?? null,
    heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
    cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
    errorCode: row.error_code,
    errorMessageSanitized: row.error_message_sanitized,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function invalid(message: string): AuthError {
  return new AuthError('VALIDATION_FAILED', message);
}

function assertText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw invalid(`${field} 长度必须在 1..${max}`);
  }
  return value;
}

function assertLeaseMs(value: number): number {
  if (!Number.isInteger(value) || value < MIN_LEASE_MS || value > MAX_LEASE_MS) {
    throw invalid(`leaseMs 必须是 ${MIN_LEASE_MS}..${MAX_LEASE_MS} 的整数`);
  }
  return value;
}

/** Prisma 唯一约束冲突（P2002）判断。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/* -------------------------------------------------------------------------- */
/* 创建 / 读取（作者边界）                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateGenerationTaskInput {
  /** 只来自会话；绝不接受请求体里的作者字段。 */
  readonly authorId: string;
  readonly workId: string;
  readonly chapterId?: string | null;
  readonly requestId: string;
  readonly taskType: string;
  /** 结构化输入；不含 prompt / 正文 / 密钥。 */
  readonly inputSnapshot: unknown;
  readonly provider: string;
  readonly model: string;
  readonly maxAttempts?: number;
}

/**
 * 创建任务（幂等）。
 *
 * 同 `(workId, requestId)` 已存在时：
 * - `input_hash` 相同 → 返回既有任务且 `created=false`，不覆盖、不新增；
 * - `input_hash` 不同 → `TASK_REQUEST_CONFLICT`（409），不覆盖、不新增。
 *
 * 指纹覆盖 `chapterId / taskType / inputSnapshot / provider / model / maxAttempts`，
 * `inputSnapshot` 先转 canonical JSON（对象 key 递归排序、数组保持顺序）。
 */
export async function createGenerationTask(
  db: TaskReader & Pick<PrismaClient, 'generationTask'>,
  input: CreateGenerationTaskInput,
): Promise<{ readonly task: GenerationTaskView; readonly created: boolean }> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const requestId = assertText(input.requestId, 'requestId', 128);
  const taskType = assertText(input.taskType, 'taskType', 64);
  if (!TASK_TYPE_PATTERN.test(taskType)) {
    throw invalid('taskType 格式不合法');
  }
  const provider = assertText(input.provider, 'provider', 64);
  const model = assertText(input.model, 'model', 128);
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_MAX_ATTEMPTS) {
    throw invalid(`maxAttempts 必须是 1..${MAX_MAX_ATTEMPTS} 的整数`);
  }

  await requireOwnedWork(db, workId, input.authorId);

  let chapterId: string | null = null;
  if (input.chapterId !== undefined && input.chapterId !== null && input.chapterId !== '') {
    chapterId = normalizeUuid(input.chapterId, '章节 id');
    const chapter = await db.chapter.findFirst({
      where: { id: chapterId, workId },
      select: { id: true },
    });
    if (chapter === null) {
      // 不区分"不存在"与"属于他人作品"
      throw new AuthError('NOT_FOUND', '章节不存在');
    }
  }

  let snapshotJson: string;
  try {
    snapshotJson = canonicalJsonStringify(input.inputSnapshot);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw invalid(`inputSnapshot 必须是可稳定序列化的 JSON（${error.message}）`);
    }
    throw error;
  }
  if (snapshotJson.length > MAX_INPUT_SNAPSHOT_CHARS) {
    throw invalid(`inputSnapshot 不能超过 ${MAX_INPUT_SNAPSHOT_CHARS} 个字符`);
  }

  const inputHash = hashTaskRequest({
    chapterId,
    taskType,
    inputSnapshot: input.inputSnapshot,
    provider,
    model,
    maxAttempts,
  });

  try {
    const row = await db.generationTask.create({
      data: {
        workId,
        chapterId,
        requestId,
        inputHash,
        taskType,
        inputSnapshot: input.inputSnapshot as never,
        provider,
        model,
        maxAttempts,
      },
    });
    return { task: toGenerationTaskView(row), created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const existing = await db.generationTask.findUnique({
      where: { workId_requestId: { workId, requestId } },
    });
    if (existing === null) {
      throw error;
    }
    if (existing.inputHash !== inputHash) {
      // 不覆盖既有任务，也不回显任何一侧的输入内容。
      throw new AuthError('TASK_REQUEST_CONFLICT');
    }
    return { task: toGenerationTaskView(existing), created: false };
  }
}

/** 作者读取自己的任务（非所有者 404）。 */
export async function getGenerationTaskForAuthor(
  db: TaskReader,
  input: { readonly authorId: string; readonly workId: string; readonly taskId: string },
): Promise<GenerationTaskView> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const taskId = normalizeUuid(input.taskId, '任务 id');
  await requireOwnedWork(db, workId, input.authorId);
  const row = await db.generationTask.findFirst({ where: { id: taskId, workId } });
  if (row === null) {
    throw new AuthError('NOT_FOUND', '任务不存在');
  }
  return toGenerationTaskView(row);
}

/** Worker 内部读取（不做作者校验；不得直接暴露给 HTTP 层）。 */
export async function getGenerationTask(
  db: Pick<PrismaClient, 'generationTask'>,
  taskId: string,
): Promise<GenerationTaskView | null> {
  const row = await db.generationTask.findUnique({ where: { id: taskId } });
  return row === null ? null : toGenerationTaskView(row);
}

/* -------------------------------------------------------------------------- */
/* 取消（作者边界）                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 请求取消。
 *
 * - queued：直接进入 cancelled；
 * - processing：只写 cancel_requested_at，Worker 在下一步之前停止；
 * - 终态：幂等返回当前状态，不报错、不复活任务。
 */
export async function requestTaskCancellationForAuthor(
  db: TaskCancelReader,
  input: { readonly authorId: string; readonly workId: string; readonly taskId: string },
): Promise<GenerationTaskView> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const taskId = normalizeUuid(input.taskId, '任务 id');
  await requireOwnedWork(db, workId, input.authorId);

  const queued = await db.$queryRaw<RawTaskRow[]>`
    UPDATE generation_tasks
       SET status = 'cancelled',
           cancel_requested_at = clock_timestamp(),
           error_code = NULL,
           error_message_sanitized = NULL,
           locked_by = NULL,
           lease_until = NULL,
           updated_at = clock_timestamp()
     WHERE id = ${taskId}
       AND work_id = ${workId}
       AND status = 'queued'
     RETURNING *
  `;
  const first = queued[0];
  if (first !== undefined) {
    return fromRaw(first);
  }

  const processing = await db.$queryRaw<RawTaskRow[]>`
    UPDATE generation_tasks
       SET cancel_requested_at = clock_timestamp(),
           updated_at = clock_timestamp()
     WHERE id = ${taskId}
       AND work_id = ${workId}
       AND status = 'processing'
     RETURNING *
  `;
  const second = processing[0];
  if (second !== undefined) {
    return fromRaw(second);
  }

  const current = await db.generationTask.findFirst({ where: { id: taskId, workId } });
  if (current === null) {
    throw new AuthError('NOT_FOUND', '任务不存在');
  }
  return toGenerationTaskView(current);
}

/* -------------------------------------------------------------------------- */
/* Worker：领取 / 心跳 / 检查点 / 完成 / 失败 / 回收                            */
/* -------------------------------------------------------------------------- */

/** 领取一个 queued 任务（FOR UPDATE SKIP LOCKED）。 */
export async function claimNextTask(
  db: Pick<PrismaClient, '$queryRaw'>,
  input: { readonly workerId: string; readonly leaseMs: number },
): Promise<GenerationTaskView | null> {
  const workerId = assertText(input.workerId, 'workerId', 128);
  const leaseMs = assertLeaseMs(input.leaseMs);

  const rows = await db.$queryRaw<RawTaskRow[]>`
    WITH candidate AS (
      SELECT id
        FROM generation_tasks
       WHERE status = 'queued'
         AND cancel_requested_at IS NULL
         AND attempt_count < max_attempts
       ORDER BY created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    )
    UPDATE generation_tasks AS t
       SET status = 'processing',
           locked_by = ${workerId},
           lease_until = clock_timestamp() + (${leaseMs}::int * interval '1 millisecond'),
           heartbeat_at = clock_timestamp(),
           attempt_count = t.attempt_count + 1,
           current_step = NULL,
           error_code = NULL,
           error_message_sanitized = NULL,
           updated_at = clock_timestamp()
      FROM candidate
     WHERE t.id = candidate.id
    RETURNING t.*
  `;
  const row = rows[0];
  return row === undefined ? null : fromRaw(row);
}

/** 续租；返回 false 表示租约已不属于当前 Worker。 */
export async function heartbeatTask(
  db: Pick<PrismaClient, '$executeRaw'>,
  input: { readonly taskId: string; readonly workerId: string; readonly leaseMs: number },
): Promise<boolean> {
  const taskId = normalizeUuid(input.taskId, '任务 id');
  const workerId = assertText(input.workerId, 'workerId', 128);
  const leaseMs = assertLeaseMs(input.leaseMs);
  const affected = await db.$executeRaw`
    UPDATE generation_tasks
       SET lease_until = clock_timestamp() + (${leaseMs}::int * interval '1 millisecond'),
           heartbeat_at = clock_timestamp(),
           updated_at = clock_timestamp()
     WHERE id = ${taskId}
       AND locked_by = ${workerId}
       AND status = 'processing'
  `;
  return affected > 0;
}

/** 写入步骤检查点；返回 false 表示租约已丢失。 */
export async function updateTaskStep(
  db: Pick<PrismaClient, '$executeRaw'>,
  input: { readonly taskId: string; readonly workerId: string; readonly step: string },
): Promise<boolean> {
  const taskId = normalizeUuid(input.taskId, '任务 id');
  const workerId = assertText(input.workerId, 'workerId', 128);
  const step = assertText(input.step, 'step', 64);
  const affected = await db.$executeRaw`
    UPDATE generation_tasks
       SET current_step = ${step},
           updated_at = clock_timestamp()
     WHERE id = ${taskId}
       AND locked_by = ${workerId}
       AND status = 'processing'
  `;
  return affected > 0;
}

/**
 * 标记成功或取消（唯一终态入口）。
 *
 * 在**同一条 UPDATE** 里原子判断 `cancel_requested_at`：
 * - 有取消标记 → `cancelled`（取消优先于完成）；
 * - 无取消标记 → `succeeded`；
 * - 租约已被抢占 / 状态不再是 processing → 0 行，返回 `lost`。
 *
 * 两种终态都清空锁、租约与错误字段：取消不是失败，不应留下错误码。
 */
export async function completeTask(
  db: Pick<PrismaClient, '$queryRaw'>,
  input: { readonly taskId: string; readonly workerId: string },
): Promise<'succeeded' | 'cancelled' | 'lost'> {
  const taskId = normalizeUuid(input.taskId, '任务 id');
  const workerId = assertText(input.workerId, 'workerId', 128);
  const rows = await db.$queryRaw<{ status: string }[]>`
    UPDATE generation_tasks
       SET status = CASE
             WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
             ELSE 'succeeded'
           END,
           error_code = NULL,
           error_message_sanitized = NULL,
           locked_by = NULL,
           lease_until = NULL,
           updated_at = clock_timestamp()
     WHERE id = ${taskId}
       AND locked_by = ${workerId}
       AND status = 'processing'
    RETURNING status
  `;
  const row = rows[0];
  if (row === undefined) {
    return 'lost';
  }
  return row.status === 'cancelled' ? 'cancelled' : 'succeeded';
}

/** 显式取消（不依赖 cancel_requested_at；Worker 已统一走 completeTask）。 */
export async function markTaskCancelled(
  db: Pick<PrismaClient, '$executeRaw'>,
  input: { readonly taskId: string; readonly workerId: string },
): Promise<boolean> {
  const taskId = normalizeUuid(input.taskId, '任务 id');
  const workerId = assertText(input.workerId, 'workerId', 128);
  const affected = await db.$executeRaw`
    UPDATE generation_tasks
       SET status = 'cancelled',
           error_code = NULL,
           error_message_sanitized = NULL,
           locked_by = NULL,
           lease_until = NULL,
           updated_at = clock_timestamp()
     WHERE id = ${taskId}
       AND locked_by = ${workerId}
       AND status = 'processing'
  `;
  return affected > 0;
}

/**
 * 记录失败。
 *
 * 取消优先：只要 `cancel_requested_at` 非空，无论错误是否可重试、次数是否用尽，
 * 一律进入 `cancelled`，**不会回到 queued**，也不会留下错误码。
 * 其余情况：
 * - `retryable=true` 且 attempt_count < max_attempts → 回到 queued；
 * - 否则 → failed（终态）。
 *
 * @returns 迁移后的状态；`lost` 表示租约已被抢占（未写入任何行）。
 */
export async function failTask(
  db: Pick<PrismaClient, '$queryRaw'>,
  input: {
    readonly taskId: string;
    readonly workerId: string;
    readonly errorCode: string;
    readonly message: string;
    readonly retryable: boolean;
  },
): Promise<'queued' | 'failed' | 'cancelled' | 'lost'> {
  const taskId = normalizeUuid(input.taskId, '任务 id');
  const workerId = assertText(input.workerId, 'workerId', 128);
  const errorCode = assertText(input.errorCode, 'errorCode', 64);
  const message = assertText(input.message, 'message', 500);

  const rows = await db.$queryRaw<{ status: string }[]>`
    UPDATE generation_tasks
       SET status = CASE
             WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
             WHEN ${input.retryable} AND attempt_count < max_attempts THEN 'queued'
             ELSE 'failed'
           END,
           error_code = CASE
             WHEN cancel_requested_at IS NOT NULL THEN NULL
             ELSE ${errorCode}
           END,
           error_message_sanitized = CASE
             WHEN cancel_requested_at IS NOT NULL THEN NULL
             ELSE ${message}
           END,
           locked_by = NULL,
           lease_until = NULL,
           updated_at = clock_timestamp()
     WHERE id = ${taskId}
       AND locked_by = ${workerId}
       AND status = 'processing'
    RETURNING status
  `;
  const row = rows[0];
  if (row === undefined) {
    return 'lost';
  }
  if (row.status === 'queued') {
    return 'queued';
  }
  return row.status === 'cancelled' ? 'cancelled' : 'failed';
}

/**
 * 回收过期租约（每次轮询前调用）。
 *
 * 顺序固定：先取消（作者意图优先），再判失败（次数用尽），最后重新排队。
 * 任何一步都只处理 `lease_until < clock_timestamp()` 的 processing 行，
 * 因此不会碰正在被其它 Worker 执行的任务。
 */
export async function sweepExpiredTasks(
  db: Pick<PrismaClient, '$executeRaw'>,
): Promise<{ readonly cancelled: number; readonly failed: number; readonly requeued: number }> {
  const cancelled = await db.$executeRaw`
    UPDATE generation_tasks
       SET status = 'cancelled',
           error_code = NULL,
           error_message_sanitized = NULL,
           locked_by = NULL,
           lease_until = NULL,
           updated_at = clock_timestamp()
     WHERE status = 'processing'
       AND lease_until < clock_timestamp()
       AND cancel_requested_at IS NOT NULL
  `;

  const failed = await db.$executeRaw`
    UPDATE generation_tasks
       SET status = 'failed',
           error_code = 'LEASE_EXHAUSTED',
           error_message_sanitized = '任务租约过期且重试次数已用尽',
           locked_by = NULL,
           lease_until = NULL,
           updated_at = clock_timestamp()
     WHERE status = 'processing'
       AND lease_until < clock_timestamp()
       AND cancel_requested_at IS NULL
       AND attempt_count >= max_attempts
  `;

  const requeued = await db.$executeRaw`
    UPDATE generation_tasks
       SET status = 'queued',
           error_code = 'LEASE_EXPIRED',
           error_message_sanitized = '任务租约过期，已重新排队',
           locked_by = NULL,
           lease_until = NULL,
           updated_at = clock_timestamp()
     WHERE status = 'processing'
       AND lease_until < clock_timestamp()
       AND cancel_requested_at IS NULL
       AND attempt_count < max_attempts
  `;

  return { cancelled, failed, requeued };
}

/* -------------------------------------------------------------------------- */
/* 上下文与模型调用日志                                                        */
/* -------------------------------------------------------------------------- */

export interface TaskContextView {
  readonly id: string;
  readonly taskId: string;
  readonly contextType: string;
  readonly refId: string | null;
  readonly snippet: string | null;
  readonly rank: number;
}

/**
 * 写入/覆盖一条上下文引用（只存摘要）。
 *
 * **内部接口**：不校验作者归属，不得直接暴露给 HTTP 层；
 * 未来 API 必须先 `getGenerationTaskForAuthor` 确认作品归属。
 */
export async function upsertTaskContext(
  db: Pick<PrismaClient, '$queryRaw'>,
  input: {
    readonly taskId: string;
    readonly contextType: string;
    readonly refId?: string | null;
    readonly snippet?: string | null;
    readonly rank?: number;
  },
): Promise<TaskContextView> {
  const taskId = normalizeUuid(input.taskId, '任务 id');
  const contextType = assertText(input.contextType, 'contextType', 64);
  const refId =
    input.refId === undefined || input.refId === null || input.refId === ''
      ? null
      : normalizeUuid(input.refId, 'refId');
  const snippet =
    input.snippet === undefined || input.snippet === null || input.snippet === ''
      ? null
      : input.snippet;
  if (snippet !== null && snippet.length > MAX_CONTEXT_SNIPPET_CHARS) {
    throw invalid(`snippet 不能超过 ${MAX_CONTEXT_SNIPPET_CHARS} 个字符`);
  }
  const rank = input.rank ?? 0;
  if (!Number.isInteger(rank) || rank < 0) {
    throw invalid('rank 必须是非负整数');
  }

  const rows = await db.$queryRaw<
    {
      id: string;
      task_id: string;
      context_type: string;
      ref_id: string | null;
      snippet: string | null;
      rank: number;
    }[]
  >`
    INSERT INTO task_contexts (id, task_id, context_type, ref_id, snippet, rank)
    VALUES (${randomUUID()}::uuid, ${taskId}, ${contextType}, ${refId}, ${snippet}, ${rank})
    ON CONFLICT (task_id, context_type, ref_id)
    DO UPDATE SET snippet = EXCLUDED.snippet, rank = EXCLUDED.rank
    RETURNING *
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new AuthError('NOT_FOUND', '任务不存在');
  }
  return {
    id: row.id,
    taskId: row.task_id,
    contextType: row.context_type,
    refId: row.ref_id,
    snippet: row.snippet,
    rank: row.rank,
  };
}

/**
 * 读取任务的上下文（按 rank 升序）。
 *
 * **内部接口**：不校验作者归属，使用前必须先走 `getGenerationTaskForAuthor`。
 */
export async function listTaskContexts(
  db: Pick<PrismaClient, 'taskContext'>,
  taskId: string,
): Promise<readonly TaskContextView[]> {
  const normalized = normalizeUuid(taskId, '任务 id');
  const rows = await db.taskContext.findMany({
    where: { taskId: normalized },
    orderBy: [{ rank: 'asc' }, { contextType: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    contextType: row.contextType,
    refId: row.refId,
    snippet: row.snippet,
    rank: row.rank,
  }));
}

export interface LlmCallLogInput {
  readonly taskId: string;
  /** 例如 `agent:test.echo@1.0.0`；不含 prompt。 */
  readonly stage: string;
  readonly provider: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
  readonly success: boolean;
  /** 失败时的稳定错误码；不含原始错误信息。 */
  readonly errorCode?: string | null;
}

/**
 * 记录一次模型调用（只记计量与结果）。
 *
 * **内部接口**：不校验作者归属；不含 prompt / 正文 / 原始错误。
 */
export async function recordLlmCall(
  db: Pick<PrismaClient, 'llmCallLog'>,
  input: LlmCallLogInput,
): Promise<void> {
  const taskId = normalizeUuid(input.taskId, '任务 id');
  const stage = assertText(input.stage, 'stage', 64);
  const provider = assertText(input.provider, 'provider', 64);
  const model = assertText(input.model, 'model', 128);
  for (const [field, value] of [
    ['promptTokens', input.promptTokens],
    ['completionTokens', input.completionTokens],
    ['latencyMs', input.latencyMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw invalid(`${field} 必须是非负整数`);
    }
  }
  if (input.success && input.errorCode !== undefined && input.errorCode !== null) {
    throw invalid('成功调用不应携带 errorCode');
  }
  const errorCode =
    input.errorCode === undefined || input.errorCode === null || input.errorCode === ''
      ? null
      : assertText(input.errorCode, 'errorCode', 64);

  await db.llmCallLog.create({
    data: {
      taskId,
      stage,
      provider,
      model,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      latencyMs: input.latencyMs,
      success: input.success,
      errorCode,
    },
  });
}

/**
 * 取消 / 所有权标志（Worker 在步骤之间检查）。
 *
 * `lockedBy` 用于确认任务仍归当前 Worker：租约过期并被重新领取后，
 * 旧 Worker 必须立即停止后续步骤。
 */
export async function getTaskCancellationState(
  db: Pick<PrismaClient, '$queryRaw'>,
  taskId: string,
): Promise<{
  readonly status: string;
  readonly cancelRequested: boolean;
  readonly lockedBy: string | null;
} | null> {
  const normalized = normalizeUuid(taskId, '任务 id');
  const rows = await db.$queryRaw<
    { status: string; cancel_requested_at: Date | null; locked_by: string | null }[]
  >`
    SELECT status, cancel_requested_at, locked_by
      FROM generation_tasks
     WHERE id = ${normalized}
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    status: row.status,
    cancelRequested: row.cancel_requested_at !== null,
    lockedBy: row.locked_by,
  };
}
