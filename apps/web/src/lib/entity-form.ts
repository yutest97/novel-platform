/**
 * 设定中心表单的**纯逻辑**（M2-B2-B）。
 *
 * 放在这里而不是组件里，是为了让"表单 → 提交值"的规则可以被单测覆盖：
 * integer / enum / entityRef / entityRefs 各自的取值、清空与上限。
 *
 * 关键约定：
 * - 表单值是"字符串或字符串数组"，与 DOM 控件的取值形态一致；
 * - entityRefs 保持**用户选择顺序**（数组顺序即提交顺序）；
 * - 空字符串 / 空数组表示"清空该字段"，提交时不出现该 key，
 *   服务端按整组替换处理（与作品方向一致）。
 */

import type { EntityItem, FieldDefinition } from './api';

/** entityRefs 的**统一硬上限**（与服务端 MAX_ENTITY_REFS 一致）。 */
export const MAX_ENTITY_REFS = 50;

/** 表单状态：文本类字段是字符串，entityRefs 是 id 数组。 */
export type FormState = Record<string, string | string[]>;

/** 分区 testid 前缀：realm_level → realm（沿用既有 rerm 风格 testid），其余同名。 */
export function sectionKey(entityType: string): string {
  return entityType === 'realm_level' ? 'realm' : entityType;
}

/**
 * 把属性值转成表单/展示可用的字符串。
 *
 * 数组与对象用 JSON 兜底，只用于"未知结构"的展示，不参与提交。
 */
export function attributeToText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

/** 取 entityRefs 的 id 数组（畸形值一律视为空）。 */
export function refsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

/** entityRefs 的实际上限：规则包 maxItems 只能**收紧**，不能突破硬上限。 */
export function refsLimit(field: FieldDefinition): number {
  return Math.min(field.maxItems ?? MAX_ENTITY_REFS, MAX_ENTITY_REFS);
}

/** 用一组字段定义与已有属性构造草稿。 */
export function formStateOf(
  fields: readonly FieldDefinition[],
  attributes: Record<string, unknown> = {},
): FormState {
  const state: FormState = {};
  for (const field of fields) {
    state[field.key] =
      field.type === 'entityRefs'
        ? refsOf(attributes[field.key])
        : attributeToText(attributes[field.key]);
  }
  return state;
}

/**
 * 表单 → 提交给服务端的 attributes。
 *
 * @throws Error 带有可直接展示给作者的中文文案（缺必填、整数非法、超上限）。
 */
export function buildAttributes(
  fields: readonly FieldDefinition[],
  state: FormState,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};

  for (const field of fields) {
    if (field.type === 'entityRefs') {
      const list = Array.isArray(state[field.key]) ? [...(state[field.key] as string[])] : [];
      if (list.length === 0) {
        // 空数组 = 清空该字段（不写属性行）
        continue;
      }
      const limit = refsLimit(field);
      if (list.length > limit) {
        throw new Error(`「${field.label}」最多选择 ${limit} 项`);
      }
      attributes[field.key] = list;
      continue;
    }

    const raw = state[field.key];
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') {
      if (field.required) {
        throw new Error(`请填写「${field.label}」`);
      }
      continue;
    }

    if (field.type === 'integer') {
      if (!/^-?\d+$/.test(text)) {
        throw new Error(`「${field.label}」必须是整数`);
      }
      const value = Number.parseInt(text, 10);
      if (field.min !== undefined && value < field.min) {
        throw new Error(`「${field.label}」不能小于 ${field.min}`);
      }
      if (field.max !== undefined && value > field.max) {
        throw new Error(`「${field.label}」不能大于 ${field.max}`);
      }
      attributes[field.key] = value;
      continue;
    }

    if (field.type === 'enum') {
      const values = (field.options ?? []).map((option) => option.value);
      if (!values.includes(text)) {
        // 正常 UI 只会提交规则包里的 value；这里防的是被篡改的 DOM
        throw new Error(`「${field.label}」的取值不在允许范围内`);
      }
      attributes[field.key] = text;
      continue;
    }

    attributes[field.key] = text;
  }

  return attributes;
}

/** 展示用：把某个属性的值格式化成中文文本（enum 显示 label、引用显示名称）。 */
export function formatAttributeValue(
  field: FieldDefinition,
  value: unknown,
  nameById: ReadonlyMap<string, string>,
): string {
  if (value === undefined || value === null || value === '') {
    return '—';
  }
  if (field.type === 'enum') {
    const option = (field.options ?? []).find((item) => item.value === value);
    return option?.label ?? attributeToText(value);
  }
  if (field.type === 'entityRef') {
    return nameById.get(attributeToText(value)) ?? '（引用已失效）';
  }
  if (field.type === 'entityRefs') {
    const list = refsOf(value);
    if (list.length === 0) {
      return '—';
    }
    return list.map((id) => nameById.get(id) ?? '（引用已失效）').join('、');
  }
  return attributeToText(value);
}

/** id → 名称，供引用展示使用。 */
export function nameMapOf(entities: readonly EntityItem[]): ReadonlyMap<string, string> {
  return new Map(entities.map((entity) => [entity.id, entity.name]));
}
