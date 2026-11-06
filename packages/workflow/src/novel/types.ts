/**
 * C1-A 小说创作问答的稳定契约类型。
 *
 * 边界：
 * - 这些类型只描述**作者问答调度**，不描述大纲 / 人物 / 章节正文；
 * - `NovelRunStateSummary` 允许落库的内容只有安全摘要，不得出现 prompt、
 *   模型原始响应、密钥或整本小说正文；
 * - HTTP 视图（NovelRunView）不包含 stateSummary，避免泄漏调度内部字段。
 */

export const NOVEL_RUN_STATUSES = [
  'queued',
  'running',
  'waiting_user',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const;

export type NovelRunStatus = (typeof NOVEL_RUN_STATUSES)[number];

export const NOVEL_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export type NovelTerminalStatus = (typeof NOVEL_TERMINAL_STATUSES)[number];

export const NOVEL_ACTIVE_STATUSES = ['queued', 'running'] as const;

export const MAX_NOVEL_REQUEST_LENGTH = 2000;
export const MAX_NOVEL_ANSWER_LENGTH = 2000;
export const DEFAULT_NOVEL_MAX_STEPS = 20;
export const MAX_NOVEL_STEPS_LIMIT = 100;

/** C1-A 只注册这两个工具；后续阶段才允许扩展。 */
export const NOVEL_ALLOWED_TOOLS = ['ask_user', 'finish'] as const;

export type NovelToolName = (typeof NOVEL_ALLOWED_TOOLS)[number];

/**
 * 调度摘要（落库在 novel_runs.state_summary）。
 *
 * 仅保留下一轮 Coordinator 决策需要的信息：
 * - 作者已补充的简短事实；
 * - 当前待答问题（不展示给 API 之外的地方）；
 * - 产物版本引用（C1-A 为空，后续阶段填 id / version）；
 * - 幂等重试与重复动作熔断所需的短字段。
 */
export interface NovelRunStateSummary {
  readonly knownFacts: readonly string[];
  readonly openQuestions: readonly string[];
  readonly artifactVersions: Readonly<Record<string, string>>;
  readonly pendingApproval: null;
  readonly confirmedArtifacts: readonly string[];
  readonly healthWarnings: readonly string[];
  readonly nextAllowedTools: readonly string[];
  readonly latestAnswer: string | null;
  readonly lastAnsweredVersion: number | null;
  readonly lastAnswer: string | null;
  readonly lastActionSignature: string | null;
  readonly repeatCount: number;
  readonly lastStepNo: number;
}

export const INITIAL_NOVEL_STATE_SUMMARY: NovelRunStateSummary = {
  knownFacts: [],
  openQuestions: [],
  artifactVersions: {},
  pendingApproval: null,
  confirmedArtifacts: [],
  healthWarnings: [],
  nextAllowedTools: [],
  latestAnswer: null,
  lastAnsweredVersion: null,
  lastAnswer: null,
  lastActionSignature: null,
  repeatCount: 0,
  lastStepNo: 0,
};

const MAX_STORED_ANSWERS = 6;
const MAX_STORED_ANSWER_LENGTH = MAX_NOVEL_ANSWER_LENGTH;

function readStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    if (item.length === 0 || item.length > MAX_STORED_ANSWER_LENGTH) {
      continue;
    }
    result.push(item);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function readNullableString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function readNullableVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * 把数据库 JSONB 收敛成安全摘要。
 *
 * 不抛错：损坏的调度摘要只丢弃未知字段，Runtime 会在步骤预算内继续；
 * 若连基础结构都不可用，调用方会得到空摘要而不是把原始内容带进日志。
 */
export function parseNovelStateSummary(raw: unknown): NovelRunStateSummary {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return INITIAL_NOVEL_STATE_SUMMARY;
  }
  const record = raw as Record<string, unknown>;
  const artifactVersions: Record<string, string> = {};
  if (
    typeof record['artifactVersions'] === 'object' &&
    record['artifactVersions'] !== null &&
    !Array.isArray(record['artifactVersions'])
  ) {
    for (const [key, value] of Object.entries(
      record['artifactVersions'] as Record<string, unknown>,
    )) {
      if (key.length <= 120 && typeof value === 'string' && value.length <= 200) {
        artifactVersions[key] = value;
      }
    }
  }
  return {
    knownFacts: readStringArray(record['knownFacts'], MAX_STORED_ANSWERS),
    openQuestions: readStringArray(record['openQuestions'], 6),
    artifactVersions,
    pendingApproval: null,
    confirmedArtifacts: readStringArray(record['confirmedArtifacts'], 6),
    healthWarnings: readStringArray(record['healthWarnings'], 6),
    nextAllowedTools: readStringArray(record['nextAllowedTools'], NOVEL_ALLOWED_TOOLS.length),
    latestAnswer: readNullableString(record['latestAnswer'], MAX_NOVEL_ANSWER_LENGTH),
    lastAnsweredVersion: readNullableVersion(record['lastAnsweredVersion']),
    lastAnswer: readNullableString(record['lastAnswer'], MAX_NOVEL_ANSWER_LENGTH),
    lastActionSignature: readNullableString(record['lastActionSignature'], 200),
    repeatCount:
      typeof record['repeatCount'] === 'number' &&
      Number.isInteger(record['repeatCount']) &&
      record['repeatCount'] >= 0 &&
      record['repeatCount'] <= 10
        ? record['repeatCount']
        : 0,
    lastStepNo: readNullableVersion(record['lastStepNo']) ?? 0,
  };
}

export function isNovelTerminalStatus(status: string): status is NovelTerminalStatus {
  return (NOVEL_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isNovelRunStatus(value: unknown): value is NovelRunStatus {
  return typeof value === 'string' && (NOVEL_RUN_STATUSES as readonly string[]).includes(value);
}

/** 只读 API 视图：不含 stateSummary、prompt、原始响应或模型日志。 */
export interface NovelRunView {
  readonly runId: string;
  readonly status: NovelRunStatus;
  readonly version: number;
  readonly currentGoal: string;
  readonly decisionSummary: string;
  readonly question: string | null;
  readonly options: readonly string[];
  readonly stepCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建接口的最小返回契约。 */
export interface NovelRunCreated {
  readonly runId: string;
  readonly status: NovelRunStatus;
  readonly version: number;
}
