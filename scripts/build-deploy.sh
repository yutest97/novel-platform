#!/usr/bin/env bash
#
# 生成可移植的生产依赖目录（供容器镜像使用）。
#
# 为什么需要这一步：
# pnpm 默认的 isolated linker 会创建指向**构建机绝对路径**的符号链接
# （如 node_modules/@novel/db -> /home/runner/work/xxx/packages/db）。
# Docker COPY 会原样保留这些链接，容器内将无法解析 workspace 依赖。
#
# `pnpm deploy --config.node-linker=hoisted` 生成扁平目录：第三方依赖与
# workspace 包都是**实体目录**，仅保留 `node_modules/.bin/` 下的
# **相对**符号链接（如 `tsc -> ../typescript/bin/tsc`）。这类链接可移植。
#
# 因此本脚本不再要求"符号链接数必须为 0"，而是逐条分类校验：
#   - 相对路径 + 解析后仍位于输出目录内 + 链接有效 → 允许
#   - 绝对路径 → 拒绝（先尝试用目标真实内容替换，替换失败即失败）
#   - 相对路径但解析后逃逸输出目录 → 拒绝
#   - 断链 → 拒绝
# 详见 scripts/check-deploy-symlinks.mjs。
#
# 关于 --legacy（v1.1 记录）：
# pnpm 10 起，deploy workspace 包默认要求 inject-workspace-packages=true，
# 否则报 ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE。当前仓库未启用注入模式，
# 因此必须加 `--legacy`。
# 代价：--legacy 模式**不读取 workspace lockfile**，会重新解析依赖，
# 存在版本漂移风险。为此本脚本在 deploy 后强制执行：
#   1) 符号链接分类校验（不可移植链接即失败）
#   2) 依赖版本一致性校验（与 pnpm-lock.yaml 对比）
#   3) 许可证复扫（产物中的依赖集合可能与仓库不同）
# 任一步失败即退出非零，阻止带风险的镜像被构建。
#
# 用法：
#   scripts/build-deploy.sh <应用名> <输出目录>
#   例：scripts/build-deploy.sh @novel/worker /out
#
set -euo pipefail

APP="${1:?用法: build-deploy.sh <应用名> <输出目录>}"
OUT="${2:?用法: build-deploy.sh <应用名> <输出目录>}"

cd "$(dirname "$0")/.."

echo "[deploy] 生成 ${APP} 的可移植生产依赖 → ${OUT}"
rm -rf "$OUT"
pnpm --filter "$APP" deploy --prod --legacy --config.node-linker=hoisted "$OUT"

echo "[deploy] 校验产物符号链接（相对路径且不逃逸输出目录才允许）……"
node scripts/check-deploy-symlinks.mjs "$OUT" --repair-absolute

echo "[deploy] 校验产物依赖版本与 pnpm-lock.yaml 是否一致……"
node scripts/check-deploy-versions.mjs "$OUT"

echo "[deploy] 对产物重新执行许可证扫描（--legacy 可能引入版本漂移）……"
node scripts/license-check.mjs --dir "$OUT"

echo "[deploy] ✓ ${APP} 产物就绪：链接可移植、版本一致、许可证合规"
