/**
 * 单章候选流水线的共享类型（A1-2）。
 *
 * 边界：
 * - 合同 / 候选只承载"计划与正文"，不承载 prompt、模型原始响应或密钥；
 * - 上下文只在内存与 task_contexts 摘要中存在，模型输入由确定性代码组装。
 */

/** 工作流 taskType。 */
export const CHAPTER_DRAFT_TASK_TYPE = 'chapter.draft';

/** 正文候选的最少字数（非空白字符数）。 */
export const MIN_DRAFT_WORDS = 1200;

/** 合同目标字数的允许区间（与数据库 CHECK 一致）。 */
export const MIN_CONTRACT_TARGET_WORDS = 2500;
export const MAX_CONTRACT_TARGET_WORDS = 4000;

/** 正文候选的最大字符数（与数据库 CHECK 一致）。 */
export const MAX_DRAFT_CHARS = 200_000;

/** 单类上下文实体（人物 / 境界 / 势力）最多进入 Agent 的条数。 */
export const MAX_CONTEXT_ENTITIES_PER_TYPE = 50;

/**
 * 允许生成候选的章节状态。
 *
 * 与采纳共用同一组"开放"状态：`finalized / abandoned` 是关闭态，
 * 既不能再生成，也不能再采纳（不为已定稿章节自动重开）。
 */
export const GENERATION_CHAPTER_STATUSES = [
  'planned',
  'outlined',
  'drafting',
  'in_review',
] as const;

/**
 * 章节是否允许生成候选。
 *
 * 用"白名单"而不是"黑名单"：将来新增状态时默认拒绝，
 * 不会因为忘记更新判断而让已关闭的章节继续生成。
 */
export function isChapterOpenForGeneration(status: string): boolean {
  return (GENERATION_CHAPTER_STATUSES as readonly string[]).includes(status);
}

/** 写作风格参数（由任务输入覆盖，缺省从作品方向推导）。 */
export interface ChapterStyle {
  readonly tone: string;
  readonly pointOfView: string;
  readonly pacing: string;
}

/** Planner 输出的一个场景节拍。 */
export interface PlannerScene {
  readonly purpose: string;
  readonly location: string;
  readonly conflict: string;
  readonly outcome: string;
}

/** Planner 的严格输出（已通过 Schema 与代码双重校验）。 */
export interface PlannerOutput {
  readonly goal: string;
  readonly mustInclude: readonly string[];
  readonly mustNotInclude: readonly string[];
  readonly characters: readonly string[];
  readonly scenes: readonly PlannerScene[];
  readonly targetWords: number;
}

/** 上下文中的人物 / 境界 / 势力摘要。 */
export interface ContextEntity {
  readonly id: string;
  readonly name: string;
  /** 不含 name 的属性摘要；秘密类字段一律排除。 */
  readonly summary: string;
}

/** 一次执行装配出的完整上下文（只在内存中使用）。 */
export interface ChapterDraftContext {
  readonly work: {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly authorId: string;
  };
  readonly chapter: {
    readonly id: string;
    readonly chapterNo: number;
    readonly title: string;
    /** 读取时的章节状态（已校验为可生成）。 */
    readonly status: string;
  };
  readonly style: ChapterStyle;
  readonly targetWords: number;
  /** 作品方向：字段标签 → 展示值（不含原始字段名）。 */
  readonly direction: Readonly<Record<string, string>>;
  readonly characters: readonly ContextEntity[];
  readonly realms: readonly ContextEntity[];
  readonly factions: readonly ContextEntity[];
}

/** 实际写入 task_contexts 的一条来源。 */
export interface ContextSource {
  readonly contextType: string;
  /** 截断提示等非实体来源为 null。 */
  readonly refId: string | null;
  readonly snippet: string;
  readonly rank: number;
}

/** 上下文的组装结果。 */
export interface AssembledContext {
  readonly context: ChapterDraftContext;
  readonly sources: readonly ContextSource[];
}

/** 冻结后的章节合同（应用层视图）。 */
export interface FrozenContract {
  readonly id: string;
  readonly workId: string;
  readonly chapterId: string;
  readonly generationTaskId: string;
  readonly versionNo: number;
  readonly goal: string;
  readonly mustInclude: readonly string[];
  readonly mustNotInclude: readonly string[];
  readonly characters: readonly string[];
  readonly scenes: readonly PlannerScene[];
  readonly targetWords: number;
  readonly status: 'frozen';
}

/** 通过校验的正文候选。 */
export interface ValidatedDraft {
  readonly text: string;
  readonly wordCount: number;
}
