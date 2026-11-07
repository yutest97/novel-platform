/**
 * C1-B-A1：故事候选服务层（内部服务，不暴露 HTTP）。
 *
 * 状态机：
 *
 *   Concept Agent 输出 → 新 artifact revision → 申请作者确认
 *   → 作者批准 / 拒绝 → 批准版本成为后续 Agent 唯一可依赖版本
 *
 * 边界（与 AGENTS.md / docs/08 一致）：
 * - Agent 只产出严格 Schema 的结构化候选，不碰数据库、不自动采纳；
 * - 本服务只做归属 / 状态 / 版本 / 落库校验，不做语义调度；
 * - 作者是最终签发者：revision 必须显式申请确认，再由作者决定；
 * - approved 是终态，禁止继续生成 revision；
 * - 旧 Worker 晚返回时用 run.state_version + artifact.current_revision 双 fence，
 *   不覆盖新的 artifact state；但真实发生的模型调用遥测仍会写入（与 C1-A 一致）。
 */

import { createHash, randomUUID } from 'node:crypto';

import { AuthError } from '@novel/auth';
import type { Prisma, PrismaClient } from '@novel/db';
import { normalizeUuid } from '@novel/works';

import { AgentInputInvalidError, AgentOutputInvalidError, AgentRunner } from '../agent.js';
import { WorkflowError } from '../errors.js';
import { ModelProviderError, type ModelCallMetadata, type ModelProvider } from '../model-types.js';
import {
  NOVEL_CONCEPT_AGENT,
  NOVEL_CONCEPT_SCHEMA_VERSION,
  runNovelConcept,
  type NovelConceptInput,
  type NovelConceptOutput,
} from './concept-agent.js';
import { isNovelTerminalStatus, parseNovelStateSummary } from './types.js';

export const NOVEL_ARTIFACT_TYPE_CONCEPT = 'concept';
export const NOVEL_ARTIFACT_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
] as const;

export type NovelArtifactStatus = (typeof NOVEL_ARTIFACT_STATUSES)[number];
export type NovelArtifactDecisionValue = 'approved' | 'rejected';

/** 未接 Runtime 前的模型调用硬超时（毫秒）。 */
const DEFAULT_CONCEPT_CALL_TIMEOUT_MS = 60_000;

/** 允许生成 / 申请确认的 run 状态（终态与 waiting_approval 不允许）。 */
const CONCEPT_ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting_user'] as const;

export interface NovelConceptArtifactView {
  readonly artifactId: string;
  readonly runId: string;
  readonly status: NovelArtifactStatus;
  readonly currentRevision: number;
  readonly revisionNo: number;
  readonly schemaVersion: string;
  readonly content: NovelConceptOutput;
  readonly sourceAgent: string;
  readonly sourceAgentVersion: string;
  readonly decision: {
    readonly value: NovelArtifactDecisionValue;
    readonly decidedAt: string;
  } | null;
}

export interface CreateConceptCandidateInput {
  readonly authorId: string;
  readonly runId: unknown;
  readonly sourceStepId?: unknown;
  readonly provider: ModelProvider;
  /** 仅测试注入；生产默认 60 秒硬超时。 */
  readonly modelCallTimeoutMs?: number;
}

export interface CreateConceptCandidateResult {
  readonly artifactId: string;
  readonly runId: string;
  readonly status: NovelArtifactStatus;
  readonly currentRevision: number;
  readonly revisionNo: number;
  readonly deduplicated: boolean;
}

export interface RequestConceptApprovalInput {
  readonly authorId: string;
  readonly runId: unknown;
  readonly artifactId: unknown;
  readonly revisionNo: unknown;
  readonly expectedRunVersion: unknown;
}

export interface ConceptApprovalResult {
  readonly artifactId: string;
  readonly runId: string;
  readonly revisionNo: number;
  readonly status: 'pending_approval';
  readonly runVersion: number;
}

export interface DecideConceptArtifactInput extends RequestConceptApprovalInput {
  readonly decision: unknown;
}

export interface ConceptDecisionResult {
  readonly artifactId: string;
  readonly runId: string;
  readonly revisionNo: number;
  readonly decision: NovelArtifactDecisionValue;
  readonly status: NovelArtifactStatus;
  readonly decidedAt: string;
  readonly runVersion: number;
  readonly deduplicated: boolean;
}

interface LockedRunRow {
  readonly id: string;
  readonly status: string;
  readonly state_version: number;
  readonly request_text: string;
  readonly state_summary: unknown;
}

interface LockedArtifactRow {
  readonly id: string;
  readonly status: string;
  readonly current_revision: number;
}

function normalizeRevisionNo(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AuthError('VALIDATION_FAILED', 'revisionNo 必须是正整数');
  }
  return value;
}

function normalizeExpectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AuthError('VALIDATION_FAILED', 'expectedRunVersion 必须是非负整数');
  }
  return value;
}

function normalizeDecision(value: unknown): NovelArtifactDecisionValue {
  if (value !== 'approved' && value !== 'rejected') {
    throw new AuthError('VALIDATION_FAILED', 'decision 必须是 approved 或 rejected');
  }
  return value;
}

function statusOf(value: string): NovelArtifactStatus {
  if (!(NOVEL_ARTIFACT_STATUSES as readonly string[]).includes(value)) {
    throw new AuthError('NOVEL_ARTIFACT_NOT_FOUND');
  }
  return value as NovelArtifactStatus;
}

/** JSON 稳定序列化：jsonb 会重排对象键，幂等比较必须与键顺序无关。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function contentHashOf(content: unknown): string {
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

function isConceptActiveRunStatus(status: string): boolean {
  return (CONCEPT_ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

async function lockRun(
  tx: Prisma.TransactionClient,
  runId: string,
  authorId: string,
): Promise<LockedRunRow | null> {
  const rows = await tx.$queryRaw<LockedRunRow[]>`
    SELECT "id", "status", "state_version", "request_text", "state_summary"
    FROM "novel_runs"
    WHERE "id" = ${runId}::uuid
      AND "author_id" = ${authorId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockConceptArtifact(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<LockedArtifactRow | null> {
  const rows = await tx.$queryRaw<LockedArtifactRow[]>`
    SELECT "id", "status", "current_revision"
    FROM "novel_artifacts"
    WHERE "run_id" = ${runId}::uuid
      AND "artifact_type" = ${NOVEL_ARTIFACT_TYPE_CONCEPT}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

function callMetadataOf(error: unknown): ModelCallMetadata | null {
  if (error instanceof AgentOutputInvalidError) {
    return error.callMetadata ?? null;
  }
  if (error instanceof ModelProviderError) {
    return error.callMetadata ?? null;
  }
  return null;
}

function errorCodeOf(error: unknown): string {
  if (error instanceof WorkflowError) {
    return error.code;
  }
  return 'AGENT_CALL_FAILED';
}

async function recordToolCall(
  db: PrismaClient,
  input: {
    readonly id: string;
    readonly runId: string;
    readonly stepId: string | null;
    readonly provider: string;
    readonly model: string;
    readonly usage: { readonly promptTokens: number; readonly completionTokens: number };
    readonly latencyMs: number;
    readonly success: boolean;
    readonly errorCode: string | null;
  },
): Promise<void> {
  await db.novelAgentCall.create({
    data: {
      id: input.id,
      runId: input.runId,
      stepId: input.stepId,
      callKind: 'tool',
      agentName: NOVEL_CONCEPT_AGENT.name,
      agentVersion: NOVEL_CONCEPT_AGENT.promptVersion,
      provider: input.provider,
      model: input.model,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      latencyMs: input.latencyMs,
      success: input.success,
      errorCode: input.errorCode,
    },
  });
}

/**
 * 调用 Concept Agent 并强制经过 Schema + 语义校验。
 *
 * 硬超时只影响本次 attempt（`MODEL_TIMEOUT`），不会泄漏 prompt / 原始响应。
 */
async function callConceptAgent(
  provider: ModelProvider,
  input: NovelConceptInput,
  timeoutMs: number,
): Promise<{
  readonly output: NovelConceptOutput;
  readonly provider: string;
  readonly model: string;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number };
  readonly latencyMs: number;
}> {
  const runner = new AgentRunner(provider);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelProviderError('MODEL_TIMEOUT', '模型调用超时', { retryable: true }));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      runNovelConcept(runner, input, { signal: controller.signal, temperature: 0 }),
      timeout,
    ]);
    return {
      output: result.output,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * 生成新的 Concept 候选 revision。
 *
 * 幂等：与当前 draft revision 内容一致时不新增 revision，返回 `deduplicated: true`。
 * Fence：模型调用前后各校验一次 run / artifact 状态；旧 Worker 晚返回不会覆盖新 revision。
 */
export async function createConceptCandidate(
  db: PrismaClient,
  input: CreateConceptCandidateInput,
): Promise<CreateConceptCandidateResult> {
  const runId = normalizeUuid(input.runId, 'runId');
  const sourceStepId =
    input.sourceStepId === undefined || input.sourceStepId === null
      ? null
      : normalizeUuid(input.sourceStepId, 'sourceStepId');

  if (
    typeof input.provider?.name !== 'string' ||
    typeof input.provider?.generateJson !== 'function'
  ) {
    throw new AuthError('VALIDATION_FAILED', 'provider 不合法');
  }
  const timeoutMs =
    typeof input.modelCallTimeoutMs === 'number' &&
    Number.isInteger(input.modelCallTimeoutMs) &&
    input.modelCallTimeoutMs > 0
      ? input.modelCallTimeoutMs
      : DEFAULT_CONCEPT_CALL_TIMEOUT_MS;

  // 1) 调用前快照：只读，不持有长事务。
  const run = await db.novelRun.findFirst({
    where: { id: runId, authorId: input.authorId },
    select: {
      id: true,
      status: true,
      stateVersion: true,
      requestText: true,
      stateSummary: true,
    },
  });
  if (run === null) {
    throw new AuthError('NOVEL_RUN_NOT_FOUND');
  }
  if (isNovelTerminalStatus(run.status) || !isConceptActiveRunStatus(run.status)) {
    throw new AuthError('NOVEL_RUN_INVALID_STATE');
  }

  const snapshot = await db.novelArtifact.findUnique({
    where: {
      runId_artifactType: { runId, artifactType: NOVEL_ARTIFACT_TYPE_CONCEPT },
    },
    select: { id: true, status: true, currentRevision: true },
  });
  if (snapshot?.status === 'approved') {
    throw new AuthError('NOVEL_ARTIFACT_ALREADY_APPROVED');
  }
  if (snapshot?.status === 'pending_approval') {
    throw new AuthError('NOVEL_ARTIFACT_VERSION_CONFLICT');
  }

  if (sourceStepId !== null) {
    const step = await db.novelRunStep.findFirst({
      where: { id: sourceStepId, runId },
      select: { id: true },
    });
    if (step === null) {
      throw new AuthError('VALIDATION_FAILED', 'sourceStepId 不属于该运行');
    }
  }

  // 2) 实际模型调用 + 立即写入脱敏调用遥测（与业务提交解耦）。
  const summary = parseNovelStateSummary(run.stateSummary);
  const modelInput: NovelConceptInput = {
    requestText: run.requestText,
    knownFacts: summary.knownFacts,
    authorFocus: summary.latestAnswer,
  };

  const callId = randomUUID();
  let metadata: {
    readonly provider: string;
    readonly model: string;
    readonly usage: { readonly promptTokens: number; readonly completionTokens: number };
    readonly latencyMs: number;
  };
  let content: NovelConceptOutput;
  try {
    const result = await callConceptAgent(input.provider, modelInput, timeoutMs);
    metadata = {
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
    content = result.output;
    await recordToolCall(db, {
      id: callId,
      runId,
      stepId: sourceStepId,
      ...metadata,
      success: true,
      errorCode: null,
    });
  } catch (error) {
    if (error instanceof AgentInputInvalidError) {
      // 输入不合法时 Provider 未被调用，不写遥测。
      throw error;
    }
    const callMetadata = callMetadataOf(error);
    await recordToolCall(db, {
      id: callId,
      runId,
      stepId: sourceStepId,
      provider: callMetadata?.provider ?? input.provider.name,
      model:
        callMetadata?.model ?? new AgentRunner(input.provider).resolveModel(NOVEL_CONCEPT_AGENT),
      usage: callMetadata?.usage ?? { promptTokens: 0, completionTokens: 0 },
      latencyMs: callMetadata?.latencyMs ?? 0,
      success: false,
      errorCode: errorCodeOf(error),
    });
    throw error;
  }

  const contentHash = contentHashOf(content);

  // 3) 业务提交：run + artifact 双锁，重新校验快照后写 revision。
  return db.$transaction(async (tx) => {
    const lockedRun = await lockRun(tx, runId, input.authorId);
    if (lockedRun === null) {
      throw new AuthError('NOVEL_RUN_NOT_FOUND');
    }
    if (isNovelTerminalStatus(lockedRun.status) || !isConceptActiveRunStatus(lockedRun.status)) {
      throw new AuthError('NOVEL_RUN_INVALID_STATE');
    }

    const existing = await lockConceptArtifact(tx, runId);
    if (existing?.status === 'approved') {
      throw new AuthError('NOVEL_ARTIFACT_ALREADY_APPROVED');
    }
    if (existing?.status === 'pending_approval') {
      throw new AuthError('NOVEL_ARTIFACT_VERSION_CONFLICT');
    }

    if (lockedRun.state_version !== run.stateVersion && existing?.status !== 'approved') {
      throw new AuthError('NOVEL_ARTIFACT_VERSION_CONFLICT');
    }

    if (existing !== null) {
      const currentRevision = await tx.novelArtifactRevision.findUnique({
        where: {
          artifactId_revisionNo: {
            artifactId: existing.id,
            revisionNo: existing.current_revision,
          },
        },
        select: { content: true },
      });

      // 同内容幂等：旧 Worker 晚返回相同内容时返回现有 revision，不覆盖状态。
      if (
        existing.status === 'draft' &&
        currentRevision !== null &&
        contentHashOf(currentRevision.content) === contentHash
      ) {
        return {
          artifactId: existing.id,
          runId,
          status: statusOf(existing.status),
          currentRevision: existing.current_revision,
          revisionNo: existing.current_revision,
          deduplicated: true,
        };
      }

      if (
        snapshot === null ||
        snapshot.id !== existing.id ||
        snapshot.status !== existing.status ||
        snapshot.currentRevision !== existing.current_revision
      ) {
        throw new AuthError('NOVEL_ARTIFACT_VERSION_CONFLICT');
      }
    } else if (snapshot !== null) {
      throw new AuthError('NOVEL_ARTIFACT_VERSION_CONFLICT');
    }

    const jsonContent = content as unknown as Prisma.InputJsonValue;
    if (existing === null) {
      const artifactId = randomUUID();
      await tx.novelArtifact.create({
        data: {
          id: artifactId,
          runId,
          authorId: input.authorId,
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
          authorId: input.authorId,
          revisionNo: 1,
          schemaVersion: NOVEL_CONCEPT_SCHEMA_VERSION,
          content: jsonContent,
          sourceAgent: NOVEL_CONCEPT_AGENT.name,
          sourceAgentVersion: NOVEL_CONCEPT_AGENT.promptVersion,
          sourceStepId,
        },
      });
      return {
        artifactId,
        runId,
        status: 'draft' as const,
        currentRevision: 1,
        revisionNo: 1,
        deduplicated: false,
      };
    }

    const nextRevision = existing.current_revision + 1;
    await tx.novelArtifactRevision.create({
      data: {
        artifactId: existing.id,
        runId,
        authorId: input.authorId,
        revisionNo: nextRevision,
        schemaVersion: NOVEL_CONCEPT_SCHEMA_VERSION,
        content: jsonContent,
        sourceAgent: NOVEL_CONCEPT_AGENT.name,
        sourceAgentVersion: NOVEL_CONCEPT_AGENT.promptVersion,
        sourceStepId,
      },
    });
    await tx.novelArtifact.update({
      where: { id: existing.id },
      data: { currentRevision: nextRevision, status: 'draft' },
    });
    return {
      artifactId: existing.id,
      runId,
      status: 'draft' as const,
      currentRevision: nextRevision,
      revisionNo: nextRevision,
      deduplicated: false,
    };
  });
}

/** 申请作者确认：draft → pending_approval，run → waiting_approval。 */
export async function requestConceptApproval(
  db: PrismaClient,
  input: RequestConceptApprovalInput,
): Promise<ConceptApprovalResult> {
  const runId = normalizeUuid(input.runId, 'runId');
  const artifactId = normalizeUuid(input.artifactId, 'artifactId');
  const revisionNo = normalizeRevisionNo(input.revisionNo);
  const expectedRunVersion = normalizeExpectedVersion(input.expectedRunVersion);

  return db.$transaction(async (tx) => {
    const lockedRun = await lockRun(tx, runId, input.authorId);
    if (lockedRun === null) {
      throw new AuthError('NOVEL_RUN_NOT_FOUND');
    }
    if (isNovelTerminalStatus(lockedRun.status) || !isConceptActiveRunStatus(lockedRun.status)) {
      throw new AuthError('NOVEL_RUN_INVALID_STATE');
    }

    const artifact = await lockConceptArtifact(tx, runId);
    if (artifact === null || artifact.id !== artifactId) {
      throw new AuthError('NOVEL_ARTIFACT_NOT_FOUND');
    }
    if (artifact.status === 'approved') {
      throw new AuthError('NOVEL_ARTIFACT_ALREADY_APPROVED');
    }
    if (artifact.status !== 'draft') {
      throw new AuthError('NOVEL_ARTIFACT_VERSION_CONFLICT');
    }
    if (artifact.current_revision !== revisionNo) {
      throw new AuthError('NOVEL_ARTIFACT_VERSION_CONFLICT');
    }
    if (lockedRun.state_version !== expectedRunVersion) {
      throw new AuthError('NOVEL_ARTIFACT_VERSION_CONFLICT');
    }

    const revision = await tx.novelArtifactRevision.findUnique({
      where: {
        artifactId_revisionNo: { artifactId, revisionNo },
      },
      select: { id: true },
    });
    if (revision === null) {
      throw new AuthError('NOVEL_ARTIFACT_NOT_FOUND');
    }

    const runVersion = lockedRun.state_version + 1;
    await tx.novelArtifact.update({
      where: { id: artifactId },
      data: { status: 'pending_approval' },
    });
    await tx.novelRun.update({
      where: { id: runId },
      data: {
        status: 'waiting_approval',
        stateVersion: runVersion,
        lockedBy: null,
        leaseUntil: null,
        heartbeatAt: null,
      },
    });
    return {
      artifactId,
      runId,
      revisionNo,
      status: 'pending_approval' as const,
      runVersion,
    };
  });
}

/**
 * 作者决定：pending_approval → approved / rejected，run → queued。
 *
 * - 同一 revision 同一决定幂等；
 * - 同一 revision 不同决定 → `NOVEL_ARTIFACT_ALREADY_DECIDED`；
 * - stale revision / run 版本冲突 → 稳定错误码。
 */
export async function decideConceptArtifact(
  db: PrismaClient,
  input: DecideConceptArtifactInput,
): Promise<ConceptDecisionResult> {
  const runId = normalizeUuid(input.runId, 'runId');
  const artifactId = normalizeUuid(input.artifactId, 'artifactId');
  const revisionNo = normalizeRevisionNo(input.revisionNo);
  const expectedRunVersion = normalizeExpectedVersion(input.expectedRunVersion);
  const decision = normalizeDecision(input.decision);

  return db.$transaction(async (tx) => {
    const lockedRun = await lockRun(tx, runId, input.authorId);
    if (lockedRun === null) {
      throw new AuthError('NOVEL_RUN_NOT_FOUND');
    }

    const artifact = await lockConceptArtifact(tx, runId);
    if (artifact === null || artifact.id !== artifactId) {
      throw new AuthError('NOVEL_ARTIFACT_NOT_FOUND');
    }

    const existingDecision = await tx.novelArtifactDecision.findUnique({
      where: {
        artifactId_revisionNo: { artifactId, revisionNo },
      },
      select: { decision: true, decidedAt: true },
    });
    if (existingDecision !== null) {
      if (existingDecision.decision !== decision) {
        throw new AuthError('NOVEL_ARTIFACT_ALREADY_DECIDED');
      }
      return {
        artifactId,
        runId,
        revisionNo,
        decision,
        status: statusOf(artifact.status),
        decidedAt: existingDecision.decidedAt.toISOString(),
        runVersion: lockedRun.state_version,
        deduplicated: true,
      };
    }

    if (artifact.status !== 'pending_approval' || artifact.current_revision !== revisionNo) {
      throw new AuthError('NOVEL_ARTIFACT_DECISION_STALE');
    }
    if (lockedRun.status !== 'waiting_approval') {
      throw new AuthError('NOVEL_ARTIFACT_DECISION_STALE');
    }
    if (lockedRun.state_version !== expectedRunVersion) {
      throw new AuthError('NOVEL_ARTIFACT_VERSION_CONFLICT');
    }

    const revision = await tx.novelArtifactRevision.findUnique({
      where: {
        artifactId_revisionNo: { artifactId, revisionNo },
      },
      select: { id: true },
    });
    if (revision === null) {
      throw new AuthError('NOVEL_ARTIFACT_DECISION_STALE');
    }

    const decided = await tx.novelArtifactDecision.create({
      data: { artifactId, revisionNo, authorId: input.authorId, decision },
      select: { decidedAt: true },
    });
    await tx.novelArtifact.update({
      where: { id: artifactId },
      data: { status: decision },
    });
    const runVersion = lockedRun.state_version + 1;
    await tx.novelRun.update({
      where: { id: runId },
      data: {
        status: 'queued',
        stateVersion: runVersion,
        lockedBy: null,
        leaseUntil: null,
        heartbeatAt: null,
      },
    });

    return {
      artifactId,
      runId,
      revisionNo,
      decision,
      status: decision,
      decidedAt: decided.decidedAt.toISOString(),
      runVersion,
      deduplicated: false,
    };
  });
}

/** 读取当前作者的当前 revision；他人 / 不存在统一 404。 */
export async function readConceptArtifact(
  db: PrismaClient,
  input: { readonly authorId: string; readonly runId: unknown; readonly artifactId: unknown },
): Promise<NovelConceptArtifactView> {
  const runId = normalizeUuid(input.runId, 'runId');
  const artifactId = normalizeUuid(input.artifactId, 'artifactId');

  return db.$transaction(
    async (tx) => {
      const artifact = await tx.novelArtifact.findFirst({
        where: { id: artifactId, runId, authorId: input.authorId },
        select: {
          id: true,
          runId: true,
          status: true,
          currentRevision: true,
        },
      });
      if (artifact === null) {
        throw new AuthError('NOVEL_ARTIFACT_NOT_FOUND');
      }

      const revision = await tx.novelArtifactRevision.findUnique({
        where: {
          artifactId_revisionNo: {
            artifactId: artifact.id,
            revisionNo: artifact.currentRevision,
          },
        },
        select: {
          revisionNo: true,
          schemaVersion: true,
          content: true,
          sourceAgent: true,
          sourceAgentVersion: true,
        },
      });
      if (revision === null) {
        throw new AuthError('NOVEL_ARTIFACT_NOT_FOUND');
      }

      const decision = await tx.novelArtifactDecision.findUnique({
        where: {
          artifactId_revisionNo: {
            artifactId: artifact.id,
            revisionNo: artifact.currentRevision,
          },
        },
        select: { decision: true, decidedAt: true },
      });

      return {
        artifactId: artifact.id,
        runId: artifact.runId,
        status: statusOf(artifact.status),
        currentRevision: artifact.currentRevision,
        revisionNo: revision.revisionNo,
        schemaVersion: revision.schemaVersion,
        content: revision.content as unknown as NovelConceptOutput,
        sourceAgent: revision.sourceAgent,
        sourceAgentVersion: revision.sourceAgentVersion,
        decision:
          decision === null
            ? null
            : {
                value: decision.decision as NovelArtifactDecisionValue,
                decidedAt: decision.decidedAt.toISOString(),
              },
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
