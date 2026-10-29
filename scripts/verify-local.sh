#!/usr/bin/env bash
#
# 本地容器栈验证脚本（可移植，无任何硬编码路径）。
#
# 前提：本机已安装 Docker 与 Docker Compose v2。
#
# 流程：
#   1. 校验 compose 配置
#   2. 构建镜像
#   3. 启动四个服务并等待健康
#   4. 验证四个健康检查端点（任一失败即退出非零）
#   5. 清理容器与卷
#
# 环境变量：
#   POSTGRES_PASSWORD  数据库密码（默认 ci-placeholder，仅用于本地验证）
#   SKIP_BUILD=1       跳过镜像构建
#   SKIP_CLEANUP=1     保留容器（便于排查）
#
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="infra/docker-compose.yml"
COMPOSE="docker compose -f ${COMPOSE_FILE}"

export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-ci-placeholder}"
export POSTGRES_USER="${POSTGRES_USER:-novel}"
export POSTGRES_DB="${POSTGRES_DB:-novel}"
# 密码必须与 POSTGRES_PASSWORD 一致，否则配置校验通过但数据库实际连接失败。
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public"
export NODE_ENV="${NODE_ENV:-production}"

cleanup() {
  if [ "${SKIP_CLEANUP:-0}" != "1" ]; then
    echo "=== 清理容器与卷 ==="
    ${COMPOSE} down -v --remove-orphans || true
  fi
}
trap cleanup EXIT

echo "=== 1. 校验 compose 配置 ==="
${COMPOSE} config --quiet
echo "compose 配置校验通过 ✓"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "=== 2. 构建镜像 ==="
  ${COMPOSE} build
fi

echo "=== 3. 启动四个服务并等待健康 ==="
${COMPOSE} up -d --wait --wait-timeout 300
${COMPOSE} ps

echo "=== 4. 验证健康检查端点 ==="
bash scripts/verify-healthchecks.sh

echo "=== 5. 完成 ==="
echo "本地容器栈验证全部通过 ✓"
