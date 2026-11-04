/**
 * 轻量 Agent 运行基础设施（A1-1）。
 *
 * 定位（与 docs/08 一致）：
 * - Agent 是**语义节点**：把结构化输入变成结构化输出；
 * - Agent 不访问数据库、不决定工作流下一步、不直接写任务状态；
 * - 工作流（WorkflowKernel）才是控制层，作者是最终签发者。
 *
 * 本文件只建立运行时，不实现 Planner / Writer 业务。
 */

import { WorkflowError } from './errors.js';
import type { JsonIssue, JsonSchema } from './json-schema.js';
import { assertJsonSchema, validateJson } from './json-schema.js';
import type { ModelProvider, ModelUsage } from './model-types.js';

/** Agent 定义（可序列化、可版本化）。 */
export interface AgentDefinition {
  /** 稳定名称，小写 + 点/下划线/短横线，例如 `planner.chapter`。 */
  readonly name: string;
  /** Prompt 版本，例如 `1.0.0`；同一 name 可有多个版本。 */
  readonly promptVersion: string;
  /** 默认模型；Provider 可覆盖为空时回落到服务端配置。 */
  readonly model: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly maxOutputTokens: number;
  readonly rolePrompt: string;
}

/** Agent 运行结果。 */
export interface AgentRunResult<TOutput = unknown> {
  readonly output: TOutput;
  readonly agentName: string;
  readonly promptVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
}

/** 运行选项。 */
export interface AgentRunOptions {
  readonly signal?: AbortSignal;
  readonly temperature?: number;
}

/** 输入不合法（问题只含路径与原因，不含字段值）。 */
export class AgentInputInvalidError extends WorkflowError {
  readonly issues: readonly JsonIssue[];
  constructor(agent: AgentDefinition, issues: readonly JsonIssue[]) {
    super(
      'AGENT_INPUT_INVALID',
      `Agent ${agent.name}@${agent.promptVersion} 输入不合法（${issues.length} 处）`,
    );
    this.name = 'AgentInputInvalidError';
    this.issues = issues;
  }
}

/** 输出不合法（模型输出不进入业务逻辑）。 */
export class AgentOutputInvalidError extends WorkflowError {
  readonly issues: readonly JsonIssue[];
  constructor(agent: AgentDefinition, issues: readonly JsonIssue[]) {
    super(
      'AGENT_OUTPUT_INVALID',
      `Agent ${agent.name}@${agent.promptVersion} 输出不合法（${issues.length} 处）`,
    );
    this.name = 'AgentOutputInvalidError';
    this.issues = issues;
  }
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/;
const MAX_ROLE_PROMPT_LENGTH = 8000;
const MAX_OUTPUT_TOKENS = 8192;

function definitionError(message: string): WorkflowError {
  return new WorkflowError('AGENT_DEFINITION_INVALID', `Agent 定义不合法：${message}`);
}

/**
 * 校验 Agent 定义（注册与运行时都会调用）。
 *
 * @throws WorkflowError `AGENT_DEFINITION_INVALID` / `AGENT_SCHEMA_INVALID`
 */
export function assertAgentDefinition(agent: AgentDefinition): void {
  if (typeof agent.name !== 'string' || !NAME_PATTERN.test(agent.name) || agent.name.length > 64) {
    throw definitionError('name 必须是小写标识符（≤64）');
  }
  if (typeof agent.promptVersion !== 'string' || !VERSION_PATTERN.test(agent.promptVersion)) {
    throw definitionError('promptVersion 不合法');
  }
  if (typeof agent.model !== 'string' || agent.model.length > 128) {
    throw definitionError('model 不合法');
  }
  if (
    !Number.isInteger(agent.maxOutputTokens) ||
    agent.maxOutputTokens < 1 ||
    agent.maxOutputTokens > MAX_OUTPUT_TOKENS
  ) {
    throw definitionError(`maxOutputTokens 必须是 1..${MAX_OUTPUT_TOKENS} 的整数`);
  }
  if (
    typeof agent.rolePrompt !== 'string' ||
    agent.rolePrompt.trim() === '' ||
    agent.rolePrompt.length > MAX_ROLE_PROMPT_LENGTH
  ) {
    throw definitionError(`rolePrompt 长度必须在 1..${MAX_ROLE_PROMPT_LENGTH}`);
  }
  assertJsonSchema(agent.inputSchema, `${agent.name}.inputSchema`);
  assertJsonSchema(agent.outputSchema, `${agent.name}.outputSchema`);
}

/** Agent 注册表（按 name + promptVersion 唯一）。 */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  /** 注册；同 name 同版本重复注册直接报错，避免静默覆盖。 */
  register(agent: AgentDefinition): void {
    assertAgentDefinition(agent);
    const key = `${agent.name}@${agent.promptVersion}`;
    if (this.agents.has(key)) {
      throw new WorkflowError('AGENT_DEFINITION_INVALID', `Agent 已注册：${key}`);
    }
    this.agents.set(key, agent);
  }

  /** 取指定版本；不传版本时必须是唯一版本。 */
  get(name: string, promptVersion?: string): AgentDefinition {
    if (promptVersion !== undefined) {
      const found = this.agents.get(`${name}@${promptVersion}`);
      if (found === undefined) {
        throw new WorkflowError(
          'AGENT_DEFINITION_INVALID',
          `Agent 未注册：${name}@${promptVersion}`,
        );
      }
      return found;
    }
    const matches = [...this.agents.values()].filter((agent) => agent.name === name);
    if (matches.length !== 1) {
      throw new WorkflowError(
        'AGENT_DEFINITION_INVALID',
        matches.length === 0 ? `Agent 未注册：${name}` : `Agent ${name} 存在多个版本，必须指定版本`,
      );
    }
    return matches[0] as AgentDefinition;
  }

  /** 已注册的 `name@version` 列表（稳定排序）。 */
  list(): readonly string[] {
    return [...this.agents.keys()].sort();
  }
}

/**
 * Agent 执行器：校验输入 → 调 Provider → 严格校验输出。
 *
 * 不重试、不写数据库、不记录 prompt/响应；重试与持久化属于 Worker/内核。
 */
export class AgentRunner {
  constructor(private readonly provider: ModelProvider) {}

  async run<TOutput = unknown>(
    agent: AgentDefinition,
    input: unknown,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult<TOutput>> {
    assertAgentDefinition(agent);

    const inputIssues = validateJson(agent.inputSchema, input);
    if (inputIssues.length > 0) {
      throw new AgentInputInvalidError(agent, inputIssues);
    }

    const result = await this.provider.generateJson({
      model: agent.model,
      maxOutputTokens: agent.maxOutputTokens,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      messages: [
        {
          role: 'system',
          content: [
            agent.rolePrompt,
            '',
            '你必须只输出一个 JSON 对象，不要输出 Markdown 代码块或任何解释。',
            '输出必须严格符合以下 JSON Schema（未声明的字段一律不允许）：',
            JSON.stringify(agent.outputSchema),
          ].join('\n'),
        },
        {
          role: 'user',
          // 输入是结构化数据，不是面向模型的指令模板；不写日志。
          content: JSON.stringify(input) ?? 'null',
        },
      ],
    });

    const outputIssues = validateJson(agent.outputSchema, result.json);
    if (outputIssues.length > 0) {
      throw new AgentOutputInvalidError(agent, outputIssues);
    }

    return {
      output: result.json as TOutput,
      agentName: agent.name,
      promptVersion: agent.promptVersion,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  }
}

/**
 * 确定性测试 Agent。
 *
 * 只用于证明"注册 → 校验 → Provider → 输出校验"链路可运行；
 * 不是业务 Agent，也不会被生产 Worker 注册。
 */
export const DETERMINISTIC_TEST_AGENT: AgentDefinition = {
  name: 'test.echo',
  promptVersion: '1.0.0',
  model: 'mock-model',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 200 },
    },
    required: ['question'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      answer: { type: 'string', minLength: 1, maxLength: 200 },
    },
    required: ['answer'],
    additionalProperties: false,
  },
  maxOutputTokens: 256,
  rolePrompt: '你是一个确定性的测试 Agent：只把输入的问题复述为 answer。',
};
