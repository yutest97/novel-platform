/**
 * 连续性事实输出校验（A2-A）。
 *
 * 只测纯函数：严格 Schema + 按 factType 的语义校验。
 * 服务层（定稿 / 版本 / 幂等 / 并发 / 审计）在 `chapter-facts-service.test.ts` 覆盖。
 */

import { describe, expect, it } from 'vitest';

import {
  CHAPTER_FACT_TYPES,
  ChapterFactsInvalidError,
  MAX_CHAPTER_FACTS,
  validateFactsOutput,
} from '../src/chapter/facts.js';

const CHARACTER_ID = '11111111-1111-4111-8111-111111111111';
const CHARACTER_ID_2 = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';

const context = {
  characters: [
    { id: CHARACTER_ID, name: '林青', summary: '外门弟子' },
    { id: CHARACTER_ID_2, name: '赵阔', summary: '执事' },
  ],
  items: [{ id: ITEM_ID, name: '青锋剑', summary: '一阶法器' }],
};

function validate(facts: unknown[]): ReturnType<typeof validateFactsOutput> {
  return validateFactsOutput({ facts }, context);
}

function expectInvalid(facts: unknown[], pattern?: RegExp): void {
  let caught: unknown;
  try {
    validate(facts);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ChapterFactsInvalidError);
  const invalid = caught as ChapterFactsInvalidError;
  expect(invalid.code).toBe('CONTINUITY_FACTS_INVALID');
  if (pattern !== undefined) {
    expect(invalid.issues.some((issue) => pattern.test(issue.path))).toBe(true);
  }
}

describe('合法输出', () => {
  it('六类事实都能通过，并保留结构化字段', () => {
    const facts = validate([
      {
        factType: 'character_state',
        subjectId: CHARACTER_ID,
        summary: '林青受了内伤',
        reason: '正文写到他咳血',
      },
      {
        factType: 'relationship_change',
        subjectId: CHARACTER_ID,
        objectId: CHARACTER_ID_2,
        summary: '两人由同门转为对立',
        reason: '赵阔当众指责林青',
      },
      {
        factType: 'item_change',
        subjectId: ITEM_ID,
        summary: '青锋剑转交给林青',
        reason: '赵阔把剑递出',
      },
      {
        factType: 'realm_progress',
        subjectId: CHARACTER_ID,
        summary: '林青突破炼气三层',
        reason: '他在灵泉边打坐突破',
      },
      {
        factType: 'plot_thread',
        threadStatus: 'advanced',
        summary: '灵泉异动线索推进',
        reason: '泉底出现裂纹',
      },
      {
        factType: 'location_change',
        subjectId: CHARACTER_ID,
        name: '后山灵泉',
        summary: '林青前往后山灵泉',
        reason: '正文写到他在泉边打坐',
      },
    ]);

    expect(facts).toHaveLength(6);
    expect(facts.map((fact) => fact.factType)).toEqual([...CHAPTER_FACT_TYPES]);
    expect(facts[0]?.subjectId).toBe(CHARACTER_ID);
    expect(facts[1]?.objectId).toBe(CHARACTER_ID_2);
    expect(facts[4]?.threadStatus).toBe('advanced');
    expect(facts[5]?.name).toBe('后山灵泉');
  });

  it('空数组合法：表示本章没有可提取变化', () => {
    expect(validate([])).toEqual([]);
  });

  it('未登记地点名允许保存（不要求是已有实体）', () => {
    const facts = validate([
      {
        factType: 'location_change',
        subjectId: CHARACTER_ID,
        name: '  无名渡口  ',
        summary: '林青抵达无名渡口',
        reason: '正文出现该地名',
      },
    ]);
    expect(facts[0]?.name).toBe('无名渡口');
  });

  it('emoji 与 Unicode 原样保留', () => {
    const facts = validate([
      {
        factType: 'plot_thread',
        threadStatus: 'new',
        summary: '🗡️ 剑冢的封印出现裂缝',
        reason: '文中提到「封印…裂开」',
      },
    ]);
    expect(facts[0]?.summary).toBe('🗡️ 剑冢的封印出现裂缝');
  });

  it('summary / reason 两端空白会被规范化', () => {
    const facts = validate([
      {
        factType: 'plot_thread',
        threadStatus: 'resolved',
        summary: '  线索收束  ',
        reason: '  真相揭晓  ',
      },
    ]);
    expect(facts[0]).toMatchObject({ summary: '线索收束', reason: '真相揭晓' });
  });
});

describe('Schema 层拒绝', () => {
  it('未知 fact_type', () => {
    expectInvalid([{ factType: 'character_death', summary: 'x', reason: 'y' }], /factType/);
  });

  it('未知字段', () => {
    expectInvalid(
      [{ factType: 'plot_thread', threadStatus: 'new', summary: 'x', reason: 'y', detail: '正文' }],
      /detail/,
    );
  });

  it('缺少 facts 字段 / facts 不是数组', () => {
    expect(() => validateFactsOutput({}, context)).toThrow(ChapterFactsInvalidError);
    expect(() => validateFactsOutput({ facts: 'x' }, context)).toThrow(ChapterFactsInvalidError);
  });

  it('summary / reason 超过 500 字', () => {
    expectInvalid([
      { factType: 'plot_thread', threadStatus: 'new', summary: 'a'.repeat(501), reason: 'y' },
    ]);
    expectInvalid([
      { factType: 'plot_thread', threadStatus: 'new', summary: 'x', reason: 'a'.repeat(501) },
    ]);
  });

  it(`超过 ${MAX_CHAPTER_FACTS} 条`, () => {
    const many = Array.from({ length: MAX_CHAPTER_FACTS + 1 }, () => ({
      factType: 'plot_thread',
      threadStatus: 'new',
      summary: '线索',
      reason: '正文',
    }));
    expectInvalid(many, /facts/);
  });

  it('location_change 地名超过 120 字', () => {
    expectInvalid([
      {
        factType: 'location_change',
        subjectId: CHARACTER_ID,
        name: 'a'.repeat(121),
        summary: 'x',
        reason: 'y',
      },
    ]);
  });
});

describe('语义层拒绝', () => {
  it('空白 summary / reason（纯空格）', () => {
    expectInvalid(
      [{ factType: 'plot_thread', threadStatus: 'new', summary: '   ', reason: 'y' }],
      /summary/,
    );
    expectInvalid(
      [{ factType: 'plot_thread', threadStatus: 'new', summary: 'x', reason: '\n\t ' }],
      /reason/,
    );
  });

  it('未知人物 id', () => {
    expectInvalid(
      [
        {
          factType: 'character_state',
          subjectId: '99999999-9999-4999-8999-999999999999',
          summary: 'x',
          reason: 'y',
        },
      ],
      /subjectId/,
    );
  });

  it('item_change 必须是物品 id（不能用人物 id）', () => {
    expectInvalid(
      [{ factType: 'item_change', subjectId: CHARACTER_ID, summary: 'x', reason: 'y' }],
      /subjectId/,
    );
  });

  it('关系双方不能是同一个人物', () => {
    expectInvalid(
      [
        {
          factType: 'relationship_change',
          subjectId: CHARACTER_ID,
          objectId: CHARACTER_ID,
          summary: 'x',
          reason: 'y',
        },
      ],
      /objectId/,
    );
  });

  it('关系第二个人物未知', () => {
    expectInvalid(
      [
        {
          factType: 'relationship_change',
          subjectId: CHARACTER_ID,
          objectId: '99999999-9999-4999-8999-999999999999',
          summary: 'x',
          reason: 'y',
        },
      ],
      /objectId/,
    );
  });

  it('location_change 缺少地名', () => {
    expectInvalid(
      [{ factType: 'location_change', subjectId: CHARACTER_ID, summary: 'x', reason: 'y' }],
      /name/,
    );
  });

  it('plot_thread 缺少 threadStatus', () => {
    expectInvalid([{ factType: 'plot_thread', summary: 'x', reason: 'y' }], /threadStatus/);
  });

  it('character_state 不接受 name / threadStatus 等越界字段', () => {
    expectInvalid(
      [
        {
          factType: 'character_state',
          subjectId: CHARACTER_ID,
          name: '某地',
          summary: 'x',
          reason: 'y',
        },
      ],
      /name/,
    );
  });

  it('plot_thread 不接受 subjectId', () => {
    expectInvalid(
      [
        {
          factType: 'plot_thread',
          subjectId: CHARACTER_ID,
          threadStatus: 'new',
          summary: 'x',
          reason: 'y',
        },
      ],
      /subjectId/,
    );
  });

  it('character_state 不接受 objectId', () => {
    expectInvalid(
      [
        {
          factType: 'character_state',
          subjectId: CHARACTER_ID,
          objectId: CHARACTER_ID_2,
          summary: 'x',
          reason: 'y',
        },
      ],
      /objectId/,
    );
  });
});

describe('错误只带路径与原因', () => {
  it('issues 不回显正文内容', () => {
    try {
      validate([
        { factType: 'plot_thread', threadStatus: 'new', summary: '机密正文片段', reason: 'y' },
        { factType: 'unknown_type', summary: 'x', reason: 'y' },
      ]);
      throw new Error('应当抛出');
    } catch (error) {
      const invalid = error as ChapterFactsInvalidError;
      const text = JSON.stringify(invalid.issues);
      expect(text).not.toContain('机密正文片段');
      expect(text).toContain('facts[1].factType');
    }
  });
});
