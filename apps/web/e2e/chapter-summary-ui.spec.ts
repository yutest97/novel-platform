import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@novel/db';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { readAuthorCredentials } from './shared-credentials.js';

/**
 * A2-D-E 版本摘要展示 UI 的 E2E。
 *
 * 前置：
 * - `admin-flow.spec.ts` 已创建并改密 `e2e-author`，并写入共享凭据；
 * - 需要**宿主机** `DATABASE_URL`（`127.0.0.1:5432/novel_e2e_*`）直连种入 3 个正式版本；
 * - 摘要响应全部由 `page.route` 提供，不依赖真实模型。
 *
 * 覆盖：默认展示最新版摘要、历史版本各自的摘要、`SUMMARY_NOT_FOUND` 信息态、
 * 读取失败局部重试、快速切换时旧响应不覆盖、`<script>` 按纯文本显示、
 * 编辑器草稿不被摘要失败影响、移动端不横向撑破、diff 不回归。
 */

const WORK_TITLE = `摘要展示-${randomUUID().slice(0, 8)}`;

/** `/api/works/:id/chapters/:chapterId/versions/:versionId/summary` */
const SUMMARY_PATTERN = /\/api\/works\/[^/]+\/chapters\/[^/]+\/versions\/[^/]+\/summary$/;

const XSS_KEY = '__summaryCardXss';

/** 正文：长度与字数都必须 ≥ 1200（数据库 CHECK）。 */
const VERSION_BODY = `风从演武场尽头吹来，吹动了青石上的尘埃。${'他握紧了手中的剑。'.repeat(160)}`;

let authorEmail = '';
let authorPassword = '';
let workId = '';
let chapterId = '';
let context: BrowserContext;
let page: Page;
let db: PrismaClient | null = null;

/** 三个版本：v1 / v2 / v3（v3 为最新）。 */
const versionIds: string[] = [];

test.describe.configure({ mode: 'serial' });

async function login(target: Page, email: string, password: string): Promise<void> {
  await target.goto('/login');
  await target.getByLabel('邮箱').fill(email);
  await target.getByLabel('密码').fill(password);
  await target.getByRole('button', { name: '登录' }).click();
  await expect(target).not.toHaveURL(/\/login(\?|$)/);
}

async function openE2EDatabase(): Promise<PrismaClient> {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined || raw.trim() === '') {
    throw new Error('E2E 直连数据库需要 DATABASE_URL（宿主机 127.0.0.1 连接串）');
  }
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, '');
  if (url.hostname === 'postgres' || database === '' || database === 'novel') {
    throw new Error('DATABASE_URL 必须指向独立的 novel_e2e_ 库，且不能使用容器内主机名');
  }
  const { createPrismaClient } = await import('@novel/db');
  return createPrismaClient({ connectionString: raw });
}

/* -------------------------------------------------------------------------- */
/* 摘要响应桩                                                                  */
/* -------------------------------------------------------------------------- */

interface SummaryStub {
  readonly id?: string;
  readonly versionNo?: number;
  readonly summary?: string;
  readonly agentName?: string;
  readonly agentVersion?: string;
  readonly createdAt?: string;
}

function summaryBody(versionId: string, stub: SummaryStub): unknown {
  return {
    summary: {
      id: stub.id ?? randomUUID(),
      chapterId,
      sourceVersionId: versionId,
      versionNo: stub.versionNo ?? 1,
      summary: stub.summary ?? '默认摘要。',
      agentName: stub.agentName ?? 'summarizer.chapter',
      agentVersion: stub.agentVersion ?? '1.0.0',
      createdAt: stub.createdAt ?? '2026-11-06T03:00:00.000Z',
    },
  };
}

type Reply =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'hold' };

function notFound(): Reply {
  return {
    kind: 'json',
    status: 404,
    body: { error: { code: 'SUMMARY_NOT_FOUND', message: '章节摘要不存在' } },
  };
}

interface HeldRequest {
  readonly versionId: string;
  readonly release: (reply: Reply) => Promise<void>;
}

interface SummaryGate {
  /** 为某个版本排队回复；按请求顺序消费。 */
  plan(versionId: string, replies: readonly Reply[]): void;
  held(): readonly HeldRequest[];
  requests(): readonly string[];
  waitForRequests(count: number): Promise<void>;
  /** 恢复到默认：每个版本返回自己的固定摘要文本。 */
  reset(): void;
}

const DEFAULT_TEXTS = new Map<string, string>();

async function installSummaryGate(target: Page): Promise<SummaryGate> {
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

  await target.route(SUMMARY_PATTERN, async (route: Route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split('/');
    const versionId = segments[segments.indexOf('versions') + 1] ?? '';
    seen.push(versionId);
    notify();

    const reply =
      queues.get(versionId)?.shift() ??
      ({
        kind: 'json',
        status: 200,
        body: summaryBody(versionId, {
          versionNo: versionIds.indexOf(versionId) + 1,
          summary: DEFAULT_TEXTS.get(versionId) ?? '默认摘要。',
        }),
      } satisfies Reply);

    if (reply.kind === 'json') {
      await route.fulfill({
        status: reply.status,
        contentType: 'application/json',
        body: JSON.stringify(reply.body),
      });
      return;
    }

    let decide!: (next: Reply) => void;
    const decision = new Promise<Reply>((resolve) => {
      decide = resolve;
    });
    let done!: () => void;
    const settled = new Promise<void>((resolve) => {
      done = resolve;
    });
    heldEntries.push({
      versionId,
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
        body: JSON.stringify(next.kind === 'json' ? next.body : summaryBody(versionId, {})),
      });
    } finally {
      done();
    }
  });

  return {
    plan: (versionId, replies) => {
      queues.set(versionId, [...replies]);
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

let gate: SummaryGate;

/* -------------------------------------------------------------------------- */
/* 准备：真实作品 + 章节 + 3 个正式版本（摘要全部走桩）                          */
/* -------------------------------------------------------------------------- */

test.beforeAll(async ({ browser }) => {
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

  const card = page.getByTestId('work-card').filter({ hasText: WORK_TITLE });
  await expect(card).toHaveCount(1);
  workId = (await card.getAttribute('href'))?.split('/').pop() ?? '';
  expect(workId).not.toBe('');

  await page.goto(`/works/${workId}/chapters`);
  await page.getByTestId('chapter-create-no').fill('1');
  await page.getByTestId('chapter-create-title').fill('第一章 摘要展示');
  await page.getByTestId('chapter-create-submit').click();
  await expect(page.getByTestId('chapter-item')).toHaveCount(1);
  await page.getByTestId('chapter-open').click();
  // 点击后是客户端路由：必须等 URL 真的变成章节详情，否则会读到 .../chapters
  await page.waitForURL(/\/chapters\/[0-9a-f-]{36}$/);
  chapterId = page.url().split('/').pop() ?? '';
  expect(chapterId).toMatch(/^[0-9a-f-]{36}$/);

  // 直接种入 3 个正式版本（正文与字数都满足数据库 CHECK），摘要不落库：
  // 全部由 request interception 提供，保证断言与真实模型无关。
  db = await openE2EDatabase();
  const authorRow = await db.user.findFirstOrThrow({
    where: { email: authorEmail },
    select: { id: true },
  });
  const wordCount = Array.from(VERSION_BODY.replace(/\s/gu, '')).length;
  for (const versionNo of [1, 2, 3]) {
    const version = await db.chapterVersion.create({
      data: {
        workId,
        chapterId,
        versionNo,
        content: `${VERSION_BODY}<!-- v${String(versionNo)} -->`,
        wordCount: wordCount + 3,
        source: 'human',
        createdBy: authorRow.id,
      },
      select: { id: true },
    });
    versionIds.push(version.id);
    DEFAULT_TEXTS.set(
      version.id,
      versionNo === 1
        ? '第一版摘要：主角入门。'
        : versionNo === 2
          ? '第二版摘要：初次比试。'
          : '第三版摘要：雨夜守山门。',
    );
  }

  gate = await installSummaryGate(page);
});

test.afterAll(async () => {
  await db?.$disconnect();
  await context?.close();
});

/** 重新打开章节页：默认选中最新版本（v3）。 */
async function openChapter(): Promise<void> {
  await page.goto(`/works/${workId}/chapters/${chapterId}`);
  await expect(page.getByTestId('version-item')).toHaveCount(3);
  await expect(page.getByTestId('version-summary')).toBeVisible();
}

/** 选择第 `index` 个版本项（0 = 最新 v3，2 = 最早 v1）。 */
async function selectVersion(index: number): Promise<void> {
  await page.getByTestId('version-item').nth(index).click();
  await expect(page.getByTestId('version-item').nth(index)).toHaveClass(/version-item--active/);
}

test.beforeEach(() => {
  gate.reset();
});

test('1. 打开章节后展示最新版本的摘要与元信息', async () => {
  await openChapter();

  await expect(page.getByTestId('version-summary-title')).toHaveText('版本摘要');
  await expect(page.getByTestId('version-summary-text')).toHaveText('第三版摘要：雨夜守山门。');
  await expect(page.getByTestId('version-summary-meta')).toContainText('版本 v3');
  await expect(page.getByTestId('version-summary-meta')).toContainText('生成于');
  await expect(page.getByTestId('version-summary')).toHaveClass(/summary-card--ok/);
});

test('2. 历史版本显示自己的摘要，不被最新版覆盖', async () => {
  await openChapter();

  await selectVersion(1);
  await expect(page.getByTestId('version-summary-text')).toHaveText('第二版摘要：初次比试。');
  await expect(page.getByTestId('version-summary-meta')).toContainText('版本 v2');

  await selectVersion(2);
  await expect(page.getByTestId('version-summary-text')).toHaveText('第一版摘要：主角入门。');
  await expect(page.getByTestId('version-summary-meta')).toContainText('版本 v1');
  await expect(page.getByTestId('version-summary-text')).not.toContainText('第三版摘要');

  // 切回最新版仍是它自己的摘要
  await selectVersion(0);
  await expect(page.getByTestId('version-summary-text')).toHaveText('第三版摘要：雨夜守山门。');
});

test('3. SUMMARY_NOT_FOUND → "该版本暂无摘要"信息态，正文仍可读', async () => {
  gate.plan(versionIds[1]!, [notFound()]);
  await openChapter();

  await selectVersion(1);
  await expect(page.getByTestId('version-summary-title')).toHaveText('该版本暂无摘要');
  await expect(page.getByTestId('version-summary-detail')).toHaveText(
    '摘要可能仍在生成、生成失败，或定稿时模型未配置。',
  );
  await expect(page.getByTestId('version-summary')).toHaveClass(/summary-card--muted/);
  await expect(page.getByTestId('version-summary-retry')).toHaveCount(0);
  await expect(page.getByTestId('version-summary-text')).toHaveCount(0);
  // 正文照常可读，版本操作不受影响
  await expect(page.getByTestId('version-content')).not.toHaveText('');
});

test('4. 读取失败只影响摘要卡片，"重新读取"可局部重试', async () => {
  await openChapter();

  // v1 = versionIds[0]（列表第 3 项）：读取失败
  gate.plan(versionIds[0]!, [
    {
      kind: 'json',
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: '服务内部错误' } },
    },
  ]);
  await selectVersion(2);
  await expect(page.getByTestId('version-summary-title')).toHaveText('版本摘要读取失败');
  await expect(page.getByTestId('version-summary')).toHaveClass(/summary-card--danger/);
  // 正文与其它按钮不受影响
  await expect(page.getByTestId('version-content')).not.toHaveText('');

  gate.plan(versionIds[0]!, [
    {
      kind: 'json',
      status: 200,
      body: summaryBody(versionIds[0]!, { versionNo: 1, summary: '重试后的摘要。' }),
    },
  ]);
  await page.getByTestId('version-summary-retry').click();
  await expect(page.getByTestId('version-summary-text')).toHaveText('重试后的摘要。');
  await expect(page.getByTestId('version-summary-retry')).toHaveCount(0);
});

test('5. 快速切换版本：旧请求晚返回不覆盖当前版本摘要', async () => {
  gate.plan(versionIds[1]!, [{ kind: 'hold' }]);
  await openChapter();

  await selectVersion(1);
  await expect.poll(() => gate.held().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('version-summary-title')).toHaveText('正在读取版本摘要…');

  await selectVersion(2);
  await expect(page.getByTestId('version-summary-text')).toHaveText('第一版摘要：主角入门。');

  // 旧请求（v2）这时才返回：必须完全静默
  await gate.held()[0]?.release({
    kind: 'json',
    status: 200,
    body: summaryBody(versionIds[1]!, { versionNo: 2, summary: '迟到的第二版摘要，不应出现。' }),
  });
  await page.waitForTimeout(400);
  await expect(page.getByTestId('version-summary-text')).toHaveText('第一版摘要：主角入门。');
  await expect(page.getByTestId('version-summary-text')).not.toContainText('迟到的第二版摘要');
});

test('6. 摘要里的 <script> / HTML 按纯文本显示，不执行', async () => {
  const marker = `<script>window.${XSS_KEY} = 1;</script>`;
  await openChapter();

  gate.plan(versionIds[0]!, [
    {
      kind: 'json',
      status: 200,
      body: summaryBody(versionIds[0]!, {
        versionNo: 1,
        summary: `${marker}\n<img src=x onerror="window.__summaryCardXss = 2">`,
      }),
    },
  ]);
  await selectVersion(2);
  const text = page.getByTestId('version-summary-text');
  await expect(text).toContainText('<script>');
  await expect(text).toContainText('<img src=x');
  // 仍是文本节点：卡片内没有真正的 script / img 元素
  await expect(page.locator('[data-testid="version-summary"] script')).toHaveCount(0);
  await expect(page.locator('[data-testid="version-summary"] img')).toHaveCount(0);
  const executed = await page.evaluate(
    (key) => (window as unknown as Record<string, unknown>)[key],
    XSS_KEY,
  );
  expect(executed).toBeUndefined();
});

test('7. 编辑器打开时摘要读取失败，未保存草稿仍在', async () => {
  // 两次失败：初次加载 + 编辑器打开后的「重新读取」
  gate.plan(versionIds[2]!, [
    {
      kind: 'json',
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: '服务内部错误' } },
    },
    {
      kind: 'json',
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: '服务内部错误' } },
    },
  ]);
  await openChapter();

  await expect(page.getByTestId('version-summary-title')).toHaveText('版本摘要读取失败');
  await page.getByTestId('editor-open').first().click();
  await expect(page.getByTestId('chapter-editor')).toBeVisible();

  const draft = `未保存的草稿-${randomUUID().slice(0, 6)}`;
  await page.getByTestId('editor-textarea').fill(draft);

  // 再触发一次摘要读取失败：编辑器与草稿都不能被影响
  await page.getByTestId('version-summary-retry').click();
  await expect(page.getByTestId('version-summary-title')).toHaveText('版本摘要读取失败');
  await expect(page.getByTestId('chapter-editor')).toBeVisible();
  await expect(page.getByTestId('editor-textarea')).toHaveValue(draft);
  await expect(page.getByTestId('editor-dirty')).toHaveText('有未保存修改');
});

test('8. 移动端 390×844：长摘要自然换行，卡片不横向撑破', async () => {
  const longToken = 'X'.repeat(240);
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await openChapter();
    gate.plan(versionIds[0]!, [
      {
        kind: 'json',
        status: 200,
        body: summaryBody(versionIds[0]!, { versionNo: 1, summary: `${longToken}\n第二行中文。` }),
      },
    ]);
    await selectVersion(2);
    await expect(page.getByTestId('version-summary-text')).toContainText('第二行中文。');

    const card = await page.locator('[data-testid="version-summary"]').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);

    const text = await page.locator('[data-testid="version-summary-text"]').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

test('9. 不回归：版本正文、diff 展开与摘要卡片共存', async () => {
  await openChapter();

  await expect(page.getByTestId('version-summary-text')).toHaveText('第三版摘要：雨夜守山门。');
  await expect(page.getByTestId('version-content')).not.toHaveText('');
  await expect(page.getByTestId('version-meta')).toContainText('字');

  // diff 仍可正常展开（摘要卡片不拦截、不影响它的状态）
  await page.getByTestId('compare-toggle').click();
  await expect(page.getByTestId('compare-panel')).toBeVisible();
  await page.getByTestId('compare-toggle').click();
  await expect(page.getByTestId('compare-panel')).toHaveCount(0);

  // 摘要不写任何存储
  const storageKeys = await page.evaluate(() => [
    ...Object.keys(window.localStorage),
    ...Object.keys(window.sessionStorage),
  ]);
  expect(storageKeys.filter((key) => key.toLowerCase().includes('summary'))).toEqual([]);
});
