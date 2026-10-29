import { describe, expect, it } from 'vitest';

import { FixedWindowRateLimiter } from '../src/ratelimit.js';

describe('登录失败限流（固定窗口）', () => {
  it('窗口内允许 5 次，第 6 次被拒绝', () => {
    const limiter = new FixedWindowRateLimiter({ maxAttempts: 5, windowMs: 60_000 });

    for (let index = 0; index < 5; index += 1) {
      expect(limiter.consume('k').allowed).toBe(true);
    }

    const blocked = limiter.consume('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('inspect 不消耗配额', () => {
    const limiter = new FixedWindowRateLimiter({ maxAttempts: 2, windowMs: 60_000 });

    limiter.consume('k');
    expect(limiter.inspect('k').remaining).toBe(1);
    expect(limiter.inspect('k').remaining).toBe(1);
  });

  it('窗口过期后恢复可用', () => {
    let now = 1_000_000;
    const limiter = new FixedWindowRateLimiter({
      maxAttempts: 1,
      windowMs: 1_000,
      now: () => now,
    });

    expect(limiter.consume('k').allowed).toBe(true);
    expect(limiter.consume('k').allowed).toBe(false);

    now += 1_001;
    expect(limiter.consume('k').allowed).toBe(true);
  });

  it('reset 后立即恢复（登录成功清零）', () => {
    const limiter = new FixedWindowRateLimiter({ maxAttempts: 1, windowMs: 60_000 });

    limiter.consume('k');
    expect(limiter.inspect('k').allowed).toBe(false);

    limiter.reset('k');
    expect(limiter.inspect('k').allowed).toBe(true);
  });

  it('不同键互不影响', () => {
    const limiter = new FixedWindowRateLimiter({ maxAttempts: 1, windowMs: 60_000 });

    limiter.consume('a');
    expect(limiter.inspect('b').allowed).toBe(true);
  });
});
