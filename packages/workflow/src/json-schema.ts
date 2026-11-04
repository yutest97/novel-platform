/**
 * 最小但**严格**的 JSON Schema 子集（A1-1）。
 *
 * 为什么不用第三方校验库：Agent 的输入/输出契约是安全边界，
 * 需要"未知字段默认拒绝"的确定性行为与可审计的实现；这里只实现
 * 实际用得到的子集，并在注册 Agent 时先校验 Schema 本身合法。
 *
 * 严格性：
 * - object 默认 `additionalProperties: false`，未声明的字段一律拒绝；
 * - number 必须是有限数；integer 不接受 1.5；
 * - 不支持的关键字（oneOf/anyOf/$ref…）视为 Schema 非法，
 *   而不是静默忽略 —— 否则"校验通过"会变成假象。
 */

import { WorkflowError } from './errors.js';

/** 支持的 JSON 类型。 */
export type JsonSchemaType =
  'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

/** 枚举值只允许 JSON 原始类型。 */
export type JsonPrimitive = string | number | boolean | null;

/** 受支持的 Schema 子集。 */
export interface JsonSchema {
  readonly type?: JsonSchemaType;
  readonly enum?: readonly JsonPrimitive[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  /** 默认 false：未声明的字段直接拒绝。 */
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
}

/** 一条校验问题（只描述路径与原因，不回显字段值）。 */
export interface JsonIssue {
  readonly path: string;
  readonly message: string;
}

const ALLOWED_KEYS = new Set([
  'type',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'description',
]);

const TYPES = new Set<JsonSchemaType>([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

function schemaError(path: string, message: string): WorkflowError {
  return new WorkflowError('AGENT_SCHEMA_INVALID', `Agent Schema 不合法（${path}）：${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * 校验 Schema 定义本身。
 *
 * @throws WorkflowError `AGENT_SCHEMA_INVALID`
 */
export function assertJsonSchema(schema: unknown, path = '$'): asserts schema is JsonSchema {
  if (!isPlainObject(schema)) {
    throw schemaError(path, '必须是对象');
  }
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw schemaError(path, `不支持的关键字 ${key}`);
    }
  }

  const type = schema['type'];
  const hasEnum = schema['enum'] !== undefined;
  if (type === undefined && !hasEnum) {
    throw schemaError(path, '必须声明 type 或 enum');
  }
  if (type !== undefined && (typeof type !== 'string' || !TYPES.has(type as JsonSchemaType))) {
    throw schemaError(path, 'type 不合法');
  }

  if (hasEnum) {
    const values = schema['enum'];
    if (!Array.isArray(values) || values.length === 0) {
      throw schemaError(path, 'enum 必须是非空数组');
    }
    const seen = new Set<string>();
    for (const value of values) {
      if (!isPrimitive(value)) {
        throw schemaError(path, 'enum 只允许 JSON 原始类型');
      }
      const marker = `${typeof value}:${String(value)}`;
      if (seen.has(marker)) {
        throw schemaError(path, 'enum 存在重复值');
      }
      seen.add(marker);
    }
  }

  const properties = schema['properties'];
  if (properties !== undefined) {
    if (!isPlainObject(properties)) {
      throw schemaError(path, 'properties 必须是对象');
    }
    for (const [key, child] of Object.entries(properties)) {
      assertJsonSchema(child, `${path}.properties.${key}`);
    }
  }

  const required = schema['required'];
  if (required !== undefined) {
    if (!Array.isArray(required)) {
      throw schemaError(path, 'required 必须是数组');
    }
    for (const key of required) {
      if (typeof key !== 'string' || key === '') {
        throw schemaError(path, 'required 的元素必须是非空字符串');
      }
      if (properties === undefined || !(key in properties)) {
        throw schemaError(path, `required 引用了未声明的字段 ${key}`);
      }
    }
  }

  const additional = schema['additionalProperties'];
  if (additional !== undefined && typeof additional !== 'boolean') {
    throw schemaError(path, 'additionalProperties 必须是布尔值');
  }

  const items = schema['items'];
  if (type === 'array') {
    if (items === undefined) {
      throw schemaError(path, 'array 必须声明 items');
    }
    assertJsonSchema(items, `${path}.items`);
  } else if (items !== undefined) {
    throw schemaError(path, '只有 array 可以声明 items');
  }

  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength'] as const) {
    const value = schema[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    ) {
      throw schemaError(path, `${key} 必须是非负整数`);
    }
  }

  for (const key of ['minimum', 'maximum'] as const) {
    const value = schema[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw schemaError(path, `${key} 必须是有限数`);
    }
  }

  const pattern = schema['pattern'];
  if (pattern !== undefined) {
    if (typeof pattern !== 'string') {
      throw schemaError(path, 'pattern 必须是字符串');
    }
    try {
      new RegExp(pattern, 'u');
    } catch {
      throw schemaError(path, 'pattern 不是合法正则');
    }
  }
}

function pathFor(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

/**
 * 校验一个 JSON 值。
 *
 * 返回空数组表示通过；每个问题只包含路径与固定原因，不回显值。
 */
export function validateJson(schema: JsonSchema, value: unknown, path = '$'): readonly JsonIssue[] {
  const issues: JsonIssue[] = [];

  if (schema.enum !== undefined) {
    const matched = schema.enum.some((item) => Object.is(item, value));
    if (!matched) {
      issues.push({ path, message: '不在允许的枚举值内' });
      return issues;
    }
  }

  const type = schema.type;
  if (type === undefined) {
    return issues;
  }

  switch (type) {
    case 'object': {
      if (!isPlainObject(value)) {
        issues.push({ path, message: '必须是对象' });
        return issues;
      }
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          issues.push({ path: pathFor(path, key), message: '缺少必填字段' });
        }
      }
      if (schema.additionalProperties !== true) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) {
            issues.push({ path: pathFor(path, key), message: '不允许的额外字段' });
          }
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          continue;
        }
        issues.push(...validateJson(child, value[key], pathFor(path, key)));
      }
      return issues;
    }

    case 'array': {
      if (!Array.isArray(value)) {
        issues.push({ path, message: '必须是数组' });
        return issues;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        issues.push({ path, message: `数组长度不能小于 ${schema.minItems}` });
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        issues.push({ path, message: `数组长度不能大于 ${schema.maxItems}` });
      }
      const items = schema.items;
      if (items !== undefined) {
        value.forEach((item, index) => {
          issues.push(...validateJson(items, item, `${path}[${index}]`));
        });
      }
      return issues;
    }

    case 'string': {
      if (typeof value !== 'string') {
        issues.push({ path, message: '必须是字符串' });
        return issues;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        issues.push({ path, message: `长度不能小于 ${schema.minLength}` });
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        issues.push({ path, message: `长度不能大于 ${schema.maxLength}` });
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
        issues.push({ path, message: '不符合格式要求' });
      }
      return issues;
    }

    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ path, message: '必须是有限数' });
        return issues;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        issues.push({ path, message: `不能小于 ${schema.minimum}` });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        issues.push({ path, message: `不能大于 ${schema.maximum}` });
      }
      return issues;
    }

    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        issues.push({ path, message: '必须是整数' });
        return issues;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        issues.push({ path, message: `不能小于 ${schema.minimum}` });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        issues.push({ path, message: `不能大于 ${schema.maximum}` });
      }
      return issues;
    }

    case 'boolean': {
      if (typeof value !== 'boolean') {
        issues.push({ path, message: '必须是布尔值' });
      }
      return issues;
    }

    case 'null': {
      if (value !== null) {
        issues.push({ path, message: '必须是 null' });
      }
      return issues;
    }

    default:
      // assertJsonSchema 已保证不会到这里；真到这说明 Schema 被绕过。
      issues.push({ path, message: '未知的 Schema 类型' });
      return issues;
  }
}
