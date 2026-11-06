/**
 * C1-A：Coordinator Runtime / Worker。
 *
 * 职责边界（与 AGENTS.md / docs/08 一致）：
 * - Coordinator 只做语义决策；Runtime 负责工具白名单、状态迁移、预算、
 *   重复动作熔断、租约、取消优先级和落库；
 * - Runtime 不替作者确认产物，也不创建任何 Work、章节或正文；
 * - 旧 Worker 晚返回时必须因租约/版本 fence 失败而**丢弃全部结果**，
 *   不写 step、不写调用日志、不改 state；
 * - 每次实际模型调用都进入 novel_agent_calls，且只进入一次（重试不产生重复成功 step）。
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { Prisma, PrismaClient } from '@novel/db';

import { AgentInputInvalidError, AgentOutputInvalidError, AgentRunner } from '../agent.js';
import { sanitizeTaskError } from '../errors.js';
import { validateJson } from '../json-schema.js';
import type { ModelProvider } from '../model-types.js';
import { hashTaskRequest } from '../request-hash.js';
import {
  NOVEL_COORDINATOR_AGENT,
  validateNovelCoordinatorAction,
  type NovelCoordinatorAction,
  type NovelCoordinatorInput,
} from './coordinator-agent.js';
import {
  NOVEL_TOOL_WORKFLOWS,
  getNovelToolWorkflow,
  type NovelToolResult,
} from './tool-workflows.js';
import { NOVEL_ALLOWED_TOOLS, parseNovelStateSummary } from './types.js';

export type NovelRunOutcome =
  'idle' | 'waiting_user' | 'completed' | 'failed' | 'cancelled' | 'lease-lost';

export interface NovelCoordinatorWorkerOptions {
  readonly provider: ModelProvider;
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly sweepIntervalMs?: number;
  readonly maxAttempts?: number;
  /** 一轮问答累计 token 预算（prompt + completion）。 */
  readonly tokenBudget?: number;
}

interface ClaimedNovelRun {
  readonly id: string;
  readonly request_text: string;
  readonly state_version: number;
  readonly state_summary: unknown;
  readonly step_count: number;
  readonly max_steps: number;
}

interface RunExecutionState {
  readonly id: string;
  readonly status: string;
  readonly state_version: number;
  readonly state_summary: unknown;
  readonly step_count: number;
  readonly max_steps: number;
  readonly request_text: string;
  readonly locked_by: string | null;
  readonly cancel_requested_at: Date | null;
}

interface PendingCall {
  readonly callKind: 'coordinator';
  readonly agentName: string;
  readonly agentVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
  readonly success: boolean;
  readonly errorCode: string | null;
}

class CommitAborted extends Error {
  constructor(readonly outcome: 'lease-lost') {
    super(outcome);
    this.name = 'CommitAborted';
  }
}

const MAX_REPEAT_ACTIONS = 3;
const DEFAULT_TOKEN_BUDGET = 100_000;
/** 单次 Coordinator 模型调用的硬超时：取所有已注册工具声明的最大值。 */
const MODEL_CALL_TIMEOUT_MS = Math.max(
  ...Object.values(NOVEL_TOOL_WORKFLOWS).map((workflow) => workflow.timeoutMs),
);

/**
 * 单进程内的 Coordinator Worker。
 *
 * 与现有 generation Worker 一起由 Worker supervisor 轮询；
 * `runOnce()` 要么处理一个 queued run，要么返回 idle。
 */
export class NovelCoordinatorWorker {
  private readonly db: PrismaClient;
  private readonly provider: ModelProvider;
  private readonly runner: AgentRunner;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly tokenBudget: number;
  private lastSweepAt = 0;
  private stopped = false;

  constructor(db: PrismaClient, options: NovelCoordinatorWorkerOptions) {
    this.db = db;
    this.provider = options.provider;
    this.runner = new AgentRunner(options.provider);
    this.workerId =
      options.workerId?.trim() || `novel:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.leaseMs / 3));
    this.sweepIntervalMs = options.sweepIntervalMs ?? 30_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  }

  stop(): void {
    this.stopped = true;
  }

  async runOnce(): Promise<NovelRunOutcome> {
    if (this.stopped) {
      return 'idle';
    }
    await this.maybeSweep();
    const run = await this.claimNextRun();
    if (run === null) {
      return 'idle';
    }
    try {
      return await this.execute(run);
    } catch (error) {
      if (error instanceof CommitAborted) {
        return error.outcome;
      }
      throw error;
    }
  }

  private async maybeSweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < this.sweepIntervalMs) {
      return;
    }
    this.lastSweepAt = now;
    // 取消优先；否则过期租约回到 queued，等待下一次接管。
    await this.db.$executeRaw`
      WITH cancelled AS (
        UPDATE "novel_runs"
        SET "status" = 'cancelled',
            "state_version" = "state_version" + 1,
            "completed_at" = clock_timestamp(),
            "cancel_requested_at" = COALESCE("cancel_requested_at", clock_timestamp()),
            "locked_by" = NULL,
            "lease_until" = NULL,
            "heartbeat_at" = NULL,
            "updated_at" = clock_timestamp()
        WHERE "status" = 'running'
          AND "cancel_requested_at" IS NOT NULL
          AND "lease_until" < clock_timestamp()
        RETURNING "id"
      ), requeued AS (
        UPDATE "novel_runs"
        SET "status" = 'queued',
            "state_version" = "state_version" + 1,
            "locked_by" = NULL,
            "lease_until" = NULL,
            "heartbeat_at" = NULL,
            "updated_at" = clock_timestamp()
        WHERE "status" = 'running'
          AND "cancel_requested_at" IS NULL
          AND "lease_until" < clock_timestamp()
        RETURNING "id"
      )
      SELECT (SELECT count(*) FROM cancelled) + (SELECT count(*) FROM requeued) AS "swept"
    `;
  }

  private async claimNextRun(): Promise<ClaimedNovelRun | null> {
    const rows = await this.db.$queryRaw<ClaimedNovelRun[]>`
      WITH candidate AS (
        SELECT "id"
        FROM "novel_runs"
        WHERE "status" = 'queued'
          AND "cancel_requested_at" IS NULL
        ORDER BY "created_at", "id"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "novel_runs" AS r
      SET "status" = 'running',
          "locked_by" = ${this.workerId},
          "lease_until" = clock_timestamp() + (${this.leaseMs}::int * interval '1 millisecond'),
          "heartbeat_at" = clock_timestamp(),
          "updated_at" = clock_timestamp()
      FROM candidate
      WHERE r."id" = candidate."id"
      RETURNING
        r."id",
        r."request_text",
        r."state_version",
        r."state_summary",
        r."step_count",
        r."max_steps"
    `;
    return rows[0] ?? null;
  }

  private async getExecutionState(runId: string): Promise<RunExecutionState | null> {
    const rows = await this.db.$queryRaw<RunExecutionState[]>`
      SELECT
        "id",
        "status",
        "state_version",
        "state_summary",
        "step_count",
        "max_steps",
        "request_text",
        "locked_by",
        "cancel_requested_at"
      FROM "novel_runs"
      WHERE "id" = ${runId}::uuid
    `;
    return rows[0] ?? null;
  }

  private async checkFence(
    runId: string,
    stateVersion: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) {
      return false;
    }
    const state = await this.getExecutionState(runId);
    return (
      state !== null &&
      state.status === 'running' &&
      state.locked_by === this.workerId &&
      state.state_version === stateVersion &&
      state.cancel_requested_at === null
    );
  }

  private async heartbeat(runId: string, stateVersion: number): Promise<boolean> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "novel_runs"
      SET "lease_until" = clock_timestamp() + (${this.leaseMs}::int * interval '1 millisecond'),
          "heartbeat_at" = clock_timestamp(),
          "updated_at" = clock_timestamp()
      WHERE "id" = ${runId}::uuid
        AND "status" = 'running'
        AND "locked_by" = ${this.workerId}
        AND "state_version" = ${stateVersion}
        AND "cancel_requested_at" IS NULL
      RETURNING "id"
    `;
    return rows.length > 0;
  }

  private async execute(run: ClaimedNovelRun): Promise<NovelRunOutcome> {
    const fresh = await this.getExecutionState(run.id);
    if (fresh === null || fresh.status !== 'running' || fresh.locked_by !== this.workerId) {
      return 'lease-lost';
    }

    const summary = parseNovelStateSummary(fresh.state_summary);
    const remainingSteps = Math.max(0, fresh.max_steps - fresh.step_count);
    if (remainingSteps <= 0) {
      // 步数预算耗尽时不能再写 step（否则违反 step_count <= max_steps）。
      await this.failWithoutStep(run.id, fresh.state_version);
      return 'failed';
    }

    const usedTokens = await this.usedTokens(run.id);
    if (usedTokens >= this.tokenBudget) {
      await this.commitFailure(run, fresh, 'NOVEL_RUN_BUDGET_EXCEEDED', [], 'none', true);
      return 'failed';
    }

    const input: NovelCoordinatorInput = {
      requestText: fresh.request_text,
      latestAnswer: summary.latestAnswer,
      stateSummary: summary,
      allowedTools: [...NOVEL_ALLOWED_TOOLS],
      remainingSteps,
    };

    const controller = new AbortController();
    let leaseLost = false;
    const heartbeatTimer = setInterval(() => {
      void this.heartbeat(run.id, fresh.state_version)
        .then((alive) => {
          if (!alive) {
            leaseLost = true;
            controller.abort();
          }
        })
        .catch(() => {
          leaseLost = true;
          controller.abort();
        });
    }, this.heartbeatIntervalMs);
    const abortTimer = setTimeout(() => controller.abort(), MODEL_CALL_TIMEOUT_MS);

    const pendingCalls: PendingCall[] = [];
    let validated: NovelCoordinatorAction | null = null;
    let lastErrorCode = 'WORKFLOW_INTERNAL_ERROR';

    try {
      for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
        if (leaseLost || !(await this.checkFence(run.id, fresh.state_version, controller.signal))) {
          return 'lease-lost';
        }
        const startedAt = performance.now();
        try {
          const result = await this.runner.run<unknown>(NOVEL_COORDINATOR_AGENT, input, {
            signal: controller.signal,
            temperature: 0,
          });
          const semantic = validateNovelCoordinatorAction(result.output);
          if (!semantic.ok) {
            lastErrorCode = 'AGENT_OUTPUT_INVALID';
            pendingCalls.push({
              callKind: 'coordinator',
              agentName: result.agentName,
              agentVersion: result.promptVersion,
              provider: result.provider,
              model: result.model,
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
              latencyMs: result.latencyMs,
              success: false,
              errorCode: 'AGENT_OUTPUT_INVALID',
            });
            continue;
          }
          validated = semantic.action;
          pendingCalls.push({
            callKind: 'coordinator',
            agentName: result.agentName,
            agentVersion: result.promptVersion,
            provider: result.provider,
            model: result.model,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            latencyMs: result.latencyMs,
            success: true,
            errorCode: null,
          });
          break;
        } catch (error) {
          const safe = sanitizeTaskError(error);
          lastErrorCode = safe.code;
          if (!(error instanceof AgentInputInvalidError)) {
            pendingCalls.push({
              callKind: 'coordinator',
              agentName: NOVEL_COORDINATOR_AGENT.name,
              agentVersion: NOVEL_COORDINATOR_AGENT.promptVersion,
              provider: this.provider.name,
              model: this.runner.resolveModel(NOVEL_COORDINATOR_AGENT),
              promptTokens: 0,
              completionTokens: 0,
              latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
              success: false,
              errorCode: safe.code,
            });
          }
          // 模型输出非法（Schema / 语义）与可重试错误都使用剩余 attempt 重新调用；
          // 输入非法与永久 Provider 错误立即停止。
          if (error instanceof AgentInputInvalidError) {
            break;
          }
          if (!(error instanceof AgentOutputInvalidError) && !safe.retryable) {
            break;
          }
        }
      }
    } finally {
      clearInterval(heartbeatTimer);
      clearTimeout(abortTimer);
    }

    if (leaseLost || !(await this.checkFence(run.id, fresh.state_version, controller.signal))) {
      return 'lease-lost';
    }

    if (validated === null) {
      await this.commitFailure(run, fresh, lastErrorCode, pendingCalls, 'none', true);
      return 'failed';
    }

    // 工具白名单 → 状态可进入性 → 工具输入 Schema：全部由 Runtime 校验。
    const workflow = getNovelToolWorkflow(validated.action);
    if (workflow === null || !NOVEL_ALLOWED_TOOLS.includes(validated.action)) {
      await this.commitFailure(
        run,
        fresh,
        'NOVEL_RUN_TOOL_NOT_ALLOWED',
        pendingCalls,
        validated.action,
        true,
      );
      return 'failed';
    }
    if (!workflow.allowedFromStatus.includes('running')) {
      await this.commitFailure(
        run,
        fresh,
        'NOVEL_RUN_INVALID_STATE',
        pendingCalls,
        validated.action,
        true,
      );
      return 'failed';
    }
    if (validateJson(workflow.inputSchema, validated.input).length > 0) {
      await this.commitFailure(
        run,
        fresh,
        'AGENT_OUTPUT_INVALID',
        pendingCalls,
        validated.action,
        true,
      );
      return 'failed';
    }

    const signature = this.actionSignature(validated);
    const repeatCount = summary.lastActionSignature === signature ? summary.repeatCount + 1 : 0;
    if (repeatCount >= MAX_REPEAT_ACTIONS - 1) {
      await this.commitFailure(
        run,
        fresh,
        'COORDINATOR_LOOP_DETECTED',
        pendingCalls,
        validated.action,
        true,
      );
      return 'failed';
    }

    // 确定性工具工作流：只产出安全摘要，不写数据库、不创建 Work。
    const toolResult = workflow.execute({
      action: validated,
      summary,
      stepNo: fresh.step_count + 1,
      signature,
      repeatCount,
    });
    await this.commitSuccess(run, fresh, validated, toolResult, pendingCalls);
    return toolResult.status === 'completed' ? 'completed' : 'waiting_user';
  }

  private async usedTokens(runId: string): Promise<number> {
    const tokens = await this.db.novelAgentCall.aggregate({
      where: { runId },
      _sum: { promptTokens: true, completionTokens: true },
    });
    return (tokens._sum.promptTokens ?? 0) + (tokens._sum.completionTokens ?? 0);
  }

  private actionSignature(action: NovelCoordinatorAction): string {
    return hashTaskRequest({
      chapterId: null,
      taskType: 'novel.coordinator.action',
      inputSnapshot: {
        action: action.action,
        question: action.input.question,
        options: action.input.options,
        finishReason: action.input.finishReason,
      },
      provider: this.provider.name,
      model: this.runner.resolveModel(NOVEL_COORDINATOR_AGENT),
      maxAttempts: this.maxAttempts,
    });
  }

  private stepInputHash(action: NovelCoordinatorAction | null, errorCode: string): string {
    return hashTaskRequest({
      chapterId: null,
      taskType: 'novel.coordinator.step',
      inputSnapshot:
        action === null
          ? { errorCode }
          : {
              action: action.action,
              question: action.input.question,
              options: action.input.options,
              finishReason: action.input.finishReason,
            },
      provider: this.provider.name,
      model: this.runner.resolveModel(NOVEL_COORDINATOR_AGENT),
      maxAttempts: this.maxAttempts,
    });
  }

  private async commitSuccess(
    run: ClaimedNovelRun,
    fresh: RunExecutionState,
    action: NovelCoordinatorAction,
    result: NovelToolResult,
    calls: readonly PendingCall[],
  ): Promise<void> {
    const nextStatus = result.status;
    const stepNo = fresh.step_count + 1;

    await this.db.$transaction(async (tx) => {
      const updated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "novel_runs"
        SET "status" = ${nextStatus},
            "state_summary" = ${JSON.stringify(result.stateSummary)}::jsonb,
            "state_version" = "state_version" + 1,
            "current_goal" = ${action.objective},
            "last_decision_summary" = ${action.decisionSummary},
            "step_count" = "step_count" + 1,
            "locked_by" = NULL,
            "lease_until" = NULL,
            "heartbeat_at" = NULL,
            "completed_at" = CASE
              WHEN ${nextStatus} IN ('completed', 'failed', 'cancelled') THEN clock_timestamp()
              ELSE NULL
            END,
            "updated_at" = clock_timestamp()
        WHERE "id" = ${run.id}::uuid
          AND "status" = 'running'
          AND "locked_by" = ${this.workerId}
          AND "state_version" = ${fresh.state_version}
          AND "cancel_requested_at" IS NULL
        RETURNING "id"
      `;
      if (updated.length === 0) {
        throw new CommitAborted('lease-lost');
      }
      const step = await tx.novelRunStep.create({
        data: {
          runId: run.id,
          stepNo,
          decision: action as unknown as Prisma.InputJsonValue,
          toolName: action.action,
          inputHash: this.stepInputHash(action, ''),
          outputSummary: result.outputSummary as unknown as Prisma.InputJsonValue,
          status: 'succeeded',
          errorCode: null,
        },
        select: { id: true },
      });
      if (calls.length > 0) {
        await tx.novelAgentCall.createMany({
          data: calls.map((call) => ({
            runId: run.id,
            stepId: step.id,
            callKind: call.callKind,
            agentName: call.agentName,
            agentVersion: call.agentVersion,
            provider: call.provider,
            model: call.model,
            promptTokens: call.promptTokens,
            completionTokens: call.completionTokens,
            latencyMs: call.latencyMs,
            success: call.success,
            errorCode: call.errorCode,
          })),
        });
      }
    });
  }

  private async commitFailure(
    run: ClaimedNovelRun,
    fresh: RunExecutionState,
    errorCode: string,
    calls: readonly PendingCall[],
    toolName: string,
    recordStep: boolean,
  ): Promise<void> {
    const stepNo = fresh.step_count + 1;
    const canRecordStep = recordStep && stepNo <= fresh.max_steps && stepNo <= 100;
    await this.db.$transaction(async (tx) => {
      const updated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "novel_runs"
        SET "status" = 'failed',
            "state_version" = "state_version" + 1,
            "step_count" = CASE WHEN ${canRecordStep} THEN "step_count" + 1 ELSE "step_count" END,
            "locked_by" = NULL,
            "lease_until" = NULL,
            "heartbeat_at" = NULL,
            "completed_at" = clock_timestamp(),
            "updated_at" = clock_timestamp()
        WHERE "id" = ${run.id}::uuid
          AND "status" = 'running'
          AND "locked_by" = ${this.workerId}
          AND "state_version" = ${fresh.state_version}
          AND "cancel_requested_at" IS NULL
        RETURNING "id"
      `;
      if (updated.length === 0) {
        throw new CommitAborted('lease-lost');
      }
      if (!canRecordStep) {
        return;
      }
      const step = await tx.novelRunStep.create({
        data: {
          runId: run.id,
          stepNo,
          decision: {},
          toolName,
          inputHash: this.stepInputHash(null, errorCode),
          outputSummary: { kind: 'failed' },
          status: 'failed',
          errorCode,
        },
        select: { id: true },
      });
      if (calls.length > 0) {
        await tx.novelAgentCall.createMany({
          data: calls.map((call) => ({
            runId: run.id,
            stepId: step.id,
            callKind: call.callKind,
            agentName: call.agentName,
            agentVersion: call.agentVersion,
            provider: call.provider,
            model: call.model,
            promptTokens: call.promptTokens,
            completionTokens: call.completionTokens,
            latencyMs: call.latencyMs,
            success: call.success,
            errorCode: call.errorCode,
          })),
        });
      }
    });
  }

  private async failWithoutStep(runId: string, stateVersion: number): Promise<void> {
    const updated = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "novel_runs"
      SET "status" = 'failed',
          "state_version" = "state_version" + 1,
          "locked_by" = NULL,
          "lease_until" = NULL,
          "heartbeat_at" = NULL,
          "completed_at" = clock_timestamp(),
          "updated_at" = clock_timestamp()
      WHERE "id" = ${runId}::uuid
        AND "status" = 'running'
        AND "locked_by" = ${this.workerId}
        AND "state_version" = ${stateVersion}
        AND "cancel_requested_at" IS NULL
      RETURNING "id"
    `;
    if (updated.length === 0) {
      throw new CommitAborted('lease-lost');
    }
  }
}
