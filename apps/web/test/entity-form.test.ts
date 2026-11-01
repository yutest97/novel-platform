/**
 * 设定中心表单纯逻辑单测（M2-B2-B）。
 *
 * 覆盖"表单值 → 提交值"的每条规则：
 * integer 解析与越界、enum 白名单、entityRef 单选、
 * entityRefs 的顺序 / 上限 / 空数组清空，以及展示格式化。
 */

import { describe, expect, it } from 'vitest';

import type { FieldDefinition } from '../src/lib/api.js';
import {
  MAX_ENTITY_REFS,
  buildAttributes,
  formatAttributeValue,
  formStateOf,
  nameMapOf,
  refsLimit,
  refsOf,
  sectionKey,
} from '../src/lib/entity-form.js';

const FIELDS: readonly FieldDefinition[] = [
  { key: 'identity', label: '身份', type: 'string', required: false, order: 1, maxLength: 100 },
  { key: 'secret', label: '秘密', type: 'text', required: false, order: 2, maxLength: 500 },
  {
    key: 'type',
    label: '势力类型',
    type: 'enum',
    required: true,
    order: 3,
    options: [
      { value: 'sect', label: '宗门' },
      { value: 'family', label: '家族' },
    ],
  },
  {
    key: 'allies',
    label: '盟友',
    type: 'entityRefs',
    required: false,
    order: 4,
    refType: 'faction',
    maxItems: 2,
  },
  {
    key: 'initialRealm',
    label: '初始境界',
    type: 'entityRef',
    required: false,
    order: 5,
    refType: 'realm_level',
  },
  {
    key: 'minorLevelCount',
    label: '小境界数',
    type: 'integer',
    required: true,
    order: 6,
    min: 1,
    max: 9,
  },
];

describe('sectionKey', () => {
  it('realm_level 用既有 realm 前缀，其余同名', () => {
    expect(sectionKey('realm_level')).toBe('realm');
    expect(sectionKey('faction')).toBe('faction');
    expect(sectionKey('character')).toBe('character');
  });
});

describe('buildAttributes', () => {
  it('按字段类型生成提交值（整数转 number、枚举提交 value、引用提交 UUID）', () => {
    const attributes = buildAttributes(FIELDS, {
      identity: '  外门弟子  ',
      type: 'sect',
      allies: ['faction-a'],
      initialRealm: 'realm-a',
      minorLevelCount: '9',
      secret: '',
    });

    expect(attributes).toEqual({
      identity: '外门弟子',
      type: 'sect',
      allies: ['faction-a'],
      initialRealm: 'realm-a',
      minorLevelCount: 9,
    });
    // 空的可选字段不提交（服务端按整组替换 → 相当于清空）
    expect('secret' in attributes).toBe(false);
  });

  it('entityRefs 保持用户选择顺序', () => {
    const attributes = buildAttributes(FIELDS, {
      type: 'sect',
      allies: ['z-first', 'a-second'],
      minorLevelCount: '1',
    });
    expect(attributes['allies']).toEqual(['z-first', 'a-second']);
  });

  it('空数组表示清空（不提交该字段）', () => {
    const attributes = buildAttributes(FIELDS, {
      type: 'sect',
      allies: [],
      minorLevelCount: '1',
    });
    expect('allies' in attributes).toBe(false);
  });

  it('超过 maxItems 直接拒绝（不静默截断）', () => {
    expect(() =>
      buildAttributes(FIELDS, {
        type: 'sect',
        allies: ['a', 'b', 'c'],
        minorLevelCount: '1',
      }),
    ).toThrow('最多选择 2 项');
  });

  it('枚举取值不在规则包内直接拒绝（防篡改 DOM）', () => {
    expect(() => buildAttributes(FIELDS, { type: 'not-an-option', minorLevelCount: '1' })).toThrow(
      '取值不在允许范围内',
    );
  });

  it('必需枚举缺失时拒绝', () => {
    expect(() => buildAttributes(FIELDS, { minorLevelCount: '1' })).toThrow('请填写「势力类型」');
  });

  it('整数必须能解析且落在 min..max 内', () => {
    expect(() => buildAttributes(FIELDS, { type: 'sect', minorLevelCount: 'abc' })).toThrow(
      '必须是整数',
    );
    expect(() => buildAttributes(FIELDS, { type: 'sect', minorLevelCount: '0' })).toThrow(
      '不能小于 1',
    );
    expect(() => buildAttributes(FIELDS, { type: 'sect', minorLevelCount: '10' })).toThrow(
      '不能大于 9',
    );
  });
});

describe('formStateOf / refsOf', () => {
  it('把已有属性回填成表单值（引用为数组）', () => {
    const state = formStateOf(FIELDS, {
      identity: '外门弟子',
      allies: ['f1', 'f2'],
      initialRealm: 'r1',
      minorLevelCount: 3,
    });
    expect(state['identity']).toBe('外门弟子');
    expect(state['allies']).toEqual(['f1', 'f2']);
    expect(state['initialRealm']).toBe('r1');
    expect(state['minorLevelCount']).toBe('3');
    expect(state['secret']).toBe('');
  });

  it('畸形引用值一律当成空数组', () => {
    expect(refsOf(undefined)).toEqual([]);
    expect(refsOf('not-an-array')).toEqual([]);
    expect(refsOf(['a', 1, null, 'b'])).toEqual(['a', 'b']);
  });
});

describe('refsLimit', () => {
  it('规则包 maxItems 只能收紧，不能突破 50', () => {
    expect(refsLimit({ key: 'k', label: 'L', type: 'entityRefs', required: false, order: 1 })).toBe(
      MAX_ENTITY_REFS,
    );
    expect(
      refsLimit({
        key: 'k',
        label: 'L',
        type: 'entityRefs',
        required: false,
        order: 1,
        maxItems: 5,
      }),
    ).toBe(5);
    expect(
      refsLimit({
        key: 'k',
        label: 'L',
        type: 'entityRefs',
        required: false,
        order: 1,
        maxItems: 500,
      }),
    ).toBe(MAX_ENTITY_REFS);
  });
});

describe('formatAttributeValue', () => {
  const names = nameMapOf([
    { id: 'r1', name: '炼气' } as never,
    { id: 'f1', name: '青云宗' } as never,
  ]);

  it('枚举显示 label，引用显示名称，空值显示破折号', () => {
    const enumField = FIELDS[2] as FieldDefinition;
    expect(formatAttributeValue(enumField, 'sect', names)).toBe('宗门');
    expect(formatAttributeValue(enumField, '', names)).toBe('—');

    const refField = FIELDS[4] as FieldDefinition;
    expect(formatAttributeValue(refField, 'r1', names)).toBe('炼气');
    expect(formatAttributeValue(refField, 'missing', names)).toBe('（引用已失效）');
  });

  it('entityRefs 按顺序用顿号连接', () => {
    const refsField = FIELDS[3] as FieldDefinition;
    expect(formatAttributeValue(refsField, ['f1', 'r1'], names)).toBe('青云宗、炼气');
    expect(formatAttributeValue(refsField, [], names)).toBe('—');
  });
});
