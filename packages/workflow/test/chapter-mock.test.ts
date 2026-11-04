/**
 * 章节专用 MockProvider（A1-4A）。
 *
 * 目标：`MODEL_PROVIDER=mock` 的 Worker 也能跑完整 chapter.draft，
 * 输出必须通过真实的 Schema + 语义校验。
 */

import { describe, expect, it } from 'vitest';

import { MOCK_CHAPTER_DRAFT, createChapterMockProvider } from '../src/chapter/mock.js';
import { normalizePlannerOutput, prepareDraftText } from '../src/chapter/agents.js';
import type { PlannerOutput } from '../src/chapter/types.js';

function plannerInput(characters: string[], targetWords = 3000) {
  return {
    model: 'mock-model',
    messages: [
      { role: 'system' as const, content: 'agent:planner.chapter@1.0.0 planner.chapter' },
      {
        role: 'user' as const,
        content: JSON.stringify({
          chapter: { chapterNo: 1, title: '初入青云', targetWords },
          style: { tone: '克制', pointOfView: '第三人称限知', pacing: '中速' },
          workDirection: {},
          characters: characters.map((name, index) => ({
            id: `char-${String(index)}`,
            name,
            summary: '外门弟子',
          })),
          realms: [],
          factions: [],
        }),
      },
    ],
    maxOutputTokens: 2000,
  };
}

describe('createChapterMockProvider', () => {
  it('身份保持 mock / mock-model（与任务记录一致）', () => {
    const provider = createChapterMockProvider();
    expect(provider.name).toBe('mock');
    expect(provider.defaultModel).toBe('mock-model');
  });

  it('Planner 输出通过 normalizePlannerOutput（人物来自上下文、字数不变）', async () => {
    const provider = createChapterMockProvider();
    const result = await provider.generateJson(plannerInput(['沈砚', '赵四'], 3200));
    const plan = normalizePlannerOutput(result.json as PlannerOutput, {
      allowedCharacters: ['沈砚', '赵四'],
      targetWords: 3200,
    });

    expect(plan.goal).toContain('初入青云');
    expect(plan.characters).toEqual(['沈砚', '赵四']);
    expect(plan.targetWords).toBe(3200);
    expect(plan.scenes).toHaveLength(1);
    expect(plan.scenes[0]?.location).toBe('演武场');
  });

  it('Planner 在无人物上下文时输出空人物列表（仍合法）', async () => {
    const provider = createChapterMockProvider();
    const result = await provider.generateJson(plannerInput([]));
    const plan = normalizePlannerOutput(result.json as PlannerOutput, {
      allowedCharacters: [],
      targetWords: 3000,
    });
    expect(plan.characters).toEqual([]);
  });

  it('Writer 输出 ≥1200 字且通过 prepareDraftText', async () => {
    const provider = createChapterMockProvider();
    const result = await provider.generateJson({
      model: 'mock-model',
      messages: [
        { role: 'system', content: 'agent:writer.chapter@1.0.0' },
        { role: 'user', content: '{"contract":{"targetWords":3000}}' },
      ],
      maxOutputTokens: 4000,
    });
    expect(result.json).toEqual({ text: MOCK_CHAPTER_DRAFT });
    const draft = prepareDraftText((result.json as { text: string }).text);
    expect(draft.wordCount).toBeGreaterThanOrEqual(1200);
  });
});
