/**
 * 章节 / 生成任务 / 候选接口的请求解析（A1-3B）。
 *
 * 全部走**严格白名单**：出现任何未声明字段（`provider` / `model` / `authorId` /
 * `status` / `workId` / 时间戳……）一律 400，不静默忽略 ——
 * 否则客户端会误以为"提交成功"。
 */

import { AuthError } from '@novel/auth';
import {
  MAX_CONTRACT_TARGET_WORDS,
  MIN_CONTRACT_TARGET_WORDS,
  type ChapterStyle,
} from '@novel/workflow';

/** 创建章节的允许字段。 */
export const CHAPTER_CREATE_FIELDS = ['chapterNo', 'title'] as const;

/**
 * 提交生成任务的允许字段。
 *
 * 刻意不含 `provider` / `model`：它们只来自服务端配置，
 * 客户端无法指定模型或绕过服务端的 Provider 选择。
 */
export const CHAPTER_GENERATE_FIELDS = ['requestId', 'targetWords', 'style'] as const;

/** 采纳候选的允许字段（`requestId` 可选，仅用于追踪）。 */
export const CANDIDATE_ADOPT_FIELDS = ['requestId'] as const;

/**
 * 保存人工版本的允许字段（A1-4B-A）。
 *
 * 只有正文与基线版本：`source` / `versionNo` / `createdBy` / `chapterId` /
 * `workId` / 时间戳全部由服务端决定，提交即 400。
 */
export const HUMAN_VERSION_FIELDS = ['content', 'baseVersionId'] as const;

/**
 * 人工版本请求体上限（**字符数**）。
 *
 * 正文允许到 200000 字符；JSON 转义（换行 / 引号 / 控制字符）会放大长度，
 * 这里留足余量，避免把"正文超长"误判成"请求体过大"——
 * 后者应由服务层统一报 `CHAPTER_CONTENT_INVALID`。
 */
export const HUMAN_VERSION_BODY_MAX_LENGTH = 1_500_000;

const STYLE_FIELDS = ['tone', 'pointOfView', 'pacing'] as const;
const MAX_STYLE_VALUE_LENGTH = 100;
const MAX_REQUEST_ID_LENGTH = 128;

/** 读取必填正整数。 */
export function requirePositiveInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AuthError('VALIDATION_FAILED', `字段 ${key} 必须是正整数`);
  }
  return value;
}

/** 读取人工版本正文（只校验类型；trim / 长度 / 字数在服务层统一处理）。 */
export function requireVersionContent(body: Record<string, unknown>): string {
  const value = body['content'];
  if (typeof value !== 'string') {
    throw new AuthError('VALIDATION_FAILED', '字段 content 必须是字符串');
  }
  return value;
}

/**
 * 读取 `baseVersionId`：**必须显式提交**。
 *
 * - `null`：预期章节当前没有正式版本（首版）；
 * - 字符串：必须等于当前最大版本 id，否则服务层 409。
 *
 * 用 `hasOwnProperty` 判断"是否出现"，而不是 `undefined` 判断：
 * 漏传字段要报 400，不能默默当成 null。
 */
export function requireBaseVersionId(body: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(body, 'baseVersionId')) {
    throw new AuthError('VALIDATION_FAILED', '缺少字段 baseVersionId（首版请显式传 null）');
  }
  const value = body['baseVersionId'];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuthError('VALIDATION_FAILED', 'baseVersionId 必须是版本 id 或 null');
  }
  return value;
}

/** 读取章节标题（只校验类型；trim 与长度在服务层统一处理）。 */
export function requireChapterTitle(body: Record<string, unknown>): string {
  const value = body['title'];
  if (typeof value !== 'string') {
    throw new AuthError('VALIDATION_FAILED', '字段 title 必须是字符串');
  }
  return value;
}

function assertRequestId(value: unknown, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) {
      throw new AuthError('VALIDATION_FAILED', '缺少字段 requestId');
    }
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_REQUEST_ID_LENGTH) {
    throw new AuthError('VALIDATION_FAILED', `requestId 长度必须在 1..${MAX_REQUEST_ID_LENGTH}`);
  }
  return value;
}

/** 读取必填 requestId。 */
export function requireRequestId(body: Record<string, unknown>): string {
  return assertRequestId(body['requestId'], true) ?? '';
}

/** 读取可选 requestId（采纳接口用）。 */
export function optionalRequestId(body: Record<string, unknown>): string | undefined {
  return assertRequestId(body['requestId'], false);
}

/** 读取可选目标字数：必须是契约允许的 2500..4000 整数。 */
export function optionalTargetWords(body: Record<string, unknown>): number | undefined {
  const value = body['targetWords'];
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_CONTRACT_TARGET_WORDS ||
    value > MAX_CONTRACT_TARGET_WORDS
  ) {
    throw new AuthError(
      'VALIDATION_FAILED',
      `targetWords 必须是 ${MIN_CONTRACT_TARGET_WORDS}..${MAX_CONTRACT_TARGET_WORDS} 的整数`,
    );
  }
  return value;
}

/**
 * 读取可选写作风格。
 *
 * 只接受 tone / pointOfView / pacing 三个字符串字段，值 trim 后 1..100；
 * 未知字段（例如试图塞 prompt 或 provider）一律 400。
 */
export function optionalStyle(body: Record<string, unknown>): Partial<ChapterStyle> | undefined {
  const value = body['style'];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuthError('VALIDATION_FAILED', '字段 style 必须是对象');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(STYLE_FIELDS as readonly string[]).includes(key)) {
      throw new AuthError('VALIDATION_FAILED', `字段 style.${key} 不可提交`);
    }
  }

  const style: { tone?: string; pointOfView?: string; pacing?: string } = {};
  for (const key of STYLE_FIELDS) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== 'string') {
      throw new AuthError('VALIDATION_FAILED', `字段 style.${key} 必须是字符串`);
    }
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.length > MAX_STYLE_VALUE_LENGTH) {
      throw new AuthError(
        'VALIDATION_FAILED',
        `字段 style.${key} 长度必须在 1..${MAX_STYLE_VALUE_LENGTH}`,
      );
    }
    style[key] = trimmed;
  }
  return style;
}
