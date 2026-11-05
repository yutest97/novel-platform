/**
 * @novel/workflow —— 工作流内核与单章候选流水线（A1-1 / A1-2）。
 *
 * 分层：
 * - `provider` / `providers/*`：模型接入（Mock 与 OpenAI 兼容）；
 * - `agent`：轻量 AgentDefinition + 严格 Schema 校验；
 * - `kernel`：确定性步骤执行（不碰数据库、不决定下一步）；
 * - `queue` / `worker`：PostgreSQL 任务队列、租约、心跳、重试、取消与幂等；
 * - `chapter/*`：`chapter.draft` 流水线（Planner / Writer / ContextBuilder / 合同与候选）。
 *
 * 仍不提供生成 HTTP API、章节 UI、候选采纳与 chapter_versions（A1-3）。
 */

export {
  NonRetryableTaskError,
  RetryableTaskError,
  TASK_MODEL_CONFIG_MISMATCH_MESSAGE,
  TaskLeaseLostError,
  TaskModelConfigMismatchError,
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
  type ModelProviderIdentity,
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
  createWorkflowExecutionState,
  type WorkflowDefinition,
  type WorkflowExecutionOptions,
  type WorkflowExecutionResult,
  type WorkflowExecutionState,
  type WorkflowStep,
  type WorkflowStepContext,
  type WorkflowTaskEnvelope,
} from './kernel.js';

export {
  CanonicalJsonError,
  TASK_INPUT_HASH_LENGTH,
  canonicalJsonStringify,
  hashTaskRequest,
  serializeTaskRequestFingerprint,
  type TaskRequestFingerprintInput,
} from './request-hash.js';

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
  toGenerationTaskView,
  updateTaskStep,
  upsertTaskContext,
  type CreateGenerationTaskInput,
  type GenerationTaskRowShape,
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

export {
  CHAPTER_DRAFT_TASK_TYPE,
  MAX_CHAPTER_NO,
  MAX_CHAPTER_TITLE_LENGTH,
  MAX_CONTEXT_ENTITIES_PER_TYPE,
  MAX_CONTRACT_TARGET_WORDS,
  MAX_DIFF_CONTENT_CHARS,
  MAX_DIFF_EDIT_DISTANCE,
  MAX_DIFF_LINES_PER_SIDE,
  MAX_DRAFT_CHARS,
  MIN_CONTRACT_TARGET_WORDS,
  MIN_DRAFT_WORDS,
  MOCK_CHAPTER_DRAFT,
  SAVED_CHAPTER_STATUS,
  SAVE_CHAPTER_STATUSES,
  PLANNER_CHAPTER_AGENT,
  WRITER_CHAPTER_AGENT,
  adoptChapterCandidate,
  buildChapterDraftContext,
  countWords,
  createChapter,
  createChapterDraftWorkflow,
  createChapterMockProvider,
  diffChapterVersions,
  diffTextLines,
  finalizeChapter,
  getChapterCandidate,
  getChapterDetail,
  getChapterVersion,
  isChapterOpenForSave,
  listChapterVersions,
  listChapters,
  normalizeHumanContent,
  normalizePlannerOutput,
  prepareDraftText,
  restoreChapterVersion,
  splitDiffLines,
  summarizeDiff,
  saveHumanChapterVersion,
  startChapterDraft,
  toTaskSummary,
  type AdoptChapterCandidateInput,
  type AdoptedChapterVersion,
  type AdoptionMeta,
  type AssembledContext,
  type BuildContextInput,
  type ChapterCandidateDetailView,
  type ChapterCandidateSummaryView,
  type ChapterDetailView,
  type ChapterDiffLine,
  type ChapterDiffLineKind,
  type ChapterDiffStats,
  type ChapterDiffVersionRef,
  type ChapterDraftContext,
  type ChapterVersionDiffView,
  type FinalizeChapterInput,
  type FinalizedChapter,
  type DiffChapterVersionsInput,
  type ChapterDraftWorkflowOptions,
  type ChapterListItemView,
  type ChapterStyle,
  type ChapterSummaryView,
  type ChapterTaskSummaryView,
  type ChapterVersionDetailView,
  type ChapterVersionSummaryView,
  type ContextEntity,
  type ContextSource,
  type CreateChapterInput,
  type FrozenContract,
  type PlannerOutput,
  type PlannerScene,
  type RestoreChapterVersionInput,
  type RestoredChapterVersion,
  type SaveHumanChapterVersionInput,
  type SavedHumanChapterVersion,
  type StartChapterDraftInput,
  type ValidatedDraft,
} from './chapter/index.js';
