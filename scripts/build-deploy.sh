#!/usr/bin/env bash
#
# 生成可移植的生产依赖目录（供容器镜像使用）。
#
# 为什么需要这一步：
# pnpm 默认的 isolated linker 会创建指向**构建机绝对路径**的符号链接
# （如 node_modules/@novel/db -> /home/runner/work/xxx/packages/db）。
# Docker COPY 会原样保留这些链接，容器内将无法解析 workspace 依赖。
#
# `pnpm deploy --config.node-linker=hoisted` 生成**扁平、无符号链接**的目录
# （实测产物 0 个符号链接），可随镜像整体移动。
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

symlinks="$(find "$OUT" -type l 2>/dev/null | wc -l | tr -d ' ')"
echo "[deploy] 产物符号链接数：${symlinks}（应为 0，保证容器内可移植）"
if [ "$symlinks" != "0" ]; then
  echo "[deploy] ✗ 产物仍含符号链接，容器内将无法解析依赖" >&2
  exit 1
fi
