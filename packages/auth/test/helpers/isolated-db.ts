/**
 * 一次性测试数据库。
 *
 * 为什么需要：账号总数上限（10）是**全局**约束，而共享测试库里已经有
 * 上百个由其他用例创建的账号，无法在共享库上验证"创建到第 10 个、第 11 个失败"。
 *
 * 做法：在同一个 PostgreSQL 实例上建一个临时**数据库**，按顺序执行仓库里的迁移 SQL，
 * 再创建一个指向该库的独立 Prisma 客户端。用完 `DROP DATABASE ... WITH (FORCE)`。
 *
 * 为什么不用独立 schema：Prisma 生成的 SQL 会显式限定 `"public"."users"`，
 * 通过 `search_path` 切换 schema 对它无效（实测仍读到 public 的数据），
 * 因此隔离粒度取"库"而不是"schema"。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPrismaClient, type PrismaClient } from '@novel/db';
import { Client } from 'pg';

import { requireDatabaseUrl } from './db.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const migrationsDir = join(repoRoot, 'packages/db/prisma/migrations');

/** 去掉 URL 中的 schema 参数（迁移在目标库的 public 中执行）。 */
function stripSchemaParam(url: string): string {
  return url
    .replace(/([?&])schema=[^&]*/g, '$1')
    .replace(/[?&]+$/, '')
    .replace(/\?&/, '?');
}

/** 把连接串的库名替换为指定数据库。 */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** 依次读取迁移目录中的 migration.sql（按目录名排序）。 */
function migrationScripts(): { name: string; sql: string }[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'),
    }));
}

/** 隔离数据库句柄。 */
export interface IsolatedDb {
  readonly db: PrismaClient;
  readonly database: string;
  readonly dispose: () => Promise<void>;
}

/**
 * 创建一个空数据库并应用全部迁移。
 *
 * @param tag 用于生成库名的短标签（便于排障）
 */
export async function createIsolatedDb(tag: string): Promise<IsolatedDb> {
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
  const target = new Client({ connectionString: targetUrl });
  await target.connect();
  try {
    for (const migration of migrationScripts()) {
      await target.query(migration.sql);
    }
  } finally {
    await target.end();
  }

  const db = createPrismaClient({ connectionString: targetUrl });

  return {
    db,
    database,
    dispose: async () => {
      await db.$disconnect();
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
