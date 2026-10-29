/**
 * 认证接口的 HTTP 适配层。
 *
 * 刻意只依赖标准 `Request` / `Response`（不使用 next/headers 的 cookies()），
 * 这样路由处理器可以在普通 Node 环境中被直接调用与测试，
 * 也不会因为框架上下文而隐式依赖请求作用域。
 */

import { AuthError, isAuthError, readAuthConfig, type AuthConfig } from '@novel/auth';

/** 构造 JSON 响应；可附带 Cookie。 */
export function authJson(body: unknown, status: number, cookies: readonly string[] = []): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * 把任意异常转换为对外响应。
 *
 * - AuthError：使用稳定错误码与统一文案；
 * - 其它异常：一律 500 + 通用文案，**不**回显异常信息（可能含 SQL 参数等敏感内容）；
 *   日志只记录异常名称与错误码。
 */
export function authErrorResponse(error: unknown): Response {
  if (isAuthError(error)) {
    return authJson(error.toBody(), error.status);
  }

  const name = error instanceof Error ? error.name : 'UnknownError';
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  console.error(`[auth] 未预期错误 name=${name} code=${code}`);

  return authJson({ error: { code: 'INTERNAL_ERROR', message: '服务内部错误' } }, 500);
}

/** 读取 JSON 请求体（限制大小，解析失败统一报 VALIDATION_FAILED）。 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new AuthError('VALIDATION_FAILED', 'Content-Type 必须为 application/json');
  }

  const text = await request.text();
  if (text.length > 8 * 1024) {
    throw new AuthError('VALIDATION_FAILED', '请求体过大');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AuthError('VALIDATION_FAILED', '请求体不是合法 JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AuthError('VALIDATION_FAILED', '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/** 从请求体取必填字符串字段。 */
export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value === '') {
    throw new AuthError('VALIDATION_FAILED', `缺少字段 ${key}`);
  }
  return value;
}

/** 读取认证相关配置（每次调用都读环境变量，便于测试注入）。 */
export function currentAuthConfig(): AuthConfig {
  return readAuthConfig();
}
