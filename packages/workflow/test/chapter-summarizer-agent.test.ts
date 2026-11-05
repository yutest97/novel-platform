/**
 * Summarizer Agent 契约（A2-D-A）。
 *
 * 只测输入 / 输出 Schema、代码侧语义校验、专用 Mock 与 AgentRunner 纯内存调用；
 * 不连数据库、不联网、不接工作流。
 */

import { describe, expect, it } from 'vitest';

import {
  AgentInputInvalidError,
  AgentOutputInvalidError,
  AgentRunner,
  assertAgentDefinition,
} from '../src/agent.js';
import { validateJson } from '../src/json-schema.js';
import { MockProvider } from '../src/providers/mock.js';
import {
  CHAPTER_SUMMARIZER_MOCK_OUTPUT,
  createChapterSummarizerMockProvider,
} from '../src/chapter/summarizer-mock.js';
import {
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_CHAPTER_TEXT_CHARS,
  MAX_SUMMARY_NO,
  assertSummarizerInput,
  runChapterSummarizer,
  SUMMARIZER_CHAPTER_AGENT,
  validateSummarizerOutput,
  type ChapterSummarizerInput,
  type ChapterSummarizerOutput,
} from '../src/chapter/summarizer.js';

const CHAPTER_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const CHAPTER_TEXT = '李青握紧断剑。\n他抬头看向雨幕。😀';

const baseInput: ChapterSummarizerInput = {
  chapter: { id: CHAPTER_ID, chapterNo: 12, title: '雨夜破阵' },
  sourceVersion: { id: VERSION_ID, versionNo: 3 },
  chapterText: CHAPTER_TEXT,
};

function expectInvalidOutput(raw: unknown): AgentOutputInvalidError {
  let caught: unknown;
  try {
    validateSummarizerOutput(raw);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentOutputInvalidError);
  expect(caught).toMatchObject({ code: 'AGENT_OUTPUT_INVALID', retryable: false });
  return caught as AgentOutputInvalidError;
}

function inputIssues(input: unknown): number {
  return validateJson(SUMMARIZER_CHAPTER_AGENT.inputSchema, input).length;
}

describe('summarizer.chapter 输入契约', () => {
  it('定义合法，完整输入与合法输出都通过', () => {
    expect(() => assertAgentDefinition(SUMMARIZER_CHAPTER_AGENT)).not.toThrow();
    expect(SUMMARIZER_CHAPTER_AGENT.name).toBe('summarizer.chapter');
    expect(SUMMARIZER_CHAPTER_AGENT.promptVersion).toBe('1.0.0');
    // 模型由 Provider 决定，不硬编码 mock-model
    expect(SUMMARIZER_CHAPTER_AGENT.model).toBe('');
    // 1000 字摘要需要足够的输出预算
    expect(SUMMARIZER_CHAPTER_AGENT.maxOutputTokens).toBeGreaterThanOrEqual(1_024);

    expect(validateJson(SUMMARIZER_CHAPTER_AGENT.inputSchema, baseInput)).toEqual([]);
    expect(() => assertSummarizerInput(baseInput)).not.toThrow();
    expect(validateSummarizerOutput({ summary: '李青守住山门，修为突破。' })).toEqual({
      summary: '李青守住山门，修为突破。',
    });
  });

  it('缺 chapter / sourceVersion / chapterText 时拒绝', () => {
    for (const key of ['chapter', 'sourceVersion', 'chapterText'] as const) {
      const input: Record<string, unknown> = { ...baseInput };
      delete input[key];
      expect(inputIssues(input)).not.toBe(0);
    }
    // 嵌套必填字段缺失同样拒绝
    expect(inputIssues({ ...baseInput, chapter: { id: CHAPTER_ID, chapterNo: 1 } })).not.toBe(0);
    expect(inputIssues({ ...baseInput, sourceVersion: { id: VERSION_ID } })).not.toBe(0);
  });

  it('非 UUID、编号越界、标题空白都被拒绝', () => {
    const inputs: unknown[] = [
      { ...baseInput, chapter: { ...baseInput.chapter, id: 'not-a-uuid' } },
      { ...baseInput, sourceVersion: { ...baseInput.sourceVersion, id: '1234' } },
      { ...baseInput, chapter: { ...baseInput.chapter, chapterNo: 0 } },
      { ...baseInput, chapter: { ...baseInput.chapter, chapterNo: MAX_SUMMARY_NO + 1 } },
      { ...baseInput, chapter: { ...baseInput.chapter, chapterNo: 1.5 } },
      { ...baseInput, sourceVersion: { ...baseInput.sourceVersion, versionNo: 0 } },
      {
        ...baseInput,
        sourceVersion: { ...baseInput.sourceVersion, versionNo: MAX_SUMMARY_NO + 1 },
      },
      // 标题纯空白：Schema 的 minLength 挡不住，必须由代码侧语义校验拒绝
      { ...baseInput, chapter: { ...baseInput.chapter, title: '   ' } },
      { ...baseInput, chapter: { ...baseInput.chapter, title: '\n\t' } },
    ];

    for (const input of inputs) {
      expect(() => assertSummarizerInput(input)).toThrow(AgentInputInvalidError);
    }
    // 纯空白标题在 Schema 层可能通过，但整体仍必须被拒绝（错误只带路径）
    let caught: unknown;
    try {
      assertSummarizerInput(inputs[7]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentInputInvalidError);
    expect((caught as AgentInputInvalidError).issues).toContainEqual({
      path: '$.chapter.title',
      message: 'title 不能为空白',
    });
  });

  it('正文上限 200000 字符，200001 拒绝', () => {
    expect(
      inputIssues({ ...baseInput, chapterText: '文'.repeat(MAX_SUMMARY_CHAPTER_TEXT_CHARS) }),
    ).toBe(0);
    expect(
      inputIssues({ ...baseInput, chapterText: '文'.repeat(MAX_SUMMARY_CHAPTER_TEXT_CHARS + 1) }),
    ).not.toBe(0);
    expect(inputIssues({ ...baseInput, chapterText: '' })).not.toBe(0);
  });

  it('顶层与嵌套的未知字段都被拒绝', () => {
    const inputs: unknown[] = [
      { ...baseInput, prompt: '不允许进入 Summarizer' },
      { ...baseInput, contract: { goal: '不属于摘要契约' } },
      { ...baseInput, chapter: { ...baseInput.chapter, workId: CHAPTER_ID } },
      { ...baseInput, sourceVersion: { ...baseInput.sourceVersion, content: '不允许' } },
    ];

    for (const input of inputs) {
      expect(inputIssues(input)).not.toBe(0);
    }
  });

  it('prompt / secret / secretKnownBy / 模型原始响应字段都被拒绝', () => {
    const inputs: unknown[] = [
      { ...baseInput, secret: '真实身世' },
      { ...baseInput, secretKnownBy: [CHAPTER_ID] },
      { ...baseInput, rawModelResponse: { text: '不允许' } },
      { ...baseInput, apiKey: 'sk-not-allowed' },
      { ...baseInput, chapter: { ...baseInput.chapter, secret: '藏起来的设定' } },
      { ...baseInput, sourceVersion: { ...baseInput.sourceVersion, prompt: '不允许' } },
    ];

    for (const input of inputs) {
      expect(inputIssues(input)).not.toBe(0);
    }
  });
});

describe('摘要输出 Schema 与语义校验', () => {
  it('拒绝空白、纯换行与超长摘要', () => {
    expectInvalidOutput({ summary: '' });
    expectInvalidOutput({ summary: '   ' });
    expectInvalidOutput({ summary: '\n\t\n' });
    expectInvalidOutput({ summary: '摘'.repeat(MAX_SUMMARY_CHARS + 1) });
  });

  it('恰好 1000 字符的摘要可接受', () => {
    const summary = '摘'.repeat(MAX_SUMMARY_CHARS);
    expect(validateSummarizerOutput({ summary }).summary).toHaveLength(MAX_SUMMARY_CHARS);
  });

  it('保留中文、emoji 与换行，并去掉首尾空白', () => {
    const summary = '  第一段：守住山门。\n第二段：断剑折断。😀  ';
    const result = validateSummarizerOutput({ summary });
    expect(result.summary).toBe('第一段：守住山门。\n第二段：断剑折断。😀');
    expect(result.summary).toContain('\n');
    expect(result.summary).toContain('😀');
  });

  it('拒绝 Markdown 标题与代码块', () => {
    expectInvalidOutput({ summary: '# 第十二章\n李青守住山门。' });
    expectInvalidOutput({ summary: '李青守住山门。\n```json\n{}\n```' });
    // 正文中的 # 不在行首时不算结构标题
    expect(validateSummarizerOutput({ summary: '他以第#3号阵位迎敌。' }).summary).toBe(
      '他以第#3号阵位迎敌。',
    );
  });

  it('拒绝输出中的未知字段', () => {
    expectInvalidOutput({ summary: '守住山门。', passed: true });
    expectInvalidOutput({ summary: '守住山门。', issues: [] });
    expectInvalidOutput({ events: ['守住山门'] });
  });

  it('非法输出统一为 AGENT_OUTPUT_INVALID，且不回显正文或摘要内容', () => {
    const secretSummary = `内部字段：${CHAPTER_TEXT}`;
    const error = expectInvalidOutput({ summary: secretSummary, debug: true });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(CHAPTER_TEXT);
    expect(serialized).not.toContain('内部字段');
    expect(error.code).toBe('AGENT_OUTPUT_INVALID');
    // 只带路径与固定原因
    expect(error.issues.every((issue) => issue.path.startsWith('$'))).toBe(true);
  });
});

describe('摘要专用 Mock 与 AgentRunner', () => {
  it('默认 Mock 输出合法、名称与模型正确，且未修改通用 MockProvider', async () => {
    const provider = createChapterSummarizerMockProvider();
    expect(provider.name).toBe('mock');
    expect(provider.defaultModel).toBe('mock-model');

    const result = await new AgentRunner(provider).run<ChapterSummarizerOutput>(
      SUMMARIZER_CHAPTER_AGENT,
      baseInput,
    );
    expect(result.output).toEqual(CHAPTER_SUMMARIZER_MOCK_OUTPUT);
    expect(result.output.summary.trim()).not.toBe('');
    expect(result.output.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(result.agentName).toBe('summarizer.chapter');
    expect(new MockProvider().defaultModel).toBe('mock-model');
  });

  it('构造参数可注入固定 summary', async () => {
    const summary = '注入摘要：主角守住山门。';
    const result = await new AgentRunner(
      createChapterSummarizerMockProvider({ summary }),
    ).run<ChapterSummarizerOutput>(SUMMARIZER_CHAPTER_AGENT, baseInput);
    expect(result.output).toEqual({ summary });
  });

  it('通过 AgentRunner 与 fake Provider 完成一次调用，并强制执行语义校验', async () => {
    let calls = 0;
    let seenModel = '';
    const runner = new AgentRunner(
      new MockProvider({
        json: (input) => {
          calls += 1;
          seenModel = input.model;
          return { summary: '李青守住山门，修为突破筑基。' };
        },
      }),
    );

    const result = await runChapterSummarizer(runner, baseInput);
    expect(calls).toBe(1);
    // model 为空 → 由 Provider 默认模型决定
    expect(seenModel).toBe('mock-model');
    expect(result.output).toEqual({ summary: '李青守住山门，修为突破筑基。' });
    expect(result.provider).toBe('mock');
  });

  it('Provider 返回空白摘要时被语义校验拦下', async () => {
    const runner = new AgentRunner(new MockProvider({ json: () => ({ summary: '  \n ' }) }));
    await expect(runChapterSummarizer(runner, baseInput)).rejects.toMatchObject({
      code: 'AGENT_OUTPUT_INVALID',
    });
  });

  it('输入不合法时不会调用 Provider', async () => {
    let calls = 0;
    const runner = new AgentRunner(
      new MockProvider({
        json: () => {
          calls += 1;
          return { summary: '不应被调用' };
        },
      }),
    );

    await expect(
      runChapterSummarizer(runner, {
        ...baseInput,
        chapter: { ...baseInput.chapter, id: 'not-a-uuid' },
      }),
    ).rejects.toMatchObject({ code: 'AGENT_INPUT_INVALID' });
    expect(calls).toBe(0);
  });
});
