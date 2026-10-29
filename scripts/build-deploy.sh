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
# 关于 --legacy（v1.1 记录）：
# pnpm 10 起，deploy workspace 包默认要求 inject-workspace-packages=true，
# 否则报 ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE。当前仓库未启用注入模式，
# 因此必须加 `--legacy`。
# 代价：--legacy 模式**不读取 workspace lockfile**，会重新解析依赖，
# 存在版本漂移风险。为此本脚本在 deploy 后强制执行：
#   1) 依赖版本一致性校验（与仓库安装结果对比）
#   2) 许可证复扫（产物中的依赖集合可能与仓库不同）
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

symlinks="$(find "$OUT" -type l 2>/dev/null | wc -l | tr -d ' ')"
echo "[deploy] 产物符号链接数：${symlinks}（应为 0，保证容器内可移植）"
if [ "$symlinks" != "0" ]; then
  echo "[deploy] ✗ 产物仍含符号链接，容器内将无法解析依赖" >&2
  exit 1
fi

echo "[deploy] 校验产物依赖版本与仓库是否一致……"
node scripts/check-deploy-versions.mjs "$OUT"

echo "[deploy] 对产物重新执行许可证扫描（--legacy 可能引入版本漂移）……"
node scripts/license-check.mjs --dir "$OUT"

echo "[deploy] ✓ ${APP} 产物就绪：无符号链接、版本一致、许可证合规"
