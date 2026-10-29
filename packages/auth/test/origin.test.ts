import { describe, expect, it } from 'vitest';

import type { AuthConfig } from '../src/config.js';
import { AuthError } from '../src/errors.js';
import { assertTrustedOrigin, readClientIp } from '../src/origin.js';
import { testConfig } from './helpers/db.js';

/** 构造一个 POST 请求。 */
function postRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: 'POST', headers });
}

describe('Origin 校验（CSRF 防护）', () => {
  const config: AuthConfig = testConfig();

  it('安全方法（GET）不校验 Origin', () => {
    expect(() =>
      assertTrustedOrigin(new Request('http://localhost:3000/api/auth/me'), config),
    ).not.toThrow();
  });

  it('POST 缺少 Origin 时拒绝', () => {
    expect(() =>
      assertTrustedOrigin(postRequest('http://localhost:3000/api/auth/login'), config),
    ).toThrowError(AuthError);
  });

  it('POST Origin 与站点不一致时拒绝', () => {
    const request = postRequest('http://localhost:3000/api/auth/login', {
      origin: 'https://evil.example.com',
    });

    expect(() => assertTrustedOrigin(request, config)).toThrowError(/来源不受信任/);
  });

  it('POST Origin 为字符串 null 时拒绝', () => {
    const request = postRequest('http://localhost:3000/api/auth/login', { origin: 'null' });

    expect(() => assertTrustedOrigin(request, config)).toThrowError(AuthError);
  });

  it('POST Origin 与请求同源时通过', () => {
    const request = postRequest('http://localhost:3000/api/auth/login', {
      origin: 'http://localhost:3000',
    });

    expect(() => assertTrustedOrigin(request, config)).not.toThrow();
  });

  it('配置了 APP_ORIGIN 时以配置为准', () => {
    const strict = testConfig({ appOrigin: 'https://novel.example.com' });

    expect(() =>
      assertTrustedOrigin(
        postRequest('https://novel.example.com/api/auth/login', {
          origin: 'https://novel.example.com',
        }),
        strict,
      ),
    ).not.toThrow();

    expect(() =>
      assertTrustedOrigin(
        postRequest('https://novel.example.com/api/auth/login', {
          origin: 'https://other.example.com',
        }),
        strict,
      ),
    ).toThrowError(AuthError);
  });

  it('readClientIp 只信任 X-Real-IP（不采信可伪造的 X-Forwarded-For）', () => {
    const request = new Request('http://localhost:3000/', {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'x-real-ip': '10.0.0.9' },
    });

    expect(readClientIp(request)).toBe('10.0.0.9');
    expect(readClientIp(new Request('http://localhost:3000/'))).toBeNull();
  });
});
