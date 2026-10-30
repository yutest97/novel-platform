import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { recordSecret, resetSecretLedger } from './secret-ledger';

/**
 * M1-B3 浏览器 E2E：账号系统全流程。
 *
 * 运行前提（由 CI 或本地脚本准备）：
 * - 应用已启动（默认 https://localhost:8443，经 Caddy）；
 * - 数据库是**一次性**的，且只有一个管理员（must_change_password=true）；
 * - 环境变量 ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD 提供该管理员的一次性口令。
 *
 * 约束：
 * - 新口令在运行时**随机生成**，不写进仓库；
 * - 用例按顺序共享同一份数据库状态，必须串行执行（workers=1）。
 */

// Playwright 以 apps/web 为工作目录运行（package.json 未声明 type: module）
const repoRoot = resolve(process.cwd(), '../..');
const screenshotDir = resolve(repoRoot, 'docs/screenshots');
const shot = (name: string): string => resolve(screenshotDir, `m1b3-${name}.png`);

const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] ?? '';
const ADMIN_INITIAL_PASSWORD = process.env['ADMIN_INITIAL_PASSWORD'] ?? '';

// 运行时随机生成，保证不落仓库；低于 12 位会被服务端拒绝
const ADMIN_NEW_PASSWORD = process.env['E2E_ADMIN_NEW_PASSWORD'] ?? `E2e-Admin-${randomUUID()}`;
const AUTHOR_PASSWORD = `E2e-Author-${randomUUID()}`;
const AUTHOR_PASSWORD_2 = `E2e-Author2-${randomUUID()}`;

const AUTHOR_EMAIL = `e2e-author-${Date.now().toString(36)}@example.test`;
// 写接口要求 Origin；Playwright 的 page.request 默认不带，需要显式补上与站点一致的来源
const ORIGIN = process.env['BASE_URL'] ?? 'https://localhost:8443';

let authorInitialPassword = '';
let authorResetPassword = '';
let adminContext: BrowserContext;
let adminPage: Page;

test.describe.configure({ mode: 'serial' });

/** 以给定账号登录（成功后由页面守卫决定落地页）。 */
async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

/** 当前焦点是否在 role=dialog 内。 */
async function focusInsideDialog(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);
}

test.beforeAll(async ({ browser }) => {
  if (ADMIN_EMAIL === '' || ADMIN_INITIAL_PASSWORD === '') {
    throw new Error('E2E 需要 ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD（一次性管理员凭据）');
  }
  mkdirSync(screenshotDir, { recursive: true });
  // 清掉上一次运行遗留的口令清单
  resetSecretLedger();
  recordSecret(ADMIN_INITIAL_PASSWORD);
  recordSecret(ADMIN_NEW_PASSWORD);
  recordSecret(AUTHOR_PASSWORD);
  recordSecret(AUTHOR_PASSWORD_2);

  adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  adminPage = await adminContext.newPage();
});

test.afterAll(async () => {
  await adminContext?.close();
});

test('1. 未登录访问 /admin/users 跳转到 /login', async ({ page }) => {
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
  await page.screenshot({ path: shot('login'), fullPage: true });
});

test('2. 管理员首次登录进入强制改密页', async () => {
  await adminPage.goto('/login');
  await adminPage.getByLabel('邮箱').fill(ADMIN_EMAIL);
  await adminPage.getByLabel('密码').fill(ADMIN_INITIAL_PASSWORD);
  await adminPage.getByRole('button', { name: '登录' }).click();

  await expect(adminPage).toHaveURL(/\/change-password/);
  await expect(adminPage.getByRole('heading', { name: '修改密码' })).toBeVisible();
  await adminPage.screenshot({ path: shot('change-password'), fullPage: true });
});

test('3. 改密成功后管理员进入 /admin/users', async () => {
  await adminPage.getByLabel('当前密码').fill(ADMIN_INITIAL_PASSWORD);
  await adminPage.getByLabel('新密码', { exact: true }).fill(ADMIN_NEW_PASSWORD);
  await adminPage.getByLabel('确认新密码').fill(ADMIN_NEW_PASSWORD);
  await adminPage.getByRole('button', { name: '提交' }).click();

  await expect(adminPage).toHaveURL(/\/admin\/users/);
  await expect(adminPage.getByRole('heading', { name: '账号管理' })).toBeVisible();
  await expect(adminPage.getByTestId('users-table')).toBeVisible();
});

test('4. 新建作者：一次性密码弹窗出现且可复制', async () => {
  await adminPage.getByTestId('create-email').fill(AUTHOR_EMAIL);
  await adminPage.getByTestId('create-submit').click();

  const dialog = adminPage.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '作者账号已创建' })).toBeVisible();

  const secret = dialog.getByTestId('one-time-secret');
  authorInitialPassword = (await secret.innerText()).trim();
  // 服务器生成的一次性口令也记入口令清单（失败快照里可能出现）
  recordSecret(authorInitialPassword);
  expect(authorInitialPassword.length).toBeGreaterThanOrEqual(20);

  // 截图前把口令区域模糊处理：仓库里不允许出现任何真实可用的测试口令
  await adminPage.addStyleTag({
    content: '[data-testid="one-time-secret"]{filter:blur(7px);user-select:none}',
  });
  await adminPage.screenshot({ path: shot('one-time-password'), fullPage: true });

  await adminPage.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await dialog.getByRole('button', { name: '复制' }).click();
  await expect(adminPage.getByText('已复制到剪贴板')).toBeVisible();

  // 弹窗没有关闭按钮，只能通过「我已保存」关闭
  await expect(dialog.getByRole('button', { name: /关闭/ })).toHaveCount(0);
});

test('5. 关闭弹窗并刷新后，一次性密码不可再查看', async () => {
  await adminPage.getByRole('button', { name: '我已保存' }).click();
  await expect(adminPage.getByRole('dialog')).toHaveCount(0);

  await adminPage.reload();
  await expect(adminPage.getByTestId('users-table')).toBeVisible();
  await expect(adminPage.getByRole('dialog')).toHaveCount(0);

  const body = await adminPage.content();
  expect(body).not.toContain(authorInitialPassword);

  // 服务端也不再返回该口令
  const response = await adminPage.request.get('/api/admin/users');
  expect(response.ok()).toBe(true);
  expect(await response.text()).not.toContain(authorInitialPassword);

  await adminPage.screenshot({ path: shot('admin-users'), fullPage: true });
});

test('6-7. 作者用初始密码登录并完成首登改密', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await page.goto('/login');
  await page.getByLabel('邮箱').fill(AUTHOR_EMAIL);
  await page.getByLabel('密码').fill(authorInitialPassword);
  await page.getByRole('button', { name: '登录' }).click();

  await expect(page).toHaveURL(/\/change-password/);
  await page.getByLabel('当前密码').fill(authorInitialPassword);
  await page.getByLabel('新密码', { exact: true }).fill(AUTHOR_PASSWORD);
  await page.getByLabel('确认新密码').fill(AUTHOR_PASSWORD);
  await page.getByRole('button', { name: '提交' }).click();

  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('workspace-email')).toHaveText(AUTHOR_EMAIL);
  await expect(page.getByTestId('workspace-role')).toHaveText('作者');
  await page.screenshot({ path: shot('workspace'), fullPage: true });

  // 8. 作者访问管理页被拒绝（跳回工作台）
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/workspace/);

  // 13. 作者没有创建入口，且服务端仍拒绝
  await expect(page.getByRole('button', { name: '创建作者' })).toHaveCount(0);
  const forbidden = await page.request.post('/api/admin/users', {
    headers: { origin: ORIGIN },
    data: { email: `attacker-${Date.now().toString(36)}@example.test` },
  });
  expect(forbidden.status()).toBe(403);
  const forbiddenBody = (await forbidden.json()) as { error: { code: string } };
  expect(forbiddenBody.error.code).toBe('FORBIDDEN');

  await context.close();
});

test('9. 管理员重置作者密码：旧会话立即失效', async ({ browser }) => {
  // 作者在另一个浏览器上下文里保持登录
  const authorContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const authorPage = await authorContext.newPage();
  await authorPage.goto('/login');
  await authorPage.getByLabel('邮箱').fill(AUTHOR_EMAIL);
  await authorPage.getByLabel('密码').fill(AUTHOR_PASSWORD);
  await authorPage.getByRole('button', { name: '登录' }).click();
  // 等 SPA 完成跳转（此时 mustChangePassword 已为 false，直接进工作台）
  await expect(authorPage).toHaveURL(/\/workspace/);

  // 管理员重置
  const row = adminPage.getByTestId('user-row').filter({ hasText: AUTHOR_EMAIL });
  await row.getByRole('button', { name: '重置密码' }).click();

  const dialog = adminPage.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/旧会话已全部失效/)).toBeVisible();
  authorResetPassword = (await dialog.getByTestId('one-time-secret').innerText()).trim();
  recordSecret(authorResetPassword);
  expect(authorResetPassword.length).toBeGreaterThanOrEqual(20);
  await dialog.getByRole('button', { name: '我已保存' }).click();

  // 作者旧页面刷新后回到登录页
  await authorPage.reload();
  await expect(authorPage).toHaveURL(/\/login/);

  await authorContext.close();
});

test('10. 管理员停用作者：作者登录显示账号停用', async ({ page }) => {
  const row = adminPage.getByTestId('user-row').filter({ hasText: AUTHOR_EMAIL });
  await row.getByRole('button', { name: '停用' }).click();

  const confirm = adminPage.getByRole('dialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '确认停用' }).click();
  await expect(adminPage.getByText('账号已停用，其所有会话已失效。')).toBeVisible();

  await page.goto('/login');
  await page.getByLabel('邮箱').fill(AUTHOR_EMAIL);
  await page.getByLabel('密码').fill(authorResetPassword);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByTestId('login-error')).toHaveText('账号已停用，请联系管理员');
  await expect(page).toHaveURL(/\/login/);
});

test('11. 管理员启用作者后可重新登录', async ({ page }) => {
  const row = adminPage.getByTestId('user-row').filter({ hasText: AUTHOR_EMAIL });
  await row.getByRole('button', { name: '启用' }).click();
  await expect(adminPage.getByText('账号已启用。')).toBeVisible();

  await page.goto('/login');
  await page.getByLabel('邮箱').fill(AUTHOR_EMAIL);
  await page.getByLabel('密码').fill(authorResetPassword);
  await page.getByRole('button', { name: '登录' }).click();
  // 重置后必须改密
  await expect(page).toHaveURL(/\/change-password/);

  await page.getByLabel('当前密码').fill(authorResetPassword);
  await page.getByLabel('新密码', { exact: true }).fill(AUTHOR_PASSWORD_2);
  await page.getByLabel('确认新密码').fill(AUTHOR_PASSWORD_2);
  await page.getByRole('button', { name: '提交' }).click();
  await expect(page).toHaveURL(/\/workspace/);
});

test('12. 退出登录后刷新仍保持未登录', async ({ page }) => {
  await adminPage.getByTestId('logout').click();
  await expect(adminPage).toHaveURL(/\/login/);

  await adminPage.reload();
  await expect(adminPage).toHaveURL(/\/login/);

  // 独立浏览器上下文也确认未登录访问会被重定向
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/login/);
});

test('13. 弹窗键盘行为：背景 inert、Tab 循环、Esc 不关闭、焦点回归', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await loginAs(page, ADMIN_EMAIL, ADMIN_NEW_PASSWORD);
  await page.goto('/admin/users');
  await expect(page.getByTestId('users-table')).toBeVisible();

  // --- ConfirmDialog：取消按钮保留、焦点回归 ---
  const row = page.getByTestId('user-row').filter({ hasText: AUTHOR_EMAIL });
  const disableTrigger = row.getByRole('button', { name: '停用' });
  await disableTrigger.click();

  const confirmDialog = page.getByRole('dialog');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog.getByRole('button', { name: '取消' })).toBeVisible();
  // 背景被设为 inert（模态隔离）
  await expect(page.locator('#app-root')).toHaveAttribute('inert', '');

  // Tab / Shift+Tab 始终留在弹窗内
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press('Tab');
  }
  expect(await focusInsideDialog(page)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await focusInsideDialog(page)).toBe(true);

  await confirmDialog.getByRole('button', { name: '取消' }).click();
  await expect(confirmDialog).toHaveCount(0);
  // 关闭后焦点回到触发按钮
  await expect(disableTrigger).toBeFocused();
  // inert 已解除
  await expect(page.locator('#app-root')).not.toHaveAttribute('inert', '');

  // --- OneTimeSecret：Esc 不关闭、焦点在「我已保存」 ---
  // 用"新建作者"触发的弹窗（避免重置已有账号的密码影响后续用例）
  await page.getByTestId('create-email').fill(`e2e-kbd-${Date.now().toString(36)}@example.test`);
  await page.getByTestId('create-submit').click();
  const secretDialog = page.getByRole('dialog');
  await expect(secretDialog).toBeVisible();
  await expect(secretDialog.getByRole('button', { name: '我已保存' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(secretDialog).toBeVisible();
  // 点击遮罩也不关闭
  await page.mouse.click(5, 5);
  await expect(secretDialog).toBeVisible();

  await secretDialog.getByRole('button', { name: '我已保存' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await context.close();
});

test('14. 会话临近到期：自动退出到登录页', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await loginAs(page, ADMIN_EMAIL, ADMIN_NEW_PASSWORD);

  // 测试注入：让 /api/auth/me 返回"3 秒后到期"的会话（不修改任何生产阈值）
  await context.route('**/api/auth/me', async (route) => {
    const response = await route.fetch();
    if (response.status() !== 200) {
      await route.fulfill({ response });
      return;
    }
    const json = (await response.json()) as {
      session: { absoluteExpiresAt: string; idleExpiresAt: string };
    };
    const soon = new Date(Date.now() + 3000).toISOString();
    json.session = { absoluteExpiresAt: soon, idleExpiresAt: soon };
    await route.fulfill({ response, json });
  });

  await page.goto('/workspace');
  await expect(page.getByTestId('workspace-email')).toBeVisible();

  // 到期后应自动跳转登录页，并带上 expired 提示
  await expect(page).toHaveURL(/\/login\?reason=expired/, { timeout: 20_000 });
  await expect(page.getByTestId('login-error')).toHaveText('会话已过期，请重新登录');

  await context.close();
});

test('15. 管理员页清除 Cookie 后执行操作：跳回登录页', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await loginAs(page, ADMIN_EMAIL, ADMIN_NEW_PASSWORD);
  await page.goto('/admin/users');
  await expect(page.getByTestId('users-table')).toBeVisible();

  // 等列表加载与随后的会话续期请求都结束，避免清除 Cookie 时还有请求在途
  await page.waitForLoadState('networkidle');

  // 让 Cookie 失效，然后点一个管理操作
  await context.clearCookies();
  const row = page.getByTestId('user-row').filter({ hasText: AUTHOR_EMAIL });
  await row.getByRole('button', { name: '重置密码' }).click();

  await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });
  await context.close();
});

test('16. 作者工作台清除 Cookie 后重新获得焦点：跳回登录页', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await loginAs(page, AUTHOR_EMAIL, AUTHOR_PASSWORD_2);
  await page.goto('/workspace');
  await expect(page.getByTestId('workspace-email')).toHaveText(AUTHOR_EMAIL);

  await context.clearCookies();
  // 模拟页面重新获得焦点（真实浏览器里由标签页切回触发）
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });

  await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });
  await context.close();
});

test('17. 手机宽度 390×844：登录、表格滚动、弹窗可操作', async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();

  await page.goto('/login');
  await page.getByLabel('邮箱').fill(ADMIN_EMAIL);
  await page.getByLabel('密码').fill(ADMIN_NEW_PASSWORD);
  await page.screenshot({ path: shot('mobile-login'), fullPage: false });

  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/admin\/users/);
  await expect(page.getByTestId('users-table')).toBeVisible();

  // 表格在 .table-wrap 内横向滚动，body 不被撑破
  const metrics = await page.evaluate(() => {
    const wrap = document.querySelector('.table-wrap');
    return {
      wrapScrollWidth: wrap instanceof HTMLElement ? wrap.scrollWidth : 0,
      wrapClientWidth: wrap instanceof HTMLElement ? wrap.clientWidth : 0,
      docScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(metrics.wrapScrollWidth).toBeGreaterThan(metrics.wrapClientWidth);
  expect(metrics.docScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);

  await page.screenshot({ path: shot('mobile-admin'), fullPage: false });

  // 触控目标：主按钮高度足够
  const submitBox = await page.getByTestId('create-submit').boundingBox();
  expect(submitBox?.height ?? 0).toBeGreaterThanOrEqual(40);

  // 新建作者 → 弹窗完整显示、按钮可点
  await page.getByTestId('create-email').fill(`e2e-mobile-${Date.now().toString(36)}@example.test`);
  await page.getByTestId('create-submit').click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(391);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(845);

  const copyBox = await dialog.getByRole('button', { name: '复制' }).boundingBox();
  expect(copyBox?.height ?? 0).toBeGreaterThanOrEqual(36);
  const confirmBox = await dialog.getByRole('button', { name: '我已保存' }).boundingBox();
  expect(confirmBox?.height ?? 0).toBeGreaterThanOrEqual(36);

  // 截图前模糊口令区域
  await page.addStyleTag({
    content: '[data-testid="one-time-secret"]{filter:blur(7px);user-select:none}',
  });
  await page.screenshot({ path: shot('mobile-one-time-password'), fullPage: false });

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await dialog.getByRole('button', { name: '复制' }).click();
  await expect(page.getByText('已复制到剪贴板')).toBeVisible();
  await dialog.getByRole('button', { name: '我已保存' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await context.close();
});

test('18. 活跃会话续期：管理操作成功后重置到期计时器', async ({ browser }) => {
  // 本用例要跨越两个到期时间点，单独放宽超时
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await loginAs(page, ADMIN_EMAIL, ADMIN_NEW_PASSWORD);

  let meCalls = 0;
  // 续期后的到期时间必须**固定**：否则页面上任何一次额外的 /me 调用
  // （例如窗口重新获得焦点）都会把到期时间往后推，用例将永远等不到到期。
  let renewedDeadline: number | null = null;

  await context.route('**/api/auth/me', async (route) => {
    const response = await route.fetch();
    if (response.status() !== 200) {
      await route.fulfill({ response });
      return;
    }
    const json = (await response.json()) as {
      session: { absoluteExpiresAt: string; idleExpiresAt: string };
    };
    meCalls += 1;

    let at: string;
    if (meCalls >= 3) {
      // 第三次起 = 已经执行过一次成功的管理操作，返回**较长**的到期时间
      renewedDeadline ??= Date.now() + 12_000;
      at = new Date(renewedDeadline).toISOString();
    } else {
      // 首次与列表加载后的刷新：4 秒后到期（较短）
      at = new Date(Date.now() + 4_000).toISOString();
    }
    json.session = { absoluteExpiresAt: at, idleExpiresAt: at };
    await route.fulfill({ response, json });
  });

  await page.goto('/admin/users');
  await expect(page.getByTestId('users-table')).toBeVisible();

  // 在第一次到期之前执行一次成功的管理操作（显式初始密码 → 无一次性口令弹窗）
  const explicitPassword = `E2e-Renew-${randomUUID()}`;
  recordSecret(explicitPassword);
  await page.getByTestId('create-email').fill(`e2e-renew-${Date.now().toString(36)}@example.test`);
  await page.getByTestId('create-password').fill(explicitPassword);
  await page.getByTestId('create-submit').click();
  await expect(page.getByTestId('admin-notice')).toContainText('作者账号已创建', {
    timeout: 15_000,
  });

  // 断言确实发生过续期：/me 被调用到第 3 次以后
  expect(meCalls).toBeGreaterThanOrEqual(3);

  // 等待超过**第一次**的到期时间（4 秒）：续期后不应被错误踢出
  await page.waitForTimeout(6_000);
  await expect(page).toHaveURL(/\/admin\/users/);
  await expect(page.getByTestId('users-table')).toBeVisible();

  // 继续等待到**新的**到期时间到达：此时应正常退出
  await expect(page).toHaveURL(/\/login\?reason=expired/, { timeout: 40_000 });

  await context.close();
});

test('19. 改密页：服务端返回 ACCOUNT_DISABLED 时跳 /login?reason=disabled', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await context.route('**/api/auth/change-password', async (route) => {
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'ACCOUNT_DISABLED', message: '账号已停用' } }),
    });
  });

  await page.goto('/change-password');
  await page.getByLabel('当前密码').fill('whatever-password-1');
  await page.getByLabel('新密码', { exact: true }).fill('brand-new-password-1');
  await page.getByLabel('确认新密码').fill('brand-new-password-1');
  await page.getByRole('button', { name: '提交' }).click();

  await expect(page).toHaveURL(/\/login\?reason=disabled/, { timeout: 20_000 });
  await expect(page.getByTestId('login-error')).toHaveText('账号已停用，请联系管理员');

  await context.close();
});

test('20. 改密页：服务端返回 UNAUTHENTICATED 时跳 /login', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await context.route('**/api/auth/change-password', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '未登录' } }),
    });
  });

  await page.goto('/change-password');
  await page.getByLabel('当前密码').fill('whatever-password-1');
  await page.getByLabel('新密码', { exact: true }).fill('brand-new-password-1');
  await page.getByLabel('确认新密码').fill('brand-new-password-1');
  await page.getByRole('button', { name: '提交' }).click();

  await expect(page).toHaveURL(/\/login(\?|$)/, { timeout: 20_000 });

  await context.close();
});

test('21. 改密页：服务端返回 PASSWORD_CHANGE_REQUIRED 时保持改密页', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await context.route('**/api/auth/change-password', async (route) => {
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'PASSWORD_CHANGE_REQUIRED', message: '首次登录必须先修改密码' },
      }),
    });
  });

  await page.goto('/change-password');
  await page.getByLabel('当前密码').fill('whatever-password-1');
  await page.getByLabel('新密码', { exact: true }).fill('brand-new-password-1');
  await page.getByLabel('确认新密码').fill('brand-new-password-1');
  await page.getByRole('button', { name: '提交' }).click();

  // 保持改密页并给出提示
  await expect(page).toHaveURL(/\/change-password/);
  await expect(page.getByTestId('change-password-error')).toHaveText('请先完成首次改密');

  await context.close();
});

test('14. 第 11 个账号：页面提示账号上限', async () => {
  // 重新登录管理员（上一步已退出）
  await adminPage.getByLabel('邮箱').fill(ADMIN_EMAIL);
  await adminPage.getByLabel('密码').fill(ADMIN_NEW_PASSWORD);
  await adminPage.getByRole('button', { name: '登录' }).click();
  await expect(adminPage).toHaveURL(/\/admin\/users/);

  // 通过接口快速补齐到 10 个账号（管理员 + 作者 + 8 个）
  const listResponse = await adminPage.request.get('/api/admin/users');
  const list = (await listResponse.json()) as { users: { email: string }[] };
  const missing = 10 - list.users.length;
  for (let index = 0; index < missing; index += 1) {
    const response = await adminPage.request.post('/api/admin/users', {
      headers: { origin: ORIGIN },
      data: { email: `e2e-bulk-${index}-${Date.now().toString(36)}@example.test` },
    });
    expect(response.status()).toBe(201);
  }

  await adminPage.reload();
  await expect(adminPage.getByTestId('users-table')).toBeVisible();

  // 页面出现上限提示
  await expect(adminPage.getByText('账号数量已达上限（10 个），无法继续创建。')).toBeVisible();

  // 仍尝试第 11 个：服务端返回稳定错误码，页面显示中文提示
  await adminPage
    .getByTestId('create-email')
    .fill(`e2e-over-${Date.now().toString(36)}@example.test`);
  await adminPage.getByTestId('create-submit').click();
  await expect(adminPage.getByTestId('action-error')).toHaveText('账号数量已达上限（10 个）');

  const overLimit = await adminPage.request.post('/api/admin/users', {
    headers: { origin: ORIGIN },
    data: { email: `e2e-over-api-${Date.now().toString(36)}@example.test` },
  });
  expect(overLimit.status()).toBe(409);
  const overLimitBody = (await overLimit.json()) as { error: { code: string } };
  expect(overLimitBody.error.code).toBe('USER_LIMIT_REACHED');
});
