import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

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
    // Prisma 7 的 `env()` 在变量缺失时会直接抛错，这会让
    // `prisma generate`（**不需要连接数据库**）在干净克隆 / CI 中失败。
    // 因此这里对缺失情况回退到本地占位连接串：
    //   - generate：只生成客户端，不需要真正连接，行为不受影响；
    //   - migrate：真正执行迁移前由 packages/db 的脚本校验 DATABASE_URL 必须存在
    //     （见 package.json 的 migrate 脚本），避免用占位串去连接而给出误导性错误。
    url:
      process.env['DATABASE_URL'] ?? 'postgresql://novel:novel@localhost:5432/novel?schema=public',
  },
});
