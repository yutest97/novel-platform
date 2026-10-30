'use client';

/**
 * 会话类错误的**统一**处理（M1-B3-REV-01）。
 *
 * 为什么需要：任何一次接口调用都可能先于本地计时器发现"会话已失效"，
 * 这些情况不能只显示一句错误文本，必须立刻把用户送回正确页面。
 *
 * 规则：
 * - UNAUTHENTICATED        → /login
 * - ACCOUNT_DISABLED       → /login?reason=disabled
 * - PASSWORD_CHANGE_REQUIRED → /change-password
 *
 * 同一时刻可能有多个并发请求同时失败（列表 + 操作），
 * 用模块级标记去重，避免连续 replace 造成路由抖动。
 */

import type { ApiErrorCode } from './api';
import { ApiError } from './api';

/** 路由跳转能力（与 next/navigation 的 router 兼容，便于测试注入）。 */
export interface Redirector {
  replace: (path: string) => void;
}

/** 会话类错误码 → 目标路径；非会话类错误返回 null。 */
export function sessionRedirectTarget(code: ApiErrorCode): string | null {
  switch (code) {
    case 'UNAUTHENTICATED':
      return '/login';
    case 'ACCOUNT_DISABLED':
      return '/login?reason=disabled';
    case 'PASSWORD_CHANGE_REQUIRED':
      return '/change-password';
    default:
      return null;
  }
}

/** 判断异常是否属于"会话已失效"这一类。 */
export function isSessionError(error: unknown): boolean {
  return error instanceof ApiError && sessionRedirectTarget(error.code) !== null;
}

let lastRedirect: { target: string; at: number } | null = null;

/** 去重窗口：同一目标在 1.5 秒内只跳一次。 */
const DEDUPE_WINDOW_MS = 1500;

/**
 * 若属于会话类错误则立即跳转并返回 true；否则返回 false（调用方可继续展示错误）。
 */
export function handleSessionError(error: unknown, router: Redirector): boolean {
  if (!(error instanceof ApiError)) {
    return false;
  }
  const target = sessionRedirectTarget(error.code);
  if (target === null) {
    return false;
  }

  const now = Date.now();
  if (
    lastRedirect !== null &&
    lastRedirect.target === target &&
    now - lastRedirect.at < DEDUPE_WINDOW_MS
  ) {
    return true;
  }
  lastRedirect = { target, at: now };
  router.replace(target);
  return true;
}

/** 测试用：清空去重状态。 */
export function resetSessionRedirectGuard(): void {
  lastRedirect = null;
}
