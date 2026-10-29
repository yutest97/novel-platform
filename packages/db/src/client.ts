import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';

/**
 * Prisma 客户端单例（惰性构造）。
 *
 * Prisma 7 使用驱动适配器（driver adapter）连接数据库：
 * 通过 `@prisma/adapter-pg` 复用 `pg` 驱动，无需 Rust 查询引擎。
 *
 * 为什么惰性构造：客户端**不在模块加载时**创建。
 * 否则缺少 DATABASE_URL 或数据库不可用时会在 import 阶段抛错，
 * 导致健康检查无法返回"失败"，而是直接崩溃 —— 这违背
 * "数据库连接失败时健康检查必须返回失败，不能永远返回 OK" 的要求。
 *
 * 全局缓存在开发模式下复用，避免热重载时不断新建连接池。
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('缺少必需的环境变量：DATABASE_URL');
  }

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
  });
}

/** 获取（必要时创建）Prisma 客户端实例。 */
export function getPrismaClient(): PrismaClient {
  if (globalForPrisma.prisma !== undefined) {
    return globalForPrisma.prisma;
  }
  const client = createClient();
  if (process.env['NODE_ENV'] !== 'production') {
    globalForPrisma.prisma = client;
  }
  return client;
}

/** 断开数据库连接（若已创建实例）。 */
export async function disconnectPrisma(): Promise<void> {
  if (globalForPrisma.prisma !== undefined) {
    await globalForPrisma.prisma.$disconnect();
    globalForPrisma.prisma = undefined;
  }
}
