/**
 * 任务请求指纹（A1-1-REV-01）。
 *
 * 目的：`(work_id, request_id)` 只能代表**同一个逻辑请求**。
 * 同一个 request_id 配不同输入时，必须稳定失败而不是静默返回旧任务。
 *
 * 规则：
 * - 覆盖所有会影响任务语义的字段：
 *   `chapterId / taskType / inputSnapshot / provider / model / maxAttempts`；
 * - `inputSnapshot` 先转成 **canonical JSON** 再算 SHA-256：
 *   对象 key 递归排序、数组保持原顺序、拒绝不可稳定序列化的值；
 * - 只落库 64 位小写十六进制摘要，**不落库快照原文之外的内容**，
 *   摘要本身不含正文 / prompt / 密钥。
 *
 * 注意：canonical 规则一旦上线就是契约，修改算法需要同时迁移 `input_hash`。
 */

import { createHash } from 'node:crypto';

/** SHA-256 十六进制摘要长度（与数据库 CHECK 一致）。 */
export const TASK_INPUT_HASH_LENGTH = 64;

/** 最大嵌套层级：防止病态输入在序列化阶段爆栈。 */
const MAX_DEPTH = 100;

/**
 * canonical JSON 无法稳定表示某个值。
 *
 * `message` 只包含路径与原因，不回显值本身（避免把输入内容带进日志）。
 */
export class CanonicalJsonError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path} ${reason}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

/** 拼接可读路径：标识符用 `.key`，其它用 `["key"]`。 */
function childPath(base: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${base}.${key}`
    : `${base}[${JSON.stringify(key)}]`;
}

function serialize(value: unknown, path: string, seen: Set<object>, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalJsonError(path, `嵌套层级不能超过 ${MAX_DEPTH}`);
  }

  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(path, '必须是有限数字');
      }
      return JSON.stringify(value);
    case 'bigint':
      throw new CanonicalJsonError(path, '不支持 BigInt');
    case 'undefined':
      throw new CanonicalJsonError(path, '不能是 undefined');
    case 'function':
      throw new CanonicalJsonError(path, '不支持函数');
    case 'symbol':
      throw new CanonicalJsonError(path, '不支持 Symbol');
    default:
      break;
  }

  const object = value;
  if (seen.has(object)) {
    throw new CanonicalJsonError(path, '存在循环引用');
  }
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      const array = value as readonly unknown[];
      const parts: string[] = [];
      // 不用 forEach/map：稀疏数组的空洞会以 undefined 进入校验并被拒绝。
      for (let index = 0; index < array.length; index += 1) {
        parts.push(serialize(array[index], `${path}[${index}]`, seen, depth + 1));
      }
      return `[${parts.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(object) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      // Date / Map / Set / 类实例的序列化结果依赖实现，不作为稳定输入。
      throw new CanonicalJsonError(path, '必须是纯对象');
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw new CanonicalJsonError(path, '不支持 Symbol 键');
    }

    const record = object as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serialize(record[key], childPath(path, key), seen, depth + 1)}`,
      );
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

/**
 * 稳定序列化：对象 key 递归排序、数组保持原顺序。
 *
 * 与 `JSON.stringify` 的差异（均为有意）：
 * - 拒绝 `undefined` / 函数 / Symbol（不静默丢弃）；
 * - 拒绝 BigInt、非有限数字、非纯对象、循环引用与过深嵌套；
 * - 相同语义的对象无论 key 顺序如何，输出完全一致。
 */
export function canonicalJsonStringify(value: unknown): string {
  return serialize(value, '$', new Set<object>(), 0);
}

/** 参与指纹计算的字段（必须覆盖所有影响任务语义的输入）。 */
export interface TaskRequestFingerprintInput {
  /** 已规范化为小写 UUID；无章节任务为 null。 */
  readonly chapterId: string | null;
  readonly taskType: string;
  readonly inputSnapshot: unknown;
  readonly provider: string;
  readonly model: string;
  readonly maxAttempts: number;
}

/** canonical JSON 形式的指纹载荷（测试与排查用，不落库）。 */
export function serializeTaskRequestFingerprint(input: TaskRequestFingerprintInput): string {
  return canonicalJsonStringify({
    chapterId: input.chapterId,
    taskType: input.taskType,
    inputSnapshot: input.inputSnapshot,
    provider: input.provider,
    model: input.model,
    maxAttempts: input.maxAttempts,
  });
}

/** 计算 `input_hash`：SHA-256(hex)，64 位小写。 */
export function hashTaskRequest(input: TaskRequestFingerprintInput): string {
  return createHash('sha256').update(serializeTaskRequestFingerprint(input), 'utf8').digest('hex');
}
