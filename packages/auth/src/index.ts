/**
 * @novel/auth —— 账号、会话与审计的核心逻辑。
 */

export { AUDIT_ACTIONS, sanitizeAuditDetail, writeAuditLog } from './audit.js';
export type { AuditAction, AuditDb, AuditEntry, SanitizedValue } from './audit.js';
export {
  GENERATED_PASSWORD_LENGTH,
  MAX_ACTIVE_SESSIONS,
  MAX_PASSWORD_LENGTH,
  MAX_USER_ACCOUNTS,
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE_NAME,
  DEFAULT_AUTH_CONFIG,
  readAuthConfig,
  readMaxUserAccounts,
} from './config.js';
export type { AuthConfig } from './config.js';
export { buildClearedSessionCookie, buildSessionCookie, readSessionToken } from './cookie.js';
export { AuthError, isAuthError } from './errors.js';
export type { AuthErrorCode } from './errors.js';
export { assertTrustedOrigin, readClientIp } from './origin.js';
export {
  assertPasswordPolicy,
  generateInitialPassword,
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
export { createAuthorUser, isUserStatus, listUsers } from './admin-users.js';
export type { AdminUserView, CreatedAuthor, UserStatusInput } from './admin-users.js';
export {
  adminResetPassword,
  resetUserPassword,
  assertAcceptableInitialPassword,
  assertValidEmail,
  countOtherActiveAdmins,
  createInitialAdmin,
  findUserByEmail,
  lockAdminGovernance,
  normalizeEmail,
  requireActiveAdmin,
  requireActiveAdminInTx,
  runAdminGovernance,
  setUserStatus,
} from './users.js';
export type { CreatedAdmin, UserReader } from './users.js';
