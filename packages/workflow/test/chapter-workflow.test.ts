/**
 * 单章候选流水线（A1-2）。
 *
 * 使用真实 PostgreSQL + MockProvider + WorkerRunner，不接 HTTP / UI。
 * 覆盖：全链路成功、合同/候选落库、上下文来源、LLM 日志、
 * Planner/Writer 失败、Provider 超时重试、合同与候选复用、
 * 取消、审计、跨作品隔离与数据库复合外键。
 */

import { randomUUID } from 'node:crypto';

import { AUDIT_ACTIONS } from '@novel/auth';
import type { PrismaClient } from '@novel/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { countWords, normalizePlannerOutput } from '../src/chapter/agents.js';
import { freezeChapterContract } from '../src/chapter/persistence.js';
import type { PlannerOutput } from '../src/chapter/types.js';
import { CHAPTER_DRAFT_TASK_TYPE } from '../src/chapter/types.js';
import { createChapterDraftWorkflow } from '../src/chapter/workflow.js';
import { WorkflowKernel, WorkflowRegistry } from '../src/kernel.js';
import {
  ModelProviderError,
  type ModelJsonInput,
  type ModelJsonResult,
  type ModelProvider,
  type ModelTextResult,
} from '../src/model-types.js';
import { claimNextTask, createGenerationTask, listTaskContexts } from '../src/queue.js';
import { WorkerRunner } from '../src/worker.js';
import {
  addCharacters,
  createChapterFixture,
  createChapterProvider,
  defaultPlannerOutput,
  lastUserContent,
  longDraft,
  type ChapterFixture,
} from './helpers/chapter.js';
import { cleanupWork, closeTestDb, silentLogger, testDb } from './helpers/db.js';

let db: PrismaClient;
let fixtures: ChapterFixture[] = [];

beforeAll(() => {
  db = testDb();
});

afterEach(async () => {
  // 只清理作品；用户与审计日志是 append-only（删除用户会触发 SET NULL →
  // 被 audit_logs 的禁止 UPDATE 触发器拦住），因此测试账号保留、互不干扰。
  for (const fixture of fixtures) {
    await cleanupWork(db, fixture.workId);
  }
  fixtures = [];
});

afterAll(async () => {
  await closeTestDb();
});

async function newFixture(tag?: string): Promise<ChapterFixture> {
  const fixture = await createChapterFixture(db, tag === undefined ? {} : { tag });
  fixtures.push(fixture);
  return fixture;
}

function createTask(
  fixture: ChapterFixture,
  options: {
    input?: unknown;
    maxAttempts?: number;
    chapterId?: string | null;
    requestId?: string;
  } = {},
) {
  return createGenerationTask(db, {
    authorId: fixture.authorId,
    workId: fixture.workId,
    chapterId: options.chapterId === undefined ? fixture.chapterId : options.chapterId,
    requestId: options.requestId ?? `req-${randomUUID()}`,
    taskType: CHAPTER_DRAFT_TASK_TYPE,
    inputSnapshot: options.input ?? { targetWords: 3000 },
    provider: 'mock',
    model: 'mock-model',
    maxAttempts: options.maxAttempts ?? 3,
  });
}

function runnerFor(provider: ModelProvider): WorkerRunner {
  const registry = new WorkflowRegistry();
  registry.register(createChapterDraftWorkflow({ db, provider }));
  return new WorkerRunner(db, new WorkflowKernel(registry), {
    workerId: 'chapter-worker',
    leaseMs: 5_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 10,
    sweepIntervalMs: 10,
    logger: silentLogger,
  });
}

async function taskRow(taskId: string) {
  return db.generationTask.findUniqueOrThrow({ where: { id: taskId } });
}

async function chapterRow(chapterId: string) {
  return db.chapter.findUniqueOrThrow({ where: { id: chapterId } });
}

describe('全链路（MockProvider → Planner → 合同 → Writer → 候选）', () => {
  it('任务 succeeded、章节 in_review、checkpoint 为 persist_candidate', async () => {
    const fixture = await newFixture();
    const { provider, calls } = createChapterProvider(
      {},
      { plan: defaultPlannerOutput(fixture), text: longDraft() },
    );
    const { task } = await createTask(fixture);

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');

    const row = await taskRow(task.id);
    expect(row.status).toBe('succeeded');
    expect(row.currentStep).toBe('persist_candidate');
    expect(row.attemptCount).toBe(1);
    expect(row.lockedBy).toBeNull();

    const chapter = await chapterRow(fixture.chapterId);
    expect(chapter.status).toBe('in_review');

    // Planner 实际收到章节信息与作品方向
    const plannerInput = calls.planner[0];
    expect(plannerInput).toBeDefined();
    const payload = JSON.parse(lastUserContent(plannerInput as ModelJsonInput)) as Record<
      string,
      unknown
    >;
    expect(payload['chapter'] as Record<string, unknown>).toMatchObject({
      chapterNo: fixture.chapterNo,
      title: fixture.chapterTitle,
      targetWords: 3000,
    });
    const direction = payload['workDirection'] as Record<string, string>;
    expect(direction['核心金手指']).toBe(`吞星古卷-${fixture.tag}`);
    expect(direction['语气风格']).toBe('冷峻克制');
  });

  it('候选正文 ≥1200 字，word_count 由服务端重新统计', async () => {
    const fixture = await newFixture();
    const rawText = `  \n${longDraft()}\n  `;
    const { provider } = createChapterProvider(
      {},
      { plan: defaultPlannerOutput(fixture), text: rawText },
    );
    const { task } = await createTask(fixture);

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');

    const candidate = await db.chapterCandidate.findUniqueOrThrow({
      where: { generationTaskId: task.id },
    });
    expect(candidate.content).toBe(rawText.trim());
    expect(candidate.wordCount).toBe(countWords(rawText));
    expect(candidate.wordCount).toBeGreaterThanOrEqual(1200);
    expect(candidate.wordCount).toBeLessThan(rawText.length);
    expect(candidate.status).toBe('candidate');
  });

  it('合同字段完整落库，候选 structured_plan 引用合同版本', async () => {
    const fixture = await newFixture();
    const plan = defaultPlannerOutput(fixture, {
      targetWords: 3200,
      mustInclude: ['外门大比', '木剑'],
      mustNotInclude: ['真实身世'],
    });
    const { provider } = createChapterProvider({}, { plan, text: longDraft() });
    const { task } = await createTask(fixture, { input: { targetWords: 3200 } });

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');

    const contract = await db.chapterContract.findUniqueOrThrow({
      where: { generationTaskId: task.id },
    });
    expect(contract).toMatchObject({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      generationTaskId: task.id,
      versionNo: 1,
      status: 'frozen',
      targetWords: 3200,
      goal: plan['goal'],
    });
    expect(contract.mustInclude).toEqual(plan['mustInclude']);
    expect(contract.mustNotInclude).toEqual(plan['mustNotInclude']);

    const beats = contract.sceneBeats as {
      characters: string[];
      scenes: { purpose: string; location: string; conflict: string; outcome: string }[];
    };
    expect(beats.characters).toEqual(plan['characters']);
    expect(beats.scenes).toEqual(plan['scenes']);

    const candidate = await db.chapterCandidate.findUniqueOrThrow({
      where: { generationTaskId: task.id },
    });
    const structured = candidate.structuredPlan as Record<string, unknown>;
    expect(structured['contractId']).toBe(contract.id);
    expect(structured['contractVersion']).toBe(1);
    expect(structured['targetWords']).toBe(3200);
    expect(structured['scenes']).toEqual(plan['scenes']);
  });

  it('task_contexts 记录真实来源与固定顺序，秘密字段不进入摘要', async () => {
    const fixture = await newFixture();
    const { provider } = createChapterProvider(
      {},
      { plan: defaultPlannerOutput(fixture), text: longDraft() },
    );
    const { task } = await createTask(fixture);

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');

    const rows = await listTaskContexts(db, task.id);
    expect(rows.map((row) => row.contextType)).toEqual([
      'chapter',
      'character',
      'character',
      'realm_level',
      'realm_level',
      'faction',
      'work_direction',
    ]);
    expect(rows.map((row) => row.rank)).toEqual([1, 100, 101, 200, 201, 300, 400]);
    expect(rows[0]?.refId).toBe(fixture.chapterId);
    expect(rows.filter((row) => row.contextType === 'character').map((row) => row.refId)).toEqual([
      fixture.characters[0]?.id,
      fixture.characters[1]?.id,
    ]);
    expect(rows.at(-1)?.refId).toBe(fixture.workId);
    for (const row of rows) {
      expect(row.snippet?.length ?? 0).toBeLessThanOrEqual(500);
      expect(row.refId).not.toBeNull();
    }

    const text = rows.map((row) => row.snippet ?? '').join('\n');
    expect(text).toContain(fixture.characters[0]?.name ?? '');
    expect(text).toContain(fixture.realms[0]?.name ?? '');
    expect(text).toContain(fixture.factions[0]?.name ?? '');
    expect(text).toContain(`吞星古卷-${fixture.tag}`);
    expect(text).not.toContain(`他其实是${fixture.tag}界的转世`);
  });

  it('人物超过 50 条时只选前 50 条，Planner Schema 不失败且留截断记录', async () => {
    const fixture = await newFixture();
    const extras = await addCharacters(db, fixture, 60);
    const { provider, calls } = createChapterProvider(
      {},
      { plan: defaultPlannerOutput(fixture), text: longDraft() },
    );
    const { task } = await createTask(fixture);

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');

    const plannerInput = calls.planner[0];
    expect(plannerInput).toBeDefined();
    const payload = JSON.parse(lastUserContent(plannerInput as ModelJsonInput)) as {
      characters: { id: string }[];
    };
    expect(payload.characters).toHaveLength(50);
    const selected = payload.characters.map((item) => item.id);
    expect(selected[0]).toBe(fixture.characters[0]?.id);
    expect(selected[1]).toBe(fixture.characters[1]?.id);
    expect(selected).toContain(extras[47]?.id);
    expect(selected).not.toContain(extras[48]?.id);

    const rows = await listTaskContexts(db, task.id);
    const characterRows = rows.filter((row) => row.contextType === 'character');
    expect(characterRows).toHaveLength(50);
    expect(characterRows.map((row) => row.refId)).toEqual(selected);
    expect(rows.some((row) => row.refId === extras[59]?.id)).toBe(false);
    const truncated = rows.find((row) => row.contextType === 'context.truncated');
    expect(truncated?.refId).toBeNull();
    expect(truncated?.rank).toBe(500);
    expect(truncated?.snippet).toContain('人物');
    expect(rows).toHaveLength(1 + 50 + 2 + 1 + 1 + 1);
  });

  it('llm_call_logs 有 planner 与 writer 两条成功记录', async () => {
    const fixture = await newFixture();
    const { provider } = createChapterProvider(
      {},
      { plan: defaultPlannerOutput(fixture), text: longDraft() },
    );
    const { task } = await createTask(fixture);

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');

    const logs = await db.llmCallLog.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.stage)).toEqual([
      'agent:planner.chapter@1.0.0',
      'agent:writer.chapter@1.0.0',
    ]);
    expect(logs.every((log) => log.success)).toBe(true);
    expect(logs.every((log) => log.promptTokens > 0 && log.completionTokens > 0)).toBe(true);
    expect(logs.every((log) => log.provider === 'mock')).toBe(true);
  });
});

describe('失败路径：不留下半成品', () => {
  it('Planner 输出不符合 Schema → failed，无合同与候选', async () => {
    const fixture = await newFixture();
    const valid = defaultPlannerOutput(fixture);
    const badOutputs: unknown[] = [
      { goal: '只有一个字段' },
      { ...valid, scenes: [] },
      { ...valid, targetWords: 5000 },
      { ...valid, extra: '未声明字段' },
    ];

    for (const bad of badOutputs) {
      const { provider } = createChapterProvider(
        { planner: () => bad },
        { plan: valid, text: longDraft() },
      );
      const { task } = await createTask(fixture);
      await expect(runnerFor(provider).runOnce()).resolves.toBe('failed');
      const row = await taskRow(task.id);
      expect(row.errorCode).toBe('AGENT_OUTPUT_INVALID');
      expect(row.errorMessageSanitized).not.toContain('只有一个字段');
    }

    expect(await db.chapterContract.count({ where: { workId: fixture.workId } })).toBe(0);
    expect(await db.chapterCandidate.count({ where: { workId: fixture.workId } })).toBe(0);
    expect((await chapterRow(fixture.chapterId)).status).toBe('planned');
  });

  it('Planner 空白 goal / 空白场景字段 → failed，无合同', async () => {
    const fixture = await newFixture();
    const valid = defaultPlannerOutput(fixture);
    const scenes = valid['scenes'] as Record<string, unknown>[];
    const badPlans: unknown[] = [
      { ...valid, goal: '   ' },
      { ...valid, scenes: [{ ...scenes[0], purpose: '   ' }] },
    ];

    for (const bad of badPlans) {
      const { provider } = createChapterProvider(
        { planner: () => bad },
        { plan: valid, text: longDraft() },
      );
      const { task } = await createTask(fixture);
      await expect(runnerFor(provider).runOnce()).resolves.toBe('failed');
      expect((await taskRow(task.id)).errorCode).toBe('AGENT_OUTPUT_INVALID');
    }

    expect(await db.chapterContract.count({ where: { workId: fixture.workId } })).toBe(0);
    expect((await chapterRow(fixture.chapterId)).status).toBe('planned');
  });

  it('Planner 虚构人物 / 改动目标字数 → failed，无合同与候选', async () => {
    const fixture = await newFixture();
    const valid = defaultPlannerOutput(fixture);
    const badPlans: unknown[] = [
      { ...valid, characters: ['虚构人物'] },
      { ...valid, targetWords: 3200 },
    ];

    for (const bad of badPlans) {
      const { provider } = createChapterProvider(
        { planner: () => bad },
        { plan: valid, text: longDraft() },
      );
      const { task } = await createTask(fixture);
      await expect(runnerFor(provider).runOnce()).resolves.toBe('failed');
      expect((await taskRow(task.id)).errorCode).toBe('AGENT_OUTPUT_INVALID');
    }

    expect(await db.chapterContract.count({ where: { workId: fixture.workId } })).toBe(0);
    expect(await db.chapterCandidate.count({ where: { workId: fixture.workId } })).toBe(0);
    expect((await chapterRow(fixture.chapterId)).status).toBe('planned');
  });

  it('Writer 少于 1200 字 → failed，无候选；章节停在 drafting', async () => {
    const fixture = await newFixture();
    const { provider } = createChapterProvider(
      {},
      { plan: defaultPlannerOutput(fixture), text: '太短了，不到一千二百字。' },
    );
    const { task } = await createTask(fixture);

    await expect(runnerFor(provider).runOnce()).resolves.toBe('failed');

    const row = await taskRow(task.id);
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('AGENT_OUTPUT_INVALID');
    expect(await db.chapterContract.count({ where: { workId: fixture.workId } })).toBe(1);
    expect(await db.chapterCandidate.count({ where: { workId: fixture.workId } })).toBe(0);
    expect((await chapterRow(fixture.chapterId)).status).toBe('drafting');

    const writerLog = await db.llmCallLog.findFirstOrThrow({
      where: { taskId: task.id, stage: 'agent:writer.chapter@1.0.0' },
    });
    expect(writerLog.success).toBe(true);
  });

  it('Provider 超时 → 可重试，重试后成功且无半成品', async () => {
    const fixture = await newFixture();
    let plannerCalls = 0;
    const { provider } = createChapterProvider(
      {
        planner: () => {
          plannerCalls += 1;
          if (plannerCalls === 1) {
            throw new ModelProviderError('MODEL_TIMEOUT', '模型服务超时', { retryable: true });
          }
          return defaultPlannerOutput(fixture);
        },
      },
      { plan: defaultPlannerOutput(fixture), text: longDraft() },
    );
    const { task } = await createTask(fixture);

    await expect(runnerFor(provider).runOnce()).resolves.toBe('retried');
    let row = await taskRow(task.id);
    expect(row.status).toBe('queued');
    expect(row.errorCode).toBe('MODEL_TIMEOUT');
    expect(await db.chapterContract.count({ where: { workId: fixture.workId } })).toBe(0);
    expect(await db.chapterCandidate.count({ where: { workId: fixture.workId } })).toBe(0);
    expect((await chapterRow(fixture.chapterId)).status).toBe('planned');

    const failedLog = await db.llmCallLog.findFirstOrThrow({
      where: { taskId: task.id, stage: 'agent:planner.chapter@1.0.0' },
    });
    expect(failedLog.success).toBe(false);
    expect(failedLog.errorCode).toBe('MODEL_TIMEOUT');
    expect(failedLog.model).toBe('mock-model');
    expect(failedLog.promptTokens).toBe(0);

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');
    row = await taskRow(task.id);
    expect(row.status).toBe('succeeded');
    expect(await db.chapterContract.count({ where: { workId: fixture.workId } })).toBe(1);
    expect(await db.chapterCandidate.count({ where: { workId: fixture.workId } })).toBe(1);
  });

  it('失败 LLM 日志记录 resolved model，且不含 Key / prompt', async () => {
    const fixture = await newFixture();
    const { provider } = createChapterProvider(
      {
        planner: () => {
          throw new Error('sk-live-SECRET 这是 prompt');
        },
      },
      { plan: defaultPlannerOutput(fixture), text: longDraft() },
    );
    // 未知异常按可重试处理；用 maxAttempts=1 让它直接落到 failed。
    const { task } = await createTask(fixture, { maxAttempts: 1 });

    await expect(runnerFor(provider).runOnce()).resolves.toBe('failed');

    const log = await db.llmCallLog.findFirstOrThrow({ where: { taskId: task.id } });
    expect(log.model).toBe('mock-model');
    expect(log.model.length).toBeGreaterThan(0);
    expect(log.success).toBe(false);
    expect(log.errorCode).toBe('WORKFLOW_INTERNAL_ERROR');
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain('sk-live-SECRET');
    expect(serialized).not.toContain('这是 prompt');
    expect((await taskRow(task.id)).errorMessageSanitized).not.toContain('sk-live-SECRET');
  });

  it('任务输入非法（targetWords 越界 / 未知字段 / 缺 chapterId）→ failed', async () => {
    const fixture = await newFixture();
    const { provider } = createChapterProvider(
      {},
      { plan: defaultPlannerOutput(fixture), text: longDraft() },
    );
    const runner = runnerFor(provider);

    const cases: { input?: unknown; chapterId?: string | null }[] = [
      { input: { targetWords: 1000 } },
      { input: { unknownKey: true } },
      { chapterId: null },
    ];
    for (const item of cases) {
      const { task } = await createTask(fixture, item);
      await expect(runner.runOnce()).resolves.toBe('failed');
      expect((await taskRow(task.id)).errorCode).toBe('TASK_INPUT_INVALID');
    }
    expect(await db.chapterContract.count({ where: { workId: fixture.workId } })).toBe(0);
  });
});

describe('重试幂等：合同与候选复用', () => {
  it('Writer 超时重试不重复创建合同、不重复调用 Planner', async () => {
    const fixture = await newFixture();
    let writerCalls = 0;
    const { provider } = createChapterProvider(
      {
        writer: () => {
          writerCalls += 1;
          if (writerCalls === 1) {
            throw new ModelProviderError('MODEL_TIMEOUT', '模型服务超时', { retryable: true });
          }
          return { text: longDraft() };
        },
      },
      { plan: defaultPlannerOutput(fixture), text: longDraft() },
    );
    const { task } = await createTask(fixture);
    const runner = runnerFor(provider);

    await expect(runner.runOnce()).resolves.toBe('retried');
    expect(await db.chapterContract.count({ where: { generationTaskId: task.id } })).toBe(1);
    expect(
      await db.llmCallLog.count({
        where: { taskId: task.id, stage: 'agent:planner.chapter@1.0.0' },
      }),
    ).toBe(1);

    await expect(runner.runOnce()).resolves.toBe('succeeded');
    expect(await db.chapterContract.count({ where: { generationTaskId: task.id } })).toBe(1);
    expect(
      await db.llmCallLog.count({
        where: { taskId: task.id, stage: 'agent:planner.chapter@1.0.0' },
      }),
    ).toBe(1);
    expect(
      await db.llmCallLog.count({
        where: { taskId: task.id, stage: 'agent:writer.chapter@1.0.0' },
      }),
    ).toBe(2);
    expect(await db.chapterCandidate.count({ where: { generationTaskId: task.id } })).toBe(1);
    expect((await chapterRow(fixture.chapterId)).status).toBe('in_review');
  });

  it('已有候选（模拟写候选后崩溃）重试不重复插行、不再调模型', async () => {
    const fixture = await newFixture();
    const { task } = await createTask(fixture);
    const plan = defaultPlannerOutput(fixture);
    const text = longDraft();

    const contract = await db.chapterContract.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        generationTaskId: task.id,
        versionNo: 1,
        goal: String(plan['goal']),
        mustInclude: plan['mustInclude'] as never,
        mustNotInclude: plan['mustNotInclude'] as never,
        sceneBeats: {
          version: 1,
          characters: plan['characters'],
          scenes: plan['scenes'],
        } as never,
        targetWords: 3000,
      },
    });
    await db.chapterCandidate.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        generationTaskId: task.id,
        contractId: contract.id,
        content: text,
        wordCount: countWords(text),
        structuredPlan: { version: 1, contractId: contract.id },
      },
    });

    const provider: ModelProvider = {
      name: 'mock',
      defaultModel: 'mock-model',
      generateJson: () => {
        throw new Error('不应调用模型');
      },
      generateText: () => {
        throw new Error('不应调用模型');
      },
    };

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');
    expect(await db.chapterContract.count({ where: { generationTaskId: task.id } })).toBe(1);
    expect(await db.chapterCandidate.count({ where: { generationTaskId: task.id } })).toBe(1);
    expect(await db.llmCallLog.count({ where: { taskId: task.id } })).toBe(0);
    expect((await chapterRow(fixture.chapterId)).status).toBe('in_review');
  });
});

describe('合同与候选不可变（数据库触发器）', () => {
  it('合同不可更新/删除；候选除 candidate → adopted 外不可修改、不可删除；正常读取不受影响', async () => {
    const fixture = await newFixture();
    const { provider } = createChapterProvider(
      {},
      { plan: defaultPlannerOutput(fixture), text: longDraft() },
    );
    const { task } = await createTask(fixture);
    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');

    const contract = await db.chapterContract.findUniqueOrThrow({
      where: { generationTaskId: task.id },
    });
    const candidate = await db.chapterCandidate.findUniqueOrThrow({
      where: { generationTaskId: task.id },
    });

    // 额外建一份没有候选引用的合同：删除若失败只可能是不可变触发器（不是外键）。
    const { task: unusedTask } = await createTask(fixture);
    const unreferencedContract = await db.chapterContract.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        generationTaskId: unusedTask.id,
        versionNo: 2,
        goal: '第二版计划',
        mustInclude: [],
        mustNotInclude: [],
        sceneBeats: { version: 1, characters: [], scenes: [] },
        targetWords: 3000,
      },
    });
    await expect(
      db.chapterContract.delete({ where: { id: unreferencedContract.id } }),
    ).rejects.toThrow();

    await expect(
      db.chapterContract.update({ where: { id: contract.id }, data: { goal: '被篡改' } }),
    ).rejects.toThrow();
    await expect(
      db.chapterContract.update({
        where: { id: contract.id },
        data: { sceneBeats: { version: 1, characters: [], scenes: [] } },
      }),
    ).rejects.toThrow();
    await expect(db.chapterContract.delete({ where: { id: contract.id } })).rejects.toThrow();

    await expect(
      db.chapterCandidate.update({ where: { id: candidate.id }, data: { content: '被篡改' } }),
    ).rejects.toThrow();
    await expect(
      db.chapterCandidate.update({ where: { id: candidate.id }, data: { wordCount: 99_999 } }),
    ).rejects.toThrow();
    await expect(
      db.chapterCandidate.update({
        where: { id: candidate.id },
        data: { structuredPlan: { version: 9 } },
      }),
    ).rejects.toThrow();
    // A1-3A 起唯一允许的状态迁移是 candidate → adopted；其余修改仍然拒绝
    await db.chapterCandidate.update({
      where: { id: candidate.id },
      data: { status: 'adopted' },
    });
    await expect(
      db.chapterCandidate.update({ where: { id: candidate.id }, data: { content: '被篡改' } }),
    ).rejects.toThrow();
    await expect(
      db.chapterCandidate.update({ where: { id: candidate.id }, data: { status: 'candidate' } }),
    ).rejects.toThrow();
    await expect(db.chapterCandidate.delete({ where: { id: candidate.id } })).rejects.toThrow();

    // 正常读取（包括重试复用）不受影响
    expect((await db.chapterContract.findUniqueOrThrow({ where: { id: contract.id } })).goal).toBe(
      contract.goal,
    );
    expect(
      (await db.chapterCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).content,
    ).toBe(candidate.content);
  });
});

describe('取消、审计与隔离', () => {
  it('Writer 执行中取消 → cancelled，无候选，章节停在 drafting', async () => {
    const fixture = await newFixture();
    const { task } = await createTask(fixture);

    const provider: ModelProvider = {
      name: 'mock',
      defaultModel: 'mock-model',
      generateJson: (input: ModelJsonInput): Promise<ModelJsonResult> => {
        const system = input.messages[0]?.content ?? '';
        if (system.includes('planner.chapter')) {
          return Promise.resolve({
            json: defaultPlannerOutput(fixture),
            provider: 'mock',
            model: input.model,
            usage: { promptTokens: 10, completionTokens: 20 },
            latencyMs: 1,
          });
        }
        return db.generationTask
          .update({ where: { id: task.id }, data: { cancelRequestedAt: new Date() } })
          .then(() => ({
            json: { text: longDraft() },
            provider: 'mock',
            model: input.model,
            usage: { promptTokens: 10, completionTokens: 100 },
            latencyMs: 1,
          }));
      },
      generateText: (): Promise<ModelTextResult> => Promise.reject(new Error('not used')),
    };

    await expect(runnerFor(provider).runOnce()).resolves.toBe('cancelled');

    expect((await taskRow(task.id)).status).toBe('cancelled');
    expect(await db.chapterCandidate.count({ where: { workId: fixture.workId } })).toBe(0);
    expect((await chapterRow(fixture.chapterId)).status).toBe('drafting');
  });

  it('审计覆盖合同冻结、三次状态迁移与候选创建，且不含正文/密钥', async () => {
    const fixture = await newFixture();
    const text = longDraft();
    const { provider } = createChapterProvider({}, { plan: defaultPlannerOutput(fixture), text });
    const { task } = await createTask(fixture);

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');

    const logs = await db.auditLog.findMany({
      where: { targetType: 'chapter', targetId: fixture.chapterId },
      orderBy: { createdAt: 'asc' },
    });
    const actions = logs.map((log) => log.action);
    expect(actions).toContain(AUDIT_ACTIONS.CHAPTER_CONTRACT_FROZEN);
    expect(actions).toContain(AUDIT_ACTIONS.CHAPTER_CANDIDATE_CREATED);
    expect(
      actions.filter((action) => action === AUDIT_ACTIONS.CHAPTER_STATUS_CHANGED),
    ).toHaveLength(3);
    expect(logs.every((log) => log.actorId === fixture.authorId)).toBe(true);
    expect(logs.every((log) => log.targetId === fixture.chapterId)).toBe(true);

    const serialized = JSON.stringify(logs.map((log) => log.detail));
    expect(serialized).not.toContain(text.slice(0, 20));
    expect(serialized).not.toContain('吞星古卷');
    expect(serialized).not.toContain('sk-');
    expect(serialized).not.toContain(fixture.email);
    expect(await taskRow(task.id)).toMatchObject({ status: 'succeeded' });
  });

  it('跨作品上下文不会混入模型输入或 task_contexts', async () => {
    const fixture = await newFixture();
    const other = await newFixture('other');
    const { provider, calls } = createChapterProvider(
      {},
      { plan: defaultPlannerOutput(fixture), text: longDraft() },
    );
    const { task } = await createTask(fixture);

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');

    const plannerInput = calls.planner[0];
    expect(plannerInput).toBeDefined();
    const payloadText = lastUserContent(plannerInput as ModelJsonInput);
    expect(payloadText).toContain(fixture.characters[0]?.name ?? '');
    expect(payloadText).not.toContain(other.characters[0]?.name ?? '__none__');
    expect(payloadText).not.toContain(`吞星古卷-${other.tag}`);
    expect(payloadText).not.toContain(other.workTitle);
    expect(payloadText).not.toContain(other.email);
    expect(payloadText).not.toContain('argon2');

    const rows = await listTaskContexts(db, task.id);
    const refIds = new Set(rows.map((row) => row.refId));
    expect(refIds.has(fixture.chapterId)).toBe(true);
    expect(refIds.has(fixture.workId)).toBe(true);
    for (const entity of [...fixture.characters, ...fixture.realms, ...fixture.factions]) {
      expect(refIds.has(entity.id)).toBe(true);
    }
    expect(refIds.has(other.chapterId)).toBe(false);
    for (const entity of [...other.characters, ...other.realms, ...other.factions]) {
      expect(refIds.has(entity.id)).toBe(false);
    }
  });

  it('写入步骤 fencing：workerId 不匹配时拒绝写合同', async () => {
    const fixture = await newFixture();
    const { task } = await createTask(fixture);
    const claimed = await claimNextTask(db, { workerId: 'worker-a', leaseMs: 5_000 });
    expect(claimed?.id).toBe(task.id);

    const plan = normalizePlannerOutput(defaultPlannerOutput(fixture) as unknown as PlannerOutput, {
      allowedCharacters: fixture.characters.map((entity) => entity.name),
      targetWords: 3000,
    });
    await expect(
      freezeChapterContract({
        db,
        fence: {
          taskId: task.id,
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          workerId: 'worker-b',
          authorId: fixture.authorId,
        },
        plan,
      }),
    ).rejects.toMatchObject({ code: 'TASK_LEASE_LOST' });

    expect(await db.chapterContract.count({ where: { workId: fixture.workId } })).toBe(0);
    expect(await db.chapterCandidate.count({ where: { workId: fixture.workId } })).toBe(0);
    expect((await chapterRow(fixture.chapterId)).status).toBe('planned');
  });

  it('数据库复合外键拒绝跨作品的合同与跨任务的候选', async () => {
    const fixture = await newFixture();
    const other = await newFixture('other');
    const { task } = await createTask(fixture);
    const plan = defaultPlannerOutput(fixture);

    await expect(
      db.chapterContract.create({
        data: {
          workId: other.workId,
          chapterId: fixture.chapterId,
          generationTaskId: task.id,
          versionNo: 1,
          goal: String(plan['goal']),
          mustInclude: [],
          mustNotInclude: [],
          sceneBeats: { version: 1, characters: [], scenes: [] },
          targetWords: 3000,
        },
      }),
    ).rejects.toThrow();

    const contract = await db.chapterContract.create({
      data: {
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        generationTaskId: task.id,
        versionNo: 1,
        goal: String(plan['goal']),
        mustInclude: plan['mustInclude'] as never,
        mustNotInclude: plan['mustNotInclude'] as never,
        sceneBeats: {
          version: 1,
          characters: plan['characters'],
          scenes: plan['scenes'],
        } as never,
        targetWords: 3000,
      },
    });

    const { task: otherTask } = await createTask(fixture, { chapterId: fixture.chapterId });
    await expect(
      db.chapterCandidate.create({
        data: {
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          generationTaskId: otherTask.id,
          contractId: contract.id,
          content: longDraft(),
          wordCount: countWords(longDraft()),
          structuredPlan: { version: 1 },
        },
      }),
    ).rejects.toThrow();
  });
});
