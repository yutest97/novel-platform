import { randomUUID } from 'node:crypto';

import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { readAuthorCredentials } from './shared-credentials.js';

/**
 * A2-C-E Reviewer 结果展示 UI 的 E2E。
 *
 * 前置：
 * - `admin-flow.spec.ts` 已创建并改密 `e2e-author`，并写入共享凭据；
 * - 有一个**真实 Worker** 连接同一数据库（`MODEL_PROVIDER=mock`）：
 *   候选仍由真实 Worker 生成，只有**审阅结果**用 request interception 提供，
 *   因此断言不依赖真实模型，也不依赖 Reviewer 的实际输出。
 *
 * 覆盖：审阅中 → 未发现结构性问题（真实轮询）、问题列表（高 / 中 / 低）、
 * `<script>` 按纯文本显示、high 不阻断采纳、REVIEW_NOT_FOUND 信息态、
 * 读取失败局部重试、快速切换候选时旧响应不覆盖、移动端不横向撑破。
 */

const WORK_TITLE = `审阅展示-${randomUUID().slice(0, 8)}`;

/** `/api/works/:id/chapters/:chapterId/candidates/:candidateId/review` */
const REVIEW_PATTERN = /\/api\/works\/[^/]+\/chapters\/[^/]+\/candidates\/[^/]+\/review$/;

const XSS_KEY = '__reviewPanelXss';

let authorEmail = '';
let authorPassword = '';
let workId = '';
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

/* -------------------------------------------------------------------------- */
/* 审阅响应桩                                                                  */
/* -------------------------------------------------------------------------- */

type Severity = 'high' | 'medium' | 'low';

interface StubIssue {
  readonly severity: Severity;
  readonly type: string;
  readonly evidence: string;
  readonly suggestion: string;
}

interface RunStub {
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly passed?: boolean | null;
  readonly errorCode?: string | null;
  readonly issues?: readonly StubIssue[];
}

interface ReviewStub {
  readonly taskStatus?: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  readonly step?: string | null;
  readonly attemptCount?: number;
  readonly taskError?: string | null;
  readonly run?: RunStub | null;
}

/** 构造审阅响应体；`candidateId` 由桩在返回前注入成**真实**候选 id。 */
function reviewBody(stub: ReviewStub): Record<string, unknown> {
  const run = stub.run === undefined ? null : stub.run;
  return {
    review: {
      candidateId: '00000000-0000-4000-8000-000000000000',
      task: {
        id: randomUUID(),
        status: stub.taskStatus ?? 'succeeded',
        currentStep: stub.step ?? null,
        attemptCount: stub.attemptCount ?? 1,
        errorCode: stub.taskError ?? null,
      },
      run:
        run === null
          ? null
          : {
              id: randomUUID(),
              status: run.status,
              passed: run.passed ?? null,
              issueCount: run.issues?.length ?? 0,
              errorCode: run.errorCode ?? null,
              agentName: 'reviewer.chapter',
              agentVersion: '1.0.0',
              startedAt: '2026-11-06T01:00:00.000Z',
              finishedAt: run.status === 'running' ? null : '2026-11-06T01:00:30.000Z',
              issues: (run.issues ?? []).map((issue, ordinal) => ({
                id: randomUUID(),
                ordinal,
                severity: issue.severity,
                type: issue.type,
                evidence: issue.evidence,
                suggestion: issue.suggestion,
              })),
            },
    },
  };
}

/** 一条回复：直接返回，或挂起等待测试释放（用于"旧请求晚返回"）。 */
type Reply =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'hold' };

const PASSED: ReviewStub = {
  taskStatus: 'succeeded',
  step: 'persist_review_result',
  run: { status: 'succeeded', passed: true, issues: [] },
};

function notFoundReply(): Reply {
  return {
    kind: 'json',
    status: 404,
    body: { error: { code: 'REVIEW_NOT_FOUND', message: '审阅结果不存在' } },
  };
}

/** 把 stub 里的占位 candidateId 替换成请求路径上的真实 id。 */
function withCandidateId(body: unknown, candidateId: string): unknown {
  if (typeof body !== 'object' || body === null) {
    return body;
  }
  const review = (body as { review?: unknown }).review;
  if (typeof review !== 'object' || review === null) {
    return body;
  }
  return { review: { ...(review as Record<string, unknown>), candidateId } };
}

interface HeldRequest {
  readonly candidateId: string;
  readonly release: (reply: Reply) => Promise<void>;
}

interface ReviewGate {
  /** 为某个候选（`*` 为通配）排队回复；按请求顺序消费，用尽后回到默认 404。 */
  plan(match: string, replies: readonly Reply[]): void;
  /** 已被挂起的请求（按到达顺序）。 */
  held(): readonly HeldRequest[];
  /** 已收到的审阅请求对应的候选 id（按到达顺序）。 */
  requests(): readonly string[];
  waitForRequests(count: number): Promise<void>;
  reset(): void;
}

async function installReviewGate(target: Page): Promise<ReviewGate> {
  const queues = new Map<string, Reply[]>();
  const heldEntries: HeldRequest[] = [];
  const seen: string[] = [];
  const waiters: { readonly count: number; readonly resolve: () => void }[] = [];

  const notify = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter !== undefined && seen.length >= waiter.count) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };

  await target.route(REVIEW_PATTERN, async (route: Route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split('/');
    const candidateId = segments[segments.indexOf('candidates') + 1] ?? '';
    seen.push(candidateId);
    notify();

    const reply = queues.get(candidateId)?.shift() ?? queues.get('*')?.shift() ?? notFoundReply();

    if (reply.kind === 'json') {
      await route.fulfill({
        status: reply.status,
        contentType: 'application/json',
        body: JSON.stringify(withCandidateId(reply.body, candidateId)),
      });
      return;
    }

    // 挂起：把决定权交给测试，等 release 后再真正 fulfill。
    let decide!: (next: Reply) => void;
    const decision = new Promise<Reply>((resolve) => {
      decide = resolve;
    });
    let done!: () => void;
    const settled = new Promise<void>((resolve) => {
      done = resolve;
    });
    heldEntries.push({
      candidateId,
      release: (next) => {
        decide(next);
        return settled;
      },
    });
    const next = await decision;
    try {
      await route.fulfill({
        status: next.kind === 'json' ? next.status : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          withCandidateId(next.kind === 'json' ? next.body : reviewBody(PASSED), candidateId),
        ),
      });
    } finally {
      done();
    }
  });

  return {
    plan: (match, replies) => {
      queues.set(match, [...replies]);
    },
    held: () => heldEntries,
    requests: () => seen,
    waitForRequests: (count) =>
      seen.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve });
          }),
    reset: () => {
      queues.clear();
      heldEntries.length = 0;
      seen.length = 0;
      waiters.length = 0;
    },
  };
}

let gate: ReviewGate;

/* -------------------------------------------------------------------------- */
/* 准备：真实作品 + 章节 + 两个候选                                             */
/* -------------------------------------------------------------------------- */

test.beforeAll(async ({ browser }) => {
  const author = readAuthorCredentials();
  authorEmail = author.email;
  authorPassword = author.password;

  context = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await context.newPage();
  await login(page, authorEmail, authorPassword);
  await expect(page).toHaveURL(/\/workspace/);

  // 先装桩：候选生成后页面会立刻请求审阅结果，桩必须已经在位。
  gate = await installReviewGate(page);

  await page.getByTestId('work-title-input').fill(WORK_TITLE);
  await page.getByTestId('work-words-input').fill('3000');
  await page.getByTestId('work-create-submit').click();
  await expect(page.getByTestId('work-notice')).toContainText('已创建');

  const card = page.getByTestId('work-card').filter({ hasText: WORK_TITLE });
  await expect(card).toHaveCount(1);
  workId = (await card.getAttribute('href'))?.split('/').pop() ?? '';
  expect(workId).not.toBe('');

  await page.goto(`/works/${workId}/chapters`);
  await page.getByTestId('chapter-create-no').fill('1');
  await page.getByTestId('chapter-create-title').fill('第一章 审阅展示');
  await page.getByTestId('chapter-create-submit').click();
  await expect(page.getByTestId('chapter-item')).toHaveCount(1);
  await page.getByTestId('chapter-open').click();
  await expect(page.getByTestId('generate-submit')).toBeVisible();

  // 两个候选来自两次真实生成（Mock Provider）；审阅结果始终由桩提供。
  for (const expected of [1, 2]) {
    await page.getByTestId('generate-submit').click();
    await expect(page.getByTestId('task-progress')).toContainText('已完成', { timeout: 90_000 });
    await expect(page.getByTestId('candidate-item')).toHaveCount(expected, { timeout: 30_000 });
  }
});

test.afterAll(async () => {
  await context?.close();
});

/** 打开第 `index` 个候选的预览（0 = 列表第一个）。 */
async function preview(index: number): Promise<void> {
  await page.getByTestId('candidate-preview').nth(index).click();
  await expect(page.getByTestId('candidate-panel')).toBeVisible();
}

test.beforeEach(() => {
  gate.reset();
});

test('1. 预览后显示"模型审阅中…"，轮询到 succeeded 后显示"未发现结构性问题"', async () => {
  // 第一次立即返回 processing；第二次（页面轮询）挂起，便于稳定断言中间态。
  gate.plan('*', [
    {
      kind: 'json',
      status: 200,
      body: reviewBody({
        taskStatus: 'processing',
        step: 'run_reviewer',
        run: { status: 'running' },
      }),
    },
    { kind: 'hold' },
  ]);

  await preview(0);
  await expect(page.getByTestId('review-status')).toHaveText('模型审阅中…');

  // 页面确实发起了第二次请求（1s 退避后的轮询）
  await expect.poll(() => gate.held().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await gate.held()[0]?.release({ kind: 'json', status: 200, body: reviewBody(PASSED) });

  await expect(page.getByTestId('review-status')).toHaveText('未发现结构性问题', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('review-issues')).toHaveCount(0);
  await expect(page.getByTestId('review-hint')).toContainText('仅供作者参考');
  // 终态后不再轮询
  const settled = gate.requests().length;
  await page.waitForTimeout(1_500);
  expect(gate.requests().length).toBe(settled);
});

test('2. 有 high / medium / low 问题时按序展示，evidence 与 suggestion 正确', async () => {
  gate.plan('*', [
    {
      kind: 'json',
      status: 200,
      body: reviewBody({
        taskStatus: 'succeeded',
        run: {
          status: 'succeeded',
          passed: false,
          issues: [
            {
              severity: 'high',
              type: 'setting_contradiction',
              evidence: '他握紧了那柄已经折断的剑。',
              suggestion: '上一章宝剑已折断，请改为别的武器。',
            },
            {
              severity: 'medium',
              type: 'timeline_conflict',
              evidence: '三日后，演武场依旧人声鼎沸。',
              suggestion: '与上一章的"翌日"冲突，请统一时间。',
            },
            {
              severity: 'low',
              type: 'prose_quality',
              evidence: '风，吹过，尘埃，落下。',
              suggestion: '断句过碎，可合并。',
            },
          ],
        },
      }),
    },
  ]);

  await preview(0);
  await expect(page.getByTestId('review-status')).toHaveText('发现 3 个问题');
  await expect(page.getByTestId('review-counts')).toHaveText('高 1 · 中 1 · 低 1');
  await expect(page.getByTestId('review-issue')).toHaveCount(3);

  expect(await page.getByTestId('review-issue-severity').allInnerTexts()).toEqual([
    '高',
    '中',
    '低',
  ]);
  expect(await page.getByTestId('review-issue-type').allInnerTexts()).toEqual([
    '设定矛盾',
    '时间线冲突',
    '文风问题',
  ]);
  await expect(page.getByTestId('review-issue-evidence').first()).toHaveText(
    '他握紧了那柄已经折断的剑。',
  );
  await expect(page.getByTestId('review-issue-suggestion').first()).toContainText(
    '上一章宝剑已折断',
  );
});

test('3. evidence 里的 <script> / HTML 按纯文本显示，不执行', async () => {
  const marker = `<script>window.${XSS_KEY} = 1;</script>`;
  const imageMarker = '<img src=x onerror="window.__reviewPanelXss = 2">';
  gate.plan('*', [
    {
      kind: 'json',
      status: 200,
      body: reviewBody({
        taskStatus: 'succeeded',
        run: {
          status: 'succeeded',
          passed: false,
          issues: [
            {
              severity: 'high',
              type: 'contract_violation',
              evidence: `${marker}${imageMarker}`,
              suggestion: `<b>请删除</b>${marker}`,
            },
          ],
        },
      }),
    },
  ]);

  await preview(0);
  const evidence = page.getByTestId('review-issue-evidence').first();
  await expect(evidence).toContainText('<script>');
  await expect(evidence).toContainText('<img src=x');
  // 仍然是文本节点：面板内没有真正的 script / img 元素
  await expect(page.locator('[data-testid="review-panel"] script')).toHaveCount(0);
  await expect(page.locator('[data-testid="review-panel"] img')).toHaveCount(0);
  const executed = await page.evaluate(
    (key) => (window as unknown as Record<string, unknown>)[key],
    XSS_KEY,
  );
  expect(executed).toBeUndefined();
});

test('4. high severity 存在时采纳按钮仍可点击（不阻断、无额外门禁）', async () => {
  gate.plan('*', [
    {
      kind: 'json',
      status: 200,
      body: reviewBody({
        taskStatus: 'succeeded',
        run: {
          status: 'succeeded',
          passed: false,
          issues: [
            {
              severity: 'high',
              type: 'setting_contradiction',
              evidence: '他握紧了那柄已经折断的剑。',
              suggestion: '请改为别的武器。',
            },
          ],
        },
      }),
    },
  ]);

  await preview(0);
  await expect(page.getByTestId('review-status')).toHaveText('发现 1 个问题');
  await expect(page.getByTestId('review-issue-severity')).toHaveText('高');

  const adopt = page.getByTestId('candidate-adopt');
  await expect(adopt).toBeEnabled();
  await adopt.click();
  // 只有普通确认弹窗，没有"审阅未通过"之类的额外阻塞
  await expect(page.getByRole('heading', { name: '采纳候选' })).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('heading', { name: '采纳候选' })).toHaveCount(0);
});

test('5. REVIEW_NOT_FOUND → "暂无审阅结果"信息态，候选仍可采纳', async () => {
  gate.plan('*', [notFoundReply()]);
  await preview(0);

  await expect(page.getByTestId('review-status')).toHaveText('暂无审阅结果');
  await expect(page.getByTestId('review-detail')).toContainText('不影响预览与采纳');
  // 信息态不是红色系统错误，也没有"重新读取"
  await expect(page.getByTestId('review-panel')).toHaveClass(/review--muted/);
  await expect(page.getByTestId('review-retry')).toHaveCount(0);
  await expect(page.getByTestId('candidate-adopt')).toBeEnabled();
  await expect(page.getByTestId('candidate-content')).not.toHaveText('');
});

test('6. 读取失败只影响审阅面板，"重新读取"可局部重试', async () => {
  gate.plan('*', [
    {
      kind: 'json',
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: '服务内部错误' } },
    },
  ]);
  await preview(0);

  await expect(page.getByTestId('review-status')).toHaveText('审阅结果读取失败');
  await expect(page.getByTestId('review-panel')).toHaveClass(/review--danger/);
  // 候选正文与采纳按钮不受影响
  await expect(page.getByTestId('candidate-content')).not.toHaveText('');
  await expect(page.getByTestId('candidate-adopt')).toBeEnabled();

  gate.plan('*', [{ kind: 'json', status: 200, body: reviewBody(PASSED) }]);
  await page.getByTestId('review-retry').click();
  await expect(page.getByTestId('review-status')).toHaveText('未发现结构性问题');
  await expect(page.getByTestId('review-retry')).toHaveCount(0);
});

test('7. 快速切换候选：旧候选晚返回不覆盖新候选的审阅结果', async () => {
  // 第一个请求挂起（旧候选）
  gate.plan('*', [{ kind: 'hold' }]);
  await preview(0);
  await expect.poll(() => gate.held().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('review-status')).toHaveText('正在读取审阅结果…');
  const firstCandidate = gate.held()[0]?.candidateId ?? '';
  expect(firstCandidate).not.toBe('');

  // 切到第二个候选：立即返回"未发现结构性问题"
  gate.plan('*', [{ kind: 'json', status: 200, body: reviewBody(PASSED) }]);
  await preview(1);
  await expect(page.getByTestId('review-status')).toHaveText('未发现结构性问题');
  expect(gate.requests()[1]).not.toBe(firstCandidate);

  // 旧候选这时才返回"发现 1 个问题"：必须完全静默
  await gate.held()[0]?.release({
    kind: 'json',
    status: 200,
    body: reviewBody({
      taskStatus: 'succeeded',
      run: {
        status: 'succeeded',
        passed: false,
        issues: [
          {
            severity: 'high',
            type: 'setting_contradiction',
            evidence: '旧候选的问题。',
            suggestion: '不应出现。',
          },
        ],
      },
    }),
  });
  await page.waitForTimeout(400);
  await expect(page.getByTestId('review-status')).toHaveText('未发现结构性问题');
  await expect(page.getByTestId('review-issue')).toHaveCount(0);
  await expect(page.getByTestId('review-counts')).toHaveCount(0);
});

test('8. 移动端 390×844：长 evidence 自然换行，问题列表不横向撑破', async () => {
  const longToken = 'X'.repeat(240);
  gate.plan('*', [
    {
      kind: 'json',
      status: 200,
      body: reviewBody({
        taskStatus: 'succeeded',
        run: {
          status: 'succeeded',
          passed: false,
          issues: [
            {
              severity: 'high',
              type: 'item_state_conflict',
              evidence: `${longToken}他握紧了那柄剑。`,
              suggestion: `${longToken}请改写。`,
            },
          ],
        },
      }),
    },
  ]);

  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await preview(0);
    await expect(page.getByTestId('review-issue')).toHaveCount(1);
    const listOverflow = await page
      .locator('[data-testid="review-issues"]')
      .evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
    expect(listOverflow.scrollWidth).toBeLessThanOrEqual(listOverflow.clientWidth + 1);

    const issueOverflow = await page
      .locator('[data-testid="review-issue"]')
      .first()
      .evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
    expect(issueOverflow.scrollWidth).toBeLessThanOrEqual(issueOverflow.clientWidth + 1);
    await expect(page.getByTestId('review-issue-evidence')).toContainText('他握紧了那柄剑。');
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

test('9. 不回归：候选正文 / 字数 / 采纳入口与审阅面板共存，且不写存储', async () => {
  gate.plan('*', [
    {
      kind: 'json',
      status: 200,
      body: reviewBody({
        taskStatus: 'succeeded',
        run: {
          status: 'succeeded',
          passed: false,
          issues: [
            {
              severity: 'low',
              type: 'prose_quality',
              evidence: '风，吹过。',
              suggestion: '可以合并短句。',
            },
          ],
        },
      }),
    },
  ]);

  await preview(0);
  await expect(page.getByTestId('review-status')).toHaveText('发现 1 个问题');
  await expect(page.getByTestId('candidate-content')).not.toHaveText('');
  await expect(page.getByTestId('candidate-word-count')).not.toHaveText('0');
  await expect(page.getByTestId('candidate-adopt')).toBeEnabled();

  const storageKeys = await page.evaluate(() => [
    ...Object.keys(window.localStorage),
    ...Object.keys(window.sessionStorage),
  ]);
  expect(storageKeys.filter((key) => key.toLowerCase().includes('review'))).toEqual([]);
});
