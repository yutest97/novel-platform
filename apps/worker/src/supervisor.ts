/**
 * Worker 循环 supervisor（A1-3C-REV-01）。
 *
 * 直接调用 `WorkerRunner.runOnce()`（而不是 `start()`），以便：
 * - 记录循环健康状态（starting / ready / retrying / stopping / failed）；
 * - 区分瞬态基础设施错误（退避重试）与永久错误（退出 1）；
 * - 让 stop() 能立即打断退避 sleep，且不再启动新一轮 runOnce。
 *
 * 只要 runOnce **正常返回**（idle / succeeded / retried / failed / cancelled /
 * lease-lost），就视为循环健康：连续失败数归零，状态回到 ready。
 * runOnce 内部已经把任务级失败/重试/取消收敛为返回值，因此抛出的异常只可能是
 * 数据库或基础设施问题。
 */

import type { WorkerLogger } from '@novel/workflow';

import { isRetryableWorkerLoopError, safeWorkerLoopErrorCode } from './loop-errors.js';

/** 循环状态。 */
export type WorkerLoopState = 'starting' | 'ready' | 'retrying' | 'stopping' | 'failed';

/** 供健康检查读取的安全快照（不含任何原始错误信息）。 */
export interface WorkerLoopSnapshot {
  readonly state: WorkerLoopState;
  readonly consecutiveFailures: number;
  readonly errorCode: string | null;
  readonly nextRetryMs: number | null;
  /** ISO 8601；从未成功轮询时为 null。 */
  readonly lastSuccessAt: string | null;
}

/** supervisor 退出结果。 */
export type WorkerLoopExit =
  { readonly status: 'stopped' } | { readonly status: 'failed'; readonly errorCode: string };

/** supervisor 只关心 runOnce 是否正常返回；generation / novel 两种循环都可传入。 */
export interface WorkerLoopRunner {
  runOnce(): Promise<string>;
}

export interface WorkerLoopSupervisorOptions {
  /** 只需要 runOnce；WorkerRunner、NovelCoordinatorWorker 或测试替身均可。 */
  readonly runner: WorkerLoopRunner;
  /** 空队列轮询间隔（健康轮询后的等待）。 */
  readonly pollIntervalMs: number;
  readonly logger: WorkerLogger;
  readonly now?: () => number;
  /** 首次退避（默认 1000ms）。 */
  readonly minRetryMs?: number;
  /** 退避上限（默认 5000ms）。 */
  readonly maxRetryMs?: number;
}

const DEFAULT_MIN_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 5_000;

/** 循环状态严重度：合并多个循环时取最严重的一个。 */
const LOOP_STATE_SEVERITY: Record<WorkerLoopState, number> = {
  ready: 0,
  starting: 1,
  retrying: 2,
  stopping: 3,
  failed: 4,
};

/**
 * 合并多个轮询循环快照（generation task 与 novel runs 各一个）。
 *
 * 任一循环永久失败即整体 failed；任一循环退避即整体 retrying；
 * 只有全部 ready 才 ready。错误码只保留最严重循环的非空值。
 */
export function mergeWorkerLoopSnapshots(
  snapshots: readonly WorkerLoopSnapshot[],
): WorkerLoopSnapshot {
  if (snapshots.length === 0) {
    return {
      state: 'starting',
      consecutiveFailures: 0,
      errorCode: null,
      nextRetryMs: null,
      lastSuccessAt: null,
    };
  }
  let merged = snapshots[0] as WorkerLoopSnapshot;
  for (const snapshot of snapshots.slice(1)) {
    const severity = LOOP_STATE_SEVERITY[snapshot.state];
    const mergedSeverity = LOOP_STATE_SEVERITY[merged.state];
    const lastSuccessAt =
      [merged.lastSuccessAt, snapshot.lastSuccessAt]
        .filter((value): value is string => value !== null)
        .sort()[0] ?? null;
    merged = {
      state: severity >= mergedSeverity ? snapshot.state : merged.state,
      consecutiveFailures: Math.max(merged.consecutiveFailures, snapshot.consecutiveFailures),
      errorCode:
        severity >= mergedSeverity
          ? (snapshot.errorCode ?? merged.errorCode)
          : (merged.errorCode ?? snapshot.errorCode),
      nextRetryMs: Math.max(merged.nextRetryMs ?? 0, snapshot.nextRetryMs ?? 0) || null,
      lastSuccessAt,
    };
  }
  return merged;
}

function assertPositive(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} 必须是正整数`);
  }
  return value;
}

export class WorkerLoopSupervisor {
  private readonly runner: WorkerLoopRunner;
  private readonly pollIntervalMs: number;
  private readonly minRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly logger: WorkerLogger;
  private readonly now: () => number;

  private state: WorkerLoopState = 'starting';
  private consecutiveFailures = 0;
  private errorCode: string | null = null;
  private nextRetryMs: number | null = null;
  private lastSuccessAt: number | null = null;
  private stopping = false;
  private started = false;
  private wakeSleep: (() => void) | null = null;

  constructor(options: WorkerLoopSupervisorOptions) {
    this.runner = options.runner;
    this.pollIntervalMs = assertPositive(options.pollIntervalMs, 'pollIntervalMs');
    this.minRetryMs = assertPositive(options.minRetryMs ?? DEFAULT_MIN_RETRY_MS, 'minRetryMs');
    this.maxRetryMs = assertPositive(options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS, 'maxRetryMs');
    if (this.maxRetryMs < this.minRetryMs) {
      throw new Error('maxRetryMs 不能小于 minRetryMs');
    }
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  /** 当前状态快照（纯值，调用方无法修改内部状态）。 */
  snapshot(): WorkerLoopSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      errorCode: this.errorCode,
      nextRetryMs: this.nextRetryMs,
      lastSuccessAt:
        this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt).toISOString(),
    };
  }

  /**
   * 请求停止。
   *
   * - 立即切到 stopping（失败态保持 failed），先于关闭健康端口；
   * - 唤醒退避 sleep；
   * - run() 不会在停止后再调用 runOnce。
   */
  stop(): void {
    this.stopping = true;
    if (this.state !== 'failed') {
      this.state = 'stopping';
    }
    this.wakeSleep?.();
  }

  /** 运行循环，直到 stop() 或遇到永久错误。 */
  async run(): Promise<WorkerLoopExit> {
    if (this.started) {
      throw new Error('WorkerLoopSupervisor 只能运行一次');
    }
    this.started = true;

    while (!this.stopping) {
      try {
        const outcome = await this.runner.runOnce();
        if (this.stopping) {
          break;
        }
        this.markHealthy();
        if (outcome === 'idle') {
          await this.sleep(this.pollIntervalMs);
        }
      } catch (error) {
        if (this.stopping) {
          break;
        }

        this.consecutiveFailures += 1;
        const code = safeWorkerLoopErrorCode(error);

        if (!isRetryableWorkerLoopError(error)) {
          this.state = 'failed';
          this.errorCode = code;
          this.nextRetryMs = null;
          this.logger.error('worker loop failed permanently', {
            errorCode: code,
            failures: this.consecutiveFailures,
          });
          return { status: 'failed', errorCode: code };
        }

        this.state = 'retrying';
        this.errorCode = code;
        const delay = Math.min(
          this.minRetryMs * 2 ** (this.consecutiveFailures - 1),
          this.maxRetryMs,
        );
        this.nextRetryMs = delay;
        this.logger.warn('worker loop retrying', {
          errorCode: code,
          failures: this.consecutiveFailures,
          nextRetryMs: delay,
        });
        await this.sleep(delay);
      }
    }

    return { status: 'stopped' };
  }

  /** 任一次正常返回都算健康轮询：清零失败计数并进入 ready。 */
  private markHealthy(): void {
    const wasReady = this.state === 'ready';
    this.state = 'ready';
    this.consecutiveFailures = 0;
    this.errorCode = null;
    this.nextRetryMs = null;
    this.lastSuccessAt = this.now();
    if (!wasReady) {
      this.logger.info('worker loop ready');
    }
  }

  /** 可被 stop() 打断的 sleep。 */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stopping) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.wakeSleep = null;
        resolve();
      }, ms);
      this.wakeSleep = () => {
        clearTimeout(timer);
        this.wakeSleep = null;
        resolve();
      };
    });
  }
}
