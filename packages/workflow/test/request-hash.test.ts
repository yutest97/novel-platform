/**
 * 任务请求指纹（A1-1-REV-01）。
 *
 * 覆盖：canonical JSON 的稳定性（key 排序 / 数组顺序 / 拒绝不可序列化值）、
 * SHA-256 摘要形态、六个语义字段的覆盖，以及"错误信息不回显输入内容"。
 */

import { describe, expect, it } from 'vitest';

import {
  CanonicalJsonError,
  TASK_INPUT_HASH_LENGTH,
  canonicalJsonStringify,
  hashTaskRequest,
  serializeTaskRequestFingerprint,
} from '../src/request-hash.js';

const CHAPTER_ID = '11111111-1111-4111-8111-111111111111';

function fingerprint(
  overrides: Partial<Parameters<typeof hashTaskRequest>[0]> = {},
): Parameters<typeof hashTaskRequest>[0] {
  return {
    chapterId: CHAPTER_ID,
    taskType: 'test.flow',
    inputSnapshot: { question: '你好', options: { tone: 'plain', length: 100 } },
    provider: 'mock',
    model: 'mock-model',
    maxAttempts: 3,
    ...overrides,
  };
}

describe('canonical JSON', () => {
  it('对象 key 顺序不同但语义相同 → 输出与 hash 完全一致', () => {
    const left = { beta: 1, alpha: { delta: 4, charlie: [3, 2] } };
    const right = { alpha: { charlie: [3, 2], delta: 4 }, beta: 1 };

    expect(canonicalJsonStringify(left)).toBe(canonicalJsonStringify(right));
    expect(hashTaskRequest(fingerprint({ inputSnapshot: left }))).toBe(
      hashTaskRequest(fingerprint({ inputSnapshot: right })),
    );
  });

  it('递归排序嵌套对象，数组保持原顺序', () => {
    expect(canonicalJsonStringify({ list: [{ b: 1, a: 2 }] })).toBe('{"list":[{"a":2,"b":1}]}');
    expect(canonicalJsonStringify({ list: [1, 2, 3] })).not.toBe(
      canonicalJsonStringify({ list: [3, 2, 1] }),
    );
    expect(canonicalJsonStringify({ list: [1, 2, 3] })).toBe('{"list":[1,2,3]}');
  });

  it('字符串转义稳定', () => {
    expect(canonicalJsonStringify({ 'a"b': 'x\ny' })).toBe('{"a\\"b":"x\\ny"}');
  });

  it('拒绝 undefined（对象值、数组元素、顶层）', () => {
    expect(() => canonicalJsonStringify({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify([1, undefined])).toThrow(/不能是 undefined/);
    expect(() => canonicalJsonStringify(undefined)).toThrow(/不能是 undefined/);
  });

  it('拒绝函数、Symbol 与 BigInt', () => {
    expect(() => canonicalJsonStringify({ fn: () => 1 })).toThrow(/不支持函数/);
    expect(() => canonicalJsonStringify([Symbol('x')])).toThrow(/不支持 Symbol/);
    expect(() => canonicalJsonStringify({ n: 1n })).toThrow(/不支持 BigInt/);
    expect(() => canonicalJsonStringify({ [Symbol('k')]: 1 })).toThrow(/Symbol 键/);
  });

  it('拒绝循环引用；允许同一对象的非循环复用', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJsonStringify(cyclic)).toThrow(/循环引用/);

    const shared = { a: 1 };
    expect(canonicalJsonStringify({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });

  it('拒绝非有限数字与非纯对象', () => {
    expect(() => canonicalJsonStringify({ n: Number.NaN })).toThrow(/有限数字/);
    expect(() => canonicalJsonStringify({ n: Number.POSITIVE_INFINITY })).toThrow(/有限数字/);
    expect(() => canonicalJsonStringify({ d: new Date() })).toThrow(/纯对象/);
    expect(() => canonicalJsonStringify(new Map())).toThrow(/纯对象/);
  });

  it('错误只带路径与原因，不回显输入值', () => {
    let caught: unknown;
    try {
      canonicalJsonStringify({ outer: { inner: 'super-secret' }, bad: undefined });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CanonicalJsonError);
    const message = (caught as Error).message;
    expect(message).toContain('$.bad');
    expect(message).not.toContain('super-secret');
  });
});

describe('任务请求指纹', () => {
  it('载荷覆盖六个语义字段', () => {
    const payload = JSON.parse(serializeTaskRequestFingerprint(fingerprint())) as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).sort()).toEqual([
      'chapterId',
      'inputSnapshot',
      'maxAttempts',
      'model',
      'provider',
      'taskType',
    ]);
  });

  it('六个字段任一变化都会改变 hash', () => {
    const variants: [string, Partial<Parameters<typeof hashTaskRequest>[0]>][] = [
      ['chapterId', { chapterId: null }],
      ['taskType', { taskType: 'test.other' }],
      ['inputSnapshot', { inputSnapshot: { question: '你好' } }],
      ['provider', { provider: 'openai-compatible' }],
      ['model', { model: 'other-model' }],
      ['maxAttempts', { maxAttempts: 5 }],
    ];
    const baseHash = hashTaskRequest(fingerprint());

    for (const [label, overrides] of variants) {
      expect(hashTaskRequest(fingerprint(overrides)), label).not.toBe(baseHash);
    }
  });

  it('输出 64 位小写十六进制摘要，不含正文或 prompt 片段', () => {
    const hash = hashTaskRequest(
      fingerprint({
        inputSnapshot: { secret: 'sk-live-TOPSECRET', draft: '正文片段'.repeat(20) },
      }),
    );

    expect(hash).toHaveLength(TASK_INPUT_HASH_LENGTH);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('sk-live');
    expect(hash).not.toContain('TOPSECRET');
    expect(hash).not.toContain('正文');
  });
});
