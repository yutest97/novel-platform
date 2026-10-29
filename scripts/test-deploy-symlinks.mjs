#!/usr/bin/env node
/**
 * scripts/check-deploy-symlinks.mjs 的行为测试。
 *
 * 用真实文件系统构造 5 组夹具（不做 mock），逐组断言退出码与分类结论：
 *   1. 输出目录内部的相对链接            → 通过
 *   2. 指向输出目录外部的相对链接        → 失败（reject:escape）
 *   3. 绝对路径链接                      → 失败（reject:absolute）
 *   4. 断链                              → 失败（reject:broken）
 *   5. 绝对链接 + --repair-absolute      → 用真实内容替换后通过
 *
 * 运行：node scripts/test-deploy-symlinks.mjs
 * 退出码：0 = 全部通过；1 = 有用例失败。
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checker = resolve(here, 'check-deploy-symlinks.mjs');

const root = mkdtempSync(join(tmpdir(), 'symlink-test-'));
let failed = 0;
let passed = 0;

/** 运行校验器，返回 { status, output }。 */
function run(dir, extraArgs = []) {
  const result = spawnSync(process.execPath, [checker, dir, ...extraArgs], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/** 断言辅助。 */
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

/** 创建目录（含父级）。 */
function mk(...parts) {
  const p = join(...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

/** 写文件。 */
function write(file, content = 'x') {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

/** 建符号链接；失败时报错而非静默跳过。 */
function link(target, path, type) {
  try {
    symlinkSync(target, path, type);
  } catch (error) {
    throw new Error(
      `无法创建符号链接（${path} → ${target}）：${error.code ?? error.message}。` +
        '该测试需要支持符号链接的文件系统与足够权限（Linux/macOS 默认满足；Windows 需管理员或开发者模式）。',
    );
  }
  return path;
}

console.log('符号链接分类校验器 —— 行为测试');
console.log(`夹具根目录：${root}`);

try {
  // ---------- 用例 1：输出目录内部的相对链接 → 通过 ----------
  {
    const out = mk(root, 'case1-inside', 'out');
    write(join(out, 'node_modules', 'typescript', 'bin', 'tsc'));
    write(join(out, 'node_modules', 'pkg', 'index.js'));
    mk(out, 'node_modules', '.bin');
    link('../typescript/bin/tsc', join(out, 'node_modules', '.bin', 'tsc'), 'file');
    // 注意：从 node_modules/ 出发，同级依赖的相对路径是 ./pkg/...，
    // 写成 ../pkg/... 会跳到 out/pkg（不存在）而成为断链。
    link('./pkg/index.js', join(out, 'node_modules', 'pkg-link.js'), 'file');

    const { status, output } = run(out);
    console.log('\n[1] 输出目录内部的相对链接（应通过）');
    check('退出码为 0', status === 0, `实际 status=${status}\n${output}`);
    check('分类为 allow:bin-relative', output.includes('allow:bin-relative'), output);
    check('分类为 allow:relative-inside', output.includes('allow:relative-inside'), output);
    check('打印"是否绝对路径  : 否"', output.includes('是否绝对路径  : 否'), output);
    check('打印"位于输出目录内: 是"', output.includes('位于输出目录内: 是'), output);
  }

  // ---------- 用例 2：相对链接逃逸输出目录 → 失败 ----------
  {
    const base = mk(root, 'case2-escape');
    const out = mk(base, 'out');
    mk(out, 'node_modules');
    const outside = mk(base, 'outside');
    write(join(outside, 'secret.txt'), 'should-not-be-reachable');
    link('../../outside', join(out, 'node_modules', 'evil'), 'dir');

    const { status, output } = run(out);
    console.log('\n[2] 指向输出目录外部的相对链接（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('分类为 reject:escape', output.includes('reject:escape'), output);
    check('打印"位于输出目录内: 否"', output.includes('位于输出目录内: 否'), output);
  }

  // ---------- 用例 3：绝对路径链接 → 失败 ----------
  {
    const base = mk(root, 'case3-absolute');
    const out = mk(base, 'out');
    mk(out, 'node_modules');
    const real = mk(base, 'real-pkg');
    write(join(real, 'index.js'));
    link(real, join(out, 'node_modules', 'abspkg'), 'dir');

    const { status, output } = run(out);
    console.log('\n[3] 绝对路径链接（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('分类为 reject:absolute', output.includes('reject:absolute'), output);
    check('打印"是否绝对路径  : 是"', output.includes('是否绝对路径  : 是'), output);
  }

  // ---------- 用例 4：断链 → 失败 ----------
  {
    const out = mk(root, 'case4-broken', 'out');
    mk(out, 'node_modules');
    link('../nowhere/at/all', join(out, 'node_modules', 'broken'), 'dir');

    const { status, output } = run(out);
    console.log('\n[4] 断链（应失败）');
    check('退出码为 1', status === 1, `实际 status=${status}\n${output}`);
    check('分类为 reject:broken', output.includes('reject:broken'), output);
    check('realpath 标注无法解析', output.includes('无法解析'), output);
  }

  // ---------- 用例 5：绝对链接 + --repair-absolute → 复制内容替换后通过 ----------
  {
    const base = mk(root, 'case5-repair');
    const out = mk(base, 'out');
    mk(out, 'node_modules');
    const real = mk(base, 'workspace-pkg');
    write(join(real, 'index.js'), 'console.log("copied")');
    write(join(real, 'nested', 'data.txt'), 'nested');
    const linkPath = link(real, join(out, 'node_modules', 'novel-db'), 'dir');

    const { status, output } = run(out, ['--repair-absolute']);
    console.log('\n[5] 绝对链接 + --repair-absolute（应复制内容后通过）');
    check('退出码为 0', status === 0, `实际 status=${status}\n${output}`);
    check('输出包含"已替换"', output.includes('已替换'), output);
    check('链接已被替换为实体目录', lstatSync(linkPath).isSymbolicLink() === false, '仍是符号链接');
    check('内容被真实复制（index.js）', existsSync(join(linkPath, 'index.js')), 'index.js 缺失');
    check(
      '嵌套文件也被复制',
      existsSync(join(linkPath, 'nested', 'data.txt')),
      'nested/data.txt 缺失',
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项。`);
if (failed > 0) {
  console.error('符号链接分类校验器测试失败。');
  process.exit(1);
}
console.log('符号链接分类校验器测试全部通过。');
