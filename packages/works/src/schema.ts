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

import { isUuid } from './ids.js';

/**
 * entityRefs 的**统一硬上限**。
 *
 * 即使规则包把 `maxItems` 写得更大，也按此值封顶 ——
 * 避免单个请求把无限多的引用塞进一行 jsonb。
 */
export const MAX_ENTITY_REFS = 50;

/** 支持的字段类型。 */
export type FieldType = 'string' | 'text' | 'integer' | 'enum' | 'entityRef' | 'entityRefs';

/** 已知字段类型清单（契约校验用，必须与 `FieldType` 保持同步）。 */
const KNOWN_FIELD_TYPES: readonly FieldType[] = [
  'string',
  'text',
  'integer',
  'enum',
  'entityRef',
  'entityRefs',
];

function isKnownFieldType(value: unknown): value is FieldType {
  return typeof value === 'string' && (KNOWN_FIELD_TYPES as readonly string[]).includes(value);
}

/** 引用类字段类型（值是实体 UUID）。 */
export function isReferenceFieldType(type: FieldType): boolean {
  return type === 'entityRef' || type === 'entityRefs';
}

/** enum 的一个选项：`value` 入库、`label` 仅展示。 */
export interface EnumOption {
  readonly value: string;
  readonly label: string;
}

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
  /** type=enum 时的可选值集合（value 为入库值）。 */
  readonly options?: readonly EnumOption[];
  /** type=entityRef / entityRefs 时的目标实体类型。 */
  readonly refType?: string;
  /** type=entityRefs 时的元素个数上限。 */
  readonly maxItems?: number;
}

/** 一组字段定义（作品方向或某个实体类型）。 */
export interface FieldGroup {
  readonly title: string;
  readonly schemaRef: string;
  /** 分组展示顺序（实体类型之间）；缺省排到最后。 */
  readonly order?: number;
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
  if (
    type !== 'string' &&
    type !== 'text' &&
    type !== 'integer' &&
    type !== 'enum' &&
    type !== 'entityRef' &&
    type !== 'entityRefs'
  ) {
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
    options?: readonly EnumOption[];
    refType?: string;
    maxItems?: number;
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
  if (typeof item['refType'] === 'string') {
    definition.refType = item['refType'];
  }
  if (typeof item['maxItems'] === 'number') {
    definition.maxItems = item['maxItems'];
  }

  const rawOptions = item['options'];
  if (Array.isArray(rawOptions)) {
    const options: EnumOption[] = [];
    for (const entry of rawOptions) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const option = entry as Record<string, unknown>;
      const value = option['value'];
      const optionLabel = option['label'];
      if (typeof value === 'string' && typeof optionLabel === 'string') {
        options.push({ value, label: optionLabel });
      }
    }
    definition.options = options;
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

  const group: {
    title: string;
    schemaRef: string;
    order?: number;
    fields: readonly FieldDefinition[];
  } = {
    title: typeof item['title'] === 'string' ? item['title'] : '',
    schemaRef: typeof item['schemaRef'] === 'string' ? item['schemaRef'] : '',
    fields,
  };
  if (typeof item['order'] === 'number') {
    group.order = item['order'];
  }
  return group;
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

/**
 * 契约问题一律按 `INVALID_RULE_PACKAGE` 抛出。
 *
 * 这是**规则包坏数据**，不是调用方的输入错误：
 * 解析器会宽松地丢掉不认识的字段，若不在读取时拦下来，
 * 表现为"作者看到残缺的 schema、写入被静默忽略"，比直接报错危险得多。
 */
function contractViolation(detail: string): never {
  throw new AuthError('INVALID_RULE_PACKAGE', detail);
}

/** 校验单个字段组的契约完整性。 */
function assertGroupContract(
  groupKey: string,
  rawGroup: unknown,
  declaredTypes: ReadonlySet<string>,
): void {
  if (typeof rawGroup !== 'object' || rawGroup === null || Array.isArray(rawGroup)) {
    contractViolation(`规则包字段组 ${groupKey} 结构不合法`);
  }
  const group = rawGroup as Record<string, unknown>;
  const rawFields = group['fields'];
  if (!Array.isArray(rawFields)) {
    contractViolation(`规则包字段组 ${groupKey} 缺少字段定义`);
  }

  const seenKeys = new Set<string>();
  for (const rawField of rawFields) {
    if (typeof rawField !== 'object' || rawField === null || Array.isArray(rawField)) {
      contractViolation(`规则包字段组 ${groupKey} 存在非法字段定义`);
    }
    const field = rawField as Record<string, unknown>;
    const key = field['key'];
    if (typeof key !== 'string' || key === '') {
      contractViolation(`规则包字段组 ${groupKey} 存在缺少 key 的字段`);
    }
    if (seenKeys.has(key)) {
      contractViolation(`规则包字段组 ${groupKey} 存在重复字段 ${key}`);
    }
    seenKeys.add(key);

    const type = field['type'];
    if (!isKnownFieldType(type)) {
      contractViolation(`规则包字段组 ${groupKey}.${key} 的字段类型不合法`);
    }

    if (type === 'enum') {
      const options = field['options'];
      if (!Array.isArray(options) || options.length === 0) {
        contractViolation(`规则包字段组 ${groupKey}.${key} 的 enum 选项为空`);
      }
      const values = new Set<string>();
      for (const rawOption of options) {
        if (typeof rawOption !== 'object' || rawOption === null || Array.isArray(rawOption)) {
          contractViolation(`规则包字段组 ${groupKey}.${key} 存在非法 enum 选项`);
        }
        const option = rawOption as Record<string, unknown>;
        const value = option['value'];
        const label = option['label'];
        if (typeof value !== 'string' || value === '' || typeof label !== 'string') {
          contractViolation(`规则包字段组 ${groupKey}.${key} 存在非法 enum 选项`);
        }
        if (values.has(value)) {
          contractViolation(`规则包字段组 ${groupKey}.${key} 的 enum 选项 value 重复`);
        }
        values.add(value);
      }
    }

    if (type === 'entityRef' || type === 'entityRefs') {
      const refType = field['refType'];
      if (typeof refType !== 'string' || refType === '') {
        contractViolation(`规则包字段组 ${groupKey}.${key} 缺少 refType`);
      }
      if (!declaredTypes.has(refType)) {
        contractViolation(`规则包字段组 ${groupKey}.${key} 的 refType ${refType} 未在规则包中声明`);
      }
      // maxItems 只在 entityRefs 上有效；一旦出现就必须是正整数
      // （统一硬上限 MAX_ENTITY_REFS 由 validateFields 另行封顶）。
      if (type === 'entityRefs' && field['maxItems'] !== undefined) {
        const maxItems = field['maxItems'];
        if (typeof maxItems !== 'number' || !Number.isInteger(maxItems) || maxItems <= 0) {
          contractViolation(`规则包字段组 ${groupKey}.${key} 的 maxItems 必须是正整数`);
        }
      }
    }
  }
}

/**
 * 校验 `field_schema` 的字段契约完整性。
 *
 * 在**读取规则包之后、做任何业务判断之前**调用（见 `requireRulePackage`）：
 * 坏规则包必须在入口处就失败，而不是解析成一份"看起来正常、其实残缺"的 schema。
 *
 * 校验项（M2-B2-A-REV-01）：
 * 1. 字段类型必须是已知类型；
 * 2. `enum` 的 `options` 必须非空，且每个 `value` 非空、不重复；
 * 3. `entityRef` / `entityRefs` 必须有 `refType`；
 * 4. `refType` 必须在该 `field_schema.entityTypes` 中声明；
 * 5. `entityRefs.maxItems` 如果出现，必须是正整数。
 */
export function assertFieldSchemaContract(rawSchema: unknown): void {
  if (typeof rawSchema !== 'object' || rawSchema === null || Array.isArray(rawSchema)) {
    contractViolation('规则包缺少字段定义');
  }
  const schema = rawSchema as Record<string, unknown>;

  const entityTypes: Record<string, unknown> = {};
  const rawEntityTypes = schema['entityTypes'];
  if (rawEntityTypes !== undefined) {
    if (
      typeof rawEntityTypes !== 'object' ||
      rawEntityTypes === null ||
      Array.isArray(rawEntityTypes)
    ) {
      contractViolation('规则包的 entityTypes 结构不合法');
    }
    Object.assign(entityTypes, rawEntityTypes as Record<string, unknown>);
  }

  const declaredTypes = new Set(Object.keys(entityTypes));
  if (schema['workDirection'] !== undefined) {
    assertGroupContract('workDirection', schema['workDirection'], declaredTypes);
  }
  for (const [key, value] of Object.entries(entityTypes)) {
    assertGroupContract(key, value, declaredTypes);
  }
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
 * 取"作品方向"这组字段定义。
 *
 * 作品方向与实体类型在 field_schema 里是**两个并列的顶层键**
 * （`workDirection` 与 `entityTypes`），因此不能用 `entityTypeGroup`。
 */
export function workDirectionGroup(rulePackage: { fieldSchema: unknown }): FieldGroup | null {
  return parseRuleFieldSchema(rulePackage.fieldSchema).workDirection ?? null;
}

/**
 * 按字段定义校验一组设定值。
 *
 * 规则：
 * - 未知字段 → 400（严格，不静默忽略）；
 * - 必填字段缺失或为空 → 400；
 * - 类型不符 → 400；
 * - 整数越界、字符串超长 → 400；
 * - enum 取值不在规则包选项内 → 400；
 * - entityRef / entityRefs 必须是 UUID 形态（**存在性由服务层在事务内另校验**）；
 * - entityRefs 出现重复 UUID → 400（不静默去重）；超过上限 → 400；
 * - 可选字段未提供或为空 → 不写入（调用方负责合并）。
 *
 * @returns 规范化后的值（只含已定义且有值的字段）
 */
export function validateFields(
  group: FieldGroup,
  values: Record<string, unknown>,
  options: { requireAll?: boolean } = {},
): Record<string, string | number | string[]> {
  const known = new Set(group.fields.map((field) => field.key));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) {
      throw new AuthError('VALIDATION_FAILED', `未知字段 ${key}`);
    }
  }

  const result: Record<string, string | number | string[]> = {};
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

    if (field.type === 'enum') {
      if (typeof raw !== 'string') {
        throw new AuthError('VALIDATION_FAILED', `字段 ${field.label} 必须是字符串`);
      }
      const allowed = (field.options ?? []).map((option) => option.value);
      if (!allowed.includes(raw)) {
        throw new AuthError('VALIDATION_FAILED', `字段 ${field.label} 的取值不在允许范围内`);
      }
      result[field.key] = raw;
      continue;
    }

    if (field.type === 'entityRef') {
      if (typeof raw !== 'string' || !isUuid(raw)) {
        throw new AuthError('VALIDATION_FAILED', `字段 ${field.label} 必须是实体 id`);
      }
      result[field.key] = raw;
      continue;
    }

    if (field.type === 'entityRefs') {
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || !isUuid(item))) {
        throw new AuthError('VALIDATION_FAILED', `字段 ${field.label} 必须是实体 id 数组`);
      }
      // 空数组 = 清空该字段（不写行）
      if (raw.length === 0) {
        continue;
      }
      const limit = Math.min(field.maxItems ?? MAX_ENTITY_REFS, MAX_ENTITY_REFS);
      if (raw.length > limit) {
        throw new AuthError('VALIDATION_FAILED', `字段 ${field.label} 最多 ${limit} 项`);
      }
      // 重复不静默去重：直接拒绝，避免调用方误以为写入成功
      if (new Set(raw).size !== raw.length) {
        throw new AuthError('VALIDATION_FAILED', `字段 ${field.label} 存在重复项`);
      }
      // 保持输入顺序
      result[field.key] = [...(raw as string[])];
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
