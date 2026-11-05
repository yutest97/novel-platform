/**
 * 定稿章节摘要工作流（A2-D-B）。
 *
 * 使用真实 PostgreSQL + MockProvider + WorkerRunner，不接 HTTP / UI。
 * 覆盖：定稿同事务入队与幂等、默认 Mock 摘要、重试复用、skip 分支、
 * stale / 非定稿 / 跨作品隔离、取消与旧 Worker、非法输出、数据库约束、
 * LLM 日志、作者读接口过滤与 Worker 编排。
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@novel/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createChapterMockProvider } from '../src/chapter/mock.js';
import { finalizeChapter } from '../src/chapter/finalize.js';
import { saveHumanChapterVersion } from '../src/chapter/human.js';
import { createChapterReviewWorkflow } from '../src/chapter/review-workflow.js';
import { getChapterDetail, listChapters } from '../src/chapter/service.js';
import { createChapterSummaryWorkflow } from '../src/chapter/summary-workflow.js';
import { persistChapterSummary, summaryTaskRequestId } from '../src/chapter/summary.js';
import { CHAPTER_SUMMARIZER_MOCK_OUTPUT } from '../src/chapter/summarizer-mock.js';
import { SUMMARIZER_CHAPTER_AGENT } from '../src/chapter/summarizer.js';
import { CHAPTER_DRAFT_TASK_TYPE, CHAPTER_SUMMARY_TASK_TYPE } from '../src/chapter/types.js';
import { createChapterDraftWorkflow } from '../src/chapter/workflow.js';
import { WorkflowKernel, WorkflowRegistry } from '../src/kernel.js';
import { ModelProviderError, type ModelProvider } from '../src/model-types.js';
import {
  claimNextTask,
  completeTask,
  createGenerationTask,
  DEFAULT_MAX_ATTEMPTS,
  listTaskContexts,
  requestTaskCancellationForAuthor,
} from '../src/queue.js';
import { WorkerRunner } from '../src/worker.js';
import {
  createChapterFixture,
  createChapterProvider,
  longDraft,
  type ChapterFixture,
  type ChapterProvider,
} from './helpers/chapter.js';
import { cleanupWork, closeTestDb, silentLogger, testDb } from './helpers/db.js';

let db: PrismaClient;
let fixtures: ChapterFixture[] = [];

/** 定稿时由 API 层传入的服务端 provider / model。 */
const SUMMARY_SPEC = { provider: 'mock', model: 'mock-model' } as const;

beforeAll(() => {
  db = testDb();
});

afterEach(async () => {
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

/** 生产装配的镜像：同一个 Worker 注册 draft / review / summarize。 */
function runnerFor(provider: ModelProvider): WorkerRunner {
  const registry = new WorkflowRegistry();
  registry.register(createChapterDraftWorkflow({ db, provider }));
  registry.register(createChapterReviewWorkflow({ db, provider }));
  registry.register(createChapterSummaryWorkflow({ db, provider }));
  return new WorkerRunner(db, new WorkflowKernel(registry), {
    provider,
    workerId: 'summary-worker',
    leaseMs: 5_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 10,
    sweepIntervalMs: 10,
    logger: silentLogger,
  });
}

/** 保存一版人工正式版本（章节回到 in_review）。 */
async function saveVersion(
  fixture: ChapterFixture,
  content = longDraft(),
  baseVersionId: string | null = null,
) {
  return saveHumanChapterVersion({
    db,
    workId: fixture.workId,
    chapterId: fixture.chapterId,
    authorId: fixture.authorId,
    content,
    baseVersionId,
  });
}

async function finalize(fixture: ChapterFixture, versionId: string) {
  return finalizeChapter({
    db,
    workId: fixture.workId,
    chapterId: fixture.chapterId,
    authorId: fixture.authorId,
    versionId,
    summary: SUMMARY_SPEC,
  });
}

/** 定稿并返回版本与摘要任务。 */
async function finalizedVersion(
  fixture: ChapterFixture,
  content = longDraft(),
): Promise<{ versionId: string; versionNo: number; taskId: string }> {
  const saved = await saveVersion(fixture, content);
  const result = await finalize(fixture, saved.versionId);
  if (result.summaryTaskId === null) {
    throw new Error('测试期望配置可用时创建摘要任务');
  }
  return { versionId: saved.versionId, versionNo: saved.versionNo, taskId: result.summaryTaskId };
}

function providerWith(handlers: Parameters<typeof createChapterProvider>[0]): ChapterProvider {
  return createChapterProvider(handlers, { plan: {}, text: longDraft() });
}

async function summaryTaskRow(taskId: string) {
  return db.generationTask.findUniqueOrThrow({ where: { id: taskId } });
}

async function summaryRow(sourceVersionId: string) {
  return db.chapterSummary.findUnique({ where: { sourceVersionId } });
}

describe('定稿与摘要任务同事务入队', () => {
  it('首次定稿创建唯一的 chapter.summarize 任务', async () => {
    const fixture = await newFixture();
    const saved = await saveVersion(fixture);

    const result = await finalize(fixture, saved.versionId);
    expect(result).toMatchObject({
      status: 'finalized',
      versionId: saved.versionId,
      deduplicated: false,
      summaryTaskCreated: true,
    });

    const tasks = await db.generationTask.findMany({
      where: { chapterId: fixture.chapterId, taskType: CHAPTER_SUMMARY_TASK_TYPE },
    });
    expect(tasks).toHaveLength(1);

    const task = tasks[0];
    expect(task?.id).toBe(result.summaryTaskId);
    expect(task).toMatchObject({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      requestId: `summary:${saved.versionId}`,
      taskType: CHAPTER_SUMMARY_TASK_TYPE,
      status: 'queued',
      attemptCount: 0,
      lockedBy: null,
      provider: 'mock',
      model: 'mock-model',
    });
    expect(task?.requestId).toBe(summaryTaskRequestId(saved.versionId));
    expect(task?.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(task?.requestId.length).toBeLessThanOrEqual(128);
    expect(task?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    // 快照只有 sourceVersionId：不含正文 / prompt / 摘要 / 密钥
    expect(task?.inputSnapshot).toEqual({ sourceVersionId: saved.versionId });
    const serialized = JSON.stringify(task?.inputSnapshot);
    expect(serialized).not.toContain('风从演武场');
    expect(serialized.toLowerCase()).not.toContain('prompt');
    expect(serialized).not.toContain('summary');
  });

  it('同版本重复定稿不重复建任务', async () => {
    const fixture = await newFixture();
    const { versionId, taskId } = await finalizedVersion(fixture);

    const again = await finalize(fixture, versionId);
    expect(again).toMatchObject({ deduplicated: true, summaryTaskCreated: false });
    expect(again.summaryTaskId).toBe(taskId);
    expect(
      await db.generationTask.count({
        where: { chapterId: fixture.chapterId, taskType: CHAPTER_SUMMARY_TASK_TYPE },
      }),
    ).toBe(1);
  });

  it('已定稿但任务缺失时由幂等定稿补齐（崩溃恢复）', async () => {
    const fixture = await newFixture();
    const { versionId, taskId } = await finalizedVersion(fixture);

    await db.generationTask.delete({ where: { id: taskId } });
    expect(await db.generationTask.count({ where: { chapterId: fixture.chapterId } })).toBe(0);

    const recovered = await finalize(fixture, versionId);
    expect(recovered).toMatchObject({ deduplicated: true, summaryTaskCreated: true });

    const tasks = await db.generationTask.findMany({
      where: { chapterId: fixture.chapterId, taskType: CHAPTER_SUMMARY_TASK_TYPE },
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.inputSnapshot).toEqual({ sourceVersionId: versionId });
  });

  it('模型配置漂移时复用既有任务，不覆盖 provider / model', async () => {
    const fixture = await newFixture();
    const { versionId, taskId } = await finalizedVersion(fixture);

    // 同一 sourceVersion 的幂等定稿：即使当前配置与旧 task 不同，也必须复用
    const drifted = await finalizeChapter({
      db,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      versionId,
      summary: { provider: 'openai-compatible', model: 'gpt-4o-mini' },
    });
    expect(drifted).toMatchObject({
      deduplicated: true,
      summaryTaskId: taskId,
      summaryTaskCreated: false,
    });

    const task = await summaryTaskRow(taskId);
    expect(task).toMatchObject({ provider: 'mock', model: 'mock-model' });
    expect(
      await db.generationTask.count({
        where: { chapterId: fixture.chapterId, taskType: CHAPTER_SUMMARY_TASK_TYPE },
      }),
    ).toBe(1);
  });

  it('模型配置不可用时定稿照常成功，配置恢复后幂等定稿补齐任务', async () => {
    const fixture = await newFixture();
    const saved = await saveVersion(fixture);

    // summary: null 表示服务端解析不到可用模型配置：只跳过摘要调度
    const skipped = await finalizeChapter({
      db,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      authorId: fixture.authorId,
      versionId: saved.versionId,
      summary: null,
    });
    expect(skipped).toMatchObject({
      status: 'finalized',
      versionId: saved.versionId,
      deduplicated: false,
      summaryTaskId: null,
      summaryTaskCreated: false,
    });
    expect((await db.chapter.findUniqueOrThrow({ where: { id: fixture.chapterId } })).status).toBe(
      'finalized',
    );
    expect(
      await db.generationTask.count({
        where: { chapterId: fixture.chapterId, taskType: CHAPTER_SUMMARY_TASK_TYPE },
      }),
    ).toBe(0);

    // 配置恢复后同版本幂等定稿补齐任务
    const recovered = await finalize(fixture, saved.versionId);
    expect(recovered).toMatchObject({
      deduplicated: true,
      summaryTaskCreated: true,
    });
    expect(recovered.summaryTaskId).not.toBeNull();
    expect(
      await db.generationTask.count({
        where: { chapterId: fixture.chapterId, taskType: CHAPTER_SUMMARY_TASK_TYPE },
      }),
    ).toBe(1);
  });

  it('定稿被拒绝时不创建摘要任务', async () => {
    const fixture = await newFixture();
    const saved = await saveVersion(fixture);
    // 版本 id 换成不存在的 uuid：稳定冲突，不写任何任务
    await expect(finalize(fixture, randomUUID())).rejects.toMatchObject({
      code: 'CHAPTER_VERSION_CONFLICT',
    });
    expect(await db.generationTask.count({ where: { chapterId: fixture.chapterId } })).toBe(0);
    expect(await db.chapterSummary.count({ where: { chapterId: fixture.chapterId } })).toBe(0);
    expect((await db.chapter.findUniqueOrThrow({ where: { id: fixture.chapterId } })).status).toBe(
      'in_review',
    );

    // 合法定稿后只有一个任务
    await finalize(fixture, saved.versionId);
    expect(
      await db.generationTask.count({
        where: { chapterId: fixture.chapterId, taskType: CHAPTER_SUMMARY_TASK_TYPE },
      }),
    ).toBe(1);
  });
});

describe('摘要工作流与幂等', () => {
  it('默认 Mock 完成摘要，表行与 agent / provider / model 正确', async () => {
    const fixture = await newFixture();
    const { versionId, taskId } = await finalizedVersion(fixture);
    const provider = createChapterMockProvider();

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');

    const task = await summaryTaskRow(taskId);
    expect(task.status).toBe('succeeded');
    expect(task.currentStep).toBe('persist_summary');
    expect(task.attemptCount).toBe(1);

    const row = await summaryRow(versionId);
    expect(row).toMatchObject({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      sourceVersionId: versionId,
      agentName: SUMMARIZER_CHAPTER_AGENT.name,
      agentVersion: SUMMARIZER_CHAPTER_AGENT.promptVersion,
      provider: 'mock',
      model: 'mock-model',
      summary: CHAPTER_SUMMARIZER_MOCK_OUTPUT.summary,
    });

    // 章节仍是定稿，摘要不改变章节 / 版本
    expect((await db.chapter.findUniqueOrThrow({ where: { id: fixture.chapterId } })).status).toBe(
      'finalized',
    );
    expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(1);
  });

  it('同 sourceVersion 重试复用同一任务，只写一条摘要', async () => {
    const fixture = await newFixture();
    const { versionId, taskId } = await finalizedVersion(fixture);
    let calls = 0;
    const { provider } = providerWith({
      summarizer: () => {
        calls += 1;
        if (calls === 1) {
          throw new ModelProviderError('MODEL_NETWORK_ERROR', '网络不可用', { retryable: true });
        }
        return { summary: '重试后的确定性摘要。' };
      },
    });

    const runner = runnerFor(provider);
    await expect(runner.runOnce()).resolves.toBe('retried');
    expect(await summaryRow(versionId)).toBeNull();

    await expect(runner.runOnce()).resolves.toBe('succeeded');

    const task = await summaryTaskRow(taskId);
    expect(task.attemptCount).toBe(2);
    expect(task.status).toBe('succeeded');
    expect(await db.chapterSummary.count({ where: { chapterId: fixture.chapterId } })).toBe(1);
    expect((await summaryRow(versionId))?.summary).toBe('重试后的确定性摘要。');
  });

  it('已有同版本摘要时新任务直接跳过，不调用模型', async () => {
    const fixture = await newFixture();
    const { versionId } = await finalizedVersion(fixture);
    const { provider, calls } = providerWith({});

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');
    expect(calls.summarizer).toHaveLength(1);

    // 另一条指向同一版本的任务（不同 requestId）必须跳过模型调用
    const { task } = await createGenerationTask(db, {
      authorId: fixture.authorId,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      requestId: `summary-dup-${randomUUID()}`,
      taskType: CHAPTER_SUMMARY_TASK_TYPE,
      inputSnapshot: { sourceVersionId: versionId },
      provider: 'mock',
      model: 'mock-model',
    });

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');
    expect((await summaryTaskRow(task.id)).status).toBe('succeeded');
    expect(calls.summarizer).toHaveLength(1);
    expect(await db.chapterSummary.count({ where: { chapterId: fixture.chapterId } })).toBe(1);
  });

  it('task_contexts 只记录章节与版本标识，不含正文', async () => {
    const fixture = await newFixture();
    const { versionId, taskId } = await finalizedVersion(fixture);
    await expect(runnerFor(createChapterMockProvider()).runOnce()).resolves.toBe('succeeded');

    const contexts = await listTaskContexts(db, taskId);
    expect(contexts.map((row) => row.contextType).sort()).toEqual(['chapter', 'chapter_version']);
    const text = contexts.map((row) => row.snippet ?? '').join('\n');
    expect(text).not.toContain('风从演武场');
    expect(contexts.some((row) => row.refId === versionId)).toBe(true);
    expect(contexts.some((row) => row.refId === fixture.chapterId)).toBe(true);
  });
});

describe('拒绝非定稿 / 旧版本 / 跨作品', () => {
  it('章节未定稿时失败，不写摘要', async () => {
    const fixture = await newFixture();
    const saved = await saveVersion(fixture);
    const { task } = await createGenerationTask(db, {
      authorId: fixture.authorId,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      requestId: `summary-manual-${randomUUID()}`,
      taskType: CHAPTER_SUMMARY_TASK_TYPE,
      inputSnapshot: { sourceVersionId: saved.versionId },
      provider: 'mock',
      model: 'mock-model',
    });

    await expect(runnerFor(createChapterMockProvider()).runOnce()).resolves.toBe('failed');
    expect((await summaryTaskRow(task.id)).errorCode).toBe('SUMMARY_CHAPTER_NOT_FINALIZED');
    expect(await db.chapterSummary.count({ where: { chapterId: fixture.chapterId } })).toBe(0);
  });

  it('旧版本任务在章节重新定稿后变为 stale', async () => {
    const fixture = await newFixture();
    const first = await finalizedVersion(fixture);

    // 人工 revision：章节回到 in_review，产生新版本
    const second = await saveVersion(fixture, longDraft('第二版'), first.versionId);
    await finalize(fixture, second.versionId);

    await expect(runnerFor(createChapterMockProvider()).runOnce()).resolves.toBe('failed');

    const oldTask = await summaryTaskRow(first.taskId);
    expect(oldTask.status).toBe('failed');
    expect(oldTask.errorCode).toBe('SUMMARY_SOURCE_VERSION_STALE');
    expect(await summaryRow(first.versionId)).toBeNull();

    // 新版本的任务仍可成功
    await expect(runnerFor(createChapterMockProvider()).runOnce()).resolves.toBe('succeeded');
    expect((await summaryRow(second.versionId))?.summary).toBe(
      CHAPTER_SUMMARIZER_MOCK_OUTPUT.summary,
    );
  });

  it('跨作品版本被拒绝，且不写摘要', async () => {
    const fixture = await newFixture();
    const other = await newFixture();
    const own = await finalizedVersion(fixture);
    const otherFinalized = await finalizedVersion(other);
    const otherVersionId = otherFinalized.versionId;
    // 清掉两个作品自动入队的摘要任务，保证 runOnce 领到本用例新建的任务
    await db.generationTask.deleteMany({
      where: { id: { in: [own.taskId, otherFinalized.taskId] } },
    });

    const { task } = await createGenerationTask(db, {
      authorId: fixture.authorId,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      requestId: `summary-cross-${randomUUID()}`,
      taskType: CHAPTER_SUMMARY_TASK_TYPE,
      inputSnapshot: { sourceVersionId: otherVersionId },
      provider: 'mock',
      model: 'mock-model',
    });

    await expect(runnerFor(createChapterMockProvider()).runOnce()).resolves.toBe('failed');
    expect((await summaryTaskRow(task.id)).errorCode).toBe('SUMMARY_SOURCE_VERSION_STALE');
    expect(await db.chapterSummary.count({ where: { workId: fixture.workId } })).toBe(0);
    expect(await db.chapterSummary.count({ where: { workId: other.workId } })).toBe(0);
  });

  it('模型调用期间发生 revision → 提交阶段 stale，不写摘要', async () => {
    const fixture = await newFixture();
    const { versionId, taskId } = await finalizedVersion(fixture);

    // MockProvider 的响应函数必须同步返回 JSON，因此这里用一个自定义 Provider
    // 在模型"调用期间"保存新 revision。
    const provider: ModelProvider = {
      name: 'mock',
      defaultModel: 'mock-model',
      generateJson: async (input) => {
        expect(input.messages[0]?.content).toContain('summarizer.chapter');
        await saveVersion(fixture, longDraft('并发修订'), versionId);
        return {
          json: { summary: '旧版本摘要不应写入。' },
          provider: 'mock',
          model: input.model,
          usage: { promptTokens: 1, completionTokens: 1 },
          latencyMs: 0,
        };
      },
      generateText: () => Promise.reject(new Error('摘要任务不应走文本生成')),
    };

    await expect(runnerFor(provider).runOnce()).resolves.toBe('failed');

    const task = await summaryTaskRow(taskId);
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('SUMMARY_SOURCE_VERSION_STALE');
    expect(await summaryRow(versionId)).toBeNull();

    // 章节与版本状态由人工保存决定，摘要失败不改变它们
    expect((await db.chapter.findUniqueOrThrow({ where: { id: fixture.chapterId } })).status).toBe(
      'in_review',
    );
    expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(2);
  });
});

describe('取消、旧 Worker 与失败隔离', () => {
  it('取消后不写摘要，章节仍是定稿', async () => {
    const fixture = await newFixture();
    const { versionId, taskId } = await finalizedVersion(fixture);

    const claimed = await claimNextTask(db, { workerId: 'cancel-worker', leaseMs: 5_000 });
    expect(claimed?.id).toBe(taskId);

    await requestTaskCancellationForAuthor(db, {
      authorId: fixture.authorId,
      workId: fixture.workId,
      taskId,
    });
    await expect(completeTask(db, { taskId, workerId: 'cancel-worker' })).resolves.toBe(
      'cancelled',
    );

    expect(await summaryRow(versionId)).toBeNull();
    expect((await summaryTaskRow(taskId)).status).toBe('cancelled');
    expect((await db.chapter.findUniqueOrThrow({ where: { id: fixture.chapterId } })).status).toBe(
      'finalized',
    );
  });

  it('旧 Worker 晚返回不能写摘要', async () => {
    const fixture = await newFixture();
    const { versionId, taskId } = await finalizedVersion(fixture);
    await expect(runnerFor(createChapterMockProvider()).runOnce()).resolves.toBe('succeeded');
    const before = await summaryRow(versionId);

    await expect(
      persistChapterSummary({
        db,
        fence: {
          taskId,
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          sourceVersionId: versionId,
          workerId: 'stale-worker',
        },
        output: { summary: '旧 Worker 的晚返回' },
        provider: 'mock',
        model: 'mock-model',
      }),
    ).rejects.toMatchObject({ code: 'TASK_LEASE_LOST' });

    const after = await summaryRow(versionId);
    expect(after?.summary).toBe(before?.summary);
    expect(await db.chapterSummary.count({ where: { chapterId: fixture.chapterId } })).toBe(1);
  });

  it('非法摘要输出使任务失败，定稿与版本不受损', async () => {
    const fixture = await newFixture();
    const { versionId, taskId } = await finalizedVersion(fixture);
    const { provider } = providerWith({ summarizer: () => ({ summary: '   ' }) });

    await expect(runnerFor(provider).runOnce()).resolves.toBe('failed');

    const task = await summaryTaskRow(taskId);
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('AGENT_OUTPUT_INVALID');
    expect(await summaryRow(versionId)).toBeNull();
    expect((await db.chapter.findUniqueOrThrow({ where: { id: fixture.chapterId } })).status).toBe(
      'finalized',
    );
    expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(1);
  });
});

describe('摘要表的数据库约束', () => {
  it('单版本唯一 / 复合外键 / 长度与空白 CHECK / append-only', async () => {
    const fixture = await newFixture();
    const { versionId } = await finalizedVersion(fixture);
    await expect(runnerFor(createChapterMockProvider()).runOnce()).resolves.toBe('succeeded');
    const row = await db.chapterSummary.findUniqueOrThrow({
      where: { sourceVersionId: versionId },
    });

    // 每版最多一条
    await expect(
      db.chapterSummary.create({
        data: {
          workId: fixture.workId,
          chapterId: fixture.chapterId,
          sourceVersionId: versionId,
          agentName: 'summarizer.chapter',
          agentVersion: '1.0.0',
          provider: 'mock',
          model: 'mock-model',
          summary: '重复摘要',
        },
      }),
    ).rejects.toThrow();

    // 复合外键：把摘要挂到别的作品 / 章节组合上被拒绝
    const other = await newFixture();
    await expect(
      db.chapterSummary.create({
        data: {
          workId: other.workId,
          chapterId: other.chapterId,
          sourceVersionId: versionId,
          agentName: 'summarizer.chapter',
          agentVersion: '1.0.0',
          provider: 'mock',
          model: 'mock-model',
          summary: '跨作品摘要',
        },
      }),
    ).rejects.toThrow();

    // 长度 / 空白 CHECK
    const extra = await newFixture();
    const extraVersion = await saveVersion(extra);
    for (const summary of ['   ', '', '摘'.repeat(1001)]) {
      await expect(
        db.chapterSummary.create({
          data: {
            workId: extra.workId,
            chapterId: extra.chapterId,
            sourceVersionId: extraVersion.versionId,
            agentName: 'summarizer.chapter',
            agentVersion: '1.0.0',
            provider: 'mock',
            model: 'mock-model',
            summary,
          },
        }),
      ).rejects.toThrow();
    }

    // append-only
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "chapter_summaries" SET "summary" = 'x' WHERE "id" = $1`,
        row.id,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.$executeRawUnsafe(`DELETE FROM "chapter_summaries" WHERE "id" = $1`, row.id),
    ).rejects.toThrow(/append-only/);
  });
});

describe('LLM 日志与作者读接口', () => {
  it('成功调用写且只写一条 llm_call_logs，不含正文', async () => {
    const fixture = await newFixture();
    const content = longDraft();
    const { versionId, taskId } = await finalizedVersion(fixture, content);
    await expect(runnerFor(createChapterMockProvider()).runOnce()).resolves.toBe('succeeded');

    const logs = await db.llmCallLog.findMany({ where: { taskId } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      stage: `agent:${SUMMARIZER_CHAPTER_AGENT.name}@${SUMMARIZER_CHAPTER_AGENT.promptVersion}`,
      provider: 'mock',
      model: 'mock-model',
      success: true,
      errorCode: null,
    });
    expect(logs[0]?.promptTokens).toBeGreaterThan(0);
    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain(content.slice(0, 24));
    expect(serialized).not.toContain((await summaryRow(versionId))?.summary.slice(0, 12) ?? '');
  });

  it('失败调用同样只写一条 success=false 的日志', async () => {
    const fixture = await newFixture();
    const { taskId } = await finalizedVersion(fixture);
    const { provider } = providerWith({ summarizer: () => ({ summary: '' }) });

    await expect(runnerFor(provider).runOnce()).resolves.toBe('failed');

    const logs = await db.llmCallLog.findMany({ where: { taskId } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ success: false, errorCode: 'AGENT_OUTPUT_INVALID' });
  });

  it('章节详情 / 列表不把 summary 任务当成最新正文任务', async () => {
    const fixture = await newFixture();
    // 先放一条正文任务，便于断言"最新正文任务"仍是它
    const { task: draftTask } = await createGenerationTask(db, {
      authorId: fixture.authorId,
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      requestId: `req-${randomUUID()}`,
      taskType: CHAPTER_DRAFT_TASK_TYPE,
      inputSnapshot: { targetWords: 3000 },
      provider: 'mock',
      model: 'mock-model',
    });
    await finalizedVersion(fixture);

    const detail = await getChapterDetail({
      db,
      workId: fixture.workId,
      authorId: fixture.authorId,
      chapterId: fixture.chapterId,
    });
    expect(detail.latestTask?.id).toBe(draftTask.id);
    expect(detail.latestTask?.status).toBe('queued');

    const list = await listChapters({ db, workId: fixture.workId, authorId: fixture.authorId });
    expect(list[0]).toMatchObject({ latestTaskStatus: 'queued' });

    // summary 任务确实存在，但不出现在读接口里
    expect(
      await db.generationTask.count({
        where: { chapterId: fixture.chapterId, taskType: CHAPTER_SUMMARY_TASK_TYPE },
      }),
    ).toBe(1);
  });

  it('Worker 注册后能领取并完成 summary 任务，且不串错 Agent', async () => {
    const fixture = await newFixture();
    const { taskId } = await finalizedVersion(fixture);
    const { provider, calls } = providerWith({});

    await expect(runnerFor(provider).runOnce()).resolves.toBe('succeeded');
    await expect(runnerFor(provider).runOnce()).resolves.toBe('idle');

    expect((await summaryTaskRow(taskId)).status).toBe('succeeded');
    expect(calls.summarizer).toHaveLength(1);
    // 摘要任务不会触发 planner / writer / reviewer
    expect(calls.planner).toHaveLength(0);
    expect(calls.writer).toHaveLength(0);
    expect(calls.reviewer).toHaveLength(0);
  });
});
