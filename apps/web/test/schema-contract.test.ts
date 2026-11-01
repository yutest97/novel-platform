/**
 * M2-B2-A-REV-01：前端契约类型必须能描述真实的 v3 schema 形态。
 *
 * 后端 `xuanhuan@3.0.0` 的 field_schema 里有 enum（带 options）、
 * entityRef（带 refType）、entityRefs（带 refType + maxItems），
 * 以及实体类型之间的组级 `order`。前端类型若还停留在
 * `'string' | 'text' | 'integer'`，页面渲染 select / 引用选择器时就只能靠 `any` 兜底。
 *
 * 本文件的断言分两层：
 * - 运行期：字面量形状确实带着 options / refType / maxItems；
 * - 编译期：`pnpm typecheck` 必须能接受真实 v3 形状、并拒绝越界写法
 *   （`@ts-expect-error` 若失效，typecheck 会因"未使用的抑制指令"而失败）。
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  EntityGroupItem,
  EnumOption,
  FieldDefinition,
  FieldGroup,
  FieldType,
  SupportedEntityType,
} from '../src/lib/api.js';

/** 与 v3 规则包里 faction.type 完全同形的选项集合。 */
const FACTION_TYPE_OPTIONS: readonly EnumOption[] = [
  { value: 'sect', label: '宗门' },
  { value: 'family', label: '家族' },
  { value: 'dynasty', label: '王朝' },
  { value: 'alliance', label: '联盟' },
  { value: 'guild', label: '商盟' },
  { value: 'other', label: '其他' },
];

/** 与 v3 规则包里 faction 组同形的字段定义。 */
const FACTION_GROUP: FieldGroup = {
  title: '势力',
  schemaRef: 'xuanhuan@3.0.0',
  order: 2,
  fields: [
    {
      key: 'type',
      label: '势力类型',
      type: 'enum',
      required: true,
      order: 1,
      options: FACTION_TYPE_OPTIONS,
    },
    {
      key: 'allies',
      label: '盟友',
      type: 'entityRefs',
      required: false,
      order: 2,
      refType: 'faction',
      maxItems: 50,
    },
    {
      key: 'enemies',
      label: '敌对',
      type: 'entityRefs',
      required: false,
      order: 3,
      refType: 'faction',
    },
  ],
};

/** 与 v3 规则包里 character 组同形的字段定义（entityRef 两种目标）。 */
const CHARACTER_GROUP: FieldGroup = {
  title: '人物',
  schemaRef: 'xuanhuan@3.0.0',
  order: 3,
  fields: [
    { key: 'identity', label: '身份', type: 'string', required: false, order: 1, maxLength: 100 },
    { key: 'secret', label: '秘密', type: 'text', required: false, order: 2, maxLength: 1000 },
    {
      key: 'secretKnownBy',
      label: '谁知道这个秘密',
      type: 'entityRefs',
      required: false,
      order: 3,
      refType: 'character',
      maxItems: 50,
    },
    {
      key: 'initialRealm',
      label: '初始境界',
      type: 'entityRef',
      required: false,
      order: 4,
      refType: 'realm_level',
    },
    {
      key: 'faction',
      label: '所属势力',
      type: 'entityRef',
      required: false,
      order: 5,
      refType: 'faction',
    },
  ],
};

describe('前端契约类型与 v3 schema 同形', () => {
  it('FieldDefinition 覆盖 enum / entityRef / entityRefs 的所有附加属性', () => {
    const enumField = FACTION_GROUP.fields[0] as FieldDefinition;
    expect(enumField.type).toBe('enum');
    expect(enumField.options?.map((option) => option.value)).toEqual([
      'sect',
      'family',
      'dynasty',
      'alliance',
      'guild',
      'other',
    ]);
    expect(enumField.options?.map((option) => option.label)).toEqual([
      '宗门',
      '家族',
      '王朝',
      '联盟',
      '商盟',
      '其他',
    ]);

    const refsField = FACTION_GROUP.fields[1] as FieldDefinition;
    expect(refsField.type).toBe('entityRefs');
    expect(refsField.refType).toBe('faction');
    expect(refsField.maxItems).toBe(50);

    const refField = CHARACTER_GROUP.fields[3] as FieldDefinition;
    expect(refField.type).toBe('entityRef');
    expect(refField.refType).toBe('realm_level');
  });

  it('FieldGroup 带组级 order；EntityGroupItem.entityType 收敛为本轮三类', () => {
    expect(FACTION_GROUP.order).toBe(2);
    expect(CHARACTER_GROUP.order).toBe(3);

    expectTypeOf<FieldType>().toEqualTypeOf<
      'string' | 'text' | 'integer' | 'enum' | 'entityRef' | 'entityRefs'
    >();
    expectTypeOf<SupportedEntityType>().toEqualTypeOf<'realm_level' | 'faction' | 'character'>();
    expectTypeOf<EntityGroupItem['entityType']>().toEqualTypeOf<SupportedEntityType>();

    const group: EntityGroupItem = {
      entityType: 'character',
      title: CHARACTER_GROUP.title,
      schemaRef: CHARACTER_GROUP.schemaRef,
      order: CHARACTER_GROUP.order ?? 0,
      entities: [],
    };
    expect(group.entityType).toBe('character');
  });
});

/**
 * 只用于编译期校验的类型边界，**从不调用**。
 *
 * `@ts-expect-error` 若不再报错（说明类型被放宽成 any/string），
 * `tsc --noEmit` 会因为"未使用的抑制指令"失败。
 */
function assertTypeBoundaries(): void {
  // @ts-expect-error 字段类型只接受六种已定义的取值
  const badType: FieldDefinition = { key: 'k', label: 'L', type: 'ref', required: false, order: 1 };
  void badType;

  const badGroup: EntityGroupItem = {
    // @ts-expect-error 实体分组只接受本轮启用的三类
    entityType: 'item',
    title: '物品',
    schemaRef: 'xuanhuan@3.0.0',
    order: 4,
    entities: [],
  };
  void badGroup;
}

void assertTypeBoundaries;
