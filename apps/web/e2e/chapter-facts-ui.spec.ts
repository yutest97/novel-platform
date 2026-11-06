import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@novel/db';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { readAuthorCredentials } from './shared-credentials.js';

/**
 * A2-E 连续性事实候选只读审阅 UI 的 E2E。
 *
 * 前置：
 * - `admin-flow.spec.ts` 已创建并改密 `e2e-author`，并写入共享凭据；
 * - 需要**宿主机** `DATABASE_URL`（`127.0.0.1:5432/novel_e2e_*`）直连种入正式版本、
 *   切换章节状态（真实定稿流程需要生成 / 采纳，本卡只做事实 UI，故直接置 `finalized`）；
 * - 事实列表与提取响应全部由 `page.route` 提供，不依赖真实模型 / 真实提取。
 *
 * 覆盖：提取入口的定稿 + 最新版本门禁、created=true / false、六类过滤、
 * truncated 提示、两种空态、list / extract 错误隔离与局部重试、快速切换不覆盖、
 * HTML 纯文本、无接受 / 写回按钮、抽取中刷新不残留 loading、移动端不横向撑破。
 */

const WORK_TITLE = `事实审阅-${randomUUID().slice(0, 8)}`;

/** `GET /api/works/:id/chapters/:chapterId/facts[?factType=...]` */
const LIST_PATTERN = /\/api\/works\/[^/]+\/chapters\/[^/]+\/facts(\?[^/]*)?$/;
/** `POST /api/works/:id/chapters/:chapterId/facts/extract` */
const EXTRACT_PATTERN = /\/api\/works\/[^/]+\/chapters\/[^/]+\/facts\/extract$/;

const XSS_KEY = '__factPanelXss';

/** 正文：长度与字数都必须 ≥ 1200（数据库 CHECK）。 */
const VERSION_BODY = `风从演武场尽头吹来，吹动了青石上的尘埃。${'他握紧了手中的剑。'.repeat(160)}`;

const RUN_ID = '0f8f6c2e-4a1b-4c3d-8e5f-6a7b8c9d0e1f';

let authorEmail = '';
let authorPassword = '';
let workId = '';
let chapterId = '';
let versionId = '';
let context: BrowserContext;
let page: Page;
let db: PrismaClient | null = null;

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

/** 把章节切到指定状态（跳过生成 / 采纳，只服务于事实 UI 的前置条件）。 */
async function setChapterStatus(status: 'in_review' | 'finalized'): Promise<void> {
  if (db === null) {
    throw new Error('数据库未连接');
  }
  await db.chapter.update({ where: { id: chapterId }, data: { status } });
}

/* -------------------------------------------------------------------------- */
/* 事实响应桩                                                                  */
/* -------------------------------------------------------------------------- */

interface FactStub {
  readonly id?: string;
  readonly factType?: string;
  readonly summary?: string;
  readonly reason?: string;
  readonly subjectId?: string | null;
  readonly objectId?: string | null;
  readonly name?: string | null;
  readonly threadStatus?: string | null;
}

function factItem(stub: FactStub = {}): unknown {
  return {
    id: stub.id ?? randomUUID(),
    runId: RUN_ID,
    sourceVersionId: versionId,
    sourceVersionNo: 1,
    factType: stub.factType ?? 'character_state',
    summary: stub.summary ?? '主角在演武场突破到炼气三层。',
    reason: stub.reason ?? '正文写到气海扩张与气息变化。',
    subjectId: stub.subjectId ?? null,
    objectId: stub.objectId ?? null,
    name: stub.name ?? null,
    threadStatus: stub.threadStatus ?? null,
    createdAt: '2026-11-06T03:00:00.000Z',
    // A2-F-B：读取模型新增 decision（本卡 UI 不渲染，桩里保持未决定）
    decision: null,
  };
}

function listBody(facts: readonly unknown[], total = facts.length, truncated = false): unknown {
  return { facts, total, truncated };
}

function extractBody(created: boolean, factCount: number): unknown {
  return {
    extraction: {
      runId: RUN_ID,
      created,
      sourceVersionId: versionId,
      sourceVersionNo: 1,
      agentName: 'continuity.extractor',
      agentVersion: '1.0.0',
      provider: 'mock',
      model: 'mock-model',
      factCount,
      factTypeCounts: factCount === 0 ? {} : { character_state: factCount },
    },
  };
}

type Reply =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'hold' };

interface HeldRequest {
  readonly kind: 'list' | 'extract';
  readonly filter: string;
  readonly release: (reply: Reply) => Promise<void>;
}

interface FactsGate {
  /** 为某个筛选值排队回复（`all` 或六类之一）；按请求顺序消费。 */
  planList(filter: string, replies: readonly Reply[]): void;
  planExtract(replies: readonly Reply[]): void;
  /** 依次收到的筛选值（`all` 表示没有 `factType` 参数）。 */
  listFilters(): readonly string[];
  /** 依次收到的完整请求路径（含 query）。 */
  listUrls(): readonly string[];
  /** 提取请求的 body。 */
  extractBodies(): readonly unknown[];
  held(): readonly HeldRequest[];
  reset(): void;
}

/**
 * 装事实接口的响应桩。
 *
 * 默认：列表为空、提取 `created=true`。需要特定响应时必须显式 `plan*`，
 * 避免"默认就返回数据"掩盖了请求没发出的问题。
 */
async function installFactsGate(target: Page): Promise<FactsGate> {
  const listQueues = new Map<string, Reply[]>();
  const extractQueue: Reply[] = [];
  const filters: string[] = [];
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const heldEntries: HeldRequest[] = [];

  const respond = async (
    route: Route,
    reply: Reply,
    kind: 'list' | 'extract',
    filter: string,
    fallback: unknown,
  ): Promise<void> => {
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
      kind,
      filter,
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
        body: JSON.stringify(next.kind === 'json' ? next.body : fallback),
      });
    } catch {
      // 页面已刷新 / 请求已被导航取消：忽略，避免桩把测试拖成超时
    } finally {
      done();
    }
  };

  await target.route(LIST_PATTERN, async (route: Route) => {
    const url = new URL(route.request().url());
    const filter = url.searchParams.get('factType') ?? 'all';
    filters.push(filter);
    urls.push(`${url.pathname}${url.search}`);
    const reply = listQueues.get(filter)?.shift() ?? {
      kind: 'json',
      status: 200,
      body: listBody([], 0, false),
    };
    await respond(route, reply, 'list', filter, listBody([], 0, false));
  });

  await target.route(EXTRACT_PATTERN, async (route: Route) => {
    bodies.push(route.request().postDataJSON());
    const reply = extractQueue.shift() ?? {
      kind: 'json',
      status: 201,
      body: extractBody(true, 1),
    };
    await respond(route, reply, 'extract', 'extract', extractBody(true, 1));
  });

  return {
    planList: (filter, replies) => {
      listQueues.set(filter, [...replies]);
    },
    planExtract: (replies) => {
      extractQueue.length = 0;
      extractQueue.push(...replies);
    },
    listFilters: () => filters,
    listUrls: () => urls,
    extractBodies: () => bodies,
    held: () => heldEntries,
    reset: () => {
      listQueues.clear();
      extractQueue.length = 0;
      filters.length = 0;
      urls.length = 0;
      bodies.length = 0;
      heldEntries.length = 0;
    },
  };
}

let gate: FactsGate;

/* -------------------------------------------------------------------------- */
/* 准备：真实作品 + 章节 + 1 个正式版本（事实接口全部走桩）                      */
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
  await page.getByTestId('chapter-create-title').fill('第一章 事实审阅');
  await page.getByTestId('chapter-create-submit').click();
  await expect(page.getByTestId('chapter-item')).toHaveCount(1);
  await page.getByTestId('chapter-open').click();
  // 客户端路由：必须等 URL 真的变成章节详情
  await page.waitForURL(/\/chapters\/[0-9a-f-]{36}$/);
  chapterId = page.url().split('/').pop() ?? '';
  expect(chapterId).toMatch(/^[0-9a-f-]{36}$/);

  // 直接种入 1 个正式版本：正文与字数都满足数据库 CHECK。
  db = await openE2EDatabase();
  const authorRow = await db.user.findFirstOrThrow({
    where: { email: authorEmail },
    select: { id: true },
  });
  const wordCount = Array.from(VERSION_BODY.replace(/\s/gu, '')).length;
  const version = await db.chapterVersion.create({
    data: {
      workId,
      chapterId,
      versionNo: 1,
      content: VERSION_BODY,
      wordCount,
      source: 'human',
      createdBy: authorRow.id,
    },
    select: { id: true },
  });
  versionId = version.id;

  gate = await installFactsGate(page);
});

test.afterAll(async () => {
  await db?.$disconnect();
  await context?.close();
});

/**
 * 打开章节页并等到事实区**已经落定**（ready 或 error）。
 *
 * 必须等落定再操作：否则「提取后刷新列表」的第二次请求可能和初次加载抢队列。
 */
async function openChapter(): Promise<void> {
  await page.goto(`/works/${workId}/chapters/${chapterId}`);
  await expect(page.getByTestId('facts-panel')).toBeVisible();
  await expect(page.getByTestId('version-content')).toContainText('风从演武场尽头吹来');
  await expect(
    page.locator('[data-testid="facts-total"], [data-testid="facts-error"]').first(),
  ).toBeVisible();
}

async function clickFilter(filter: string): Promise<void> {
  await page.locator(`[data-fact-filter="${filter}"]`).click();
}

test.beforeEach(async () => {
  gate.reset();
  await setChapterStatus('in_review');
});

test('1. 未定稿不显示提取入口；定稿最新版可提取（created=true）并刷新候选', async () => {
  await openChapter();

  // 未定稿：入口不存在，说明原因
  await expect(page.getByTestId('facts-extract')).toHaveCount(0);
  await expect(page.getByTestId('facts-extract-hint')).toHaveText(
    '章节定稿后才能提取连续性事实候选。',
  );

  await setChapterStatus('finalized');
  gate.planList('all', [
    { kind: 'json', status: 200, body: listBody([], 0, false) },
    {
      kind: 'json',
      status: 200,
      body: listBody(
        [
          factItem({
            summary: '主角突破到炼气三层。',
            subjectId: '11111111-2222-4333-8444-555555555555',
          }),
          factItem({
            factType: 'location_change',
            summary: '主角离开演武场，前往后山。',
            name: '后山',
          }),
        ],
        2,
        false,
      ),
    },
  ]);
  gate.planExtract([{ kind: 'json', status: 201, body: extractBody(true, 2) }]);

  await openChapter();
  await expect(page.getByTestId('facts-extract')).toHaveText('提取事实');

  const listRequestsBefore = gate.listFilters().length;
  await page.getByTestId('facts-extract').click();

  await expect(page.getByTestId('facts-extract-notice')).toContainText('已提取 2 条候选');
  await expect(page.getByTestId('facts-item')).toHaveCount(2);
  await expect(page.getByTestId('facts-total')).toHaveText('共 2 条候选');
  // 提取只针对当前最新版本：请求体必须带该版本 id
  expect(gate.extractBodies()).toEqual([{ sourceVersionId: versionId }]);
  // 成功后恰好多读一次列表（保持当前筛选），不自动采纳任何候选
  expect(gate.listFilters().length).toBe(listRequestsBefore + 1);
  expect(gate.listFilters().at(-1)).toBe('all');

  // 中文类型 + 版本号 + 引用只用简短 id
  await expect(page.getByTestId('facts-item-type').first()).toHaveText('人物状态');
  await expect(page.getByTestId('facts-item-type').nth(1)).toHaveText('人物位置');
  await expect(page.getByTestId('facts-item-version').first()).toHaveText('版本 v1');
  await expect(page.getByTestId('facts-item-refs').first()).toContainText('主体 11111111…');
  await expect(page.getByTestId('facts-item-refs').nth(1)).toContainText('地点 后山');
});

test('2. created=false 提示"已读取既有结果"，不重复新增', async () => {
  await setChapterStatus('finalized');
  await openChapter();
  gate.planList('all', [
    { kind: 'json', status: 200, body: listBody([factItem(), factItem()], 2, false) },
  ]);
  gate.planExtract([{ kind: 'json', status: 200, body: extractBody(false, 2) }]);

  await page.getByTestId('facts-extract').click();

  await expect(page.getByTestId('facts-extract-notice')).toContainText('已读取既有结果');
  await expect(page.getByTestId('facts-extract-notice')).toContainText('2 条候选');
  await expect(page.getByTestId('facts-extract-notice')).not.toContainText('已提取');
  await expect(page.getByTestId('facts-item')).toHaveCount(2);
});

test('3. 六类筛选各自发出 factType 请求并展示对应结果', async () => {
  await openChapter();

  const cases = [
    { filter: 'character_state', label: '人物状态', stub: { factType: 'character_state' } },
    { filter: 'relationship_change', label: '关系变化', stub: { factType: 'relationship_change' } },
    { filter: 'item_change', label: '物品变化', stub: { factType: 'item_change' } },
    { filter: 'realm_progress', label: '境界进展', stub: { factType: 'realm_progress' } },
    {
      filter: 'plot_thread',
      label: '情节线索',
      stub: { factType: 'plot_thread', threadStatus: 'new' },
    },
    {
      filter: 'location_change',
      label: '人物位置',
      stub: { factType: 'location_change', name: '后山' },
    },
  ] as const;

  for (const item of cases) {
    gate.planList(item.filter, [
      {
        kind: 'json',
        status: 200,
        body: listBody([factItem({ ...item.stub, summary: `${item.label}示例。` })], 1, false),
      },
    ]);
    await clickFilter(item.filter);
    await expect(page.getByTestId('facts-item-type')).toHaveText(item.label);
    await expect(page.getByTestId('facts-item-summary')).toHaveText(`${item.label}示例。`);
    await expect(page.getByTestId('facts-total')).toHaveText('当前筛选共 1 条候选');
  }

  // 过滤只交给服务端：请求带 factType，客户端不裁剪
  expect(gate.listFilters()).toEqual([
    'all',
    'character_state',
    'relationship_change',
    'item_change',
    'realm_progress',
    'plot_thread',
    'location_change',
  ]);
  expect(gate.listUrls()[1]).toContain('factType=character_state');
  expect(gate.listUrls()[6]).toContain('factType=location_change');

  // 切回全部：不带 factType
  gate.planList('all', [{ kind: 'json', status: 200, body: listBody([factItem()], 1, false) }]);
  await clickFilter('all');
  await expect(page.getByTestId('facts-total')).toHaveText('共 1 条候选');
  expect(gate.listUrls()[7]).not.toContain('factType=');
});

test('4. truncated=true 显示截断提示，不静默丢弃结果', async () => {
  gate.planList('all', [{ kind: 'json', status: 200, body: listBody([factItem()], 240, true) }]);
  await openChapter();

  await expect(page.getByTestId('facts-truncated')).toHaveText(
    '结果较多：共 240 条候选，仅显示最近 200 条。',
  );
  await expect(page.getByTestId('facts-total')).toHaveText('共 240 条候选');
  await expect(page.getByTestId('facts-item')).toHaveCount(1);
});

test('5. 空结果与"筛选为空"是两种文案', async () => {
  // A. 完全没有候选
  gate.planList('all', [{ kind: 'json', status: 200, body: listBody([], 0, false) }]);
  await openChapter();
  await expect(page.getByTestId('facts-empty-title')).toHaveText('还没有事实候选');
  await expect(page.getByTestId('facts-empty-detail')).toContainText('章节定稿后可以提取');
  await expect(page.getByTestId('facts-list')).toHaveCount(0);

  // B. 有候选，但当前筛选为空
  gate.planList('all', [
    { kind: 'json', status: 200, body: listBody([factItem(), factItem()], 2, false) },
  ]);
  gate.planList('item_change', [{ kind: 'json', status: 200, body: listBody([], 0, false) }]);
  await openChapter();
  await expect(page.getByTestId('facts-item')).toHaveCount(2);

  await clickFilter('item_change');
  await expect(page.getByTestId('facts-empty-title')).toHaveText('当前筛选下没有候选');
  await expect(page.getByTestId('facts-empty-detail')).toContainText('物品变化');
  await expect(page.getByTestId('facts-total')).toHaveText('当前筛选共 0 条候选');
});

test('6. 列表读取失败只影响事实区，正文可读，可局部重新读取', async () => {
  gate.planList('all', [
    {
      kind: 'json',
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: '服务内部错误' } },
    },
  ]);
  await openChapter();

  await expect(page.getByTestId('facts-error')).toContainText('服务内部错误，请稍后重试');
  await expect(page.getByTestId('facts-list')).toHaveCount(0);
  // 正文、版本元信息、摘要卡片都不受事实读取失败影响
  await expect(page.getByTestId('version-content')).toContainText('风从演武场尽头吹来');
  await expect(page.getByTestId('version-meta')).toContainText('字');
  await expect(page.getByTestId('version-summary')).toBeVisible();

  gate.planList('all', [{ kind: 'json', status: 200, body: listBody([factItem()], 1, false) }]);
  await page.getByTestId('facts-retry').click();
  await expect(page.getByTestId('facts-item')).toHaveCount(1);
  await expect(page.getByTestId('facts-error')).toHaveCount(0);
  expect(gate.listFilters()).toEqual(['all', 'all']);
});

test('7. 提取失败给稳定中文提示，事实区外的内容不受影响', async () => {
  await setChapterStatus('finalized');
  await openChapter();

  gate.planExtract([
    {
      kind: 'json',
      status: 409,
      body: { error: { code: 'CONTINUITY_EXTRACTION_IN_PROGRESS', message: '正在提取' } },
    },
  ]);
  await page.getByTestId('facts-extract').click();
  await expect(page.getByTestId('facts-extract-error')).toHaveText(
    '该版本正在提取连续性事实，请稍后重试。',
  );
  await expect(page.getByTestId('version-content')).toContainText('风从演武场尽头吹来');

  gate.planExtract([
    {
      kind: 'json',
      status: 409,
      body: { error: { code: 'CONTINUITY_SOURCE_VERSION_STALE', message: '版本已变化' } },
    },
  ]);
  await page.getByTestId('facts-extract').click();
  await expect(page.getByTestId('facts-extract-error')).toHaveText(
    '章节最新版本已变化，请重新选择最新版本再提取。',
  );

  // 成功后上一次错误必须被清掉
  gate.planExtract([{ kind: 'json', status: 201, body: extractBody(true, 1) }]);
  gate.planList('all', [{ kind: 'json', status: 200, body: listBody([factItem()], 1, false) }]);
  await page.getByTestId('facts-extract').click();
  await expect(page.getByTestId('facts-extract-error')).toHaveCount(0);
  await expect(page.getByTestId('facts-extract-notice')).toContainText('已提取 1 条候选');
});

test('8. 快速切换筛选：旧响应晚返回不覆盖新筛选', async () => {
  await openChapter();

  gate.planList('character_state', [{ kind: 'hold' }]);
  gate.planList('plot_thread', [
    {
      kind: 'json',
      status: 200,
      body: listBody(
        [factItem({ factType: 'plot_thread', summary: '主线线索：玉佩来历未解。' })],
        1,
        false,
      ),
    },
  ]);

  await clickFilter('character_state');
  // 等被挂起的那次请求真的到达服务端桩，再切到下一个筛选
  await expect
    .poll(() => gate.held().filter((entry) => entry.kind === 'list').length)
    .toBeGreaterThan(0);
  await clickFilter('plot_thread');
  await expect(page.getByTestId('facts-item-summary')).toHaveText('主线线索：玉佩来历未解。');

  const held = gate.held().find((entry) => entry.kind === 'list');
  expect(held).toBeDefined();
  await held?.release({
    kind: 'json',
    status: 200,
    body: listBody(
      [
        factItem({ summary: '旧筛选的候选 A。' }),
        factItem({ id: randomUUID(), summary: '旧筛选的候选 B。' }),
      ],
      2,
      false,
    ),
  });
  // 观察窗：旧响应必须被丢弃，列表与总数都保持"情节线索"
  await page.waitForTimeout(400);
  await expect(page.getByTestId('facts-item')).toHaveCount(1);
  await expect(page.getByTestId('facts-item-summary')).toHaveText('主线线索：玉佩来历未解。');
  await expect(page.getByTestId('facts-total')).toHaveText('当前筛选共 1 条候选');
  await expect(page.locator('[data-fact-filter="plot_thread"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('9. summary / reason 中的 HTML 按纯文本显示，不执行', async () => {
  const marker = `<script>window.${XSS_KEY} = 1;</script>`;
  gate.planList('all', [
    {
      kind: 'json',
      status: 200,
      body: listBody(
        [
          factItem({
            summary: `${marker}\n<img src=x onerror="window.__factPanelXss = 2">`,
            reason: '<b>不是粗体</b>',
          }),
        ],
        1,
        false,
      ),
    },
  ]);
  await openChapter();

  await expect(page.getByTestId('facts-item-summary')).toContainText('<script>');
  await expect(page.getByTestId('facts-item-summary')).toContainText('<img src=x');
  await expect(page.getByTestId('facts-item-reason')).toContainText('<b>不是粗体</b>');
  // 仍是文本节点：面板内没有真正的 script / img / b 元素
  await expect(page.locator('[data-testid="facts-panel"] script')).toHaveCount(0);
  await expect(page.locator('[data-testid="facts-panel"] img')).toHaveCount(0);
  await expect(page.locator('[data-testid="facts-panel"] b')).toHaveCount(0);
  const executed = await page.evaluate(
    (key) => (window as unknown as Record<string, unknown>)[key],
    XSS_KEY,
  );
  expect(executed).toBeUndefined();
});

test('10. 事实区没有任何接受 / 拒绝 / 写回入口', async () => {
  gate.planList('all', [{ kind: 'json', status: 200, body: listBody([factItem()], 1, false) }]);
  await openChapter();

  const panel = page.getByTestId('facts-panel');
  const labels = (await panel.getByRole('button').allTextContents()).map((text) => text.trim());
  // 只允许：提取 + 7 个筛选（+ 失败时的"重新读取"）
  const allowed = new Set([
    '提取事实',
    '提取中…',
    '重新读取',
    '全部',
    '人物状态',
    '关系变化',
    '物品变化',
    '境界进展',
    '情节线索',
    '人物位置',
  ]);
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels) {
    expect(allowed.has(label)).toBe(true);
  }

  const text = (await panel.innerText()).replace(/\s/gu, '');
  for (const forbidden of ['接受', '拒绝', '采纳', '写回', '批量']) {
    expect(text).not.toContain(forbidden);
  }
});

test('11. 移动端 390×844：长 summary / reason 不横向撑破', async () => {
  const longToken = 'X'.repeat(240);
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    gate.planList('all', [
      {
        kind: 'json',
        status: 200,
        body: listBody(
          [
            factItem({
              summary: `${longToken}\n第二行中文。`,
              reason: `${longToken}${longToken}`,
              subjectId: '11111111-2222-4333-8444-555555555555',
            }),
          ],
          1,
          false,
        ),
      },
    ]);
    await openChapter();
    await expect(page.getByTestId('facts-item-summary')).toContainText('第二行中文。');

    const item = await page
      .locator('[data-testid="facts-item"]')
      .first()
      .evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
    expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth + 1);

    const panel = await page.locator('[data-testid="facts-panel"]').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

test('12. 提取进行中刷新页面不会留下永久 loading', async () => {
  await setChapterStatus('finalized');
  await openChapter();
  gate.planExtract([{ kind: 'hold' }]);

  await page.getByTestId('facts-extract').click();
  await expect(page.getByTestId('facts-extract')).toHaveText('提取中…');
  await expect(page.getByTestId('facts-extract')).toBeDisabled();

  // 刷新：组件内存里的 extracting 必须随之消失，事实区按 API 状态重新读取
  gate.planList('all', [{ kind: 'json', status: 200, body: listBody([factItem()], 1, false) }]);
  await openChapter();

  await expect(page.getByTestId('facts-extract')).toHaveText('提取事实');
  await expect(page.getByTestId('facts-extract')).toBeEnabled();
  await expect(page.getByTestId('facts-loading')).toHaveCount(0);
  await expect(page.getByTestId('facts-item')).toHaveCount(1);

  // 收尾：释放被挂起的提取请求，避免残留未决路由
  const held = gate.held().find((entry) => entry.kind === 'extract');
  await held?.release({ kind: 'json', status: 500, body: { error: { code: 'INTERNAL_ERROR' } } });
});
