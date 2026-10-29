#!/usr/bin/env node
/**
 * 依赖许可证扫描（CI 门禁）。
 *
 * 规则（见 docs/05-architecture-and-licenses.md §6）：
 * - GPL / LGPL / AGPL / SSPL / 未注明许可证 → **直接失败**（不允许闭源分发或有传染风险）。
 * - 其余宽松许可证（MIT / Apache-2.0 / BSD / ISC 等）→ 允许，但需在清单中保留声明。
 * - 已人工审阅的例外 → 必须**绑定具体包名与版本**后放行，并记录审阅结论。
 *
 * 扫描范围：**直接依赖与传递依赖全部受检**，生产与开发分别扫描、分别出清单。
 *   - 生产依赖：pnpm licenses list --prod
 *   - 开发依赖：pnpm licenses list --dev
 *
 * 用法：
 *   node scripts/license-check.mjs [--dev]           # 校验
 *   node scripts/license-check.mjs --write [--dev]   # 同时写出清单
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

/** 明确禁止的许可证标识（大小写不敏感，按子串匹配）。 */
const FORBIDDEN_PATTERNS = ['AGPL', 'GPL', 'LGPL', 'SSPL', 'OSL', 'EUPL', 'PROPRIETARY'];

/** 允许的宽松许可证白名单。 */
const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'BlueOak-1.0.0',
  'PostgreSQL',
  'MIT-0',
]);

/**
 * 已人工审阅、允许使用的**具体包**（绑定包名与版本，不按许可证名称整体放行）。
 *
 * 键格式：`包名@版本`；值为审阅结论。
 * 新增条目必须经技术负责人确认，并写明依据。
 * 依据 docs/05-architecture-and-licenses.md §6.2。
 */
const REVIEWED_PACKAGES = new Map([
  [
    'caniuse-lite@1.0.30001820',
    '浏览器兼容性**数据集**（非可执行代码），由 browserslist 引入。' +
      'CC-BY-4.0 允许闭源分发，要求署名 → 已在清单中署名；不存在 copyleft 传染。',
  ],
]);

/** 判定许可证是否被禁止（含未知许可证）。 */
export function isForbiddenLicense(license) {
  if (typeof license !== 'string' || license.trim() === '') {
    return true; // 未知/缺失 → 禁止
  }
  const normalized = license.toUpperCase();
  return FORBIDDEN_PATTERNS.some((pattern) => normalized.includes(pattern.toUpperCase()));
}

/**
 * 拆分复合许可表达式（"MIT AND ISC"、"MIT OR Apache-2.0"）。
 * 只处理顶层 AND / OR，不处理 WITH / Exception。
 */
export function splitLicenseExpression(license) {
  return license
    .split(/\s+(?:AND|OR)\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 判定许可证是否属于已知宽松许可（支持复合许可）。 */
export function isAllowedLicense(license) {
  if (typeof license !== 'string') {
    return false;
  }
  const parts = splitLicenseExpression(license.trim());
  if (parts.length === 0) {
    return false;
  }
  return parts.every((part) => ALLOWED_LICENSES.has(part));
}

/** 判定某个具体包是否已人工审阅。 */
export function isReviewedPackage(name, version) {
  return REVIEWED_PACKAGES.has(`${name}@${version}`);
}

/**
 * 调用 pnpm licenses list。
 *
 * 为什么不使用 `shell: true`：会触发 Node 的 DEP0190 弃用警告，
 * 且在 Windows 上引入命令注入面。
 *
 * 解析方式：
 * 1. 优先用 `npm_execpath`（由 pnpm 注入，指向 pnpm 的 JS 入口），
 *    以 `node <pnpm.cjs>` 的方式调用 —— 跨平台一致，无需 shell。
 * 2. 回退到 PATH 中的 `pnpm`（Unix）/ `pnpm.cmd`（Windows）。
 */
function loadLicenses(dev) {
  const args = ['licenses', 'list', '--json', '--recursive'];
  args.push(dev ? '--dev' : '--prod');

  const execPath = process.env['npm_execpath'];
  if (execPath !== undefined && execPath.trim() !== '') {
    const raw = execFileSync(process.execPath, [execPath, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(raw);
  }

  const raw = execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

/**
 * 扫描任意 node_modules 目录（用于 pnpm deploy 产物）。
 *
 * `pnpm deploy --legacy` 会重新解析依赖、不读 workspace lockfile，
 * 因此产物中的依赖集合可能与仓库安装结果不同 —— 必须单独复扫一遍。
 */
function loadLicensesFromDir(dir) {
  const nodeModules = resolve(dir, 'node_modules');
  if (!existsSync(nodeModules)) {
    throw new Error(`未找到 ${nodeModules}`);
  }

  const grouped = {};
  const visit = (scopeDir) => {
    for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name.startsWith('.')) {
        continue;
      }
      const fullPath = resolve(scopeDir, entry.name);
      if (entry.name.startsWith('@')) {
        visit(fullPath); // scoped 包：再下一层
        continue;
      }
      const pkgJsonPath = resolve(fullPath, 'package.json');
      if (!existsSync(pkgJsonPath)) {
        continue;
      }
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        const license =
          typeof pkg.license === 'string'
            ? pkg.license
            : Array.isArray(pkg.licenses)
              ? pkg.licenses.map((l) => l.type).join(' OR ')
              : 'UNKNOWN';
        (grouped[license] ??= []).push({
          name: pkg.name,
          versions: [pkg.version],
          license,
        });
      } catch {
        // 忽略无法解析的 package.json
      }
    }
  };

  visit(nodeModules);
  return grouped;
}

function main() {
  const dev = process.argv.includes('--dev');
  const shouldWrite = process.argv.includes('--write');
  const dirIndex = process.argv.indexOf('--dir');
  const scanDir = dirIndex !== -1 ? process.argv[dirIndex + 1] : undefined;

  const scope = scanDir !== undefined ? `deploy 产物（${scanDir}）` : dev ? '开发依赖' : '生产依赖';
  const outputPath = resolve(
    repoRoot,
    dev ? 'THIRD_PARTY_LICENSES.dev.md' : 'THIRD_PARTY_LICENSES.md',
  );

  if (scanDir === undefined && !existsSync(resolve(repoRoot, 'node_modules'))) {
    console.error(
      `[license:${scope}] 未找到 node_modules，请先执行 pnpm install --frozen-lockfile`,
    );
    process.exit(1);
  }

  let grouped;
  try {
    grouped = scanDir !== undefined ? loadLicensesFromDir(scanDir) : loadLicenses(dev);
  } catch (error) {
    console.error(`[license:${scope}] 扫描失败：`, error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // pnpm 输出结构：{ "<许可证>": [ { name, versions, license, ... } ] }
  const entries = [];
  const ownPackages = [];
  for (const [licenseKey, packages] of Object.entries(grouped)) {
    for (const pkg of packages) {
      for (const version of pkg.versions ?? []) {
        // 本项目自有 workspace 包（@novel/*）不是第三方依赖：
        // 它们没有 license 字段，也不属于"分发第三方代码"的范畴，跳过。
        if (typeof pkg.name === 'string' && pkg.name.startsWith('@novel/')) {
          ownPackages.push(`${pkg.name}@${version}`);
          continue;
        }
        entries.push({
          name: pkg.name,
          version,
          license: pkg.license ?? licenseKey,
        });
      }
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  const forbidden = entries.filter((entry) => isForbiddenLicense(entry.license));
  const unreviewed = entries.filter(
    (entry) => !isForbiddenLicense(entry.license) && !isAllowedLicense(entry.license),
  );
  const reviewed = unreviewed.filter((entry) => isReviewedPackage(entry.name, entry.version));
  const unapproved = unreviewed.filter((entry) => !isReviewedPackage(entry.name, entry.version));

  if (shouldWrite) {
    const byLicense = new Map();
    for (const entry of entries) {
      if (!byLicense.has(entry.license)) {
        byLicense.set(entry.license, []);
      }
      byLicense.get(entry.license).push(`${entry.name}@${entry.version}`);
    }
    const reviewedNotes = reviewed.map(
      (entry) =>
        `- **${entry.name}@${entry.version}**（${entry.license}）：${
          REVIEWED_PACKAGES.get(`${entry.name}@${entry.version}`) ?? ''
        }`,
    );
    const lines = [
      `# 第三方依赖许可证清单（THIRD-PARTY NOTICES）— ${scope}`,
      '',
      '> 本文件由 `pnpm license:report` 自动生成，请勿手工编辑。',
      `> 数据来源：\`pnpm licenses list --json --recursive ${dev ? '--dev' : '--prod'}\`。`,
      '> 生成时间：' + new Date().toISOString(),
      '',
      `**${scope}**总数：**${entries.length}**`,
      '',
      '本项目保持**封闭源码**。以下依赖均采用允许闭源分发的宽松许可证，',
      '其原始版权与许可证声明保留在各自包内（`node_modules/<包名>/LICENSE`）。',
      '',
      '## 已人工审阅的例外（绑定具体包与版本）',
      '',
      ...(reviewedNotes.length > 0 ? reviewedNotes : ['- （无）']),
      '',
      '## 按许可证分组',
      '',
      ...[...byLicense.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([license, names]) => [
          `### ${license}`,
          '',
          ...names.sort().map((name) => `- ${name}`),
          '',
        ]),
    ];
    writeFileSync(outputPath, lines.join('\n'), 'utf8');
    console.log(`[license:${scope}] 已写出 ${outputPath}`);
  }

  if (forbidden.length > 0) {
    console.error(`\n[license:${scope}] ✗ 发现被禁止的许可证（GPL/LGPL/AGPL/SSPL/未知）：`);
    for (const entry of forbidden) {
      console.error(`  - ${entry.name}@${entry.version} → ${entry.license}`);
    }
    console.error(
      '\n[license] 依据 docs/05 §6.1：发现可能要求开源本产品的依赖，必须立即停止使用并上报。',
    );
    process.exit(1);
  }

  if (unapproved.length > 0) {
    console.error(`\n[license:${scope}] ✗ 发现未经审阅的许可证（不在白名单，也无逐包审阅记录）：`);
    for (const entry of unapproved) {
      console.error(`  - ${entry.name}@${entry.version} → ${entry.license}`);
    }
    console.error(
      '\n[license] 处理方式：移除该依赖，或经技术负责人审阅后在 scripts/license-check.mjs 的' +
        ' REVIEWED_PACKAGES 中登记「包名@版本」后放行。',
    );
    process.exit(1);
  }

  const allowedCount = entries.length - reviewed.length;
  console.log(
    `[license:${scope}] ✓ 扫描通过：${entries.length} 个第三方依赖 —— ${allowedCount} 个宽松许可` +
      (reviewed.length > 0 ? `，${reviewed.length} 个已逐包审阅（需在清单中署名）` : '') +
      '；未发现 GPL/LGPL/AGPL/SSPL/未知许可证。' +
      (ownPackages.length > 0 ? `（已排除本项目自有包 ${ownPackages.length} 个）` : ''),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
