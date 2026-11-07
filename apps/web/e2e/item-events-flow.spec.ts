import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import {
  ADMIN_EMAIL,
  ORIGIN,
  readAdminPassword,
  writeAuthorCredentials,
} from './shared-credentials.js';
import { recordSecret } from './secret-ledger.js';

/**
 * M2-B3-B2：物品持有人 / 事件时间线 UI + E2E。
 *
 * 覆盖：
 * - item 卡片上的「持有人 / 事件」入口（其它实体没有）；
 * - 首次打开同时读 `/state` 与 `/events`（首屏 `limit=50`）；
 * - 未登记 → 登记获得 → 转手 → 消耗 → 冲正 → 冲正行不可再冲正；
 * - 备注 / 幂等键不写 URL、localStorage、sessionStorage；
 * - 删除当前持有人 `409` 并列出物品名；转走后可删；
 * - 他人作品 `404`、管理员 `403`；
 * - 软删物品后事件仍可读，追加 / 冲正入口不可用（`?item=<id>` 直达）；
 * - 390×844 下完成登记 / 转手 / 冲正，不撑破视口，按钮 ≥ 40px。
 *
 * 前置：admin-flow.spec.ts 已完成管理员首次改密并写入共享口令文件。
 *
 * 账号预算：产品硬上限 10 个，既有 4 个 spec 已占 9 个（管理员 1 + 既有作者 8），
 * 因此本文件只新建 **1 个**作者。跨作者隔离用例复用 admin-flow 已创建的
 * `e2e-author-*` 账号（管理员重置其口令后登录），不额外占用名额。
 */

const screenshotDir = resolve(process.cwd(), '../../docs/screenshots');
const shot = (name: string): string => resolve(screenshotDir, `m2b3b-${name}.png`);

const STAMP = Date.now().toString(36);
const AUTHOR_A_EMAIL = `m2b3b-author-a-${STAMP}@example.test`;
const AUTHOR_A_NEW_PASSWORD = `M2b3b-AuthorA-${randomUUID()}`;
/** 被复用账号（另一作者）改密后的口令，运行时确定。 */
const AUTHOR_B_NEW_PASSWORD = `M2b3b-AuthorB-${randomUUID()}`;
const WORK_TITLE = `物品事件作品-${randomUUID().slice(0, 8)}`;

const CHARACTER_A = '林青';
const CHARACTER_B = '苏沐';
const ITEM_MAIN = '青锋剑';
const ITEM_MOBILE = '玄铁盾';

/** 测试备注：只用于验证"不进 URL / storage"，不是真实秘密。 */
const NOTE_OBTAINED = '山门试炼所得（E2E 备注）';
const NOTE_TRANSFER = '暂借师姐（E2E 备注）';
const NOTE_REVERSAL = '误记消耗，冲正（E2E 备注）';

let adminPassword = '';
let workId = '';
let authorAInitialPassword = '';

let adminContext: BrowserContext;
let adminPage: Page;

test.describe.configure({ mode: 'serial' });

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

/** 首次登录 → 改密 → 进入工作台。 */
async function firstLoginAndChangePassword(
  page: Page,
  email: string,
  initialPassword: string,
  newPassword: string,
): Promise<void> {
  await login(page, email, initialPassword);
  await expect(page).toHaveURL(/\/change-password/);
  recordSecret(newPassword);
  await page.getByLabel('当前密码').fill(initialPassword);
  await page.getByLabel('新密码', { exact: true }).fill(newPassword);
  await page.getByLabel('确认新密码').fill(newPassword);
  await page.getByRole('button', { name: '提交' }).click();
  await expect(page).toHaveURL(/\/workspace/);
}

/** 作者创建一个作品，返回作品 id。 */
async function createWorkAsAuthor(page: Page, title: string): Promise<string> {
  await page.goto('/workspace');
  await expect(page).toHaveURL(/\/workspace/);
  await page.getByTestId('work-title-input').fill(title);
  await page.getByTestId('work-create-submit').click();
  await expect(page.getByTestId('work-notice')).toContainText('已创建');
  const href = await page.getByTestId('work-card').first().getAttribute('href');
  return href?.split('/').pop() ?? '';
}

/** 在某个分区里创建一条实体（可选填其它字段）。 */
async function createInSection(
  page: Page,
  key: 'character' | 'item',
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

/** 打开某件物品的事件面板。 */
async function openItemPanel(page: Page, itemName: string): Promise<void> {
  await page
    .getByTestId('item-item')
    .filter({ hasText: itemName })
    .getByTestId('item-events-open')
    .click();
  await expect(page.getByTestId('item-events-panel')).toBeVisible();
}

/** 关闭事件面板。 */
async function closeItemPanel(page: Page): Promise<void> {
  await page.getByTestId('item-events-close').click();
  await expect(page.getByTestId('item-events-panel')).toHaveCount(0);
}

type EventAction = 'obtained' | 'transferred' | 'consumed' | 'lost';

/** 在面板里追加一条事件。 */
async function appendEvent(
  page: Page,
  options: { action: EventAction; holder?: string; note?: string },
): Promise<void> {
  await page.getByTestId(`item-event-action-${options.action}`).check();
  if (options.holder !== undefined) {
    await page.getByTestId('item-event-holder').selectOption({ label: options.holder });
  }
  if (options.note !== undefined) {
    await page.getByTestId('item-event-note-input').fill(options.note);
  }
  await page.getByTestId('item-event-submit').click();
}

/** 读取当前页面的浏览器存储与地址栏，用于"备注不落地"断言。 */
async function storageSnapshot(
  page: Page,
): Promise<{ local: number; session: number; href: string; storageText: string }> {
  return page.evaluate(() => {
    const dump = (store: Storage): string =>
      Object.keys(store)
        .map((key) => `${key}=${store.getItem(key) ?? ''}`)
        .join('\n');
    return {
      local: window.localStorage.length,
      session: window.sessionStorage.length,
      href: window.location.href,
      storageText: `${dump(window.localStorage)}\n${dump(window.sessionStorage)}`,
    };
  });
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(screenshotDir, { recursive: true });
  adminPassword = readAdminPassword();

  adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  adminPage = await adminContext.newPage();
  await login(adminPage, ADMIN_EMAIL, adminPassword);
  await expect(adminPage).toHaveURL(/\/admin\/users/);

  const a = await createAuthorByAdmin(adminPage, AUTHOR_A_EMAIL);
  authorAInitialPassword = a.initialPassword;
});

test.afterAll(async () => {
  await adminContext?.close();
});

test('1. 作者创建作品、两个人物与两件物品；物品卡片显示「未登记」', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await firstLoginAndChangePassword(
    page,
    AUTHOR_A_EMAIL,
    authorAInitialPassword,
    AUTHOR_A_NEW_PASSWORD,
  );
  workId = await createWorkAsAuthor(page, WORK_TITLE);
  expect(workId).not.toBe('');

  await page.goto(`/works/${workId}/settings`);

  await createInSection(page, 'character', CHARACTER_A);
  await createInSection(page, 'character', CHARACTER_B);
  await createInSection(page, 'item', ITEM_MAIN, async () => {
    await page.getByTestId('item-new-category').selectOption('weapon');
    await page.getByTestId('item-new-quality').selectOption('mystic');
  });
  await createInSection(page, 'item', ITEM_MOBILE, async () => {
    await page.getByTestId('item-new-category').selectOption('armor');
    await page.getByTestId('item-new-quality').selectOption('earth');
  });

  // 只有 item 卡片有「持有人 / 事件」入口
  const mainCard = page.getByTestId('item-item').filter({ hasText: ITEM_MAIN });
  await expect(mainCard.getByTestId('item-events-open')).toBeVisible();
  await expect(mainCard.getByTestId('item-holder-summary')).toHaveText('未登记');
  await expect(
    page
      .getByTestId('character-item')
      .filter({ hasText: CHARACTER_A })
      .getByTestId('item-events-open'),
  ).toHaveCount(0);
  await expect(page.getByTestId('faction-item').getByTestId('item-events-open')).toHaveCount(0);

  await page.screenshot({ path: shot('item-holder-cards'), fullPage: true });

  await context.close();
});

test('2. 首次打开面板：同时请求 state/events（limit=50），显示未登记与空时间线', async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${workId}/settings`);

  // 等卡片摘要（页面级 GET /state）先完成，之后新的 /state 只可能来自面板
  const mainCard = page.getByTestId('item-item').filter({ hasText: ITEM_MAIN });
  await expect(mainCard.getByTestId('item-holder-summary')).toHaveText('未登记');

  const stateRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return request.method() === 'GET' && /\/items\/[^/]+\/state$/.test(url.pathname);
  });
  const eventsRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      request.method() === 'GET' &&
      /\/items\/[^/]+\/events$/.test(url.pathname) &&
      url.searchParams.get('limit') === '50'
    );
  });

  await openItemPanel(page, ITEM_MAIN);
  await stateRequest;
  await eventsRequest;

  await expect(page.getByTestId('item-events-item-name')).toHaveText(ITEM_MAIN);
  await expect(page.getByTestId('item-state-status')).toHaveText('未登记');
  await expect(page.getByTestId('item-state-holder')).toHaveText('暂无持有人');
  await expect(page.getByTestId('item-state-event-count')).toHaveText('0');
  await expect(page.getByTestId('item-state-effective-count')).toHaveText('0');
  await expect(page.getByTestId('item-state-last-seq')).toHaveText('0');
  await expect(page.getByTestId('item-events-empty')).toContainText('还没有任何事件记录');

  // 未登记 → 只能「登记获得」，没有转手/消耗/丢失，也没有 fromHolder 输入
  await expect(page.getByTestId('item-event-action-obtained')).toBeChecked();
  await expect(page.getByTestId('item-event-action-transferred')).toHaveCount(0);
  await expect(page.getByTestId('item-event-action-consumed')).toHaveCount(0);
  await expect(page.getByTestId('item-event-action-lost')).toHaveCount(0);
  await expect(page.getByLabel('fromHolder')).toHaveCount(0);

  // 事件类型只显示中文，不把英文 eventType 写进可见文本
  const panelText = await page.getByTestId('item-events-panel').innerText();
  for (const english of ['obtained', 'transferred', 'consumed', 'lost', 'unrecorded']) {
    expect(panelText).not.toContain(english);
  }

  await closeItemPanel(page);
  await context.close();
});

test('3. 登记获得给林青：卡片/面板显示持有中；备注不进 URL 与 storage；关闭清空草稿', async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${workId}/settings`);
  await openItemPanel(page, ITEM_MAIN);

  await appendEvent(page, { action: 'obtained', holder: CHARACTER_A, note: NOTE_OBTAINED });
  await expect(page.getByTestId('item-events-notice')).toContainText('已记录「获得」');

  await expect(page.getByTestId('item-state-status')).toHaveText('持有中');
  await expect(page.getByTestId('item-state-holder')).toHaveText(CHARACTER_A);
  await expect(page.getByTestId('item-state-event-count')).toHaveText('1');
  await expect(page.getByTestId('item-state-effective-count')).toHaveText('1');
  await expect(page.getByTestId('item-state-last-seq')).toHaveText('1');

  const row = page.getByTestId('item-event-row').first();
  await expect(row.getByTestId('item-event-seq')).toHaveText('#1');
  await expect(row.getByTestId('item-event-type')).toHaveText('获得');
  await expect(row.getByTestId('item-event-route')).toHaveText(`— → ${CHARACTER_A}`);
  await expect(row.getByTestId('item-event-note')).toContainText(NOTE_OBTAINED);
  await expect(page.getByTestId('item-event-reverse')).toHaveCount(1);

  // 备注不进入地址栏或任何 Web Storage
  const snapshot = await storageSnapshot(page);
  expect(snapshot.href).not.toContain(encodeURIComponent(NOTE_OBTAINED));
  expect(snapshot.href).not.toContain('山门试炼');
  expect(snapshot.local).toBe(0);
  expect(snapshot.session).toBe(0);
  expect(snapshot.storageText).not.toContain('山门试炼');

  // 关闭 → 重新打开：备注草稿已清空
  await closeItemPanel(page);
  await expect(
    page.getByTestId('item-item').filter({ hasText: ITEM_MAIN }).getByTestId('item-holder-summary'),
  ).toHaveText(`持有中 · ${CHARACTER_A}`);

  await openItemPanel(page, ITEM_MAIN);
  await expect(page.getByTestId('item-event-note-input')).toHaveValue('');
  await closeItemPanel(page);

  await context.close();
});

test('4. 转手 林青 → 苏沐：刷新后仍是苏沐，当前持有人不在候选里', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${workId}/settings`);
  await openItemPanel(page, ITEM_MAIN);

  // 持有中：转手 / 消耗 / 丢失；不再出现「获得」
  await expect(page.getByTestId('item-event-action-transferred')).toBeVisible();
  await expect(page.getByTestId('item-event-action-consumed')).toBeVisible();
  await expect(page.getByTestId('item-event-action-lost')).toBeVisible();
  await expect(page.getByTestId('item-event-action-obtained')).toHaveCount(0);

  // 当前持有人（林青）不能作为转手目标
  const holderOptions = await page
    .getByTestId('item-event-holder')
    .locator('option')
    .allTextContents();
  expect(holderOptions).not.toContain(CHARACTER_A);
  expect(holderOptions).toContain(CHARACTER_B);

  await appendEvent(page, { action: 'transferred', holder: CHARACTER_B, note: NOTE_TRANSFER });
  await expect(page.getByTestId('item-events-notice')).toContainText('已记录「转手」');
  await expect(page.getByTestId('item-state-holder')).toHaveText(CHARACTER_B);
  await expect(page.getByTestId('item-state-last-seq')).toHaveText('2');

  const rows = page.getByTestId('item-event-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).getByTestId('item-event-type')).toHaveText('转手');
  await expect(rows.nth(1).getByTestId('item-event-route')).toHaveText(
    `${CHARACTER_A} → ${CHARACTER_B}`,
  );

  await closeItemPanel(page);

  // 刷新后仍为苏沐（真相来自流水，不来自任何属性列）
  await page.reload();
  await expect(
    page.getByTestId('item-item').filter({ hasText: ITEM_MAIN }).getByTestId('item-holder-summary'),
  ).toHaveText(`持有中 · ${CHARACTER_B}`);

  await context.close();
});

test('5. 消耗后状态为已消耗，持有人清空，只开放「登记获得」', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${workId}/settings`);
  await openItemPanel(page, ITEM_MAIN);

  await appendEvent(page, { action: 'consumed' });
  await expect(page.getByTestId('item-events-notice')).toContainText('已记录「消耗」');
  await expect(page.getByTestId('item-state-status')).toHaveText('已消耗');
  await expect(page.getByTestId('item-state-holder')).toHaveText('暂无持有人');
  await expect(page.getByTestId('item-state-event-count')).toHaveText('3');
  await expect(page.getByTestId('item-state-effective-count')).toHaveText('3');
  await expect(page.getByTestId('item-state-last-seq')).toHaveText('3');

  const row = page.getByTestId('item-event-row').nth(2);
  await expect(row.getByTestId('item-event-type')).toHaveText('消耗');
  await expect(row.getByTestId('item-event-route')).toHaveText(`${CHARACTER_B} → —`);

  // 已消耗 → 只能登记获得
  await expect(page.getByTestId('item-event-action-obtained')).toBeChecked();
  await expect(page.getByTestId('item-event-action-transferred')).toHaveCount(0);
  await expect(page.getByTestId('item-event-submit')).toContainText('记录登记获得');

  await context.close();
});

test('6. 冲正消耗：回到持有中苏沐，历史行显示已冲正，冲正行显示「冲正 #3」', async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${workId}/settings`);
  await openItemPanel(page, ITEM_MAIN);

  // 只有最新一条可冲正
  await expect(page.getByTestId('item-event-reverse')).toHaveCount(1);
  await page.getByTestId('item-event-row').nth(2).getByTestId('item-event-reverse').click();

  // 二次确认
  await expect(page.getByTestId('item-event-reversal-form')).toBeVisible();
  await expect(page.getByTestId('item-event-reversal-form')).toContainText('确认冲正第 3 条事件');
  await page.getByTestId('item-event-reversal-note').fill(NOTE_REVERSAL);
  await page.getByTestId('item-event-reversal-confirm').click();
  await expect(page.getByTestId('item-events-notice')).toContainText('已冲正第 3 条事件');

  // 回到冲正前的状态
  await expect(page.getByTestId('item-state-status')).toHaveText('持有中');
  await expect(page.getByTestId('item-state-holder')).toHaveText(CHARACTER_B);
  await expect(page.getByTestId('item-state-event-count')).toHaveText('4');
  // 冲正行与被冲正的目标行同时从有效流剔除 → 4 - 2 = 2
  await expect(page.getByTestId('item-state-effective-count')).toHaveText('2');
  await expect(page.getByTestId('item-state-last-seq')).toHaveText('4');

  const rows = page.getByTestId('item-event-row');
  await expect(rows).toHaveCount(4);

  // 目标行：置灰 + 「已冲正」
  const target = rows.nth(2);
  await expect(target.getByTestId('item-event-reversed')).toHaveText('已冲正');
  await expect(target).toHaveAttribute('data-reversed', 'true');
  await expect(target.getByTestId('item-event-type')).toHaveText('消耗');
  await expect(target).toHaveClass(/timeline-row--reversed/);

  // 冲正行：显示「冲正 #3」，不能被当成一次普通的获得
  const reversal = rows.nth(3);
  await expect(reversal.getByTestId('item-event-type')).toHaveText('冲正 #3');
  await expect(reversal.getByTestId('item-event-type')).not.toHaveText('获得');
  await expect(reversal).toHaveClass(/timeline-row--reversal/);
  await expect(reversal.getByTestId('item-event-note')).toContainText(NOTE_REVERSAL);

  // 冲正备注同样不进入 URL / storage
  const snapshot = await storageSnapshot(page);
  expect(snapshot.href).not.toContain('误记消耗');
  expect(snapshot.local).toBe(0);
  expect(snapshot.session).toBe(0);
  expect(snapshot.storageText).not.toContain('误记消耗');

  await context.close();
});

test('7. 冲正后：冲正行与历史行都不提供冲正按钮', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${workId}/settings`);
  await openItemPanel(page, ITEM_MAIN);

  // 最新一行是冲正行 → 整个面板没有任何可冲正入口
  await expect(page.getByTestId('item-event-row')).toHaveCount(4);
  await expect(page.getByTestId('item-event-reverse')).toHaveCount(0);
  await expect(
    page.getByTestId('item-event-row').nth(3).getByTestId('item-event-reverse'),
  ).toHaveCount(0);
  await expect(
    page.getByTestId('item-event-row').nth(2).getByTestId('item-event-reverse'),
  ).toHaveCount(0);

  await context.close();
});

test('8. 删除当前持有人苏沐：409 并显示「物品 · 青锋剑」', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${workId}/settings`);

  await page
    .getByTestId('character-item')
    .filter({ hasText: CHARACTER_B })
    .getByTestId('character-delete')
    .click();

  await expect(page.getByTestId('character-error')).toContainText('该实体当前被引用，无法删除');
  await expect(page.getByTestId('character-references')).toContainText('共 1 个实体引用了它');
  await expect(page.getByTestId('character-reference-item')).toHaveText(`物品 · ${ITEM_MAIN}`);

  // 没有被删除
  await page.reload();
  await expect(page.getByTestId('character-item').filter({ hasText: CHARACTER_B })).toHaveCount(1);

  await context.close();
});

test('9. 移动端 390×844：登记获得 → 转手 → 冲正，不撑破视口，按钮 ≥ 40px', async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${workId}/settings`);

  await openItemPanel(page, ITEM_MOBILE);
  await expect(page.getByTestId('item-state-status')).toHaveText('未登记');

  await appendEvent(page, { action: 'obtained', holder: CHARACTER_A });
  await expect(page.getByTestId('item-state-holder')).toHaveText(CHARACTER_A);

  await appendEvent(page, { action: 'transferred', holder: CHARACTER_B });
  await expect(page.getByTestId('item-state-holder')).toHaveText(CHARACTER_B);
  await expect(page.getByTestId('item-state-last-seq')).toHaveText('2');

  // 冲正这次转手 → 回到林青
  await page.getByTestId('item-event-row').nth(1).getByTestId('item-event-reverse').click();
  await expect(page.getByTestId('item-event-reversal-form')).toBeVisible();
  const confirmBox = await page.getByTestId('item-event-reversal-confirm').boundingBox();
  expect(confirmBox?.height ?? 0, '冲正确认按钮高度').toBeGreaterThanOrEqual(40);
  await page.getByTestId('item-event-reversal-confirm').click();
  await expect(page.getByTestId('item-events-notice')).toContainText('已冲正第 2 条事件');
  await expect(page.getByTestId('item-state-holder')).toHaveText(CHARACTER_A);
  await expect(page.getByTestId('item-event-row').nth(2).getByTestId('item-event-type')).toHaveText(
    '冲正 #2',
  );

  // 触控目标 ≥ 40px
  for (const testId of ['item-events-close', 'item-event-submit']) {
    const control = page.getByTestId(testId);
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    expect(box?.height ?? 0, `${testId} 高度`).toBeGreaterThanOrEqual(40);
  }

  // 页面不撑破视口（含弹窗内的长文本）
  const metrics = await page.evaluate(() => ({
    docWidth: document.documentElement.scrollWidth,
    modalWidth: document.querySelector('.modal')?.scrollWidth ?? 0,
    viewport: window.innerWidth,
  }));
  expect(metrics.docWidth).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.modalWidth).toBeLessThanOrEqual(metrics.viewport + 1);

  await page.screenshot({ path: shot('mobile-item-events'), fullPage: false });

  await closeItemPanel(page);
  await context.close();
});

test('10. 转回林青后苏沐可删除；历史行只显示「已删除角色」', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${workId}/settings`);

  // 青锋剑当前仍在苏沐手里 → 先转回林青
  await openItemPanel(page, ITEM_MAIN);
  await appendEvent(page, { action: 'transferred', holder: CHARACTER_A });
  await expect(page.getByTestId('item-state-holder')).toHaveText(CHARACTER_A);
  await closeItemPanel(page);

  // 苏沐不再是任何存活物品的当前持有人 → 可删
  await page
    .getByTestId('character-item')
    .filter({ hasText: CHARACTER_B })
    .getByTestId('character-delete')
    .click();
  await expect(page.getByTestId('settings-notice')).toContainText('已删除');
  await expect(page.getByTestId('character-item').filter({ hasText: CHARACTER_B })).toHaveCount(0);

  // 历史事件仍指向苏沐，但只显示「已删除角色」，不显示姓名
  await openItemPanel(page, ITEM_MAIN);
  const rows = page.getByTestId('item-event-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(1).getByTestId('item-event-route')).toContainText('已删除角色');
  await expect(rows.nth(1).getByTestId('item-event-route')).not.toContainText(CHARACTER_B);
  await expect(page.getByTestId('item-state-holder')).toHaveText(CHARACTER_A);

  await page.screenshot({ path: shot('item-events-timeline'), fullPage: false });
  await closeItemPanel(page);

  // 卡片入口同步为林青
  await expect(
    page.getByTestId('item-item').filter({ hasText: ITEM_MAIN }).getByTestId('item-holder-summary'),
  ).toHaveText(`持有中 · ${CHARACTER_A}`);

  await context.close();
});

test('11. 另一作者看不到事件（404）；管理员 403', async ({ browser }) => {
  // 账号上限只剩 1 个名额：复用 admin-flow 建的 e2e-author 账号当"另一作者"。
  const usersResponse = await adminPage.request.get('/api/admin/users');
  expect(usersResponse.status()).toBe(200);
  const userList = (await usersResponse.json()) as {
    users: { id: string; email: string; role: string; status: string }[];
  };
  const reused =
    userList.users.find(
      (user) =>
        user.role === 'author' && user.status === 'active' && user.email.startsWith('e2e-author-'),
    ) ??
    userList.users.find(
      (user) => user.role === 'author' && user.status === 'active' && user.email !== AUTHOR_A_EMAIL,
    );
  expect(reused, '应存在一个可复用的作者账号').toBeDefined();
  const reusedEmail = reused?.email ?? '';
  const reusedId = reused?.id ?? '';
  expect(reusedEmail).not.toBe('');

  // 管理员重置口令（一次性）→ 该账号首次登录必须改密
  const resetPassword = `M2b3b-Reused-${randomUUID()}`;
  recordSecret(resetPassword);
  const resetResponse = await adminPage.request.post(
    `/api/admin/users/${reusedId}/reset-password`,
    { headers: { origin: ORIGIN }, data: { newPassword: resetPassword } },
  );
  expect(resetResponse.status()).toBe(200);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await firstLoginAndChangePassword(page, reusedEmail, resetPassword, AUTHOR_B_NEW_PASSWORD);
  // 复用账号就是 admin-flow 建的 e2e-author：改密后必须同步共享凭据文件，
  // 否则按字母序排在其后的 spec（novel-run-flow / visibility）会用旧口令登录。
  if (reusedEmail.startsWith('e2e-author-')) {
    writeAuthorCredentials(reusedEmail, AUTHOR_B_NEW_PASSWORD);
  }

  // 取物品 id（作者 A 的会话）
  const authorContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const authorPage = await authorContext.newPage();
  await login(authorPage, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  const listResponse = await authorPage.request.get(`/api/works/${workId}/entities?type=item`);
  expect(listResponse.status()).toBe(200);
  const list = (await listResponse.json()) as { entities: { id: string; name: string }[] };
  const itemId = list.entities.find((entity) => entity.name === ITEM_MAIN)?.id ?? '';
  expect(itemId).not.toBe('');
  await authorContext.close();

  for (const path of [`/items/${itemId}/events`, `/items/${itemId}/state`]) {
    const response = await page.request.get(`/api/works/${workId}${path}`);
    expect(response.status(), `另一作者访问 ${path}`).toBe(404);
  }

  // 管理员同样被拒绝（403），且不会因为作品不属于自己而泄露存在性
  for (const path of [`/items/${itemId}/events`, `/items/${itemId}/state`]) {
    const response = await adminPage.request.get(`/api/works/${workId}${path}`);
    expect(response.status(), `管理员访问 ${path}`).toBe(403);
  }

  await context.close();
});

test('12. 软删物品后事件仍可读，追加/冲正入口不可用（ITEM_EVENTS_CLOSED 提示）', async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${workId}/settings`);

  const listResponse = await page.request.get(`/api/works/${workId}/entities?type=item`);
  const list = (await listResponse.json()) as { entities: { id: string; name: string }[] };
  const itemId = list.entities.find((entity) => entity.name === ITEM_MOBILE)?.id ?? '';
  expect(itemId).not.toBe('');

  // 从界面软删除（物品没有被任何实体引用，应当允许）
  await page
    .getByTestId('item-item')
    .filter({ hasText: ITEM_MOBILE })
    .getByTestId('item-delete')
    .click();
  await expect(page.getByTestId('settings-notice')).toContainText('已删除');
  await expect(page.getByTestId('item-item').filter({ hasText: ITEM_MOBILE })).toHaveCount(0);

  // 深链直达已删除物品的事件面板
  await page.goto(`/works/${workId}/settings?item=${itemId}`);
  await expect(page.getByTestId('item-events-panel')).toBeVisible();
  await expect(page.getByTestId('item-events-item-name')).toHaveText(ITEM_MOBILE);
  await expect(page.getByTestId('item-events-closed')).toContainText('物品已删除');
  await expect(page.getByTestId('item-state-status')).toHaveText('持有中');
  await expect(page.getByTestId('item-event-row')).toHaveCount(3);
  await expect(page.getByTestId('item-event-type').nth(2)).toHaveText('冲正 #2');

  // 只读：没有追加表单，也没有冲正按钮
  await expect(page.getByTestId('item-event-form')).toHaveCount(0);
  await expect(page.getByTestId('item-event-reverse')).toHaveCount(0);
  await expect(page.getByTestId('item-event-submit')).toHaveCount(0);

  // 关闭后地址栏不再保留 item 参数（备注从来不进 URL）
  await closeItemPanel(page);
  expect(page.url()).not.toContain('item=');

  await context.close();
});

test('13. 页面与截图不含口令、邮箱、Cookie 或令牌', async ({ browser }) => {
  // 高一点的视口：文档截图能一次看到状态摘要 + 时间线 + 追加表单
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 1100 },
  });
  const page = await context.newPage();

  await login(page, AUTHOR_A_EMAIL, AUTHOR_A_NEW_PASSWORD);
  await page.goto(`/works/${workId}/settings`);
  await openItemPanel(page, ITEM_MAIN);

  const body = await page.locator('body').innerText();
  for (const secret of [
    AUTHOR_A_NEW_PASSWORD,
    authorAInitialPassword,
    adminPassword,
    AUTHOR_A_EMAIL,
    ADMIN_EMAIL,
  ]) {
    if (secret !== '') {
      expect(body).not.toContain(secret);
    }
  }
  for (const word of ['Cookie', 'cookie', 'Bearer', 'token']) {
    expect(body).not.toContain(word);
  }

  // 密码输入框不应存在于面板/页面
  await expect(page.getByLabel('密码')).toHaveCount(0);

  await page.screenshot({ path: shot('item-events-desktop'), fullPage: false });

  // 追加表单单独留一张图（面板较长，桌面截图默认只看得到时间线）
  await page.getByTestId('item-event-form').scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot('item-events-form'), fullPage: false });

  await closeItemPanel(page);
  await page.screenshot({ path: shot('settings-with-holder'), fullPage: true });

  await context.close();
});
