/**
 * 密码哈希（argon2id）。
 *
 * 约束：
 * - 只使用 argon2id，不使用可逆加密，也不保存明文。
 * - 参数采用 OWASP 推荐的下限组合：m=19456 KiB（19 MiB）、t=2、p=1。
 * - 校验失败与账号不存在必须耗时相近，因此提供 `verifyAbsentUserPassword`
 *   用于"账号不存在"分支的等时处理。
 */

import { hash, verify } from '@node-rs/argon2';

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './config.js';
import { AuthError } from './errors.js';

/**
 * argon2 算法与版本取值。
 *
 * `@node-rs/argon2` 把 `Algorithm` / `Version` 声明为 ambient const enum，
 * 在 `verbatimModuleSyntax` 下无法按值访问，因此这里使用其文档化常量：
 *   Algorithm.Argon2id = 2、Version.V0x13 = 1。
 * 生成的哈希串形如 `$argon2id$v=19$m=19456,t=2,p=1$...`，可自证算法正确。
 */
const ARGON2ID = 2;
const ARGON2_VERSION_0X13 = 1;

/** argon2id 参数（写入哈希串中，校验时自动读取）。 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  version: ARGON2_VERSION_0X13,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/** 计算一个"占位哈希"，用于账号不存在时的等时校验。 */
let dummyHashPromise: Promise<string> | undefined;

/** 生成密码哈希（argon2id）。 */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return hash(password, ARGON2_OPTIONS);
}

/**
 * 校验密码是否与哈希匹配。
 *
 * 哈希串损坏或算法不匹配时返回 false，不抛错（避免把内部细节暴露给调用方）。
 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password, { algorithm: ARGON2ID });
  } catch {
    return false;
  }
}

/**
 * 账号不存在时的等时校验。
 *
 * 对不存在的账号也执行一次完整的 argon2id 校验，避免通过响应时间
 * 判断邮箱是否已注册。返回值恒为 false。
 */
export async function verifyAbsentUserPassword(password: string): Promise<false> {
  dummyHashPromise ??= hash('placeholder-password-for-timing-equalisation', ARGON2_OPTIONS);
  const placeholder = await dummyHashPromise;
  await verifyPassword(placeholder, password);
  return false;
}

/**
 * 密码强度策略。
 *
 * - 长度 12–200；
 * - 不能与当前密码相同（改密场景传入 currentPassword）；
 * - 允许任意字符（含中文与空格），不做复杂度字符集强制，
 *   以长度为主要强度来源（NIST SP 800-63B 取向）。
 */
export function assertPasswordPolicy(password: string, currentPassword?: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError('VALIDATION_FAILED', `密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError('VALIDATION_FAILED', `密码不得超过 ${MAX_PASSWORD_LENGTH} 个字符`);
  }
  if (password.trim().length === 0) {
    throw new AuthError('VALIDATION_FAILED', '密码不得全为空白字符');
  }
  if (currentPassword !== undefined && password === currentPassword) {
    throw new AuthError('VALIDATION_FAILED', '新密码不能与当前密码相同');
  }
}
