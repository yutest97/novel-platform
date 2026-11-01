import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { ADMIN_EMAIL, ORIGIN, readAdminPassword } from './shared-credentials.js';
import { recordSecret } from './secret-ledger.js';

/**
 * M2-A 作品流程 E2E。
 *
 * 场景：
 * - 管理员创建两个作者；
 * - 作者 A 登录、创建作品、刷新后仍存在；
 * - 打开作品详情；
 * - 作者 B 登录，看不到作者 A 的作品；
 * - 作者 B 直接进入作者 A 的 /works/:id 无法访问；
 * - 退出后重新登录，作者 A 仍能看到自己的作品；
 * - 移动端 390×844 创建作品并查看列表；
 * - 表单错误提示可被读屏获取；
 * - 页面不出现人物、章节或 AI 生成入口。
 *
 * 前置：admin-flow.spec.ts 已完成管理员首次改密，并写入共享口令文件。
 */

const screenshotDir = resolve(process.cwd(), '../../docs/screenshots');
const shot = (name: string): string => resolve(screenshotDir, `m2a-${name}.png`);

// 注意：不能在模块顶层读取共享口令 —— Playwright 会先**加载**所有 spec 文件
// 再执行，此时 admin-flow.spec.ts 还没跑，改密后的口令尚不存在。
let adminPassword = '';

const AUTHOR_A_EMAIL = `m2a-author-a-${Date.now().toString(36)}@example.test`;
const AUTHOR_B_EMAIL = `m2a-author-b-${Date.now().toString(36)}@example.test`;
const AUTHOR_A_NEW_PASSWORD = `M2a-AuthorA2-${randomUUID()}`;
// 作者的**初始口令**由服务器生成（一次性），在 beforeAll 里创建账号时取得
let authorAInitialPassword = '';
let authorBInitialPassword = '';

const WORK_TITLE = `玄天问道-${randomUUID().slice(0, 8)}`;

/** 管理员创建一个作者账号，返回一次性初始口令。 */
async function createAuthorByAdmin(
  page: Page,
  email: string,
): Promise<{ id: string; initialPassword: string }> {
  const response = await page.request.post('/api/admin/users', {
    headers: { origin: ORIGIN },
    data: { email },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { user: { id: string }; initialPassword: string };
  recordSecret(body.initialPassword);
  return { id: body.user.id, initialPassword: body.initialPassword };
}

/**
 * 以给定账号登录。
 *
 * 必须等登录请求**完成**再返回：登录后立刻 goto 会中断尚未完成的请求，
 * 导致会话 Cookie 还没种下就被带到新页面（表现为 /api/auth/me 401 → 跳登录）。
 */
async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  // 成功会离开 /login（去 /change-password 或 /workspace）；
  // 失败会留在 /login 并显示错误 —— 此时断言失败，报错更清晰。
  await expect(page).not.toHaveURL(/\/login(\?|$)/);
}

test.describe.configure({ mode: 'serial' });

let adminContext: BrowserContext;
let adminPage: Page;
let authorAId = '';
let authorAWorkId = '';

test.beforeAll(async ({ browser }) => {
  mkdirSync(screenshotDir, { recursive: true });

  // 延迟读取：admin-flow.spec.ts 已完成首次改密并写入共享口令
  adminPassword = readAdminPassword();

  adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  adminPage = await adminContext.newPage();

  // 管理员登录（用改密后的口令）
  await login(adminPage, ADMIN_EMAIL, adminPassword);
  await expect(adminPage).toHaveURL(/\/admin\/users/);

  // 管理员创建两个作者
  const a = await createAuthorByAdmin(adminPage, AUTHOR_A_EMAIL);
  const b = await createAuthorByAdmin(adminPage, AUTHOR_B_EMAIL);
  authorAId = a.id;
  authorAInitialPassword = a.initialPassword;
  authorBInitialPassword = b.initialPassword;
  expect(b.id).not.toBe(authorAId);
});

test.afterAll(async () => {
  await adminContext?.close();
});

test('1. 管理员创建的两个作者都能登录并完成首登改密', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, authorAInitialPassword);
  await expect(page).toHaveURL(/\/change-password/);

  // 新口令是运行时生成的：使用前必须记入口令清单，
  // 否则失败快照里可能出现它的明文。
  recordSecret(AUTHOR_A_NEW_PASSWORD);

  await page.getByLabel('当前密码').fill(authorAInitialPassword);
  await page.getByLabel('新密码', { exact: true }).fill(AUTHOR_A_NEW_PASSWORD);
  await page.getByLabel('确认新密码').fill(AUTHOR_A_NEW_PASSWORD);
  await page.getByRole('button', { name: '提交' }).click();

  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('workspace-email')).toHaveText(AUTHOR_A_EMAIL);

  await context.close();
});

test('2. 作者 A 创建作品，刷新后仍存在', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await expect(page).toHaveURL(/\/workspace/);

  // 空状态
  await expect(page.getByTestId('works-empty')).toBeVisible();

  await page.getByTestId('work-title-input').fill(WORK_TITLE);
  await page.getByTestId('work-summary-input').fill('一个少年踏上修行之路的故事。');
  await page.getByTestId('work-chapters-input').fill('20');
  await page.getByTestId('work-words-input').fill('4000');
  await page.getByTestId('work-create-submit').click();

  await expect(page.getByTestId('work-notice')).toContainText('已创建');
  await expect(page.getByTestId('works-list')).toBeVisible();
  await expect(page.getByTestId('work-card')).toHaveCount(1);
  await expect(page.getByTestId('work-card')).toContainText(WORK_TITLE);

  // 刷新后仍在
  await page.reload();
  await expect(page.getByTestId('work-card')).toHaveCount(1);
  await expect(page.getByTestId('work-card')).toContainText(WORK_TITLE);

  await page.screenshot({ path: shot('workspace'), fullPage: true });

  // 记录作品 id，供后续用例使用
  const href = await page.getByTestId('work-card').getAttribute('href');
  expect(href).not.toBeNull();
  authorAWorkId = href?.split('/').pop() ?? '';

  await context.close();
});

test('3. 作者 A 打开作品详情', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}`);

  await expect(page.getByTestId('work-detail-title')).toHaveText(WORK_TITLE);
  await expect(page.getByTestId('work-detail-chapters')).toHaveText('20');
  await expect(page.getByTestId('work-detail-words')).toHaveText('4000');
  await expect(page.getByTestId('back-to-works')).toBeVisible();

  // 明确提示后续阶段才开放的功能
  await expect(
    page.getByText('人物、势力、功法、物品、卷纲与章节创作将在后续阶段开放。'),
  ).toBeVisible();

  await page.screenshot({ path: shot('work-detail'), fullPage: true });

  await context.close();
});

test('4. 作者 B 看不到作者 A 的作品，直接访问其作品详情也被拒绝', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // B 首次登录需要改密
  await login(page, AUTHOR_B_EMAIL, authorBInitialPassword);
  await expect(page).toHaveURL(/\/change-password/);

  // 改密后的口令同样是运行时拼出来的，必须记入口令清单
  const authorBChangedPassword = `${authorBInitialPassword}-changed`;
  recordSecret(authorBChangedPassword);

  await page.getByLabel('当前密码').fill(authorBInitialPassword);
  await page.getByLabel('新密码', { exact: true }).fill(authorBChangedPassword);
  await page.getByLabel('确认新密码').fill(authorBChangedPassword);
  await page.getByRole('button', { name: '提交' }).click();
  await expect(page).toHaveURL(/\/workspace/);

  // 列表为空
  await expect(page.getByTestId('works-empty')).toBeVisible();
  await expect(page.getByText(WORK_TITLE)).toHaveCount(0);

  // 直接进入 A 的作品详情：无法访问
  await page.goto(`/works/${authorAWorkId}`);
  await expect(page.getByTestId('work-detail-error')).toBeVisible();
  await expect(page.getByText('作品不存在，或不属于当前账号。')).toBeVisible();

  await context.close();
});

test('5. 作者 A 退出后重新登录，仍能看到自己的作品', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await expect(page).toHaveURL(/\/workspace/);

  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login/);

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('work-card')).toHaveCount(1);
  await expect(page.getByTestId('work-card')).toContainText(WORK_TITLE);

  await context.close();
});

test('6. 重复标题显示稳定的中文提示（可被读屏获取）', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await expect(page).toHaveURL(/\/workspace/);

  await page.getByTestId('work-title-input').fill(WORK_TITLE);
  await page.getByTestId('work-create-submit').click();

  const error = page.getByTestId('work-create-error');
  await expect(error).toBeVisible();
  await expect(error).toHaveText('你已创建过同名作品，请换一个标题');
  // role="alert" → 可被读屏获取
  await expect(error).toHaveAttribute('role', 'alert');

  await context.close();
});

test('7. 表单校验失败显示可访问的错误提示', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await expect(page).toHaveURL(/\/workspace/);

  // 章数越界
  await page.getByTestId('work-title-input').fill(`边界作品-${randomUUID().slice(0, 6)}`);
  await page.getByTestId('work-chapters-input').fill('999');
  await page.getByTestId('work-create-submit').click();

  const error = page.getByTestId('work-create-error');
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText('目标章数');

  await context.close();
});

test('8. 移动端 390×844：创建作品并查看列表', async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await expect(page).toHaveURL(/\/workspace/);

  const title = `移动端作品-${randomUUID().slice(0, 6)}`;
  await page.getByTestId('work-title-input').fill(title);
  await page.getByTestId('work-create-submit').click();
  await expect(page.getByTestId('work-notice')).toContainText('已创建');
  await expect(page.getByTestId('work-card')).toHaveCount(2);

  await page.screenshot({ path: shot('mobile-workspace'), fullPage: false });

  // 触控目标可用
  const submitBox = await page.getByTestId('work-create-submit').boundingBox();
  expect(submitBox?.height ?? 0).toBeGreaterThanOrEqual(40);

  // 页面不撑破视口
  const metrics = await page.evaluate(() => ({
    docWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(metrics.docWidth).toBeLessThanOrEqual(metrics.viewport + 1);

  await context.close();
});

test('9. PATCH 不可变字段被服务端拒绝（400），作品不被改动', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await expect(page).toHaveURL(/\/workspace/);

  // 通过接口直接 PATCH：不可变字段一律 400，不静默忽略
  const forbiddenBodies: Record<string, unknown>[] = [
    { authorId: randomUUID() },
    { author_id: randomUUID() },
    { role: 'admin' },
    { id: randomUUID() },
    { genreRulePackage: 'xuanhuan' },
    { genre_rule_package: 'xuanhuan' },
    { createdAt: '2020-01-01T00:00:00.000Z' },
    { created_at: '2020-01-01T00:00:00.000Z' },
    { updatedAt: '2020-01-01T00:00:00.000Z' },
    { updated_at: '2020-01-01T00:00:00.000Z' },
  ];

  for (const body of forbiddenBodies) {
    const response = await page.request.patch(`/api/works/${authorAWorkId}`, {
      headers: { origin: ORIGIN },
      data: body,
    });
    expect(response.status(), `字段 ${Object.keys(body)[0]} 应当被拒绝`).toBe(400);
    const parsed = (await response.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_FAILED');
  }

  // 作品本身没被改动：仍可正常读取，标题与题材保持原值
  const detail = await page.request.get(`/api/works/${authorAWorkId}`);
  expect(detail.status()).toBe(200);
  const parsed = (await detail.json()) as {
    work: { title: string; genreRulePackage: string };
  };
  expect(parsed.work.title).toBe(WORK_TITLE);
  expect(parsed.work.genreRulePackage).toBe('xuanhuan');

  await context.close();
});

test('10. 页面不出现人物、章节或 AI 生成入口', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await expect(page).toHaveURL(/\/workspace/);

  // 不存在这些入口
  for (const label of ['人物', '境界', '卷纲', 'AI 生成', '生成章节']) {
    await expect(page.getByRole('button', { name: label })).toHaveCount(0);
    await expect(page.getByRole('link', { name: label })).toHaveCount(0);
  }

  await context.close();
});
