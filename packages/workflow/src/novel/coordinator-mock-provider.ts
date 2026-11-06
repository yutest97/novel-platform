/**
 * C1-A 的确定性 Coordinator Mock Provider。
 *
 * 用途：无网络环境下的 Runtime / Worker / API / 页面联调与测试。
 *
 * 行为：
 * - 只读取结构化 input（requestText / latestAnswer / stateSummary）；
 * - 没有回答时先问题材；
 * - 有回答且未明确要求结束时，按已补充数量追问人物 / 目标 / 目标读者；
 * - 作者明确说"结束 / 先到这里"等固定口令时返回 finish；
 * - 不读系统时钟、不访问数据库、不发网络请求。
 */

import type { ModelJsonInput } from '../model-types.js';
import { MockProvider, type MockJsonValue } from '../providers/mock.js';
import type { NovelCoordinatorAction, NovelCoordinatorInput } from './coordinator-agent.js';

const FINISH_COMMANDS = new Set([
  '结束',
  '先到这里',
  '就到这里',
  '结束吧',
  '停止',
  '不用了',
  '到此为止',
  '没有了',
  '先到这里结束',
  '结束问答',
]);

const QUESTION_BY_COUNT = [
  {
    question: '你想写哪一种题材的小说？',
    options: ['东方玄幻', '都市异能', '悬疑推理', '自定义'],
    objective: '确定小说题材',
  },
  {
    question: '主角最核心的目标或困境是什么？',
    options: ['复仇成长', '守护他人', '查明真相', '自定义'],
    objective: '明确主角的核心目标',
  },
  {
    question: '主角最鲜明的性格或身份设定是什么？',
    options: ['冷静克制', '热血直接', '隐忍腹黑', '自定义'],
    objective: '明确主角设定',
  },
  {
    question: '你希望故事主要面向哪类目标读者？',
    options: ['男频读者', '女频读者', '泛读者', '自定义'],
    objective: '明确目标读者',
  },
  {
    question: '还需要补充关键设定吗？也可以直接结束问答。',
    options: ['想再补充一点', '先到这里结束'],
    objective: '确认是否继续补充设定',
  },
  {
    question: '你更偏好哪种叙事节奏？',
    options: ['快节奏强冲突', '稳健铺陈', '慢热氛围', '自定义'],
    objective: '明确叙事节奏',
  },
] as const;

function normalizeCommand(text: string): string {
  return text.replace(/[\s，。！？!?、,.：:；;]/g, '');
}

function parseInput(input: ModelJsonInput): NovelCoordinatorInput | null {
  const user = input.messages.filter((message) => message.role === 'user').at(-1);
  if (user === undefined) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(user.content);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    return parsed as NovelCoordinatorInput;
  } catch {
    return null;
  }
}

function actionFor(input: NovelCoordinatorInput | null): NovelCoordinatorAction {
  const requestText =
    input !== null && typeof input.requestText === 'string' && input.requestText.length > 0
      ? input.requestText
      : '开始一部小说';
  const latestAnswer =
    input !== null && typeof input.latestAnswer === 'string' && input.latestAnswer.trim() !== ''
      ? input.latestAnswer
      : null;
  const knownFacts =
    input !== null && Array.isArray(input.stateSummary?.knownFacts)
      ? input.stateSummary.knownFacts
      : [];

  if (latestAnswer !== null && FINISH_COMMANDS.has(normalizeCommand(latestAnswer))) {
    return {
      action: 'finish',
      objective: '结束本轮创作问答',
      input: { question: null, options: [], finishReason: 'author_requested_finish' },
      decisionSummary: `作者明确要求结束问答。已有 ${knownFacts.length} 条补充事实，本轮请求：${requestText.slice(0, 80)}`,
    };
  }

  const answeredCount = knownFacts.length + (latestAnswer === null ? 0 : 1);
  const selected =
    QUESTION_BY_COUNT[Math.min(answeredCount, QUESTION_BY_COUNT.length - 1)] ??
    QUESTION_BY_COUNT[0];

  return {
    action: 'ask_user',
    objective: selected.objective,
    input: {
      question: selected.question,
      options: [...selected.options],
      finishReason: null,
    },
    decisionSummary:
      latestAnswer === null
        ? '作者刚描述创作目标，先确认题材方向。'
        : `已收到 ${answeredCount} 条作者补充，继续确认下一步关键信息。`,
  };
}

/** 创建完全确定性的 Coordinator Mock Provider。 */
export function createNovelCoordinatorMockProvider(
  options: { latencyMs?: number } = {},
): MockProvider {
  return new MockProvider({
    model: 'mock-coordinator',
    ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
    json: (input) => actionFor(parseInput(input)) as unknown as MockJsonValue,
  });
}
