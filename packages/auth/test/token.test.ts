import { describe, expect, it } from 'vitest';

import { generateSessionToken, hashSessionToken } from '../src/token.js';

describe('会话令牌', () => {
  it('生成 256 位随机令牌（base64url，43 字符）', () => {
    const token = generateSessionToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('每次生成的令牌都不同', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()));

    expect(tokens.size).toBe(200);
  });

  it('哈希是稳定的 SHA-256（64 位十六进制）且不等于原文', () => {
    const token = generateSessionToken();
    const hashed = hashSessionToken(token);

    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toBe(token);
    expect(hashSessionToken(token)).toBe(hashed);
    expect(hashSessionToken(`${token}x`)).not.toBe(hashed);
  });
});
