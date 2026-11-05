/**
 * Reviewer Agent 契约（A2-C-A）。
 *
 * 只测 Schema、语义校验、专用 Mock 和 AgentRunner 纯内存调用；
 * 不连数据库、不联网、不接 `chapter.draft` 工作流。
 */

import { describe, expect, it } from 'vitest';

import { AgentOutputInvalidError, AgentRunner, assertAgentDefinition } from '../src/agent.js';
import { MockProvider } from '../src/providers/mock.js';
import { validateJson } from '../src/json-schema.js';
import {
  CHAPTER_REVIEW_ISSUE_TYPES,
  CHAPTER_REVIEW_SEVERITIES,
  MAX_REVIEW_DRAFT_CHARS,
  MAX_REVIEW_ENTITIES_PER_TYPE,
  MAX_REVIEW_PRIOR_SUMMARIES,
  MAX_REVIEW_PRIOR_SUMMARY_CHARS,
  REVIEWER_CHAPTER_AGENT,
  runChapterReviewer,
  validateReviewerOutput,
  type ChapterReviewIssue,
  type ChapterReviewerInput,
  type ChapterReviewerOutput,
} from '../src/chapter/reviewer.js';
import { createChapterReviewerMockProvider } from '../src/chapter/reviewer-mock.js';

const CHAPTER_ID = '11111111-1111-4111-8111-111111111111';
const CHARACTER_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';
const REALM_ID = '44444444-4444-4444-8444-444444444444';
const FACTION_ID = '55555555-5555-4555-8555-555555555555';
const EVIDENCE = '李青握紧断剑。';

const baseInput: ChapterReviewerInput = {
  chapter: {
    id: CHAPTER_ID,
    chapterNo: 12,
    title: '雨夜破阵',
  },
  contract: {
    goal: '李青在雨夜守住山门。',
    mustInclude: ['守住山门'],
    mustNotInclude: ['李青死亡'],
    scenes: [
      {
        purpose: '正面迎敌',
        location: '山门',
        conflict: '守军溃散',
        outcome: '李青独自补位',
      },
    ],
  },
  draft: `${EVIDENCE}\n他抬头看向雨幕。😀`,
  characters: [{ id: CHARACTER_ID, name: '李青', summary: '外门弟子，谨慎坚毅。' }],
  items: [{ id: ITEM_ID, name: '断剑', summary: '剑身有缺口，仍可使用。' }],
  realms: [{ id: REALM_ID, name: '炼气九层', summary: '当前公开修为。' }],
  factions: [{ id: FACTION_ID, name: '青岳宗', summary: '李青所属宗门。' }],
  priorSummaries: [{ chapterNo: 11, summary: '李青察觉有人夜袭山门。' }],
};

function makeIssue(overrides: Partial<ChapterReviewIssue> = {}): ChapterReviewIssue {
  return {
    severity: 'medium',
    type: 'prose_quality',
    evidence: EVIDENCE,
    suggestion: '补充动作前后的因果。',
    ...overrides,
  };
}

function outputWith(issues: readonly ChapterReviewIssue[] = []): ChapterReviewerOutput {
  return { passed: issues.length === 0, issues };
}

function expectInvalidOutput(raw: unknown, draft = baseInput.draft): AgentOutputInvalidError {
  let caught: unknown;
  try {
    validateReviewerOutput(raw, { draft });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentOutputInvalidError);
  expect(caught).toMatchObject({
    code: 'AGENT_OUTPUT_INVALID',
    retryable: false,
  });
  return caught as AgentOutputInvalidError;
}

describe('reviewer.chapter Agent 输入契约', () => {
  it('定义合法，完整输入通过严格 Schema，无问题输出合法', () => {
    expect(() => assertAgentDefinition(REVIEWER_CHAPTER_AGENT)).not.toThrow();
    expect(REVIEWER_CHAPTER_AGENT.name).toBe('reviewer.chapter');
    expect(REVIEWER_CHAPTER_AGENT.promptVersion).toBe('1.0.0');
    expect(validateJson(REVIEWER_CHAPTER_AGENT.inputSchema, baseInput)).toEqual([]);
    expect(validateReviewerOutput(outputWith(), { draft: baseInput.draft })).toEqual({
      passed: true,
      issues: [],
    });
  });

  it('缺章节、合同或 draft 时拒绝输入', () => {
    for (const key of ['chapter', 'contract', 'draft'] as const) {
      const input: Record<string, unknown> = { ...baseInput };
      delete input[key];
      expect(validateJson(REVIEWER_CHAPTER_AGENT.inputSchema, input)).not.toEqual([]);
    }
  });

  it('顶层与实体中的 secret / prompt / 原始响应字段都被拒绝', () => {
    const inputs: unknown[] = [
      { ...baseInput, prompt: '不允许进入 Reviewer' },
      { ...baseInput, rawModelResponse: { text: '不允许' } },
      {
        ...baseInput,
        characters: [
          {
            id: CHARACTER_ID,
            name: '李青',
            summary: '外门弟子。',
            secret: '真实身世',
          },
        ],
      },
      {
        ...baseInput,
        items: [
          {
            id: ITEM_ID,
            name: '断剑',
            summary: '剑身有缺口。',
            secretKnownBy: [CHARACTER_ID],
          },
        ],
      },
    ];

    for (const input of inputs) {
      expect(validateJson(REVIEWER_CHAPTER_AGENT.inputSchema, input)).not.toEqual([]);
    }
  });

  it('正文、每类实体和前章摘要遵守上限，实体 id 必须是 uuid', () => {
    const entity = { id: CHARACTER_ID, name: '李青', summary: '安全摘要' };
    const inputs: unknown[] = [
      { ...baseInput, draft: '字'.repeat(MAX_REVIEW_DRAFT_CHARS + 1) },
      {
        ...baseInput,
        characters: Array.from({ length: MAX_REVIEW_ENTITIES_PER_TYPE + 1 }, () => entity),
      },
      {
        ...baseInput,
        priorSummaries: Array.from({ length: MAX_REVIEW_PRIOR_SUMMARIES + 1 }, (_, index) => ({
          chapterNo: index + 1,
          summary: '摘要',
        })),
      },
      {
        ...baseInput,
        priorSummaries: [
          {
            chapterNo: 1,
            summary: '摘'.repeat(MAX_REVIEW_PRIOR_SUMMARY_CHARS + 1),
          },
        ],
      },
      {
        ...baseInput,
        chapter: { ...baseInput.chapter, id: 'not-a-uuid' },
      },
    ];

    for (const input of inputs) {
      expect(validateJson(REVIEWER_CHAPTER_AGENT.inputSchema, input)).not.toEqual([]);
    }
  });
});

describe('Reviewer 输出 Schema 与语义校验', () => {
  it('接受 high / medium / low 三种级别', () => {
    for (const severity of CHAPTER_REVIEW_SEVERITIES) {
      const result = validateReviewerOutput(outputWith([makeIssue({ severity })]), {
        draft: baseInput.draft,
      });
      expect(result.issues[0]?.severity).toBe(severity);
    }
  });

  it('接受七种问题类型', () => {
    for (const type of CHAPTER_REVIEW_ISSUE_TYPES) {
      const result = validateReviewerOutput(outputWith([makeIssue({ type })]), {
        draft: baseInput.draft,
      });
      expect(result.issues[0]?.type).toBe(type);
    }
  });

  it('拒绝未知 severity / type', () => {
    const invalidOutputs: unknown[] = [
      {
        passed: false,
        issues: [{ ...makeIssue(), severity: 'critical' }],
      },
      {
        passed: false,
        issues: [{ ...makeIssue(), type: 'unknown_issue' }],
      },
    ];

    for (const output of invalidOutputs) {
      expectInvalidOutput(output);
    }
  });

  it('拒绝顶层与问题项的未知字段', () => {
    const outputs: unknown[] = [
      { ...outputWith(), debug: true },
      {
        ...outputWith([makeIssue()]),
        issues: [{ ...makeIssue(), reason: '不允许的额外诊断字段' }],
      },
    ];

    for (const output of outputs) {
      expectInvalidOutput(output);
    }
  });

  it('拒绝空或纯空白 evidence / suggestion', () => {
    expectInvalidOutput(outputWith([makeIssue({ evidence: '   ' })]));
    expectInvalidOutput(outputWith([makeIssue({ suggestion: '\n\t' })]));
  });

  it('拒绝不是 draft 连续子串的 evidence，且错误不回显正文', () => {
    const error = expectInvalidOutput(outputWith([makeIssue({ evidence: '冯七砍断山门。' })]));
    expect(JSON.stringify(error)).not.toContain(EVIDENCE);
    expect(JSON.stringify(error)).not.toContain(baseInput.draft);
  });

  it('拒绝 passed 与 issues 数量矛盾', () => {
    expectInvalidOutput({ passed: true, issues: [makeIssue()] });
    expectInvalidOutput({ passed: false, issues: [] });
  });

  it('拒绝超过 20 条问题', () => {
    const issues = Array.from({ length: 21 }, (_, index) =>
      makeIssue({
        evidence: `${EVIDENCE}${index}`,
        suggestion: `建议 ${index}`,
      }),
    );
    expectInvalidOutput({ passed: false, issues });
  });

  it('拒绝超长 evidence / suggestion', () => {
    expectInvalidOutput(outputWith([makeIssue({ evidence: '引'.repeat(301) })]));
    expectInvalidOutput(outputWith([makeIssue({ suggestion: '改'.repeat(501) })]));
  });

  it('重复的 type + evidence 明确拒绝', () => {
    expectInvalidOutput(
      outputWith([
        makeIssue(),
        makeIssue({
          evidence: ` ${EVIDENCE} `,
          suggestion: '另一条建议',
        }),
      ]),
    );
  });

  it('正确保留中文、emoji 和换行 evidence', () => {
    const evidence = '断剑。\n他抬头看向雨幕。😀';
    const result = validateReviewerOutput(outputWith([makeIssue({ evidence })]), {
      draft: baseInput.draft,
    });
    expect(result.issues[0]?.evidence).toBe(evidence);
  });
});

describe('Reviewer 专用 Mock 与 AgentRunner', () => {
  it('默认 Mock 输出 passed=true 且不修改通用 MockProvider', async () => {
    const provider = createChapterReviewerMockProvider();
    expect(provider.name).toBe('mock');
    expect(provider.defaultModel).toBe('mock-model');

    const result = await new AgentRunner(provider).run<ChapterReviewerOutput>(
      REVIEWER_CHAPTER_AGENT,
      baseInput,
    );
    expect(result.output).toEqual({ passed: true, issues: [] });
    expect(new MockProvider().defaultModel).toBe('mock-model');
  });

  it('构造参数可以注入固定问题结果', async () => {
    const issue = makeIssue({ severity: 'high', type: 'contract_violation' });
    const result = await new AgentRunner(
      createChapterReviewerMockProvider({ issues: [issue] }),
    ).run(REVIEWER_CHAPTER_AGENT, baseInput);
    expect(result.output).toEqual({ passed: false, issues: [issue] });
  });

  it('通过 AgentRunner 和 fake Provider 完成一次调用，并强制执行语义校验', async () => {
    let calls = 0;
    const runner = new AgentRunner(
      new MockProvider({
        json: () => {
          calls += 1;
          return { passed: true, issues: [] };
        },
      }),
    );

    const result = await runChapterReviewer(runner, baseInput);
    expect(calls).toBe(1);
    expect(result.provider).toBe('mock');
    expect(result.agentName).toBe('reviewer.chapter');
    expect(result.output).toEqual(outputWith());
  });
});
