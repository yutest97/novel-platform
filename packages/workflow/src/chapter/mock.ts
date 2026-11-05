/**
 * 章节流水线专用 MockProvider（A1-4A）。
 *
 * 通用 `MockProvider` 的默认输出（`{ok:true}` / `mock response`）无法通过
 * Planner / Writer 的 Schema，因此 `MODEL_PROVIDER=mock` 时：
 * - 单测仍可直接使用通用 MockProvider 自行注入输出；
 * - **Worker 常驻进程**使用本模块：根据 Planner 的结构化输入生成合法合同，
 *   Writer 返回 ≥1200 字的确定性正文。
 *
 * 身份仍是 `name=mock / defaultModel=mock-model`，与 web 创建任务时记录的一致。
 */

import type { ModelJsonInput, ModelProvider } from '../model-types.js';
import { MockProvider, type MockJsonValue } from '../providers/mock.js';
import { CHAPTER_REVIEWER_MOCK_OUTPUT } from './reviewer-mock.js';
import { CHAPTER_SUMMARIZER_MOCK_OUTPUT } from './summarizer-mock.js';

const DEFAULT_TARGET_WORDS = 3_000;

/** 确定性正文：20 个非空白字符 × 80 = 1600 字，满足候选下限。 */
const DRAFT = '风从演武场尽头吹来，吹动了青石上的尘埃。'.repeat(80);

/** 供测试断言使用的正文常量。 */
export const MOCK_CHAPTER_DRAFT = DRAFT;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取最后一条 user 消息并解析为对象；失败返回 null。 */
function readUserPayload(input: ModelJsonInput): Record<string, unknown> | null {
  const userMessages = input.messages.filter((message) => message.role === 'user');
  const content = userMessages[userMessages.length - 1]?.content;
  if (content === undefined) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 从 Planner 输入生成合法合同（人物来自上下文，目标字数原样保留）。 */
function buildPlannerOutput(input: ModelJsonInput): MockJsonValue {
  const payload = readUserPayload(input);
  const chapter = isRecord(payload?.['chapter']) ? payload['chapter'] : {};
  const targetWords =
    typeof chapter['targetWords'] === 'number' ? chapter['targetWords'] : DEFAULT_TARGET_WORDS;
  const title = typeof chapter['title'] === 'string' ? chapter['title'] : '本章';

  const characters: string[] = [];
  const rawCharacters = payload?.['characters'];
  if (Array.isArray(rawCharacters)) {
    for (const entry of rawCharacters) {
      if (isRecord(entry) && typeof entry['name'] === 'string' && entry['name'] !== '') {
        characters.push(entry['name']);
      }
      if (characters.length >= 3) {
        break;
      }
    }
  }

  return {
    goal: `完成《${title}》的章节目标`,
    mustInclude: ['演武场', '正面交锋'],
    mustNotInclude: ['现代科技'],
    characters,
    scenes: [
      {
        purpose: '建立冲突',
        location: '演武场',
        conflict: '同门当众挑衅',
        outcome: '以巧劲化解并赢下比试',
      },
    ],
    targetWords,
  };
}

function chapterJsonResponder(input: ModelJsonInput): MockJsonValue {
  const system = input.messages[0]?.content ?? '';
  if (system.includes('planner.chapter')) {
    return buildPlannerOutput(input);
  }
  if (system.includes('reviewer.chapter')) {
    // A2-C-B：审阅默认无问题；需要注入问题的测试直接用
    // `createChapterReviewerMockProvider({ issues })`。
    return CHAPTER_REVIEWER_MOCK_OUTPUT;
  }
  if (system.includes('summarizer.chapter')) {
    // A2-D-B：摘要默认返回确定性、合法、非空的摘要。
    return CHAPTER_SUMMARIZER_MOCK_OUTPUT;
  }
  return { text: DRAFT };
}

/**
 * 创建章节流水线 MockProvider。
 *
 * 不联网、输出确定；JSON 与文本都返回可直接通过 Schema 的结果。
 */
export function createChapterMockProvider(): ModelProvider {
  return new MockProvider({
    json: chapterJsonResponder,
    text: () => DRAFT,
  });
}
