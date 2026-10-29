/**
 * 并发正确性（REV-01 第 3、4 条）。
 *
 * 1) 同一账号并发建会话：advisory lock 串行化后，最终恰好 5 个会话。
 * 2) 并发错误登录：额度在进入数据库/argon2 之前同步预留，
 *    因此最多只有 5 次进入完整校验，其余立即 429。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthError } from '../src/errors.js';
import { FixedWindowRateLimiter } from '../src/ratelimit.js';
import { loginWithPassword } from '../src/service.js';
import { createSession, findSessionByToken } from '../src/sessions.js';
import {
  closeTestDb,
  createTestUser,
  requireDatabaseUrl,
  testConfig,
  testDb,
} from './helpers/db.js';

const META = { ip: '203.0.113.40', userAgent: 'vitest-concurrency' };
const CONCURRENCY = 10;
const LOGIN_CONCURRENCY = 20;
const MAX_ATTEMPTS = 5;

describe('并发正确性', () => {
  beforeAll(() => {
    requireDatabaseUrl();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('10 个并发 createSession 后，该账号恰好 5 个会话', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => createSession(db, { userId: user.id, config })),
    );

    const rejected = results.flatMap((item) =>
      item.status === 'rejected' ? [item.reason as unknown] : [],
    );
    expect(rejected).toEqual([]);

    const count = await db.session.count({ where: { userId: user.id } });
    expect(count).toBe(5);

    // 并发生成的 10 个令牌中，仍然有效的恰好 5 个（即保留的是最新 5 个）
    const tokens = results.flatMap((item) =>
      item.status === 'fulfilled' ? [item.value.token] : [],
    );
    let stillValid = 0;
    for (const token of tokens) {
      const row = await findSessionByToken(db, token);
      if (row !== null) {
        stillValid += 1;
      }
    }
    expect(stillValid).toBe(5);
  });

  it('20 个并发错误登录：恰好 5 次进入完整校验，其余 429', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig({ loginMaxAttempts: MAX_ATTEMPTS });
    const limiter = new FixedWindowRateLimiter({
      maxAttempts: MAX_ATTEMPTS,
      windowMs: config.loginWindowMs,
    });

    const results = await Promise.allSettled(
      Array.from({ length: LOGIN_CONCURRENCY }, (_, index) =>
        loginWithPassword(db, limiter, {
          email: user.email,
          password: `wrong-password-${index}`,
          config,
          meta: META,
        }),
      ),
    );

    const codes = results.map((item) =>
      item.status === 'rejected' ? (item.reason as AuthError).code : 'SUCCEEDED',
    );

    const reachedVerification = codes.filter((code) => code === 'INVALID_CREDENTIALS').length;
    const blocked = codes.filter((code) => code === 'RATE_LIMITED').length;

    expect(reachedVerification).toBe(MAX_ATTEMPTS);
    expect(blocked).toBe(LOGIN_CONCURRENCY - MAX_ATTEMPTS);
    expect(codes).not.toContain('SUCCEEDED');

    // 只有进入完整校验的那 5 次写了登录失败审计
    const auditCount = await db.auditLog.count({
      where: { action: 'auth.login_failed', actorId: user.id, ip: META.ip },
    });
    expect(auditCount).toBe(MAX_ATTEMPTS);
  });

  it('并发下的限流不会因竞态放行第 6 次校验', async () => {
    const db = testDb();
    const user = await createTestUser(db);
    const config = testConfig();
    const limiter = new FixedWindowRateLimiter({ maxAttempts: MAX_ATTEMPTS, windowMs: 60_000 });

    // 先串行用完额度
    for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
      await loginWithPassword(db, limiter, {
        email: user.email,
        password: `wrong-${index}`,
        config,
        meta: { ip: '203.0.113.41', userAgent: 'vitest' },
      }).catch(() => undefined);
    }

    // 再来 5 个并发请求：必须全部 429
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        loginWithPassword(db, limiter, {
          email: user.email,
          password: user.password,
          config,
          meta: { ip: '203.0.113.41', userAgent: 'vitest' },
        }),
      ),
    );

    for (const item of results) {
      expect(item.status).toBe('rejected');
      expect((item as PromiseRejectedResult).reason).toBeInstanceOf(AuthError);
      expect(((item as PromiseRejectedResult).reason as AuthError).code).toBe('RATE_LIMITED');
    }
  });
});
