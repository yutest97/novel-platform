/**
 * @novel/auth —— 账号、会话与审计的核心逻辑。
 */

export { AUDIT_ACTIONS, sanitizeAuditDetail, writeAuditLog } from './audit.js';
export type { AuditAction, AuditEntry, SanitizedValue } from './audit.js';
export {
  MAX_ACTIVE_SESSIONS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE_NAME,
  DEFAULT_AUTH_CONFIG,
  readAuthConfig,
} from './config.js';
export type { AuthConfig } from './config.js';
export { buildClearedSessionCookie, buildSessionCookie, readSessionToken } from './cookie.js';
export { AuthError, isAuthError } from './errors.js';
export type { AuthErrorCode } from './errors.js';
export { assertTrustedOrigin, readClientIp } from './origin.js';
export {
  assertPasswordPolicy,
  hashPassword,
  verifyAbsentUserPassword,
  verifyPassword,
} from './password.js';
export { FixedWindowRateLimiter, loginIpRateLimitKey, loginRateLimitKey } from './ratelimit.js';
export type { RateLimitResult } from './ratelimit.js';
export { generateSessionToken, hashSessionToken } from './token.js';
export {
  authenticateToken,
  computeExpiries,
  createSession,
  findSessionByToken,
  isSessionExpired,
  revokeAllSessions,
  revokeSessionById,
  toPublicUser,
  touchSession,
} from './sessions.js';
export type { AuthContext, IssuedSession, PublicUser, SessionExpiries } from './sessions.js';
export {
  changePassword,
  getCurrentUser,
  loginWithPassword,
  logout,
  revokeUserSessions,
} from './service.js';
export type { ChangePasswordInput, LoginInput, LoginResult } from './service.js';
export { EMPTY_REQUEST_META } from './types.js';
export type { RequestMeta } from './types.js';
export {
  adminResetPassword,
  assertValidEmail,
  createInitialAdmin,
  findUserByEmail,
  normalizeEmail,
  setUserStatus,
} from './users.js';
export type { CreatedAdmin } from './users.js';
