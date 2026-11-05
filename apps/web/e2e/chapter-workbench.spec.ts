import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PrismaClient } from '@novel/db';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';

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
 * - 运行 Playwright 的环境需要 DATABASE_URL，且必须是**宿主机**连接串
 *   （`127.0.0.1:5432/novel_e2e_<run_id>_<attempt>`）：直连用于把第 2 章置为
 *   finalized，以及种入 failed / cancelled / 已请求取消的任务行。
 *   不能用容器内主机名 `postgres`，也不能指向默认 `novel` 库。
 *
 * 覆盖：作品详情入口 → 创建章节 → Mock 生成 → 页面轮询到 succeeded →
 * 候选预览 → 采纳 → 正式版本 1 → 刷新后仍在 → finalized 无生成按钮 →
 * 后端权限断言 → 390×844 移动端 →
 * （REV-01）取消后用相同参数重新生成不复用 requestId → 目标字数默认值收敛 →
 * （REV-02）生成提示随任务状态变化：等待 → 完成 / 失败不出绿条 / 取消。
 */

const screenshotDir = resolve(process.cwd(), '../../docs/screenshots');
const shot = (name: string): string => resolve(screenshotDir, `a1_4a-${name}.png`);
/** A1-4B-B 人工编辑器截图（与 A1-4A 区分前缀）。 */
const shot4b = (name: string): string => resolve(screenshotDir, `a1_4b-${name}.png`);

/** Ctrl+S / Cmd+S（按运行平台选择修饰键）。 */
const SAVE_SHORTCUT = process.platform === 'darwin' ? 'Meta+s' : 'Control+s';

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

/**
 * 打开 Playwright 进程直连的数据库。
 *
 * 连接串由 CI 以**宿主机**形式注入（`127.0.0.1:5432/novel_e2e_<run_id>_<attempt>`）。
 * spec 内不猜测 host、不写死密码、不读容器内环境变量，只读 `DATABASE_URL`；
 * 这里只做两个低成本自检，避免把种子数据写进错误的库：
 * - 拒绝容器内主机名 `postgres`（Playwright 不在容器网络里）；
 * - 拒绝默认 `novel` 库（会污染烟测数据与账号上限）。
 */
async function openE2EDatabase(): Promise<PrismaClient> {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'E2E 直连数据库需要 DATABASE_URL（宿主机连接串：postgresql://…@127.0.0.1:5432/novel_e2e_<run_id>_<attempt>）',
    );
  }
  const url = new URL(raw);
  if (url.hostname === 'postgres') {
    throw new Error(
      'DATABASE_URL 不能使用容器内主机名 postgres：Playwright 运行在宿主机上，请改为 127.0.0.1',
    );
  }
  const database = url.pathname.replace(/^\//, '');
  if (database === '' || database === 'novel') {
    throw new Error(
      `DATABASE_URL 不能指向默认库 ${database === '' ? '(空)' : database}：E2E 必须使用独立的 novel_e2e_ 库`,
    );
  }
  const { createPrismaClient } = await import('@novel/db');
  return createPrismaClient({ connectionString: raw });
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
  // 清理本 spec 故意种入的"未终态"任务（locked_by=e2e-seed）：
  // 它们是 UI 状态的测试替身，不是真实 Worker 的在途任务，
  // 留在库里会让"测试后无 queued / processing"的门禁失真。
  if (workId !== '') {
    const db = await openE2EDatabase();
    try {
      await db.generationTask.deleteMany({
        where: { workId, lockedBy: 'e2e-seed', status: { in: ['queued', 'processing'] } },
      });
    } finally {
      await db.$disconnect();
    }
  }
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

test('3. 提交 Mock 生成：先显示等待，成功后等待提示消失', async () => {
  await expect(page.getByTestId('generate-target-words')).toHaveValue('3000');
  await page.getByTestId('generate-submit').click();

  // 提交后按钮进入生成中；页面必须自行轮询到终态（Worker 真实领取）
  await expect(page.getByTestId('generate-submit')).toBeDisabled();
  // queued/processing 才允许出现「等待 Worker」
  await expect(page.getByTestId('workbench-notice')).toContainText('等待 Worker');
  await expect(page.getByTestId('workbench-notice')).not.toContainText('生成完成');

  await expect(page.getByTestId('task-progress')).toContainText('已完成', { timeout: 90_000 });
  await expect(page.getByTestId('candidate-item')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('workbench-notice')).toContainText('生成完成，候选已保存');
  await expect(page.getByTestId('workbench-notice')).not.toContainText('等待 Worker');
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

test('6. 刷新后正式正文仍在，且不为已完成任务显示等待提示', async () => {
  await page.reload();
  await expect(page.getByTestId('version-reader')).toBeVisible();
  await expect(page.getByTestId('version-item')).toHaveCount(1);
  // 已完成任务刷新后只显示完成提示，绝不回到「等待 Worker」
  await expect(page.getByTestId('workbench-notice')).toContainText('生成完成，候选已保存');
  await expect(page.getByTestId('workbench-notice')).not.toContainText('等待 Worker');
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

  // 宿主机连接串由 CI 注入（见 ci.yml 的 Playwright 步骤 env）；spec 不自造连接串。
  const db = await openE2EDatabase();
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
  // 已完成任务在移动端同样只显示完成提示
  await expect(mobile.getByTestId('workbench-notice')).toContainText('生成完成，候选已保存');
  await expect(mobile.getByTestId('workbench-notice')).not.toContainText('等待 Worker');
  await expectNoCredentials(mobile);
  // 整页截图：顶部提示与正文阅读区同时可见，便于核验「没有等待提示」
  await mobile.screenshot({ path: shot('mobile-reading'), fullPage: true });

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
    // 取消后不得继续显示「等待 Worker」（真实接口刷新后该章无任务 → 提示整块消失）
    await expect(page.getByTestId('workbench-notice')).toHaveCount(0);
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

/* -------------------------------------------------------------------------- */
/* A1-4A-REV-02：生成提示必须与实际任务状态一致                              */
/* -------------------------------------------------------------------------- */

/**
 * 终态任务的提示：失败只留红色错误、取消显示已取消、取消请求中显示已请求取消。
 *
 * 任务行直接种库：`INSERT` 不走 `generation_tasks_status_transition`（那是 BEFORE UPDATE
 * 触发器），因此能在 Worker 正在运行的前提下把任务钉在指定终态，不依赖执行时序。
 */
test('13. 终态任务不显示等待提示：失败 / 已取消 / 已请求取消', async () => {
  // 与 finalized 种子共用同一个 helper：只读 DATABASE_URL，不自造连接串。
  const db = await openE2EDatabase();
  const { createHash } = await import('node:crypto');
  const { createChapter } = await import('@novel/workflow');

  async function seedChapter(
    authorId: string,
    chapterNo: number,
    title: string,
    task: {
      readonly status: string;
      readonly extra?: Record<string, unknown>;
    },
  ): Promise<string> {
    const chapter = await createChapter({ db, authorId, workId, chapterNo, title });
    const requestId = `e2e-${randomUUID()}`;
    const created = await db.generationTask.create({
      data: {
        workId,
        chapterId: chapter.id,
        requestId,
        inputHash: createHash('sha256').update(`${requestId}:3000`).digest('hex'),
        taskType: 'chapter.draft',
        status: task.status,
        inputSnapshot: { targetWords: 3000 },
        provider: 'mock',
        model: 'mock-model',
        attemptCount: 1,
        maxAttempts: 3,
        ...(task.extra as Record<string, never>),
      },
    });
    if (task.status === 'processing') {
      // 用**数据库时钟**固定租约与取消时间：应用侧写入的 timestamptz 在某些时区配置下
      // 会与 db 的 clock_timestamp() 有偏移，导致 Worker 的 sweep 立刻把
      // `processing + cancel_requested_at` 判成"租约过期"并取消，本用例就会不稳定。
      await db.$executeRaw`
        UPDATE generation_tasks
           SET lease_until = clock_timestamp() + interval '10 minutes',
               cancel_requested_at = clock_timestamp()
         WHERE id = ${created.id}
           AND status = 'processing'
      `;
    }
    return chapter.id;
  }

  try {
    const work = await db.work.findUniqueOrThrow({
      where: { id: workId },
      select: { authorId: true },
    });

    const failedChapterId = await seedChapter(work.authorId, 5, '第五章 失败', {
      status: 'failed',
      extra: {
        errorCode: 'TASK_MODEL_CONFIG_MISMATCH',
        errorMessageSanitized: '任务模型配置已变化，请重新提交生成任务',
      },
    });
    const cancelledChapterId = await seedChapter(work.authorId, 6, '第六章 已取消', {
      status: 'cancelled',
      extra: { cancelRequestedAt: new Date() },
    });
    const cancellingChapterId = await seedChapter(work.authorId, 7, '第七章 取消中', {
      status: 'processing',
      extra: {
        lockedBy: 'e2e-seed',
        leaseUntil: new Date(Date.now() + 60_000),
        cancelRequestedAt: new Date(),
      },
    });

    // 失败：只有 task-error，没有绿色等待提示
    await page.goto(`/works/${workId}/chapters/${failedChapterId}`);
    await expect(page.getByTestId('task-error')).toContainText('TASK_MODEL_CONFIG_MISMATCH');
    await expect(page.getByTestId('workbench-notice')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('等待 Worker');

    // 已取消
    await page.goto(`/works/${workId}/chapters/${cancelledChapterId}`);
    await expect(page.getByTestId('workbench-notice')).toHaveText('生成任务已取消');
    await expect(page.getByTestId('workbench-notice')).not.toContainText('等待 Worker');

    // processing + cancelRequestedAt：显示已请求取消，仍可等待轮询收敛
    await page.goto(`/works/${workId}/chapters/${cancellingChapterId}`);
    await expect(page.getByTestId('workbench-notice')).toHaveText('已请求取消生成');
    await expect(page.getByTestId('task-cancel')).toBeVisible();
    await expect(page.getByTestId('workbench-notice')).not.toContainText('等待 Worker');
  } finally {
    await db.$disconnect();
  }
});

/* -------------------------------------------------------------------------- */
/* A1-4B-B：Markdown 人工编辑器与 human 版本保存                               */
/* -------------------------------------------------------------------------- */

/** 生成一段满足 1200 非空白字符下限的正文。 */
function longDraft(marker: string): string {
  return `${marker}\n\n${'雨落在青瓦上，他数着更声。'.repeat(120)}`;
}

/** 断言当前页面没有进入任何浏览器存储（草稿 / 正文不得落地）。 */
async function expectNothingStored(target: Page, needle: string): Promise<void> {
  const stored = await target.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(stored).not.toContain(needle);
  expect(target.url()).not.toContain(needle);
}

test('14. 编辑版本 1 并用 Ctrl/Cmd+S 保存为人工版本 2', async () => {
  await page.goto(`/works/${workId}/chapters/${chapter1Id}`);
  await expect(page.getByTestId('version-content')).toContainText('风从演武场', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('version-source')).toHaveText('AI');

  await page.getByTestId('editor-open').click();
  const textarea = page.getByTestId('editor-textarea');
  await expect(textarea).toBeVisible();

  // pre-fill 当前最新正式正文
  const original = await textarea.inputValue();
  expect(original.length).toBeGreaterThanOrEqual(1200);
  expect(original).toContain('风从演武场');

  const edited = `${original}\n\n（人工修订）他把剑收回鞘中，转身走进雨里。${'雨声压在檐上。'.repeat(80)}`;
  await textarea.fill(edited);
  await expect(page.getByTestId('editor-dirty')).toHaveText('有未保存修改');
  await expect(page.getByTestId('editor-metrics')).toContainText('非空白字符');
  await expect(page.getByTestId('editor-metrics')).toContainText('已达可保存下限');
  await expectNoCredentials(page);
  await page.getByTestId('chapter-editor').scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot4b('editor-desktop'), fullPage: true });

  // Ctrl/Cmd+S 保存（阻止浏览器默认行为）
  await textarea.focus();
  await page.keyboard.press(SAVE_SHORTCUT);

  await expect(page.getByTestId('workbench-notice')).toContainText('已保存正式版本 2');
  await expect(page.getByTestId('chapter-editor')).toHaveCount(0);
  await expect(page.getByTestId('version-item')).toHaveCount(2);
  // 最新版本自动选中，来源显示「人工」
  await expect(page.getByTestId('version-source')).toHaveText('人工');
  await expect(page.getByTestId('version-content')).toContainText('人工修订');
  await expect(page.getByTestId('chapter-status')).toHaveText('待定稿');
  await expectNoCredentials(page);
  await page.screenshot({ path: shot4b('human-version'), fullPage: true });
});

test('15. 刷新后版本 2 仍在；版本 1 只读且正文未变', async () => {
  await page.reload();
  await expect(page.getByTestId('version-item')).toHaveCount(2);
  await expect(page.getByTestId('version-source')).toHaveText('人工');
  await expect(page.getByTestId('version-content')).toContainText('人工修订');

  // 切到版本 1：旧内容原样保留（append-only），且不提供可保存编辑器
  await page.getByTestId('version-item').nth(1).click();
  await expect(page.getByTestId('version-source')).toHaveText('AI');
  const v1 = await page.getByTestId('version-content').innerText();
  expect(v1).toContain('风从演武场');
  expect(v1).not.toContain('人工修订');
  await expect(page.getByTestId('version-readonly-hint')).toContainText('历史版本只读');
  await expect(page.getByTestId('editor-open')).toHaveCount(0);

  // 选择最新版本后可再次编辑
  await page.getByTestId('version-select-latest').click();
  await expect(page.getByTestId('editor-open')).toContainText('编辑最新版本（版本 2）');
  await expectNoCredentials(page);
});

test('16. 未保存草稿点击取消需要二次确认，且草稿不落存储', async () => {
  await page.getByTestId('editor-open').click();
  const textarea = page.getByTestId('editor-textarea');
  const original = await textarea.inputValue();
  const typed = `${original}\n未保存的修改`;
  await textarea.fill(typed);

  await page.getByTestId('editor-cancel').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('放弃未保存的修改');

  // 先不放弃：草稿仍在
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(page.getByTestId('editor-textarea')).toHaveValue(typed);

  // 再放弃：编辑器关闭
  await page.getByTestId('editor-cancel').click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃修改' }).click();
  await expect(page.getByTestId('chapter-editor')).toHaveCount(0);

  await expectNothingStored(page, '未保存的修改');
  const body = await page.locator('body').innerText();
  expect(body).not.toContain(ADMIN_EMAIL);
});

test('17. 正文过短保存失败：稳定错误文案且草稿保留', async () => {
  await page.getByTestId('editor-open').click();
  const textarea = page.getByTestId('editor-textarea');
  await textarea.fill('太短了。');
  await expect(page.getByTestId('editor-metrics')).toContainText('还需');
  await expect(page.getByTestId('editor-dirty')).toHaveText('有未保存修改');

  await page.getByTestId('editor-save').click();
  await expect(page.getByTestId('editor-error')).toHaveText('章节正文不合法，请检查字数和内容');
  // 草稿没有被清空，版本数也没变
  await expect(page.getByTestId('editor-textarea')).toHaveValue('太短了。');
  await expect(page.getByTestId('version-item')).toHaveCount(2);

  // 放弃草稿，避免影响后续用例
  await page.getByTestId('editor-cancel').click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃修改' }).click();
  await expect(page.getByTestId('chapter-editor')).toHaveCount(0);
});

test('18. 基线冲突：保留草稿，并提供「载入最新版本」', async () => {
  await page.route('**/api/works/*/chapters/*/versions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'CHAPTER_VERSION_CONFLICT', message: '章节版本发生冲突，请刷新后重试' },
      }),
    });
  });

  try {
    await page.getByTestId('editor-open').click();
    const textarea = page.getByTestId('editor-textarea');
    const original = await textarea.inputValue();
    const typed = `${original}\n冲突用例的草稿。`;
    await textarea.fill(typed);

    await page.getByTestId('editor-save').click();
    await expect(page.getByTestId('editor-error')).toHaveText(
      '正文已被其他操作更新，请重新载入最新版本',
    );
    // 草稿保留，并给出重新载入入口
    await expect(page.getByTestId('editor-textarea')).toHaveValue(typed);
    await expect(page.getByTestId('editor-reload')).toBeVisible();
    await expect(page.getByTestId('version-item')).toHaveCount(2);
  } finally {
    await page.unroute('**/api/works/*/chapters/*/versions');
  }

  // 载入最新版本：先确认「会替换草稿」，再真正载入
  await page.getByTestId('editor-reload').click();
  await page.getByRole('dialog').getByRole('button', { name: '载入最新版本' }).click();
  await expect(page.getByTestId('editor-error')).toHaveCount(0);
  await expect(page.getByTestId('editor-reload')).toHaveCount(0);
  await expect(page.getByTestId('editor-textarea')).toHaveValue(/人工修订/);
  await expect(page.getByTestId('editor-dirty')).toHaveText('无修改');

  await page.getByTestId('editor-cancel').click();
  await expect(page.getByTestId('chapter-editor')).toHaveCount(0);
});

test('19. 无正式版本时可手动创建版本 1', async () => {
  await page.goto(`/works/${workId}/chapters`);
  // 前面的用例已经建了 7 章（含种库的 5~7 章），这里按当前数量 +1 断言，避免硬编码漂移。
  // 先等列表渲染完再取数量：`count()` 不会等待，刚 goto 完可能读到 0。
  await expect(page.getByTestId('chapter-item').last()).toBeVisible();
  const before = await page.getByTestId('chapter-item').count();
  await page.getByTestId('chapter-create-no').fill('8');
  await page.getByTestId('chapter-create-title').fill('第八章 手写');
  await page.getByTestId('chapter-create-submit').click();
  await expect(page.getByTestId('chapter-item')).toHaveCount(before + 1);

  await page.getByTestId('chapter-open').last().click();
  await expect(page.getByTestId('chapter-heading')).toContainText('第 8 章');
  await expect(page.getByTestId('versions-empty')).toBeVisible();
  await expect(page.getByTestId('editor-open')).toHaveText('手动创建第一版');

  await page.getByTestId('editor-open').click();
  const textarea = page.getByTestId('editor-textarea');
  await expect(textarea).toHaveValue('');
  await textarea.fill(longDraft('（手动首版）他第一次握剑，掌心全是汗。'));
  await expect(page.getByTestId('editor-metrics')).toContainText('已达可保存下限');
  await page.getByTestId('editor-save').click();

  await expect(page.getByTestId('workbench-notice')).toContainText('已保存正式版本 1');
  await expect(page.getByTestId('version-item')).toHaveCount(1);
  await expect(page.getByTestId('version-source')).toHaveText('人工');
  await expect(page.getByTestId('version-content')).toContainText('他第一次握剑');
  await expect(page.getByTestId('chapter-status')).toHaveText('待定稿');
  await expectNoCredentials(page);
});

test('20. 390×844 移动端编辑、保存、刷新阅读，不撑破视口', async ({ browser }) => {
  const mobileContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const mobile = await mobileContext.newPage();
  await login(mobile, authorEmail, authorPassword);

  await mobile.goto(`/works/${workId}/chapters/${chapter1Id}`);
  await expect(mobile.getByTestId('version-item')).toHaveCount(2);
  await mobile.getByTestId('editor-open').click();

  const textarea = mobile.getByTestId('editor-textarea');
  const original = await textarea.inputValue();
  await textarea.fill(`${original}\n（移动端修订）${'夜风穿过廊下。'.repeat(40)}`);
  await expect(mobile.getByTestId('editor-metrics')).toContainText('非空白字符');

  const metrics = await mobile.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  await expectNoCredentials(mobile);
  await mobile.screenshot({ path: shot4b('editor-mobile'), fullPage: false });

  await mobile.getByTestId('editor-save').click();
  await expect(mobile.getByTestId('workbench-notice')).toContainText('已保存正式版本 3');
  await expect(mobile.getByTestId('version-item')).toHaveCount(3);

  // 刷新后仍能读到最新正文
  await mobile.reload();
  await expect(mobile.getByTestId('version-content')).toContainText('移动端修订');
  await expect(mobile.getByTestId('version-source')).toHaveText('人工');

  const readingMetrics = await mobile.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(readingMetrics.scrollWidth).toBeLessThanOrEqual(readingMetrics.viewportWidth + 1);

  // 截图与页面不含口令 / 邮箱 / Cookie / 令牌
  await expectNoCredentials(mobile);
  const cookies = await mobileContext.cookies();
  const body = await mobile.locator('body').innerText();
  for (const value of cookies.map((cookie) => cookie.value).filter((v) => v.length > 0)) {
    expect(body).not.toContain(value);
  }
  expect(body).not.toContain('Bearer ');
  expect(body).not.toContain(ADMIN_EMAIL);

  await mobileContext.close();
});

/* -------------------------------------------------------------------------- */
/* A1-4B-B-REV-01：应用内离开保护与冲突重载确认                                */
/* -------------------------------------------------------------------------- */

/** 等待"后退哨兵"压入历史（确保在按后退前拦截已经就绪）。 */
async function waitForHistoryGuard(target: Page): Promise<void> {
  await target.waitForFunction(
    () =>
      (window.history.state as { __novelChapterEditorGuard?: boolean } | null)
        ?.__novelChapterEditorGuard === true,
  );
}

test('21. dirty 时点击返回章节列表：取消留在编辑器，确认才离开', async () => {
  await page.goto(`/works/${workId}/chapters/${chapter1Id}`);
  await expect(page.getByTestId('editor-open')).toContainText('编辑最新版本');
  await page.getByTestId('editor-open').click();

  const textarea = page.getByTestId('editor-textarea');
  const typed = `${await textarea.inputValue()}\n返回用例的草稿。`;
  await textarea.fill(typed);
  await expect(page.getByTestId('editor-dirty')).toHaveText('有未保存修改');

  // 取消：留在章节页，正文、dirty 状态都不变
  await page.getByTestId('back-to-chapters').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('未保存的正文');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(page).toHaveURL(new RegExp(`/works/${workId}/chapters/${chapter1Id}$`));
  await expect(page.getByTestId('editor-textarea')).toHaveValue(typed);
  await expect(page.getByTestId('editor-dirty')).toHaveText('有未保存修改');

  // 确认：离开到章节列表
  await page.getByTestId('back-to-chapters').click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃并离开' }).click();
  await expect(page).toHaveURL(new RegExp(`/works/${workId}/chapters$`));
  await expect(page.getByTestId('chapter-list')).toBeVisible();
});

test('22. dirty 时浏览器后退：取消后草稿仍在', async () => {
  await page.goto(`/works/${workId}/chapters/${chapter1Id}`);
  await page.getByTestId('editor-open').click();

  const textarea = page.getByTestId('editor-textarea');
  const typed = `${await textarea.inputValue()}\n后退用例的草稿。`;
  await textarea.fill(typed);
  await expect(page.getByTestId('editor-dirty')).toHaveText('有未保存修改');
  // 拦截依赖一条哨兵历史记录，等它压入后再模拟后退
  await waitForHistoryGuard(page);

  await page.evaluate(() => window.history.back());
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('后退');
  await dialog.getByRole('button', { name: '取消' }).click();

  // 取消后仍停在本章，草稿完整保留
  expect(page.url()).toContain(`/chapters/${chapter1Id}`);
  await expect(page.getByTestId('editor-textarea')).toHaveValue(typed);
  await expect(page.getByTestId('editor-dirty')).toHaveText('有未保存修改');

  // 清理：放弃草稿
  await page.getByTestId('editor-cancel').click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃修改' }).click();
  await expect(page.getByTestId('chapter-editor')).toHaveCount(0);
  await expectNothingStored(page, '后退用例的草稿');
});

test('23. dirty 时 beforeunload 被阻止，放弃草稿后解除', async () => {
  await page.goto(`/works/${workId}/chapters/${chapter1Id}`);
  await page.getByTestId('editor-open').click();

  const textarea = page.getByTestId('editor-textarea');
  await textarea.fill(`${await textarea.inputValue()}\nbeforeunload 用例的草稿。`);
  await expect(page.getByTestId('editor-dirty')).toHaveText('有未保存修改');

  const prevented = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);

  // 放弃草稿后监听解除，刷新不再被拦
  await page.getByTestId('editor-cancel').click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃修改' }).click();
  await expect(page.getByTestId('chapter-editor')).toHaveCount(0);

  const afterDiscard = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(afterDiscard).toBe(false);
  await expectNothingStored(page, 'beforeunload 用例的草稿');
});

test('24. 冲突后载入最新版：取消保留草稿，确认替换并归零 dirty', async () => {
  await page.route('**/api/works/*/chapters/*/versions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'CHAPTER_VERSION_CONFLICT', message: '章节版本发生冲突，请刷新后重试' },
      }),
    });
  });

  let typed = '';
  try {
    await page.goto(`/works/${workId}/chapters/${chapter1Id}`);
    await page.getByTestId('editor-open').click();
    const textarea = page.getByTestId('editor-textarea');
    typed = `${await textarea.inputValue()}\n冲突重载用例的草稿。`;
    await textarea.fill(typed);

    await page.getByTestId('editor-save').click();
    await expect(page.getByTestId('editor-error')).toContainText('正文已被其他操作更新');
    await expect(page.getByTestId('editor-reload')).toBeVisible();
  } finally {
    await page.unroute('**/api/works/*/chapters/*/versions');
  }

  // 取消载入：草稿、错误与 dirty 原样保留
  await page.getByTestId('editor-reload').click();
  let dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('载入将替换当前未保存草稿');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(page.getByTestId('editor-textarea')).toHaveValue(typed);
  await expect(page.getByTestId('editor-error')).toContainText('正文已被其他操作更新');
  await expect(page.getByTestId('editor-dirty')).toHaveText('有未保存修改');

  // 确认载入：替换为最新正文，基线更新后 dirty 归零
  await page.getByTestId('editor-reload').click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '载入最新版本' }).click();
  await expect(page.getByTestId('editor-error')).toHaveCount(0);
  await expect(page.getByTestId('editor-reload')).toHaveCount(0);
  await expect(page.getByTestId('editor-textarea')).toHaveValue(/移动端修订/);
  await expect(page.getByTestId('editor-textarea')).not.toHaveValue(typed);
  await expect(page.getByTestId('editor-dirty')).toHaveText('无修改');

  await page.getByTestId('editor-cancel').click();
  await expect(page.getByTestId('chapter-editor')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* A1-4B-B-REV-02：后退哨兵生命周期                                           */
/* -------------------------------------------------------------------------- */

/** 与 `apps/web/src/lib/chapter-editor.ts` 的 `SENTINEL_STATE_KEY` 保持一致。 */
const SENTINEL_KEY = '__novelChapterEditorGuard';

/** 用独立的 context 打开一个已登录页面，避免上一个用例的历史栈 / 会话污染。 */
async function newAuthorPage(
  browser: Browser,
): Promise<{ readonly context: BrowserContext; readonly page: Page }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const freshPage = await context.newPage();
  await login(freshPage, authorEmail, authorPassword);
  return { context, page: freshPage };
}

/** 从章节列表点进第 1 章（保证历史里有真实的上一页）。 */
async function openChapterFromList(target: Page): Promise<void> {
  await target.goto(`/works/${workId}/chapters`);
  await expect(target.getByTestId('chapter-open').first()).toBeVisible();
  await target.getByTestId('chapter-open').first().click();
  await expect(target).toHaveURL(new RegExp(`/works/${workId}/chapters/${chapter1Id}$`));
  await expect(target.getByTestId('editor-open')).toBeVisible();
}

/** 等哨兵被真正释放（history.state 不再带标记），避免用 sleep 赌时序。 */
async function waitSentinelReleased(target: Page): Promise<void> {
  await target.waitForFunction(
    (key) => (window.history.state as Record<string, unknown> | null)?.[key] !== true,
    SENTINEL_KEY,
  );
}

test('25. 撤销回原文后 dirty 归零：后退一次即离开，不停在同 URL', async ({ browser }) => {
  const { context, page: fresh } = await newAuthorPage(browser);
  try {
    await openChapterFromList(fresh);
    await fresh.getByTestId('editor-open').click();
    const textarea = fresh.getByTestId('editor-textarea');
    const original = await textarea.inputValue();

    await textarea.fill(`${original}\n临时修改。`);
    await expect(fresh.getByTestId('editor-dirty')).toHaveText('有未保存修改');
    await waitForHistoryGuard(fresh);

    // 撤销回原始正文：编辑器仍打开，但 dirty 归零 → 哨兵必须被释放
    await textarea.fill(original);
    await expect(fresh.getByTestId('editor-dirty')).toHaveText('无修改');
    await waitSentinelReleased(fresh);

    // 后退一次就应回到章节列表（哨兵未释放时会停在同 URL 的章节页）
    await fresh.evaluate(() => window.history.back());
    await expect(fresh).toHaveURL(new RegExp(`/works/${workId}/chapters$`));
    await expect(fresh.getByTestId('chapter-list')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('26. 冲突后载入最新版 dirty 归零：后退一次即离开', async ({ browser }) => {
  const { context, page: fresh } = await newAuthorPage(browser);
  await fresh.route('**/api/works/*/chapters/*/versions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'CHAPTER_VERSION_CONFLICT', message: '章节版本发生冲突，请刷新后重试' },
      }),
    });
  });

  try {
    await openChapterFromList(fresh);
    await fresh.getByTestId('editor-open').click();
    const textarea = fresh.getByTestId('editor-textarea');
    await textarea.fill(`${await textarea.inputValue()}\n冲突后重载的草稿。`);
    await fresh.getByTestId('editor-save').click();
    await expect(fresh.getByTestId('editor-error')).toContainText('正文已被其他操作更新');
  } finally {
    await fresh.unroute('**/api/works/*/chapters/*/versions');
  }

  try {
    await fresh.getByTestId('editor-reload').click();
    await fresh.getByRole('dialog').getByRole('button', { name: '载入最新版本' }).click();
    await expect(fresh.getByTestId('editor-dirty')).toHaveText('无修改');
    // 编辑器仍打开：dirty 归零同样要释放哨兵
    await waitSentinelReleased(fresh);

    await fresh.evaluate(() => window.history.back());
    await expect(fresh).toHaveURL(new RegExp(`/works/${workId}/chapters$`));
    await expect(fresh.getByTestId('chapter-list')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('27. 确认返回后历史干净：再后退依次回到章节页与更早的列表页', async ({ browser }) => {
  const { context, page: fresh } = await newAuthorPage(browser);
  try {
    await openChapterFromList(fresh);
    await fresh.getByTestId('editor-open').click();
    const textarea = fresh.getByTestId('editor-textarea');
    await textarea.fill(`${await textarea.inputValue()}\n返回后历史检查。`);
    await expect(fresh.getByTestId('editor-dirty')).toHaveText('有未保存修改');
    await waitForHistoryGuard(fresh);

    // 确认离开：哨兵必须先被消费，再 push 章节列表
    await fresh.getByTestId('back-to-chapters').click();
    await fresh.getByRole('dialog').getByRole('button', { name: '放弃并离开' }).click();
    await expect(fresh).toHaveURL(new RegExp(`/works/${workId}/chapters$`));
    await expect(fresh.getByTestId('chapter-list')).toBeVisible();
    await waitSentinelReleased(fresh);

    // 后退 #1：回到刚才那一章
    await fresh.evaluate(() => window.history.back());
    await expect(fresh).toHaveURL(new RegExp(`/works/${workId}/chapters/${chapter1Id}$`));
    await expect(fresh.getByTestId('chapter-heading')).toContainText('第 1 章');

    // 后退 #2：必须回到更早的列表页；若残留哨兵，这里会停在同 URL 的章节页
    await fresh.evaluate(() => window.history.back());
    await expect(fresh).toHaveURL(new RegExp(`/works/${workId}/chapters$`));
    await expect(fresh.getByTestId('chapter-list')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('28. dirty 时退出登录：取消保持登录与草稿，确认才退出', async ({ browser }) => {
  const { context, page: fresh } = await newAuthorPage(browser);
  try {
    await openChapterFromList(fresh);
    await fresh.getByTestId('editor-open').click();
    const textarea = fresh.getByTestId('editor-textarea');
    const typed = `${await textarea.inputValue()}\n退出登录用例的草稿。`;
    await textarea.fill(typed);
    await expect(fresh.getByTestId('editor-dirty')).toHaveText('有未保存修改');

    // 取消：仍登录、停在编辑器、草稿完整
    await fresh.getByTestId('logout').click();
    const dialog = fresh.getByRole('dialog');
    await expect(dialog).toContainText('退出登录');
    await dialog.getByRole('button', { name: '取消' }).click();
    expect(fresh.url()).toContain(`/chapters/${chapter1Id}`);
    await expect(fresh.getByTestId('logout')).toBeVisible();
    await expect(fresh.getByTestId('editor-textarea')).toHaveValue(typed);
    await expect(fresh.getByTestId('editor-dirty')).toHaveText('有未保存修改');

    // 确认：退出到登录页
    await fresh.getByTestId('logout').click();
    await fresh.getByRole('dialog').getByRole('button', { name: '放弃并退出' }).click();
    await expect(fresh).toHaveURL(/\/login(\?|$)/);
  } finally {
    await context.close();
  }
});

test('29. dirty 后退并确认：到达上一页且不会迟到的第二次弹窗', async ({ browser }) => {
  const { context, page: fresh } = await newAuthorPage(browser);
  try {
    await openChapterFromList(fresh);
    await fresh.getByTestId('editor-open').click();
    const textarea = fresh.getByTestId('editor-textarea');
    await textarea.fill(`${await textarea.inputValue()}\n后退确认用例的草稿。`);
    await waitForHistoryGuard(fresh);

    await fresh.evaluate(() => window.history.back());
    const dialog = fresh.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '放弃并返回' }).click();

    // 应回到章节列表（真实上一页），而不是停在章节页
    await expect(fresh).toHaveURL(new RegExp(`/works/${workId}/chapters$`));
    await expect(fresh.getByTestId('chapter-list')).toBeVisible();

    // 给"迟到的第二次弹窗"留出观察窗口
    await fresh.waitForTimeout(500);
    await expect(fresh.getByRole('dialog')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

/* -------------------------------------------------------------------------- */
/* A1-4B-C-B：版本对比与历史版本恢复                                            */
/* -------------------------------------------------------------------------- */

/**
 * 打开章节 1（此时版本倒序：版本 3、版本 2、版本 1）。
 *
 * 前面的「离开保护」用例会为每个场景新建上下文并重新登录同一账号；
 * 服务端只保留有限个活跃会话，主上下文的 Cookie 可能已被挤掉，
 * 因此这里先清 Cookie 再登录，避免落到登录页。
 */
async function openChapterOne(): Promise<void> {
  await page.context().clearCookies();
  await login(page, authorEmail, authorPassword);
  await page.goto(`/works/${workId}/chapters/${chapter1Id}`);
  await expect(page.getByTestId('version-item')).toHaveCount(3, { timeout: 20_000 });
  await expect(page.getByTestId('version-reader').locator('h3')).toHaveText('版本 3');
}

test('30. 版本对比：默认最新与上一版，统计、行号与中文标签正确', async () => {
  await openChapterOne();
  // 折叠态不渲染面板，也不预取 diff
  await expect(page.getByTestId('compare-panel')).toHaveCount(0);

  await page.getByTestId('compare-toggle').click();
  await expect(page.getByTestId('compare-panel')).toBeVisible();
  await expect(page.getByTestId('compare-toggle')).toHaveText('收起版本对比');

  // 默认：起始=版本 2，目标=版本 3
  await expect(page.getByTestId('compare-from').locator('option:checked')).toHaveText(/版本 2/);
  await expect(page.getByTestId('compare-to').locator('option:checked')).toHaveText(/版本 3/);
  await expect(page.getByTestId('compare-result')).toBeVisible();
  await expect(page.getByTestId('compare-stats')).toHaveText(
    /新增 1 行 · 删除 0 行 · 未变化 \d+ 行/,
  );

  const added = page.locator('[data-testid="diff-line"][data-kind="added"]');
  await expect(added).toHaveCount(1);
  await expect(added).toContainText('移动端修订');
  await expect(added.locator('.diff-line__label')).toHaveText('新增');
  // 双列行号：新增行左侧占位、右侧是新版本行号
  await expect(added.locator('.diff-line__no')).toHaveText(['·', /\d+/]);

  await expect(page.locator('[data-testid="diff-line"][data-kind="removed"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="diff-line"][data-kind="equal"]').first()).toBeVisible();

  // 对比是只读操作：不改选中版本
  await expect(page.getByTestId('version-reader').locator('h3')).toHaveText('版本 3');
  await expectNoCredentials(page);
  await page.getByTestId('compare-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot4b('version-diff'), fullPage: true });
});

test('31. 切换目标版本后刷新出正确 diff（方向与统计随之变化）', async () => {
  // 目标切到版本 1：v1 → v3 是"只增不删"，反向观察时用 v3 → v1 验证 removed
  await page.getByTestId('compare-to').selectOption({ label: '版本 1（AI）' });
  await expect(page.getByTestId('compare-stats')).toHaveText(/新增 0 行 · 删除 [1-9]\d* 行/);

  const removed = page.locator('[data-testid="diff-line"][data-kind="removed"]');
  await expect(removed.first()).toBeVisible();
  await expect(removed.first().locator('.diff-line__label')).toHaveText('删除');
  const removedText = (await removed.allInnerTexts()).join('\n');
  expect(removedText).toContain('人工修订');
  await expect(page.locator('[data-testid="diff-line"][data-kind="added"]')).toHaveCount(0);

  // 起始版本也切回版本 1 → 自己比自己
  await page.getByTestId('compare-from').selectOption({ label: '版本 1（AI）' });
  await expect(page.getByTestId('compare-identical')).toHaveText('两个版本内容一致。');
  await expect(page.getByTestId('compare-stats')).toHaveText(
    /新增 0 行 · 删除 0 行 · 未变化 \d+ 行/,
  );
  await expect(page.locator('[data-testid="diff-line"][data-kind="added"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="diff-line"][data-kind="removed"]')).toHaveCount(0);
});

test('32. CHAPTER_DIFF_TOO_LARGE 用替身响应显示稳定中文错误', async () => {
  const pattern = '**/api/works/**/versions/diff*';
  await page.route(pattern, async (route) => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'CHAPTER_DIFF_TOO_LARGE', message: '章节正文规模超出对比上限' },
      }),
    });
  });

  try {
    await page.getByTestId('compare-from').selectOption({ label: '版本 2（人工）' });
    await expect(page.getByTestId('compare-error')).toHaveText('章节正文规模超出对比上限');
    await expect(page.getByTestId('compare-result')).toHaveCount(0);
    // 旧结果立刻清空，不残留上一次的 diff
    await expect(page.getByTestId('diff-line')).toHaveCount(0);
  } finally {
    await page.unroute(pattern);
  }

  // 解除替身后重新对比可恢复
  await page.getByTestId('compare-from').selectOption({ label: '版本 3（人工）' });
  await page.getByTestId('compare-to').selectOption({ label: '版本 3（人工）' });
  await expect(page.getByTestId('compare-identical')).toBeVisible();
  await expect(page.getByTestId('compare-error')).toHaveCount(0);
});

test('33. 历史版本恢复：取消不产生版本，确认后新增版本并保留历史', async () => {
  await expect(page.getByTestId('version-item')).toHaveCount(3);
  // 选中版本 1（历史）
  await page.getByTestId('version-item').nth(2).click();
  await expect(page.getByTestId('version-reader').locator('h3')).toHaveText('版本 1');
  await expect(page.getByTestId('version-restore')).toHaveText('恢复此版本为新版本');

  // 取消分支
  await page.getByTestId('version-restore').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('从版本 1 恢复');
  await expect(dialog).toContainText('创建');
  await expect(dialog).toContainText('不会被删除');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('version-item')).toHaveCount(3);
  await expect(page.getByTestId('version-reader').locator('h3')).toHaveText('版本 1');

  // 确认分支
  await page.getByTestId('version-restore').click();
  await page.getByRole('dialog').getByRole('button', { name: '确认恢复' }).click();
  await expect(page.getByTestId('workbench-notice')).toContainText('已从版本 1 恢复为版本 4');
  await expect(page.getByTestId('version-item')).toHaveCount(4);
  await expect(page.getByTestId('version-reader').locator('h3')).toHaveText('版本 4');
  await expect(page.getByTestId('version-source')).toHaveText('人工');
  // 正文来自版本 1
  await expect(page.getByTestId('version-content')).toContainText('风从演武场');
  // 对比面板随恢复关闭
  await expect(page.getByTestId('compare-panel')).toHaveCount(0);
  await expectNoCredentials(page);
});

test('34. 恢复后刷新：新版本仍在，历史版本原样保留', async () => {
  await page.reload();
  await expect(page.getByTestId('version-item')).toHaveCount(4);
  await expect(page.getByTestId('version-reader').locator('h3')).toHaveText('版本 4');
  await expect(page.getByTestId('version-content')).toContainText('风从演武场');

  // 版本 1 仍是 AI 原文
  await page.getByTestId('version-item').nth(3).click();
  await expect(page.getByTestId('version-source')).toHaveText('AI');
  await expect(page.getByTestId('version-content')).toContainText('风从演武场');
  // 版本 2 / 3 也仍在
  await expect(page.getByTestId('version-item')).toHaveCount(4);
});

test('35. 恢复冲突：保留页面状态并可用「载入最新版本」恢复', async () => {
  const pattern = '**/api/works/**/versions/*/restore';
  await page.route(pattern, async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'CHAPTER_VERSION_CONFLICT', message: '章节版本发生冲突，请刷新后重试' },
      }),
    });
  });

  try {
    await page.getByTestId('version-item').nth(2).click();
    await expect(page.getByTestId('version-reader').locator('h3')).toHaveText('版本 2');
    await page.getByTestId('version-restore').click();
    await page.getByRole('dialog').getByRole('button', { name: '确认恢复' }).click();

    await expect(page.getByTestId('restore-error')).toContainText('章节版本发生冲突');
    // 页面状态保留：仍选中版本 2，版本数不变
    await expect(page.getByTestId('version-reader').locator('h3')).toHaveText('版本 2');
    await expect(page.getByTestId('version-item')).toHaveCount(4);
    await expect(page.getByTestId('restore-reload-latest')).toBeVisible();
  } finally {
    await page.unroute(pattern);
  }

  await page.getByTestId('restore-reload-latest').click();
  await expect(page.getByTestId('restore-error')).toHaveCount(0);
  await expect(page.getByTestId('version-reader').locator('h3')).toHaveText('版本 4');
});

test('36. 390×844 移动端浏览 diff 并恢复，不撑破视口', async ({ browser }) => {
  const mobileContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const mobile = await mobileContext.newPage();
  await login(mobile, authorEmail, authorPassword);
  await mobile.goto(`/works/${workId}/chapters/${chapter1Id}`);
  await expect(mobile.getByTestId('version-item')).toHaveCount(4, { timeout: 20_000 });

  await mobile.getByTestId('compare-toggle').click();
  await expect(mobile.getByTestId('compare-panel')).toBeVisible();
  await expect(mobile.getByTestId('diff-line').first()).toBeVisible();

  const browsing = await mobile.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(browsing.scrollWidth).toBeLessThanOrEqual(browsing.viewportWidth + 1);
  await expectNoCredentials(mobile);
  await mobile.screenshot({ path: shot4b('version-diff-mobile'), fullPage: false });

  // 移动端恢复：选中版本 1 → 新版本 5
  await mobile.getByTestId('version-item').nth(3).click();
  await mobile.getByTestId('version-restore').click();
  await mobile.getByRole('dialog').getByRole('button', { name: '确认恢复' }).click();
  await expect(mobile.getByTestId('workbench-notice')).toContainText('已从版本 1 恢复为版本 5');
  await expect(mobile.getByTestId('version-item')).toHaveCount(5);

  const afterRestore = await mobile.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(afterRestore.scrollWidth).toBeLessThanOrEqual(afterRestore.viewportWidth + 1);

  const cookies = await mobileContext.cookies();
  const body = await mobile.locator('body').innerText();
  for (const value of cookies.map((cookie) => cookie.value).filter((v) => v.length > 0)) {
    expect(body).not.toContain(value);
  }
  expect(body).not.toContain('Bearer ');
  expect(body).not.toContain(ADMIN_EMAIL);
  await expectNoCredentials(mobile);

  await mobileContext.close();
});

/* -------------------------------------------------------------------------- */
/* A1-4B-C-B-REV-01：diff 请求身份隔离                                          */
/* -------------------------------------------------------------------------- */

const DIFF_PATTERN = '**/api/works/**/versions/diff*';

interface DiffStub {
  readonly status: number;
  readonly body: unknown;
}

interface DiffGateEntry {
  readonly from: string;
  readonly to: string;
  /** 用指定响应放行，并等待响应真正发出。 */
  readonly respond: (stub: DiffStub) => Promise<void>;
  /** 直接中断，并等待 handler 结束（清理用，避免 unroute 挂住）。 */
  readonly abort: () => Promise<void>;
}

type DiffGateDecision =
  { readonly kind: 'fulfill'; readonly stub: DiffStub } | { readonly kind: 'abort' };

/**
 * 精确控制 diff 请求顺序：拦截后先挂起，测试决定何时、以什么响应放行。
 *
 * 这样可以在"旧请求尚未返回"时发起新请求，验证请求身份隔离，
 * 完全不需要真实 Worker 或真实 diff 计算。
 *
 * **必须 await 本函数**：`page.route` 注册完成前，首个请求可能打到真实接口，
 * 那样 gate 永远收不到请求（entries 为空），测试会以超时形式偶发失败。
 */
async function installDiffGate(target: Page): Promise<{
  readonly entries: DiffGateEntry[];
  waitFor: (count: number) => Promise<void>;
  releaseAll: () => Promise<void>;
}> {
  const entries: DiffGateEntry[] = [];

  await target.route(DIFF_PATTERN, async (route: Route) => {
    const url = new URL(route.request().url());
    let decide!: (decision: DiffGateDecision) => void;
    const decision = new Promise<DiffGateDecision>((resolve) => {
      decide = resolve;
    });
    let markDone!: () => void;
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    let settled = false;

    const entry: DiffGateEntry = {
      from: url.searchParams.get('fromVersionId') ?? '',
      to: url.searchParams.get('toVersionId') ?? '',
      respond: (stub) => {
        if (!settled) {
          settled = true;
          decide({ kind: 'fulfill', stub });
        }
        return done;
      },
      abort: () => {
        if (!settled) {
          settled = true;
          decide({ kind: 'abort' });
        }
        return done;
      },
    };
    entries.push(entry);

    // 响应必须在 handler 内发出：decision 先由测试决定，再 await 真正的 fulfill / abort。
    const result = await decision;
    try {
      if (result.kind === 'abort') {
        await route.abort();
      } else {
        await route.fulfill({
          status: result.stub.status,
          contentType: 'application/json',
          body: JSON.stringify(result.stub.body),
        });
      }
    } finally {
      markDone();
    }
  });

  return {
    entries,
    waitFor: async (count) => {
      await expect.poll(() => entries.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(count);
    },
    releaseAll: async () => {
      // 先决定所有未处理的请求，再等它们真正结束；否则 unroute 会等挂起的 handler。
      await Promise.all(entries.map((entry) => entry.abort()));
    },
  };
}

/** 与真实契约同形的成功 diff（只用于 UI 断言，不依赖真实版本内容）。 */
function stubDiff(marker: string): DiffStub {
  return {
    status: 200,
    body: {
      diff: {
        fromVersion: { id: 'stub-from', versionNo: 2, source: 'human', wordCount: 100 },
        toVersion: { id: 'stub-to', versionNo: 3, source: 'human', wordCount: 200 },
        lines: [
          { kind: 'equal', oldLineNo: 1, newLineNo: 1, text: '相同的开头' },
          { kind: 'added', oldLineNo: null, newLineNo: 2, text: marker },
        ],
        stats: { added: 1, removed: 0, unchanged: 1 },
      },
    },
  };
}

const STUB_TOO_LARGE: DiffStub = {
  status: 400,
  body: { error: { code: 'CHAPTER_DIFF_TOO_LARGE', message: '章节正文规模超出对比上限' } },
};

/** 打开章节 1 的干净初始状态：已登录、对比折叠、无任何在途请求。 */
async function openChapterForCompare(): Promise<void> {
  await page.context().clearCookies();
  await login(page, authorEmail, authorPassword);
  await page.goto(`/works/${workId}/chapters/${chapter1Id}`);
  await expect(page.getByTestId('version-item').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('compare-panel')).toHaveCount(0);
  await expect(page.getByTestId('compare-loading')).toHaveCount(0);
}

test('37. 相同选择器：旧请求失败不覆盖新请求，也不提前关闭 loading', async () => {
  await openChapterForCompare();
  const gate = await installDiffGate(page);
  try {
    // 第一次展开 → 请求 A 挂起
    await page.getByTestId('compare-toggle').click();
    await gate.waitFor(1);
    await expect(page.getByTestId('compare-loading')).toBeVisible();

    // 收起（使 A 失效），再用完全相同的默认选择器展开 → 请求 B
    await page.getByTestId('compare-toggle').click();
    await expect(page.getByTestId('compare-panel')).toHaveCount(0);
    await page.getByTestId('compare-toggle').click();
    await gate.waitFor(2);
    expect(gate.entries[0]?.from).toBe(gate.entries[1]?.from);
    expect(gate.entries[0]?.to).toBe(gate.entries[1]?.to);
    await expect(page.getByTestId('compare-loading')).toBeVisible();

    // 旧请求 A 返回错误：必须完全静默
    await gate.entries[0]?.respond(STUB_TOO_LARGE);
    await page.waitForTimeout(300);
    await expect(page.getByTestId('compare-error')).toHaveCount(0);
    await expect(page.getByTestId('compare-result')).toHaveCount(0);
    // B 仍未完成：loading 不能被 A 的 finally 提前关闭
    await expect(page.getByTestId('compare-loading')).toBeVisible();

    // 当前请求 B 成功：只显示 B 的结果
    await gate.entries[1]?.respond(stubDiff('当前请求新增行'));
    await expect(page.getByTestId('compare-result')).toBeVisible();
    await expect(page.getByTestId('compare-stats')).toHaveText(
      '新增 1 行 · 删除 0 行 · 未变化 1 行',
    );
    await expect(page.getByTestId('diff-line')).toContainText(['相同的开头', '当前请求新增行']);
    await expect(page.getByTestId('compare-error')).toHaveCount(0);
    await expect(page.getByTestId('compare-loading')).toHaveCount(0);
  } finally {
    await gate.releaseAll();
    await page.unroute(DIFF_PATTERN);
  }
});

test('38. 旧请求成功也不得显示：当前请求失败后只显示当前错误', async () => {
  await openChapterForCompare();
  const gate = await installDiffGate(page);
  try {
    await page.getByTestId('compare-toggle').click();
    await gate.waitFor(1);
    // 请求挂起时选择器是禁用的（防重复提交）：收起后用同一默认组合再展开 → 请求 B
    await page.getByTestId('compare-toggle').click();
    await expect(page.getByTestId('compare-panel')).toHaveCount(0);
    await page.getByTestId('compare-toggle').click();
    await gate.waitFor(2);
    await expect(page.getByTestId('compare-loading')).toBeVisible();

    // 旧请求 A 成功：不得把旧 diff 画到界面上
    await gate.entries[0]?.respond(stubDiff('旧请求的过期内容'));
    await page.waitForTimeout(300);
    await expect(page.getByTestId('compare-result')).toHaveCount(0);
    await expect(page.getByTestId('diff-line')).toHaveCount(0);
    await expect(page.getByTestId('compare-loading')).toBeVisible();

    // 当前请求失败：只显示当前错误，不得同时出现旧 diff
    await gate.entries[1]?.respond(STUB_TOO_LARGE);
    await expect(page.getByTestId('compare-error')).toHaveText('章节正文规模超出对比上限');
    await expect(page.getByTestId('compare-result')).toHaveCount(0);
    await expect(page.getByTestId('diff-line')).toHaveCount(0);
    await expect(page.getByTestId('compare-loading')).toHaveCount(0);
  } finally {
    await gate.releaseAll();
    await page.unroute(DIFF_PATTERN);
  }
});

test('39. 收起对比使在途请求失效：迟到响应不能点亮结果或 loading', async () => {
  await openChapterForCompare();
  const gate = await installDiffGate(page);
  try {
    await page.getByTestId('compare-toggle').click();
    await gate.waitFor(1);

    // 挂起时收起 → 再展开
    await page.getByTestId('compare-toggle').click();
    await expect(page.getByTestId('compare-panel')).toHaveCount(0);
    await page.getByTestId('compare-toggle').click();
    await gate.waitFor(2);
    await expect(page.getByTestId('compare-loading')).toBeVisible();

    // 旧请求 A 成功返回：面板保持 B 的 loading，不出现旧结果
    await gate.entries[0]?.respond(stubDiff('收起前的旧内容'));
    await page.waitForTimeout(300);
    await expect(page.getByTestId('compare-result')).toHaveCount(0);
    await expect(page.getByTestId('compare-error')).toHaveCount(0);
    await expect(page.getByTestId('compare-loading')).toBeVisible();

    // 当前请求正常完成
    await gate.entries[1]?.respond(stubDiff('当前请求内容'));
    await expect(page.getByTestId('compare-result')).toBeVisible();
    await expect(page.getByTestId('diff-line')).toContainText(['当前请求内容']);
    await expect(page.getByTestId('compare-loading')).toHaveCount(0);
  } finally {
    await gate.releaseAll();
    await page.unroute(DIFF_PATTERN);
  }
});

test('40. 当前请求完成前 loading 持续存在，完成后才关闭', async () => {
  await openChapterForCompare();
  const gate = await installDiffGate(page);
  try {
    await page.getByTestId('compare-toggle').click();
    await gate.waitFor(1);

    // 观察窗内 loading 必须持续存在（不是一闪而过）
    await expect(page.getByTestId('compare-loading')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('compare-loading')).toBeVisible();
    await expect(page.getByTestId('compare-result')).toHaveCount(0);

    await gate.entries[0]?.respond(stubDiff('完成后才出现'));
    await expect(page.getByTestId('compare-result')).toBeVisible();
    await expect(page.getByTestId('compare-loading')).toHaveCount(0);
    await expect(page.getByTestId('diff-line')).toContainText(['完成后才出现']);
  } finally {
    await gate.releaseAll();
    await page.unroute(DIFF_PATTERN);
  }
});
