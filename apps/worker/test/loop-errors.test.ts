/**
 * Worker 循环错误分类（A1-3C-REV-01）。
 *
 * 只验证「瞬态 vs 永久」与安全 code；不连数据库、不联网。
 */

import { Prisma } from '@novel/db';
import { RetryableTaskError, WorkflowError } from '@novel/workflow';
import { describe, expect, it } from 'vitest';

import {
  RetryableWorkerLoopError,
  isRetryableWorkerLoopError,
  safeWorkerLoopErrorCode,
} from '../src/loop-errors.js';

const CLIENT_VERSION = 'test';

function knownError(code: string, meta?: Record<string, unknown>): Error {
  return new Prisma.PrismaClientKnownRequestError('原始错误 postgresql://user:secret@host/db', {
    code,
    clientVersion: CLIENT_VERSION,
    ...(meta === undefined ? {} : { meta }),
  });
}

function initError(errorCode?: string): Error {
  return new Prisma.PrismaClientInitializationError(
    '无法连接 postgresql://user:secret@host/db',
    CLIENT_VERSION,
    errorCode,
  );
}

describe('瞬态错误 → 允许退避重试', () => {
  it('P2021：表 / 迁移尚不存在', () => {
    const error = knownError('P2021', { modelName: 'generation_tasks' });
    expect(isRetryableWorkerLoopError(error)).toBe(true);
    expect(safeWorkerLoopErrorCode(error)).toBe('P2021');
  });

  it('P1001：Prisma 初始化 / 数据库不可达', () => {
    const error = initError('P1001');
    expect(isRetryableWorkerLoopError(error)).toBe(true);
    expect(safeWorkerLoopErrorCode(error)).toBe('P1001');
  });

  it('初始化错误缺少 errorCode 时仍重试，code 固定为 PRISMA_INIT_ERROR', () => {
    const error = initError();
    expect(isRetryableWorkerLoopError(error)).toBe(true);
    expect(safeWorkerLoopErrorCode(error)).toBe('PRISMA_INIT_ERROR');
  });

  it('ECONNREFUSED / ETIMEDOUT 等连接类系统错误', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH']) {
      const error = Object.assign(new Error(`连接失败 postgresql://user:secret@host/db`), { code });
      expect(isRetryableWorkerLoopError(error), code).toBe(true);
      expect(safeWorkerLoopErrorCode(error)).toBe(code);
    }
  });

  it('原始查询缺表 42P01（P2010 + meta）映射为 P2021 并重试', () => {
    const rawMissingTable = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: 42P01. Message: relation "generation_tasks" does not exist',
      { code: 'P2010', clientVersion: CLIENT_VERSION, meta: { code: '42P01' } },
    );
    expect(isRetryableWorkerLoopError(rawMissingTable)).toBe(true);
    expect(safeWorkerLoopErrorCode(rawMissingTable)).toBe('P2021');
  });

  it('PostgreSQL 57P01 / 57P03（含 meta 与 cause 链）', () => {
    const adminShutdown = knownError('P2010', { code: '57P01' });
    expect(isRetryableWorkerLoopError(adminShutdown)).toBe(true);
    expect(safeWorkerLoopErrorCode(adminShutdown)).toBe('57P01');

    const startingUp = Object.assign(new Error('连接中'), {
      code: 'P2010',
      cause: { code: '57P03' },
    });
    expect(isRetryableWorkerLoopError(startingUp)).toBe(true);
    expect(safeWorkerLoopErrorCode(startingUp)).toBe('57P03');
  });

  it('显式标记的 RetryableWorkerLoopError', () => {
    const error = new RetryableWorkerLoopError('DB_POOL_TEMP');
    expect(isRetryableWorkerLoopError(error)).toBe(true);
    expect(safeWorkerLoopErrorCode(error)).toBe('DB_POOL_TEMP');
  });
});

describe('永久错误 → 不得吞掉', () => {
  it('P2022：缺列按永久错误处理（不再无限重试）', () => {
    const error = knownError('P2022', { column: 'generation_tasks.new_column' });
    expect(isRetryableWorkerLoopError(error)).toBe(false);
    expect(safeWorkerLoopErrorCode(error)).toBe('P2022');
  });

  it('其它 Prisma 已知请求错误（P2002 / P2025）为永久错误', () => {
    for (const code of ['P2002', 'P2025']) {
      const error = knownError(code);
      expect(isRetryableWorkerLoopError(error), code).toBe(false);
      expect(safeWorkerLoopErrorCode(error)).toBe(code);
    }
  });

  it('Prisma 未知请求错误为永久错误', () => {
    const error = new Prisma.PrismaClientUnknownRequestError('未知请求', {
      clientVersion: CLIENT_VERSION,
    });
    expect(isRetryableWorkerLoopError(error)).toBe(false);
    expect(safeWorkerLoopErrorCode(error)).toBe('PRISMA_UNKNOWN_REQUEST');
  });

  it('Prisma 校验 / Rust panic 错误为永久错误', () => {
    const validation = new Prisma.PrismaClientValidationError('数据结构不合法', {
      clientVersion: CLIENT_VERSION,
    });
    expect(isRetryableWorkerLoopError(validation)).toBe(false);
    expect(safeWorkerLoopErrorCode(validation)).toBe('PRISMA_VALIDATION_ERROR');

    const panic = new Prisma.PrismaClientRustPanicError('panic', CLIENT_VERSION);
    expect(isRetryableWorkerLoopError(panic)).toBe(false);
    expect(safeWorkerLoopErrorCode(panic)).toBe('PRISMA_RUST_PANIC');
  });

  it('TypeError / ReferenceError / 断言错误 / 未知 Error', () => {
    const typeError = new TypeError('x is not a function postgresql://user:secret@host/db');
    expect(isRetryableWorkerLoopError(typeError)).toBe(false);
    expect(safeWorkerLoopErrorCode(typeError)).toBe('TYPE_ERROR');

    const referenceError = new ReferenceError('missing');
    expect(isRetryableWorkerLoopError(referenceError)).toBe(false);
    expect(safeWorkerLoopErrorCode(referenceError)).toBe('REFERENCE_ERROR');

    const assertion = Object.assign(new Error('assert failed'), { name: 'AssertionError' });
    expect(isRetryableWorkerLoopError(assertion)).toBe(false);
    expect(safeWorkerLoopErrorCode(assertion)).toBe('ASSERTION_ERROR');

    const unknown = new Error('sk-live-SECRET prompt 正文');
    expect(isRetryableWorkerLoopError(unknown)).toBe(false);
    expect(safeWorkerLoopErrorCode(unknown)).toBe('WORKER_LOOP_UNKNOWN');
  });

  it('WorkflowError 一律不升级为循环重试（含 retryable 业务错误）', () => {
    const business = new WorkflowError('TASK_INPUT_INVALID', '输入不合法');
    expect(isRetryableWorkerLoopError(business)).toBe(false);
    expect(safeWorkerLoopErrorCode(business)).toBe('TASK_INPUT_INVALID');

    const retryableBusiness = new RetryableTaskError('MODEL_TIMEOUT', '模型超时');
    expect(isRetryableWorkerLoopError(retryableBusiness)).toBe(false);
    expect(safeWorkerLoopErrorCode(retryableBusiness)).toBe('MODEL_TIMEOUT');
  });

  it('安全 code 永不包含原始 message / 连接串 / Key', () => {
    const error = new TypeError('sk-live-SECRET postgresql://user:secret@host/db 正文');
    const code = safeWorkerLoopErrorCode(error);
    expect(code).not.toContain('sk-live-SECRET');
    expect(code).not.toContain('postgresql://');
    expect(code).not.toContain('正文');
  });
});
