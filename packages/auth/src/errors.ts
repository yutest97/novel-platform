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
  | 'LAST_ADMIN_PROTECTED'
  | 'EMAIL_TAKEN'
  | 'USER_LIMIT_REACHED'
  | 'WORK_TITLE_TAKEN'
  | 'INVALID_RULE_PACKAGE'
  | 'ENTITY_NAME_TAKEN'
  | 'ENTITY_IN_USE'
  | 'ENTITY_TYPE_NOT_ALLOWED'
  | 'CONCURRENT_MODIFICATION'
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
  LAST_ADMIN_PROTECTED: 403,
  EMAIL_TAKEN: 409,
  USER_LIMIT_REACHED: 409,
  // 稳定冲突错误：同一作者下作品标题重复
  WORK_TITLE_TAKEN: 409,
  // 题材规则包不存在或未启用
  INVALID_RULE_PACKAGE: 400,
  // 稳定冲突错误：同一作品同类型下实体名重复
  ENTITY_NAME_TAKEN: 409,
  // 稳定冲突错误：实体被其它实体引用，无法删除
  ENTITY_IN_USE: 409,
  // 实体类型不在当前阶段允许范围内
  ENTITY_TYPE_NOT_ALLOWED: 400,
  // 并发修改冲突：同一作品的写操作串行化后仍发生写冲突
  CONCURRENT_MODIFICATION: 409,
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
  // 稳定的专用错误码：不允许停用最后一个可用管理员
  LAST_ADMIN_PROTECTED: '不能停用最后一个可用管理员',
  // 稳定冲突错误：邮箱已被占用（不区分大小写，因为入库前已规范化）
  EMAIL_TAKEN: '该邮箱已被占用',
  // 稳定冲突错误：账号总数已达上限
  USER_LIMIT_REACHED: '账号数量已达上限',
  // 稳定冲突错误：同一作者下作品标题重复
  WORK_TITLE_TAKEN: '该作者下已存在同名作品',
  // 题材无效：规则包不存在或未启用
  INVALID_RULE_PACKAGE: '题材不可用',
  // 稳定冲突错误：同一作品同类型下实体名重复
  ENTITY_NAME_TAKEN: '同名实体已存在',
  // 稳定冲突错误：实体被引用，无法删除
  ENTITY_IN_USE: '该实体当前被引用，无法删除',
  // 实体类型不允许
  ENTITY_TYPE_NOT_ALLOWED: '不支持该实体类型',
  // 并发修改冲突
  CONCURRENT_MODIFICATION: '数据已被其他操作修改，请重试',
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
