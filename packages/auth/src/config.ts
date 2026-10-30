/**
 * 认证相关的运行期配置。
 *
 * 所有取值来自环境变量，代码中**不硬编码任何密钥**。
 * 缺少关键配置时使用文档化的安全默认值；明显不安全的组合（如关闭 Secure）
 * 只在显式配置下生效，并在启动日志中提示。
 */

/** 会话 Cookie 名称。 */
export const SESSION_COOKIE_NAME = 'novel_session';

/** 每个账号允许的最大活跃会话数（固定为 5，不通过环境变量放开）。 */
export const MAX_ACTIVE_SESSIONS = 5;

/**
 * 账号总数上限（含 disabled 账号）。
 *
 * 固定为 10，**不**通过环境变量放开：这是产品约束（封闭小团队自用），
 * 也不提供删除账号接口，因此上限就是硬上限。
 */
export const MAX_USER_ACCOUNTS = 10;

/**
 * 读取生效的账号上限。
 *
 * 上限**只允许调小、不允许调大**（返回值恒 ≤ MAX_USER_ACCOUNTS）：
 * 生产环境没有任何环境变量能突破 10 个账号的产品约束；
 * `AUTH_MAX_USER_ACCOUNTS` 仅用于测试在小规模数据上验证上限逻辑。
 */
export function readMaxUserAccounts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['AUTH_MAX_USER_ACCOUNTS'];
  if (raw === undefined || raw.trim() === '') {
    return MAX_USER_ACCOUNTS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return MAX_USER_ACCOUNTS;
  }
  return Math.min(parsed, MAX_USER_ACCOUNTS);
}

/** 服务器生成的一次性口令长度（≥20 字符要求，这里取 24）。 */
export const GENERATED_PASSWORD_LENGTH = 24;

/** 默认绝对有效期：12 小时。 */
const DEFAULT_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;

/** 默认空闲有效期：30 分钟。 */
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

/** 默认登录失败限流：15 分钟内最多 5 次。 */
const DEFAULT_LOGIN_MAX_ATTEMPTS = 5;
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** 密码最小长度（字符）。 */
export const MIN_PASSWORD_LENGTH = 12;

/** 密码最大长度（字符）——避免超长输入放大哈希开销。 */
export const MAX_PASSWORD_LENGTH = 200;

/** 认证配置。 */
export interface AuthConfig {
  /** 会话绝对有效期（毫秒）。 */
  readonly sessionAbsoluteTtlMs: number;
  /** 会话空闲有效期（毫秒）。 */
  readonly sessionIdleTtlMs: number;
  /** 每账号最大活跃会话数。 */
  readonly maxActiveSessions: number;
  /** Cookie 名称。 */
  readonly cookieName: string;
  /** 是否给 Cookie 加 Secure（默认 true；本地 http 调试才可关闭）。 */
  readonly cookieSecure: boolean;
  /** 登录失败限流：窗口内最大失败次数。 */
  readonly loginMaxAttempts: number;
  /** 登录失败限流窗口（毫秒）。 */
  readonly loginWindowMs: number;
  /**
   * 期望的站点来源（scheme://host[:port]）。
   * 未配置时从请求 URL 推导（同源校验）。
   */
  readonly appOrigin: string | undefined;
}

/** 读取正整数环境变量，非法时回退默认值。 */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 读取布尔环境变量（'false' / '0' 视为 false）。 */
function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  return fallback;
}

/**
 * 从环境变量构造认证配置。
 *
 * - `AUTH_SESSION_ABSOLUTE_HOURS`：绝对有效期小时数（默认 12）
 * - `AUTH_SESSION_IDLE_MINUTES`：空闲有效期分钟数（默认 30）
 * - `AUTH_COOKIE_SECURE`：是否 Secure（默认 true）
 * - `AUTH_LOGIN_MAX_ATTEMPTS` / `AUTH_LOGIN_WINDOW_MINUTES`：登录失败限流
 * - `APP_ORIGIN`：期望来源，例如 `http://localhost:3000`
 */
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const absoluteHours = readPositiveInt(env['AUTH_SESSION_ABSOLUTE_HOURS'], 12);
  const idleMinutes = readPositiveInt(env['AUTH_SESSION_IDLE_MINUTES'], 30);

  const sessionAbsoluteTtlMs = absoluteHours * 60 * 60 * 1000;
  const idleTtlMs = idleMinutes * 60 * 1000;

  const appOrigin = env['APP_ORIGIN'];

  return {
    sessionAbsoluteTtlMs,
    // 空闲有效期不得超过绝对有效期，否则数据库 CHECK 约束会拒绝写入。
    sessionIdleTtlMs: Math.min(idleTtlMs, sessionAbsoluteTtlMs),
    maxActiveSessions: MAX_ACTIVE_SESSIONS,
    cookieName: SESSION_COOKIE_NAME,
    cookieSecure: readBoolean(env['AUTH_COOKIE_SECURE'], true),
    loginMaxAttempts: readPositiveInt(env['AUTH_LOGIN_MAX_ATTEMPTS'], DEFAULT_LOGIN_MAX_ATTEMPTS),
    loginWindowMs:
      readPositiveInt(env['AUTH_LOGIN_WINDOW_MINUTES'], DEFAULT_LOGIN_WINDOW_MS / 60000) * 60000,
    appOrigin: appOrigin === undefined || appOrigin.trim() === '' ? undefined : appOrigin.trim(),
  };
}

/** 默认配置（无环境变量时的安全默认值，供测试与类型参考）。 */
export const DEFAULT_AUTH_CONFIG: AuthConfig = readAuthConfig({});

export { DEFAULT_ABSOLUTE_TTL_MS, DEFAULT_IDLE_TTL_MS };
