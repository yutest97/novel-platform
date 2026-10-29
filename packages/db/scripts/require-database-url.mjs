#!/usr/bin/env node
/**
 * 迁移前置校验：DATABASE_URL 必须显式存在。
 *
 * 背景：prisma.config.ts 对缺失的 DATABASE_URL 回退到本地占位串，
 * 以便 `prisma generate`（不需要数据库）在干净克隆/CI 中可用。
 * 但**迁移**必须连到真实数据库，因此在执行迁移前强制校验。
 */
const url = process.env['DATABASE_URL'];

if (url === undefined || url.trim() === '') {
  console.error(
    '[db] 缺少环境变量 DATABASE_URL —— 无法执行迁移。\n' +
      '      请设置 DATABASE_URL（例如 postgresql://user:pass@host:5432/db?schema=public）。',
  );
  process.exit(1);
}

if (url.includes('localhost:5432') && !process.env['ALLOW_PLACEHOLDER_DATABASE_URL']) {
  console.error(
    '[db] DATABASE_URL 指向 localhost:5432 的占位连接串 —— 拒绝执行迁移。\n' +
      '      如确需连接本机数据库，请设置 ALLOW_PLACEHOLDER_DATABASE_URL=1。',
  );
  process.exit(1);
}

process.exit(0);
