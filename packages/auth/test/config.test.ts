/**
 * 配置与 Cookie 策略（REV-01 第 5、6 条）。
 *
 * - 生产默认 Secure=true；本地开发 override 显式关闭。
 * - `.env.example` 的初始密码为空；占位值被显式拒绝。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readAuthConfig } from '../src/config.js';
import { buildClearedSessionCookie, buildSessionCookie } from '../src/cookie.js';
import { AuthError } from '../src/errors.js';
import { assertAcceptableInitialPassword } from '../src/users.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Cookie 安全配置', () => {
  it('生产默认 Secure=true，且 Cookie 属性齐全', () => {
    const config = readAuthConfig({});
    expect(config.cookieSecure).toBe(true);

    const cookie = buildSessionCookie('token-value', config);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toMatch(/Max-Age=\d+/);
    // 默认 12 小时
    expect(cookie).toContain('Max-Age=43200');
  });

  it('显式 AUTH_COOKIE_SECURE=false 时不带 Secure（仅用于本地 http）', () => {
    const config = readAuthConfig({ AUTH_COOKIE_SECURE: 'false' });

    expect(config.cookieSecure).toBe(false);
    const cookie = buildSessionCookie('token-value', config);
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('清除 Cookie 使用 Max-Age=0 且带相同属性', () => {
    const cookie = buildClearedSessionCookie(readAuthConfig({}));

    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('docker-compose.dev.yml 显式关闭 Secure，默认 compose 未关闭', () => {
    const devCompose = readFileSync(resolve(repoRoot, 'infra/docker-compose.dev.yml'), 'utf8');
    const mainCompose = readFileSync(resolve(repoRoot, 'infra/docker-compose.yml'), 'utf8');

    expect(devCompose).toContain("AUTH_COOKIE_SECURE: 'false'");
    // 默认配置必须是 true（或至少不是 false）
    expect(mainCompose).toContain('${AUTH_COOKIE_SECURE:-true}');
    expect(mainCompose).not.toContain('AUTH_COOKIE_SECURE: false');
  });
});

describe('初始密码占位符', () => {
  it('.env.example 中的 ADMIN_INITIAL_PASSWORD 为空值', () => {
    const example = readFileSync(resolve(repoRoot, '.env.example'), 'utf8');
    const line = example.split('\n').find((item) => item.startsWith('ADMIN_INITIAL_PASSWORD='));

    expect(line).toBe('ADMIN_INITIAL_PASSWORD=');
  });

  it('空值被拒绝', () => {
    expect(() => assertAcceptableInitialPassword('')).toThrowError(/必须设置管理员初始密码/);
    expect(() => assertAcceptableInitialPassword('   ')).toThrowError(/必须设置管理员初始密码/);
  });

  it('已知示例/占位值被拒绝', () => {
    for (const password of [
      'change-me-in-local-env-only',
      'change-me-local-only',
      'changeme',
      'placeholder-not-a-real-key',
      'your-password-here',
    ]) {
      expect(() => assertAcceptableInitialPassword(password)).toThrowError(/占位值/);
    }
  });

  it('过短的密码被拒绝，合规密码通过', () => {
    expect(() => assertAcceptableInitialPassword('short')).toThrowError(/至少 12 个字符/);
    expect(() =>
      assertAcceptableInitialPassword('a-perfectly-fine-initial-password'),
    ).not.toThrow();
  });
});

describe('IP 头信任策略', () => {
  it('伪造的 X-Forwarded-For 不被采信（readClientIp 只认 X-Real-IP）', async () => {
    const { readClientIp } = await import('../src/origin.js');

    const spoofed = new Request('http://localhost:3000/', {
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '203.0.113.99' },
    });
    expect(readClientIp(spoofed)).toBe('203.0.113.99');

    const onlyXff = new Request('http://localhost:3000/', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    });
    expect(readClientIp(onlyXff)).toBeNull();

    const multiValuedRealIp = new Request('http://localhost:3000/', {
      headers: { 'x-real-ip': '1.2.3.4, 5.6.7.8' },
    });
    expect(readClientIp(multiValuedRealIp)).toBeNull();

    const garbage = new Request('http://localhost:3000/', {
      headers: { 'x-real-ip': 'not-an-ip; DROP TABLE users' },
    });
    expect(readClientIp(garbage)).toBeNull();
  });

  it('缺少 X-Real-IP 时返回 null（退化到共享的 unknown 桶）', async () => {
    const { readClientIp } = await import('../src/origin.js');
    expect(readClientIp(new Request('http://localhost:3000/'))).toBeNull();
  });

  it('Caddyfile 覆盖 X-Real-IP 与 X-Forwarded-For', () => {
    const caddyfile = readFileSync(resolve(repoRoot, 'infra/docker/caddy/Caddyfile'), 'utf8');

    expect(caddyfile).toContain('header_up X-Real-IP {remote_host}');
    expect(caddyfile).toContain('header_up X-Forwarded-For {remote_host}');
  });

  it('Caddyfile 的 HTTPS 站点使用明确主机名，且保留 :80 健康检查入口', () => {
    const caddyfile = readFileSync(resolve(repoRoot, 'infra/docker/caddy/Caddyfile'), 'utf8');

    // 裸 `:443` 没有站点名 → 无证书可签发 → 握手报 tlsv1 alert internal error。
    expect(caddyfile).toContain('https://localhost:443 {');
    expect(caddyfile).not.toMatch(/^:443\s*\{/m);
    expect(caddyfile).toContain('tls internal');
    // HTTP 入口保留（四个健康检查端点走 8080）
    expect(caddyfile).toMatch(/^:80\s*\{/m);
  });

  it('Caddyfile 使用 auto_https disable_redirects（auto_https off 会连证书签发一起关闭）', () => {
    const caddyfile = readFileSync(resolve(repoRoot, 'infra/docker/caddy/Caddyfile'), 'utf8');
    // 只看生效配置行：注释里会说明为什么不能用 auto_https off。
    const active = caddyfile
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    expect(active).toContain('auto_https disable_redirects');
    // `auto_https off` 会让 tls internal 也不签发叶子证书，握手仍报 internal error
    expect(active).not.toMatch(/auto_https\s+off\b/);
  });
});

describe('AuthError 越权语义', () => {
  it('FORBIDDEN 为 403 且文案不泄露账号是否存在', async () => {
    const { AuthError: AuthErrorClass } = await import('../src/errors.js');
    const error = new AuthErrorClass('FORBIDDEN');

    expect(error.status).toBe(403);
    expect(error).toBeInstanceOf(AuthError);
    expect(error.toBody().error.message).toBe('没有权限执行该操作');
  });
});
