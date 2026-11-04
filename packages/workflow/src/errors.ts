/**
 * 工作流内核的稳定错误类型（A1-1）。
 *
 * 约束：
 * - 每个错误都有稳定的 `code`，供 Worker 决定重试/失败与测试断言；
 * - `message` 必须是**可安全落库/展示**的文案：不含 prompt、正文、API Key，
 *   也不含模型返回的原始错误体；
 * - 原始异常只允许在进程内用于调试，绝不写入 generation_tasks 或 llm_call_logs。
 */

/** 工作流 / Provider / Agent 的稳定错误码。 */
export type WorkflowErrorCode =
  | 'WORKFLOW_NOT_REGISTERED'
  | 'WORKFLOW_STEP_FAILED'
  | 'WORKFLOW_INTERNAL_ERROR'
  | 'TASK_LEASE_LOST'
  | 'TASK_INPUT_INVALID'
  | 'TASK_VALIDATION_FAILED'
  | 'AGENT_DEFINITION_INVALID'
  | 'AGENT_SCHEMA_INVALID'
  | 'AGENT_INPUT_INVALID'
  | 'AGENT_OUTPUT_INVALID'
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_NETWORK_ERROR'
  | 'MODEL_TIMEOUT'
  | 'MODEL_ABORTED'
  | 'MODEL_HTTP_ERROR'
  | 'MODEL_INVALID_RESPONSE';

/** 工作流基础错误。 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  /** 是否允许 Worker 在还有次数时重试。 */
  readonly retryable: boolean;

  constructor(code: WorkflowErrorCode, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * 步骤作者显式声明的「可重试」错误（网络抖动、限流、临时不可用）。
 *
 * 不写进任务表的消息：Worker 只用 code + 固定文案落库。
 */
export class RetryableTaskError extends WorkflowError {
  constructor(code: WorkflowErrorCode = 'WORKFLOW_STEP_FAILED', message = '步骤暂时失败') {
    super(code, message, { retryable: true });
    this.name = 'RetryableTaskError';
  }
}

/** 步骤作者显式声明的「不可重试」错误（输入非法、业务拒绝）。 */
export class NonRetryableTaskError extends WorkflowError {
  constructor(code: WorkflowErrorCode = 'WORKFLOW_STEP_FAILED', message = '步骤执行失败') {
    super(code, message, { retryable: false });
    this.name = 'NonRetryableTaskError';
  }
}

/** 租约已丢失：当前 Worker 不再拥有该任务，必须立即停止写入。 */
export class TaskLeaseLostError extends WorkflowError {
  constructor() {
    super('TASK_LEASE_LOST', '任务租约已失效', { retryable: false });
    this.name = 'TaskLeaseLostError';
  }
}

/** 判断异常是否带「可重试」语义。 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof WorkflowError) {
    return error.retryable;
  }
  return false;
}

/** 落库用的安全错误信息。 */
export interface SanitizedTaskError {
  readonly code: WorkflowErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * 把任意异常收敛成可落库的安全字段。
 *
 * 只接受本模块定义的错误；未知异常一律返回固定文案，
 * 因此调用方**不要**把 `error.message` 直接传给本函数之外的地方。
 */
export function sanitizeTaskError(error: unknown): SanitizedTaskError {
  if (error instanceof WorkflowError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: 'WORKFLOW_INTERNAL_ERROR',
    message: '任务执行失败',
    retryable: false,
  };
}
