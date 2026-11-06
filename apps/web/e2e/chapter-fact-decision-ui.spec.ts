import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@novel/db';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { readAuthorCredentials } from './shared-credentials.js';

/**
 * A2-F-C 事实候选决策 UI 的 E2E。
 *
 * 前置：
 * - `admin-flow.spec.ts` 已创建并改密 `e2e-author`，并写入共享凭据；
 * - 需要**宿主机** `DATABASE_URL`（`127.0.0.1:5432/novel_e2e_*`）直连种入正式版本、
 *   切换章节状态（跳过真实生成 / 采纳）；
 * - 事实列表与决定接口全部由 `page.route` 提供：断言的是**UI 行为**
 *   （门禁、徽章、并发隔离、失败范围），不依赖真实模型与真实写库。
 *
 * 覆盖：接受成功、拒绝成功、同决定幂等、不同决定冲突且不翻转、
 * 旧版本 / 非定稿无按钮、双击只发一个请求、filter 切换后旧响应不覆盖新列表、
 * 失败只影响当前候选、无写回 / 撤销 / 改判 / 批量入口、移动端不横向撑破。
 */

const WORK_TITLE = `事实决策-${randomUUID().slice(0, 8)}`;

/** `GET /api/works/:id/chapters/:chapterId/facts[?factType=...]` */
const LIST_PATTERN = /\/api\/works\/[^/]+\/chapters\/[^/]+\/facts(\?[^/]*)?$/;
/** `POST /api/works/:id/chapters/:chapterId/facts/:candidateId/decision` */
const DECISION_PATTERN = /\/api\/works\/[^/]+\/chapters\/[^/]+\/facts\/[^/]+\/decision$/;

const RUN_ID = '3b7c9d21-6f4a-4d5e-9a10-2c8e5b7d1f33';

/** 正文：长度与字数都必须 ≥ 1200（数据库 CHECK）。 */
const VERSION_BODY = `风从演武场尽头吹来，吹动了青石上的尘埃。${'他握紧了手中的剑。'.repeat(160)}`;

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

/** 把章节切到指定状态（跳过生成 / 采纳，只服务于决策 UI 的前置条件）。 */
async function setChapterStatus(status: 'in_review' | 'finalized'): Promise<void> {
  if (db === null) {
    throw new Error('数据库未连接');
  }
  await db.chapter.update({ where: { id: chapterId }, data: { status } });
}

/* -------------------------------------------------------------------------- */
/* 事实列表桩                                                                  */
/* -------------------------------------------------------------------------- */

interface FactStub {
  readonly id: string;
  readonly factType?: string;
  readonly summary?: string;
  readonly reason?: string;
  /** 候选所属版本；与当前最新版本不同即"旧版本候选"。 */
  readonly sourceVersionId?: string;
  /** 已有决定（已决候选）；不传表示未决定。 */
  readonly decision?: { readonly value: string; readonly decidedAt: string } | null;
}

/** 当前列表桩要返回的候选（每个用例自己设置）。 */
let plannedFacts: readonly FactStub[] = [];

function factItem(stub: FactStub): unknown {
  return {
    id: stub.id,
    runId: RUN_ID,
    sourceVersionId: stub.sourceVersionId ?? versionId,
    sourceVersionNo: 1,
    factType: stub.factType ?? 'character_state',
    summary: stub.summary ?? '主角在演武场突破到炼气三层。',
    reason: stub.reason ?? '正文写到气海扩张与气息变化。',
    subjectId: null,
    objectId: null,
    name: null,
    threadStatus: null,
    createdAt: '2026-11-06T03:00:00.000Z',
    decision: stub.decision ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* 决定接口桩                                                                  */
/* -------------------------------------------------------------------------- */

type Reply =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'hold' };

interface HeldDecision {
  readonly candidateId: string;
  readonly release: (reply: Reply) => Promise<void>;
}

interface DecisionGate {
  /** 为某个候选 id 排队回复；按请求顺序消费。 */
  plan(candidateId: string, replies: readonly Reply[]): void;
  /** 依次收到的决定请求体。 */
  bodies(): readonly unknown[];
  /** 依次收到的候选 id。 */
  candidateIds(): readonly string[];
  held(): readonly HeldDecision[];
  reset(): void;
}

/**
 * 装决定接口的响应桩。
 *
 * 默认：201 + `deduplicated=false`（首次决定）。
 * 需要 200 幂等 / 409 冲突 / 挂起时必须显式 `plan`。
 */
async function installDecisionGate(target: Page): Promise<DecisionGate> {
  const queues = new Map<string, Reply[]>();
  const bodies: unknown[] = [];
  const candidateIds: string[] = [];
  const heldEntries: HeldDecision[] = [];

  const decisionBody = (candidateId: string, decision: string, deduplicated: boolean): unknown => ({
    decision: {
      candidateId,
      decision,
      decidedAt: '2026-11-06T04:00:00.000Z',
      deduplicated,
    },
  });

  await target.route(DECISION_PATTERN, async (route: Route) => {
    const url = new URL(route.request().url());
    // 路径是 .../facts/:candidateId/decision → 倒数第二段才是候选 id。
    const segments = url.pathname.split('/');
    const candidateId = segments[segments.length - 2] ?? '';
    const body: unknown = route.request().postDataJSON();
    bodies.push(body);
    candidateIds.push(candidateId);

    // 默认：201 + `deduplicated=false`（首次决定），决定值与请求一致。
    const submitted =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { decision?: unknown }).decision === 'string'
        ? (body as { decision: string }).decision
        : 'accepted';
    const reply = queues.get(candidateId)?.shift() ?? {
      kind: 'json',
      status: 201,
      body: decisionBody(candidateId, submitted, false),
    };

    if (reply.kind === 'json') {
      await route.fulfill({
        status: reply.status,
        contentType: 'application/json',
        body: JSON.stringify(reply.body),
      });
      return;
    }

    // 挂起：等测试释放（用于"旧响应晚返回"）
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
        status: next.kind === 'json' ? next.status : 201,
        contentType: 'application/json',
        body: JSON.stringify(
          next.kind === 'json' ? next.body : decisionBody(candidateId, 'accepted', false),
        ),
      });
    } catch {
      // 页面已刷新 / 请求已被导航取消：忽略，避免桩把测试拖成超时
    } finally {
      done();
    }
  });

  return {
    plan: (candidateId, replies) => {
      queues.set(candidateId, [...replies]);
    },
    bodies: () => bodies,
    candidateIds: () => candidateIds,
    held: () => heldEntries,
    reset: () => {
      queues.clear();
      bodies.length = 0;
      candidateIds.length = 0;
      heldEntries.length = 0;
    },
  };
}

let decisionGate: DecisionGate;

/* -------------------------------------------------------------------------- */
/* 准备：真实作品 + 章节 + 1 个正式版本（事实接口全部走桩）                    */
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
  await page.getByTestId('chapter-create-title').fill('第一章 事实决策');
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

  // 事实列表桩：所有筛选返回同一份候选，便于观察"切筛选后旧响应不覆盖新列表"。
  await page.route(LIST_PATTERN, async (route: Route) => {
    const facts = plannedFacts.map((stub) => factItem(stub));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ facts, total: facts.length, truncated: false }),
    });
  });

  decisionGate = await installDecisionGate(page);
});

test.afterAll(async () => {
  await db?.$disconnect();
  await context?.close();
});

/** 打开章节页并等到事实列表落定。 */
async function openChapter(): Promise<void> {
  await page.goto(`/works/${workId}/chapters/${chapterId}`);
  await expect(page.getByTestId('facts-panel')).toBeVisible();
  await expect(page.getByTestId('version-content')).toContainText('风从演武场尽头吹来');
  await expect(
    page.locator('[data-testid="facts-total"], [data-testid="facts-error"]').first(),
  ).toBeVisible();
}

test.beforeEach(async () => {
  decisionGate.reset();
  plannedFacts = [];
  await setChapterStatus('finalized');
});

test('1. 未决定候选显示接受 / 拒绝按钮；接受成功展示已接受徽章与决定时间', async () => {
  const candidateId = randomUUID();
  plannedFacts = [{ id: candidateId }];
  await openChapter();

  // 未决定：两个按钮都在
  const item = page.locator(`[data-fact-id="${candidateId}"]`);
  await expect(item.getByTestId('facts-item-accept')).toBeVisible();
  await expect(item.getByTestId('facts-item-reject')).toBeVisible();
  await expect(item.getByTestId('facts-item-decision-badge')).toHaveCount(0);

  await item.getByTestId('facts-item-accept').click();

  // 成功：徽章 + 决定时间 + 声明，按钮消失
  await expect(item.getByTestId('facts-item-decision-badge')).toHaveText('已接受');
  await expect(item.getByTestId('facts-item-decision-time')).toContainText('决定于');
  await expect(item.getByTestId('facts-item-decision-note')).toContainText(
    '决定已记录；当前不会自动修改人物、物品、势力、关系或境界。',
  );
  await expect(item.getByTestId('facts-item-accept')).toHaveCount(0);
  await expect(item.getByTestId('facts-item-reject')).toHaveCount(0);

  // 请求体严格是 { decision }，且决定值正确
  expect(decisionGate.bodies()).toEqual([{ decision: 'accepted' }]);
  expect(decisionGate.candidateIds()).toEqual([candidateId]);
});

test('2. 拒绝成功展示已拒绝徽章', async () => {
  const candidateId = randomUUID();
  plannedFacts = [{ id: candidateId }];
  await openChapter();

  const item = page.locator(`[data-fact-id="${candidateId}"]`);
  await item.getByTestId('facts-item-reject').click();

  await expect(item.getByTestId('facts-item-decision-badge')).toHaveText('已拒绝');
  await expect(item.getByTestId('facts-item-accept')).toHaveCount(0);
  expect(decisionGate.bodies()).toEqual([{ decision: 'rejected' }]);
});

test('3. 同决定幂等（200 deduplicated）同样展示已决状态', async () => {
  const candidateId = randomUUID();
  plannedFacts = [{ id: candidateId }];
  decisionGate.plan(candidateId, [
    {
      kind: 'json',
      status: 200,
      body: {
        decision: {
          candidateId,
          decision: 'accepted',
          decidedAt: '2026-11-06T04:00:00.000Z',
          deduplicated: true,
        },
      },
    },
  ]);
  await openChapter();

  const item = page.locator(`[data-fact-id="${candidateId}"]`);
  await item.getByTestId('facts-item-accept').click();

  // 幂等成功也展示已决状态，不报错
  await expect(item.getByTestId('facts-item-decision-badge')).toHaveText('已接受');
  await expect(item.getByTestId('facts-item-decision-error')).toHaveCount(0);
});

test('4. 不同决定冲突（409）不翻转决定状态，只在当前候选显示错误', async () => {
  const candidateId = randomUUID();
  plannedFacts = [{ id: candidateId }];
  decisionGate.plan(candidateId, [
    {
      kind: 'json',
      status: 409,
      body: {
        error: {
          code: 'CONTINUITY_FACT_ALREADY_DECIDED',
          message: '该事实候选已做出不同决定，不能改判',
        },
      },
    },
  ]);
  await openChapter();

  const item = page.locator(`[data-fact-id="${candidateId}"]`);
  await item.getByTestId('facts-item-reject').click();

  await expect(item.getByTestId('facts-item-decision-error')).toContainText(
    '该候选已做出不同决定，不能改判。',
  );
  // 不翻转：既没有已接受也没有已拒绝徽章
  await expect(item.getByTestId('facts-item-decision-badge')).toHaveCount(0);
  // 按钮仍在（可以重新提交同一个决定）
  await expect(item.getByTestId('facts-item-accept')).toBeVisible();
});

test('5. 旧版本候选与未定稿章节都没有决定按钮', async () => {
  const staleId = randomUUID();
  const freshId = randomUUID();
  plannedFacts = [
    // 旧版本候选：sourceVersionId 与当前最新版本不同
    { id: staleId, sourceVersionId: randomUUID() },
    { id: freshId },
  ];
  await openChapter();

  // 旧版本候选：没有按钮，有说明
  const staleItem = page.locator(`[data-fact-id="${staleId}"]`);
  await expect(staleItem.getByTestId('facts-item-accept')).toHaveCount(0);
  await expect(staleItem.getByTestId('facts-item-reject')).toHaveCount(0);
  await expect(staleItem.getByTestId('facts-item-decision-hint')).toHaveText(
    '仅当前最新定稿版本可做决定。',
  );

  // 最新版本候选：按钮在
  const freshItem = page.locator(`[data-fact-id="${freshId}"]`);
  await expect(freshItem.getByTestId('facts-item-accept')).toBeVisible();

  // 未定稿章节：整个面板都没有决定按钮
  await setChapterStatus('in_review');
  await openChapter();
  await expect(page.getByTestId('facts-decision-hint')).toHaveText(
    '章节定稿后才能对事实候选做出决定。',
  );
  await expect(page.getByTestId('facts-item-accept')).toHaveCount(0);
  await expect(page.getByTestId('facts-item-reject')).toHaveCount(0);
});

test('6. 双击与同时点两个按钮只发一个请求', async () => {
  const candidateId = randomUUID();
  plannedFacts = [{ id: candidateId }];
  decisionGate.plan(candidateId, [{ kind: 'hold' }]);
  await openChapter();

  const item = page.locator(`[data-fact-id="${candidateId}"]`);
  // 同一个 tick 内连点接受三次、再点一次拒绝：React 还没来得及禁用按钮，
  // 只有 in-flight 判定能保证只发一个请求。
  await item.evaluate((element) => {
    const accept = element.querySelector<HTMLButtonElement>('[data-testid="facts-item-accept"]');
    const reject = element.querySelector<HTMLButtonElement>('[data-testid="facts-item-reject"]');
    accept?.click();
    accept?.click();
    accept?.click();
    reject?.click();
  });

  // 只发一个请求，且第一个请求胜出
  expect(decisionGate.bodies()).toHaveLength(1);
  expect(decisionGate.bodies()[0]).toEqual({ decision: 'accepted' });

  // 提交中：两个按钮都禁用并显示「记录中…」
  await expect(item.getByTestId('facts-item-accept')).toHaveText('记录中…');
  await expect(item.getByTestId('facts-item-reject')).toHaveText('记录中…');
  await expect(item.getByTestId('facts-item-accept')).toBeDisabled();

  // 收尾：释放被挂起的请求，避免残留未决路由
  const held = decisionGate.held().find((entry) => entry.candidateId === candidateId);
  await held?.release({
    kind: 'json',
    status: 201,
    body: {
      decision: {
        candidateId,
        decision: 'accepted',
        decidedAt: '2026-11-06T04:00:00.000Z',
        deduplicated: false,
      },
    },
  });
});

test('7. filter 切换后旧决定响应不覆盖新列表', async () => {
  const candidateId = randomUUID();
  plannedFacts = [{ id: candidateId }];
  decisionGate.plan(candidateId, [{ kind: 'hold' }]);
  await openChapter();

  const item = page.locator(`[data-fact-id="${candidateId}"]`);
  await item.getByTestId('facts-item-accept').click();
  await expect(item.getByTestId('facts-item-accept')).toHaveText('记录中…');

  // 切换筛选：列表重新读取（版本自增），旧响应随后到达
  await page.locator('[data-fact-filter="character_state"]').click();
  await expect(page.locator('[data-fact-filter="character_state"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const held = decisionGate.held().find((entry) => entry.candidateId === candidateId);
  await held?.release({
    kind: 'json',
    status: 201,
    body: {
      decision: {
        candidateId,
        decision: 'accepted',
        decidedAt: '2026-11-06T04:00:00.000Z',
        deduplicated: false,
      },
    },
  });

  // 观察窗：旧响应被丢弃 —— 新列表里该候选仍是"未决定"，没有徽章也没有错误
  await page.waitForTimeout(400);
  const newItem = page.locator(`[data-fact-id="${candidateId}"]`);
  await expect(newItem.getByTestId('facts-item-decision-badge')).toHaveCount(0);
  await expect(newItem.getByTestId('facts-item-decision-error')).toHaveCount(0);
  await expect(newItem.getByTestId('facts-item-accept')).toBeVisible();
});

test('8. 决定失败只影响当前候选，其它候选照常可用', async () => {
  const failedId = randomUUID();
  const okId = randomUUID();
  plannedFacts = [{ id: failedId }, { id: okId }];
  decisionGate.plan(failedId, [
    {
      kind: 'json',
      status: 409,
      body: {
        error: {
          code: 'CONTINUITY_FACT_DECISION_STALE',
          message: '该事实候选已过期：章节或版本已变化',
        },
      },
    },
  ]);
  await openChapter();

  const failedItem = page.locator(`[data-fact-id="${failedId}"]`);
  await failedItem.getByTestId('facts-item-accept').click();
  await expect(failedItem.getByTestId('facts-item-decision-error')).toContainText(
    '章节或版本已变化，不能继续决定。',
  );

  // 失败不清空列表
  await expect(page.getByTestId('facts-item')).toHaveCount(2);
  // 另一条候选不受影响，仍可决定
  const okItem = page.locator(`[data-fact-id="${okId}"]`);
  await expect(okItem.getByTestId('facts-item-decision-error')).toHaveCount(0);
  await okItem.getByTestId('facts-item-accept').click();
  await expect(okItem.getByTestId('facts-item-decision-badge')).toHaveText('已接受');
});

test('9. 事实区没有写回 / 撤销 / 改判 / 批量入口', async () => {
  const candidateId = randomUUID();
  plannedFacts = [{ id: candidateId }];
  await openChapter();

  const item = page.locator(`[data-fact-id="${candidateId}"]`);
  await item.getByTestId('facts-item-accept').click();
  await expect(item.getByTestId('facts-item-decision-badge')).toHaveText('已接受');

  const panel = page.getByTestId('facts-panel');
  const labels = (await panel.getByRole('button').allTextContents()).map((text) => text.trim());
  for (const label of labels) {
    expect(['撤销', '改判', '批量', '写回', '采纳']).not.toContain(label);
  }
  const text = (await panel.innerText()).replace(/\s/gu, '');
  expect(text).not.toContain('撤销');
  expect(text).not.toContain('改判');
  expect(text).not.toContain('批量');
  expect(text).not.toContain('写回');
  expect(text).not.toContain('采纳');
  // 已决候选没有接受 / 拒绝按钮（没有改判入口）
  await expect(item.getByTestId('facts-item-accept')).toHaveCount(0);
  await expect(item.getByTestId('facts-item-reject')).toHaveCount(0);
});

test('10. 移动端 390×844：决定区不横向撑破', async () => {
  const longToken = 'X'.repeat(240);
  const candidateId = randomUUID();
  plannedFacts = [{ id: candidateId, summary: `${longToken}\n第二行中文。` }];

  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await openChapter();
    await expect(page.getByTestId('facts-item-summary')).toContainText('第二行中文。');
    await page.locator(`[data-fact-id="${candidateId}"]`).getByTestId('facts-item-accept').click();
    await expect(
      page.locator(`[data-fact-id="${candidateId}"]`).getByTestId('facts-item-decision-badge'),
    ).toHaveText('已接受');

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
