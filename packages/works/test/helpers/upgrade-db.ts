/**
 * 升级路径测试用的隔离数据库。
 *
 * 为什么不能用共享测试库：迁移测试需要把库停在"升级前"的状态
 * （规则包还是 2.0.0、存在 1.0.0 历史行），这会污染其它用例。
 *
 * 做法与 `packages/auth/test/helpers/isolated-db.ts` 一致：
 * 在同一个 PostgreSQL 实例上建一个临时**数据库**，按目录名顺序执行仓库里的
 * `migration.sql`，但**只执行到指定迁移之前**，把"应用下一个迁移"交给用例。
 *
 * 用"库"而不是"schema"的原因：Prisma 生成的 SQL 会显式限定 "public"，
 * 通过 search_path 切换 schema 对它无效。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPrismaClient, type PrismaClient } from '@novel/db';
import { Client } from 'pg';

import { requireDatabaseUrl } from './db.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const migrationsDir = join(repoRoot, 'packages/db/prisma/migrations');

/** 去掉连接串里的 Prisma 专有 schema 参数。 */
function stripSchemaParam(url: string): string {
  return url
    .replace(/([?&])schema=[^&]*/g, '$1')
    .replace(/[?&]+$/, '')
    .replace(/\?&/, '?');
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** 按目录名排序的迁移列表。 */
export function listMigrations(): { name: string; sql: string }[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'),
    }));
}

/** 读取某个迁移的 SQL 原文（保证测试与真实迁移不漂移）。 */
export function readMigration(name: string): string {
  return readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
}

/** 升级路径测试用的隔离库句柄。 */
export interface UpgradeDb {
  readonly db: PrismaClient;
  /** 指向隔离库的原生连接，用于执行迁移与直接断言表内容。 */
  readonly raw: Client;
  readonly dispose: () => Promise<void>;
}

/**
 * 建一个临时库，并应用**目录名严格小于 `before`** 的所有迁移。
 *
 * @param tag 库名短标签（排障用）
 * @param before 迁移目录名；该迁移及之后的都不执行
 */
export async function createDbBeforeMigration(tag: string, before: string): Promise<UpgradeDb> {
  const baseUrl = stripSchemaParam(requireDatabaseUrl());
  const database = `t_${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }

  const targetUrl = withDatabase(baseUrl, database);
  const raw = new Client({ connectionString: targetUrl });
  await raw.connect();
  for (const migration of listMigrations()) {
    if (migration.name >= before) {
      break;
    }
    await raw.query(migration.sql);
  }

  const db = createPrismaClient({ connectionString: targetUrl });

  return {
    db,
    raw,
    dispose: async () => {
      await db.$disconnect();
      await raw.end();
      const cleanup = new Client({ connectionString: baseUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
