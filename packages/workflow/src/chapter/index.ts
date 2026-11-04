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
  adoptChapterCandidate,
  type AdoptChapterCandidateInput,
  type AdoptedChapterVersion,
  type AdoptionMeta,
} from './adoption.js';
export {
  MAX_CHAPTER_NO,
  MAX_CHAPTER_TITLE_LENGTH,
  createChapter,
  getChapterCandidate,
  getChapterDetail,
  startChapterDraft,
  toTaskSummary,
  type ChapterCandidateDetailView,
  type ChapterCandidateSummaryView,
  type ChapterDetailView,
  type ChapterSummaryView,
  type ChapterTaskSummaryView,
  type CreateChapterInput,
  type StartChapterDraftInput,
} from './service.js';
export {
  CHAPTER_DRAFT_TASK_TYPE,
  MAX_CONTEXT_ENTITIES_PER_TYPE,
  MAX_CONTRACT_TARGET_WORDS,
  MAX_DRAFT_CHARS,
  MIN_CONTRACT_TARGET_WORDS,
  MIN_DRAFT_WORDS,
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
