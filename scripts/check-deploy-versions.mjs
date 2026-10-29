#!/usr/bin/env node
/**
 * 校验 pnpm deploy 产物的依赖版本是否与仓库 lockfile 一致。
 *
 * 背景：`pnpm deploy` 使用 `--legacy` 模式时**不读取 workspace lockfile**，
 * 会重新解析依赖，存在版本漂移风险。若 deploy 产物中的关键包版本
 * 与 pnpm-lock.yaml / 仓库安装结果不一致，必须停止发布。
 *
 * 用法：
 *   node scripts/check-deploy-versions.mjs <deploy产物目录> [更多目录...]
 * 退出码：
 *   0 = 全部一致；1 = 存在不一致或缺少关键包
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

/** 关键运行时依赖：必须与仓库安装版本一致。 */
const CRITICAL_PACKAGES = ['next', 'react', 'react-dom', '@prisma/client', 'pg'];

/**
 * 从 pnpm-lock.yaml 解析关键依赖的版本作为基线。
 *
 * 不调用 pnpm 命令（Windows 上 spawnSync 对 pnpm.cmd 会 EINVAL），
 * 也不读 node_modules（pnpm 隔离布局把依赖放在各子包或 .pnpm 下）。
 * lockfile 中每个包以 `  <name>@<version>:` 形式出现（scoped 包带引号），
 * 同一包可能有多个带 peer 后缀的条目，取第一条（即声明版本）。
 */
function loadLockfileBaseline() {
  const lockPath = resolve(repoRoot, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) {
    throw new Error(`未找到 ${lockPath}`);
  }
  const text = readFileSync(lockPath, 'utf8');
  const baseline = new Map();

  for (const pkgName of CRITICAL_PACKAGES) {
    const escaped = pkgName.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
    const pattern = new RegExp(`^\\s+'?${escaped}@(\\d+\\.\\d+\\.\\d+[^'\\s(:]*)'?`, 'm');
    const match = pattern.exec(text);
    if (match?.[1] !== undefined) {
      baseline.set(pkgName, match[1]);
    }
  }
  return baseline;
}

/** 读取某个 node_modules 下指定包的版本。 */
function readInstalledVersion(nodeModulesDir, pkgName) {
  const pkgJsonPath = resolve(nodeModulesDir, pkgName, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return null;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 校验单个 deploy 目录。 */
function checkDir(dir, baseline) {
  const nodeModules = resolve(dir, 'node_modules');
  if (!existsSync(nodeModules)) {
    console.error(`✗ ${dir}：未找到 node_modules，deploy 产物不完整`);
    return { ok: false, rows: [] };
  }

  const rows = [];
  let ok = true;

  for (const pkgName of CRITICAL_PACKAGES) {
    const expected = baseline.get(pkgName) ?? null;
    const deployed = readInstalledVersion(nodeModules, pkgName);

    if (deployed === null) {
      // 某些应用不依赖全部关键包（例如 worker 不依赖 next/react），跳过而非失败。
      rows.push({
        pkgName,
        baseline: expected ?? '(不适用)',
        deployed: '(未安装)',
        status: 'skip',
      });
      continue;
    }

    if (expected === null) {
      rows.push({ pkgName, baseline: '(lockfile 中无)', deployed, status: 'MISMATCH' });
      ok = false;
      continue;
    }

    if (expected === deployed) {
      rows.push({ pkgName, baseline: expected, deployed, status: 'ok' });
    } else {
      rows.push({ pkgName, baseline: expected, deployed, status: 'MISMATCH' });
      ok = false;
    }
  }

  return { ok, rows };
}

function main() {
  const dirs = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  if (dirs.length === 0) {
    console.error('用法: node scripts/check-deploy-versions.mjs <deploy产物目录> [...]');
    process.exit(1);
  }

  let allOk = true;
  let baseline;
  try {
    baseline = loadLockfileBaseline();
  } catch (error) {
    console.error('✗ 无法读取 lockfile 依赖集合：', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  for (const dir of dirs) {
    console.log(`\n=== 校验 deploy 产物版本：${dir} ===`);
    const { ok, rows } = checkDir(dir, baseline);

    console.log(
      ['依赖'.padEnd(22), 'lockfile(仓库)'.padEnd(18), 'deploy 产物'.padEnd(18), '状态'].join(''),
    );
    console.log('-'.repeat(76));
    for (const row of rows) {
      console.log(
        [
          row.pkgName.padEnd(22),
          String(row.baseline).padEnd(18),
          String(row.deployed).padEnd(18),
          row.status === 'ok' ? '✓ 一致' : row.status === 'skip' ? '- 跳过' : '✗ 不一致',
        ].join(''),
      );
    }

    if (!ok) {
      console.error(`\n✗ ${dir} 存在版本漂移 —— 必须停止发布并排查。`);
      allOk = false;
    } else {
      console.log(`\n✓ ${dir} 关键依赖版本与仓库一致`);
    }
  }

  process.exit(allOk ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
