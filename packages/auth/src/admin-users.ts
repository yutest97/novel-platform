/**
 * 管理员账号管理（M1-B2）：列表、创建作者。
 *
 * 安全约束：
 * - 所有写操作走 `runAdminGovernance`：固定 advisory lock → 事务内重读 actor
 *   （存在 / active / admin / 已改密）→ 再读目标/计数/写入/写审计。
 * - 账号总数上限 MAX_USER_ACCOUNTS：在事务内 count + insert，
 *   配合治理锁串行化，并发创建也无法突破上限。
 * - 服务器生成的一次性口令只在返回值中出现一次，不落库明文、不写日志与审计。
 * - 列表只返回安全字段，绝不包含 passwordHash / 会话令牌 / 审计详情。
 */

import type { PrismaClient } from '@novel/db';

import { AUDIT_ACTIONS, writeAuditLog } from './audit.js';
import { readMaxUserAccounts } from './config.js';
import { AuthError } from './errors.js';
import { generateInitialPassword, hashPassword } from './password.js';
import { toPublicUser, type PublicUser } from './sessions.js';
import type { RequestMeta } from './types.js';
import {
  assertAcceptableInitialPassword,
  assertValidEmail,
  normalizeEmail,
  runAdminGovernance,
} from './users.js';

/** 管理接口对外的账号视图（固定字段，永不含 passwordHash）。 */
export interface AdminUserView {
  readonly id: string;
  readonly email: string;
  readonly role: 'admin' | 'author';
  readonly status: 'active' | 'disabled';
  readonly mustChangePassword: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 数据库行 → 对外视图。 */
function toAdminUserView(user: {
  id: string;
  email: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AdminUserView {
  return {
    id: user.id,
    email: user.email,
    role: user.role === 'admin' ? 'admin' : 'author',
    status: user.status === 'disabled' ? 'disabled' : 'active',
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/**
 * 列出全部账号（按创建时间正序，第一版不分页）。
 *
 * 只 select 安全字段；排序以 id 作为次级键保证稳定。
 */
export async function listUsers(db: PrismaClient): Promise<AdminUserView[]> {
  const rows = await db.user.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      mustChangePassword: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return rows.map(toAdminUserView);
}

/** 创建作者账号的结果：`initialPassword` 只在此处出现一次。 */
export interface CreatedAuthor {
  readonly user: AdminUserView;
  /**
   * 服务器生成的一次性口令。
   * 调用方**显式**提供了初始密码时为 `null`（不回声管理员自己输入的口令）。
   */
  readonly initialPassword: string | null;
}

/**
 * 管理员创建作者账号。
 *
 * - role 固定 author（不接受调用方指定）；
 * - 未提供 initialPassword 时由服务器生成 ≥20 字符口令；
 * - mustChangePassword 恒为 true；
 * - 邮箱统一小写，重复返回稳定冲突 EMAIL_TAKEN（409）；
 * - 账号数已达上限返回 USER_LIMIT_REACHED（409）。
 */
export async function createAuthorUser(
  db: PrismaClient,
  input: {
    actorId: string;
    email: string;
    initialPassword?: string | undefined;
    meta: RequestMeta;
  },
): Promise<CreatedAuthor> {
  const email = normalizeEmail(input.email);
  assertValidEmail(email);

  const providedPassword = input.initialPassword;
  const initialPassword = providedPassword ?? generateInitialPassword();
  assertAcceptableInitialPassword(initialPassword);

  // 哈希在事务外完成（argon2 较慢，避免长时间持有治理锁）。
  const passwordHash = await hashPassword(initialPassword);

  const user = await runAdminGovernance(db, input.actorId, async (tx) => {
    // 1) 先看上限：count 与 insert 在同一事务内，配合固定 advisory lock 串行化。
    //    上限恒 ≤ MAX_USER_ACCOUNTS（生产 10），环境变量只能调小（仅测试用）。
    const maxUsers = readMaxUserAccounts();
    const total = await tx.user.count();
    if (total >= maxUsers) {
      throw new AuthError('USER_LIMIT_REACHED', `上限 ${maxUsers} 个账号`);
    }

    // 2) 再看邮箱冲突（邮箱已规范化，唯一索引之外再给出稳定错误码）。
    const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (existing !== null) {
      throw new AuthError('EMAIL_TAKEN');
    }

    const created = await tx.user.create({
      data: {
        email,
        passwordHash,
        role: 'author',
        status: 'active',
        mustChangePassword: true,
      },
    });

    await writeAuditLog(tx, {
      action: AUDIT_ACTIONS.ADMIN_USER_CREATED,
      actorId: input.actorId,
      targetType: 'user',
      targetId: created.id,
      // 只记录非敏感信息。
      detail: { email, role: 'author', status: 'active', mustChangePassword: true },
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });

    return created;
  });

  // 管理员自己输入的口令不回显；只有服务器生成的口令才一次性返回。
  return {
    user: toAdminUserView(user),
    initialPassword: providedPassword === undefined ? initialPassword : null,
  };
}

/** 停用/启用所需的状态联合类型（供路由层校验）。 */
export type UserStatusInput = 'active' | 'disabled';

/** 判断请求体里的 status 是否合法。 */
export function isUserStatus(value: unknown): value is UserStatusInput {
  return value === 'active' || value === 'disabled';
}

/** 对外暴露 PublicUser 的转换（路由层复用）。 */
export { toPublicUser };
export type { PublicUser };
