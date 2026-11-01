/**
 * 前端 API 客户端单元测试（M2-B1-REV-02）。
 *
 * 重点验证**并发冲突**这条链路是通的：
 * - 后端返回 409 + `CONCURRENT_MODIFICATION` 时，
 *   前端必须原样保留该错误码，**不能**退化成 `INTERNAL_ERROR`；
 * - 文案是可重试的中文提示；
 * - 该错误码**不触发**登录/改密跳转（它和会话失效是两回事）。
 *
 * 另外验证排序值已从客户端入参中移除：
 * `createEntity` / `updateEntity` 发出的请求体里不会带 orderIndex。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  createEntity,
  messageOf,
  updateEntity,
  type ApiErrorCode,
} from '../src/lib/api.js';
import {
  handleSessionError,
  isSessionError,
  resetSessionRedirectGuard,
  sessionRedirectTarget,
} from '../src/lib/session-errors.js';

/** 用假 fetch 构造一个指定状态码与响应体的响应。 */
function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** 取出假 fetch 收到的请求体（已 JSON 解析）。 */
function sentBody(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex]?.[1] as { body?: string } | undefined;
  return init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
}

describe('前端 API 客户端：CONCURRENT_MODIFICATION', () => {
  beforeEach(() => {
    resetSessionRedirectGuard();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('409 + CONCURRENT_MODIFICATION 保留原错误码，不退化为 INTERNAL_ERROR', async () => {
    stubFetch(409, {
      error: { code: 'CONCURRENT_MODIFICATION', message: '数据已被其他操作修改，请重试' },
    });

    const failure = await updateEntity('11111111-1111-4111-8111-111111111111', 'e-1', {
      name: '金丹期',
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as ApiError;
    expect(apiError.code).toBe('CONCURRENT_MODIFICATION');
    // 关键：不能被映射成兜底的 INTERNAL_ERROR
    expect(apiError.code).not.toBe('INTERNAL_ERROR');
    expect(apiError.status).toBe(409);
  });

  it('CONCURRENT_MODIFICATION 的文案是稳定、可重试的中文提示', () => {
    const error = new ApiError('CONCURRENT_MODIFICATION', 409);
    expect(error.message).toBe('数据已被其他操作修改，请重试');
    expect(messageOf(error)).toBe('数据已被其他操作修改，请重试');
  });

  it('CONCURRENT_MODIFICATION 不属于会话类错误：不跳转登录，只提示可重试', () => {
    const code: ApiErrorCode = 'CONCURRENT_MODIFICATION';
    expect(sessionRedirectTarget(code)).toBeNull();

    const replace = vi.fn();
    const handled = handleSessionError(new ApiError(code, 409), { replace });

    expect(isSessionError(new ApiError(code, 409))).toBe(false);
    expect(handled, '会话类错误处理器必须放行，交给页面展示提示').toBe(false);
    expect(replace, '不得触发任何路由跳转（尤其不能跳 /login）').not.toHaveBeenCalled();
  });

  it('未知错误码仍然退化为 INTERNAL_ERROR（对照）', async () => {
    stubFetch(409, { error: { code: 'SOMETHING_NEW' } });

    const failure = await updateEntity('11111111-1111-4111-8111-111111111111', 'e-1', {
      name: 'x',
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect((failure as ApiError).code).toBe('INTERNAL_ERROR');
  });
});

describe('前端 API 客户端：排序值已从入参移除', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('createEntity 请求体不含 orderIndex', async () => {
    const fetchMock = stubFetch(201, {
      entity: { id: 'e-1', orderIndex: 1 },
    });

    await createEntity('11111111-1111-4111-8111-111111111111', {
      entityType: 'realm_level',
      name: '炼气',
      attributes: { minorLevelCount: 9 },
    });

    const body = sentBody(fetchMock);
    expect(body).not.toHaveProperty('orderIndex');
    expect(body).not.toHaveProperty('order_index');
    expect(body).toMatchObject({ entityType: 'realm_level', name: '炼气' });
  });

  it('updateEntity 请求体不含 orderIndex', async () => {
    const fetchMock = stubFetch(200, {
      entity: { id: 'e-1', orderIndex: 2 },
    });

    await updateEntity('11111111-1111-4111-8111-111111111111', 'e-1', {
      name: '筑基期',
      attributes: { minorLevelCount: 3 },
    });

    const body = sentBody(fetchMock);
    expect(body).not.toHaveProperty('orderIndex');
    expect(body).not.toHaveProperty('order_index');
    expect(body).toMatchObject({ name: '筑基期' });
  });
});
