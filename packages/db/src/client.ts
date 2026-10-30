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
 * 为什么全环境缓存（v1.2 修复）：
 * 早期实现在 production 环境**不写入**全局缓存，导致每次调用
 * `getPrismaClient()` 都会新建 PrismaClient —— 每次健康检查泄漏一个连接池，
 * 长时间运行必然耗尽数据库连接。现在**所有环境**（含 production）
 * 都复用同一实例。
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * 本模块作用域内的累计创建次数。
 *
 * 刻意**不放在 globalThis** 上：实例需要跨模块实例共享（dev 热重载），
 * 但创建计数是诊断指标，应跟随模块实例，便于测试精确断言。
 */
let prismaCreations = 0;

/**
 * 创建一个**不受单例缓存管理**的 Prisma 客户端。
 *
 * 用途：集成测试需要在独立 PostgreSQL schema 上验证"全局计数"类约束
 * （例如账号总数上限），这些测试必须拥有干净的数据空间。
 * 生产代码请一律使用 `getPrismaClient()`，以免泄漏连接池。
 *
 * @param options.connectionString 连接串（不含 schema 参数）
 * @param options.schema 目标 schema（通过 `search_path` 生效）
 */
export function createPrismaClient(options: {
  connectionString: string;
  schema?: string;
}): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    ...(options.schema === undefined ? {} : { options: `-c search_path=${options.schema}` }),
  });

  return new PrismaClient({
    adapter,
    log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
  });
}

function createClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('缺少必需的环境变量：DATABASE_URL');
  }

  const client = createPrismaClient({ connectionString });

  prismaCreations += 1;
  return client;
}

/**
 * 获取 Prisma 客户端实例。
 *
 * 全环境（含 production）返回**同一个**实例，绝不重复创建连接池。
 */
export function getPrismaClient(): PrismaClient {
  if (globalForPrisma.prisma === undefined) {
    globalForPrisma.prisma = createClient();
  }
  return globalForPrisma.prisma;
}

/**
 * Prisma 客户端的可观测统计（用于测试与运维排障）。
 *
 * - `creations`：本模块实例内累计创建的 PrismaClient 数量。
 *   正常情况下应恒为 1（无论调用多少次 `getPrismaClient()`）。
 */
export function getPrismaClientStats(): { readonly creations: number } {
  return { creations: prismaCreations };
}

/** 断开数据库连接（若已创建实例）。进程退出前必须调用。 */
export async function disconnectPrisma(): Promise<void> {
  if (globalForPrisma.prisma !== undefined) {
    await globalForPrisma.prisma.$disconnect();
    globalForPrisma.prisma = undefined;
  }
}
