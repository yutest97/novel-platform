import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * E2E 共享凭据（M2-A）。
 *
 * 管理员的初始口令只能用一次（首次登录必须改密），而 Playwright 的各个
 * spec 文件彼此独立、无法共享内存状态。因此改密后的口令写到这个文件，
 * 供后续 spec 文件读取登录。
 *
 * 该文件**不入仓库**（.gitignore）也**不进镜像上下文**（.dockerignore），
 * 并且在 CI 结束后由清理步骤删除。
 */

const credentialFile = resolve(process.cwd(), '.e2e-admin-password');
const authorCredentialFile = resolve(process.cwd(), '.e2e-author.json');

/** 管理员邮箱（来自运行环境）。 */
export const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] ?? '';

/** 写接口的 Origin。 */
export const ORIGIN = process.env['BASE_URL'] ?? 'https://localhost:8443';

/** 保存管理员改密后的口令。 */
export function writeAdminPassword(password: string): void {
  writeFileSync(credentialFile, password, { encoding: 'utf8' });
}

/**
 * 读取管理员改密后的口令。
 *
 * 若文件不存在（例如单独运行某个 spec 文件），抛错提示先跑
 * admin-flow.spec.ts 完成首次改密。
 */
export function readAdminPassword(): string {
  try {
    const value = readFileSync(credentialFile, 'utf8').trim();
    if (value === '') {
      throw new Error('空的');
    }
    return value;
  } catch {
    throw new Error(
      '未找到管理员改密后的口令：请先运行 admin-flow.spec.ts（它会完成首次改密并写入共享凭据文件）。',
    );
  }
}

/** 可复用的既有作者账号（由 admin-flow 创建并完成改密）。 */
export interface E2EAuthorCredentials {
  readonly email: string;
  readonly password: string;
}

/** admin-flow 在结束时写入，供后续章节工作台等 spec 复用（不新建账号）。 */
export function writeAuthorCredentials(email: string, password: string): void {
  writeFileSync(authorCredentialFile, JSON.stringify({ email, password }), { encoding: 'utf8' });
}

/** 读取既有 e2e-author；缺失时给出明确的运行顺序提示。 */
export function readAuthorCredentials(): E2EAuthorCredentials {
  try {
    const raw = readFileSync(authorCredentialFile, 'utf8');
    const parsed = JSON.parse(raw) as { email?: unknown; password?: unknown };
    if (typeof parsed.email !== 'string' || typeof parsed.password !== 'string') {
      throw new Error('字段不完整');
    }
    return { email: parsed.email, password: parsed.password };
  } catch {
    throw new Error(
      '未找到可复用的 e2e-author 凭据：请先运行 admin-flow.spec.ts（它会创建作者并写入共享凭据文件）。',
    );
  }
}
