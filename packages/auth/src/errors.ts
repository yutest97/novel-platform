/**
 * 认证错误类型。
 *
 * 设计约束：
 * - 对外错误信息必须**不泄露**账号是否存在、密码是否错误等细节。
 * - 所有错误都带稳定的 `code`，便于前端分支处理与测试断言。
 */

/** 对外暴露的错误码（稳定契约）。 */
export type AuthErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_DISABLED'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'INVALID_ORIGIN'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'FORBIDDEN'
  | 'NOT_FOUND';

/** 错误码 → HTTP 状态码。 */
const STATUS_BY_CODE: Record<AuthErrorCode, number> = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_DISABLED: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  INVALID_ORIGIN: 403,
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
};

/** 错误码 → 对外文案。 */
const MESSAGE_BY_CODE: Record<AuthErrorCode, string> = {
  UNAUTHENTICATED: '未登录或登录已失效',
  // 账号不存在与密码错误必须使用**完全相同**的文案。
  INVALID_CREDENTIALS: '邮箱或密码不正确',
  ACCOUNT_DISABLED: '账号已停用',
  PASSWORD_CHANGE_REQUIRED: '首次登录必须先修改密码',
  INVALID_ORIGIN: '请求来源不受信任',
  RATE_LIMITED: '尝试过于频繁，请稍后再试',
  VALIDATION_FAILED: '请求参数不合法',
  // 越权与"操作者不存在"使用同一文案，避免泄露账号是否存在。
  FORBIDDEN: '没有权限执行该操作',
  NOT_FOUND: '资源不存在',
};

/** 认证领域错误。 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;

  constructor(code: AuthErrorCode, detail?: string) {
    super(detail === undefined ? MESSAGE_BY_CODE[code] : `${MESSAGE_BY_CODE[code]}：${detail}`);
    this.name = 'AuthError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }

  /** 对外响应体（不含任何内部细节）。 */
  toBody(): { error: { code: AuthErrorCode; message: string } } {
    return { error: { code: this.code, message: MESSAGE_BY_CODE[this.code] } };
  }
}

/** 判断任意异常是否为 AuthError。 */
export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
