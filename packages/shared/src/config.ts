/**
 * 服务身份与运行期元信息的共享定义。
 *
 * M1-A 阶段仅承载骨架所需的最小信息；业务对象（作品、章节、事实等）不在本轮范围内。
 */

/** 仓库内所有服务的名称。 */
export const SERVICE_NAMES = {
  web: 'web',
  worker: 'worker',
} as const;

/** 服务名称的联合类型。 */
export type ServiceName = (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES];

/** 统一的运行时配置键名（值一律来自环境变量，不硬编码密钥）。 */
export const CONFIG_KEYS = {
  DATABASE_URL: 'DATABASE_URL',
  WEB_PORT: 'WEB_PORT',
  WORKER_PORT: 'WORKER_PORT',
  NODE_ENV: 'NODE_ENV',
  LOG_LEVEL: 'LOG_LEVEL',
  MODEL_BASE_URL: 'MODEL_BASE_URL',
  MODEL_NAME: 'MODEL_NAME',
  MODEL_API_KEY: 'MODEL_API_KEY',
} as const;

/**
 * 从环境变量读取一个字符串配置。
 *
 * 缺失时抛出明确错误，避免服务在"配置静默缺失"的情况下假装健康。
 */
export function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`缺少必需的环境变量：${key}`);
  }
  return value;
}

/**
 * 从环境变量读取一个整数配置，失败时回退到默认值。
 */
export function readIntEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
