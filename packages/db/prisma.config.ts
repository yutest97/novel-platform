import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 配置文件。
 *
 * Prisma 7 起，datasource 的连接串不再写在 schema.prisma 中，
 * 而是在此配置（Prisma 7 官方格式，见 https://pris.ly/d/config-datasource）。
 *
 * 环境变量加载顺序：仓库根目录 .env → 本包 .env（后者不覆盖前者）。
 */
const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../..');

for (const candidate of [resolve(repoRoot, '.env'), resolve(packageRoot, '.env')]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate });
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.mjs',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
