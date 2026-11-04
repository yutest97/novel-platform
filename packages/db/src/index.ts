export {
  createPrismaClient,
  disconnectPrisma,
  getPrismaClient,
  getPrismaClientStats,
  type PrismaLogLevel,
} from './client.js';
export { DB_PROBE_TIMEOUT_MS, describeError, probeDatabase, withTimeout } from './health.js';
// 运行时导出 Prisma 命名空间：Worker 循环需要按错误类（Known/Initialization/Unknown）
// 区分瞬态与永久错误。类型位置仍可直接 `import type { Prisma }`。
export { Prisma } from './generated/prisma/client.js';
export type { PrismaClient } from './generated/prisma/client.js';
export type { User, UserRole, UserStatus, Session, AuditLog } from './generated/prisma/client.js';
