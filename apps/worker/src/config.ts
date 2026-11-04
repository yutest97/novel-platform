/**
 * Worker 运行配置（A1-3C）。
 *
 * 只从环境变量读取，不做任何网络/数据库访问：
 * - 非法值在**启动时**直接失败，不进入轮询；
 * - 错误消息只含字段名与允许范围，绝不回显 Key 或原始环境变量；
 * - `WORKER_ID` 可选（缺省由 WorkerRunner 生成 `host:pid:random`）。
 */

/** Worker 运行参数。 */
export interface WorkerRuntimeConfig {
  /** 可选；缺省由 WorkerRunner 生成。 */
  readonly workerId: string | undefined;
  readonly leaseMs: number;
  /** 未配置时由 WorkerRunner 按 leaseMs/3 计算。 */
  readonly heartbeatIntervalMs: number | undefined;
  readonly pollIntervalMs: number;
  readonly sweepIntervalMs: number;
  readonly port: number;
}

/** 配置错误（安全文案：字段 + 范围）。 */
export class WorkerConfigError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'WorkerConfigError';
    this.field = field;
  }
}

export const DEFAULT_WORKER_LEASE_MS = 30_000;
export const DEFAULT_WORKER_POLL_MS = 1_000;
export const DEFAULT_WORKER_SWEEP_MS = 5_000;
export const DEFAULT_WORKER_PORT = 3001;

/** 与队列层 `assertLeaseMs` 保持一致。 */
export const MIN_WORKER_LEASE_MS = 100;
export const MAX_WORKER_LEASE_MS = 3_600_000;
export const MIN_WORKER_INTERVAL_MS = 1;
export const MAX_WORKER_INTERVAL_MS = 600_000;
export const MAX_WORKER_ID_LENGTH = 128;

function parseInteger(
  env: NodeJS.ProcessEnv,
  field: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const raw = env[field];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const trimmed = raw.trim();
  // Number('0x10') / Number('1e3') 会接受非十进制写法，这里只接受纯数字。
  if (!/^-?\d+$/.test(trimmed)) {
    throw new WorkerConfigError(field, `${field} 必须是 ${min}..${max} 的整数`);
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new WorkerConfigError(field, `${field} 必须是 ${min}..${max} 的整数`);
  }
  return value;
}

function parseWorkerId(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env['WORKER_ID'];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.length > MAX_WORKER_ID_LENGTH) {
    throw new WorkerConfigError('WORKER_ID', `WORKER_ID 不能超过 ${MAX_WORKER_ID_LENGTH} 个字符`);
  }
  return trimmed;
}

/**
 * 读取并校验 Worker 运行配置。
 *
 * @throws WorkerConfigError 字段非法（消息不含任何密钥）
 */
export function readWorkerRuntimeConfig(env: NodeJS.ProcessEnv = process.env): WorkerRuntimeConfig {
  const leaseMs = parseInteger(
    env,
    'WORKER_LEASE_MS',
    DEFAULT_WORKER_LEASE_MS,
    MIN_WORKER_LEASE_MS,
    MAX_WORKER_LEASE_MS,
  );

  let heartbeatIntervalMs: number | undefined;
  const rawHeartbeat = env['WORKER_HEARTBEAT_MS'];
  if (rawHeartbeat !== undefined && rawHeartbeat.trim() !== '') {
    heartbeatIntervalMs = parseInteger(
      env,
      'WORKER_HEARTBEAT_MS',
      Math.max(1, Math.floor(leaseMs / 3)),
      MIN_WORKER_INTERVAL_MS,
      MAX_WORKER_INTERVAL_MS,
    );
    // 心跳必须严格早于租约到期，否则租约还没续上就被别的 Worker 回收。
    if (heartbeatIntervalMs >= leaseMs) {
      throw new WorkerConfigError(
        'WORKER_HEARTBEAT_MS',
        `WORKER_HEARTBEAT_MS 必须小于 WORKER_LEASE_MS（${leaseMs}）`,
      );
    }
  }

  const pollIntervalMs = parseInteger(
    env,
    'WORKER_POLL_MS',
    DEFAULT_WORKER_POLL_MS,
    MIN_WORKER_INTERVAL_MS,
    MAX_WORKER_INTERVAL_MS,
  );
  const sweepIntervalMs = parseInteger(
    env,
    'WORKER_SWEEP_MS',
    DEFAULT_WORKER_SWEEP_MS,
    MIN_WORKER_INTERVAL_MS,
    MAX_WORKER_INTERVAL_MS,
  );
  const port = parseInteger(env, 'WORKER_PORT', DEFAULT_WORKER_PORT, 1, 65_535);

  return {
    workerId: parseWorkerId(env),
    leaseMs,
    heartbeatIntervalMs,
    pollIntervalMs,
    sweepIntervalMs,
    port,
  };
}
