/**
 * 确定性工作流内核（A1-1）。
 *
 * 职责边界：
 * - 内核只按**注册表里固定的步骤顺序**执行，不根据模型输出决定下一步；
 * - 内核不访问数据库：进度持久化、租约、取消状态都由 Worker 通过回调注入；
 * - 步骤失败只做分类（可重试 / 不可重试），重试与状态迁移属于 Worker。
 *
 * 这样 Kernel 可以在没有数据库、没有网络的单测里完整跑通。
 */

import { sanitizeTaskError, TaskLeaseLostError, WorkflowError } from './errors.js';

/** 任务信封：内核执行所需的全部输入（不含 prompt/正文）。 */
export interface WorkflowTaskEnvelope {
  readonly taskId: string;
  readonly workId: string;
  readonly chapterId: string | null;
  readonly requestId: string;
  readonly taskType: string;
  readonly input: unknown;
}

/** 单个步骤的上下文。 */
export interface WorkflowStepContext {
  readonly task: WorkflowTaskEnvelope;
  readonly stepName: string;
  /** 租约丢失 / 服务停止时中止；步骤应尽快返回。 */
  readonly signal: AbortSignal;
}

/** 一个确定性步骤。 */
export interface WorkflowStep {
  readonly name: string;
  run(context: WorkflowStepContext): Promise<void>;
}

/** 工作流定义：taskType + 固定步骤序列。 */
export interface WorkflowDefinition {
  readonly taskType: string;
  readonly steps: readonly WorkflowStep[];
}

/** 执行选项（由 Worker 注入）。 */
export interface WorkflowExecutionOptions {
  readonly signal: AbortSignal;
  /** 每个步骤前、以及全部步骤完成后调用；返回 true 表示已请求取消。 */
  readonly isCancelled: () => Promise<boolean>;
  /** 步骤成功后的检查点（Worker 写 current_step）。 */
  readonly onStepCompleted: (stepName: string) => Promise<void>;
}

/** 执行结果。 */
export interface WorkflowExecutionResult {
  readonly status: 'succeeded' | 'cancelled';
  readonly completedSteps: readonly string[];
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAX_STEPS = 20;

/** 自定义守卫：避免 `Array.isArray` 把只读数组窄化成 any[]。 */
function isStepList(value: unknown): value is readonly WorkflowStep[] {
  return Array.isArray(value);
}

/** 步骤失败（已脱敏：只含步骤名与稳定错误码）。 */
export class WorkflowStepError extends WorkflowError {
  readonly stepName: string;

  constructor(stepName: string, error: unknown) {
    const sanitized = sanitizeTaskError(error);
    // 未知异常按可重试处理：基础设施抖动更常见，且 attempt 上限会兜底。
    const retryable = error instanceof WorkflowError ? sanitized.retryable : true;
    super(sanitized.code, `步骤 ${stepName} 执行失败`, { retryable });
    this.name = 'WorkflowStepError';
    this.stepName = stepName;
  }
}

/** 工作流注册表（taskType 唯一）。 */
export class WorkflowRegistry {
  private readonly definitions = new Map<string, WorkflowDefinition>();

  register(definition: WorkflowDefinition): void {
    if (
      typeof definition.taskType !== 'string' ||
      !NAME_PATTERN.test(definition.taskType) ||
      definition.taskType.length > 64
    ) {
      throw new WorkflowError('WORKFLOW_NOT_REGISTERED', 'taskType 不合法');
    }
    if (this.definitions.has(definition.taskType)) {
      throw new WorkflowError('WORKFLOW_NOT_REGISTERED', `taskType 已注册：${definition.taskType}`);
    }
    const steps = definition.steps;
    if (!isStepList(steps) || steps.length === 0) {
      throw new WorkflowError('WORKFLOW_NOT_REGISTERED', '工作流至少需要一个步骤');
    }
    if (steps.length > MAX_STEPS) {
      throw new WorkflowError('WORKFLOW_NOT_REGISTERED', `工作流步骤不能超过 ${MAX_STEPS} 个`);
    }
    const names = new Set<string>();
    for (const step of steps) {
      if (typeof step.name !== 'string' || !NAME_PATTERN.test(step.name)) {
        throw new WorkflowError('WORKFLOW_NOT_REGISTERED', 'step.name 不合法');
      }
      if (names.has(step.name)) {
        throw new WorkflowError('WORKFLOW_NOT_REGISTERED', `步骤名重复：${step.name}`);
      }
      if (typeof step.run !== 'function') {
        throw new WorkflowError('WORKFLOW_NOT_REGISTERED', `步骤缺少 run：${step.name}`);
      }
      names.add(step.name);
    }
    this.definitions.set(definition.taskType, definition);
  }

  get(taskType: string): WorkflowDefinition {
    const found = this.definitions.get(taskType);
    if (found === undefined) {
      throw new WorkflowError('WORKFLOW_NOT_REGISTERED', `未注册的工作流：${taskType}`);
    }
    return found;
  }

  list(): readonly string[] {
    return [...this.definitions.keys()].sort();
  }
}

/** 确定性执行器。 */
export class WorkflowKernel {
  constructor(private readonly registry: WorkflowRegistry) {}

  async execute(
    task: WorkflowTaskEnvelope,
    options: WorkflowExecutionOptions,
  ): Promise<WorkflowExecutionResult> {
    const definition = this.registry.get(task.taskType);
    const completed: string[] = [];

    for (const step of definition.steps) {
      this.assertRunning(options.signal);
      if (await options.isCancelled()) {
        return { status: 'cancelled', completedSteps: completed };
      }

      try {
        await step.run({ task, stepName: step.name, signal: options.signal });
      } catch (error) {
        if (error instanceof TaskLeaseLostError) {
          throw error;
        }
        throw new WorkflowStepError(step.name, error);
      }

      // 检查点写入失败通常意味着租约已丢：直接向上抛，Worker 会停止写入。
      await options.onStepCompleted(step.name);
      completed.push(step.name);
    }

    this.assertRunning(options.signal);
    if (await options.isCancelled()) {
      return { status: 'cancelled', completedSteps: completed };
    }
    return { status: 'succeeded', completedSteps: completed };
  }

  /** 中止信号：停止后续步骤，并按租约丢失处理（不写成功状态）。 */
  private assertRunning(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new TaskLeaseLostError();
    }
  }
}
