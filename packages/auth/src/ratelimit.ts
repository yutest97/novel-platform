/**
 * 登录失败限流（固定窗口计数）。
 *
 * 设计取舍：
 * - 单进程内存计数，够用于单实例部署；多实例部署时应换成共享存储
 *   （Redis 等），本轮不引入额外基础设施依赖。
 * - 以"邮箱 + 来源 IP"为主要维度，另加纯 IP 维度，避免单一维度被绕过。
 * - 只对**失败**计数，登录成功后清零，避免正常用户被误伤。
 */

/** 单次限流检查结果。 */
export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

/** 固定窗口限流器。 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { maxAttempts: number; windowMs: number; now?: () => number }) {
    this.maxAttempts = options.maxAttempts;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
  }

  /** 消耗一次配额（用于记录一次失败尝试）。 */
  consume(key: string): RateLimitResult {
    const now = this.now();
    this.prune(now);

    let bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }

    if (bucket.count >= this.maxAttempts) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }

    bucket.count += 1;
    return { allowed: true, remaining: this.maxAttempts - bucket.count, retryAfterSeconds: 0 };
  }

  /** 仅查询是否已被限流，不消耗配额。 */
  inspect(key: string): RateLimitResult {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      return { allowed: true, remaining: this.maxAttempts, retryAfterSeconds: 0 };
    }
    if (bucket.count >= this.maxAttempts) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, remaining: this.maxAttempts - bucket.count, retryAfterSeconds: 0 };
  }

  /** 登录成功后清空该键的计数。 */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** 清空全部计数（测试用）。 */
  resetAll(): void {
    this.buckets.clear();
  }

  /** 清理过期桶，避免内存无界增长。 */
  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}

/** 登录限流键：邮箱 + IP。 */
export function loginRateLimitKey(email: string, ip: string | null): string {
  return `login:${email}:${ip ?? 'unknown'}`;
}

/** 登录限流键：纯 IP。 */
export function loginIpRateLimitKey(ip: string | null): string {
  return `login-ip:${ip ?? 'unknown'}`;
}
