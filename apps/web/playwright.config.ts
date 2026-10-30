import { defineConfig, devices } from '@playwright/test';

/**
 * 浏览器 E2E 配置。
 *
 * - 默认打到 Caddy 的 HTTPS 入口（https://localhost:8443），
 *   `ignoreHTTPSErrors` 仅用于忽略本地 Caddy internal 自签 CA；
 * - 本地调试可用 BASE_URL=http://127.0.0.1:3000 直连 next；
 * - workers=1：用例之间共享同一份数据库状态（管理员 → 作者 → 上限），必须串行。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env['CI']),
  reporter: [['list']],
  use: {
    baseURL: process.env['BASE_URL'] ?? 'https://localhost:8443',
    ignoreHTTPSErrors: true,
    // 用例会输入口令并展示一次性口令：不保留任何自动失败产物（trace/截图/视频），
    // 避免明文口令落进 test-results。页面截图一律由用例手动作业并做模糊处理。
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    locale: 'zh-CN',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
