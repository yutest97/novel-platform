#!/usr/bin/env node
/**
 * scripts/check-deploy-versions.mjs 的行为测试。
 *
 * 用真实文件系统构造 deploy 产物夹具（不做 mock），覆盖：
 *   1. caniuse-lite 与 lockfile 同版本                → ok
 *   2. deploy 01822 / lockfile 01821                  → MISMATCH + exit 1
 *   3. web 产物缺少 caniuse-lite                      → skip（不失败）
 *   4. worker 产物不装 next / react / caniuse-lite    → 全部 skip，exit 0
 *
 * 既断言导出函数的行级结论（`checkDir` + 构造的 baseline），
 * 也断言 CLI 的真实退出码与输出。
 *
 * 运行：node scripts/test-deploy-versions.mjs
 * 退出码：0 = 全部通过；1 = 有用例失败。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CRITICAL_PACKAGES, checkDir, loadLockfileBaseline } from './check-deploy-versions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checker = resolve(here, 'check-deploy-versions.mjs');
const root = mkdtempSync(join(tmpdir(), 'deploy-version-test-'));
const baseline = loadLockfileBaseline();

let failed = 0;
let passed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
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
}

/** 按 `{ 包名: 版本 }` 生成一个带 node_modules 的 deploy 产物夹具。 */
function buildDir(name, versions) {
  const dir = join(root, name);
  const nodeModules = join(dir, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  for (const [pkgName, version] of Object.entries(versions)) {
    if (version === null || version === undefined) {
      continue;
    }
    const pkgDir = join(nodeModules, pkgName);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      `${JSON.stringify({ name: pkgName, version }, null, 2)}\n`,
      'utf8',
    );
  }
  return dir;
}

/** 全部关键包都取 lockfile 版本，再用 overrides 覆盖。 */
function versionsWith(overrides = {}) {
  const versions = {};
  for (const pkgName of CRITICAL_PACKAGES) {
    versions[pkgName] = baseline.get(pkgName) ?? '0.0.0';
  }
  return { ...versions, ...overrides };
}

function run(dir) {
  const result = spawnSync(process.execPath, [checker, dir], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function rowOf(result, pkgName) {
  return result.rows.find((row) => row.pkgName === pkgName);
}

const expectedVersion = baseline.get('caniuse-lite') ?? '';
check('lockfile 解析出 caniuse-lite 版本', expectedVersion !== '', expectedVersion);

try {
  // ---- 用例 1：同版本 → ok ----
  console.log('\n[1] caniuse-lite 与 lockfile 同版本');
  {
    const dir = buildDir('same', versionsWith());
    const result = checkDir(dir, baseline);
    const row = rowOf(result, 'caniuse-lite');
    check('整体校验通过', result.ok === true, JSON.stringify(result.rows));
    check(
      `caniuse-lite 状态为 ok（${expectedVersion}）`,
      row?.status === 'ok',
      JSON.stringify(row),
    );
    check('CLI 退出码为 0', run(dir).status === 0, `status=${String(run(dir).status)}`);
  }

  // ---- 用例 2：deploy 01822 / lockfile 01821 → MISMATCH ----
  console.log('\n[2] deploy 版本高于 lockfile（模拟 01822 vs 01821）');
  {
    const deployedVersion = '1.0.30001822';
    const staleBaseline = new Map(baseline);
    staleBaseline.set('caniuse-lite', '1.0.30001821');
    const dir = buildDir('mismatch', versionsWith({ 'caniuse-lite': deployedVersion }));

    // 行级：函数必须判定不一致（不依赖真实锁文件版本）
    const result = checkDir(dir, staleBaseline);
    const row = rowOf(result, 'caniuse-lite');
    check('整体校验失败', result.ok === false, JSON.stringify(result.rows));
    check('caniuse-lite 状态为 MISMATCH', row?.status === 'MISMATCH', JSON.stringify(row));
    check('lockfile 侧显示 01821', row?.baseline === '1.0.30001821', JSON.stringify(row));
    check('deploy 侧显示 01822', row?.deployed === deployedVersion, JSON.stringify(row));

    // CLI：真实 lockfile 为 01822，产物放 01821 → 非零退出
    const cliDir = buildDir('mismatch-cli', versionsWith({ 'caniuse-lite': '1.0.30001821' }));
    const cli = run(cliDir);
    check('CLI 退出码为 1', cli.status === 1, `status=${String(cli.status)}`);
    check('CLI 输出包含 caniuse-lite', cli.output.includes('caniuse-lite'), cli.output);
    check('CLI 输出标记不一致', cli.output.includes('不一致'), cli.output);
  }

  // ---- 用例 3：web 产物缺少 caniuse-lite → skip ----
  console.log('\n[3] web 产物缺少 caniuse-lite');
  {
    const dir = buildDir('missing', versionsWith({ 'caniuse-lite': null }));
    const result = checkDir(dir, baseline);
    const row = rowOf(result, 'caniuse-lite');
    check('整体校验仍通过', result.ok === true, JSON.stringify(result.rows));
    check('caniuse-lite 状态为 skip', row?.status === 'skip', JSON.stringify(row));
    check('deploy 侧标记为未安装', row?.deployed === '(未安装)', JSON.stringify(row));
  }

  // ---- 用例 4：worker 产物不含浏览器依赖 → 全部 skip ----
  console.log('\n[4] worker 产物（不含 next / react / react-dom / caniuse-lite）');
  {
    const dir = buildDir(
      'worker',
      versionsWith({ next: null, react: null, 'react-dom': null, 'caniuse-lite': null }),
    );
    const result = checkDir(dir, baseline);
    check('整体校验通过', result.ok === true, JSON.stringify(result.rows));
    for (const pkgName of ['next', 'react', 'react-dom', 'caniuse-lite']) {
      check(
        `${pkgName} 为 skip`,
        rowOf(result, pkgName)?.status === 'skip',
        JSON.stringify(result.rows),
      );
    }
    check('@prisma/client 仍为 ok', rowOf(result, '@prisma/client')?.status === 'ok');
    const cli = run(dir);
    check('CLI 退出码为 0', cli.status === 0, `status=${String(cli.status)}`);
    check('CLI 输出包含跳过标记', cli.output.includes('跳过'), cli.output);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
