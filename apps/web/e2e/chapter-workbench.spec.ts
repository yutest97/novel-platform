import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import {
  ADMIN_EMAIL,
  ORIGIN,
  readAdminPassword,
  readAuthorCredentials,
} from './shared-credentials.js';

/**
 * A1-4A 章节工作台 E2E。
 *
 * 前置：
 * - admin-flow.spec.ts 已创建并改密 `e2e-author`，并写入共享凭据；
 * - 有一个**真实 Worker 进程/容器**连接同一数据库（MODEL_PROVIDER=mock）；
 * - 运行 Playwright 的环境需要 DATABASE_URL（仅用于把第 2 章置为 finalized）。
 *
 * 覆盖：作品详情入口 → 创建章节 → Mock 生成 → 页面轮询到 succeeded →
 * 候选预览 → 采纳 → 正式版本 1 → 刷新后仍在 → finalized 无生成按钮 →
 * 后端权限断言 → 390×844 移动端 →
 * （REV-01）取消后用相同参数重新生成不复用 requestId → 目标字数默认值收敛。
 */

const screenshotDir = resolve(process.cwd(), '../../docs/screenshots');
const shot = (name: string): string => resolve(screenshotDir, `a1_4a-${name}.png`);

const WORK_TITLE = `章节工作台-${randomUUID().slice(0, 8)}`;

let authorEmail = '';
let authorPassword = '';
let workId = '';
let chapter1Id = '';
let chapter2Id = '';

let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial' });

async function login(target: Page, email: string, password: string): Promise<void> {
  await target.goto('/login');
  await target.getByLabel('邮箱').fill(email);
  await target.getByLabel('密码').fill(password);
  await target.getByRole('button', { name: '登录' }).click();
  await expect(target).not.toHaveURL(/\/login(\?|$)/);
}

/** 断言页面不泄露邮箱 / 口令（截图前调用）。 */
async function expectNoCredentials(target: Page): Promise<void> {
  const text = await target.locator('body').innerText();
  expect(text).not.toContain(authorEmail);
  expect(text).not.toContain(authorPassword);
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(screenshotDir, { recursive: true });
  const author = readAuthorCredentials();
  authorEmail = author.email;
  authorPassword = author.password;

  context = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await context.newPage();
  await login(page, authorEmail, authorPassword);
  await expect(page).toHaveURL(/\/workspace/);

  await page.getByTestId('work-title-input').fill(WORK_TITLE);
  await page.getByTestId('work-words-input').fill('3000');
  await page.getByTestId('work-create-submit').click();
  await expect(page.getByTestId('work-notice')).toContainText('已创建');

  // 列表刷新是异步的：按标题定位卡片，避免拿到刷新前的第一张卡
  const card = page.getByTestId('work-card').filter({ hasText: WORK_TITLE });
  await expect(card).toHaveCount(1);
  const href = await card.getAttribute('href');
  workId = href?.split('/').pop() ?? '';
  expect(workId).not.toBe('');
});

test.afterAll(async () => {
  await context?.close();
});

test('1. 作品详情进入章节列表，空态可见', async () => {
  await page.goto(`/works/${workId}`);
  await expect(page.getByTestId('open-chapters')).toBeVisible();
  await page.getByTestId('open-chapters').click();
  await expect(page).toHaveURL(new RegExp(`/works/${workId}/chapters$`));
  await expect(page.getByTestId('chapters-empty')).toBeVisible();
  await expect(page.getByTestId('chapter-create-no')).toHaveValue('1');
  await expectNoCredentials(page);
  await page.screenshot({ path: shot('chapters-empty'), fullPage: true });
});

test('2. 创建章节并打开工作台', async () => {
  await page.getByTestId('chapter-create-no').fill('1');
  await page.getByTestId('chapter-create-title').fill('第一章 演武场');
  await page.getByTestId('chapter-create-submit').click();
  await expect(page.getByTestId('chapter-notice')).toContainText('已创建第 1 章');
  await expect(page.getByTestId('chapter-item')).toHaveCount(1);

  await page.getByTestId('chapter-open').click();
  await expect(page.getByTestId('chapter-heading')).toContainText('第 1 章 · 第一章 演武场');
  await expect(page.getByTestId('chapter-status')).toHaveText('待生成');
  await expect(page.getByTestId('generate-submit')).toBeVisible();
  chapter1Id = page.url().split('/').pop() ?? '';
  expect(chapter1Id).not.toBe('');
  await expectNoCredentials(page);
  await page.screenshot({ path: shot('workbench'), fullPage: true });
});

test('3. 提交 Mock 生成，页面轮询到 succeeded', async () => {
  await expect(page.getByTestId('generate-target-words')).toHaveValue('3000');
  await page.getByTestId('generate-submit').click();

  // 提交后按钮进入生成中；页面必须自行轮询到终态（Worker 真实领取）
  await expect(page.getByTestId('generate-submit')).toBeDisabled();
  await expect(page.getByTestId('task-progress')).toContainText('已完成', { timeout: 90_000 });
  await expect(page.getByTestId('candidate-item')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('workbench-notice')).toContainText('已提交生成任务');
  await expectNoCredentials(page);
});

test('4. 打开候选正文，展示字数与结构化计划', async () => {
  await page.getByTestId('candidate-preview').click();
  await expect(page.getByTestId('candidate-panel')).toBeVisible();
  await expect(page.getByTestId('candidate-status')).toHaveText('待采纳');

  const content = await page.getByTestId('candidate-content').innerText();
  expect(content.length).toBeGreaterThanOrEqual(1200);
  await expect(page.getByTestId('candidate-word-count')).not.toHaveText('0');

  await expect(page.getByTestId('candidate-plan')).toBeVisible();
  await page.getByTestId('candidate-plan').locator('summary').click();
  await expect(page.getByTestId('candidate-plan')).toContainText('目标');
  await expect(page.getByTestId('candidate-plan')).toContainText('演武场');

  await expectNoCredentials(page);
  await page.screenshot({ path: shot('candidate'), fullPage: true });
});

test('5. 采纳候选，自动展示正式版本 1', async () => {
  await page.getByTestId('candidate-adopt').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认采纳' }).click();

  await expect(page.getByTestId('workbench-notice')).toContainText('已生成正式版本 1');
  await expect(page.getByTestId('version-list')).toBeVisible();
  await expect(page.getByTestId('version-item')).toHaveCount(1);
  await expect(page.getByTestId('version-reader')).toBeVisible();
  const content = await page.getByTestId('version-content').innerText();
  expect(content.length).toBeGreaterThanOrEqual(1200);
  await expect(page.getByTestId('version-source')).toHaveText('AI');
  await expect(page.getByTestId('candidate-status')).toHaveText('已采纳');
  await expect(page.getByTestId('chapter-status')).toHaveText('待定稿');
  await expectNoCredentials(page);
  await page.screenshot({ path: shot('reading'), fullPage: true });
});

test('6. 刷新后正式正文仍在', async () => {
  await page.reload();
  await expect(page.getByTestId('version-reader')).toBeVisible();
  await expect(page.getByTestId('version-item')).toHaveCount(1);
  await expect(page.getByTestId('version-content')).toContainText('风从演武场', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('chapter-status')).toHaveText('待定稿');
});

test('7. finalized 章节不显示生成控件', async () => {
  await page.goto(`/works/${workId}/chapters`);
  await page.getByTestId('chapter-create-no').fill('2');
  await page.getByTestId('chapter-create-title').fill('第二章 定稿');
  await page.getByTestId('chapter-create-submit').click();
  await expect(page.getByTestId('chapter-item')).toHaveCount(2);

  const links = page.getByTestId('chapter-open');
  const href = await links.nth(1).getAttribute('href');
  chapter2Id = href?.split('/').pop() ?? '';
  expect(chapter2Id).not.toBe('');

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('finalized 用例需要 DATABASE_URL（用于把第 2 章置为 finalized）');
  }
  const { createPrismaClient } = await import('@novel/db');
  const db = createPrismaClient({ connectionString: databaseUrl });
  try {
    await db.chapter.update({ where: { id: chapter2Id }, data: { status: 'finalized' } });
  } finally {
    await db.$disconnect();
  }

  await page.goto(`/works/${workId}/chapters/${chapter2Id}`);
  await expect(page.getByTestId('chapter-status')).toHaveText('已完成');
  await expect(page.getByTestId('chapter-closed-hint')).toContainText('不能继续生成候选');
  await expect(page.getByTestId('generate-submit')).toHaveCount(0);
});

test('8. 后端权限：未登录 401、他人/不存在作品 404、管理员 403', async ({ browser }) => {
  const authorResponse = await page.request.get(`/api/works/${workId}/chapters`, {
    headers: { origin: ORIGIN },
  });
  expect(authorResponse.status()).toBe(200);

  const versionsResponse = await page.request.get(
    `/api/works/${workId}/chapters/${chapter1Id}/versions`,
    { headers: { origin: ORIGIN } },
  );
  expect(versionsResponse.status()).toBe(200);
  const versionsBody = (await versionsResponse.json()) as { versions: { id: string }[] };
  const versionId = versionsBody.versions[0]?.id ?? '';
  const versionResponse = await page.request.get(
    `/api/works/${workId}/chapters/${chapter1Id}/versions/${versionId}`,
    { headers: { origin: ORIGIN } },
  );
  expect(versionResponse.status()).toBe(200);

  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  const anonymousResponse = await anonymous.request.get(`/api/works/${workId}/chapters`);
  expect(anonymousResponse.status()).toBe(401);
  await anonymous.close();

  const missing = await page.request.get(`/api/works/${randomUUID()}/chapters`);
  expect(missing.status()).toBe(404);

  const adminPassword = readAdminPassword();
  const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const adminPage = await adminContext.newPage();
  await login(adminPage, ADMIN_EMAIL, adminPassword);
  const byAdmin = await adminPage.request.get(`/api/works/${workId}/chapters`);
  expect(byAdmin.status()).toBe(403);
  const adminVersions = await adminPage.request.get(
    `/api/works/${workId}/chapters/${chapter1Id}/versions`,
  );
  expect(adminVersions.status()).toBe(403);
  const adminVersion = await adminPage.request.get(
    `/api/works/${workId}/chapters/${chapter1Id}/versions/${versionId}`,
  );
  expect(adminVersion.status()).toBe(403);
  await adminContext.close();
});

test('9. 390×844 移动端：创建章节、生成、候选预览与正式阅读', async ({ browser }) => {
  const mobileContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const mobile = await mobileContext.newPage();
  await login(mobile, authorEmail, authorPassword);

  await mobile.goto(`/works/${workId}/chapters`);
  await expect(mobile.getByTestId('chapter-list')).toBeVisible();
  await expectNoCredentials(mobile);
  await mobile.screenshot({ path: shot('mobile-chapters'), fullPage: false });

  await mobile.getByTestId('chapter-create-no').fill('3');
  await mobile.getByTestId('chapter-create-title').fill('第三章 雨夜');
  await mobile.getByTestId('chapter-create-submit').click();
  await expect(mobile.getByTestId('chapter-item')).toHaveCount(3);

  const links = mobile.getByTestId('chapter-open');
  await links.nth(2).click();
  await expect(mobile.getByTestId('chapter-heading')).toContainText('第 3 章 · 第三章 雨夜');

  const metrics = await mobile.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  await mobile.screenshot({ path: shot('mobile-workbench'), fullPage: false });

  await mobile.getByTestId('generate-submit').click();
  await expect(mobile.getByTestId('task-progress')).toContainText('已完成', { timeout: 90_000 });
  await mobile.getByTestId('candidate-preview').click();
  await expect(mobile.getByTestId('candidate-panel')).toBeVisible();
  await expect(mobile.getByTestId('candidate-content')).toBeVisible();
  await mobile.getByTestId('candidate-panel').scrollIntoViewIfNeeded();
  await mobile.screenshot({ path: shot('mobile-candidate'), fullPage: false });

  // 正式阅读：回到第 1 章（已有版本 1）
  await mobile.goto(`/works/${workId}/chapters/${chapter1Id}`);
  await expect(mobile.getByTestId('version-content')).toContainText('风从演武场', {
    timeout: 20_000,
  });
  await mobile.getByTestId('version-reader').scrollIntoViewIfNeeded();
  await expectNoCredentials(mobile);
  await mobile.screenshot({ path: shot('mobile-reading'), fullPage: false });

  const readingMetrics = await mobile.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(readingMetrics.scrollWidth).toBeLessThanOrEqual(readingMetrics.viewportWidth + 1);

  await mobileContext.close();
});

test('10. 截图与页面不出现口令、邮箱、Cookie 或令牌', async () => {
  await page.goto(`/works/${workId}/chapters/${chapter1Id}`);
  await expect(page.getByTestId('version-content')).toBeVisible();
  await expectNoCredentials(page);

  const cookies = await context.cookies();
  const cookieValues = cookies.map((cookie) => cookie.value).filter((value) => value.length > 0);
  const body = await page.locator('body').innerText();
  for (const value of cookieValues) {
    expect(body).not.toContain(value);
  }
  expect(body).not.toContain('Bearer ');
});

/* -------------------------------------------------------------------------- */
/* A1-4A-REV-01：取消后重新生成                                              */
/* -------------------------------------------------------------------------- */

interface StubTask {
  readonly id: string;
  readonly chapterId: string;
  readonly status: string;
  readonly currentStep: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly cancelRequestedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function stubTask(id: string, overrides: Partial<StubTask> = {}): StubTask {
  const now = new Date().toISOString();
  return {
    id,
    chapterId: '',
    status: 'queued',
    currentStep: null,
    attemptCount: 1,
    maxAttempts: 3,
    cancelRequestedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * 取消后重新生成：用测试替身把任务钉在 queued/processing，避免 Mock Worker 太快。
 *
 * 断言的是幂等不变量：相同表单参数在取消后必须换新的 requestId，
 * 否则服务端会按 `(work_id, request_id)` 命中旧任务，页面永远看到旧的 cancelled。
 */
test('11. 取消生成后用相同参数重新生成：不复用 requestId，显示新任务', async () => {
  const staleTaskId = randomUUID();
  const freshTaskId = randomUUID();
  const generateBodies: { requestId?: string; targetWords?: number }[] = [];
  const polledTaskIds: string[] = [];
  let generateCount = 0;

  await page.goto(`/works/${workId}/chapters`);
  await page.getByTestId('chapter-create-no').fill('4');
  await page.getByTestId('chapter-create-title').fill('第四章 取消重试');
  await page.getByTestId('chapter-create-submit').click();
  await expect(page.getByTestId('chapter-item')).toHaveCount(4);
  await page.getByTestId('chapter-open').last().click();
  await expect(page.getByTestId('chapter-heading')).toContainText('第 4 章');

  await page.route('**/api/works/*/chapters/*/generate', async (route) => {
    generateCount += 1;
    generateBodies.push(route.request().postDataJSON() as { requestId?: string });
    const taskId = generateCount === 1 ? staleTaskId : freshTaskId;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ task: stubTask(taskId) }),
    });
  });

  await page.route('**/api/works/*/generation-tasks/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/cancel')) {
      // 最坏情况：取消接口仍返回 processing + cancelRequestedAt（不是终态）
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          task: stubTask(staleTaskId, {
            status: 'processing',
            currentStep: 'write_draft',
            cancelRequestedAt: new Date().toISOString(),
          }),
        }),
      });
      return;
    }
    const taskId = path.split('/').pop() ?? '';
    polledTaskIds.push(taskId);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task: stubTask(taskId, { status: 'processing', currentStep: 'write_draft' }),
      }),
    });
  });

  try {
    // 第一次生成
    await page.getByTestId('generate-submit').click();
    await expect(page.getByTestId('task-cancel')).toBeVisible();
    await expect(page.getByTestId('task-progress')).toContainText('排队中');
    expect(generateBodies).toHaveLength(1);

    // 取消：即使返回 processing + cancelRequestedAt，幂等键也必须作废
    await page.getByTestId('task-cancel').click();
    await expect(page.getByTestId('task-progress')).toHaveText('尚未提交生成任务');
    // 取消前的轮询是旧任务，清理后再验证新一轮只跟踪新任务
    polledTaskIds.length = 0;

    // 用完全相同的参数重新生成
    await page.getByTestId('generate-submit').click();
    await expect(page.getByTestId('task-progress')).toContainText('正在写正文', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('task-progress')).not.toContainText('已取消');
    await expect(page.getByTestId('generate-submit')).toBeDisabled();

    expect(generateBodies).toHaveLength(2);
    const [first, second] = generateBodies;
    expect(first?.requestId).toBeTruthy();
    expect(second?.requestId).toBeTruthy();
    expect(second?.requestId).not.toBe(first?.requestId);
    expect(second?.targetWords).toBe(first?.targetWords);

    // 轮询只跟踪新任务
    expect(polledTaskIds).toContain(freshTaskId);
    expect(polledTaskIds).not.toContain(staleTaskId);

    // requestId 不出现在 URL / localStorage / sessionStorage
    const currentRequestId = second?.requestId ?? '';
    expect(page.url()).not.toContain(currentRequestId);
    const stored = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    expect(stored).not.toContain(currentRequestId);
    await expectNoCredentials(page);
  } finally {
    await page.unroute('**/api/works/*/chapters/*/generate');
    await page.unroute('**/api/works/*/generation-tasks/**');
  }
});

test('12. 作品目标字数越界时，生成表单默认值收敛到合法区间', async () => {
  await page.goto('/workspace');
  const title = `目标字数-${randomUUID().slice(0, 8)}`;
  await page.getByTestId('work-title-input').fill(title);
  await page.getByTestId('work-words-input').fill('1200');
  await page.getByTestId('work-create-submit').click();
  await expect(page.getByTestId('work-notice')).toContainText('已创建');

  const card = page.getByTestId('work-card').filter({ hasText: title });
  await expect(card).toHaveCount(1);
  const href = await card.getAttribute('href');
  const clampedWorkId = href?.split('/').pop() ?? '';
  expect(clampedWorkId).not.toBe('');

  await page.goto(`/works/${clampedWorkId}/chapters`);
  await page.getByTestId('chapter-create-no').fill('1');
  await page.getByTestId('chapter-create-title').fill('第一章 目标字数');
  await page.getByTestId('chapter-create-submit').click();
  await page.getByTestId('chapter-open').first().click();

  // 页面展示作品原始目标，生成表单用收敛后的合法默认值
  await expect(page.getByTestId('chapter-target-words')).toHaveText('1200');
  await expect(page.getByTestId('generate-target-words')).toHaveValue('2500');
});
