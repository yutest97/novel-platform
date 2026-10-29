/**
 * 会话令牌的生成与哈希。
 *
 * 约束：
 * - 令牌必须是密码学安全随机数（32 字节 ≈ 256 位熵）。
 * - 数据库只保存令牌的 SHA-256 哈希，**绝不保存令牌本身**。
 *   （令牌本身是高熵随机串，不需要 argon2 这类慢哈希，
 *   一次 SHA-256 即可，且避免每次请求都付出哈希开销。）
 */

import { createHash, randomBytes } from 'node:crypto';

/** 生成会话令牌（base64url，43 个字符）。 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 计算令牌的 SHA-256 哈希（数据库存储形式）。 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
