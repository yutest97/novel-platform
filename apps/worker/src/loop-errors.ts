/**
 * Worker 轮询循环的错误分类（A1-3C-REV-01）。
 *
 * 目标：只对**基础设施瞬态错误**退避重试；业务错误、编程错误与未知错误
 * 一律视为永久失败，由进程退出 + 容器重启策略处理，绝不伪装健康。
 *
 * 安全约束：
 * - 本模块只读取错误的 `code / name / meta` 等稳定字段；
 * - 不读取、不返回、不记录 `message`（可能含连接串、prompt 或正文）；
 * - `safeWorkerLoopErrorCode` 返回的 code 只允许短 token。
 */

import { Prisma } from '@novel/db';
import { WorkflowError } from '@novel/workflow';

/** Prisma 已知请求错误中允许重试的代码。 */
const RETRYABLE_PRISMA_CODES: ReadonlySet<string> = new Set([
  // 连接失败 / 无法连接 / 连接超时 / 连接被关闭
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  // 表或迁移尚不存在（空库首次启动）
  'P2021',
  // 连接池等待超时
  'P2024',
]);

/**
 * PostgreSQL 管理员关机 / 暂时无法接受连接 / 原始查询缺表。
 *
 * `42P01` 是 `$executeRaw` / `$queryRaw` 缺表时 Prisma 暴露的底层 SQLSTATE
 * （P2010 + meta.code），语义与 P2021 相同，统一映射为 `P2021`。
 */
const RETRYABLE_SQL_STATES: ReadonlySet<string> = new Set(['57P01', '57P03', '42P01']);

/** SQLSTATE → 对外稳定 code（缺表统一映射为 P2021）。 */
function sqlStateCode(state: string): string {
  return state === '42P01' ? 'P2021' : state;
}

/** Node / pg 驱动的连接类系统错误。 */
const RETRYABLE_SYSTEM_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

const SAFE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * 显式标记为「可重试基础错误」。
 *
 * 给未来的基础设施适配层使用；普通业务异常不应使用本类型。
 */
export class RetryableWorkerLoopError extends Error {
  readonly code: string;

  constructor(code = 'WORKER_LOOP_RETRYABLE') {
    super('Worker 循环暂时不可用');
    this.name = 'RetryableWorkerLoopError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeCode(value: unknown): string | null {
  return typeof value === 'string' && SAFE_CODE_PATTERN.test(value) ? value : null;
}

/**
 * 在 meta / cause 链里查找允许重试的 SQLSTATE。
 *
 * 只做有限深度遍历，避免异常对象上的循环引用。
 */
function findRetryableSqlState(value: unknown, depth = 0): string | null {
  if (depth > 4 || !isRecord(value)) {
    return null;
  }
  // Prisma 7 的驱动适配器错误把 SQLSTATE 放在：
  // meta.driverAdapterError.cause.originalCode（同时提供 kind=TableDoesNotExist）。
  for (const key of ['code', 'originalCode'] as const) {
    const token = value[key];
    if (typeof token === 'string' && RETRYABLE_SQL_STATES.has(token)) {
      return token;
    }
  }
  if (value['kind'] === 'TableDoesNotExist') {
    return '42P01';
  }
  for (const key of ['meta', 'cause', 'driverAdapterError', 'originalError'] as const) {
    const found = findRetryableSqlState(value[key], depth + 1);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** 取出 Prisma 错误的安全分类（兼容跨 bundle 的 name 判定）。 */
function classifyPrismaError(error: unknown): { retryable: boolean; code: string } | null {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return { retryable: true, code: safeCode(error.errorCode) ?? 'PRISMA_INIT_ERROR' };
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const sqlState = findRetryableSqlState(error);
    return {
      retryable: RETRYABLE_PRISMA_CODES.has(error.code) || sqlState !== null,
      code:
        sqlState === null
          ? (safeCode(error.code) ?? 'PRISMA_KNOWN_REQUEST')
          : sqlStateCode(sqlState),
    };
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return { retryable: false, code: 'PRISMA_UNKNOWN_REQUEST' };
  }
  if (error instanceof Prisma.PrismaClientValidationError) {
    return { retryable: false, code: 'PRISMA_VALIDATION_ERROR' };
  }
  if (error instanceof Prisma.PrismaClientRustPanicError) {
    return { retryable: false, code: 'PRISMA_RUST_PANIC' };
  }

  if (!isRecord(error)) {
    return null;
  }
  const name = error['name'];
  const code = safeCode(error['code']);
  if (name === 'PrismaClientInitializationError') {
    return { retryable: true, code: safeCode(error['errorCode']) ?? code ?? 'PRISMA_INIT_ERROR' };
  }
  if (name === 'PrismaClientKnownRequestError') {
    const sqlState = findRetryableSqlState(error);
    return {
      retryable: (code !== null && RETRYABLE_PRISMA_CODES.has(code)) || sqlState !== null,
      code: sqlState === null ? (code ?? 'PRISMA_KNOWN_REQUEST') : sqlStateCode(sqlState),
    };
  }
  if (name === 'PrismaClientUnknownRequestError') {
    return { retryable: false, code: 'PRISMA_UNKNOWN_REQUEST' };
  }
  if (name === 'PrismaClientValidationError') {
    return { retryable: false, code: 'PRISMA_VALIDATION_ERROR' };
  }
  if (name === 'PrismaClientRustPanicError') {
    return { retryable: false, code: 'PRISMA_RUST_PANIC' };
  }
  return null;
}

/**
 * 是否允许 Worker 循环退避重试。
 *
 * true 仅限：Prisma 初始化/连接错误、P1001/P1002/P1008/P1017/P2021/P2024、
 * PostgreSQL 57P01/57P03、Node 连接类错误、显式标记的
 * `RetryableWorkerLoopError`。
 *
 * false：其余一切（含所有 WorkflowError、P2022 缺列、Prisma 未知请求、
 * TypeError / ReferenceError / 断言错误 / 未知异常）。
 */
export function isRetryableWorkerLoopError(error: unknown): boolean {
  const prisma = classifyPrismaError(error);
  if (prisma !== null) {
    return prisma.retryable;
  }
  if (error instanceof RetryableWorkerLoopError) {
    return true;
  }
  // 业务错误不因 retryable 标记而升级为循环重试：任务级重试由 WorkerRunner 负责。
  if (error instanceof WorkflowError) {
    return false;
  }
  if (!isRecord(error)) {
    return false;
  }
  const sqlState = findRetryableSqlState(error);
  if (sqlState !== null) {
    return true;
  }
  const code = error['code'];
  return typeof code === 'string' && RETRYABLE_SYSTEM_CODES.has(code);
}

/**
 * 把任意异常收敛成可记录的安全 code。
 *
 * 绝不返回 `message`；未知异常统一返回 `WORKER_LOOP_UNKNOWN`。
 */
export function safeWorkerLoopErrorCode(error: unknown): string {
  const prisma = classifyPrismaError(error);
  if (prisma !== null) {
    return prisma.code;
  }
  if (error instanceof RetryableWorkerLoopError) {
    return safeCode(error.code) ?? 'WORKER_LOOP_RETRYABLE';
  }
  if (error instanceof WorkflowError) {
    return safeCode(error.code) ?? 'WORKFLOW_ERROR';
  }
  if (error instanceof TypeError) {
    return 'TYPE_ERROR';
  }
  if (error instanceof ReferenceError) {
    return 'REFERENCE_ERROR';
  }
  if (error instanceof RangeError) {
    return 'RANGE_ERROR';
  }
  if (error instanceof SyntaxError) {
    return 'SYNTAX_ERROR';
  }
  if (error instanceof Error && error.name === 'AssertionError') {
    return 'ASSERTION_ERROR';
  }
  if (isRecord(error)) {
    const sqlState = findRetryableSqlState(error);
    if (sqlState !== null) {
      return sqlStateCode(sqlState);
    }
    const code = safeCode(error['code']);
    if (code !== null) {
      return code;
    }
    if (error['name'] === 'AssertionError') {
      return 'ASSERTION_ERROR';
    }
  }
  return 'WORKER_LOOP_UNKNOWN';
}
