/**
 * 前端与后端之间的最小 HTTP 客户端。
 *
 * 安全约束（M1-B3）：
 * - 只走**同源 fetch**，凭据由浏览器自动携带 HttpOnly Cookie，前端不读取令牌；
 * - 错误只按**稳定错误码**映射中文文案，不回显服务端原始信息；
 * - 不把任何响应写入 localStorage / sessionStorage。
 */

import {
  DiffPayloadError,
  parseChapterVersionDiff,
  type ChapterVersionDiff,
} from './chapter-diff-view';

export type {
  ChapterDiffLine,
  ChapterDiffLineKind,
  ChapterDiffStats,
  ChapterDiffVersionRef,
  ChapterVersionDiff,
} from './chapter-diff-view';

/** 后端稳定错误码。 */
export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_DISABLED'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'INVALID_ORIGIN'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'FORBIDDEN'
  | 'LAST_ADMIN_PROTECTED'
  | 'EMAIL_TAKEN'
  | 'USER_LIMIT_REACHED'
  | 'WORK_TITLE_TAKEN'
  | 'INVALID_RULE_PACKAGE'
  | 'ENTITY_NAME_TAKEN'
  | 'ENTITY_IN_USE'
  | 'ENTITY_TYPE_NOT_ALLOWED'
  | 'ITEM_EVENT_INVALID_TRANSITION'
  | 'ITEM_EVENT_NOT_REVERSIBLE'
  | 'ITEM_EVENT_IDEMPOTENCY_CONFLICT'
  | 'ITEM_EVENTS_CLOSED'
  // 任务创建幂等冲突：同一 requestId 被用于不同内容
  | 'TASK_REQUEST_CONFLICT'
  // 章节候选采纳（A1-3A）：候选不存在 / 不可采纳 / 版本冲突 / 章节状态不允许
  | 'CHAPTER_CANDIDATE_NOT_FOUND'
  | 'CHAPTER_CANDIDATE_NOT_ADOPTABLE'
  | 'CHAPTER_VERSION_CONFLICT'
  | 'CHAPTER_STATE_INVALID_FOR_ADOPTION'
  // 同一作品内章号重复（A1-3B）
  | 'CHAPTER_NO_TAKEN'
  // 章节已定稿 / 已废弃，不能再生成候选（A1-3B-REV-01）
  | 'CHAPTER_STATE_INVALID_FOR_GENERATION'
  // 人工版本保存（A1-4B-A）：正文不合法 / 章节已废弃
  | 'CHAPTER_CONTENT_INVALID'
  | 'CHAPTER_STATE_INVALID_FOR_SAVE'
  // 版本 diff（A1-4B-C-A）：正文规模超出对比上限
  | 'CHAPTER_DIFF_TOO_LARGE'
  // 历史版本恢复（A1-4B-C-B）：目标版本已是当前最新
  | 'CHAPTER_VERSION_ALREADY_LATEST'
  // 章节定稿（A1-4B-C-C）：状态不允许定稿
  | 'CHAPTER_STATE_INVALID_FOR_FINALIZE'
  // 连续性事实（A2-B）
  | 'CONTINUITY_CHAPTER_NOT_FINALIZED'
  | 'CONTINUITY_SOURCE_VERSION_STALE'
  | 'CONTINUITY_EXTRACTION_IN_PROGRESS'
  | 'CONTINUITY_EXTRACTION_LEASE_LOST'
  | 'CONTINUITY_FACTS_INVALID'
  | 'CONTINUITY_EXTRACTION_FAILED'
  // 并发修改冲突：同一作品的写操作串行化后仍发生写冲突/死锁（HTTP 409）
  | 'CONCURRENT_MODIFICATION'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

/** 错误码 → 中文文案。 */
const MESSAGES: Record<ApiErrorCode, string> = {
  UNAUTHENTICATED: '登录已失效，请重新登录',
  INVALID_CREDENTIALS: '邮箱或密码不正确',
  ACCOUNT_DISABLED: '账号已停用，请联系管理员',
  PASSWORD_CHANGE_REQUIRED: '请先完成首次改密',
  INVALID_ORIGIN: '请求来源校验未通过，请刷新页面后重试',
  RATE_LIMITED: '尝试过于频繁，请稍后再试',
  VALIDATION_FAILED: '提交的信息不合法，请检查后重试',
  FORBIDDEN: '没有权限执行该操作',
  LAST_ADMIN_PROTECTED: '不能停用最后一个可用管理员',
  EMAIL_TAKEN: '该邮箱已被占用',
  USER_LIMIT_REACHED: '账号数量已达上限（10 个）',
  WORK_TITLE_TAKEN: '你已创建过同名作品，请换一个标题',
  INVALID_RULE_PACKAGE: '题材不可用',
  ENTITY_NAME_TAKEN: '同名实体已存在',
  ENTITY_IN_USE: '该实体当前被引用，无法删除',
  ENTITY_TYPE_NOT_ALLOWED: '不支持该实体类型',
  ITEM_EVENT_INVALID_TRANSITION: '当前物品状态不允许该操作',
  ITEM_EVENT_NOT_REVERSIBLE: '只能冲正当前最新且未被冲正的事件',
  ITEM_EVENT_IDEMPOTENCY_CONFLICT: '该幂等键已用于不同的事件内容',
  ITEM_EVENTS_CLOSED: '物品已删除，不能再追加或冲正事件',
  TASK_REQUEST_CONFLICT: '该 requestId 已用于不同的请求内容',
  CHAPTER_CANDIDATE_NOT_FOUND: '章节候选不存在',
  CHAPTER_CANDIDATE_NOT_ADOPTABLE: '该章节候选当前不可采纳',
  CHAPTER_VERSION_CONFLICT: '章节版本发生冲突，请刷新后重试',
  CHAPTER_STATE_INVALID_FOR_ADOPTION: '章节当前状态不允许采纳候选',
  CHAPTER_NO_TAKEN: '该章号已被占用',
  CHAPTER_STATE_INVALID_FOR_GENERATION: '章节当前状态不允许生成候选',
  CHAPTER_CONTENT_INVALID: '章节正文不合法，请检查字数和内容',
  CHAPTER_STATE_INVALID_FOR_SAVE: '章节当前状态不允许保存人工版本',
  CHAPTER_DIFF_TOO_LARGE: '章节正文规模超出对比上限',
  CHAPTER_VERSION_ALREADY_LATEST: '该版本已是最新版本，无需恢复',
  CHAPTER_STATE_INVALID_FOR_FINALIZE: '章节当前状态不允许定稿',
  CONTINUITY_CHAPTER_NOT_FINALIZED: '章节尚未定稿，不能提取连续性事实',
  CONTINUITY_SOURCE_VERSION_STALE: '章节最新版本已变化，请重新提取',
  CONTINUITY_EXTRACTION_IN_PROGRESS: '该版本正在提取连续性事实，请稍后重试',
  CONTINUITY_EXTRACTION_LEASE_LOST: '该连续性提取任务已由新的尝试接管',
  CONTINUITY_FACTS_INVALID: '模型输出的连续性事实不合法',
  CONTINUITY_EXTRACTION_FAILED: '连续性事实提取失败，请稍后重试',
  // 并发修改冲突：可重试提示，**不**触发登录跳转
  CONCURRENT_MODIFICATION: '数据已被其他操作修改，请重试',
  NOT_FOUND: '目标不存在',
  INTERNAL_ERROR: '服务内部错误，请稍后重试',
};

/**
 * 删除保护摘要里的一条引用者（**只含定位信息**）。
 *
 * 服务端保证这里不含属性值 / 秘密 / 正文，前端也不做任何补全。
 */
export interface EntityReferenceItem {
  readonly id: string;
  readonly entityType: string;
  readonly name: string;
}

/** 删除保护摘要（`ENTITY_IN_USE` 时随错误一起返回）。 */
export interface EntityReferenceSummary {
  readonly total: number;
  readonly items: readonly EntityReferenceItem[];
}

/** 接口错误（携带稳定错误码、HTTP 状态，以及可选的安全引用摘要）。 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** 仅 `ENTITY_IN_USE` 且服务端提供了摘要时存在。 */
  readonly references?: EntityReferenceSummary;

  constructor(code: ApiErrorCode, status: number, references?: EntityReferenceSummary) {
    super(MESSAGES[code] ?? MESSAGES.INTERNAL_ERROR);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    if (references !== undefined) {
      this.references = references;
    }
  }
}

/**
 * 从错误响应体里解析引用摘要。
 *
 * 逐字段校验形状：畸形数据一律当作"没有摘要"，绝不把未知字段带到界面上
 * （服务端已经只返回 id / entityType / name，这里再兜一层）。
 */
function parseReferenceSummary(value: unknown): EntityReferenceSummary | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const summary = value as { total?: unknown; items?: unknown };
  if (typeof summary.total !== 'number' || !Array.isArray(summary.items)) {
    return undefined;
  }
  const items: EntityReferenceItem[] = [];
  for (const entry of summary.items) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const item = entry as { id?: unknown; entityType?: unknown; name?: unknown };
    if (
      typeof item.id === 'string' &&
      typeof item.entityType === 'string' &&
      typeof item.name === 'string'
    ) {
      items.push({ id: item.id, entityType: item.entityType, name: item.name });
    }
  }
  if (items.length === 0) {
    return undefined;
  }
  return { total: Math.max(summary.total, items.length), items };
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && value in MESSAGES;
}

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * 发送 JSON 请求（同源，带 Cookie）。
 *
 * @throws ApiError 非 2xx 时抛出，`code` 为后端稳定错误码。
 */
export async function apiRequest(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(path, {
    method,
    headers,
    // 同源请求由浏览器自动附带 Cookie 与 Origin 头
    credentials: 'same-origin',
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    cache: 'no-store',
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const error =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error?: { code?: unknown; references?: unknown } }).error
        : undefined;
    const code = isApiErrorCode(error?.code) ? error.code : 'INTERNAL_ERROR';
    throw new ApiError(code, response.status, parseReferenceSummary(error?.references));
  }

  return { status: response.status, body };
}

/** 供 UI 展示的错误文案（只认稳定错误码）。 */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return '网络异常，请稍后重试';
}

/** 当前用户与会话信息。 */
export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly role: 'admin' | 'author';
  readonly status: 'active' | 'disabled';
  readonly mustChangePassword: boolean;
}

export interface SessionInfo {
  readonly user: SessionUser;
  readonly session: { absoluteExpiresAt: string; idleExpiresAt: string };
}

/** 读取当前会话（未登录/停用/待改密会抛 ApiError）。 */
export async function fetchSession(): Promise<SessionInfo> {
  const { body } = await apiRequest('/api/auth/me');
  return body as SessionInfo;
}

/** 管理接口的账号视图。 */
export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly role: 'admin' | 'author';
  readonly status: 'active' | 'disabled';
  readonly mustChangePassword: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 角色中文名。 */
export function roleLabel(role: 'admin' | 'author'): string {
  return role === 'admin' ? '管理员' : '作者';
}

/** 状态中文名。 */
export function statusLabel(status: 'active' | 'disabled'): string {
  return status === 'active' ? '启用' : '停用';
}

/** 本地时间显示（固定 zh-CN，避免服务端/客户端水合差异）。 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/* ---------------------------------------------------------------- 作品（M2-A） */

/** 作品列表项。 */
export interface WorkSummary {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly targetChapters: number;
  readonly targetWordsPerChapter: number;
  readonly genreRulePackage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 作品设定。 */
export interface WorkSetting {
  readonly settingKey: string;
  readonly settingValue: unknown;
  readonly schemaRef: string;
  readonly updatedAt: string;
}

/** 作品详情。 */
export interface WorkDetail extends WorkSummary {
  readonly settings: readonly WorkSetting[];
}

/** 题材规则包。 */
export interface RulePackage {
  readonly code: string;
  readonly name: string;
  readonly version: string;
  readonly active: boolean;
}

/** 读取当前作者的作品列表。 */
export async function fetchWorks(): Promise<WorkSummary[]> {
  const { body } = await apiRequest('/api/works');
  return (body as { works: WorkSummary[] }).works;
}

/** 创建作品。 */
export async function createWork(input: {
  title: string;
  summary?: string;
  targetChapters?: number;
  targetWordsPerChapter?: number;
  genreRulePackage: string;
}): Promise<WorkSummary> {
  const { body } = await apiRequest('/api/works', { method: 'POST', body: input });
  return (body as { work: WorkSummary }).work;
}

/** 读取作品详情。 */
export async function fetchWork(workId: string): Promise<WorkDetail> {
  const { body } = await apiRequest(`/api/works/${encodeURIComponent(workId)}`);
  return (body as { work: WorkDetail }).work;
}

/** 读取可用题材（仅启用中的规则包）。 */
export async function fetchRulePackages(): Promise<RulePackage[]> {
  const { body } = await apiRequest('/api/works/rule-packages');
  return (body as { rulePackages: RulePackage[] }).rulePackages;
}

/* ------------------------------------------------- 设定中心与实体（M2-B1） */

/** 规则包支持的字段类型（与 `@novel/works` 的 `FieldType` 一一对应）。 */
export type FieldType = 'string' | 'text' | 'integer' | 'enum' | 'entityRef' | 'entityRefs';

/** enum 的一个选项：`value` 入库、`label` 仅展示。 */
export interface EnumOption {
  readonly value: string;
  readonly label: string;
}

/** 字段定义（来自规则包的 field_schema）。 */
export interface FieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly order: number;
  readonly help?: string;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  /** type=enum 时的可选值集合。 */
  readonly options?: readonly EnumOption[];
  /** type=entityRef / entityRefs 时的目标实体类型。 */
  readonly refType?: string;
  /** type=entityRefs 时的元素个数上限。 */
  readonly maxItems?: number;
}

/** 一组字段定义。 */
export interface FieldGroup {
  readonly title: string;
  readonly schemaRef: string;
  /** 分组展示顺序（实体类型之间）；缺省表示排到最后。 */
  readonly order?: number;
  readonly fields: readonly FieldDefinition[];
}

/** 规则包的公开 schema 摘要。 */
export interface SchemaSummary {
  readonly code: string;
  readonly name: string;
  readonly version: string;
  readonly workDirection: FieldGroup | null;
  readonly entityTypes: readonly { key: string; group: FieldGroup }[];
}

/** 实体。 */
export interface EntityItem {
  readonly id: string;
  readonly entityType: string;
  readonly name: string;
  readonly orderIndex: number | null;
  readonly attributes: Record<string, unknown>;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 本轮启用 CRUD 的实体类型（与 `@novel/works` 的 `SUPPORTED_ENTITY_TYPES` 一致）。 */
export type SupportedEntityType = 'realm_level' | 'faction' | 'character' | 'item' | 'technique';

/** 设定中心里的一个实体分组（按 entityType 分区）。 */
export interface EntityGroupItem {
  readonly entityType: SupportedEntityType;
  readonly title: string;
  readonly schemaRef: string;
  readonly order: number;
  readonly entities: readonly EntityItem[];
}

/** 设定中心。 */
export interface SettingsCenter {
  readonly workId: string;
  readonly workTitle: string;
  readonly direction: Record<string, unknown>;
  readonly schema: SchemaSummary;
  readonly entityGroups: readonly EntityGroupItem[];
}

/** 读取设定中心。 */
export async function fetchSettingsCenter(workId: string): Promise<SettingsCenter> {
  const { body } = await apiRequest(`/api/works/${encodeURIComponent(workId)}/settings`);
  return (body as { settings: SettingsCenter }).settings;
}

/** 更新作品方向。 */
export async function updateDirection(
  workId: string,
  direction: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { body } = await apiRequest(`/api/works/${encodeURIComponent(workId)}/settings`, {
    method: 'PATCH',
    body: { direction },
  });
  return (body as { direction: Record<string, unknown> }).direction;
}

/** 列出作品内指定类型的实体。 */
export async function fetchEntities(workId: string, entityType: string): Promise<EntityItem[]> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/entities?type=${encodeURIComponent(entityType)}`,
  );
  return (body as { entities: EntityItem[] }).entities;
}

/** 新建实体。 */
export async function createEntity(
  workId: string,
  input: {
    entityType: string;
    name: string;
    attributes: Record<string, unknown>;
  },
): Promise<EntityItem> {
  const { body } = await apiRequest(`/api/works/${encodeURIComponent(workId)}/entities`, {
    method: 'POST',
    body: input,
  });
  return (body as { entity: EntityItem }).entity;
}

/**
 * 编辑实体。
 *
 * **排序值不在入参里**：orderIndex 由服务端独占，
 * 顺序变更只能通过 `reorderEntities`（完整集合重排）完成。
 */
export async function updateEntity(
  workId: string,
  entityId: string,
  input: {
    name?: string;
    attributes?: Record<string, unknown>;
  },
): Promise<EntityItem> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/entities/${encodeURIComponent(entityId)}`,
    { method: 'PATCH', body: input },
  );
  return (body as { entity: EntityItem }).entity;
}

/** 软删除实体。 */
export async function deleteEntity(workId: string, entityId: string): Promise<void> {
  await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/entities/${encodeURIComponent(entityId)}`,
    { method: 'DELETE' },
  );
}

/** 重排实体顺序。 */
export async function reorderEntities(
  workId: string,
  entityType: string,
  entityIds: readonly string[],
): Promise<EntityItem[]> {
  const { body } = await apiRequest(`/api/works/${encodeURIComponent(workId)}/entities/reorder`, {
    method: 'PUT',
    body: { entityType, entityIds },
  });
  return (body as { entities: EntityItem[] }).entities;
}

/* -------------------------------------------------------------------------- */
/* 物品事件流水（M2-B3-B1）                                                     */
/* -------------------------------------------------------------------------- */

/** 物品事件类型。 */
export type ItemEventType = 'obtained' | 'transferred' | 'consumed' | 'lost';

/** 物品生命周期状态。 */
export type ItemStatus = 'unrecorded' | 'held' | 'consumed' | 'lost';

/**
 * 事件/状态里的持有人引用。
 *
 * **只含定位信息**：id / name / deleted。
 * 服务端保证不带人物属性、秘密或其它字段。
 */
export interface ItemHolderRef {
  readonly id: string;
  readonly name: string;
  readonly deleted: boolean;
}

/** 一条物品事件。 */
export interface ItemEventView {
  readonly id: string;
  readonly itemId: string;
  readonly seq: number;
  readonly eventType: ItemEventType;
  readonly fromHolder: ItemHolderRef | null;
  readonly toHolder: ItemHolderRef | null;
  readonly reversalOf: string | null;
  readonly reversedBy: string | null;
  readonly reversed: boolean;
  readonly note: string | null;
  readonly createdAt: string;
}

/** 事件分页。 */
export interface ItemEventPage {
  readonly events: readonly ItemEventView[];
  readonly hasMore: boolean;
  readonly nextAfterSeq: number;
}

/** 物品派生状态。 */
export interface ItemStateView {
  readonly itemId: string;
  readonly itemName: string;
  readonly status: ItemStatus;
  readonly holder: ItemHolderRef | null;
  readonly eventCount: number;
  readonly effectiveEventCount: number;
  readonly lastSeq: number;
  readonly lastEventAt: string | null;
}

/** 写操作结果。 */
export interface ItemEventMutation {
  readonly event: ItemEventView;
  readonly state: ItemStateView;
  /** 同一幂等键命中既有事件时为 true。 */
  readonly deduplicated: boolean;
}

/** 读取物品事件（seq 升序，afterSeq 游标）。 */
export async function listItemEvents(
  workId: string,
  itemId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<ItemEventPage> {
  const params = new URLSearchParams();
  if (options.afterSeq !== undefined) {
    params.set('afterSeq', String(options.afterSeq));
  }
  if (options.limit !== undefined) {
    params.set('limit', String(options.limit));
  }
  const query = params.toString();
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/items/${encodeURIComponent(itemId)}/events${
      query === '' ? '' : `?${query}`
    }`,
  );
  return body as ItemEventPage;
}

/**
 * 追加物品事件。
 *
 * 注意：**没有 fromHolder 参数** —— 转出方由服务端按当前状态推导。
 */
export async function appendItemEvent(
  workId: string,
  itemId: string,
  input: {
    eventType: ItemEventType;
    toHolder?: string | null;
    note?: string | null;
    idempotencyKey: string;
  },
): Promise<ItemEventMutation> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/items/${encodeURIComponent(itemId)}/events`,
    { method: 'POST', body: input },
  );
  return body as ItemEventMutation;
}

/** 冲正当前最新事件（服务端推导反向事件类型与双方持有人）。 */
export async function reverseItemEvent(
  workId: string,
  itemId: string,
  eventId: string,
  input: { note?: string | null; idempotencyKey: string },
): Promise<ItemEventMutation> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/items/${encodeURIComponent(itemId)}/events/${encodeURIComponent(eventId)}/reversal`,
    { method: 'POST', body: input },
  );
  return body as ItemEventMutation;
}

/** 读取物品派生状态（持有人 + 生命周期 + 计数）。 */
export async function getItemState(workId: string, itemId: string): Promise<ItemStateView> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/items/${encodeURIComponent(itemId)}/state`,
  );
  return (body as { state: ItemStateView }).state;
}

/* -------------------------------------------------------------------------- */
/* 章节 / 生成任务 / 候选（A1-3B）                                              */
/* -------------------------------------------------------------------------- */

/** 章节摘要。 */
export interface ChapterSummary {
  readonly id: string;
  readonly workId: string;
  readonly chapterNo: number;
  readonly title: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * 生成任务摘要。
 *
 * 服务端**不会**返回 `input_snapshot` / `input_hash` / `requestId` / 租约字段；
 * `errorMessage` 是服务端映射后的安全文案，不含模型原始错误。
 */
export interface GenerationTaskSummary {
  readonly id: string;
  readonly chapterId: string | null;
  readonly status: string;
  readonly currentStep: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly cancelRequestedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 章节详情里的候选摘要（不含正文）。 */
export interface ChapterCandidateSummary {
  readonly id: string;
  readonly status: string;
  readonly wordCount: number;
  readonly createdAt: string;
}

/** 章节详情：章节 + 最新任务 + 候选摘要列表。 */
export interface ChapterDetail {
  readonly chapter: ChapterSummary;
  readonly latestTask: GenerationTaskSummary | null;
  readonly candidates: readonly ChapterCandidateSummary[];
}

/** 候选详情（含正文与结构化计划）。 */
export interface ChapterCandidateDetail {
  readonly id: string;
  readonly chapterId: string;
  readonly contractId: string;
  readonly status: string;
  readonly wordCount: number;
  readonly content: string;
  readonly structuredPlan: unknown;
  readonly createdAt: string;
}

/** 采纳结果摘要（不含正文）。 */
export interface ChapterVersionSummary {
  readonly versionId: string;
  readonly versionNo: number;
  readonly wordCount: number;
  readonly chapterStatus: string;
  /** true 表示该候选此前已被采纳，本次未新增版本。 */
  readonly deduplicated: boolean;
}

/** 写作风格参数（省略表示由服务端按作品方向推导）。 */
export interface ChapterStyleInput {
  readonly tone?: string;
  readonly pointOfView?: string;
  readonly pacing?: string;
}

/** 创建章节（章号在作品内唯一）。 */
export async function createChapter(
  workId: string,
  input: { readonly chapterNo: number; readonly title: string },
): Promise<ChapterSummary> {
  const { body } = await apiRequest(`/api/works/${encodeURIComponent(workId)}/chapters`, {
    method: 'POST',
    body: input,
  });
  return (body as { chapter: ChapterSummary }).chapter;
}

/** 读取章节详情（含最新任务与候选摘要）。 */
export async function fetchChapter(workId: string, chapterId: string): Promise<ChapterDetail> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(chapterId)}`,
  );
  return body as ChapterDetail;
}

/**
 * 提交章节生成任务。
 *
 * `provider` / `model` 由服务端配置决定，**不接受前端参数**；
 * `requestId` 是幂等键：同键同内容返回同一任务，同键异内容报
 * `TASK_REQUEST_CONFLICT`。
 */
export async function startChapterGeneration(
  workId: string,
  chapterId: string,
  input: {
    readonly requestId: string;
    readonly targetWords?: number;
    readonly style?: ChapterStyleInput;
  },
): Promise<GenerationTaskSummary> {
  const payload: Record<string, unknown> = { requestId: input.requestId };
  if (input.targetWords !== undefined) {
    payload['targetWords'] = input.targetWords;
  }
  if (input.style !== undefined) {
    payload['style'] = input.style;
  }
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(chapterId)}/generate`,
    { method: 'POST', body: payload },
  );
  return (body as { task: GenerationTaskSummary }).task;
}

/** 读取任务状态（轮询用）。 */
export async function fetchGenerationTask(
  workId: string,
  taskId: string,
): Promise<GenerationTaskSummary> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/generation-tasks/${encodeURIComponent(taskId)}`,
  );
  return (body as { task: GenerationTaskSummary }).task;
}

/** 请求取消任务（queued 立即取消，processing 在下一步之前停止）。 */
export async function cancelGenerationTask(
  workId: string,
  taskId: string,
): Promise<GenerationTaskSummary> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/generation-tasks/${encodeURIComponent(taskId)}/cancel`,
    { method: 'POST' },
  );
  return (body as { task: GenerationTaskSummary }).task;
}

/** 读取候选正文与结构化计划（已 adopted 的候选仍可读取）。 */
export async function fetchChapterCandidate(
  workId: string,
  chapterId: string,
  candidateId: string,
): Promise<ChapterCandidateDetail> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(
      chapterId,
    )}/candidates/${encodeURIComponent(candidateId)}`,
  );
  return (body as { candidate: ChapterCandidateDetail }).candidate;
}

/**
 * 采纳候选为正式章节版本。
 *
 * 成功返回版本摘要（不含正文）；重复采纳返回同一版本且 `deduplicated=true`。
 */
export async function adoptChapterCandidate(
  workId: string,
  chapterId: string,
  candidateId: string,
  input: { readonly requestId?: string } = {},
): Promise<ChapterVersionSummary> {
  const payload: Record<string, unknown> = {};
  if (input.requestId !== undefined) {
    payload['requestId'] = input.requestId;
  }
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(
      chapterId,
    )}/candidates/${encodeURIComponent(candidateId)}/adopt`,
    { method: 'POST', body: payload },
  );
  return (body as { version: ChapterVersionSummary }).version;
}

/* -------------------------------------------------------------------------- */
/* 章节列表 / 正式版本（A1-4A）                                                  */
/* -------------------------------------------------------------------------- */

/** 章节列表项（不含正文；`latestTask*` 供状态徽标）。 */
export interface ChapterListItem {
  readonly id: string;
  readonly workId: string;
  readonly chapterNo: number;
  readonly title: string;
  readonly status: string;
  readonly latestTaskStatus: string | null;
  readonly latestTaskStep: string | null;
  readonly updatedAt: string;
}

/** 正式版本摘要（列表用，不含正文）。 */
export interface ChapterVersionListItem {
  readonly id: string;
  readonly versionNo: number;
  /** `ai` | `human`。 */
  readonly source: string;
  readonly wordCount: number;
  readonly createdAt: string;
}

/** 正式版本详情（含正文）。 */
export interface ChapterVersionDetail extends ChapterVersionListItem {
  readonly chapterId: string;
  readonly content: string;
}

/** 读取作品下的章节列表（chapterNo 升序）。 */
export async function fetchChapters(workId: string): Promise<ChapterListItem[]> {
  const { body } = await apiRequest(`/api/works/${encodeURIComponent(workId)}/chapters`);
  return (body as { chapters: ChapterListItem[] }).chapters;
}

/** 读取章节的正式版本摘要（versionNo 倒序，最新在前）。 */
export async function fetchChapterVersions(
  workId: string,
  chapterId: string,
): Promise<ChapterVersionListItem[]> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(chapterId)}/versions`,
  );
  return (body as { versions: ChapterVersionListItem[] }).versions;
}

/* -------------------------------------------------------------------------- */
/* 人工章节版本（A1-4B-A）                                                       */
/* -------------------------------------------------------------------------- */

/** 人工保存结果（**不含正文**；正文由 `fetchChapterVersion` 读取）。 */
export interface HumanChapterVersionSummary {
  readonly versionId: string;
  readonly versionNo: number;
  readonly wordCount: number;
  readonly source: 'human';
  readonly parentVersionId: string | null;
  /** 保存后的章节状态（人工保存会把 finalized 拉回 in_review）。 */
  readonly chapterStatus: string;
}

/**
 * 把一段正文保存为新的**人类版本**。
 *
 * - `baseVersionId` 必须显式给出：`null` 表示"当前还没有正式版本"（首版）；
 *   已有版本时传当前最大版本 id，服务端用它做乐观并发校验；
 * - 基线不一致 → 409 `CHAPTER_VERSION_CONFLICT`（不会覆盖别人的版本）；
 * - 正文由服务端 trim 并重新计算字数，空白 / 过短 / 超长 → 400 `CHAPTER_CONTENT_INVALID`；
 * - 章节已废弃 → 409 `CHAPTER_STATE_INVALID_FOR_SAVE`。
 */
export async function saveHumanChapterVersion(
  workId: string,
  chapterId: string,
  input: { readonly content: string; readonly baseVersionId: string | null },
): Promise<HumanChapterVersionSummary> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(chapterId)}/versions`,
    {
      method: 'POST',
      body: { content: input.content, baseVersionId: input.baseVersionId },
    },
  );
  return (body as { version: HumanChapterVersionSummary }).version;
}

/** 读取正式版本正文。 */
export async function fetchChapterVersion(
  workId: string,
  chapterId: string,
  versionId: string,
): Promise<ChapterVersionDetail> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(
      chapterId,
    )}/versions/${encodeURIComponent(versionId)}`,
  );
  return (body as { version: ChapterVersionDetail }).version;
}

/* -------------------------------------------------------------------------- */
/* 版本对比与历史恢复（A1-4B-C）                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 读取两个正式版本之间的行级 diff（只读）。
 *
 * - `fromVersionId` / `toVersionId` 各传一次；服务端严格白名单校验；
 * - 响应**严格解析**：形状不对（缺字段 / 类型不符 / 行号与 kind 不自洽 /
 *   stats 与实际行数矛盾）按 `INTERNAL_ERROR` 处理，绝不渲染半截结果；
 * - `CHAPTER_DIFF_TOO_LARGE` 由统一错误映射给出稳定中文文案；
 * - 不写 URL / localStorage / sessionStorage。
 */
export async function fetchChapterVersionDiff(
  workId: string,
  chapterId: string,
  fromVersionId: string,
  toVersionId: string,
): Promise<ChapterVersionDiff> {
  const query = new URLSearchParams({ fromVersionId, toVersionId });
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(
      chapterId,
    )}/versions/diff?${query.toString()}`,
  );
  try {
    return parseChapterVersionDiff(body);
  } catch (error) {
    if (error instanceof DiffPayloadError) {
      throw new ApiError('INTERNAL_ERROR', 500);
    }
    throw error;
  }
}

/** 历史版本恢复结果（**不含正文**；正文由 `fetchChapterVersion` 读取）。 */
export interface RestoredChapterVersionSummary {
  readonly versionId: string;
  readonly versionNo: number;
  readonly wordCount: number;
  readonly source: 'human';
  /** 新版本的父版本 = 恢复时的最新版本。 */
  readonly parentVersionId: string;
  /** 正文来源的历史版本 id（原版本保持不变）。 */
  readonly restoredFromVersionId: string;
  readonly chapterStatus: string;
}

/**
 * 把历史版本恢复为**新的**人工正式版本。
 *
 * - `baseVersionId` 必须是**当前最大版本 id**（用于乐观并发）；
 * - 正文与字数由服务端从历史版本原样复制，客户端不提交正文；
 * - 版本已是最新 → 409 `CHAPTER_VERSION_ALREADY_LATEST`；
 * - 基线过期 → 409 `CHAPTER_VERSION_CONFLICT`；章节废弃 → 409
 *   `CHAPTER_STATE_INVALID_FOR_SAVE`；历史版本不属于该章节 / 作品 → 404。
 */
export async function restoreChapterVersion(
  workId: string,
  chapterId: string,
  versionId: string,
  input: { readonly baseVersionId: string },
): Promise<RestoredChapterVersionSummary> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(
      chapterId,
    )}/versions/${encodeURIComponent(versionId)}/restore`,
    { method: 'POST', body: { baseVersionId: input.baseVersionId } },
  );
  return (body as { version: RestoredChapterVersionSummary }).version;
}

/* -------------------------------------------------------------------------- */
/* 章节定稿（A1-4B-C-C）                                                        */
/* -------------------------------------------------------------------------- */

/** 定稿结果（**不含正文**）。 */
export interface FinalizedChapterSummary {
  readonly chapterId: string;
  readonly status: 'finalized';
  readonly versionId: string;
  readonly versionNo: number;
  /** `true` 表示幂等重试：章节早已定稿在同一版本，没有新增审计。 */
  readonly deduplicated: boolean;
}

/**
 * 把章节定稿到**当前最新正式版本**。
 *
 * - `versionId` 必须是当前最大版本 id：否则 409 `CHAPTER_VERSION_CONFLICT`；
 * - 章节状态不是 `in_review` / 没有正式版本 / 已定稿但版本不同 →
 *   409 `CHAPTER_STATE_INVALID_FOR_FINALIZE`；
 * - 已定稿且同一版本 → 200 且 `deduplicated=true`（幂等，不重复写审计）；
 * - 定稿后人工保存 revision 会回到 `in_review`，需要重新定稿。
 */
export async function finalizeChapter(
  workId: string,
  chapterId: string,
  versionId: string,
): Promise<FinalizedChapterSummary> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(chapterId)}/finalize`,
    { method: 'POST', body: { versionId } },
  );
  return (body as { chapter: FinalizedChapterSummary }).chapter;
}

/* -------------------------------------------------------------------------- */
/* 连续性事实（A2-B）                                                            */
/* -------------------------------------------------------------------------- */

/** 一次提取的结果摘要（**不含正文、prompt、模型原始响应、attemptToken**）。 */
export interface ChapterFactExtractionSummary {
  readonly runId: string;
  readonly created: boolean;
  readonly sourceVersionId: string;
  readonly sourceVersionNo: number;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly factCount: number;
  readonly factTypeCounts: Readonly<Record<string, number>>;
}

/** 一条候选（只读视图）。 */
export interface ChapterFactListItem {
  readonly id: string;
  readonly runId: string;
  readonly sourceVersionId: string;
  readonly sourceVersionNo: number;
  readonly factType: string;
  readonly summary: string;
  readonly reason: string;
  readonly subjectId: string | null;
  readonly objectId: string | null;
  readonly name: string | null;
  readonly threadStatus: string | null;
  readonly createdAt: string;
}

/** 候选列表（最多 200 条；被截断时 `truncated=true`）。 */
export interface ChapterFactListPage {
  readonly facts: readonly ChapterFactListItem[];
  readonly total: number;
  readonly truncated: boolean;
}

/** 候选对应的 run 安全元信息。 */
export interface ChapterFactRunView {
  readonly runId: string;
  readonly sourceVersionId: string;
  readonly sourceVersionNo: number;
  readonly status: string;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly errorCode: string | null;
  readonly factCount: number;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** 候选详情。 */
export interface ChapterFactCandidateDetail {
  readonly fact: ChapterFactListItem;
  readonly run: ChapterFactRunView;
}

function chapterFactsBasePath(workId: string, chapterId: string): string {
  return `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(chapterId)}/facts`;
}

/**
 * 触发当前定稿版本的连续性事实提取（A2-B）。
 *
 * - `sourceVersionId` 必须是当前最新正式版本 → 否则 409 `CONTINUITY_SOURCE_VERSION_STALE`；
 * - 章节未定稿 → 409 `CONTINUITY_CHAPTER_NOT_FINALIZED`；
 * - 同版本已有成功 run → 200 且 `created=false`（幂等，不新增候选与审计）；
 * - 同版本正在提取 → 409 `CONTINUITY_EXTRACTION_IN_PROGRESS`；
 * - 本次尝试被接管 → 409 `CONTINUITY_EXTRACTION_LEASE_LOST`。
 *
 * 只产生候选，不写回人物 / 物品 / 势力 / 关系 / 境界。
 */
export async function extractChapterFactsFromApi(
  workId: string,
  chapterId: string,
  sourceVersionId: string,
): Promise<ChapterFactExtractionSummary> {
  const { body } = await apiRequest(`${chapterFactsBasePath(workId, chapterId)}/extract`, {
    method: 'POST',
    body: { sourceVersionId },
  });
  return (body as { extraction: ChapterFactExtractionSummary }).extraction;
}

/** 读取某章节的候选列表（可选按 `factType` 过滤；最多 200 条）。 */
export async function fetchChapterFacts(
  workId: string,
  chapterId: string,
  options: { readonly factType?: string } = {},
): Promise<ChapterFactListPage> {
  const query = new URLSearchParams();
  if (options.factType !== undefined) {
    query.set('factType', options.factType);
  }
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  const { body } = await apiRequest(`${chapterFactsBasePath(workId, chapterId)}${suffix}`);
  return body as ChapterFactListPage;
}

/** 读取单条候选详情（跨作品 / 跨章节 / 随机 id → 404）。 */
export async function fetchChapterFactCandidate(
  workId: string,
  chapterId: string,
  candidateId: string,
): Promise<ChapterFactCandidateDetail> {
  const { body } = await apiRequest(
    `${chapterFactsBasePath(workId, chapterId)}/${encodeURIComponent(candidateId)}`,
  );
  return body as ChapterFactCandidateDetail;
}

/** 读取一次提取运行的状态（不含 `attemptToken` 与原始错误消息）。 */
export async function fetchChapterFactRun(
  workId: string,
  chapterId: string,
  runId: string,
): Promise<ChapterFactRunView> {
  const { body } = await apiRequest(
    `/api/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(
      chapterId,
    )}/fact-runs/${encodeURIComponent(runId)}`,
  );
  return (body as { run: ChapterFactRunView }).run;
}
