/**
 * Planner / Writer 的 Schema 与代码侧校验（A1-2）。
 *
 * 这里只测纯函数，不连数据库、不联网。
 */

import { describe, expect, it } from 'vitest';

import { assertAgentDefinition } from '../src/agent.js';
import {
  countWords,
  normalizePlannerOutput,
  PLANNER_CHAPTER_AGENT,
  prepareDraftText,
  WRITER_CHAPTER_AGENT,
} from '../src/chapter/agents.js';
import type { PlannerOutput } from '../src/chapter/types.js';
import { validateJson } from '../src/json-schema.js';

function validPlan(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return {
    goal: '李青在外门大比中暴露真实实力。',
    mustInclude: ['外门大比', '隐藏修为'],
    mustNotInclude: ['身世'],
    characters: ['李青', '赵四'],
    scenes: [
      { purpose: '逼上台', location: '演武场', conflict: '当众挑衅', outcome: '被迫应战' },
      {
        purpose: '第一次反转',
        location: '擂台',
        conflict: '境界压制失效',
        outcome: '露出炼气九层',
      },
    ],
    targetWords: 3000,
    ...overrides,
  };
}

describe('Agent 定义与输出 Schema', () => {
  it('planner-v1 / writer-v1 定义合法，且拒绝未声明字段', () => {
    expect(() => assertAgentDefinition(PLANNER_CHAPTER_AGENT)).not.toThrow();
    expect(() => assertAgentDefinition(WRITER_CHAPTER_AGENT)).not.toThrow();

    const withExtra = { ...validPlan(), extra: '不允许' };
    const issues = validateJson(PLANNER_CHAPTER_AGENT.outputSchema, withExtra);
    expect(issues.some((issue) => issue.path === '$.extra')).toBe(true);

    const writerExtra = validateJson(WRITER_CHAPTER_AGENT.outputSchema, {
      text: '正文',
      wordCount: 99,
    });
    expect(writerExtra.some((issue) => issue.path === '$.wordCount')).toBe(true);
  });

  it('Planner Schema 拒绝空场景与越界目标字数', () => {
    expect(
      validateJson(PLANNER_CHAPTER_AGENT.outputSchema, validPlan({ scenes: [] })).length,
    ).toBeGreaterThan(0);
    expect(
      validateJson(PLANNER_CHAPTER_AGENT.outputSchema, validPlan({ targetWords: 5000 })).length,
    ).toBeGreaterThan(0);
    expect(
      validateJson(PLANNER_CHAPTER_AGENT.outputSchema, validPlan({ targetWords: 2000 })).length,
    ).toBeGreaterThan(0);
  });

  it('Writer Schema 要求 text 且只允许 text', () => {
    expect(validateJson(WRITER_CHAPTER_AGENT.outputSchema, {}).length).toBeGreaterThan(0);
    expect(validateJson(WRITER_CHAPTER_AGENT.outputSchema, { text: 123 }).length).toBeGreaterThan(
      0,
    );
    expect(validateJson(WRITER_CHAPTER_AGENT.outputSchema, { text: '正文' })).toEqual([]);
  });
});

describe('Planner 输出代码校验', () => {
  it('trim 并去重，保持顺序', () => {
    const plan = normalizePlannerOutput(
      validPlan({
        goal: '  目标  ',
        mustInclude: ['  外门大比 ', '外门大比', '隐藏修为'],
        scenes: [
          {
            purpose: ' 逼上台 ',
            location: ' 演武场 ',
            conflict: ' 当众挑衅 ',
            outcome: ' 被迫应战 ',
          },
        ],
      }),
    );
    expect(plan.goal).toBe('目标');
    expect(plan.mustInclude).toEqual(['外门大比', '隐藏修为']);
    expect(plan.scenes[0]).toEqual({
      purpose: '逼上台',
      location: '演武场',
      conflict: '当众挑衅',
      outcome: '被迫应战',
    });
  });

  it('拒绝空白 goal / 空白场景字段 / 越界 targetWords', () => {
    expect(() => normalizePlannerOutput(validPlan({ goal: '   ' }))).toThrow(/goal/);
    expect(() =>
      normalizePlannerOutput(
        validPlan({
          scenes: [{ purpose: '  ', location: '演武场', conflict: '冲突', outcome: '结果' }],
        }),
      ),
    ).toThrow(/scenes\[0\]/);
    expect(() => normalizePlannerOutput(validPlan({ targetWords: 2000 }))).toThrow(/targetWords/);
  });
});

describe('正文字数与校验', () => {
  it('countWords 统计非空白字符（按 Unicode 码点）', () => {
    expect(countWords(' 你好\n世界 ')).toBe(4);
    expect(countWords('😀😀')).toBe(2);
    expect(countWords(' \n\t ')).toBe(0);
  });

  it('少于 1200 字拒绝；达到下限通过并返回服务端字数', () => {
    expect(() => prepareDraftText('太短了')).toThrow(/1200/);

    const text = '风从演武场尽头吹来。'.repeat(150);
    const draft = prepareDraftText(`  ${text}  `);
    expect(draft.text).toBe(text);
    expect(draft.wordCount).toBe(countWords(text));
    expect(draft.wordCount).toBeGreaterThanOrEqual(1200);
  });
});
