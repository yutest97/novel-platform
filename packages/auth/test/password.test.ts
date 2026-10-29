import { describe, expect, it } from 'vitest';

import { assertPasswordPolicy, hashPassword, verifyPassword } from '../src/password.js';

describe('密码哈希（argon2id）', () => {
  it('哈希串使用 argon2id 且不包含明文', async () => {
    const password = 'correct-horse-battery-staple';
    const hashed = await hashPassword(password);

    expect(hashed.startsWith('$argon2id$')).toBe(true);
    expect(hashed).toContain('m=19456,t=2,p=1');
    expect(hashed).not.toContain(password);
  });

  it('正确密码校验通过，错误密码校验失败', async () => {
    const hashed = await hashPassword('s3cret-password-value');

    await expect(verifyPassword(hashed, 's3cret-password-value')).resolves.toBe(true);
    await expect(verifyPassword(hashed, 's3cret-password-valuE')).resolves.toBe(false);
    await expect(verifyPassword(hashed, '')).resolves.toBe(false);
  });

  it('同一密码两次哈希结果不同（盐随机）', async () => {
    const first = await hashPassword('same-password-1234');
    const second = await hashPassword('same-password-1234');

    expect(first).not.toBe(second);
    await expect(verifyPassword(first, 'same-password-1234')).resolves.toBe(true);
    await expect(verifyPassword(second, 'same-password-1234')).resolves.toBe(true);
  });

  it('损坏的哈希串返回 false 而不是抛错', async () => {
    await expect(verifyPassword('not-a-hash', 'whatever-password')).resolves.toBe(false);
  });

  it('密码策略：过短、纯空白、与当前密码相同都会被拒绝', () => {
    expect(() => assertPasswordPolicy('short')).toThrowError(/至少 12 个字符/);
    expect(() => assertPasswordPolicy('            ')).toThrowError(/空白/);
    expect(() => assertPasswordPolicy('same-password-1234', 'same-password-1234')).toThrowError(
      /不能与当前密码相同/,
    );
    expect(() => assertPasswordPolicy('a-perfectly-fine-password')).not.toThrow();
  });

  it('超过最大长度的密码被拒绝', () => {
    expect(() => assertPasswordPolicy('x'.repeat(201))).toThrowError(/不得超过/);
  });
});
