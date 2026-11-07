import { expect, test, type Page, type Route } from '@playwright/test';

import { readAuthorCredentials } from './shared-credentials.js';

/**
 * C1-A 动态问答页可见性与轮询生命周期 E2E。
 *
 * 这个用例覆盖真实页面的 effect 生命周期（不是纯函数单测）：
 * - 初始隐藏时不发起请求；
 * - 在途请求返回时仍隐藏，不再安排下一次 timer；
 * - 恢复可见立即补一次，并重置退避；
 * - 旧响应晚返回不能覆盖新一轮状态；
 * - 无 options 时 textarea 可提交纯文本回答；
 * - 回答 version 冲突只提示并重新拉取。
 *
 * 凭据在运行时读取（admin-flow.spec.ts 先运行并写入 `.e2e-author.json`）。
 */

const RUN_ID = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';

test.use({ ignoreHTTPSErrors: true });

type Visibility = 'visible' | 'hidden';

interface RunView {
  readonly runId: string;
  readonly status: 'queued' | 'running' | 'waiting_user' | 'completed';
  readonly version: number;
  readonly currentGoal: string;
  readonly decisionSummary: string;
  readonly question: string | null;
  readonly options: readonly string[];
  readonly stepCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function view(overrides: Partial<RunView>): RunView {
  return {
    runId: RUN_ID,
    status: 'running',
    version: 1,
    currentGoal: '理解作者的创作目标',
    decisionSummary: '',
    question: null,
    options: [],
    stepCount: 0,
    createdAt: '2026-11-07T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function login(page: Page): Promise<void> {
  const credentials = readAuthorCredentials();
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
  await expect(page.getByLabel('邮箱')).toBeFocused();
  await page.getByLabel('邮箱').fill(credentials.email);
  await page.getByLabel('密码').fill(credentials.password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByRole('heading', { name: '写作台' })).toBeVisible();
}

async function setVisibility(page: Page, state: Visibility): Promise<void> {
  await page.evaluate((next) => {
    const control = window as unknown as {
      __setVisibility: (value: string) => void;
    };
    control.__setVisibility(next);
  }, state);
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  try {
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(body),
    });
  } catch {
    // 旧请求已被页面的 AbortController 取消；忽略 fulfill 失败即可。
  }
}

test('页面隐藏时真正暂停轮询，恢复后立即刷新并忽略旧响应', async ({ page }) => {
  await login(page);

  // 登录后、进入 run 页前安装可控可见性；脚本在新文档创建时立即生效。
  await page.addInitScript(() => {
    let current: 'visible' | 'hidden' = 'hidden';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => current,
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => current === 'hidden',
    });
    Object.defineProperty(window, '__setVisibility', {
      configurable: true,
      value: (next: string) => {
        current = next === 'hidden' ? 'hidden' : 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
      },
    });
  });

  let getCount = 0;
  let answerMode: 'ok' | 'conflict' = 'ok';
  const answerBodies: { expectedVersion: number; answer: string }[] = [];
  const firstGate = deferred();

  await page.route('**/api/novel-runs/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith('/answer')) {
      const body = request.postDataJSON() as { expectedVersion: number; answer: string };
      answerBodies.push(body);
      if (answerMode === 'conflict') {
        await fulfillJson(route, 409, { error: { code: 'NOVEL_RUN_VERSION_CONFLICT' } });
        return;
      }
      await fulfillJson(
        route,
        200,
        view({
          status: 'waiting_user',
          version: body.expectedVersion + 1,
          question: '新问题',
          stepCount: 1,
        }),
      );
      return;
    }
    if (request.method() !== 'GET') {
      await fulfillJson(route, 404, { error: { code: 'NOVEL_RUN_NOT_FOUND' } });
      return;
    }

    getCount += 1;
    const sequence = getCount;
    if (sequence === 1) {
      // 在途时由测试切到 hidden，再放行；页面不应安排下一次 timer。
      await firstGate.promise;
      await fulfillJson(route, 200, view({ status: 'running', version: 1 }));
      return;
    }
    if (sequence === 2) {
      // 迟到响应：页面已因再次恢复可见而发起 sequence 3。
      await sleep(400);
      await fulfillJson(
        route,
        200,
        view({ status: 'waiting_user', version: 2, question: '旧问题', stepCount: 1 }),
      );
      return;
    }
    await fulfillJson(
      route,
      200,
      view({ status: 'waiting_user', version: 3, question: '新问题', stepCount: 1 }),
    );
  });

  await page.goto(`/novel-runs/${RUN_ID}`);
  await expect(page.getByTestId('novel-run-heading')).toBeVisible();

  // 1. 初始 hidden：不发起请求。
  await sleep(1_500);
  expect(getCount).toBe(0);

  // 2. 恢复可见：立即补一次请求。
  await setVisibility(page, 'visible');
  await expect.poll(() => getCount, { timeout: 10_000 }).toBe(1);

  // 3. 在途请求返回时页面已 hidden：不再安排下一次请求。
  await setVisibility(page, 'hidden');
  firstGate.resolve();
  await expect(page.getByTestId('novel-run-status')).toHaveText('整理中');
  await sleep(1_800);
  expect(getCount).toBe(1);

  // 4. 再次恢复可见：立即发起，且旧的在途响应不能覆盖新一轮状态。
  await setVisibility(page, 'visible');
  await expect.poll(() => getCount, { timeout: 10_000 }).toBe(2);
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await expect.poll(() => getCount, { timeout: 10_000 }).toBe(3);
  await expect(page.getByTestId('novel-run-status')).toHaveText('等待你的回答');
  await expect(page.getByTestId('novel-question')).toHaveText('新问题');
  await sleep(1_000);
  await expect(page.getByTestId('novel-question')).toHaveText('新问题');

  // 5. 无 options：仍可用 textarea 提交纯文本回答。
  await expect(page.getByTestId('novel-options')).toHaveCount(0);
  await page.getByTestId('novel-answer').fill('自由回答');
  await page.getByTestId('novel-submit').click();
  await expect.poll(() => answerBodies.length, { timeout: 10_000 }).toBe(1);
  expect(answerBodies[0]).toEqual({ expectedVersion: 3, answer: '自由回答' });

  // 6. 回答 version 冲突：只提示并重新拉取，不覆盖服务端状态。
  answerMode = 'conflict';
  const beforeConflict = getCount;
  await page.getByTestId('novel-answer').fill('另一个回答');
  await page.getByTestId('novel-submit').click();
  await expect(page.getByTestId('novel-submit-error')).toBeVisible();
  await expect.poll(() => getCount, { timeout: 10_000 }).toBeGreaterThan(beforeConflict);
});
