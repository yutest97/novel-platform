/**
 * Planner / Writer Agent 定义与代码侧校验（A1-2）。
 *
 * 分工（与 docs/08 一致）：
 * - Agent 只把结构化输入变成结构化输出；
 * - Schema 先做类型/范围/未知字段校验，代码再做语义校验
 *   （空字符串、trim 后长度、目标字数区间等）；
 * - Agent 不访问数据库，也不决定工作流下一步。
 */

import type { AgentDefinition } from '../agent.js';
import { NonRetryableTaskError } from '../errors.js';
import type { JsonSchema } from '../json-schema.js';
import {
  MAX_CONTRACT_TARGET_WORDS,
  MAX_DRAFT_CHARS,
  MIN_CONTRACT_TARGET_WORDS,
  MIN_DRAFT_WORDS,
  type PlannerOutput,
  type PlannerScene,
  type ValidatedDraft,
} from './types.js';

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

const entitySummarySchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 60 },
    summary: { type: 'string', maxLength: 500 },
  },
  required: ['id', 'name', 'summary'],
  additionalProperties: false,
};

const contractSchema: JsonSchema = {
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
    characters: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 60 },
      maxItems: 30,
    },
    scenes: { type: 'array', items: sceneSchema, minItems: 1, maxItems: 12 },
    targetWords: {
      type: 'integer',
      minimum: MIN_CONTRACT_TARGET_WORDS,
      maximum: MAX_CONTRACT_TARGET_WORDS,
    },
  },
  required: ['goal', 'mustInclude', 'mustNotInclude', 'characters', 'scenes', 'targetWords'],
  additionalProperties: false,
};

const styleSchema: JsonSchema = {
  type: 'object',
  properties: {
    tone: { type: 'string', minLength: 1, maxLength: 100 },
    pointOfView: { type: 'string', minLength: 1, maxLength: 100 },
    pacing: { type: 'string', minLength: 1, maxLength: 100 },
  },
  required: ['tone', 'pointOfView', 'pacing'],
  additionalProperties: false,
};

/** planner.chapter@1.0.0（planner-v1）。 */
export const PLANNER_CHAPTER_AGENT: AgentDefinition = {
  name: 'planner.chapter',
  promptVersion: '1.0.0',
  model: 'mock-model',
  inputSchema: {
    type: 'object',
    properties: {
      chapter: {
        type: 'object',
        properties: {
          chapterNo: { type: 'integer', minimum: 1 },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          targetWords: {
            type: 'integer',
            minimum: MIN_CONTRACT_TARGET_WORDS,
            maximum: MAX_CONTRACT_TARGET_WORDS,
          },
        },
        required: ['chapterNo', 'title', 'targetWords'],
        additionalProperties: false,
      },
      style: styleSchema,
      // 作品方向由规则包定义，字段随题材变化；这里只约束"必须是对象"。
      workDirection: { type: 'object', additionalProperties: true },
      characters: { type: 'array', items: entitySummarySchema, maxItems: 50 },
      realms: { type: 'array', items: entitySummarySchema, maxItems: 50 },
      factions: { type: 'array', items: entitySummarySchema, maxItems: 50 },
    },
    required: ['chapter', 'style', 'workDirection', 'characters', 'realms', 'factions'],
    additionalProperties: false,
  },
  outputSchema: contractSchema,
  maxOutputTokens: 2048,
  rolePrompt:
    '你是 planner.chapter（planner-v1），负责把作品设定与章节信息拆成可执行的章节合同。' +
    '你只输出结构化计划，不写正文；场景必须是可拍摄的事件（目的/地点/冲突/结果），' +
    '不得引入输入中未出现的人物或势力。',
};

/** writer.chapter@1.0.0（writer-v1）。 */
export const WRITER_CHAPTER_AGENT: AgentDefinition = {
  name: 'writer.chapter',
  promptVersion: '1.0.0',
  model: 'mock-model',
  inputSchema: {
    type: 'object',
    properties: {
      contract: contractSchema,
      characters: { type: 'array', items: entitySummarySchema, maxItems: 30 },
      realms: { type: 'array', items: entitySummarySchema, maxItems: 30 },
      style: styleSchema,
      targetWords: {
        type: 'integer',
        minimum: MIN_CONTRACT_TARGET_WORDS,
        maximum: MAX_CONTRACT_TARGET_WORDS,
      },
    },
    required: ['contract', 'characters', 'realms', 'style', 'targetWords'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      // 正文作为 JSON 的一个字段返回；长度由代码按"非空白字符数"重新统计。
      text: { type: 'string', minLength: 1, maxLength: MAX_DRAFT_CHARS },
    },
    required: ['text'],
    additionalProperties: false,
  },
  maxOutputTokens: 8192,
  rolePrompt:
    '你是 writer.chapter（writer-v1），负责按已冻结的章节合同写正文。' +
    '只输出一个包含 text 字段的 JSON 对象；不解释、不写标题、不输出 Markdown。',
};

function invalidOutput(detail: string): never {
  throw new NonRetryableTaskError('AGENT_OUTPUT_INVALID', `Planner 输出不合法：${detail}`);
}

/** trim 后非空的字符串列表；保持原顺序并去重。 */
function normalizeStringList(values: readonly string[], field: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized === '') {
      invalidOutput(`${field} 不能包含空白项`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function normalizeScene(scene: PlannerScene, index: number): PlannerScene {
  const purpose = scene.purpose.trim();
  const location = scene.location.trim();
  const conflict = scene.conflict.trim();
  const outcome = scene.outcome.trim();
  // Schema 只能保证 length >= 1，"   " 需要代码拦截。
  if (purpose === '' || location === '' || conflict === '' || outcome === '') {
    invalidOutput(`scenes[${index}] 的四个字段都不能为空`);
  }
  return { purpose, location, conflict, outcome };
}

/**
 * 代码侧语义校验（Schema 通过之后）。
 *
 * 与 Schema 的重复检查是有意的：Schema 是模型契约，代码是最后一道闸门；
 * 任何一项不满足都按**不可重试**失败，不写合同。
 */
export function normalizePlannerOutput(output: PlannerOutput): PlannerOutput {
  const goal = output.goal.trim();
  if (goal === '') {
    invalidOutput('goal 不能为空');
  }
  if (output.scenes.length === 0) {
    invalidOutput('scenes 至少需要 1 个');
  }
  const scenes = output.scenes.map((scene, index) => normalizeScene(scene, index));
  if (
    !Number.isInteger(output.targetWords) ||
    output.targetWords < MIN_CONTRACT_TARGET_WORDS ||
    output.targetWords > MAX_CONTRACT_TARGET_WORDS
  ) {
    invalidOutput(
      `targetWords 必须是 ${MIN_CONTRACT_TARGET_WORDS}..${MAX_CONTRACT_TARGET_WORDS} 的整数`,
    );
  }

  return {
    goal,
    mustInclude: normalizeStringList(output.mustInclude, 'mustInclude'),
    mustNotInclude: normalizeStringList(output.mustNotInclude, 'mustNotInclude'),
    characters: normalizeStringList(output.characters, 'characters'),
    scenes,
    targetWords: output.targetWords,
  };
}

/**
 * 统计"字数"：Unicode 码点中**非空白字符**的数量。
 *
 * 与 `String.length` 不同：emoji / 代理对按 1 个字符计；
 * 与模型自报的 wordCount 无关，服务端永远重新计算。
 */
export function countWords(text: string): number {
  return Array.from(text.replace(/\s/gu, '')).length;
}

/**
 * 校验并规范化 Writer 正文。
 *
 * - 去掉首尾空白后再统计；
 * - 少于 1200 字 → 不可重试失败，不写候选；
 * - 超过上限 → 同样拒绝，避免把超大文本写进数据库。
 */
export function prepareDraftText(rawText: string): ValidatedDraft {
  const text = rawText.trim();
  if (text.length > MAX_DRAFT_CHARS) {
    throw new NonRetryableTaskError(
      'AGENT_OUTPUT_INVALID',
      `正文不能超过 ${MAX_DRAFT_CHARS} 个字符`,
    );
  }
  const wordCount = countWords(text);
  if (wordCount < MIN_DRAFT_WORDS) {
    throw new NonRetryableTaskError(
      'AGENT_OUTPUT_INVALID',
      `正文不足 ${MIN_DRAFT_WORDS} 字（实际 ${wordCount} 字）`,
    );
  }
  return { text, wordCount };
}
