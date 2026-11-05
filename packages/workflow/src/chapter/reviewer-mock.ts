/**
 * 章节 Reviewer 专用 MockProvider（A2-C-A）。
 *
 * 默认输出无问题结果；调用方可以注入固定问题，供纯单测验证高 / 中 / 低级别
 * 和全部问题类型。Mock 不联网、不读 Key、不读系统时钟，也不修改通用 MockProvider。
 */

import type { ModelProvider } from '../model-types.js';
import { MockProvider } from '../providers/mock.js';
import type { ChapterReviewIssue, ChapterReviewerOutput } from './reviewer.js';

/** Reviewer Mock 的默认输出。 */
export const CHAPTER_REVIEWER_MOCK_OUTPUT = {
  passed: true,
  issues: [],
} as const satisfies ChapterReviewerOutput;

export interface ChapterReviewerMockOptions {
  /** 固定注入的问题；缺省为空，即 `passed: true`。 */
  readonly issues?: readonly ChapterReviewIssue[];
  /** 固定延迟（毫秒），默认 0。 */
  readonly latencyMs?: number;
}

/** 创建章节 Reviewer 专用 Mock Provider。 */
export function createChapterReviewerMockProvider(
  options: ChapterReviewerMockOptions = {},
): ModelProvider {
  const issues = options.issues ?? [];
  return new MockProvider({
    json: {
      passed: issues.length === 0,
      issues: issues.map((issue) => ({
        severity: issue.severity,
        type: issue.type,
        evidence: issue.evidence,
        suggestion: issue.suggestion,
      })),
    },
    latencyMs: options.latencyMs ?? 0,
  });
}
