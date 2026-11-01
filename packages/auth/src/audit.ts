/**
 * 审计日志写入（append-only）。
 *
 * 约束：
 * - 只提供写入接口，不提供更新与删除接口；数据库层另有触发器禁止 UPDATE/DELETE。
 * - 写入前对 detail 做**脱敏**：任何键名疑似密码/令牌/密钥的字段一律丢弃。
 * - 登录失败审计**不记录**用户提交的密码，也不记录 Cookie 或会话令牌。
 */

import type { PrismaClient } from '@novel/db';

/**
 * 审计写入所需的最小数据库能力。
 *
 * 同时接受 `PrismaClient` 与 `Prisma.TransactionClient`，
 * 以便把「业务修改 + 审计写入」放进**同一个事务**：
 * 审计写失败时，业务修改会随事务一起回滚。
 */
export type AuditDb = Pick<PrismaClient, 'auditLog'>;

/** 审计动作常量（与 docs 中的动作命名保持一致）。 */
export const AUDIT_ACTIONS = {
  ADMIN_CREATED: 'admin.created',
  ADMIN_USER_CREATED: 'admin.user_created',
  LOGIN_SUCCEEDED: 'auth.login_succeeded',
  LOGIN_FAILED: 'auth.login_failed',
  LOGOUT: 'auth.logout',
  PASSWORD_CHANGED: 'auth.password_changed',
  USER_DISABLED: 'user.disabled',
  USER_ENABLED: 'user.enabled',
  ADMIN_PASSWORD_RESET: 'admin.password_reset',
  WORK_CREATED: 'work.created',
  WORK_UPDATED: 'work.updated',
} as const;

/** 审计动作类型。 */
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** 疑似敏感的键名（命中即丢弃该字段）。 */
const SENSITIVE_KEY_PATTERN =
  /pass(word)?|secret|token|cookie|authorization|hash|api[-_]?key|credential/i;

/** detail 中单个字符串的最大保留长度。 */
const MAX_STRING_LENGTH = 200;

/** 脱敏后的 JSON 值。 */
export type SanitizedValue =
  string | number | boolean | null | SanitizedValue[] | { [key: string]: SanitizedValue };

/**
 * 递归脱敏任意 detail。
 *
 * - 命中敏感键名的字段整条丢弃；
 * - 字符串截断到 200 字符；
 * - 函数、undefined、Symbol 等不可序列化值替换为 null。
 */
export function sanitizeAuditDetail(value: unknown, depth = 0): SanitizedValue {
  if (depth > 4) {
    return null;
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeAuditDetail(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: { [key: string]: SanitizedValue } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        continue;
      }
      result[key] = sanitizeAuditDetail(item, depth + 1);
    }
    return result;
  }
  return null;
}

/** 写审计日志的输入。 */
export interface AuditEntry {
  readonly action: AuditAction;
  /** 操作者；账号不存在等场景可为 null。 */
  readonly actorId?: string | null;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly detail?: unknown;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** 写入一条审计日志。 */
export async function writeAuditLog(db: AuditDb, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      action: entry.action,
      actorId: entry.actorId ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      detail: (sanitizeAuditDetail(entry.detail) as never) ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
    },
  });
}
