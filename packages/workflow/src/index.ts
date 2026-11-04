/**
 * @novel/workflow —— A1-1 工作流内核。
 *
 * 分层：
 * - `provider` / `providers/*`：模型接入（Mock 与 OpenAI 兼容）；
 * - `agent`：轻量 AgentDefinition + 严格 Schema 校验；
 * - `kernel`：确定性步骤执行（不碰数据库、不决定下一步）；
 * - `queue` / `worker`：PostgreSQL 任务队列、租约、心跳、重试、取消与幂等。
 *
 * A1-1 **不包含** Planner / Writer 业务实现，也不提供生成 API 或章节 UI。
 */

export {
  NonRetryableTaskError,
  RetryableTaskError,
  TaskLeaseLostError,
  WorkflowError,
  isRetryableError,
  sanitizeTaskError,
  type SanitizedTaskError,
  type WorkflowErrorCode,
} from './errors.js';

export {
  assertJsonSchema,
  validateJson,
  type JsonIssue,
  type JsonPrimitive,
  type JsonSchema,
  type JsonSchemaType,
} from './json-schema.js';

export {
  ModelProviderError,
  estimateTokens,
  isModelProviderError,
  type ModelErrorCode,
  type ModelJsonInput,
  type ModelJsonResult,
  type ModelMessage,
  type ModelProvider,
  type ModelTextInput,
  type ModelTextResult,
  type ModelUsage,
} from './model-types.js';

export {
  MockProvider,
  type MockJsonResponder,
  type MockProviderOptions,
  type MockTextResponder,
} from './providers/mock.js';
export {
  OpenAICompatibleProvider,
  type FetchLike,
  type OpenAICompatibleConfig,
} from './providers/openai-compatible.js';
export {
  createModelProvider,
  createModelProviderFromEnv,
  readProviderConfig,
  type ModelProviderKind,
  type ProviderRuntimeConfig,
} from './provider.js';

export {
  AgentInputInvalidError,
  AgentOutputInvalidError,
  AgentRegistry,
  AgentRunner,
  DETERMINISTIC_TEST_AGENT,
  assertAgentDefinition,
  type AgentDefinition,
  type AgentRunOptions,
  type AgentRunResult,
} from './agent.js';

export {
  WorkflowKernel,
  WorkflowRegistry,
  WorkflowStepError,
  type WorkflowDefinition,
  type WorkflowExecutionOptions,
  type WorkflowExecutionResult,
  type WorkflowStep,
  type WorkflowStepContext,
  type WorkflowTaskEnvelope,
} from './kernel.js';

export {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_CONTEXT_SNIPPET_CHARS,
  MAX_INPUT_SNAPSHOT_CHARS,
  MAX_MAX_ATTEMPTS,
  TASK_STATUSES,
  claimNextTask,
  completeTask,
  createGenerationTask,
  failTask,
  getGenerationTask,
  getGenerationTaskForAuthor,
  getTaskCancellationState,
  heartbeatTask,
  listTaskContexts,
  markTaskCancelled,
  recordLlmCall,
  requestTaskCancellationForAuthor,
  sweepExpiredTasks,
  updateTaskStep,
  upsertTaskContext,
  type CreateGenerationTaskInput,
  type GenerationTaskView,
  type LlmCallLogInput,
  type TaskCancelReader,
  type TaskContextView,
  type TaskReader,
  type TaskStatus,
} from './queue.js';

export {
  WorkerRunner,
  type WorkerLogger,
  type WorkerRunnerOptions,
  type WorkerRunOutcome,
} from './worker.js';
