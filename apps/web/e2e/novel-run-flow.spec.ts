import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { readAuthorCredentials } from './shared-credentials.js';

/**
 * C1-A 动态问答浏览器 E2E。
 *
 * 场景：作者登录 → 写新小说 → 等待 Coordinator 提问 → 回答 → 下一问 →
 * 取消 → 重新发起并回答结束口令 → completed。
 *
 * 前置：真实 PostgreSQL + next（BASE_URL）+ 已启动 Worker（mock provider），
 * 且 admin-flow.spec.ts 已创建并改密 `e2e-author`（写入 `.e2e-author.json`）。
 * 凭据在运行时读取，不在模块加载期读取，避免全量启动时文件尚未生成。
 */

let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

/** 登录作者并进入写作台。 */
async function login(): Promise<void> {
  const credentials = readAuthorCredentials();
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
  // 登录页在 hydration 后自动聚焦邮箱；等待它可避免原生表单 GET 提交。
  await expect(page.getByLabel('邮箱')).toBeFocused();
  await page.getByLabel('邮箱').fill(credentials.email);
  await page.getByLabel('密码').fill(credentials.password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByRole('heading', { name: '写作台' })).toBeVisible();
}

/** 从工作台发起一轮问答，返回 runId。 */
async function startNovelRun(goal: string): Promise<string> {
  await page.goto('/workspace');
  await expect(page.getByRole('heading', { name: '写作台' })).toBeVisible();
  await page.getByTestId('novel-goal-input').fill(goal);
  await page.getByTestId('novel-start-submit').click();
  await expect(page).toHaveURL(/\/novel-runs\/[0-9a-f-]{36}/);
  return page.url().split('/').pop() ?? '';
}

/** 等待页面显示某个状态标签（轮询最多 30s）。 */
async function expectStatus(label: string): Promise<void> {
  await expect(page.getByTestId('novel-run-status')).toHaveText(label, { timeout: 30_000 });
}

test('作者发起问答，回答后取消，再次发起并选择结束', async () => {
  await login();

  await startNovelRun('写一个东方玄幻故事');
  await expect(page.getByTestId('novel-run-heading')).toBeVisible();
  await expectStatus('等待你的回答');
  await expect(page.getByTestId('novel-question')).not.toBeEmpty();

  const firstQuestion = (await page.getByTestId('novel-question').textContent()) ?? '';
  await page.getByTestId('novel-answer').fill('东方玄幻');
  await page.getByTestId('novel-submit').click();

  // 提交后先经历排队/整理中，再回到下一问；不能立即比较文本，
  // 否则会在状态尚未离开「等待你的回答」时读到旧问题。
  await expect
    .poll(
      async () => {
        const status =
          (await page
            .getByTestId('novel-run-status')
            .textContent()
            .catch(() => '')) ?? '';
        const question =
          (await page
            .getByTestId('novel-question')
            .textContent()
            .catch(() => '')) ?? '';
        return status === '等待你的回答' && question !== '' && question !== firstQuestion
          ? question
          : null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  const secondQuestion = (await page.getByTestId('novel-question').textContent()) ?? '';
  expect(secondQuestion).not.toBe(firstQuestion);

  await page.getByTestId('novel-cancel').click();
  await expectStatus('已取消');
  await expect(page.getByTestId('novel-terminal-card')).toContainText('已取消');

  // 重新发起：明确结束口令直接完成。
  await startNovelRun('写一个悬疑推理故事');
  await expectStatus('等待你的回答');
  await page.getByTestId('novel-answer').fill('先到这里');
  await page.getByTestId('novel-submit').click();
  await expectStatus('已结束');
  await expect(page.getByTestId('novel-terminal-card')).toContainText('已结束');

  // 回到工作台入口仍然存在。
  await page.getByTestId('back-to-workspace').click();
  await expect(page.getByTestId('novel-start-card')).toBeVisible();
});
