import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { hashPassword } from '../dist/index.js';

/**
 * 重置 E2E 共享作者口令（单文件重跑用）。
 *
 * 背景：完整 E2E 跑完后，`admin-flow.spec.ts` 与 `item-events-flow.spec.ts`
 * 会改写共享作者 `e2e-author` 的口令；单独重跑某个 spec 时，
 * `.e2e-author.json` 里的旧口令会失效（登录 401）。
 * 这个脚本把该账号的口令重置回 `.e2e-author.json` 里记录的值。
 *
 * 用法：node scripts/reset-e2e-author.mjs <数据库连接串>
 */
const connectionString = process.argv[2];
if (connectionString === undefined || connectionString.trim() === '') {
  throw new Error('需要数据库连接串');
}

const here = dirname(fileURLToPath(import.meta.url));
const credentialFile = resolve(here, '../../../apps/web/.e2e-author.json');
const credential = JSON.parse(readFileSync(credentialFile, 'utf8'));

const hash = await hashPassword(credential.password);
const client = new pg.Client({ connectionString });
await client.connect();
const result = await client.query(
  'update users set password_hash = $1, must_change_password = false where email = $2',
  [hash, credential.email],
);
console.log(`reset rows=${result.rowCount} email=${credential.email}`);
await client.end();
