/**
 * 后端端到端闭环（A1-3C）。
 *
 * 真实 PostgreSQL + MockProvider，全链路走**真实 HTTP 路由处理函数**：
 *
 *   POST /chapters                       创建章节
 *   POST /chapters/:id/generate          创建 chapter.draft 任务
 *   WorkerRunner.runOnce()               领取 → 预检 → Planner → 合同 → Writer → 候选
 *   GET  /generation-tasks/:taskId       轮询到 succeeded
 *   GET  /chapters/:chapterId            最新任务 + 候选摘要
 *   GET  .../candidates/:candidateId     读取候选正文
 *   POST .../adopt                       采纳 → chapter_version(versionNo=1)
 *   再次采纳                             幂等 deduplicated=true
 *
 * 不启动常驻进程、不接真实模型网络；Worker 与 web 共用同一个 Provider 实例，
 * 因此任务记录的 provider/model 与预检配置一致。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import {
  MockProvider,
  WorkerRunner,
  WorkflowKernel,
  WorkflowRegistry,
  countWords,
  createChapterDraftWorkflow,
} from '@novel/workflow';
import { lockWork, parseRuleFieldSchema } from '@novel/works';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { POST as adoptPost } from '../app/api/works/[id]/chapters/[chapterId]/candidates/[candidateId]/adopt/route.js';
import { GET as candidateGet } from '../app/api/works/[id]/chapters/[chapterId]/candidates/[candidateId]/route.js';
import { POST as generatePost } from '../app/api/works/[id]/chapters/[chapterId]/generate/route.js';
import { GET as chapterGet } from '../app/api/works/[id]/chapters/[chapterId]/route.js';
import { POST as chaptersPost } from '../app/api/works/[id]/chapters/route.js';
import { GET as taskGet } from '../app/api/works/[id]/generation-tasks/[taskId]/route.js';

const ORIGIN = 'http://127.0.0.1:3000';
const TARGET_WORDS = 3000;
/** 正文：1600 个非空白字符（≥ 候选下限 1200）。 */
const DRAFT = '风从演武场尽头吹来，吹动了青石上的尘埃。'.repeat(80);

const MODEL_ENV_KEYS = ['MODEL_PROVIDER', 'MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_NAME'] as const;

let db: PrismaClient;
let authorId: string;
let token: string;
let workId: string;
let chapterId: string;
let taskId: string;
let heroName: string;

const savedEnv: Record<string, string | undefined> = {};

/** 本文件创建的任务：异常中断时收敛到终态，避免污染后续用例的全局领取。 */
const trackedTaskIds: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function request(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.token !== undefined) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
  }
  headers['origin'] = ORIGIN;
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function chapterParams(id: string, chapter: string) {
  return { params: Promise.resolve({ id, chapterId: chapter }) };
}

function candidateParams(id: string, chapter: string, candidate: string) {
  return { params: Promise.resolve({ id, chapterId: chapter, candidateId: candidate }) };
}

function taskParams(id: string, task: string) {
  return { params: Promise.resolve({ id, taskId: task }) };
}

async function createFixture(): Promise<void> {
  const user = await db.user.create({
    data: {
      email: `chapter-e2e-${randomUUID()}@example.test`,
      passwordHash: '$argon2id$stub',
      role: 'author',
      status: 'active',
      mustChangePassword: false,
    },
  });
  authorId = user.id;

  const { createSession, readAuthConfig } = await import('@novel/auth');
  const session = await createSession(db, { userId: authorId, config: readAuthConfig() });
  token = session.token;

  const work = await db.work.create({
    data: {
      authorId,
      title: `端到端作品-${randomUUID().slice(0, 8)}`,
      genreRulePackage: 'xuanhuan',
      targetWordsPerChapter: TARGET_WORDS,
    },
    select: { id: true },
  });
  workId = work.id;

  const rule = await db.rulePackage.findUniqueOrThrow({
    where: { code: 'xuanhuan' },
    select: { fieldSchema: true },
  });
  const schema = parseRuleFieldSchema(rule.fieldSchema);
  const directionGroup = schema.workDirection;
  const characterGroup = schema.entityTypes?.['character'];
  if (directionGroup === undefined || characterGroup === undefined) {
    throw new Error('xuanhuan 规则包缺少工作方向 / 人物字段组');
  }

  await db.workSetting.create({
    data: {
      workId,
      settingKey: 'toneStyle',
      settingValue: '冷峻克制',
      schemaRef: directionGroup.schemaRef,
    },
  });
  const hero = await db.entity.create({
    data: {
      workId,
      entityType: 'character',
      name: `沈砚-${randomUUID().slice(0, 6)}`,
      orderIndex: 1,
    },
    select: { id: true, name: true },
  });
  await db.entityAttribute.createMany({
    data: [
      {
        entityId: hero.id,
        attrKey: 'identity',
        attrValue: '外门弟子' as never,
        schemaRef: characterGroup.schemaRef,
      },
      {
        entityId: hero.id,
        attrKey: 'goal',
        attrValue: '查明师门旧案' as never,
        schemaRef: characterGroup.schemaRef,
      },
    ],
  });
  heroName = hero.name;

  const created = await chaptersPost(
    request(`/api/works/${workId}/chapters`, {
      method: 'POST',
      body: { chapterNo: 1, title: '第一章 演武场' },
      token,
    }),
    { params: Promise.resolve({ id: workId }) },
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as { chapter: { id: string } };
  chapterId = body.chapter.id;
}

/** 轮询任务直到终态（真实场景由前端轮询；这里最多等 5 秒）。 */
async function pollTaskUntilSucceeded(id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await taskGet(
      request(`/api/works/${workId}/generation-tasks/${id}`, { token }),
      taskParams(workId, id),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { task: Record<string, unknown> };
    if (body.task['status'] === 'succeeded') {
      return body.task;
    }
    if (body.task['status'] === 'failed' || body.task['status'] === 'cancelled') {
      throw new Error(`任务未成功：${JSON.stringify(body.task)}`);
    }
    await sleep(20);
  }
  throw new Error('等待任务 succeeded 超时');
}

beforeAll(async () => {
  db = getPrismaClient();
  for (const key of MODEL_ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  // Mock：不联网；web 路由与 Worker 读到的是同一份配置。
  process.env['MODEL_PROVIDER'] = 'mock';
  delete process.env['MODEL_NAME'];
  delete process.env['MODEL_BASE_URL'];
  delete process.env['MODEL_API_KEY'];

  await createFixture();
});

afterEach(async () => {
  for (const id of trackedTaskIds) {
    await db.$executeRaw`
      UPDATE generation_tasks
         SET status = 'cancelled',
             cancel_requested_at = COALESCE(cancel_requested_at, clock_timestamp()),
             locked_by = NULL,
             lease_until = NULL,
             updated_at = clock_timestamp()
       WHERE id = ${id}::uuid AND status IN ('queued', 'processing')
    `;
  }
  trackedTaskIds.length = 0;
});

afterAll(async () => {
  for (const key of MODEL_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  if (workId !== undefined) {
    // 版本 / 合同 / 候选不可变（触发器），测试清理需在事务内临时禁用。
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_versions" DISABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_candidates" DISABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_contracts" DISABLE TRIGGER USER');
        await tx.chapterVersion.deleteMany({ where: { workId } });
        await tx.chapterCandidate.deleteMany({ where: { workId } });
        await tx.chapterContract.deleteMany({ where: { workId } });
        await tx.generationTask.deleteMany({ where: { workId } });
        await tx.chapter.deleteMany({ where: { workId } });
        await tx.work.deleteMany({ where: { id: workId } });
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_contracts" ENABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_candidates" ENABLE TRIGGER USER');
        await tx.$executeRawUnsafe('ALTER TABLE "chapter_versions" ENABLE TRIGGER USER');
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
  }

  await db.$disconnect();
});

describe('API → Worker → 候选 → 采纳（全链路）', () => {
  it('完整闭环：任务 succeeded、候选可读、采纳生成 versionNo=1、重复采纳幂等', async () => {
    // ---- 1. 提交生成任务（provider/model 来自服务端配置）----
    const generate = await generatePost(
      request(`/api/works/${workId}/chapters/${chapterId}/generate`, {
        method: 'POST',
        body: { requestId: `e2e-${randomUUID()}`, targetWords: TARGET_WORDS },
        token,
      }),
      chapterParams(workId, chapterId),
    );
    expect(generate.status).toBe(201);
    const generateBody = (await generate.json()) as { task: { id: string; status: string } };
    taskId = generateBody.task.id;
    trackedTaskIds.push(taskId);
    expect(generateBody.task.status).toBe('queued');

    const taskRow = await db.generationTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(taskRow.taskType).toBe('chapter.draft');
    expect(taskRow.provider).toBe('mock');
    expect(taskRow.model).toBe('mock-model');

    // ---- 2. Worker：与预检一致的 Provider，真实执行 chapter.draft ----
    const provider = new MockProvider({
      json: (input) => {
        const system = input.messages[0]?.content ?? '';
        if (system.includes('planner.chapter')) {
          return {
            goal: '沈砚在演武场以弱胜强，赢下外门名额',
            mustInclude: ['演武场', '外门名额'],
            mustNotInclude: ['现代科技'],
            characters: [heroName],
            scenes: [
              {
                purpose: '建立冲突',
                location: '演武场',
                conflict: '被内门弟子当众挑衅',
                outcome: '以巧劲化解并赢下比试',
              },
            ],
            targetWords: TARGET_WORDS,
          };
        }
        return { text: DRAFT };
      },
    });

    const registry = new WorkflowRegistry();
    registry.register(createChapterDraftWorkflow({ db, provider }));
    const runner = new WorkerRunner(db, new WorkflowKernel(registry), {
      provider,
      workerId: 'e2e-worker',
      leaseMs: 10_000,
      heartbeatIntervalMs: 1_000,
      pollIntervalMs: 10,
      sweepIntervalMs: 10,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await expect(runner.runOnce()).resolves.toBe('succeeded');

    // ---- 3. 轮询任务直到 succeeded ----
    const task = await pollTaskUntilSucceeded(taskId);
    expect(task['status']).toBe('succeeded');
    expect(task['currentStep']).toBe('persist_candidate');
    trackedTaskIds.length = 0;

    // ---- 4. 章节详情：最新任务 + 候选摘要（不含正文）----
    const detail = await chapterGet(
      request(`/api/works/${workId}/chapters/${chapterId}`, { token }),
      chapterParams(workId, chapterId),
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      chapter: { status: string };
      latestTask: { id: string; status: string } | null;
      candidates: { id: string; status: string; wordCount: number }[];
    };
    expect(detailBody.chapter.status).toBe('in_review');
    expect(detailBody.latestTask).toMatchObject({ id: taskId, status: 'succeeded' });
    expect(detailBody.candidates).toHaveLength(1);
    expect(detailBody.candidates[0]?.status).toBe('candidate');
    expect(detailBody.candidates[0]?.wordCount).toBe(countWords(DRAFT));
    expect(JSON.stringify(detailBody)).not.toContain('风从演武场');
    const candidateId = detailBody.candidates[0]?.id ?? '';

    // ---- 5. 读取候选正文 ----
    const candidateResponse = await candidateGet(
      request(`/api/works/${workId}/chapters/${chapterId}/candidates/${candidateId}`, { token }),
      candidateParams(workId, chapterId, candidateId),
    );
    expect(candidateResponse.status).toBe(200);
    const candidateBody = (await candidateResponse.json()) as {
      candidate: { content: string; wordCount: number; status: string };
    };
    expect(candidateBody.candidate.status).toBe('candidate');
    expect(candidateBody.candidate.content).toBe(DRAFT);
    expect(candidateBody.candidate.content.length).toBeGreaterThanOrEqual(1200);
    expect(candidateBody.candidate.wordCount).toBe(countWords(DRAFT));

    // ---- 6. 同一把作品锁：章节创建与采纳都必须排队等待 ----
    let releaseLock: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let markAcquired: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const holder = db.$transaction(
      async (tx) => {
        await lockWork(tx, workId);
        markAcquired();
        await gate;
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
    await acquired;

    let adoptSettled = false;
    let chapterSettled = false;
    const adoptPromise = adoptPost(
      request(`/api/works/${workId}/chapters/${chapterId}/candidates/${candidateId}/adopt`, {
        method: 'POST',
        body: {},
        token,
      }),
      candidateParams(workId, chapterId, candidateId),
    ).then((response) => {
      adoptSettled = true;
      return response;
    });
    const chapterPromise = chaptersPost(
      request(`/api/works/${workId}/chapters`, {
        method: 'POST',
        body: { chapterNo: 2, title: '第二章 等待锁' },
        token,
      }),
      { params: Promise.resolve({ id: workId }) },
    ).then((response) => {
      chapterSettled = true;
      return response;
    });
    // 避免断言失败时留下未处理的 rejection
    void adoptPromise.catch(() => undefined);
    void chapterPromise.catch(() => undefined);

    await sleep(250);
    expect(adoptSettled).toBe(false);
    expect(chapterSettled).toBe(false);

    releaseLock();
    await holder;
    expect((await chapterPromise).status).toBe(201);

    // ---- 7. 采纳候选 → 正式版本 ----
    const adoptResponse = await adoptPromise;
    expect(adoptResponse.status).toBe(201);
    const adoptBody = (await adoptResponse.json()) as {
      version: {
        versionNo: number;
        wordCount: number;
        chapterStatus: string;
        deduplicated: boolean;
      };
    };
    expect(adoptBody.version).toMatchObject({
      versionNo: 1,
      wordCount: countWords(DRAFT),
      chapterStatus: 'in_review',
      deduplicated: false,
    });

    const versions = await db.chapterVersion.findMany({ where: { workId, chapterId } });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.source).toBe('ai');
    expect(versions[0]?.sourceCandidateId).toBe(candidateId);
    expect(versions[0]?.content).toBe(DRAFT);

    // ---- 8. 重复采纳 → 幂等 ----
    const repeat = await adoptPost(
      request(`/api/works/${workId}/chapters/${chapterId}/candidates/${candidateId}/adopt`, {
        method: 'POST',
        body: { requestId: `adopt-${randomUUID()}` },
        token,
      }),
      candidateParams(workId, chapterId, candidateId),
    );
    expect(repeat.status).toBe(200);
    const repeatBody = (await repeat.json()) as {
      version: { versionNo: number; deduplicated: boolean };
    };
    expect(repeatBody.version).toMatchObject({ versionNo: 1, deduplicated: true });
    expect(await db.chapterVersion.count({ where: { workId, chapterId } })).toBe(1);

    // ---- 9. 真实模型调用有两条成功计量，且不含正文 / Key ----
    const logs = await db.llmCallLog.findMany({ where: { taskId } });
    expect(logs.map((log) => log.stage).sort()).toEqual([
      'agent:planner.chapter@1.0.0',
      'agent:writer.chapter@1.0.0',
    ]);
    expect(logs.every((log) => log.success && log.provider === 'mock')).toBe(true);
    expect(logs.every((log) => log.model === 'mock-model')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('风从演武场');

    // ---- 10. 无 queued / processing 残留 ----
    expect(
      await db.generationTask.count({
        where: { workId, status: { in: ['queued', 'processing'] } },
      }),
    ).toBe(0);
  }, 60_000);
});
