#!/usr/bin/env node
/**
 * scripts/check-ci-compose-order.mjs 的行为测试（**不需要 Docker**）。
 *
 * A. CI 工作流夹具：
 *   1. 正确顺序                                → 通过
 *   2. 缺少「只启动 postgres」                 → 失败
 *   3. 迁移排在启动 postgres 之前              → 失败
 *   4. 迁移用容器连接串（postgres:5432）       → 失败
 *   5. E2E 只重建 web                          → 失败
 *   6. E2E 只检查 /api/healthz                 → 失败
 *   7. 出现 /livez                             → 失败
 *   8. 失败诊断缺少 logs worker                → 失败
 *   9. 仓库里真实的 ci.yml                     → 通过
 *  18. Playwright 步骤缺 DATABASE_URL          → 失败
 *  19. Playwright 用容器内 postgres:5432       → 失败
 *  20. Playwright 指向默认 novel 库            → 失败
 *  21. Playwright 使用正确的宿主机串           → 通过
 *
 * B. 本地验证脚本夹具（scripts/verify-local.sh）：
 *  10. 正确顺序                                → 通过
 *  11. 四服务 up 排在迁移之前                  → 失败
 *  12. 迁移用容器连接串                        → 失败
 *  13. 漏掉迁移                                → 失败
 *  14. 漏掉健康检查                            → 失败
 *  15. 出现 /livez                             → 失败
 *  16. export 宿主机连接串                     → 失败
 *  17. 仓库里真实的 verify-local.sh            → 通过
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
const realLocalScript = resolve(here, 'verify-local.sh');
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

/** 运行守卫，返回 { status, output }。第二个参数可指定本地脚本。 */
function run(file, script) {
  const args = [checker, file];
  if (script !== undefined) {
    args.push(script);
  }
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** 把工作流夹具写进临时文件并运行守卫（本地脚本用默认的真实文件）。 */
function runFixture(name, content) {
  const file = join(root, `${name}.yml`);
  writeFileSync(file, content, 'utf8');
  return run(file);
}

/** 把脚本夹具写进临时文件并运行守卫（工作流用真实的 ci.yml）。 */
function runScriptFixture(name, content) {
  const file = join(root, `${name}.sh`);
  writeFileSync(file, content, 'utf8');
  return run(realWorkflow, file);
}

/** Playwright 步骤应使用的宿主机连接串（库名必须与 E2E_DB_NAME 一致）。 */
const PLAYWRIGHT_DB_URL =
  'postgresql://novel:ci-placeholder@127.0.0.1:5432/novel_e2e_${{ github.run_id }}_${{ github.run_attempt }}?schema=public';

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

      - name: 浏览器 E2E（真实 Chromium，经 Caddy HTTPS）
        env:
          BASE_URL: https://localhost:8443
          DATABASE_URL: ${PLAYWRIGHT_DB_URL}
          ADMIN_EMAIL: ci-e2e@example.test
        run: pnpm --filter @novel/web exec playwright test
`;

/** 断言替换确实生效，避免夹具静默变成「没改动的正确版本」。 */
function mutate(name, from, to) {
  if (!GOOD.includes(from)) {
    throw new Error(`夹具 ${name} 的替换源不存在：${from}`);
  }
  return GOOD.replace(from, to);
}

/**
 * 正确的本地验证脚本顺序。
 *
 * 用数组 join 而不是模板字面量：脚本里满是 `${…}`，
 * 模板字面量会把它们当 JS 插值。
 */
const GOOD_LOCAL = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'COMPOSE_PROJECT_NAME="novel-verify-$$"',
  'verify_project_name() {',
  '  case "${COMPOSE_PROJECT_NAME}" in',
  '    novel-verify-*) return 0 ;;',
  '    *) return 1 ;;',
  '  esac',
  '}',
  'COMPOSE=(docker compose -p "${COMPOSE_PROJECT_NAME}" -f infra/docker-compose.yml)',
  'export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public"',
  'HOST_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}?schema=public"',
  'cleanup() {',
  '  "${COMPOSE[@]}" down -v --remove-orphans || true',
  '}',
  'trap cleanup EXIT',
  '"${COMPOSE[@]}" config --quiet',
  '"${COMPOSE[@]}" build',
  '"${COMPOSE[@]}" up -d --wait --wait-timeout 120 postgres',
  'DATABASE_URL="${HOST_DATABASE_URL}" pnpm db:deploy',
  '"${COMPOSE[@]}" up -d --wait --wait-timeout 300',
  'bash scripts/verify-healthchecks.sh',
  '',
].join('\n');

/** 本地脚本夹具替换（同样断言替换源存在）。 */
function mutateLocal(name, from, to) {
  if (!GOOD_LOCAL.includes(from)) {
    throw new Error(`本地夹具 ${name} 的替换源不存在：${from}`);
  }
  return GOOD_LOCAL.replace(from, to);
}

console.log('启动顺序守卫 —— 行为测试');
console.log(`夹具目录：${root}`);

try {
  // ---------- 用例 1：正确顺序 ----------
  {
    const { status, output } = runFixture('good', GOOD);
    console.log('\n[1] 正确顺序（应通过）');
    check('退出码为 0', status === 0, `实际 status=${status}\n${output}`);
    check('输出包含"守卫通过"', output.includes('启动顺序守卫通过'), output);
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
    check('真实工作流通过守卫', output.includes('启动顺序守卫通过'), output);
  }

  // ---------- 用例 10：本地脚本正确顺序 ----------
  {
    const { status, output } = runScriptFixture('good-local', GOOD_LOCAL);
    console.log('\n[10] verify-local.sh 正确顺序（应通过）');
    check('退出码为 0', status === 0, `实际 status=${status}\n${output}`);
    check('本地段全部通过', output.includes('启动顺序守卫通过'), output);
  }

  // ---------- 用例 11：四服务 up 排在迁移之前 ----------
  {
    const postgresUp = '"${COMPOSE[@]}" up -d --wait --wait-timeout 120 postgres';
    const migrate = 'DATABASE_URL="${HOST_DATABASE_URL}" pnpm db:deploy';
    const fullUp = '"${COMPOSE[@]}" up -d --wait --wait-timeout 300';
    const fixture = mutateLocal(
      'local-up-first',
      [postgresUp, migrate, fullUp].join('\n'),
      [fullUp, postgresUp, migrate].join('\n'),
    );
    const { status, output } = runScriptFixture('local-up-first', fixture);
    console.log('\n[11] 本地脚本：四服务 up 排在迁移之前（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('指出完整 up 应在迁移之后', output.includes('完整四服务 up 发生在迁移之后'), output);
  }

  // ---------- 用例 12：迁移用容器连接串 ----------
  {
    const fixture = mutateLocal(
      'local-container-migrate',
      'DATABASE_URL="${HOST_DATABASE_URL}" pnpm db:deploy',
      'DATABASE_URL="postgresql://novel:ci-placeholder@postgres:5432/novel?schema=public" pnpm db:deploy',
    );
    const { status, output } = runScriptFixture('local-container-migrate', fixture);
    console.log('\n[12] 本地脚本：迁移用容器连接串（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check(
      '指出迁移命令需用宿主机连接串',
      output.includes('迁移命令用宿主机连接串覆盖 DATABASE_URL'),
      output,
    );
  }

  // ---------- 用例 13：漏掉迁移 ----------
  {
    const fixture = mutateLocal(
      'local-no-migrate',
      'DATABASE_URL="${HOST_DATABASE_URL}" pnpm db:deploy\n',
      '',
    );
    const { status, output } = runScriptFixture('local-no-migrate', fixture);
    console.log('\n[13] 本地脚本：漏掉迁移（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('指出没有 db:deploy', output.includes('完整 up 之前执行过 db:deploy'), output);
  }

  // ---------- 用例 14：漏掉健康检查 ----------
  {
    const fixture = mutateLocal('local-no-health', 'bash scripts/verify-healthchecks.sh\n', '');
    const { status, output } = runScriptFixture('local-no-health', fixture);
    console.log('\n[14] 本地脚本：漏掉健康检查（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check(
      '指出没有调用 verify-healthchecks.sh',
      output.includes('调用 verify-healthchecks.sh'),
      output,
    );
  }

  // ---------- 用例 15：本地脚本出现 /livez ----------
  {
    const fixture = mutateLocal(
      'local-livez',
      'bash scripts/verify-healthchecks.sh\n',
      'curl -fsS http://127.0.0.1:3001/livez\nbash scripts/verify-healthchecks.sh\n',
    );
    const { status, output } = runScriptFixture('local-livez', fixture);
    console.log('\n[15] 本地脚本：出现 /livez（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('指出不允许 livez', output.includes('livez'), output);
  }

  // ---------- 用例 16：export 宿主机连接串 ----------
  {
    const fixture = mutateLocal(
      'local-export-host',
      'trap cleanup EXIT',
      'trap cleanup EXIT\nexport HOST_DATABASE_URL',
    );
    const { status, output } = runScriptFixture('local-export-host', fixture);
    console.log('\n[16] 本地脚本：export 宿主机连接串（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('指出宿主机连接串不应被 export', output.includes('没有被 export'), output);
  }

  // ---------- 用例 17：仓库真实 verify-local.sh ----------
  {
    const { status, output } = run(realWorkflow, realLocalScript);
    console.log('\n[17] 仓库真实 scripts/verify-local.sh（应通过）');
    check('退出码为 0', status === 0, `实际 status=${status}\n${output}`);
    check('真实本地脚本通过守卫', output.includes('启动顺序守卫通过'), output);
  }

  // ---------- 用例 18：Playwright 步骤缺 DATABASE_URL ----------
  {
    const fixture = mutate(
      'playwright-no-db',
      `          DATABASE_URL: ${PLAYWRIGHT_DB_URL}\n`,
      '',
    );
    const { status, output } = runFixture('playwright-no-db', fixture);
    console.log('\n[18] Playwright 步骤缺 DATABASE_URL（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('指出缺少 DATABASE_URL', output.includes('浏览器 E2E 步骤显式设置 DATABASE_URL'), output);
  }

  // ---------- 用例 19：Playwright 用容器内 postgres:5432 ----------
  {
    const fixture = mutate(
      'playwright-container-url',
      PLAYWRIGHT_DB_URL,
      'postgresql://novel:ci-placeholder@postgres:5432/novel_e2e_${{ github.run_id }}_${{ github.run_attempt }}?schema=public',
    );
    const { status, output } = runFixture('playwright-container-url', fixture);
    console.log('\n[19] Playwright 用容器内 postgres:5432（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check(
      '指出不能用容器主机名 postgres',
      output.includes('Playwright 连接串不使用容器内 postgres:5432'),
      output,
    );
    check('指出必须用 127.0.0.1', output.includes('Playwright 连接串使用宿主机 127.0.0.1'), output);
  }

  // ---------- 用例 20：Playwright 指向默认 novel 库 ----------
  {
    const fixture = mutate(
      'playwright-default-db',
      PLAYWRIGHT_DB_URL,
      'postgresql://novel:ci-placeholder@127.0.0.1:5432/novel?schema=public',
    );
    const { status, output } = runFixture('playwright-default-db', fixture);
    console.log('\n[20] Playwright 指向默认 novel 库（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check(
      '指出库名必须是本次 run 的 E2E 库',
      output.includes('Playwright 连接串指向本次 run 的 novel_e2e_'),
      output,
    );
    check('指出不允许默认库', output.includes('Playwright 连接串不指向默认 novel 库'), output);
  }

  // ---------- 用例 21：Playwright 使用正确的宿主机串 ----------
  {
    const { status, output } = runFixture('playwright-good', GOOD);
    console.log('\n[21] Playwright 使用正确的宿主机串（应通过）');
    check('退出码为 0', status === 0, `实际 status=${status}\n${output}`);
    check(
      '宿主机 127.0.0.1 断言通过',
      output.includes('Playwright 连接串使用宿主机 127.0.0.1'),
      output,
    );
    check('run 级 E2E 库断言通过', output.includes('指向本次 run 的 novel_e2e_'), output);
    check(
      '未使用 postgres:5432',
      output.includes('Playwright 连接串不使用容器内 postgres:5432'),
      output,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项。`);
if (failed > 0) {
  console.error('启动顺序守卫测试失败。');
  process.exit(1);
}
console.log('启动顺序守卫测试全部通过。');
