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
/** M2-B2-B 的截图单独用 m2b2- 前缀，避免与「方向 + 境界」时期的图混在一起。 */
const shotM2b2 = (name: string): string => resolve(screenshotDir, `m2b2-${name}.png`);

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

test('2b. 清空可选作品方向字段：保存后刷新仍为空', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  // 先写入两个可选字段
  await page.getByTestId('direction-toneStyle').fill('热血激昂');
  await page.getByTestId('direction-protagonistPosition').fill('废柴逆袭');
  await page.getByTestId('direction-save').click();
  await expect(page.getByTestId('settings-notice')).toContainText('已保存');

  await page.reload();
  await expect(page.getByTestId('direction-toneStyle')).toHaveValue('热血激昂');
  await expect(page.getByTestId('direction-protagonistPosition')).toHaveValue('废柴逆袭');

  // 清空两个可选字段后保存
  await page.getByTestId('direction-toneStyle').fill('');
  await page.getByTestId('direction-protagonistPosition').fill('');
  await page.getByTestId('direction-save').click();
  await expect(page.getByTestId('settings-notice')).toContainText('已保存');

  // 刷新后必须仍为空（服务端确实删掉了这两行）
  await page.reload();
  await expect(page.getByTestId('direction-toneStyle')).toHaveValue('');
  await expect(page.getByTestId('direction-protagonistPosition')).toHaveValue('');

  // 必填字段不受影响
  await expect(page.getByTestId('direction-subGenre')).toHaveValue('东方玄幻');
  await expect(page.getByTestId('direction-goldenFinger')).toHaveValue('残破玉佩');

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
  await expect(reloaded.getByTestId('realm-attr-minorLevelCount')).toHaveText('4');
  await expect(reloaded.getByTestId('realm-attr-breakthroughCondition')).toHaveText(
    '破而后立，心境无瑕',
  );

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

test('9. 设定页只开放本阶段的四类分区，不出现物品/功法/地点/关系图/AI 入口', async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  // 本阶段开放的四类分区（顺序见下一个用例）
  await expect(page.getByTestId('direction-save')).toBeVisible();
  await expect(page.getByTestId('realm-section')).toBeVisible();
  await expect(page.getByTestId('faction-section')).toBeVisible();
  await expect(page.getByTestId('character-section')).toBeVisible();

  // 后续阶段的能力不能以任何可点击入口出现
  for (const label of ['物品', '功法', '地点', '关系图', 'AI 生成']) {
    await expect(page.getByRole('button', { name: label })).toHaveCount(0);
    await expect(page.getByRole('link', { name: label })).toHaveCount(0);
  }

  await context.close();
});

/* ------------------------------------------------------------------ *
 * M2-B2-B：多类型设定中心（势力 / 人物）与引用保护
 * ------------------------------------------------------------------ */

/** 打开某个分区的新建表单并提交；`fill` 里可以继续操作该分区内的控件。 */
async function createInSection(
  page: Page,
  key: 'realm' | 'faction' | 'character',
  name: string,
  fill?: () => Promise<void>,
): Promise<void> {
  await page.getByTestId(`${key}-create-open`).click();
  await page.getByTestId(`${key}-new-name`).fill(name);
  if (fill !== undefined) {
    await fill();
  }
  await page.getByTestId(`${key}-create-submit`).click();
  await expect(
    page.getByTestId(`${key}-item`).filter({ hasText: name }),
    `${key} 分区应出现「${name}」`,
  ).toHaveCount(1);
}

/** 某分区当前的实体名称顺序。 */
async function namesOf(page: Page, key: 'realm' | 'faction' | 'character'): Promise<string[]> {
  return page.getByTestId(`${key}-name`).allTextContents();
}

test('10. 分区顺序来自 entityGroups.order，可创建两个势力', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  // 三个分区都渲染完成后再收集标题
  await expect(page.getByTestId('realm-section')).toBeVisible();
  await expect(page.getByTestId('faction-section')).toBeVisible();
  await expect(page.getByTestId('character-section')).toBeVisible();

  // 分区顺序由服务端 entityGroups.order 决定：境界 → 势力 → 人物
  const headings = await page.locator('[data-testid$="-section"] h2').allTextContents();
  expect(headings).toEqual(['境界体系', '势力', '人物']);

  await expect(page.getByTestId('faction-count')).toContainText('0');
  await expect(page.getByTestId('faction-empty')).toBeVisible();

  await createInSection(page, 'faction', '青云宗', async () => {
    await page.getByTestId('faction-new-type').selectOption('sect');
    await page.getByTestId('faction-new-tier').fill('一流');
  });
  await createInSection(page, 'faction', '血刀门', async () => {
    await page.getByTestId('faction-new-type').selectOption('family');
  });

  await expect(page.getByTestId('faction-count')).toContainText('2');
  await expect(page.getByTestId('faction-item')).toHaveCount(2);

  // 类型显示为 label 而不是入库 value
  await expect(
    page.getByTestId('faction-item').filter({ hasText: '青云宗' }).getByTestId('faction-attr-type'),
  ).toHaveText('宗门');

  await page.reload();
  await expect(page.getByTestId('faction-item')).toHaveCount(2);

  await context.close();
});

test('11. 人物引用境界与势力；无候选时显示空态', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  await page.getByTestId('character-create-open').click();

  // 还没有任何人物 → 「谁知道这个秘密」没有候选，必须给出明确空态
  await expect(page.getByTestId('character-new-secretKnownBy-empty')).toContainText('人物');

  await page.getByTestId('character-new-name').fill('林青');
  await page.getByTestId('character-new-identity').fill('外门弟子');
  await page.getByTestId('character-new-secret').fill('（测试占位）身世另有隐情');
  await page.getByTestId('character-new-initialRealm').selectOption({ label: '筑基' });
  await page.getByTestId('character-new-faction').selectOption({ label: '青云宗' });

  // 秘密只存在于组件内存：不进 URL，也不进任何 Web Storage
  const storage = await page.evaluate(() => ({
    local: window.localStorage.length,
    session: window.sessionStorage.length,
    href: window.location.href,
  }));
  expect(storage.local).toBe(0);
  expect(storage.session).toBe(0);
  expect(storage.href).not.toContain('测试占位');

  await page.getByTestId('character-create-submit').click();

  const linqing = page.getByTestId('character-item').filter({ hasText: '林青' });
  await expect(linqing).toHaveCount(1);
  await expect(linqing.getByTestId('character-attr-initialRealm')).toHaveText('筑基');
  await expect(linqing.getByTestId('character-attr-faction')).toHaveText('青云宗');

  // 刷新后仍在（引用以 UUID 存储、展示为名称）
  await page.reload();
  const reloaded = page.getByTestId('character-item').filter({ hasText: '林青' });
  await expect(reloaded.getByTestId('character-attr-initialRealm')).toHaveText('筑基');

  await context.close();
});

test('12. 编辑人物把所属势力改为另一个势力', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  await page
    .getByTestId('character-item')
    .filter({ hasText: '林青' })
    .getByTestId('character-edit')
    .click();
  // 编辑时自身必须从候选里排除（禁止自引用）
  const selfOptions = await page
    .getByTestId('character-edit-secretKnownBy-select')
    .locator('option')
    .allTextContents();
  expect(selfOptions).not.toContain('林青');

  await page.getByTestId('character-edit-faction').selectOption({ label: '血刀门' });
  await page.getByTestId('character-edit-save').click();
  await expect(page.getByTestId('settings-notice')).toContainText('已更新');

  await page.reload();
  await expect(
    page
      .getByTestId('character-item')
      .filter({ hasText: '林青' })
      .getByTestId('character-attr-faction'),
  ).toHaveText('血刀门');

  await context.close();
});

test('13. 把另一人物加入 secretKnownBy：顺序保留、刷新后仍在', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  await createInSection(page, 'character', '苏沐', async () => {
    await page.getByTestId('character-new-identity').fill('师姐');
  });

  await page
    .getByTestId('character-item')
    .filter({ hasText: '林青' })
    .getByTestId('character-edit')
    .click();
  await page.getByTestId('character-edit-secretKnownBy-select').selectOption({ label: '苏沐' });
  await page.getByTestId('character-edit-secretKnownBy-add').click();
  await expect(page.getByTestId('character-edit-secretKnownBy-selected')).toContainText('1. 苏沐');
  await page.getByTestId('character-edit-save').click();
  await expect(page.getByTestId('settings-notice')).toContainText('已更新');

  await page.reload();
  await expect(
    page
      .getByTestId('character-item')
      .filter({ hasText: '林青' })
      .getByTestId('character-attr-secretKnownBy'),
  ).toHaveText('苏沐');

  await context.close();
});

test('14. 删除被人物引用的境界：409 并展示引用者名称', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  await page
    .getByTestId('realm-item')
    .filter({ hasText: '筑基' })
    .getByTestId('realm-delete')
    .click();

  await expect(page.getByTestId('realm-error')).toContainText('该实体当前被引用，无法删除');
  await expect(page.getByTestId('realm-references')).toBeVisible();
  await expect(page.getByTestId('realm-references')).toContainText('共 1 个实体引用了它');
  // 只展示类型与名称，不含秘密或属性值
  await expect(page.getByTestId('realm-reference-item')).toHaveText('人物 · 林青');
  await expect(page.getByTestId('realm-references')).not.toContainText('测试占位');

  // 目标没有被删除
  await page.reload();
  await expect(page.getByTestId('realm-item').filter({ hasText: '筑基' })).toHaveCount(1);

  await context.close();
});

test('15. 解除引用后可以删除该境界', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  // 清空「初始境界」
  await page
    .getByTestId('character-item')
    .filter({ hasText: '林青' })
    .getByTestId('character-edit')
    .click();
  await page.getByTestId('character-edit-initialRealm').selectOption('');
  await page.getByTestId('character-edit-save').click();
  await expect(page.getByTestId('settings-notice')).toContainText('已更新');

  await page
    .getByTestId('realm-item')
    .filter({ hasText: '筑基' })
    .getByTestId('realm-delete')
    .click();
  await expect(page.getByTestId('settings-notice')).toContainText('已删除');

  await page.reload();
  await expect(page.getByTestId('realm-item').filter({ hasText: '筑基' })).toHaveCount(0);
  await expect(
    page
      .getByTestId('character-item')
      .filter({ hasText: '林青' })
      .getByTestId('character-attr-initialRealm'),
  ).toHaveText('—');

  await context.close();
});

test('16. 删除被人物引用的势力：409 摘要；解除后可删', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  await page
    .getByTestId('faction-item')
    .filter({ hasText: '血刀门' })
    .getByTestId('faction-delete')
    .click();
  await expect(page.getByTestId('faction-error')).toContainText('该实体当前被引用，无法删除');
  await expect(page.getByTestId('faction-reference-item')).toHaveText('人物 · 林青');

  await page
    .getByTestId('character-item')
    .filter({ hasText: '林青' })
    .getByTestId('character-edit')
    .click();
  await page.getByTestId('character-edit-faction').selectOption({ label: '青云宗' });
  await page.getByTestId('character-edit-save').click();
  await expect(page.getByTestId('settings-notice')).toContainText('已更新');

  await page
    .getByTestId('faction-item')
    .filter({ hasText: '血刀门' })
    .getByTestId('faction-delete')
    .click();
  await expect(page.getByTestId('settings-notice')).toContainText('已删除');
  await expect(page.getByTestId('faction-item')).toHaveCount(1);

  await context.close();
});

test('17. 三类实体分别新增与排序，互不影响', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  await createInSection(page, 'realm', '化神', async () => {
    await page.getByTestId('realm-new-minorLevelCount').fill('1');
    await page.getByTestId('realm-new-breakthroughCondition').fill('神魂合一');
  });
  await createInSection(page, 'faction', '万剑宗', async () => {
    await page.getByTestId('faction-new-type').selectOption('sect');
  });

  const realmsBefore = await namesOf(page, 'realm');
  const charactersBefore = await namesOf(page, 'character');
  expect(await namesOf(page, 'faction')).toEqual(['青云宗', '万剑宗']);

  // 势力排序不影响境界与人物
  await page
    .getByTestId('faction-item')
    .filter({ hasText: '万剑宗' })
    .getByTestId('faction-move-up')
    .click();
  await expect(page.getByTestId('faction-name').first()).toHaveText('万剑宗');
  expect(await namesOf(page, 'realm')).toEqual(realmsBefore);
  expect(await namesOf(page, 'character')).toEqual(charactersBefore);

  // 境界排序不影响势力与人物
  await expect(page.getByTestId('faction-name').nth(1)).toHaveText('青云宗');
  await page
    .getByTestId('realm-item')
    .filter({ hasText: '化神' })
    .getByTestId('realm-move-up')
    .click();
  await expect(page.getByTestId('realm-name').nth(1)).toHaveText('化神');
  expect(await namesOf(page, 'faction')).toEqual(['万剑宗', '青云宗']);
  expect(await namesOf(page, 'character')).toEqual(charactersBefore);

  // 刷新后各自顺序都保持
  await page.reload();
  await expect(page.getByTestId('realm-name').nth(1)).toHaveText('化神');
  await expect(page.getByTestId('faction-name').first()).toHaveText('万剑宗');

  await page.screenshot({ path: shotM2b2('multitype-settings'), fullPage: true });

  await context.close();
});

test('18. enum 只能从 UI 的固定选项提交，非法值被服务端拒绝', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  await page.getByTestId('faction-create-open').click();
  const typeControl = page.getByTestId('faction-new-type');
  expect(await typeControl.evaluate((element) => element.tagName)).toBe('SELECT');

  const options = await typeControl.locator('option').evaluateAll((elements) =>
    elements.map((element) => ({
      value: (element as HTMLOptionElement).value,
      label: element.textContent ?? '',
    })),
  );
  // 空选项 + 规则包声明的六个 value（顺序即规则包顺序）
  expect(options.map((option) => option.value)).toEqual([
    '',
    'sect',
    'family',
    'dynasty',
    'alliance',
    'guild',
    'other',
  ]);
  expect(options.map((option) => option.label).slice(1)).toEqual([
    '宗门',
    '家族',
    '王朝',
    '联盟',
    '商盟',
    '其他',
  ]);

  await page.getByTestId('faction-create-cancel').click();

  // 即使绕过界面直接请求，服务端也会拒绝
  const response = await page.request.post(`/api/works/${authorAWorkId}/entities`, {
    headers: { origin: ORIGIN },
    data: { entityType: 'faction', name: '非法枚举势力', attributes: { type: 'not-an-option' } },
  });
  expect(response.status()).toBe(400);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
    'VALIDATION_FAILED',
  );

  await context.close();
});

test('19. 引用候选不含其它作者作品的数据', async ({ browser }) => {
  // 作者 B 先造一份同名境界
  const bContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const bPage = await bContext.newPage();
  await login(bPage, AUTHOR_B_EMAIL, AUTHOR_B_NEW_PASSWORD);
  const bWorkId = await createWorkAsAuthor(bPage, `别人的作品-${randomUUID().slice(0, 8)}`);
  await bPage.goto(`/works/${bWorkId}/settings`);
  await createRealm(bPage, '别人的境界', { minorLevels: '1', condition: '与我无关' });
  await expect(bPage.getByTestId('realm-name').first()).toHaveText('别人的境界');
  await bContext.close();

  // 作者 A 的候选里不应出现
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  await page.getByTestId('character-create-open').click();
  const realmOptions = await page
    .getByTestId('character-new-initialRealm')
    .locator('option')
    .allTextContents();
  expect(realmOptions).not.toContain('别人的境界');
  expect(realmOptions).toContain('化神');

  const factionOptions = await page
    .getByTestId('character-new-faction')
    .locator('option')
    .allTextContents();
  expect(factionOptions).toContain('青云宗');
  expect(factionOptions).toContain('万剑宗');

  await page.getByTestId('character-create-cancel').click();
  await context.close();
});

test('20. 移动端 390×844：创建人物、单选势力与多选秘密知晓人，不撑破视口', async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${authorAWorkId}/settings`);

  await createInSection(page, 'character', '云裳', async () => {
    await page.getByTestId('character-new-initialRealm').selectOption({ label: '化神' });
    await page.getByTestId('character-new-faction').selectOption({ label: '青云宗' });
    await page.getByTestId('character-new-secretKnownBy-select').selectOption({ label: '林青' });
    await page.getByTestId('character-new-secretKnownBy-add').click();
    await expect(page.getByTestId('character-new-secretKnownBy-selected')).toContainText('1. 林青');
  });

  const yunchang = page.getByTestId('character-item').filter({ hasText: '云裳' });
  await expect(yunchang.getByTestId('character-attr-faction')).toHaveText('青云宗');
  await expect(yunchang.getByTestId('character-attr-secretKnownBy')).toHaveText('林青');

  // 触控目标可用
  const addBox = await page.getByTestId('character-create-open').boundingBox();
  expect(addBox?.height ?? 0).toBeGreaterThanOrEqual(40);

  // 页面不撑破视口
  const metrics = await page.evaluate(() => ({
    docWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(metrics.docWidth).toBeLessThanOrEqual(metrics.viewport + 1);

  await page.screenshot({ path: shotM2b2('multitype-mobile'), fullPage: false });

  await context.close();
});
