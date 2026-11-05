/** 单章候选流水线（A1-2）对外入口。 */

export {
  PLANNER_CHAPTER_AGENT,
  WRITER_CHAPTER_AGENT,
  countWords,
  normalizePlannerOutput,
  prepareDraftText,
} from './agents.js';
export { buildChapterDraftContext, type BuildContextInput } from './context.js';
export {
  MAX_DIFF_CONTENT_CHARS,
  MAX_DIFF_EDIT_DISTANCE,
  MAX_DIFF_LINES_PER_SIDE,
  diffChapterVersions,
  diffTextLines,
  splitDiffLines,
  summarizeDiff,
  type ChapterDiffLine,
  type ChapterDiffLineKind,
  type ChapterDiffStats,
  type ChapterDiffVersionRef,
  type ChapterVersionDiffView,
  type DiffChapterVersionsInput,
} from './diff.js';

export { MOCK_CHAPTER_DRAFT, createChapterMockProvider } from './mock.js';
export {
  adoptChapterCandidate,
  type AdoptChapterCandidateInput,
  type AdoptedChapterVersion,
  type AdoptionMeta,
} from './adoption.js';
export { finalizeChapter, type FinalizeChapterInput, type FinalizedChapter } from './finalize.js';
export {
  CHAPTER_FACT_TYPES,
  CONTINUITY_EXTRACTOR_AGENT,
  ChapterFactsInvalidError,
  FACT_RUN_LEASE_MS,
  MAX_CHAPTER_FACTS,
  MAX_FACT_TEXT_LENGTH,
  MAX_LOCATION_NAME_LENGTH,
  PLOT_THREAD_STATUSES,
  extractChapterFacts,
  validateFactsOutput,
  type ChapterFact,
  type ChapterFactInput,
  type ChapterFactType,
  type ChapterFactsResult,
  type ExtractChapterFactsInput,
  type FactEntityRef,
} from './facts.js';
export { CONTINUITY_FACTS_MOCK_OUTPUT, createContinuityFactsMockProvider } from './facts-mock.js';
export { createChapterFactProviderFromEnv } from './facts-provider.js';
export {
  CHAPTER_REVIEWER_MOCK_OUTPUT,
  createChapterReviewerMockProvider,
  type ChapterReviewerMockOptions,
} from './reviewer-mock.js';
export {
  CHAPTER_REVIEW_ISSUE_TYPES,
  CHAPTER_REVIEW_SEVERITIES,
  MAX_REVIEW_DRAFT_CHARS,
  MAX_REVIEW_ENTITIES_PER_TYPE,
  MAX_REVIEW_EVIDENCE_CHARS,
  MAX_REVIEW_ISSUES,
  MAX_REVIEW_PRIOR_SUMMARIES,
  MAX_REVIEW_PRIOR_SUMMARY_CHARS,
  MAX_REVIEW_SUGGESTION_CHARS,
  REVIEWER_CHAPTER_AGENT,
  runChapterReviewer,
  validateReviewerOutput,
  type ChapterReviewEntity,
  type ChapterReviewIssue,
  type ChapterReviewIssueType,
  type ChapterReviewPriorSummary,
  type ChapterReviewSeverity,
  type ChapterReviewerInput,
  type ChapterReviewerOutput,
} from './reviewer.js';
export {
  MAX_CHAPTER_FACT_LIST,
  getChapterFactCandidate,
  getChapterFactRun,
  listChapterFacts,
  type ChapterFactCandidateDetail,
  type ChapterFactListResult,
  type ChapterFactRunSummary,
  type ChapterFactView,
} from './fact-read.js';
export {
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_CHAPTER_TEXT_CHARS,
  MAX_SUMMARY_NO,
  MAX_SUMMARY_TITLE_CHARS,
  SUMMARIZER_CHAPTER_AGENT,
  assertSummarizerInput,
  runChapterSummarizer,
  validateSummarizerOutput,
  type ChapterSummarizerInput,
  type ChapterSummarizerOutput,
} from './summarizer.js';
export {
  CHAPTER_SUMMARIZER_MOCK_OUTPUT,
  createChapterSummarizerMockProvider,
  type ChapterSummarizerMockOptions,
} from './summarizer-mock.js';
export {
  normalizeHumanContent,
  restoreChapterVersion,
  saveHumanChapterVersion,
  type RestoreChapterVersionInput,
  type RestoredChapterVersion,
  type SaveHumanChapterVersionInput,
  type SavedHumanChapterVersion,
} from './human.js';
export {
  MAX_CHAPTER_NO,
  MAX_CHAPTER_TITLE_LENGTH,
  createChapter,
  getChapterCandidate,
  getChapterDetail,
  getChapterVersion,
  listChapterVersions,
  listChapters,
  startChapterDraft,
  toTaskSummary,
  type ChapterCandidateDetailView,
  type ChapterCandidateSummaryView,
  type ChapterDetailView,
  type ChapterListItemView,
  type ChapterSummaryView,
  type ChapterTaskSummaryView,
  type ChapterVersionDetailView,
  type ChapterVersionSummaryView,
  type CreateChapterInput,
  type StartChapterDraftInput,
} from './service.js';
export {
  CHAPTER_DRAFT_TASK_TYPE,
  CHAPTER_REVIEW_TASK_TYPE,
  CHAPTER_SUMMARY_TASK_TYPE,
  MAX_CONTEXT_ENTITIES_PER_TYPE,
  MAX_CONTRACT_TARGET_WORDS,
  MAX_DRAFT_CHARS,
  MIN_CONTRACT_TARGET_WORDS,
  MIN_DRAFT_WORDS,
  FINALIZED_CHAPTER_STATUS,
  RESTORE_CHAPTER_STATUSES,
  SAVED_CHAPTER_STATUS,
  SAVE_CHAPTER_STATUSES,
  isChapterFinalizable,
  isChapterOpenForRestore,
  isChapterOpenForSave,
} from './types.js';
export type {
  AssembledContext,
  ChapterDraftContext,
  ChapterStyle,
  ContextEntity,
  ContextSource,
  FrozenContract,
  PlannerOutput,
  PlannerScene,
  ValidatedDraft,
} from './types.js';
export { createChapterDraftWorkflow, type ChapterDraftWorkflowOptions } from './workflow.js';
export {
  buildChapterReviewContext,
  getReviewRunByTaskId,
  markReviewRunFailed,
  parseChapterReviewTaskInput,
  persistReviewResult,
  prepareReviewRun,
  type ChapterReviewContext,
  type ChapterReviewRunRow,
  type ChapterReviewTaskInput,
  type ReviewTaskFence,
} from './review.js';
export {
  createChapterReviewWorkflow,
  type ChapterReviewWorkflowOptions,
} from './review-workflow.js';
export {
  createChapterSummaryWorkflow,
  type ChapterSummaryWorkflowOptions,
} from './summary-workflow.js';
export {
  ensureSummaryTask,
  findExistingSummary,
  loadChapterSummaryContext,
  parseChapterSummaryTaskInput,
  persistChapterSummary,
  summaryTaskRequestId,
  type ChapterSummaryContext,
  type ChapterSummaryTaskInput,
  type PersistChapterSummaryInput,
  type SummaryTaskFence,
} from './summary.js';
export { ensureDeterministicTask, type ModelTaskSpec } from './persistence.js';
export {
  ensureReviewTask,
  reviewTaskRequestId,
  type ReviewTaskSpec,
  type TaskFenceScope,
} from './persistence.js';
export {
  loadSafeEntityGroups,
  toSafeEntityRefs,
  type SafeEntityRef,
  type SafeEntityRow,
} from './safe-entities.js';
