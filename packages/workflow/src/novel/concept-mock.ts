/**
 * Concept Agent 专用 MockProvider（C1-B-A1）。
 *
 * 默认输出一份完整、非空、确定性的故事候选；不联网、不读 Key、不读系统时钟，
 * 也不复制作者原文到输出。调用方可以注入固定延迟以验证并发 / fence 行为。
 */

import type { ModelProvider } from '../model-types.js';
import { MockProvider } from '../providers/mock.js';
import type { NovelConceptOutput } from './concept-agent.js';

/** Concept Mock 的默认输出。 */
export const NOVEL_CONCEPT_MOCK_OUTPUT = {
  titleSuggestions: ['归墟来信', '长夜守灯人', '无名碑'],
  logline: '一封来自归墟的迟到信件，把守灯人拖进一场跨越百年的旧案。',
  coreConflict: '守灯人必须公开真相，却会让唯一信任他的人失去一切。',
  targetAudience: '偏好悬疑与情感张力的中文长篇读者',
  tone: '冷峻、克制，在关键处转向温暖',
  sellingPoints: [
    '悬疑主线与人物关系互相推动',
    '每一封信都对应一段可验证的旧事',
    '主角必须在真相与承诺之间做选择',
    '配角有自己的目标，不只是工具人',
  ],
  themes: ['记忆与责任', '真相的代价', '普通人的坚持'],
  storyPromise: '每次揭开一层旧事，都会让读者更在意主角最终保住什么。',
  openQuestions: ['主角愿意为真相付出多大代价？', '归墟的信件究竟由谁寄出？'],
} as const satisfies NovelConceptOutput;

export interface NovelConceptMockOptions {
  /** 固定延迟（毫秒），默认 0。 */
  readonly latencyMs?: number;
}

/** 创建 Concept Agent 专用 Mock Provider。 */
export function createNovelConceptMockProvider(
  options: NovelConceptMockOptions = {},
): ModelProvider {
  return new MockProvider({
    json: NOVEL_CONCEPT_MOCK_OUTPUT,
    latencyMs: options.latencyMs ?? 0,
  });
}
