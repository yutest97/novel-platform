#!/usr/bin/env node
/**
 * scripts/check-ci-compose-order.mjs 的行为测试（**不需要 Docker**）。
 *
 * 用临时 YAML 夹具断言守卫真的会拦住回退：
 *   1. 正确顺序                                → 通过
 *   2. 缺少「只启动 postgres」                 → 失败
 *   3. 迁移排在启动 postgres 之前              → 失败
 *   4. 迁移用容器连接串（postgres:5432）       → 失败
 *   5. E2E 只重建 web                          → 失败
 *   6. E2E 只检查 /api/healthz                 → 失败
 *   7. 出现 /livez                             → 失败
 *   8. 失败诊断缺少 logs worker                → 失败
 *   9. 仓库里真实的 ci.yml                     → 通过（守卫确实在守当前文件）
 *
 * 运行：node scripts/test-check-ci-compose-order.mjs
 * 退出码：0 = 全部通过；1 = 有用例失败。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checker = resolve(here, 'check-ci-compose-order.mjs');
const realWorkflow = resolve(here, '../.github/workflows/ci.yml');
const root = mkdtempSync(join(tmpdir(), 'ci-order-test-'));

let failed = 0;
let passed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${name}`);
  if (detail !== undefined) {
    console.error(
      String(detail)
        .split('\n')
        .map((line) => `      ${line}`)
        .join('\n'),
    );
  }
}

/** 运行守卫，返回 { status, output }。 */
function run(file) {
  const result = spawnSync(process.execPath, [checker, file], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** 把 YAML 写进临时文件并运行守卫。 */
function runFixture(name, content) {
  const file = join(root, `${name}.yml`);
  writeFileSync(file, content, 'utf8');
  return run(file);
}

/** 正确的启动顺序（结构与真实 ci.yml 相同，去掉无关步骤）。 */
const GOOD = `name: CI
jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - name: 构建容器镜像
        run: docker compose -f infra/docker-compose.yml build

      - name: 启动 PostgreSQL（迁移前只起数据库）
        run: |
          set -euo pipefail
          docker compose -f infra/docker-compose.yml up -d --wait \\
            --wait-timeout 120 postgres

      - name: 对容器数据库执行迁移（宿主机连接串）
        env:
          DATABASE_URL: postgresql://novel:ci-placeholder@127.0.0.1:5432/novel?schema=public
        run: |
          set -euo pipefail
          pnpm db:deploy

      - name: 启动四个服务并等待健康
        run: |
          set -euo pipefail
          docker compose -f infra/docker-compose.yml up -d --wait --wait-timeout 300

      - name: 验证四个健康检查端点
        run: |
          set -euo pipefail
          bash scripts/verify-healthchecks.sh

      - name: 重建 web 与 worker 指向 E2E 数据库并等待双端健康
        env:
          E2E_CONTAINER_DATABASE_URL: postgresql://novel:ci-placeholder@postgres:5432/novel_e2e?schema=public
        run: |
          set -euo pipefail
          COMPOSE=(docker compose -f infra/docker-compose.yml)
          DATABASE_URL="$E2E_CONTAINER_DATABASE_URL" \\
            "\${COMPOSE[@]}" up -d --force-recreate --no-deps \\
              --wait --wait-timeout 180 web worker
          web_code="$(curl -sS -k https://localhost:8443/api/healthz || true)"
          worker_code="$(curl -sS -k https://localhost:8443/worker/healthz || true)"
          "\${COMPOSE[@]}" ps || true
          "\${COMPOSE[@]}" logs web --tail 100 || true
          "\${COMPOSE[@]}" logs worker --tail 100 || true
          "\${COMPOSE[@]}" logs postgres --tail 100 || true
`;

/** 断言替换确实生效，避免夹具静默变成「没改动的正确版本」。 */
function mutate(name, from, to) {
  if (!GOOD.includes(from)) {
    throw new Error(`夹具 ${name} 的替换源不存在：${from}`);
  }
  return GOOD.replace(from, to);
}

console.log('CI 启动顺序守卫 —— 行为测试');
console.log(`夹具目录：${root}`);

try {
  // ---------- 用例 1：正确顺序 ----------
  {
    const { status, output } = runFixture('good', GOOD);
    console.log('\n[1] 正确顺序（应通过）');
    check('退出码为 0', status === 0, `实际 status=${status}\n${output}`);
    check('输出包含"守卫通过"', output.includes('CI 启动顺序守卫通过'), output);
  }

  // ---------- 用例 2：缺少「只启动 postgres」 ----------
  {
    const fixture = mutate(
      'no-postgres-step',
      `      - name: 启动 PostgreSQL（迁移前只起数据库）
        run: |
          set -euo pipefail
          docker compose -f infra/docker-compose.yml up -d --wait \\
            --wait-timeout 120 postgres

`,
      '',
    );
    const { status, output } = runFixture('no-postgres-step', fixture);
    console.log('\n[2] 缺少「只启动 postgres」（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('指出缺少只启动 postgres 的步骤', output.includes('只启动 postgres'), output);
  }

  // ---------- 用例 3：迁移排在启动 postgres 之前 ----------
  {
    const postgresStep = `      - name: 启动 PostgreSQL（迁移前只起数据库）
        run: |
          set -euo pipefail
          docker compose -f infra/docker-compose.yml up -d --wait \\
            --wait-timeout 120 postgres

`;
    const migrateStep = `      - name: 对容器数据库执行迁移（宿主机连接串）
        env:
          DATABASE_URL: postgresql://novel:ci-placeholder@127.0.0.1:5432/novel?schema=public
        run: |
          set -euo pipefail
          pnpm db:deploy

`;
    const fixture = GOOD.replace(postgresStep + migrateStep, migrateStep + postgresStep);
    const { status, output } = runFixture('migrate-before-postgres', fixture);
    console.log('\n[3] 迁移排在启动 postgres 之前（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('指出顺序错误', output.includes('先启动 postgres，再执行迁移'), output);
  }

  // ---------- 用例 4：迁移用容器连接串 ----------
  {
    const fixture = mutate(
      'migrate-container-url',
      'DATABASE_URL: postgresql://novel:ci-placeholder@127.0.0.1:5432/novel?schema=public',
      'DATABASE_URL: postgresql://novel:ci-placeholder@postgres:5432/novel?schema=public',
    );
    const { status, output } = runFixture('migrate-container-url', fixture);
    console.log('\n[4] 迁移用容器连接串（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('指出缺少 127.0.0.1', output.includes('127.0.0.1'), output);
  }

  // ---------- 用例 5：E2E 只重建 web ----------
  {
    const fixture = mutate(
      'recreate-web-only',
      '--wait --wait-timeout 180 web worker',
      '--wait --wait-timeout 180 web',
    );
    const { status, output } = runFixture('recreate-web-only', fixture);
    console.log('\n[5] E2E 只重建 web（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('指出缺少 worker', output.includes('重建命令包含 worker'), output);
  }

  // ---------- 用例 6：E2E 只检查 web 健康 ----------
  {
    const fixture = mutate(
      'health-web-only',
      '          worker_code="$(curl -sS -k https://localhost:8443/worker/healthz || true)"\n',
      '          worker_code="$web_code"\n',
    );
    const { status, output } = runFixture('health-web-only', fixture);
    console.log('\n[6] E2E 只检查 /api/healthz（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('指出缺少 /worker/healthz', output.includes('/worker/healthz'), output);
  }

  // ---------- 用例 7：出现 /livez ----------
  {
    const fixture = mutate(
      'livez',
      '          bash scripts/verify-healthchecks.sh',
      '          curl -fsS http://127.0.0.1:3001/livez && bash scripts/verify-healthchecks.sh',
    );
    const { status, output } = runFixture('livez', fixture);
    console.log('\n[7] 出现 /livez（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('指出不允许 livez', output.includes('livez'), output);
  }

  // ---------- 用例 8：诊断缺少 logs worker ----------
  {
    const fixture = mutate(
      'no-worker-logs',
      '          "${COMPOSE[@]}" logs worker --tail 100 || true\n',
      '',
    );
    const { status, output } = runFixture('no-worker-logs', fixture);
    console.log('\n[8] 失败诊断缺少 logs worker（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('指出缺少 logs worker --tail 100', output.includes('logs worker --tail 100'), output);
  }

  // ---------- 用例 9：仓库真实 ci.yml ----------
  {
    const { status, output } = run(realWorkflow);
    console.log('\n[9] 仓库真实 .github/workflows/ci.yml（应通过）');
    check('退出码为 0', status === 0, `实际 status=${status}\n${output}`);
    check('真实工作流通过守卫', output.includes('CI 启动顺序守卫通过'), output);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项。`);
if (failed > 0) {
  console.error('CI 启动顺序守卫测试失败。');
  process.exit(1);
}
console.log('CI 启动顺序守卫测试全部通过。');
