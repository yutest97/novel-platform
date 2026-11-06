import { describe, expect, it } from 'vitest';

import { AgentRunner } from '../src/agent.js';
import { validateJson } from '../src/json-schema.js';
import {
  NOVEL_COORDINATOR_AGENT,
  NOVEL_COORDINATOR_INPUT_SCHEMA,
  NOVEL_COORDINATOR_OUTPUT_SCHEMA,
  validateNovelCoordinatorAction,
  type NovelCoordinatorAction,
  type NovelCoordinatorInput,
} from '../src/novel/coordinator-agent.js';
import { createNovelCoordinatorMockProvider } from '../src/novel/coordinator-mock-provider.js';
import { NOVEL_TOOL_WORKFLOWS, getNovelToolWorkflow } from '../src/novel/tool-workflows.js';
import { INITIAL_NOVEL_STATE_SUMMARY } from '../src/novel/types.js';

const BASE_INPUT: NovelCoordinatorInput = {
  requestText: '写一个东方玄幻故事',
  latestAnswer: null,
  stateSummary: INITIAL_NOVEL_STATE_SUMMARY,
  allowedTools: ['ask_user', 'finish'],
  remainingSteps: 20,
};

const ASK_ACTION: NovelCoordinatorAction = {
  action: 'ask_user',
  objective: '确定题材',
  input: {
    question: '你想写哪一种题材的小说？',
    options: ['东方玄幻', '都市异能'],
    finishReason: null,
  },
  decisionSummary: '先确认题材。',
};

const FINISH_ACTION: NovelCoordinatorAction = {
  action: 'finish',
  objective: '结束问答',
  input: {
    question: null,
    options: [],
    finishReason: '关键设定已确认',
  },
  decisionSummary: '作者确认可以结束。',
};

describe('Coordinator 输入 / 输出契约', () => {
  it('输入 Schema 接受协议字段并拒绝未知字段', () => {
    expect(validateJson(NOVEL_COORDINATOR_INPUT_SCHEMA, BASE_INPUT)).toEqual([]);
    const withExtra = { ...BASE_INPUT, provider: 'openai' };
    expect(validateJson(NOVEL_COORDINATOR_INPUT_SCHEMA, withExtra).length).toBeGreaterThan(0);
  });

  it('输出 Schema 接受 ask；finishReason 的交叉约束由语义校验负责', () => {
    expect(validateJson(NOVEL_COORDINATOR_OUTPUT_SCHEMA, ASK_ACTION)).toEqual([]);
    const bad = {
      ...ASK_ACTION,
      input: { ...ASK_ACTION.input, finishReason: '结束' },
    };
    // Schema 允许 string | null（两种 action 共用一份结构），语义层必须拒绝。
    expect(validateJson(NOVEL_COORDINATOR_OUTPUT_SCHEMA, bad)).toEqual([]);
    expect(validateNovelCoordinatorAction(bad).ok).toBe(false);
  });

  it('输出 Schema 接受 finish；question 的交叉约束由语义校验负责', () => {
    expect(validateJson(NOVEL_COORDINATOR_OUTPUT_SCHEMA, FINISH_ACTION)).toEqual([]);
    const bad = {
      ...FINISH_ACTION,
      input: { ...FINISH_ACTION.input, question: '还有什么补充？' },
    };
    expect(validateJson(NOVEL_COORDINATOR_OUTPUT_SCHEMA, bad)).toEqual([]);
    expect(validateNovelCoordinatorAction(bad).ok).toBe(false);
  });

  it('输出 Schema 只允许 ask_user / finish', () => {
    const bad = { ...ASK_ACTION, action: 'generate_world' } as unknown;
    expect(validateJson(NOVEL_COORDINATOR_OUTPUT_SCHEMA, bad).length).toBeGreaterThan(0);
  });

  it('语义校验：ask 必须有非空问题与非空选项，选项不得重复', () => {
    expect(validateNovelCoordinatorAction(ASK_ACTION).ok).toBe(true);

    const emptyQuestion = {
      ...ASK_ACTION,
      input: { ...ASK_ACTION.input, question: '   ' },
    };
    expect(validateNovelCoordinatorAction(emptyQuestion).ok).toBe(false);

    const emptyOptions = {
      ...ASK_ACTION,
      input: { ...ASK_ACTION.input, options: [] },
    };
    expect(validateNovelCoordinatorAction(emptyOptions).ok).toBe(false);

    const duplicateOptions = {
      ...ASK_ACTION,
      input: { ...ASK_ACTION.input, options: ['玄幻', '玄幻'] },
    };
    expect(validateNovelCoordinatorAction(duplicateOptions).ok).toBe(false);
  });

  it('语义校验：finish 不得带问题或选项', () => {
    expect(validateNovelCoordinatorAction(FINISH_ACTION).ok).toBe(true);
    const withOptions = {
      ...FINISH_ACTION,
      input: { ...FINISH_ACTION.input, options: ['继续'] },
    };
    expect(validateNovelCoordinatorAction(withOptions).ok).toBe(false);
    const withQuestion = {
      ...FINISH_ACTION,
      input: { ...FINISH_ACTION.input, question: '再补一点？' },
    };
    expect(validateNovelCoordinatorAction(withQuestion).ok).toBe(false);
  });

  it('语义校验：问题文本拒绝 SQL / Prisma / 文件路径 / shell / HTML', () => {
    const samples = [
      '请执行 SELECT * FROM novel_runs',
      '调用 prisma.novelRun.findMany 看看',
      '读取 E:\\小说开发\\packages\\db\\schema.prisma',
      '运行 rm -rf / 清理一下',
      '把 <script>alert(1)</script> 放进正文',
    ];
    for (const question of samples) {
      const action = {
        ...ASK_ACTION,
        input: { ...ASK_ACTION.input, question },
      };
      expect(validateNovelCoordinatorAction(action).ok).toBe(false);
    }
  });
});

describe('工具工作流注册表', () => {
  it('只注册 ask_user 与 finish，且从 running 进入', () => {
    expect(Object.keys(NOVEL_TOOL_WORKFLOWS).sort()).toEqual(['ask_user', 'finish']);
    for (const workflow of Object.values(NOVEL_TOOL_WORKFLOWS)) {
      expect(workflow.allowedFromStatus).toEqual(['running']);
      expect(workflow.sideEffect).toBe('read_only');
      expect(workflow.maxAttempts).toBe(1);
      expect(workflow.timeoutMs).toBeGreaterThan(0);
    }
    expect(NOVEL_TOOL_WORKFLOWS.ask_user.successTransition).toBe('waiting_user');
    expect(NOVEL_TOOL_WORKFLOWS.finish.successTransition).toBe('completed');
  });

  it('未知工具返回 null，不抛错', () => {
    expect(getNovelToolWorkflow('generate_world')).toBeNull();
    expect(getNovelToolWorkflow('ask_user')).toBe(NOVEL_TOOL_WORKFLOWS.ask_user);
  });

  it('ask_user 执行结果只产出问题与收敛事实，不写创作资料', () => {
    const result = NOVEL_TOOL_WORKFLOWS.ask_user.execute({
      action: ASK_ACTION,
      summary: { ...INITIAL_NOVEL_STATE_SUMMARY, latestAnswer: '我想写玄幻' },
      stepNo: 1,
      signature: 'sig-1',
      repeatCount: 0,
    });
    expect(result.status).toBe('waiting_user');
    expect(result.outputSummary).toEqual({
      kind: 'question',
      question: ASK_ACTION.input.question,
      options: ASK_ACTION.input.options,
    });
    expect(result.stateSummary.knownFacts).toEqual(['我想写玄幻']);
    expect(result.stateSummary.openQuestions).toEqual([ASK_ACTION.input.question]);
    expect(result.stateSummary.latestAnswer).toBeNull();
    expect(result.stateSummary.lastStepNo).toBe(1);
  });

  it('finish 执行结果为 completed，且不保留待答问题', () => {
    const result = NOVEL_TOOL_WORKFLOWS.finish.execute({
      action: FINISH_ACTION,
      summary: { ...INITIAL_NOVEL_STATE_SUMMARY, openQuestions: ['旧问题'] },
      stepNo: 2,
      signature: 'sig-2',
      repeatCount: 0,
    });
    expect(result.status).toBe('completed');
    expect(result.stateSummary.openQuestions).toEqual([]);
    expect(result.outputSummary).toEqual({
      kind: 'finish',
      finishReason: FINISH_ACTION.input.finishReason,
    });
  });
});

describe('Coordinator Mock Provider（无网络、确定性）', () => {
  const runner = new AgentRunner(createNovelCoordinatorMockProvider());

  it('第一轮返回一个带选项的问题', async () => {
    const result = await runner.run<Record<string, unknown>>(NOVEL_COORDINATOR_AGENT, BASE_INPUT);
    expect(result.output['action']).toBe('ask_user');
    const input = result.output['input'] as Record<string, unknown>;
    expect(typeof input['question']).toBe('string');
    expect((input['options'] as readonly string[]).length).toBeGreaterThan(0);
    expect(input['finishReason']).toBeNull();
  });

  it('已有回答时继续追问不同问题', async () => {
    const first = await runner.run<Record<string, unknown>>(NOVEL_COORDINATOR_AGENT, {
      ...BASE_INPUT,
      stateSummary: { ...INITIAL_NOVEL_STATE_SUMMARY, knownFacts: ['东方玄幻'] },
    });
    const second = await runner.run<Record<string, unknown>>(NOVEL_COORDINATOR_AGENT, {
      ...BASE_INPUT,
      latestAnswer: '少年被灭门后复仇',
      stateSummary: { ...INITIAL_NOVEL_STATE_SUMMARY, knownFacts: ['东方玄幻'] },
    });
    const firstQuestion = (first.output['input'] as Record<string, unknown>)['question'];
    const secondQuestion = (second.output['input'] as Record<string, unknown>)['question'];
    expect(firstQuestion).not.toBe(secondQuestion);
  });

  it('明确结束口令返回 finish，且 question 为 null', async () => {
    const result = await runner.run<Record<string, unknown>>(NOVEL_COORDINATOR_AGENT, {
      ...BASE_INPUT,
      latestAnswer: '先到这里',
    });
    expect(result.output['action']).toBe('finish');
    const input = result.output['input'] as Record<string, unknown>;
    expect(input['question']).toBeNull();
    expect(typeof input['finishReason']).toBe('string');
  });

  it('Mock 输出本身通过严格 Schema 与语义校验', async () => {
    for (const latestAnswer of [null, '东方玄幻', '先到这里']) {
      const result = await runner.run<Record<string, unknown>>(NOVEL_COORDINATOR_AGENT, {
        ...BASE_INPUT,
        latestAnswer,
      });
      expect(validateNovelCoordinatorAction(result.output).ok).toBe(true);
    }
  });
});
