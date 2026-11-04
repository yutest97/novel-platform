/**
 * PostgreSQL Worker 运行器（A1-1）。
 *
 * 一个轮询周期：
 *   1. 回收过期租约（取消优先 → 次数用尽判失败 → 其余重新排队）；
 *   2. `FOR UPDATE SKIP LOCKED` 领取一个 queued 任务；
 *   3. 启动心跳定时器（续租失败立即 abort，停止后续步骤）；
 *   4. 交给 WorkflowKernel 按固定步骤执行，每步写 current_step；
 *   5. 完成 / 重试 / 失败 / 取消四选一，全部带 `locked_by` fencing。
 *      成功与取消共用一个终态入口：`cancel_requested_at` 在同一条 UPDATE 里
 *      原子判断，取消优先于成功与失败（含可重试错误）。
 *
 * 崩溃语义：进程直接消失不会写任何终态；租约到期后由其它 Worker 的 sweep
 * 重新排队或判失败，因此不会留下"永久 processing"。
 *
 * 日志：只允许 taskId / taskType / status / errorCode 这类定位字段，
 * 绝不打印 input_snapshot、prompt、正文或原始异常。
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { PrismaClient } from '@novel/db';

import { sanitizeTaskError, TaskLeaseLostError } from './errors.js';
import type { WorkflowKernel } from './kernel.js';
import {
  claimNextTask,
  completeTask,
  failTask,
  getTaskCancellationState,
  heartbeatTask,
  sweepExpiredTasks,
  updateTaskStep,
  type GenerationTaskView,
} from './queue.js';

/** 单个轮询周期的结果。 */
export type WorkerRunOutcome =
  'idle' | 'succeeded' | 'retried' | 'failed' | 'cancelled' | 'lease-lost';

/** 日志接口（只允许安全字段）。 */
export interface WorkerLogger {
  info(message: string, meta?: Record<string, string | number>): void;
  warn(message: string, meta?: Record<string, string | number>): void;
  error(message: string, meta?: Record<string, string | number>): void;
}

const consoleLogger: WorkerLogger = {
  info: (message, meta) => {
    console.log(`[workflow] ${message}`, meta ?? '');
  },
  warn: (message, meta) => {
    console.warn(`[workflow] ${message}`, meta ?? '');
  },
  error: (message, meta) => {
    console.error(`[workflow] ${message}`, meta ?? '');
  },
};

export interface WorkerRunnerOptions {
  readonly workerId?: string;
  readonly leaseMs?: number;
  /** 默认 leaseMs/3。 */
  readonly heartbeatIntervalMs?: number;
  readonly pollIntervalMs?: number;
  readonly sweepIntervalMs?: number;
  readonly logger?: WorkerLogger;
  /** 仅用于测试的时钟（调度用，不参与租约计算）。 */
  readonly now?: () => number;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_SWEEP_MS = 5_000;

function defaultWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

function assertPositiveInt(value: number, field: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${field} 必须是 1..${max} 的整数`);
  }
  return value;
}

export class WorkerRunner {
  private readonly db: PrismaClient;
  private readonly kernel: WorkflowKernel;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly sweepIntervalMs: number;
  private readonly logger: WorkerLogger;
  private readonly now: () => number;

  private stopped = false;
  private wake: (() => void) | null = null;
  private lastSweepAt = 0;

  constructor(db: PrismaClient, kernel: WorkflowKernel, options: WorkerRunnerOptions = {}) {
    this.db = db;
    this.kernel = kernel;
    this.workerId = options.workerId ?? defaultWorkerId();
    this.leaseMs = assertPositiveInt(options.leaseMs ?? DEFAULT_LEASE_MS, 'leaseMs', 3_600_000);
    this.heartbeatIntervalMs = assertPositiveInt(
      options.heartbeatIntervalMs ?? Math.max(1, Math.floor(this.leaseMs / 3)),
      'heartbeatIntervalMs',
      600_000,
    );
    this.pollIntervalMs = assertPositiveInt(
      options.pollIntervalMs ?? DEFAULT_POLL_MS,
      'pollIntervalMs',
      600_000,
    );
    this.sweepIntervalMs = assertPositiveInt(
      options.sweepIntervalMs ?? DEFAULT_SWEEP_MS,
      'sweepIntervalMs',
      600_000,
    );
    this.logger = options.logger ?? consoleLogger;
    this.now = options.now ?? (() => Date.now());
  }

  /** 当前 Worker 标识（测试断言用）。 */
  get id(): string {
    return this.workerId;
  }

  /** 执行一个轮询周期；测试应优先调用它，而不是 start()。 */
  async runOnce(): Promise<WorkerRunOutcome> {
    await this.maybeSweep();

    const task = await claimNextTask(this.db, {
      workerId: this.workerId,
      leaseMs: this.leaseMs,
    });
    if (task === null) {
      return 'idle';
    }

    this.logger.info('task claimed', { taskId: task.id, taskType: task.taskType });
    return this.executeTask(task);
  }

  /**
   * 循环执行，直到 stop()。
   *
   * 不吞异常：runOnce 抛错会让 start 退出，由进程管理器重启（崩溃恢复靠租约）。
   */
  async start(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      const outcome = await this.runOnce();
      if (outcome === 'idle' && !this.stopped) {
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  /** 请求停止（当前任务完成后退出；进程被杀则靠租约回收）。 */
  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  private async maybeSweep(): Promise<void> {
    const now = this.now();
    if (this.lastSweepAt !== 0 && now - this.lastSweepAt < this.sweepIntervalMs) {
      return;
    }
    this.lastSweepAt = now;
    const result = await sweepExpiredTasks(this.db);
    if (result.cancelled + result.failed + result.requeued > 0) {
      this.logger.warn('expired leases swept', {
        cancelled: result.cancelled,
        failed: result.failed,
        requeued: result.requeued,
      });
    }
  }

  private async executeTask(task: GenerationTaskView): Promise<WorkerRunOutcome> {
    const cancellation = await getTaskCancellationState(this.db, task.id);
    if (cancellation === null) {
      return 'lease-lost';
    }
    if (cancellation.cancelRequested) {
      // 取消是终态结论：与"完成"共用同一条原子 UPDATE，避免与并发完成互相覆盖。
      const finalStatus = await completeTask(this.db, {
        taskId: task.id,
        workerId: this.workerId,
      });
      if (finalStatus === 'lost') {
        return 'lease-lost';
      }
      this.logger.info('task cancelled', { taskId: task.id, taskType: task.taskType });
      return 'cancelled';
    }

    const controller = new AbortController();
    let leaseLost = false;
    const timer = setInterval(() => {
      void heartbeatTask(this.db, {
        taskId: task.id,
        workerId: this.workerId,
        leaseMs: this.leaseMs,
      })
        .then((ok) => {
          if (!ok) {
            leaseLost = true;
            controller.abort();
          }
        })
        .catch(() => {
          // 心跳失败不打印原始错误：可能是连接串等敏感信息。
          leaseLost = true;
          controller.abort();
        });
    }, this.heartbeatIntervalMs);
    timer.unref();

    try {
      await this.kernel.execute(
        {
          taskId: task.id,
          workId: task.workId,
          chapterId: task.chapterId,
          requestId: task.requestId,
          taskType: task.taskType,
          input: task.inputSnapshot,
        },
        {
          signal: controller.signal,
          isCancelled: async () => {
            if (leaseLost) {
              return true;
            }
            const state = await getTaskCancellationState(this.db, task.id);
            return state === null || state.cancelRequested || state.status !== 'processing';
          },
          onStepCompleted: async (step) => {
            const ok = await updateTaskStep(this.db, {
              taskId: task.id,
              workerId: this.workerId,
              step,
            });
            if (!ok) {
              throw new TaskLeaseLostError();
            }
          },
        },
      );

      // 本地已判定租约丢失：不写任何终态，交给 sweep 回收（避免误写成功）。
      if (leaseLost) {
        this.logger.warn('task lease lost', { taskId: task.id });
        return 'lease-lost';
      }

      // 成功与取消共用同一个终态入口：`cancel_requested_at` 在 SQL 里原子判断，
      // 因此"步骤刚跑完、取消刚好到达"也不会被写成 succeeded。
      const finalStatus = await completeTask(this.db, {
        taskId: task.id,
        workerId: this.workerId,
      });
      if (finalStatus === 'lost') {
        return 'lease-lost';
      }
      if (finalStatus === 'cancelled') {
        this.logger.info('task cancelled', { taskId: task.id, taskType: task.taskType });
        return 'cancelled';
      }
      this.logger.info('task succeeded', { taskId: task.id, taskType: task.taskType });
      return 'succeeded';
    } catch (error) {
      if (error instanceof TaskLeaseLostError || leaseLost) {
        this.logger.warn('task lease lost', { taskId: task.id });
        return 'lease-lost';
      }

      const sanitized = sanitizeTaskError(error);
      const status = await failTask(this.db, {
        taskId: task.id,
        workerId: this.workerId,
        errorCode: sanitized.code,
        message: sanitized.message,
        retryable: sanitized.retryable,
      });
      if (status === 'lost') {
        this.logger.warn('task lease lost while failing', { taskId: task.id });
        return 'lease-lost';
      }
      if (status === 'cancelled') {
        this.logger.info('task cancelled', { taskId: task.id, taskType: task.taskType });
        return 'cancelled';
      }
      this.logger.warn('task failed', {
        taskId: task.id,
        taskType: task.taskType,
        errorCode: sanitized.code,
        status,
      });
      return status === 'queued' ? 'retried' : 'failed';
    } finally {
      clearInterval(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stopped) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
