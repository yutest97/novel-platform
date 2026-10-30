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
  NOT_FOUND: '目标账号不存在',
  INTERNAL_ERROR: '服务内部错误，请稍后重试',
};

/** 接口错误（携带稳定错误码与 HTTP 状态）。 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, status: number) {
    super(MESSAGES[code] ?? MESSAGES.INTERNAL_ERROR);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
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
    const code =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error?: { code?: unknown } }).error?.code
        : undefined;
    throw new ApiError(isApiErrorCode(code) ? code : 'INTERNAL_ERROR', response.status);
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
