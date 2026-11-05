/**
 * 章节摘要专用 MockProvider（A2-D-A）。
 *
 * 默认输出确定、合法、非空；调用方可注入固定 summary 供测试。
 * 不联网、不读 Key、不读系统时钟，也不修改通用 MockProvider。
 */

import type { ModelProvider } from '../model-types.js';
import { MockProvider } from '../providers/mock.js';
import type { ChapterSummarizerOutput } from './summarizer.js';

/** 默认摘要（确定性文本，不依赖章节内容）。 */
export const CHAPTER_SUMMARIZER_MOCK_OUTPUT = {
  summary:
    '本章：主角在雨夜守住山门，击退来袭之敌；修为由炼气突破至筑基，佩剑断裂；' +
    '夜袭的主使身份仍未揭示。',
} as const satisfies ChapterSummarizerOutput;

export interface ChapterSummarizerMockOptions {
  /** 固定注入的摘要；缺省使用 `CHAPTER_SUMMARIZER_MOCK_OUTPUT`。 */
  readonly summary?: string;
}

/** 创建章节摘要专用 Mock Provider。 */
export function createChapterSummarizerMockProvider(
  options: ChapterSummarizerMockOptions = {},
): ModelProvider {
  return new MockProvider({
    json: {
      summary: options.summary ?? CHAPTER_SUMMARIZER_MOCK_OUTPUT.summary,
    },
  });
}
