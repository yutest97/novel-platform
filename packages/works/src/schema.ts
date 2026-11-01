/**
 * 规则包字段定义与校验（M2-B1）。
 *
 * 玄幻专属字段（作品方向、境界体系）定义在 `rule_packages.field_schema` 里，
 * **不**写进通用核心表。本模块负责：
 * - 解析 field_schema 的两个部分：作品方向（workDirection）与实体类型（entityTypes）；
 * - 按字段定义校验提交的设定值：类型、必填、取值范围、长度、未知字段；
 * - 生成对外的"schema 摘要"（字段定义，不含任何实际设定值）。
 */

import { AuthError } from '@novel/auth';

/** 支持的字段类型。 */
export type FieldType = 'string' | 'text' | 'integer';

/** 单个字段定义。 */
export interface FieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly order: number;
  readonly help?: string;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
}

/** 一组字段定义（作品方向或某个实体类型）。 */
export interface FieldGroup {
  readonly title: string;
  readonly schemaRef: string;
  readonly fields: readonly FieldDefinition[];
}

/** field_schema 的完整结构。 */
export interface RuleFieldSchema {
  readonly version?: number;
  readonly workDirection?: FieldGroup;
  readonly entityTypes?: Record<string, FieldGroup>;
}

/** 对外的 schema 摘要（只有定义，没有设定值）。 */
export interface SchemaSummary {
  readonly code: string;
  readonly name: string;
  readonly version: string;
  readonly workDirection: FieldGroup | null;
  readonly entityTypes: readonly { key: string; group: FieldGroup }[];
}

/** 字段定义的宽松解析（容忍数据库里的历史结构）。 */
function parseField(raw: unknown): FieldDefinition | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const key = item['key'];
  const label = item['label'];
  const type = item['type'];
  if (typeof key !== 'string' || typeof label !== 'string') {
    return null;
  }
  if (type !== 'string' && type !== 'text' && type !== 'integer') {
    return null;
  }

  const definition: {
    key: string;
    label: string;
    type: FieldType;
    required: boolean;
    order: number;
    help?: string;
    maxLength?: number;
    min?: number;
    max?: number;
  } = {
    key,
    label,
    type,
    required: item['required'] === true,
    order: typeof item['order'] === 'number' ? item['order'] : 0,
  };

  if (typeof item['help'] === 'string') {
    definition.help = item['help'];
  }
  if (typeof item['maxLength'] === 'number') {
    definition.maxLength = item['maxLength'];
  }
  if (typeof item['min'] === 'number') {
    definition.min = item['min'];
  }
  if (typeof item['max'] === 'number') {
    definition.max = item['max'];
  }

  return definition;
}

/** 解析一组字段定义。 */
function parseGroup(raw: unknown): FieldGroup | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const rawFields = item['fields'];
  if (!Array.isArray(rawFields)) {
    return null;
  }
  const fields = rawFields
    .map((entry) => parseField(entry))
    .filter((entry): entry is FieldDefinition => entry !== null)
    .sort((a, b) => a.order - b.order);

  return {
    title: typeof item['title'] === 'string' ? item['title'] : '',
    schemaRef: typeof item['schemaRef'] === 'string' ? item['schemaRef'] : '',
    fields,
  };
}

/** 解析完整的 field_schema。 */
export function parseRuleFieldSchema(raw: unknown): RuleFieldSchema {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const item = raw as Record<string, unknown>;

  const entityTypesRaw = item['entityTypes'];
  const entityTypes: Record<string, FieldGroup> = {};
  if (typeof entityTypesRaw === 'object' && entityTypesRaw !== null) {
    for (const [key, value] of Object.entries(entityTypesRaw as Record<string, unknown>)) {
      const group = parseGroup(value);
      if (group !== null) {
        entityTypes[key] = group;
      }
    }
  }

  const result: {
    version?: number;
    workDirection?: FieldGroup;
    entityTypes?: Record<string, FieldGroup>;
  } = {};
  if (typeof item['version'] === 'number') {
    result.version = item['version'];
  }
  const workDirection = parseGroup(item['workDirection']);
  if (workDirection !== null) {
    result.workDirection = workDirection;
  }
  result.entityTypes = entityTypes;
  return result;
}

/** 生成对外的 schema 摘要。 */
export function buildSchemaSummary(rulePackage: {
  code: string;
  name: string;
  version: string;
  fieldSchema: unknown;
}): SchemaSummary {
  const schema = parseRuleFieldSchema(rulePackage.fieldSchema);
  return {
    code: rulePackage.code,
    name: rulePackage.name,
    version: rulePackage.version,
    workDirection: schema.workDirection ?? null,
    entityTypes: Object.entries(schema.entityTypes ?? {}).map(([key, group]) => ({ key, group })),
  };
}

/** 取某个实体类型的字段定义。 */
export function entityTypeGroup(
  rulePackage: { fieldSchema: unknown },
  entityType: string,
): FieldGroup | null {
  const schema = parseRuleFieldSchema(rulePackage.fieldSchema);
  return schema.entityTypes?.[entityType] ?? null;
}

/**
 * 按字段定义校验一组设定值。
 *
 * 规则：
 * - 未知字段 → 400（严格，不静默忽略）；
 * - 必填字段缺失或为空 → 400；
 * - 类型不符 → 400；
 * - 整数越界、字符串超长 → 400；
 * - 可选字段未提供 → 不写入（调用方负责合并）。
 *
 * @returns 规范化后的值（只含已定义且有值的字段）
 */
export function validateFields(
  group: FieldGroup,
  values: Record<string, unknown>,
  options: { requireAll?: boolean } = {},
): Record<string, string | number> {
  const known = new Set(group.fields.map((field) => field.key));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) {
      throw new AuthError('VALIDATION_FAILED', `未知字段 ${key}`);
    }
  }

  const result: Record<string, string | number> = {};
  for (const field of group.fields) {
    const raw = values[field.key];
    const missing = raw === undefined || raw === null || raw === '';

    if (missing) {
      if (field.required && options.requireAll !== false) {
        throw new AuthError('VALIDATION_FAILED', `缺少必填字段 ${field.label}`);
      }
      continue;
    }

    if (field.type === 'integer') {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        throw new AuthError('VALIDATION_FAILED', `字段 ${field.label} 必须是整数`);
      }
      if (field.min !== undefined && raw < field.min) {
        throw new AuthError('VALIDATION_FAILED', `字段 ${field.label} 不能小于 ${field.min}`);
      }
      if (field.max !== undefined && raw > field.max) {
        throw new AuthError('VALIDATION_FAILED', `字段 ${field.label} 不能大于 ${field.max}`);
      }
      result[field.key] = raw;
      continue;
    }

    if (typeof raw !== 'string') {
      throw new AuthError('VALIDATION_FAILED', `字段 ${field.label} 必须是字符串`);
    }
    const text = raw.trim();
    if (text === '') {
      if (field.required) {
        throw new AuthError('VALIDATION_FAILED', `缺少必填字段 ${field.label}`);
      }
      continue;
    }
    if (field.maxLength !== undefined && text.length > field.maxLength) {
      throw new AuthError(
        'VALIDATION_FAILED',
        `字段 ${field.label} 最长 ${field.maxLength} 个字符`,
      );
    }
    result[field.key] = text;
  }

  return result;
}
