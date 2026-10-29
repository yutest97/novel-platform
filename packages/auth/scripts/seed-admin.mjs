#!/usr/bin/env node
/**
 * 一次性创建初始管理员。
 *
 * 用法：
 *   ADMIN_EMAIL=admin@example.com ADMIN_INITIAL_PASSWORD='至少12位的口令' \
 *     pnpm admin:create
 *
 * 安全约束：
 * - 邮箱与初始密码只从环境变量 / 本地 .env 读取，不写入仓库。
 * - 密码以 argon2id 哈希入库，脚本本身**不打印**密码或哈希。
 * - 幂等：已存在同邮箱账号时不覆盖、不改密码。
 * - 新账号 must_change_password = true，首次登录必须改密。
 * - 不提供注册接口，本脚本是创建账号的唯一途径。
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { disconnectPrisma, getPrismaClient } from '@novel/db';
import { config as loadEnv } from 'dotenv';

import {
  EMPTY_REQUEST_META,
  createInitialAdmin,
  isAuthError,
  normalizeEmail,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

for (const candidate of [resolve(repoRoot, '.env'), resolve(here, '../.env')]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate });
  }
}

async function main() {
  const email = process.env['ADMIN_EMAIL'];
  const password = process.env['ADMIN_INITIAL_PASSWORD'];

  if (email === undefined || email.trim() === '') {
    throw new Error('缺少环境变量 ADMIN_EMAIL');
  }
  if (password === undefined || password === '') {
    throw new Error('缺少环境变量 ADMIN_INITIAL_PASSWORD');
  }

  const db = getPrismaClient();
  const result = await createInitialAdmin(db, {
    email: normalizeEmail(email),
    password,
    meta: EMPTY_REQUEST_META,
  });

  if (result.created) {
    console.log(`[seed] ✓ 已创建管理员：${result.email}`);
    console.log('[seed]   该账号首次登录必须修改密码（must_change_password = true）。');
    console.log('[seed]   初始密码未写入日志，请从你的密码管理器获取。');
  } else {
    console.log(`[seed] 管理员已存在，未做任何修改：${result.email}`);
  }
}

main()
  .catch((error) => {
    // 只输出可安全展示的信息：
    // - 本项目的 AuthError：输出其文案（仅含参数校验说明）；
    // - 其它异常（如 Prisma 错误）：只输出类型与错误码，避免把 SQL 参数（可能含哈希）打进日志。
    if (isAuthError(error)) {
      console.error(`[seed] ✗ 创建管理员失败：${error.code} —— ${error.message}`);
    } else {
      const name = error instanceof Error ? error.name : 'UnknownError';
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'n/a';
      console.error(`[seed] ✗ 创建管理员失败：name=${name} code=${code}`);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
