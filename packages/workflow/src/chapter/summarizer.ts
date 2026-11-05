/**
 * 章节摘要 Agent 契约与代码侧语义校验（A2-D-A）。
 *
 * 定位：
 * - `summarizer.chapter@1.0.0` 只把**一章正式定稿正文**压缩成可追溯的章节摘要；
 * - 不访问数据库、不判断章节是否定稿 / 是否最新版本、不决定下一步；
 * - 幂等、租约、落库由 A2-D-B 工作流负责（本文件不涉及）。
 *
 * 边界：
 * - 输入只有章节标识、正式版本标识与正文；不含 prompt、secret、模型原始响应或 Key；
 * - 输出只有 `summary`；未知字段、空白、超长、Markdown 结构一律拒绝；
 * - 错误只带路径与固定原因，不回显正文或摘要内容。
 */

import type { AgentDefinition, AgentRunOptions, AgentRunResult, AgentRunner } from '../agent.js';
import { AgentInputInvalidError, AgentOutputInvalidError } from '../agent.js';
import type { JsonIssue, JsonSchema } from '../json-schema.js';
import { validateJson } from '../json-schema.js';

/** 正文上限（与 chapter_versions / 候选一致）。 */
export const MAX_SUMMARY_CHAPTER_TEXT_CHARS = 200_000;
/** 摘要上限。 */
export const MAX_SUMMARY_CHARS = 1_000;
/** 章节标题上限（与数据库 CHECK 一致）。 */
export const MAX_SUMMARY_TITLE_CHARS = 200;
/** 章节号 / 版本号上限。 */
export const MAX_SUMMARY_NO = 100_000;

/** 摘要输入（正文只存在于本次模型请求）。 */
export interface ChapterSummarizerInput {
  readonly chapter: {
    readonly id: string;
    readonly chapterNo: number;
    readonly title: string;
  };
  readonly sourceVersion: {
    readonly id: string;
    readonly versionNo: number;
  };
  readonly chapterText: string;
}

/** 摘要输出（严格 Schema 通过后的结果）。 */
export interface ChapterSummarizerOutput {
  readonly summary: string;
}

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const summarizerInputSchema: JsonSchema = {
  type: 'object',
  properties: {
    chapter: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: UUID_PATTERN },
        chapterNo: { type: 'integer', minimum: 1, maximum: MAX_SUMMARY_NO },
        title: { type: 'string', minLength: 1, maxLength: MAX_SUMMARY_TITLE_CHARS },
      },
      required: ['id', 'chapterNo', 'title'],
      additionalProperties: false,
    },
    sourceVersion: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: UUID_PATTERN },
        versionNo: { type: 'integer', minimum: 1, maximum: MAX_SUMMARY_NO },
      },
      required: ['id', 'versionNo'],
      additionalProperties: false,
    },
    chapterText: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_SUMMARY_CHAPTER_TEXT_CHARS,
    },
  },
  required: ['chapter', 'sourceVersion', 'chapterText'],
  additionalProperties: false,
};

const summarizerOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: MAX_SUMMARY_CHARS },
  },
  required: ['summary'],
  additionalProperties: false,
};

/** `summarizer.chapter@1.0.0`（summarizer-v1）。 */
export const SUMMARIZER_CHAPTER_AGENT: AgentDefinition = {
  name: 'summarizer.chapter',
  promptVersion: '1.0.0',
  // 由 Provider 决定模型（不把 mock 模型写进业务 Agent）。
  model: '',
  inputSchema: summarizerInputSchema,
  outputSchema: summarizerOutputSchema,
  // 1000 字中文摘要 + 结构化余量。
  maxOutputTokens: 2_048,
  rolePrompt: [
    '你是 summarizer.chapter（summarizer-v1），负责把一章**正式定稿正文**压缩成可追溯的章节摘要，',
    '供后续连续性检查与上下文装配使用。',
    '你只做摘要：不续写、不改写正文、不评价文笔、不输出多个方案、不提出问题清单。',
    '摘要应当覆盖（本章没有的类别不要编造）：',
    '- 本章关键事件与结果；',
    '- 人物状态变化（身份、位置、目标、伤势等）；',
    '- 重要物品 / 关系 / 境界变化；',
    '- 尚未解决的线索与伏笔。',
    '约束：',
    '- 摘要 1..1000 字，使用纯文本；不要 Markdown 标题、代码块或多套方案；',
    '- 不要大段复述原文，不要输出解释、前言或输入中未声明的字段；',
    '- 只输出 {"summary":"…"} 一个 JSON 对象。',
  ].join('\n'),
};

function outputInvalid(issues: readonly JsonIssue[]): never {
  throw new AgentOutputInvalidError(SUMMARIZER_CHAPTER_AGENT, issues);
}

/**
 * 输入校验：严格 Schema + 代码侧语义检查。
 *
 * Schema 的 `minLength` 挡不住纯空白标题，因此 `chapter.title` 必须 trim 后非空。
 * 错误只带路径与固定原因，不回显正文。
 *
 * @throws AgentInputInvalidError `AGENT_INPUT_INVALID`
 */
export function assertSummarizerInput(input: unknown): asserts input is ChapterSummarizerInput {
  const issues: JsonIssue[] = [...validateJson(summarizerInputSchema, input)];
  if (issues.length === 0) {
    const { chapter } = input as ChapterSummarizerInput;
    if (chapter.title.trim() === '') {
      issues.push({ path: '$.chapter.title', message: 'title 不能为空白' });
    }
  }
  if (issues.length > 0) {
    throw new AgentInputInvalidError(SUMMARIZER_CHAPTER_AGENT, issues);
  }
}

/** 行首 Markdown 标题（`# ` / `## ` …）。 */
const MARKDOWN_HEADING = /^#{1,6}\s/m;
/** 代码块围栏。 */
const CODE_FENCE = '```';

/**
 * 校验并规范化摘要输出。
 *
 * 顺序：严格 Schema（类型 / 长度 / 未知字段）→ 代码语义校验：
 * - `summary.trim()` 后不得为空（Schema 的 minLength 挡不住纯空白）；
 * - trim 后不得超过 1000 字；
 * - 不得包含 Markdown 标题或代码块（那是格式残留，不是摘要内容）。
 *
 * @throws AgentOutputInvalidError 错误只含路径与固定原因。
 */
export function validateSummarizerOutput(raw: unknown): ChapterSummarizerOutput {
  const schemaIssues = validateJson(summarizerOutputSchema, raw);
  if (schemaIssues.length > 0) {
    outputInvalid(schemaIssues);
  }

  const output = raw as ChapterSummarizerOutput;
  const summary = output.summary.trim();
  const issues: JsonIssue[] = [];

  if (summary === '') {
    issues.push({ path: '$.summary', message: 'summary 不能为空白' });
  } else {
    if (summary.length > MAX_SUMMARY_CHARS) {
      issues.push({ path: '$.summary', message: `summary 不能超过 ${MAX_SUMMARY_CHARS} 字` });
    }
    if (MARKDOWN_HEADING.test(summary)) {
      issues.push({ path: '$.summary', message: 'summary 不得包含 Markdown 标题' });
    }
    if (summary.includes(CODE_FENCE)) {
      issues.push({ path: '$.summary', message: 'summary 不得包含代码块' });
    }
  }

  if (issues.length > 0) {
    outputInvalid(issues);
  }
  return { summary };
}

/**
 * 运行摘要 Agent 并强制经过专用语义校验。
 *
 * 纯内存调用：不写日志、不写数据库、不决定下一步。
 */
export async function runChapterSummarizer(
  runner: AgentRunner,
  input: ChapterSummarizerInput,
  options: AgentRunOptions = {},
): Promise<AgentRunResult<ChapterSummarizerOutput>> {
  assertSummarizerInput(input);
  const result = await runner.run<ChapterSummarizerOutput>(
    SUMMARIZER_CHAPTER_AGENT,
    input,
    options,
  );
  return { ...result, output: validateSummarizerOutput(result.output) };
}
