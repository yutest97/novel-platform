import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { ADMIN_EMAIL, ORIGIN, readAdminPassword } from './shared-credentials.js';
import { recordSecret } from './secret-ledger.js';

/**
 * M2-B1 设定中心 E2E。
 *
 * 场景：
 * - 作者 A 进入作品设定；
 * - 填写并保存作品方向，刷新后仍存在；
 * - 创建炼气、筑基、金丹三个境界；
 * - 修改筑基信息，刷新后仍存在；
 * - 调整境界顺序，刷新后顺序保持；
 * - 删除一个未被引用境界；
 * - 作者 B 直接访问 A 的设定页无法访问；
 * - 移动端 390×844 可编辑作品方向并新增境界；
 * - 页面不出现人物、势力、功法、物品、章节或 AI 生成入口。
 *
 * 前置：admin-flow.spec.ts 已完成管理员首次改密并写入共享口令文件。
 */

const screenshotDir = resolve(process.cwd(), '../../docs/screenshots');
const shot = (name: string): string => resolve(screenshotDir, `m2b1-${name}.png`);

const AUTHOR_A_EMAIL = `m2b1-author-a-${Date.now().toString(36)}@example.test`;
const AUTHOR_B_EMAIL = `m2b1-author-b-${Date.now().toString(36)}@example.test`;
const AUTHOR_A_NEW_PASSWORD = `M2b1-AuthorA-${randomUUID()}`;
const AUTHOR_B_NEW_PASSWORD = `M2b1-AuthorB-${randomUUID()}`;

const WORK_TITLE = `设定作品-${randomUUID().slice(0, 8)}`;

let adminPassword = '';
let authorAWorkId = '';

test.describe.configure({ mode: 'serial' });

let adminContext: BrowserContext;
let adminPage: Page;
let authorAInitialPassword = '';
let authorBInitialPassword = '';

/** 以给定账号登录。 */
async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).not.toHaveURL(/\/login(\?|$)/);
}

/** 管理员创建一个作者，返回一次性初始口令。 */
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

/** 作者创建一个作品。 */
async function createWorkAsAuthor(page: Page, title: string): Promise<string> {
  await page.goto('/workspace');
  await expect(page).toHaveURL(/\/workspace/);
  await page.getByTestId('work-title-input').fill(title);
  await page.getByTestId('work-create-submit').click();
  await expect(page.getByTestId('work-notice')).toContainText('已创建');
  const href = await page.getByTestId('work-card').first().getAttribute('href');
  return href?.split('/').pop() ?? '';
}

/** 填写并保存一条境界。 */
async function createRealm(
  page: Page,
  name: string,
  options: { minorLevels?: string; condition?: string } = {},
): Promise<void> {
  await page.getByTestId('realm-create-open').click();
  await page.getByTestId('realm-new-name').fill(name);
  await page.getByTestId('realm-new-minorLevelCount').fill(options.minorLevels ?? '9');
  await page.getByTestId('realm-new-breakthroughCondition').fill(options.condition ?? '引气入体');
  await page.getByTestId('realm-create-submit').click();
  await expect(page.getByTestId('settings-notice')).toContainText('已新增', { timeout: 15_000 });
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(screenshotDir, { recursive: true });
  adminPassword = readAdminPassword();

  adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  adminPage = await adminContext.newPage();

  await login(adminPage, ADMIN_EMAIL, adminPassword);
  await expect(adminPage).toHaveURL(/\/admin\/users/);

  const a = await createAuthorByAdmin(adminPage, AUTHOR_A_EMAIL);
  const b = await createAuthorByAdmin(adminPage, AUTHOR_B_EMAIL);
  authorAInitialPassword = a.initialPassword;
  authorBInitialPassword = b.initialPassword;
});

test.afterAll(async () => {
  await adminContext?.close();
});

test('1. 作者完成首登改密并创建作品', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, authorAInitialPassword);
  await expect(page).toHaveURL(/\/change-password/);

  recordSecret(AUTHOR_A_NEW_PASSWORD);
  await page.getByLabel('当前密码').fill(authorAInitialPassword);
  await page.getByLabel('新密码', { exact: true }).fill(AUTHOR_A_NEW_PASSWORD);
  await page.getByLabel('确认新密码').fill(AUTHOR_A_NEW_PASSWORD);
  await page.getByRole('button', { name: '提交' }).click();
  await expect(page).toHaveURL(/\/workspace/);

  authorAWorkId = await createWorkAsAuthor(page, WORK_TITLE);
  expect(authorAWorkId).not.toBe('');

  await context.close();
});

test('2. 进入设定中心：填写并保存作品方向，刷新后仍存在', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  await expect(page.getByTestId('direction-subGenre')).toBeVisible();
  await page.getByTestId('direction-subGenre').fill('东方玄幻');
  await page.getByTestId('direction-goldenFinger').fill('残破玉佩');
  await page.getByTestId('direction-toneStyle').fill('热血激昂');
  await page.getByTestId('direction-protagonistPosition').fill('废柴逆袭');
  await page.getByTestId('direction-save').click();
  await expect(page.getByTestId('settings-notice')).toContainText('已保存');

  // 刷新后仍存在
  await page.reload();
  await expect(page.getByTestId('direction-subGenre')).toHaveValue('东方玄幻');
  await expect(page.getByTestId('direction-goldenFinger')).toHaveValue('残破玉佩');
  await expect(page.getByTestId('direction-toneStyle')).toHaveValue('热血激昂');
  await expect(page.getByTestId('direction-protagonistPosition')).toHaveValue('废柴逆袭');

  await page.screenshot({ path: shot('settings'), fullPage: true });

  await context.close();
});

test('3. 创建炼气、筑基、金丹三个境界', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  await expect(page.getByTestId('realm-count')).toContainText('0');

  await createRealm(page, '炼气', { minorLevels: '9', condition: '引气入体' });
  await createRealm(page, '筑基', { minorLevels: '3', condition: '破而后立' });
  await createRealm(page, '金丹', { minorLevels: '1', condition: '凝结丹液' });

  await expect(page.getByTestId('realm-count')).toContainText('3');
  await expect(page.getByTestId('realm-item')).toHaveCount(3);
  await expect(page.getByTestId('realm-name').first()).toHaveText('炼气');

  await context.close();
});

test('4. 修改筑基信息，刷新后仍存在', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  const zhuji = page.getByTestId('realm-item').filter({ hasText: '筑基' });
  await zhuji.getByTestId('realm-edit').click();
  await page.getByTestId('realm-edit-minorLevelCount').fill('4');
  await page.getByTestId('realm-edit-breakthroughCondition').fill('破而后立，心境无瑕');
  await page.getByTestId('realm-edit-save').click();
  await expect(page.getByTestId('settings-notice')).toContainText('已更新');

  await page.reload();
  const reloaded = page.getByTestId('realm-item').filter({ hasText: '筑基' });
  await expect(reloaded.getByTestId('realm-minor-levels')).toHaveText('4');
  await expect(reloaded.getByTestId('realm-breakthrough')).toHaveText('破而后立，心境无瑕');

  await context.close();
});

test('5. 调整境界顺序，刷新后顺序保持', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  // 把「金丹」上移一位
  const jindan = page.getByTestId('realm-item').filter({ hasText: '金丹' });
  await jindan.getByTestId('realm-move-up').click();
  await expect(page.getByTestId('realm-name').nth(1)).toHaveText('金丹');

  await page.reload();
  await expect(page.getByTestId('realm-name').nth(0)).toHaveText('炼气');
  await expect(page.getByTestId('realm-name').nth(1)).toHaveText('金丹');
  await expect(page.getByTestId('realm-name').nth(2)).toHaveText('筑基');

  await context.close();
});

test('6. 删除一个未被引用的境界', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  const jindan = page.getByTestId('realm-item').filter({ hasText: '金丹' });
  await jindan.getByTestId('realm-delete').click();
  await expect(page.getByTestId('settings-notice')).toContainText('已删除');

  await page.reload();
  await expect(page.getByTestId('realm-count')).toContainText('2');
  await expect(page.getByText('金丹')).toHaveCount(0);

  await context.close();
});

test('7. 作者 B 直接访问作者 A 的设定页无法访问', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_B_EMAIL, authorBInitialPassword);
  await expect(page).toHaveURL(/\/change-password/);

  recordSecret(AUTHOR_B_NEW_PASSWORD);
  await page.getByLabel('当前密码').fill(authorBInitialPassword);
  await page.getByLabel('新密码', { exact: true }).fill(AUTHOR_B_NEW_PASSWORD);
  await page.getByLabel('确认新密码').fill(AUTHOR_B_NEW_PASSWORD);
  await page.getByRole('button', { name: '提交' }).click();
  await expect(page).toHaveURL(/\/workspace/);

  // 直接进入 A 的设定页
  await page.goto(`/works/${authorAWorkId}/settings`);
  await expect(page.getByTestId('settings-load-error')).toBeVisible();
  await expect(page.getByText('作品不存在，或不属于当前账号。')).toBeVisible();

  // 接口层同样是 404
  const response = await page.request.get(`/api/works/${authorAWorkId}/settings`);
  expect(response.status()).toBe(404);

  await context.close();
});

test('8. 移动端 390×844：可编辑作品方向并新增境界', async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  await page.getByTestId('direction-toneStyle').fill('冷峻克制');
  await page.getByTestId('direction-save').click();
  await expect(page.getByTestId('settings-notice')).toContainText('已保存');

  await createRealm(page, '元婴', { minorLevels: '1', condition: '神魂蜕变' });
  await expect(page.getByTestId('realm-count')).toContainText('3');

  await page.screenshot({ path: shot('mobile-settings'), fullPage: false });

  // 触控目标可用
  const submitBox = await page.getByTestId('direction-save').boundingBox();
  expect(submitBox?.height ?? 0).toBeGreaterThanOrEqual(40);

  // 页面不撑破视口
  const metrics = await page.evaluate(() => ({
    docWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(metrics.docWidth).toBeLessThanOrEqual(metrics.viewport + 1);

  await context.close();
});

test('9. 设定页不出现人物、势力、功法、物品、章节或 AI 生成入口', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  for (const label of ['人物', '势力', '功法', '物品', '章节', 'AI 生成']) {
    await expect(page.getByRole('button', { name: label })).toHaveCount(0);
    await expect(page.getByRole('link', { name: label })).toHaveCount(0);
  }

  await context.close();
});
