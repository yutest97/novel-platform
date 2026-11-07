/**
 * C1-B-A1：故事候选数据域与服务层真实 PostgreSQL 集成测试。
 *
 * 覆盖：
 * - artifact / revision / decision 的复合外键、唯一性、CHECK、append-only；
 * - artifact 状态机与 rejected → 新 revision → draft、approved 终态；
 * - current_revision 与 revision 最大编号一致（延迟约束触发器）；
 * - 服务层首次生成、内容幂等、拒绝后新 revision、批准后禁止生成；
 * - 申请确认 / 作者决定与 run 状态迁移；
 * - 同决定幂等、不同决定冲突、旧版本 / 旧 revision 冲突、跨作者 404；
 * - 事务失败不留半条数据、旧 Worker 晚返回不覆盖新状态；
 * - 失败调用的 provider / model / usage 安全遥测。
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@novel/db';
import { AuthError } from '@novel/auth';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AgentOutputInvalidError } from '../src/agent.js';
import {
  NOVEL_ARTIFACT_TYPE_CONCEPT,
  NOVEL_CONCEPT_AGENT,
  NOVEL_CONCEPT_MOCK_OUTPUT,
  NOVEL_CONCEPT_SCHEMA_VERSION,
  createConceptCandidate,
  createNovelConceptMockProvider,
  decideConceptArtifact,
  readConceptArtifact,
  requestConceptApproval,
  startNovelRun,
  type NovelConceptOutput,
} from '../src/index.js';
import type {
  ModelJsonInput,
  ModelJsonResult,
  ModelProvider,
  ModelTextResult,
  ModelUsage,
} from '../src/model-types.js';
import { MockProvider } from '../src/providers/mock.js';
import { cleanupUser, closeTestDb, createTestUser, testDb } from './helpers/db.js';

let db: PrismaClient;
let authorId: string;
let otherAuthorId: string;
const createdRuns: string[] = [];

beforeAll(async () => {
  db = testDb();
  authorId = (await createTestUser(db, 'author')).id;
  otherAuthorId = (await createTestUser(db, 'author')).id;
});

beforeEach(() => {
  createdRuns.length = 0;
});

afterEach(async () => {
  if (createdRuns.length === 0) {
    return;
  }
  // 五张表都有 append-only / 不可删除 / 延迟一致性触发器；清理只用于测试库。
  await db.$transaction(
    async (tx) => {
      for (const table of [
        'novel_artifact_decisions',
        'novel_artifact_revisions',
        'novel_artifacts',
        'novel_agent_calls',
        'novel_run_steps',
        'novel_runs',
      ]) {
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
      }
      await tx.novelArtifactDecision.deleteMany({
        where: { artifact: { runId: { in: createdRuns } } },
      });
      await tx.novelArtifactRevision.deleteMany({ where: { runId: { in: createdRuns } } });
      await tx.novelArtifact.deleteMany({ where: { runId: { in: createdRuns } } });
      await tx.novelAgentCall.deleteMany({ where: { runId: { in: createdRuns } } });
      await tx.novelRunStep.deleteMany({ where: { runId: { in: createdRuns } } });
      await tx.novelRun.deleteMany({ where: { id: { in: createdRuns } } });
      for (const table of [
        'novel_runs',
        'novel_run_steps',
        'novel_agent_calls',
        'novel_artifacts',
        'novel_artifact_revisions',
        'novel_artifact_decisions',
      ]) {
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
      }
    },
    { maxWait: 15_000, timeout: 30_000 },
  );
});

afterAll(async () => {
  await cleanupUser(db, otherAuthorId);
  await cleanupUser(db, authorId);
  await closeTestDb();
});

async function startRun(owner = authorId, requestText = '想写一个悬疑向的东方玄幻长篇。') {
  const run = await startNovelRun(db, { authorId: owner, requestText });
  createdRuns.push(run.runId);
  return run;
}

async function createCandidate(
  runId: string,
  provider: ModelProvider = createNovelConceptMockProvider(),
  owner = authorId,
) {
  return createConceptCandidate(db, {
    authorId: owner,
    runId,
    provider,
  });
}

function variantProvider(logline: string): ModelProvider {
  return new MockProvider({
    json: { ...NOVEL_CONCEPT_MOCK_OUTPUT, logline },
    model: 'mock-concept',
  });
}

async function expectAuthError(promise: Promise<unknown>, code: string): Promise<AuthError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    const authError = error as AuthError;
    expect(authError.code).toBe(code);
    return authError;
  }
  throw new Error(`预期抛出 ${code}，实际成功`);
}

async function artifactRow(runId: string) {
  return db.novelArtifact.findUnique({
    where: { runId_artifactType: { runId, artifactType: NOVEL_ARTIFACT_TYPE_CONCEPT } },
    select: { id: true, status: true, currentRevision: true },
  });
}

async function revisionRows(artifactId: string) {
  return db.novelArtifactRevision.findMany({
    where: { artifactId },
    orderBy: { revisionNo: 'asc' },
    select: { revisionNo: true, content: true },
  });
}

async function decisionRows(artifactId: string) {
  return db.novelArtifactDecision.findMany({
    where: { artifactId },
    select: { revisionNo: true, decision: true, authorId: true },
  });
}

/** 直接创建 artifact + revision 1（绕过服务层，用于数据域测试）。 */
async function createArtifactDirect(
  runId: string,
  owner = authorId,
  content: NovelConceptOutput = NOVEL_CONCEPT_MOCK_OUTPUT,
) {
  const artifactId = randomUUID();
  await db.$transaction(async (tx) => {
    await tx.novelArtifact.create({
      data: {
        id: artifactId,
        runId,
        authorId: owner,
        workId: null,
        artifactType: NOVEL_ARTIFACT_TYPE_CONCEPT,
        status: 'draft',
        currentRevision: 1,
      },
    });
    await tx.novelArtifactRevision.create({
      data: {
        artifactId,
        runId,
        authorId: owner,
        revisionNo: 1,
        schemaVersion: NOVEL_CONCEPT_SCHEMA_VERSION,
        content: content as unknown as never,
        sourceAgent: NOVEL_CONCEPT_AGENT.name,
        sourceAgentVersion: NOVEL_CONCEPT_AGENT.promptVersion,
        sourceStepId: null,
      },
    });
  });
  return artifactId;
}

async function createDecisionDirect(artifactId: string, revisionNo: number, owner = authorId) {
  return db.novelArtifactDecision.create({
    data: {
      artifactId,
      revisionNo,
      authorId: owner,
      decision: 'approved',
    },
    select: { id: true },
  });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('故事候选数据域', () => {
  it('复合外键：artifact 的 author 必须等于 run 的 author', async () => {
    const run = await startRun();
    await expect(
      db.novelArtifact.create({
        data: {
          runId: run.runId,
          authorId: otherAuthorId,
          workId: null,
          artifactType: NOVEL_ARTIFACT_TYPE_CONCEPT,
          status: 'draft',
          currentRevision: 1,
        },
      }),
    ).rejects.toThrow();
  });

  it('唯一性：同一 run 同一类型只能有一个 artifact', async () => {
    const run = await startRun();
    await createArtifactDirect(run.runId);
    await expect(createArtifactDirect(run.runId)).rejects.toThrow();
  });

  it('revision 必须钉在同一 run / author 的 artifact 上', async () => {
    const run = await startRun();
    const otherRun = await startRun();
    const artifactId = await createArtifactDirect(run.runId);
    await expect(
      db.novelArtifactRevision.create({
        data: {
          artifactId,
          runId: otherRun.runId,
          authorId,
          revisionNo: 2,
          schemaVersion: NOVEL_CONCEPT_SCHEMA_VERSION,
          content: NOVEL_CONCEPT_MOCK_OUTPUT as unknown as never,
          sourceAgent: NOVEL_CONCEPT_AGENT.name,
          sourceAgentVersion: NOVEL_CONCEPT_AGENT.promptVersion,
          sourceStepId: null,
        },
      }),
    ).rejects.toThrow();
  });

  it('revision 与 decision 都是 append-only', async () => {
    const run = await startRun();
    const artifactId = await createArtifactDirect(run.runId);
    await expect(
      db.novelArtifactRevision.update({
        where: { artifactId_revisionNo: { artifactId, revisionNo: 1 } },
        data: { schemaVersion: 'concept@2.0.0' },
      }),
    ).rejects.toThrow();
    await expect(
      db.novelArtifactRevision.delete({
        where: { artifactId_revisionNo: { artifactId, revisionNo: 1 } },
      }),
    ).rejects.toThrow();
  });

  it('artifact 不可删除且核心归属列不可修改', async () => {
    const run = await startRun();
    const artifactId = await createArtifactDirect(run.runId);
    await expect(db.novelArtifact.delete({ where: { id: artifactId } })).rejects.toThrow();
    await expect(
      db.novelArtifact.update({ where: { id: artifactId }, data: { artifactType: 'world' } }),
    ).rejects.toThrow();
    await expect(
      db.novelArtifact.update({ where: { id: artifactId }, data: { authorId: otherAuthorId } }),
    ).rejects.toThrow();
  });

  it('content 必须是 object 且序列化长度不超过 131072', async () => {
    const run = await startRun();
    const artifactId = await createArtifactDirect(run.runId);
    await expect(
      db.novelArtifactRevision.create({
        data: {
          artifactId,
          runId: run.runId,
          authorId,
          revisionNo: 2,
          schemaVersion: NOVEL_CONCEPT_SCHEMA_VERSION,
          content: { huge: 'x'.repeat(131_073) } as unknown as never,
          sourceAgent: NOVEL_CONCEPT_AGENT.name,
          sourceAgentVersion: NOVEL_CONCEPT_AGENT.promptVersion,
          sourceStepId: null,
        },
      }),
    ).rejects.toThrow();
  });

  it('current_revision 必须与 revision 最大编号一致', async () => {
    const run = await startRun();
    const artifactId = await createArtifactDirect(run.runId);
    await expect(
      db.$transaction(async (tx) => {
        await tx.novelArtifactRevision.create({
          data: {
            artifactId,
            runId: run.runId,
            authorId,
            revisionNo: 2,
            schemaVersion: NOVEL_CONCEPT_SCHEMA_VERSION,
            content: NOVEL_CONCEPT_MOCK_OUTPUT as unknown as never,
            sourceAgent: NOVEL_CONCEPT_AGENT.name,
            sourceAgentVersion: NOVEL_CONCEPT_AGENT.promptVersion,
            sourceStepId: null,
          },
        });
      }),
    ).rejects.toThrow();
  });

  it('状态机：draft → pending → approved，approved 后禁止新 revision', async () => {
    const run = await startRun();
    const artifactId = await createArtifactDirect(run.runId);
    await db.novelArtifact.update({
      where: { id: artifactId },
      data: { status: 'pending_approval' },
    });
    // 没有 decision 不能直接 approved
    await expect(
      db.novelArtifact.update({ where: { id: artifactId }, data: { status: 'approved' } }),
    ).rejects.toThrow();
    await db.$transaction(async (tx) => {
      await tx.novelArtifactDecision.create({
        data: { artifactId, revisionNo: 1, authorId, decision: 'approved' },
      });
      await tx.novelArtifact.update({ where: { id: artifactId }, data: { status: 'approved' } });
    });
    await expect(
      db.novelArtifactRevision.create({
        data: {
          artifactId,
          runId: run.runId,
          authorId,
          revisionNo: 2,
          schemaVersion: NOVEL_CONCEPT_SCHEMA_VERSION,
          content: NOVEL_CONCEPT_MOCK_OUTPUT as unknown as never,
          sourceAgent: NOVEL_CONCEPT_AGENT.name,
          sourceAgentVersion: NOVEL_CONCEPT_AGENT.promptVersion,
          sourceStepId: null,
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.novelArtifact.update({ where: { id: artifactId }, data: { status: 'draft' } }),
    ).rejects.toThrow();
  });

  it('rejected → 新 revision 回到 draft，且旧 revision 决定保留', async () => {
    const run = await startRun();
    const artifactId = await createArtifactDirect(run.runId);
    await db.novelArtifact.update({
      where: { id: artifactId },
      data: { status: 'pending_approval' },
    });
    await db.$transaction(async (tx) => {
      await tx.novelArtifactDecision.create({
        data: { artifactId, revisionNo: 1, authorId, decision: 'rejected' },
      });
      await tx.novelArtifact.update({ where: { id: artifactId }, data: { status: 'rejected' } });
    });
    await db.$transaction(async (tx) => {
      await tx.novelArtifactRevision.create({
        data: {
          artifactId,
          runId: run.runId,
          authorId,
          revisionNo: 2,
          schemaVersion: NOVEL_CONCEPT_SCHEMA_VERSION,
          content: NOVEL_CONCEPT_MOCK_OUTPUT as unknown as never,
          sourceAgent: NOVEL_CONCEPT_AGENT.name,
          sourceAgentVersion: NOVEL_CONCEPT_AGENT.promptVersion,
          sourceStepId: null,
        },
      });
      await tx.novelArtifact.update({
        where: { id: artifactId },
        data: { currentRevision: 2, status: 'draft' },
      });
    });
    const artifact = await artifactRow(run.runId);
    expect(artifact?.status).toBe('draft');
    expect(artifact?.currentRevision).toBe(2);
    expect((await decisionRows(artifactId)).map((row) => row.revisionNo)).toEqual([1]);
  });

  it('decision 只能针对 pending 的当前 revision，且 author 必须等于 artifact author', async () => {
    const run = await startRun();
    const artifactId = await createArtifactDirect(run.runId);
    // draft 状态下不能写 decision
    await expect(createDecisionDirect(artifactId, 1)).rejects.toThrow();
    await db.novelArtifact.update({
      where: { id: artifactId },
      data: { status: 'pending_approval' },
    });
    // 非当前 revision 不能写 decision
    await expect(createDecisionDirect(artifactId, 2)).rejects.toThrow();
    // 他人不能替作者决定
    await expect(createDecisionDirect(artifactId, 1, otherAuthorId)).rejects.toThrow();
    // decision 值只能是 approved / rejected
    await expect(
      db.novelArtifactDecision.create({
        data: { artifactId, revisionNo: 1, authorId, decision: 'maybe' },
      }),
    ).rejects.toThrow();
    // 同一 revision 只能一条 decision
    await createDecisionDirect(artifactId, 1);
    await expect(createDecisionDirect(artifactId, 1)).rejects.toThrow();
  });
});

describe('Concept 候选服务层', () => {
  it('首次生成 revision 1，并写入 tool 调用遥测', async () => {
    const run = await startRun();
    const result = await createCandidate(run.runId);
    expect(result).toMatchObject({
      runId: run.runId,
      status: 'draft',
      currentRevision: 1,
      revisionNo: 1,
      deduplicated: false,
    });

    const view = await readConceptArtifact(db, {
      authorId,
      runId: run.runId,
      artifactId: result.artifactId,
    });
    expect(view.schemaVersion).toBe(NOVEL_CONCEPT_SCHEMA_VERSION);
    expect(view.content.titleSuggestions).toEqual(NOVEL_CONCEPT_MOCK_OUTPUT.titleSuggestions);
    expect(view.decision).toBeNull();
    expect(Object.keys(view)).not.toContain('stateSummary');
    expect(Object.keys(view)).not.toContain('prompt');

    const calls = await db.novelAgentCall.findMany({
      where: { runId: run.runId },
      select: { callKind: true, agentName: true, success: true, errorCode: true, stepId: true },
    });
    expect(calls).toEqual([
      {
        callKind: 'tool',
        agentName: NOVEL_CONCEPT_AGENT.name,
        success: true,
        errorCode: null,
        stepId: null,
      },
    ]);
  });

  it('同内容幂等：不新增 revision，但仍记录每次真实调用', async () => {
    const run = await startRun();
    const first = await createCandidate(run.runId);
    const second = await createCandidate(run.runId);
    expect(second.deduplicated).toBe(true);
    expect(second.revisionNo).toBe(1);
    expect(await revisionRows(first.artifactId)).toHaveLength(1);
    expect(await db.novelAgentCall.count({ where: { runId: run.runId } })).toBe(2);
  });

  it('不同内容生成 revision 2 且仍为 draft', async () => {
    const run = await startRun();
    const first = await createCandidate(run.runId);
    const second = await createCandidate(run.runId, variantProvider('另一条故事钩子'));
    expect(second.deduplicated).toBe(false);
    expect(second.currentRevision).toBe(2);
    const rows = await revisionRows(first.artifactId);
    expect(rows.map((row) => row.revisionNo)).toEqual([1, 2]);
  });

  it('拒绝后生成 revision 2，旧决定保留', async () => {
    const run = await startRun();
    const first = await createCandidate(run.runId);
    await requestConceptApproval(db, {
      authorId,
      runId: run.runId,
      artifactId: first.artifactId,
      revisionNo: 1,
      expectedRunVersion: run.version,
    });
    await decideConceptArtifact(db, {
      authorId,
      runId: run.runId,
      artifactId: first.artifactId,
      revisionNo: 1,
      expectedRunVersion: run.version + 1,
      decision: 'rejected',
    });
    const second = await createCandidate(run.runId, variantProvider('拒绝后的新钩子'));
    expect(second.currentRevision).toBe(2);
    expect((await artifactRow(run.runId))?.status).toBe('draft');
    expect((await decisionRows(first.artifactId)).map((row) => row.revisionNo)).toEqual([1]);
  });

  it('批准后 create 被拒绝', async () => {
    const run = await startRun();
    const first = await createCandidate(run.runId);
    await requestConceptApproval(db, {
      authorId,
      runId: run.runId,
      artifactId: first.artifactId,
      revisionNo: 1,
      expectedRunVersion: run.version,
    });
    await decideConceptArtifact(db, {
      authorId,
      runId: run.runId,
      artifactId: first.artifactId,
      revisionNo: 1,
      expectedRunVersion: run.version + 1,
      decision: 'approved',
    });
    await expectAuthError(
      createCandidate(run.runId, variantProvider('批准后的新钩子')),
      'NOVEL_ARTIFACT_ALREADY_APPROVED',
    );
    expect(await revisionRows(first.artifactId)).toHaveLength(1);
  });

  it('request approval：artifact pending、run waiting_approval 且版本 +1', async () => {
    const run = await startRun();
    const created = await createCandidate(run.runId);
    const approval = await requestConceptApproval(db, {
      authorId,
      runId: run.runId,
      artifactId: created.artifactId,
      revisionNo: 1,
      expectedRunVersion: run.version,
    });
    expect(approval).toMatchObject({
      revisionNo: 1,
      status: 'pending_approval',
      runVersion: run.version + 1,
    });
    expect((await artifactRow(run.runId))?.status).toBe('pending_approval');
    const state = await db.novelRun.findUnique({
      where: { id: run.runId },
      select: { status: true, stateVersion: true },
    });
    expect(state).toEqual({ status: 'waiting_approval', stateVersion: run.version + 1 });
  });

  it('approve / reject 后 run 回到 queued；同决定幂等、不同决定冲突', async () => {
    const run = await startRun();
    const created = await createCandidate(run.runId);
    await requestConceptApproval(db, {
      authorId,
      runId: run.runId,
      artifactId: created.artifactId,
      revisionNo: 1,
      expectedRunVersion: run.version,
    });

    const approved = await decideConceptArtifact(db, {
      authorId,
      runId: run.runId,
      artifactId: created.artifactId,
      revisionNo: 1,
      expectedRunVersion: run.version + 1,
      decision: 'approved',
    });
    expect(approved.status).toBe('approved');
    expect(approved.deduplicated).toBe(false);
    expect((await db.novelRun.findUnique({ where: { id: run.runId } }))?.status).toBe('queued');

    const again = await decideConceptArtifact(db, {
      authorId,
      runId: run.runId,
      artifactId: created.artifactId,
      revisionNo: 1,
      expectedRunVersion: run.version + 1,
      decision: 'approved',
    });
    expect(again.deduplicated).toBe(true);

    await expectAuthError(
      decideConceptArtifact(db, {
        authorId,
        runId: run.runId,
        artifactId: created.artifactId,
        revisionNo: 1,
        expectedRunVersion: run.version + 1,
        decision: 'rejected',
      }),
      'NOVEL_ARTIFACT_ALREADY_DECIDED',
    );
  });

  it('旧 expectedRunVersion / 旧 revision 使用稳定错误且不留决定', async () => {
    const run = await startRun();
    const created = await createCandidate(run.runId);

    // 旧版本申请确认：artifact 必须保持 draft、无 decision、run 不变
    await expectAuthError(
      requestConceptApproval(db, {
        authorId,
        runId: run.runId,
        artifactId: created.artifactId,
        revisionNo: 1,
        expectedRunVersion: run.version + 99,
      }),
      'NOVEL_ARTIFACT_VERSION_CONFLICT',
    );
    expect((await artifactRow(run.runId))?.status).toBe('draft');
    expect(await decisionRows(created.artifactId)).toHaveLength(0);

    await requestConceptApproval(db, {
      authorId,
      runId: run.runId,
      artifactId: created.artifactId,
      revisionNo: 1,
      expectedRunVersion: run.version,
    });
    // 旧 expectedVersion 决定：不写 decision、不推进 run
    await expectAuthError(
      decideConceptArtifact(db, {
        authorId,
        runId: run.runId,
        artifactId: created.artifactId,
        revisionNo: 1,
        expectedRunVersion: run.version,
        decision: 'approved',
      }),
      'NOVEL_ARTIFACT_VERSION_CONFLICT',
    );
    expect(await decisionRows(created.artifactId)).toHaveLength(0);
    expect((await artifactRow(run.runId))?.status).toBe('pending_approval');
  });

  it('对非 pending 状态决策返回 DECISION_STALE', async () => {
    const run = await startRun();
    const created = await createCandidate(run.runId);
    await expectAuthError(
      decideConceptArtifact(db, {
        authorId,
        runId: run.runId,
        artifactId: created.artifactId,
        revisionNo: 1,
        expectedRunVersion: run.version,
        decision: 'approved',
      }),
      'NOVEL_ARTIFACT_DECISION_STALE',
    );
    expect(await decisionRows(created.artifactId)).toHaveLength(0);
  });

  it('跨作者 / 不存在统一 404，不泄露差异', async () => {
    const run = await startRun();
    const created = await createCandidate(run.runId);
    await expectAuthError(
      readConceptArtifact(db, {
        authorId: otherAuthorId,
        runId: run.runId,
        artifactId: created.artifactId,
      }),
      'NOVEL_ARTIFACT_NOT_FOUND',
    );
    await expectAuthError(
      createCandidate(run.runId, createNovelConceptMockProvider(), otherAuthorId),
      'NOVEL_RUN_NOT_FOUND',
    );
    await expectAuthError(
      readConceptArtifact(db, {
        authorId,
        runId: run.runId,
        artifactId: randomUUID(),
      }),
      'NOVEL_ARTIFACT_NOT_FOUND',
    );
  });

  it('失败调用仍写脱敏遥测（provider / model / usage / error_code）', async () => {
    const run = await startRun();
    const invalidProvider = new MockProvider({
      json: { ...NOVEL_CONCEPT_MOCK_OUTPUT, nextTool: 'concept.generate' },
      model: 'mock-concept',
    });
    try {
      await createCandidate(run.runId, invalidProvider);
      throw new Error('预期输出被拒绝');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentOutputInvalidError);
    }
    expect(await artifactRow(run.runId)).toBeNull();
    const calls = await db.novelAgentCall.findMany({
      where: { runId: run.runId },
      select: {
        callKind: true,
        provider: true,
        model: true,
        promptTokens: true,
        completionTokens: true,
        success: true,
        errorCode: true,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      callKind: 'tool',
      provider: 'mock',
      model: 'mock-concept',
      success: false,
      errorCode: 'AGENT_OUTPUT_INVALID',
    });
    expect(calls[0]?.promptTokens).toBeGreaterThan(0);
    expect(calls[0]?.completionTokens).toBeGreaterThan(0);
  });

  it('旧 Worker 晚返回：批准后不能覆盖新 artifact state', async () => {
    const run = await startRun();
    const created = await createCandidate(run.runId);

    const gate = deferred<ModelJsonResult>();
    const entered = deferred<void>();
    const slowProvider: ModelProvider = {
      name: 'mock',
      defaultModel: 'mock-concept',
      generateJson(input: ModelJsonInput): Promise<ModelJsonResult> {
        entered.resolve(undefined);
        return gate.promise.then((result) => ({ ...result, model: input.model }));
      },
      generateText(): Promise<ModelTextResult> {
        throw new Error('not used');
      },
    };
    const slowCreate = createConceptCandidate(db, {
      authorId,
      runId: run.runId,
      provider: slowProvider,
    });
    await entered.promise;

    await requestConceptApproval(db, {
      authorId,
      runId: run.runId,
      artifactId: created.artifactId,
      revisionNo: 1,
      expectedRunVersion: run.version,
    });
    await decideConceptArtifact(db, {
      authorId,
      runId: run.runId,
      artifactId: created.artifactId,
      revisionNo: 1,
      expectedRunVersion: run.version + 1,
      decision: 'approved',
    });

    const usage: ModelUsage = { promptTokens: 100, completionTokens: 50 };
    gate.resolve({
      json: { ...NOVEL_CONCEPT_MOCK_OUTPUT, logline: '晚到的旧钩子' },
      provider: 'mock',
      model: 'mock-concept',
      usage,
      latencyMs: 10,
    });

    await expectAuthError(slowCreate, 'NOVEL_ARTIFACT_ALREADY_APPROVED');
    expect(await revisionRows(created.artifactId)).toHaveLength(1);
    expect((await artifactRow(run.runId))?.status).toBe('approved');
    // 真实发生的调用仍有一条遥测
    const calls = await db.novelAgentCall.findMany({ where: { runId: run.runId } });
    expect(calls).toHaveLength(2);
  });

  it('旧 Worker 晚返回：不同内容不能覆盖已推进的 draft revision', async () => {
    const run = await startRun();
    const first = await createCandidate(run.runId);

    const gate = deferred<ModelJsonResult>();
    const entered = deferred<void>();
    const slowProvider: ModelProvider = {
      name: 'mock',
      defaultModel: 'mock-concept',
      generateJson(input: ModelJsonInput): Promise<ModelJsonResult> {
        entered.resolve(undefined);
        return gate.promise.then((result) => ({ ...result, model: input.model }));
      },
      generateText(): Promise<ModelTextResult> {
        throw new Error('not used');
      },
    };
    const slowCreate = createConceptCandidate(db, {
      authorId,
      runId: run.runId,
      provider: slowProvider,
    });
    await entered.promise;

    await createCandidate(run.runId, variantProvider('先返回的新钩子'));
    expect((await artifactRow(run.runId))?.currentRevision).toBe(2);

    gate.resolve({
      json: { ...NOVEL_CONCEPT_MOCK_OUTPUT, logline: '晚到的旧钩子' },
      provider: 'mock',
      model: 'mock-concept',
      usage: { promptTokens: 100, completionTokens: 50 },
      latencyMs: 10,
    });

    await expectAuthError(slowCreate, 'NOVEL_ARTIFACT_VERSION_CONFLICT');
    expect(await revisionRows(first.artifactId)).toHaveLength(2);
  });
});
