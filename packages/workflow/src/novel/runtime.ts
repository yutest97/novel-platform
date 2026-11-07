/**
 * C1-A：Coordinator Runtime / Worker。
 *
 * 职责边界（与 AGENTS.md / docs/08 一致）：
 * - Coordinator 只做语义决策；Runtime 负责工具白名单、状态迁移、预算、
 *   重复动作熔断、租约、取消优先级和落库；
 * - Runtime 不替作者确认产物，也不创建任何 Work、章节或正文；
 * - 旧 Worker 晚返回时必须因租约/版本 fence 失败而**丢弃业务提交**，
 *   不写 step、不改 state；但允许追加它实际发生的脱敏调用遥测（step_id 为空）；
 * - 每次实际模型调用都立即写入 novel_agent_calls，且只写入一次；
 * - 模型硬超时与租约丢失使用独立信号：超时只影响单次 attempt，租约丢失才终止执行。
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { Prisma, PrismaClient } from '@novel/db';

import { AgentInputInvalidError, AgentOutputInvalidError, AgentRunner } from '../agent.js';
import { sanitizeTaskError } from '../errors.js';
import { validateJson } from '../json-schema.js';
import { ModelProviderError, type ModelProvider } from '../model-types.js';
import { hashTaskRequest } from '../request-hash.js';
import {
  NOVEL_COORDINATOR_AGENT,
  validateNovelCoordinatorAction,
  type NovelCoordinatorAction,
  type NovelCoordinatorInput,
} from './coordinator-agent.js';
import { getNovelToolWorkflow, type NovelToolResult } from './tool-workflows.js';
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
  /** 单次模型调用硬超时（毫秒）；生产默认 60 秒，测试可注入更短值。 */
  readonly modelCallTimeoutMs?: number;
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
  readonly lease_until: Date | null;
  readonly cancel_requested_at: Date | null;
}

/** 每次实际模型调用的脱敏遥测；写入后不再修改。 */
interface CallTelemetry {
  readonly callId: string;
  readonly runId: string;
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

type AttemptOutcome =
  | { readonly kind: 'success'; readonly action: NovelCoordinatorAction }
  | { readonly kind: 'retry'; readonly errorCode: string }
  | { readonly kind: 'stop'; readonly errorCode: string };

class CommitAborted extends Error {
  constructor(readonly outcome: 'lease-lost') {
    super(outcome);
    this.name = 'CommitAborted';
  }
}

const MAX_REPEAT_ACTIONS = 3;
const DEFAULT_TOKEN_BUDGET = 100_000;
/** 单次模型调用硬超时（生产默认 60 秒；测试通过构造参数注入更短值）。 */
const DEFAULT_MODEL_CALL_TIMEOUT_MS = 60_000;

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
  private readonly modelCallTimeoutMs: number;
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
    this.modelCallTimeoutMs = Math.max(
      1,
      options.modelCallTimeoutMs ?? DEFAULT_MODEL_CALL_TIMEOUT_MS,
    );
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
        "lease_until",
        "cancel_requested_at"
      FROM "novel_runs"
      WHERE "id" = ${runId}::uuid
    `;
    return rows[0] ?? null;
  }

  /**
   * 真实 fence：只以数据库状态为准。
   *
   * 模型超时使用的 attempt signal **不得**参与这里的判断，
   * 否则一次可重试超时会被误判成租约丢失。
   */
  private async checkFence(runId: string, stateVersion: number): Promise<boolean> {
    const state = await this.getExecutionState(runId);
    return (
      state !== null &&
      state.status === 'running' &&
      state.locked_by === this.workerId &&
      state.state_version === stateVersion &&
      state.cancel_requested_at === null &&
      state.lease_until !== null &&
      state.lease_until.getTime() > Date.now()
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
      await this.commitFailure(run, fresh, 'NOVEL_RUN_BUDGET_EXCEEDED', 'none', true);
      return 'failed';
    }

    const input: NovelCoordinatorInput = {
      requestText: fresh.request_text,
      latestAnswer: summary.latestAnswer,
      stateSummary: summary,
      allowedTools: [...NOVEL_ALLOWED_TOOLS],
      remainingSteps,
    };

    // leaseAbort 只由心跳失败 / 取消 / 真实 fence 失败触发；
    // 单次模型调用超时使用 runModelAttempt 内部的独立 attemptAbort。
    const leaseAbort = new AbortController();
    let leaseLost = false;
    const heartbeatTimer = setInterval(() => {
      void this.heartbeat(run.id, fresh.state_version)
        .then((alive) => {
          if (!alive) {
            leaseLost = true;
            leaseAbort.abort();
          }
        })
        .catch(() => {
          leaseLost = true;
          leaseAbort.abort();
        });
    }, this.heartbeatIntervalMs);

    let validated: NovelCoordinatorAction | null = null;
    let lastErrorCode = 'WORKFLOW_INTERNAL_ERROR';

    try {
      for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
        if (leaseLost || !(await this.checkFence(run.id, fresh.state_version))) {
          return 'lease-lost';
        }
        const outcome = await this.runModelAttempt(run.id, input, leaseAbort.signal);
        // 心跳已判定租约丢失 / 取消：本次结果不再作为业务失败提交。
        if (leaseLost || leaseAbort.signal.aborted) {
          return 'lease-lost';
        }
        if (outcome.kind === 'success') {
          validated = outcome.action;
          break;
        }
        lastErrorCode = outcome.errorCode;
        if (outcome.kind === 'stop') {
          break;
        }
      }
    } finally {
      clearInterval(heartbeatTimer);
      leaseAbort.abort();
    }

    if (leaseLost || !(await this.checkFence(run.id, fresh.state_version))) {
      return 'lease-lost';
    }

    if (validated === null) {
      await this.commitFailure(run, fresh, lastErrorCode, 'none', true);
      return 'failed';
    }

    // 工具白名单 → 状态可进入性 → 工具输入 Schema：全部由 Runtime 校验。
    const workflow = getNovelToolWorkflow(validated.action);
    if (workflow === null || !NOVEL_ALLOWED_TOOLS.includes(validated.action)) {
      await this.commitFailure(run, fresh, 'NOVEL_RUN_TOOL_NOT_ALLOWED', validated.action, true);
      return 'failed';
    }
    if (!workflow.allowedFromStatus.includes('running')) {
      await this.commitFailure(run, fresh, 'NOVEL_RUN_INVALID_STATE', validated.action, true);
      return 'failed';
    }
    if (validateJson(workflow.inputSchema, validated.input).length > 0) {
      await this.commitFailure(run, fresh, 'AGENT_OUTPUT_INVALID', validated.action, true);
      return 'failed';
    }

    const signature = this.actionSignature(validated);
    const repeatCount = summary.lastActionSignature === signature ? summary.repeatCount + 1 : 0;
    if (repeatCount >= MAX_REPEAT_ACTIONS - 1) {
      await this.commitFailure(run, fresh, 'COORDINATOR_LOOP_DETECTED', validated.action, true);
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
    await this.commitSuccess(run, fresh, validated, toolResult);
    return toolResult.status === 'completed' ? 'completed' : 'waiting_user';
  }

  /**
   * 单次模型调用 attempt。
   *
   * - 用 `Promise.race` 硬截断 Provider，即使 Provider 不监听 signal；
   * - 超时只 abort 本次 attemptAbort，返回可重试的 `MODEL_TIMEOUT`；
   * - 租约丢失通过 leaseSignal 让调用尽快停止，但不写业务失败；
   * - 每次实际调用完成后立即 append 一条脱敏遥测（`step_id` 为空）。
   */
  private async runModelAttempt(
    runId: string,
    input: NovelCoordinatorInput,
    leaseSignal: AbortSignal,
  ): Promise<AttemptOutcome> {
    const attemptAbort = new AbortController();
    const callId = randomUUID();
    const startedAt = performance.now();
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let onLeaseAbort: (() => void) | null = null;

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          attemptAbort.abort();
          reject(new ModelProviderError('MODEL_TIMEOUT', '模型调用超时', { retryable: true }));
        }, this.modelCallTimeoutMs);
      });
      const leaseFailure = new Promise<never>((_resolve, reject) => {
        onLeaseAbort = () => {
          reject(new ModelProviderError('MODEL_ABORTED', '模型调用已中止'));
        };
        if (leaseSignal.aborted) {
          onLeaseAbort();
        } else {
          leaseSignal.addEventListener('abort', onLeaseAbort, { once: true });
        }
      });

      const signal = AbortSignal.any([attemptAbort.signal, leaseSignal]);
      const result = await Promise.race([
        this.runner.run<unknown>(NOVEL_COORDINATOR_AGENT, input, {
          signal,
          temperature: 0,
        }),
        timeout,
        leaseFailure,
      ]);

      const semantic = validateNovelCoordinatorAction(result.output);
      if (!semantic.ok) {
        await this.appendCall({
          callId,
          runId,
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
        return { kind: 'retry', errorCode: 'AGENT_OUTPUT_INVALID' };
      }
      await this.appendCall({
        callId,
        runId,
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
      return { kind: 'success', action: semantic.action };
    } catch (error) {
      const safe = sanitizeTaskError(error);
      // 输入在调用 Provider 前就被拒绝，不产生实际模型调用，也不写调用日志。
      if (error instanceof AgentInputInvalidError) {
        return { kind: 'stop', errorCode: safe.code };
      }
      await this.appendCall({
        callId,
        runId,
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
      // Schema 输出非法与可重试错误（含 MODEL_TIMEOUT）使用剩余 attempt；
      // 永久 Provider 错误立即停止。
      if (error instanceof AgentOutputInvalidError || safe.retryable) {
        return { kind: 'retry', errorCode: safe.code };
      }
      return { kind: 'stop', errorCode: safe.code };
    } finally {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
      }
      if (onLeaseAbort !== null) {
        leaseSignal.removeEventListener('abort', onLeaseAbort);
      }
    }
  }

  /**
   * 调用遥测与业务状态提交解耦：实际调用完成后立即 append。
   *
   * 使用调用前后生成的稳定 `callId` 作为主键；同一逻辑调用只写一次，
   * 也允许旧 Worker 追加它真实发生的调用日志（`step_id` 为空）。
   */
  private async appendCall(call: CallTelemetry): Promise<void> {
    await this.db.novelAgentCall.create({
      data: {
        id: call.callId,
        runId: call.runId,
        stepId: null,
        callKind: 'coordinator',
        agentName: call.agentName,
        agentVersion: call.agentVersion,
        provider: call.provider,
        model: call.model,
        promptTokens: call.promptTokens,
        completionTokens: call.completionTokens,
        latencyMs: call.latencyMs,
        success: call.success,
        errorCode: call.errorCode,
      },
    });
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
      await tx.novelRunStep.create({
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
      });
    });
  }

  private async commitFailure(
    run: ClaimedNovelRun,
    fresh: RunExecutionState,
    errorCode: string,
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
      await tx.novelRunStep.create({
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
      });
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
