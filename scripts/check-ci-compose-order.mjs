#!/usr/bin/env node
/**
 * 启动顺序守卫（**不需要 Docker**）。
 *
 * 同时检查两处：CI 的 docker job 与本地容器验证脚本。
 *
 * A. `.github/workflows/ci.yml`
 *   1. 在「完整四服务 up --wait」之前，已有一步**只启动 postgres**；
 *   2. 该步之后、完整 up 之前，用**宿主机连接串（127.0.0.1）**执行过 `pnpm db:deploy`；
 *   3. 「验证四个健康检查端点」排在完整 up 之后；
 *   4. E2E 的重建命令**同时包含 web 与 worker**，且只注入容器连接串；
 *   5. E2E 就绪检查**同时**请求 `/api/healthz` 与 `/worker/healthz`；
 *   6. 失败诊断包含 ps 与三个服务的 logs；
 *   7. 全文不出现 `/livez`（不允许用 live 探针绕过 readiness）。
 *
 * B. `scripts/verify-local.sh`
 *   1. 完整四服务 up 之前，先**只启动 postgres**；
 *   2. 用宿主机连接串（127.0.0.1）执行 `pnpm db:deploy`，且该连接串只作用于这条命令
 *      （容器内的 `DATABASE_URL` 仍走服务名 `postgres:5432`，且不被 export 覆盖）；
 *   3. 完整 up 发生在迁移之后，健康检查发生在完整 up 之后；
 *   4. compose 命令使用 bash 数组，避免 `$COMPOSE` 分词；
 *   5. 不打印口令 / 连接串，清理仍限定 `novel-verify-*`；
 *   6. 全文不出现 `/livez`。
 *
 * 为什么需要它：全新数据卷上先 `up --wait` 四个服务时，表还没迁移，
 * Worker 的 queueLoop 会停在 retrying（/healthz 503），等待会挂到超时。
 * 顺序一旦被改回去，这个守卫会立刻失败。
 *
 * 用法：node scripts/check-ci-compose-order.mjs [workflow.yml] [verify-local.sh]
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultWorkflow = resolve(here, '../.github/workflows/ci.yml');
const defaultLocalScript = resolve(here, 'verify-local.sh');
const workflowPath = resolve(process.argv[2] ?? defaultWorkflow);
const localScriptPath = resolve(process.argv[3] ?? defaultLocalScript);

let failed = 0;
let passed = 0;

/** 断言辅助：通过打印 ✓，失败打印 ✗ 并计数。 */
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

/**
 * 按 `- name:` 切出步骤。
 *
 * 只做本仓库 CI 需要的最小解析：步骤体是缩进比 `- name:` 更深的连续行；
 * 遇到同级或更浅的非空行即结束（下一个 `- name:` 属于新步骤）。
 */
function parseSteps(text) {
  const lines = text.split('\n');
  const steps = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)- name:\s*(.+?)\s*$/.exec(lines[i]);
    if (match === null) {
      continue;
    }
    const indent = match[1].length;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') {
        body.push('');
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) {
        break;
      }
      body.push(line);
    }
    steps.push({ name: match[2], body: body.join('\n'), index: steps.length });
    i = j - 1;
  }
  return steps;
}

/** 去掉整行注释（注释里提到命令不应该被当成真的执行）。 */
function withoutComments(body) {
  return body
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/** 把 shell 续行（反斜杠换行）合并成一行，再按行返回。 */
function commandLines(body) {
  const joined = withoutComments(body).replace(/\\\r?\n\s*/g, ' ');
  return joined
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 完整四服务 up：没有服务名、没有 --no-deps / --force-recreate。 */
function isFullStackUp(line) {
  if (!/\bup\b/.test(line) || !/--wait\b/.test(line)) {
    return false;
  }
  if (/--no-deps|--force-recreate/.test(line)) {
    return false;
  }
  return !/\b(postgres|web|worker|caddy)\b/.test(line);
}

/** 只启动 postgres 的 up。 */
function isPostgresOnlyUp(line) {
  if (!/\bup\b/.test(line) || !/--wait\b/.test(line)) {
    return false;
  }
  if (/--no-deps|--force-recreate/.test(line)) {
    return false;
  }
  return /\bpostgres\b/.test(line) && !/\b(web|worker|caddy)\b/.test(line);
}

function describe(step) {
  return `步骤「${step.name}」（第 ${String(step.index + 1)} 步）`;
}

let text;
try {
  text = readFileSync(workflowPath, 'utf8');
} catch (error) {
  console.error(`无法读取工作流文件：${workflowPath}`);
  console.error(error.message);
  process.exit(1);
}

const steps = parseSteps(text);
console.log(`[1/2] CI 工作流：${workflowPath}`);
console.log(`      解析到 ${String(steps.length)} 个步骤。`);

if (steps.length === 0) {
  console.error('✗ 没有解析到任何步骤，工作流结构可能已变化。');
  process.exit(1);
}

// ---------- 1. 找到完整四服务 up ----------
const fullUpStep = steps.find((step) => commandLines(step.body).some(isFullStackUp));
check(
  '存在「完整四服务 up --wait」步骤',
  fullUpStep !== undefined,
  '未找到不带服务名的 `docker compose ... up -d --wait`',
);

const before = fullUpStep === undefined ? steps : steps.slice(0, fullUpStep.index);

// ---------- 2. 迁移前只启动 postgres ----------
const postgresStep = before.find((step) => commandLines(step.body).some(isPostgresOnlyUp));
check(
  '完整 up 之前有「只启动 postgres」的步骤',
  postgresStep !== undefined,
  '全新数据卷上先起 web/worker 会因缺表一直 503，必须先只起 postgres',
);

// ---------- 3. 用宿主机连接串迁移 ----------
const migrateStep = before.find(
  (step) =>
    commandLines(step.body).some((line) => line.includes('db:deploy')) &&
    withoutComments(step.body).includes('127.0.0.1'),
);
check(
  '完整 up 之前用 127.0.0.1 连接串执行过 db:deploy',
  migrateStep !== undefined,
  '宿主机上的迁移必须走 127.0.0.1:5432（容器内才用服务名 postgres）',
);

if (postgresStep !== undefined && migrateStep !== undefined) {
  check(
    '先启动 postgres，再执行迁移',
    postgresStep.index < migrateStep.index,
    `${describe(postgresStep)} 应排在 ${describe(migrateStep)} 之前`,
  );
}

// ---------- 4. 健康端点验证排在完整 up 之后 ----------
const healthStep = steps.find((step) =>
  commandLines(step.body).some((line) => line.includes('verify-healthchecks.sh')),
);
check('存在健康检查端点验证步骤', healthStep !== undefined, '未找到 verify-healthchecks.sh');
if (fullUpStep !== undefined && healthStep !== undefined) {
  check(
    '健康检查端点验证排在完整 up 之后',
    healthStep.index > fullUpStep.index,
    `${describe(healthStep)} 应排在 ${describe(fullUpStep)} 之后`,
  );
}

// ---------- 5. E2E 同时重建 web 与 worker ----------
const recreateStep = steps.find((step) =>
  commandLines(step.body).some((line) => line.includes('--force-recreate')),
);
check('存在 E2E 重建容器步骤', recreateStep !== undefined, '未找到 --force-recreate');

if (recreateStep !== undefined) {
  const recreateLine = commandLines(recreateStep.body).find((line) =>
    line.includes('--force-recreate'),
  );
  const line = recreateLine ?? '';
  check('重建命令包含 web', /\bweb\b/.test(line), `重建命令缺少 web：${line}`);
  check(
    '重建命令包含 worker（只重建 web 会让 worker 继续消费默认库）',
    /\bworker\b/.test(line),
    `重建命令缺少 worker：${line}`,
  );
  check(
    '重建使用容器内连接串 E2E_CONTAINER_DATABASE_URL',
    withoutComments(recreateStep.body).includes('E2E_CONTAINER_DATABASE_URL'),
    '重建时必须显式注入容器连接串（postgres:5432）',
  );

  const recreateBody = withoutComments(recreateStep.body);
  check(
    'E2E 就绪检查包含 /api/healthz',
    recreateBody.includes('/api/healthz'),
    '缺少 web 健康检查',
  );
  check(
    'E2E 就绪检查包含 /worker/healthz',
    recreateBody.includes('/worker/healthz'),
    '缺少 worker 健康检查（worker queueLoop 未 ready 时为 503）',
  );

  check('E2E 失败诊断包含 docker compose ps', /\bps\b/.test(recreateBody), '缺少 compose ps');
  for (const service of ['web', 'worker', 'postgres']) {
    check(
      `E2E 失败诊断包含 logs ${service} --tail 100`,
      new RegExp(`logs ${service} --tail 100`).test(recreateBody),
      `缺少 \`logs ${service} --tail 100\``,
    );
  }
}

// ---------- 6. 不允许用 live 探针绕过 readiness ----------
check(
  '工作流不出现 /livez（注释除外）',
  !/livez/i.test(withoutComments(text)),
  '不允许用 /livez 绕过 readiness：worker 未就绪时必须保持 503',
);

/* -------------------------------------------------------------------------- */
/* B. 本地验证脚本 scripts/verify-local.sh                                    */
/* -------------------------------------------------------------------------- */

let localText;
try {
  localText = readFileSync(localScriptPath, 'utf8');
} catch (error) {
  console.error(`无法读取本地验证脚本：${localScriptPath}`);
  console.error(error.message);
  process.exit(1);
}

console.log(`\n[2/2] 本地验证脚本：${localScriptPath}`);
const localLines = commandLines(localText);
const lineAt = (index) => (index === -1 ? '' : localLines[index]);

const localPostgres = localLines.findIndex((line) => isPostgresOnlyUp(line));
const localMigrate = localLines.findIndex((line) => line.includes('db:deploy'));
const localFullUp = localLines.findIndex((line) => isFullStackUp(line));
const localHealth = localLines.findIndex((line) => line.includes('verify-healthchecks.sh'));

check(
  'verify-local.sh：完整 up 之前有「只启动 postgres」',
  localPostgres !== -1,
  '全新数据卷上先起 web/worker 会因缺表一直 503，必须先只起 postgres',
);
check(
  'verify-local.sh：完整 up 之前执行过 db:deploy',
  localMigrate !== -1,
  '未找到 pnpm db:deploy',
);
check(
  'verify-local.sh：先启动 postgres，再执行迁移',
  localPostgres !== -1 && localMigrate !== -1 && localPostgres < localMigrate,
  `postgres 在第 ${String(localPostgres + 1)} 条命令，db:deploy 在第 ${String(localMigrate + 1)} 条`,
);
check(
  'verify-local.sh：完整四服务 up 发生在迁移之后',
  localMigrate !== -1 && localFullUp !== -1 && localMigrate < localFullUp,
  `db:deploy 在第 ${String(localMigrate + 1)} 条命令，完整 up 在第 ${String(localFullUp + 1)} 条`,
);
check(
  'verify-local.sh：调用 verify-healthchecks.sh',
  localHealth !== -1,
  '未找到 scripts/verify-healthchecks.sh',
);
check(
  'verify-local.sh：健康检查排在完整 up 之后',
  localFullUp !== -1 && localHealth > localFullUp,
  `完整 up 在第 ${String(localFullUp + 1)} 条命令，健康检查在第 ${String(localHealth + 1)} 条`,
);

// ---- 连接串分离：容器内用服务名，宿主机只用 127.0.0.1 跑迁移 ----
const hostUrlLine = localLines.find((line) => line.startsWith('HOST_DATABASE_URL='));
check(
  'verify-local.sh：宿主机连接串走 127.0.0.1',
  hostUrlLine !== undefined && hostUrlLine.includes('127.0.0.1'),
  hostUrlLine ?? '未找到 HOST_DATABASE_URL=... 定义',
);
check(
  'verify-local.sh：迁移命令用宿主机连接串覆盖 DATABASE_URL',
  /DATABASE_URL="\$\{HOST_DATABASE_URL\}"|DATABASE_URL="\$HOST_DATABASE_URL"|DATABASE_URL=\$HOST_DATABASE_URL/.test(
    lineAt(localMigrate),
  ),
  `迁移命令应写成 DATABASE_URL="$HOST_DATABASE_URL" pnpm db:deploy，实际：${lineAt(localMigrate)}`,
);
const exportedDb = localLines.find((line) => line.startsWith('export DATABASE_URL='));
check(
  'verify-local.sh：容器内 DATABASE_URL 仍走服务名 postgres:5432',
  exportedDb !== undefined && exportedDb.includes('@postgres:5432'),
  exportedDb ?? '未找到 export DATABASE_URL=...',
);
check(
  'verify-local.sh：宿主机连接串没有被 export（只作用于迁移命令）',
  !/export\s+HOST_DATABASE_URL/.test(localText),
  'export 会让后续步骤与 compose 插值也用宿主机串，容器内会连不上',
);

// ---- 其它安全项 ----
check(
  'verify-local.sh：compose 命令用 bash 数组（COMPOSE=(…）',
  /COMPOSE=\(/.test(localText),
  '未找到 COMPOSE=( 定义',
);
const bareCompose = localLines.filter(
  (line) => /\$\{COMPOSE\}(?!\[)/.test(line) || /(^|[^\\])\$COMPOSE(?!\[)/.test(line),
);
check(
  'verify-local.sh：没有把 compose 命令当字符串展开',
  bareCompose.length === 0,
  bareCompose.join('\n'),
);
const leakyEcho = localLines.filter(
  (line) => /^echo\b/.test(line) && /(POSTGRES_PASSWORD|DATABASE_URL)/.test(line),
);
check('verify-local.sh：不打印口令 / 连接串', leakyEcho.length === 0, leakyEcho.join('\n'));
check(
  'verify-local.sh：清理仍限定 novel-verify-*',
  localText.includes('novel-verify-*'),
  '清理保护被移除：down -v 可能误删其它项目的数据卷',
);
check(
  'verify-local.sh：不出现 /livez（注释除外）',
  !/livez/i.test(withoutComments(localText)),
  '不允许用 /livez 绕过 readiness',
);

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项。`);
if (failed > 0) {
  console.error('启动顺序守卫失败：docker 启动顺序或连接串用法被改回不安全的形式。');
  process.exit(1);
}
console.log('启动顺序守卫通过。');
