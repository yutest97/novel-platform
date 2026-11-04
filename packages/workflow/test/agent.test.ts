/**
 * Agent 运行基础设施（A1-1）。
 *
 * 证明：定义校验、输入/输出严格 Schema、注册与版本、确定性测试 Agent 可运行。
 * 这些用例不连数据库、不联网。
 */

import { describe, expect, it } from 'vitest';

import {
  AgentInputInvalidError,
  AgentOutputInvalidError,
  AgentRegistry,
  AgentRunner,
  DETERMINISTIC_TEST_AGENT,
  assertAgentDefinition,
  type AgentDefinition,
} from '../src/agent.js';
import { WorkflowError } from '../src/errors.js';
import type { JsonSchema } from '../src/json-schema.js';
import { ModelProviderError } from '../src/model-types.js';
import { MockProvider } from '../src/providers/mock.js';

const baseAgent: AgentDefinition = {
  name: 'test.summary',
  promptVersion: '1.2.0',
  model: 'mock-model',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1, maxLength: 50 } },
    required: ['text'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { title: { type: 'string', minLength: 1 } },
    required: ['title'],
    additionalProperties: false,
  },
  maxOutputTokens: 128,
  rolePrompt: '你负责起标题。',
};

describe('模型解析', () => {
  it('agent.model 为空时回落 provider.defaultModel；显式值优先', async () => {
    const provider = new MockProvider({ model: 'provider-default', json: { title: '标题' } });
    const runner = new AgentRunner(provider);

    expect(runner.resolveModel({ ...baseAgent, model: '' })).toBe('provider-default');
    expect(runner.resolveModel(baseAgent)).toBe('mock-model');

    const result = await runner.run({ ...baseAgent, model: '' }, { text: '你好' });
    expect(result.model).toBe('provider-default');
  });
});

describe('AgentDefinition', () => {
  it('合法定义通过校验', () => {
    expect(() => assertAgentDefinition(baseAgent)).not.toThrow();
    expect(() => assertAgentDefinition(DETERMINISTIC_TEST_AGENT)).not.toThrow();
  });

  const invalidDefinitions: [string, AgentDefinition][] = [
    ['name 大写', { ...baseAgent, name: 'Test.Summary' }],
    ['promptVersion 为空', { ...baseAgent, promptVersion: '' }],
    ['maxOutputTokens 为 0', { ...baseAgent, maxOutputTokens: 0 }],
    ['maxOutputTokens 过大', { ...baseAgent, maxOutputTokens: 99999 }],
    ['rolePrompt 为空', { ...baseAgent, rolePrompt: '   ' }],
    [
      'inputSchema 非法',
      { ...baseAgent, inputSchema: { type: 'object', oneOf: [] } as unknown as JsonSchema },
    ],
  ];

  it.each(invalidDefinitions)('拒绝非法定义：%s', (_label, agent) => {
    expect(() => assertAgentDefinition(agent)).toThrow(WorkflowError);
  });
});

describe('AgentRegistry', () => {
  it('按 name@version 注册与读取', () => {
    const registry = new AgentRegistry();
    registry.register(baseAgent);
    expect(registry.list()).toEqual(['test.summary@1.2.0']);
    expect(registry.get('test.summary', '1.2.0').promptVersion).toBe('1.2.0');
  });

  it('同 name 多版本：不指定版本时要求显式', () => {
    const registry = new AgentRegistry();
    registry.register(baseAgent);
    registry.register({ ...baseAgent, promptVersion: '2.0.0' });
    expect(() => registry.get('test.summary')).toThrow(/多个版本/);
    expect(registry.get('test.summary', '2.0.0').promptVersion).toBe('2.0.0');
  });

  it('重复注册同一版本直接报错（不静默覆盖）', () => {
    const registry = new AgentRegistry();
    registry.register(baseAgent);
    expect(() => registry.register(baseAgent)).toThrow(/已注册/);
  });
});

describe('AgentRunner', () => {
  it('确定性测试 Agent：注册 → 输入校验 → Provider → 输出校验', async () => {
    const registry = new AgentRegistry();
    registry.register(DETERMINISTIC_TEST_AGENT);
    const runner = new AgentRunner(new MockProvider({ json: { answer: '你好' } }));

    const result = await runner.run<{ answer: string }>(DETERMINISTIC_TEST_AGENT, {
      question: '你好',
    });

    expect(result.output).toEqual({ answer: '你好' });
    expect(result.agentName).toBe('test.echo');
    expect(result.promptVersion).toBe('1.0.0');
    expect(result.provider).toBe('mock');
    expect(result.model).toBe('mock-model');
    expect(result.usage.promptTokens).toBeGreaterThan(0);
  });

  it('输入不合法：不调用 Provider，错误只含路径', async () => {
    let called = false;
    const runner = new AgentRunner(
      new MockProvider({
        json: () => {
          called = true;
          return { title: 'x' };
        },
      }),
    );

    await expect(runner.run(baseAgent, { text: '', extra: 'SECRET-VALUE' })).rejects.toBeInstanceOf(
      AgentInputInvalidError,
    );

    expect(called).toBe(false);
    try {
      await runner.run(baseAgent, { extra: 'SECRET-VALUE' });
    } catch (error) {
      expect(error).toBeInstanceOf(AgentInputInvalidError);
      const issues = (error as AgentInputInvalidError).issues;
      expect(issues.map((issue) => issue.path)).toContain('$.extra');
      expect(JSON.stringify(error)).not.toContain('SECRET-VALUE');
    }
  });

  it('输出不合法：拒绝进入业务逻辑', async () => {
    const runner = new AgentRunner(new MockProvider({ json: { title: 123 } }));
    await expect(runner.run(baseAgent, { text: '正文' })).rejects.toBeInstanceOf(
      AgentOutputInvalidError,
    );
  });

  it('输出含未声明字段同样被拒绝', async () => {
    const runner = new AgentRunner(
      new MockProvider({ json: { title: '标题', prompt: 'SHOULD-NOT-PASS' } }),
    );
    await expect(runner.run(baseAgent, { text: '正文' })).rejects.toBeInstanceOf(
      AgentOutputInvalidError,
    );
  });

  it('Provider 错误原样向上传递（已是安全文案）', async () => {
    const runner = new AgentRunner(
      new MockProvider({
        json: () => {
          throw new ModelProviderError('MODEL_TIMEOUT', '模型服务超时', { retryable: true });
        },
      }),
    );
    await expect(runner.run(baseAgent, { text: '正文' })).rejects.toMatchObject({
      code: 'MODEL_TIMEOUT',
      retryable: true,
    });
  });
});
