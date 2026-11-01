/**
 * 前端与后端之间的最小 HTTP 客户端。
 *
 * 安全约束（M1-B3）：
 * - 只走**同源 fetch**，凭据由浏览器自动携带 HttpOnly Cookie，前端不读取令牌；
 * - 错误只按**稳定错误码**映射中文文案，不回显服务端原始信息；
 * - 不把任何响应写入 localStorage / sessionStorage。
 */

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
