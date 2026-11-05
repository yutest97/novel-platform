/**
 * 章节 Reviewer Agent 契约与代码侧语义校验（A2-C-A）。
 *
 * 定位：
 * - Reviewer 只把冻结合同、正文候选和必要的安全摘要变成结构化问题；
 * - 不重写正文、不决定采纳、不访问数据库，也不接入 `chapter.draft` 工作流；
 * - Schema 负责类型、枚举、长度和未知字段，代码负责 trim、引文真实性、
 *   `passed` 一致性和重复问题等语义边界。
 */

import type { AgentDefinition, AgentRunOptions, AgentRunResult, AgentRunner } from '../agent.js';
import { AgentOutputInvalidError } from '../agent.js';
import type { JsonIssue, JsonSchema } from '../json-schema.js';
import { validateJson } from '../json-schema.js';

/** 审阅严重级别（稳定白名单）。 */
export const CHAPTER_REVIEW_SEVERITIES = ['high', 'medium', 'low'] as const;
export type ChapterReviewSeverity = (typeof CHAPTER_REVIEW_SEVERITIES)[number];

/** 审阅问题类型（稳定白名单）。 */
export const CHAPTER_REVIEW_ISSUE_TYPES = [
  'contract_violation',
  'setting_contradiction',
  'timeline_conflict',
  'item_state_conflict',
  'plot_thread_conflict',
  'character_consistency',
  'prose_quality',
] as const;
export type ChapterReviewIssueType = (typeof CHAPTER_REVIEW_ISSUE_TYPES)[number];

export const MAX_REVIEW_DRAFT_CHARS = 200_000;
export const MAX_REVIEW_ENTITIES_PER_TYPE = 100;
export const MAX_REVIEW_PRIOR_SUMMARIES = 20;
export const MAX_REVIEW_PRIOR_SUMMARY_CHARS = 1_000;
export const MAX_REVIEW_ISSUES = 20;
export const MAX_REVIEW_EVIDENCE_CHARS = 300;
export const MAX_REVIEW_SUGGESTION_CHARS = 500;

/** Reviewer 输入中的安全实体摘要。 */
export interface ChapterReviewEntity {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

/** Reviewer 输入中的章节前情摘要。 */
export interface ChapterReviewPriorSummary {
  readonly chapterNo: number;
  readonly summary: string;
}

/** Reviewer 的结构化输入（正文只存在于本次模型请求）。 */
export interface ChapterReviewerInput {
  readonly chapter: {
    readonly id: string;
    readonly chapterNo: number;
    readonly title: string;
  };
  readonly contract: {
    readonly goal: string;
    readonly mustInclude: readonly string[];
    readonly mustNotInclude: readonly string[];
    readonly scenes: readonly {
      readonly purpose: string;
      readonly location: string;
      readonly conflict: string;
      readonly outcome: string;
    }[];
  };
  readonly draft: string;
  readonly characters: readonly ChapterReviewEntity[];
  readonly items: readonly ChapterReviewEntity[];
  readonly realms: readonly ChapterReviewEntity[];
  readonly factions: readonly ChapterReviewEntity[];
  readonly priorSummaries: readonly ChapterReviewPriorSummary[];
}

/** 一条已通过 Schema 与语义校验的审阅问题。 */
export interface ChapterReviewIssue {
  readonly severity: ChapterReviewSeverity;
  readonly type: ChapterReviewIssueType;
  readonly evidence: string;
  readonly suggestion: string;
}

/** Reviewer 的严格输出。 */
export interface ChapterReviewerOutput {
  readonly passed: boolean;
  readonly issues: readonly ChapterReviewIssue[];
}

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const entitySummarySchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    summary: { type: 'string', maxLength: 500 },
  },
  required: ['id', 'name', 'summary'],
  additionalProperties: false,
};

const sceneSchema: JsonSchema = {
  type: 'object',
  properties: {
    purpose: { type: 'string', minLength: 1, maxLength: 300 },
    location: { type: 'string', minLength: 1, maxLength: 120 },
    conflict: { type: 'string', minLength: 1, maxLength: 300 },
    outcome: { type: 'string', minLength: 1, maxLength: 300 },
  },
  required: ['purpose', 'location', 'conflict', 'outcome'],
  additionalProperties: false,
};

const reviewerInputSchema: JsonSchema = {
  type: 'object',
  properties: {
    chapter: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: UUID_PATTERN },
        chapterNo: { type: 'integer', minimum: 1, maximum: 100_000 },
        title: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['id', 'chapterNo', 'title'],
      additionalProperties: false,
    },
    contract: {
      type: 'object',
      properties: {
        goal: { type: 'string', minLength: 1, maxLength: 500 },
        mustInclude: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 200 },
          maxItems: 20,
        },
        mustNotInclude: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 200 },
          maxItems: 20,
        },
        scenes: { type: 'array', items: sceneSchema, minItems: 1, maxItems: 12 },
      },
      required: ['goal', 'mustInclude', 'mustNotInclude', 'scenes'],
      additionalProperties: false,
    },
    draft: { type: 'string', minLength: 1, maxLength: MAX_REVIEW_DRAFT_CHARS },
    characters: {
      type: 'array',
      items: entitySummarySchema,
      maxItems: MAX_REVIEW_ENTITIES_PER_TYPE,
    },
    items: {
      type: 'array',
      items: entitySummarySchema,
      maxItems: MAX_REVIEW_ENTITIES_PER_TYPE,
    },
    realms: {
      type: 'array',
      items: entitySummarySchema,
      maxItems: MAX_REVIEW_ENTITIES_PER_TYPE,
    },
    factions: {
      type: 'array',
      items: entitySummarySchema,
      maxItems: MAX_REVIEW_ENTITIES_PER_TYPE,
    },
    priorSummaries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          chapterNo: { type: 'integer', minimum: 1, maximum: 100_000 },
          summary: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_REVIEW_PRIOR_SUMMARY_CHARS,
          },
        },
        required: ['chapterNo', 'summary'],
        additionalProperties: false,
      },
      maxItems: MAX_REVIEW_PRIOR_SUMMARIES,
    },
  },
  required: [
    'chapter',
    'contract',
    'draft',
    'characters',
    'items',
    'realms',
    'factions',
    'priorSummaries',
  ],
  additionalProperties: false,
};

const reviewIssueSchema: JsonSchema = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: CHAPTER_REVIEW_SEVERITIES },
    type: { type: 'string', enum: CHAPTER_REVIEW_ISSUE_TYPES },
    evidence: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_REVIEW_EVIDENCE_CHARS,
    },
    suggestion: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_REVIEW_SUGGESTION_CHARS,
    },
  },
  required: ['severity', 'type', 'evidence', 'suggestion'],
  additionalProperties: false,
};

const reviewerOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    issues: {
      type: 'array',
      items: reviewIssueSchema,
      maxItems: MAX_REVIEW_ISSUES,
    },
  },
  required: ['passed', 'issues'],
  additionalProperties: false,
};

/** `reviewer.chapter@1.0.0`（reviewer-v1）。 */
export const REVIEWER_CHAPTER_AGENT: AgentDefinition = {
  name: 'reviewer.chapter',
  promptVersion: '1.0.0',
  // 由 Provider 决定模型（不把 mock 模型写进业务 Agent）。
  model: '',
  inputSchema: reviewerInputSchema,
  outputSchema: reviewerOutputSchema,
  maxOutputTokens: 4096,
  rolePrompt: [
    '你是 reviewer.chapter（reviewer-v1），负责检查章节候选正文是否符合冻结合同、',
    '设定的安全摘要与前章摘要。',
    '你只输出结构化审阅问题，不改写正文、不输出新正文、不替作者做采纳决定。',
    'evidence 必须逐字复制正文中真实存在的连续片段；suggestion 只给修改方向。',
    '问题最多 20 条；没有问题时输出 {"passed":true,"issues":[]}。',
    '存在任何问题时 passed 必须为 false。',
    '不要输出 Markdown、代码块、解释或输入中未声明的字段。',
  ].join(''),
};

function outputInvalid(issues: readonly JsonIssue[]): never {
  throw new AgentOutputInvalidError(REVIEWER_CHAPTER_AGENT, issues);
}

/**
 * 校验并规范化 Reviewer 输出。
 *
 * Schema 通过后再做语义校验：
 * - severity / type 白名单在代码中再次确认；
 * - evidence / suggestion trim 后不得为空；
 * - evidence trim 后必须仍是本次 draft 的连续子串，防止模型编造引文；
 * - `passed` 必须严格等于“issues 为空”；
 * - 重复的 `type + evidence` 直接拒绝：这一类输出通常说明模型重复报同一问题，
 *   保留或静默去重都会掩盖提示质量问题，因此不在本阶段自动修复。
 *
 * 错误只包含路径与固定原因，不回显正文、引文或建议。
 */
export function validateReviewerOutput(
  raw: unknown,
  context: { readonly draft: string },
): ChapterReviewerOutput {
  const schemaIssues = validateJson(reviewerOutputSchema, raw);
  if (schemaIssues.length > 0) {
    outputInvalid(schemaIssues);
  }

  const output = raw as ChapterReviewerOutput;
  const issues: JsonIssue[] = [];
  const normalized: ChapterReviewIssue[] = [];
  const seen = new Set<string>();

  output.issues.forEach((issue, index) => {
    const path = `$.issues[${index}]`;
    const severity = issue.severity as string;
    const type = issue.type as string;

    if (!(CHAPTER_REVIEW_SEVERITIES as readonly string[]).includes(severity)) {
      issues.push({ path: `${path}.severity`, message: '未知严重级别' });
    }
    if (!(CHAPTER_REVIEW_ISSUE_TYPES as readonly string[]).includes(type)) {
      issues.push({ path: `${path}.type`, message: '未知问题类型' });
    }

    const evidence = issue.evidence.trim();
    const suggestion = issue.suggestion.trim();
    if (evidence === '') {
      issues.push({ path: `${path}.evidence`, message: 'evidence 不能为空白' });
    } else if (!context.draft.includes(evidence)) {
      issues.push({ path: `${path}.evidence`, message: 'evidence 必须是 draft 的子串' });
    }
    if (suggestion === '') {
      issues.push({ path: `${path}.suggestion`, message: 'suggestion 不能为空白' });
    }

    const marker = `${type}\u0000${evidence}`;
    if (seen.has(marker)) {
      issues.push({ path, message: '重复的 type + evidence 问题' });
    } else {
      seen.add(marker);
    }

    normalized.push({
      severity: issue.severity,
      type: issue.type,
      evidence,
      suggestion,
    });
  });

  if (output.passed !== (output.issues.length === 0)) {
    issues.push({
      path: '$.passed',
      message: 'passed 必须与 issues 是否为空保持一致',
    });
  }

  if (issues.length > 0) {
    outputInvalid(issues);
  }
  return { passed: output.passed, issues: normalized };
}

/**
 * 运行 Reviewer 并强制经过专用语义校验。
 *
 * 纯内存调用：不记录日志、不写数据库、不决定下一步。
 */
export async function runChapterReviewer(
  runner: AgentRunner,
  input: ChapterReviewerInput,
  options: AgentRunOptions = {},
): Promise<AgentRunResult<ChapterReviewerOutput>> {
  const result = await runner.run<ChapterReviewerOutput>(REVIEWER_CHAPTER_AGENT, input, options);
  return {
    ...result,
    output: validateReviewerOutput(result.output, { draft: input.draft }),
  };
}
