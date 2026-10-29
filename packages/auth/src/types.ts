/** 请求元信息（审计用，均为可选值）。 */
export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** 空请求元信息（供内部调用与测试使用）。 */
export const EMPTY_REQUEST_META: RequestMeta = { ip: null, userAgent: null };
