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
  | 'ITEM_EVENT_INVALID_TRANSITION'
  | 'ITEM_EVENT_NOT_REVERSIBLE'
  | 'ITEM_EVENT_IDEMPOTENCY_CONFLICT'
  | 'ITEM_EVENTS_CLOSED'
  | 'TASK_REQUEST_CONFLICT'
  | 'CHAPTER_CANDIDATE_NOT_FOUND'
  | 'CHAPTER_CANDIDATE_NOT_ADOPTABLE'
  | 'CHAPTER_VERSION_CONFLICT'
  | 'CHAPTER_STATE_INVALID_FOR_ADOPTION'
  | 'CHAPTER_NO_TAKEN'
  | 'CHAPTER_STATE_INVALID_FOR_GENERATION'
  // 人工版本保存（A1-4B-A）：正文不合法 / 章节状态不允许保存
  | 'CHAPTER_CONTENT_INVALID'
  | 'CHAPTER_STATE_INVALID_FOR_SAVE'
  // 版本 diff（A1-4B-C-A）：正文规模超出对比上限
  | 'CHAPTER_DIFF_TOO_LARGE'
  // 历史版本恢复（A1-4B-C-B）：准备恢复的版本已经是当前最新
  | 'CHAPTER_VERSION_ALREADY_LATEST'
  // 章节定稿（A1-4B-C-C）：当前状态不允许定稿
  | 'CHAPTER_STATE_INVALID_FOR_FINALIZE'
  // 连续性事实提取（A2-A）
  | 'CONTINUITY_CHAPTER_NOT_FINALIZED'
  | 'CONTINUITY_SOURCE_VERSION_STALE'
  | 'CONTINUITY_EXTRACTION_IN_PROGRESS'
  | 'CONTINUITY_EXTRACTION_LEASE_LOST'
  | 'CONTINUITY_FACTS_INVALID'
  | 'CONTINUITY_EXTRACTION_FAILED'
  // 事实候选决策（A2-F-A）：候选已过期，或已做出不同决定
  | 'CONTINUITY_FACT_DECISION_STALE'
  | 'CONTINUITY_FACT_ALREADY_DECIDED'
  // Reviewer 结果只读接口（A2-C-D）：候选没有审阅任务，或归属不匹配
  | 'REVIEW_NOT_FOUND'
  // 章节版本摘要只读接口（A2-D-D）：该版本还没有成功落库的摘要
  | 'SUMMARY_NOT_FOUND'
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
  // 物品事件状态机不允许该操作（例如未持有就转手）
  ITEM_EVENT_INVALID_TRANSITION: 409,
  // 只允许冲正当前最新、且未被冲正过的事件
  ITEM_EVENT_NOT_REVERSIBLE: 409,
  // 同一幂等键被用于不同内容
  ITEM_EVENT_IDEMPOTENCY_CONFLICT: 409,
  // 物品已软删除，流水封闭
  ITEM_EVENTS_CLOSED: 409,
  // 同一 requestId 被用于不同内容（任务创建幂等冲突）
  TASK_REQUEST_CONFLICT: 409,
  // 候选不存在，或不属于当前作品 / 章节（不区分"不存在"与"不是你的"，避免探测）
  CHAPTER_CANDIDATE_NOT_FOUND: 404,
  // 候选已不是 candidate（无正式版本支撑），或重复采纳时数据不一致
  CHAPTER_CANDIDATE_NOT_ADOPTABLE: 409,
  // 版本号 / 来源候选唯一冲突（并发采纳同一候选或同一版本号）
  CHAPTER_VERSION_CONFLICT: 409,
  // 章节当前状态（finalized / abandoned）不允许采纳
  CHAPTER_STATE_INVALID_FOR_ADOPTION: 409,
  // 同一作品内章号重复
  CHAPTER_NO_TAKEN: 409,
  // 章节已定稿 / 已废弃，不能再生成候选
  CHAPTER_STATE_INVALID_FOR_GENERATION: 409,
  // 人工版本正文不合法（字数 / 长度 / 空白）
  CHAPTER_CONTENT_INVALID: 400,
  // 章节已废弃，不能再保存人工版本
  CHAPTER_STATE_INVALID_FOR_SAVE: 409,
  // diff：正文行数 / 长度超出对比上限（规模保护）
  CHAPTER_DIFF_TOO_LARGE: 400,
  // 恢复目标已是当前最新版本：拒绝创建无意义的新版本
  CHAPTER_VERSION_ALREADY_LATEST: 409,
  // 章节状态不允许定稿（含无正式版本、已定稿但版本不同）
  CHAPTER_STATE_INVALID_FOR_FINALIZE: 409,
  // 连续性事实提取：章节未定稿 / 版本过期 / 已有进行中的提取
  CONTINUITY_CHAPTER_NOT_FINALIZED: 409,
  CONTINUITY_SOURCE_VERSION_STALE: 409,
  CONTINUITY_EXTRACTION_IN_PROGRESS: 409,
  // 本次尝试已被新尝试接管：结果被丢弃
  CONTINUITY_EXTRACTION_LEASE_LOST: 409,
  // 模型输出不合法：不可重试
  CONTINUITY_FACTS_INVALID: 422,
  // Provider / 内部失败：可重试
  CONTINUITY_EXTRACTION_FAILED: 502,
  // 决定已过期：章节不再定稿，或候选不是当前最新版本
  CONTINUITY_FACT_DECISION_STALE: 409,
  // 已做出相反决定：不翻转、不改判
  CONTINUITY_FACT_ALREADY_DECIDED: 409,
  // 审阅结果不存在（含"不是你的作品 / 章节 / 候选"与"没有审阅任务"）
  REVIEW_NOT_FOUND: 404,
  // 摘要不存在（含"不是你的作品 / 章节 / 版本"与"尚未生成"）
  SUMMARY_NOT_FOUND: 404,
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
  ITEM_EVENT_INVALID_TRANSITION: '当前物品状态不允许该操作',
  ITEM_EVENT_NOT_REVERSIBLE: '只能冲正当前最新且未被冲正的事件',
  ITEM_EVENT_IDEMPOTENCY_CONFLICT: '该幂等键已用于不同的事件内容',
  ITEM_EVENTS_CLOSED: '物品已删除，不能再追加或冲正事件',
  // 不要求客户端换 requestId，也不回显任何输入内容
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
  // 区分两种 409：一个是"候选不再适用"，一个是"已做出相反决定"
  CONTINUITY_FACT_DECISION_STALE: '该事实候选已过期：章节或版本已变化',
  CONTINUITY_FACT_ALREADY_DECIDED: '该事实候选已做出不同决定，不能改判',
  // 统一 404：不区分"没有审阅结果"与"不是你的"，避免探测
  REVIEW_NOT_FOUND: '审阅结果不存在',
  // 同样统一 404，不区分"尚未生成"与"不是你的"
  SUMMARY_NOT_FOUND: '章节摘要不存在',
  // 并发修改冲突
  CONCURRENT_MODIFICATION: '数据已被其他操作修改，请重试',
  NOT_FOUND: '资源不存在',
};

/** 认证领域错误。 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;
  /**
   * 允许对外暴露的结构化附加信息。
   *
   * 仅用于**安全摘要**类信息（例如「该实体被哪些实体引用」的名称与类型），
   * 绝不允许放属性值、秘密、正文等业务内容。
   * 未提供时响应体与历史版本完全一致。
   */
  private readonly publicDetails?: Record<string, unknown>;

  constructor(code: AuthErrorCode, detail?: string, publicDetails?: Record<string, unknown>) {
    super(detail === undefined ? MESSAGE_BY_CODE[code] : `${MESSAGE_BY_CODE[code]}：${detail}`);
    this.name = 'AuthError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    if (publicDetails !== undefined) {
      this.publicDetails = publicDetails;
    }
  }

  /** 对外响应体（不含任何内部细节）。 */
  toBody(): { error: { code: AuthErrorCode; message: string; [key: string]: unknown } } {
    return {
      error: {
        code: this.code,
        message: MESSAGE_BY_CODE[this.code],
        ...(this.publicDetails ?? {}),
      },
    };
  }
}

/** 判断任意异常是否为 AuthError。 */
export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
