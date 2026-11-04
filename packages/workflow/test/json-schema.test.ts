/**
 * JSON Schema 子集校验（A1-1）。
 *
 * 重点不是"支持多少关键字"，而是**严格**：
 * - 未声明字段默认拒绝；
 * - 非法 Schema 在注册阶段就报错，而不是运行时静默放过；
 * - 错误只带路径与原因，不回显字段值。
 */

import { describe, expect, it } from 'vitest';

import { WorkflowError } from '../src/errors.js';
import { assertJsonSchema, validateJson, type JsonSchema } from '../src/json-schema.js';

const personSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 10 },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    role: { enum: ['author', 'admin', null] },
  },
  required: ['name'],
  additionalProperties: false,
};

describe('validateJson', () => {
  it('接受合法对象（含可选字段与数组）', () => {
    expect(
      validateJson(personSchema, { name: '林青', age: 20, tags: ['a', 'b'], role: 'author' }),
    ).toEqual([]);
  });

  it('拒绝未声明字段（默认 additionalProperties=false）', () => {
    const issues = validateJson(personSchema, { name: '林青', secret: 'x' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('$.secret');
    expect(issues[0]?.message).toContain('不允许');
  });

  it('必填缺失、类型错误、边界错误都带路径', () => {
    const issues = validateJson(personSchema, { age: 1.5, tags: ['a', 'b', 'c'] });
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain('$.name');
    expect(paths).toContain('$.age');
    expect(paths).toContain('$.tags');
  });

  it('integer 不接受小数，number 接受有限数', () => {
    expect(validateJson({ type: 'integer' }, 1.5)).toHaveLength(1);
    expect(validateJson({ type: 'number' }, 1.5)).toHaveLength(0);
    expect(validateJson({ type: 'number' }, Number.POSITIVE_INFINITY)).toHaveLength(1);
  });

  it('enum 按 JSON 原始值严格匹配', () => {
    expect(validateJson({ enum: ['a', 1, null] }, 'a')).toHaveLength(0);
    expect(validateJson({ enum: ['a', 1, null] }, null)).toHaveLength(0);
    expect(validateJson({ enum: ['a', 1, null] }, 'b')).toHaveLength(1);
  });

  it('字符串长度与正则', () => {
    const schema: JsonSchema = { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' };
    expect(validateJson(schema, 'abc')).toHaveLength(0);
    expect(validateJson(schema, 'a')).toHaveLength(1);
    expect(validateJson(schema, 'abcdef')).toHaveLength(1);
    expect(validateJson(schema, 'ABC')).toHaveLength(1);
  });

  it('数组边界与元素校验', () => {
    const schema: JsonSchema = {
      type: 'array',
      items: { type: 'integer' },
      minItems: 1,
      maxItems: 2,
    };
    expect(validateJson(schema, [1, 2])).toHaveLength(0);
    expect(validateJson(schema, [])).toHaveLength(1);
    expect(validateJson(schema, [1, 2, 3])).toHaveLength(1);
    expect(validateJson(schema, [1, 'x'])[0]?.path).toBe('$[1]');
  });

  it('不接受 null / 非对象冒充 object', () => {
    expect(validateJson({ type: 'object' }, null)).toHaveLength(1);
    expect(validateJson({ type: 'object' }, [])).toHaveLength(1);
  });

  it('错误不回显字段值', () => {
    const issues = validateJson(personSchema, { name: 'x', age: '顶不住了' });
    expect(JSON.stringify(issues)).not.toContain('顶不住了');
  });
});

describe('assertJsonSchema', () => {
  it('接受合法 Schema', () => {
    expect(() => assertJsonSchema(personSchema)).not.toThrow();
  });

  it.each([
    ['不支持的关键字', { type: 'object', oneOf: [] }],
    ['缺少 type/enum', { properties: {} }],
    ['未知 type', { type: 'date' }],
    ['array 缺 items', { type: 'array' }],
    ['required 引用未声明字段', { type: 'object', properties: {}, required: ['x'] }],
    ['enum 为空', { enum: [] }],
    ['enum 含对象', { enum: [{ a: 1 }] }],
    ['pattern 非正则', { type: 'string', pattern: '[' }],
    ['minItems 为负', { type: 'array', items: { type: 'string' }, minItems: -1 }],
  ])('拒绝非法 Schema：%s', (_label, schema) => {
    expect(() => assertJsonSchema(schema)).toThrow(WorkflowError);
  });

  it('非法 Schema 的错误只描述位置与原因', () => {
    try {
      assertJsonSchema({ type: 'object', properties: { a: { type: 'array' } } });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      const message = (error as WorkflowError).message;
      expect(message).toContain('$.properties.a');
      expect(message).not.toContain('SECRET');
    }
  });
});
