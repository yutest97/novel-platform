import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS, sanitizeAuditDetail, writeAuditLog } from '../src/audit.js';
import { closeTestDb, requireDatabaseUrl, testDb } from './helpers/db.js';

describe('审计脱敏（纯函数）', () => {
  it('丢弃密码、令牌、密钥类字段', () => {
    const sanitized = sanitizeAuditDetail({
      reason: 'bad_password',
      password: 'plain-text-password',
      passwordHash: '$argon2id$v=19$...',
      sessionToken: 'abcdef',
      secret: 'x',
      cookie: 'novel_session=abc',
      nested: { authorization: 'Bearer x', keep: 'yes' },
    });

    expect(sanitized).toEqual({
      reason: 'bad_password',
      nested: { keep: 'yes' },
    });
  });

  it('超长字符串被截断', () => {
    const sanitized = sanitizeAuditDetail({ note: 'x'.repeat(500) });

    expect(typeof sanitized).toBe('object');
    const note = (sanitized as { note: string }).note;
    expect(note.length).toBeLessThanOrEqual(201);
  });
});

describe('审计日志写入（真实 PostgreSQL）', () => {
  beforeAll(() => {
    requireDatabaseUrl();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('写入的 detail 不含密码与令牌明文', async () => {
    const db = testDb();
    const marker = `audit-${Date.now()}`;

    await writeAuditLog(db, {
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      actorId: null,
      targetType: 'user',
      targetId: null,
      detail: {
        reason: 'bad_password',
        password: 'super-secret-password',
        token: 'session-token-value',
        marker,
      },
      ip: '203.0.113.9',
      userAgent: 'vitest',
    });

    const rows = await db.auditLog.findMany({
      where: { action: AUDIT_ACTIONS.LOGIN_FAILED },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const raw = JSON.stringify(rows);
    expect(raw).not.toContain('super-secret-password');
    expect(raw).not.toContain('session-token-value');

    const row = rows.find((item) => JSON.stringify(item.detail ?? {}).includes(marker));
    expect(row).toBeDefined();
    expect(row?.detail).toEqual({ reason: 'bad_password', marker });
  });

  it('审计表是 append-only：UPDATE 与 DELETE 都被数据库拒绝', async () => {
    const db = testDb();

    await writeAuditLog(db, {
      action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      actorId: null,
      detail: { probe: true },
    });

    const row = await db.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.LOGIN_SUCCEEDED },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();

    await expect(
      db.$executeRawUnsafe(
        `UPDATE audit_logs SET action = 'tampered' WHERE id = $1::uuid`,
        row?.id,
      ),
    ).rejects.toThrowError(/append-only/);

    await expect(
      db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = $1::uuid`, row?.id),
    ).rejects.toThrowError(/append-only/);
  });
});
