/**
 * @novel/works —— 小说作品核心（M2-A）。
 *
 * 只包含"作品 / 题材规则包 / 作品设定"三类对象；
 * 章节、人物、境界、大纲生成与模型调用**不在**本阶段范围内。
 */

export {
  ALLOWED_RULE_PACKAGE_CODE,
  DEFAULT_TARGET_CHAPTERS,
  DEFAULT_TARGET_WORDS_PER_CHAPTER,
  MAX_SUMMARY_LENGTH,
  MAX_TARGET_CHAPTERS,
  MAX_TARGET_WORDS_PER_CHAPTER,
  MAX_TITLE_LENGTH,
  MIN_TARGET_CHAPTERS,
  MIN_TARGET_WORDS_PER_CHAPTER,
  assertTargetChapters,
  assertTargetWordsPerChapter,
  assertUsableRulePackage,
  createWork,
  getWork,
  listActiveRulePackages,
  listWorks,
  normalizeSummary,
  normalizeTitle,
  updateWork,
} from './works.js';

export type {
  CreateWorkInput,
  RulePackageView,
  UpdateWorkInput,
  WorkDetailView,
  WorkSettingView,
  WorkView,
} from './works.js';
