#!/usr/bin/env node
/**
 * deploy 产物符号链接分类校验器。
 *
 * 背景：
 * `pnpm deploy --config.node-linker=hoisted` 会为声明了 `bin` 的包在
 * `node_modules/.bin/` 下创建**相对**符号链接（POSIX 平台），例如
 * `node_modules/.bin/tsc -> ../typescript/bin/tsc`。这类链接完全可移植，
 * 不应视为缺陷；真正致命的是**绝对路径链接**（指向构建机的
 * `/app/packages/...` 或 `/home/runner/work/...`）与**逃逸输出目录**的链接。
 *
 * 因此判定规则（按顺序短路）：
 *   1. 绝对路径链接                → 拒绝（reject:absolute）
 *   2. 断链（目标不存在）           → 拒绝（reject:broken）
 *   3. 相对链接但解析后逃逸输出目录  → 拒绝（reject:escape）
 *   4. 相对链接且目标位于输出目录内  → 允许（allow:relative-inside）
 *      - 其中位于 node_modules/.bin 的记为 allow:bin-relative
 *
 * 用法：
 *   node scripts/check-deploy-symlinks.mjs <输出目录> [--repair-absolute]
 *
 *   --repair-absolute  对**绝对路径**链接，用其解析目标的真实内容递归复制替换
 *                      （不删除依赖、不静默跳过），替换后重新扫描一次。
 *                      断链与逃逸链接不做修复，直接失败。
 *
 * 退出码：0 = 全部允许；1 = 存在被拒绝的链接。
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 判定 target 是否位于 root 之内（含 root 本身）。 */
function isInside(target, root) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 判断字符串是否为绝对路径（覆盖 POSIX / Windows 盘符 / UNC）。 */
function looksAbsolute(p) {
  return isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** 递归收集所有符号链接（不跟随链接进入目录，避免环）。 */
function collectSymlinks(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        found.push(full);
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
  return found;
}

/**
 * 分析单个符号链接。
 *
 * @returns {{path:string, rel:string, target:string, absolute:boolean,
 *            broken:boolean, resolved:string|null, inside:boolean,
 *            verdict:'allow'|'reject', reason:string}}
 */
export function classifyLink(linkPath, outputRoot) {
  const target = readlinkSync(linkPath);
  const absolute = looksAbsolute(target);
  const rel = relative(outputRoot, linkPath);

  let resolved = null;
  try {
    resolved = realpathSync(linkPath);
  } catch {
    // 断链：链接本身无法解析
    resolved = null;
  }

  const broken = resolved === null;
  const inside = broken ? false : isInside(resolved, outputRoot);

  let verdict = 'allow';
  let reason;
  if (absolute && broken) {
    verdict = 'reject';
    reason = 'reject:absolute+broken';
  } else if (absolute) {
    verdict = 'reject';
    reason = 'reject:absolute';
  } else if (broken) {
    verdict = 'reject';
    reason = 'reject:broken';
  } else if (!inside) {
    verdict = 'reject';
    reason = 'reject:escape';
  } else if (rel.split(/[\\/]/).includes('.bin')) {
    reason = 'allow:bin-relative';
  } else {
    reason = 'allow:relative-inside';
  }

  return { path: linkPath, rel, target, absolute, broken, resolved, inside, verdict, reason };
}

/** 打印单条链接的完整分析（审查要求的 5 个字段）。 */
function printDetail(item) {
  const tag = item.verdict === 'allow' ? '允许' : '拒绝';
  console.log(`  [${tag}] ${item.rel}`);
  console.log(`         链接目标      : ${item.target}`);
  console.log(`         是否绝对路径  : ${item.absolute ? '是' : '否'}`);
  console.log(`         realpath 解析 : ${item.resolved ?? '(无法解析 → 断链)'}`);
  console.log(`         位于输出目录内: ${item.inside ? '是' : '否'}`);
  console.log(`         判定依据      : ${item.reason}`);
}

/**
 * 对绝对路径链接执行修复：用解析目标的真实内容递归复制替换链接。
 * 仅处理可解析的绝对链接；断链与逃逸链接不修复。
 */
function repairAbsolute(items) {
  const repaired = [];
  for (const item of items) {
    if (!item.absolute || item.broken || item.resolved === null) {
      continue;
    }
    if (!existsSync(item.resolved)) {
      continue;
    }
    // 二次确认：链接必须是符号链接，避免误删实体目录
    if (!lstatSync(item.path).isSymbolicLink()) {
      continue;
    }
    // 先摘除链接本身（unlink 不会触碰链接目标），再把目标真实内容复制过来。
    // 这是"用真实内容替换链接"，不是删除依赖。
    unlinkSync(item.path);
    cpSync(item.resolved, item.path, { recursive: true, dereference: true, force: true });
    repaired.push({ rel: item.rel, from: item.target, copiedFrom: item.resolved });
  }
  return repaired;
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const doRepair = args.includes('--repair-absolute');

  if (dir === undefined) {
    console.error('用法: node scripts/check-deploy-symlinks.mjs <输出目录> [--repair-absolute]');
    process.exit(2);
  }
  if (!existsSync(dir)) {
    console.error(`[symlink] ✗ 输出目录不存在：${dir}`);
    process.exit(1);
  }

  const outputRoot = realpathSync(dir);
  console.log(`[symlink] 扫描 ${outputRoot}`);

  let items = collectSymlinks(outputRoot).map((p) => classifyLink(p, outputRoot));

  if (doRepair) {
    const absolute = items.filter(
      (i) => i.reason === 'reject:absolute' || i.reason === 'reject:absolute+broken',
    );
    if (absolute.length > 0) {
      console.log(`[symlink] 发现 ${absolute.length} 个绝对路径链接，执行内容复制替换……`);
      const repaired = repairAbsolute(items);
      for (const r of repaired) {
        console.log(`         已替换: ${r.rel}（原指向 ${r.from}）← 复制自 ${r.copiedFrom}`);
      }
      // 替换后重新扫描，确保结果基于真实文件系统状态
      items = collectSymlinks(outputRoot).map((p) => classifyLink(p, outputRoot));
    }
  }

  if (items.length === 0) {
    console.log('[symlink] 产物中无符号链接。');
    return;
  }

  console.log(`[symlink] 共 ${items.length} 个符号链接，逐项分类：`);
  for (const item of items) {
    printDetail(item);
  }

  const rejected = items.filter((i) => i.verdict === 'reject');
  const allowed = items.length - rejected.length;
  const binLinks = items.filter((i) => i.reason === 'allow:bin-relative').length;

  console.log(
    `[symlink] 汇总：允许 ${allowed} 个（其中 node_modules/.bin 安全相对链接 ${binLinks} 个），` +
      `拒绝 ${rejected.length} 个。`,
  );

  if (rejected.length > 0) {
    console.error('\n[symlink] ✗ 存在不可移植的符号链接，容器内将无法解析：');
    for (const item of rejected) {
      console.error(`  - ${item.rel} → ${item.target}（${item.reason}）`);
    }
    console.error('  规则：绝对路径 / 断链 / 逃逸输出目录 一律拒绝。');
    process.exit(1);
  }

  console.log('[symlink] ✓ 全部链接均为相对路径且位于输出目录内，可随镜像整体移动。');
}

// 仅在直接执行时运行 main（被测试 import 时不触发）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
