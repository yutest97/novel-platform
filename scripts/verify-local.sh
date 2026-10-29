#!/usr/bin/env bash
#
# 本地容器栈验证脚本（可移植，无硬编码路径）。
#
# 前提：本机已安装 Docker 与 Docker Compose v2。
#
# 安全设计（v1.1）：
# - 使用**独立的 Compose 项目名** `novel-verify-<pid>`，
#   容器 / 网络 / 数据卷全部带该前缀，与日常开发环境（novel-platform_*）完全隔离。
# - 清理使用 `down -v`，但**只能删除本项目**创建的资源；
#   清理前校验 COMPOSE_PROJECT_NAME 必须以 `novel-verify-` 开头，
#   否则直接拒绝执行，避免误删日常开发数据卷（如 novel-platform_pgdata）。
#
# 流程：
#   1. 校验 compose 配置
#   2. 构建镜像
#   3. 启动四个服务并等待健康
#   4. 验证四个健康检查端点（任一失败即退出非零）
#   5. 清理本次验证创建的容器与卷
#
# 环境变量：
#   POSTGRES_PASSWORD  数据库密码（默认仅用于本地验证的占位值）
#   SKIP_BUILD=1       跳过镜像构建
#   SKIP_CLEANUP=1     保留容器（便于排查）
#
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="infra/docker-compose.yml"

# ---- 独立项目名：与日常开发隔离 ----
export COMPOSE_PROJECT_NAME="novel-verify-$$"

# ---- 清理保护：只允许清理本次验证项目 ----
verify_project_name() {
  case "${COMPOSE_PROJECT_NAME}" in
    novel-verify-*)
      return 0
      ;;
    *)
      echo "拒绝执行：COMPOSE_PROJECT_NAME='${COMPOSE_PROJECT_NAME}' 不以 'novel-verify-' 开头。" >&2
      echo "本脚本只允许清理自己的验证项目，避免误删日常开发数据卷。" >&2
      return 1
      ;;
  esac
}

# 显式校验一次（清理函数内还会再校验）
verify_project_name

COMPOSE="docker compose -p ${COMPOSE_PROJECT_NAME} -f ${COMPOSE_FILE}"

export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-ci-placeholder}"
export POSTGRES_USER="${POSTGRES_USER:-novel}"
export POSTGRES_DB="${POSTGRES_DB:-novel}"
# 密码必须与 POSTGRES_PASSWORD 一致，否则配置校验通过但数据库实际连接失败。
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public"
export NODE_ENV="${NODE_ENV:-production}"

cleanup() {
  local exit_code=$?
  if [ "${SKIP_CLEANUP:-0}" != "1" ]; then
    echo "=== 清理验证项目 ${COMPOSE_PROJECT_NAME}（容器 + 卷）==="
    if verify_project_name; then
      ${COMPOSE} down -v --remove-orphans || true
    fi
  else
    echo "=== 已跳过清理（SKIP_CLEANUP=1），验证项目：${COMPOSE_PROJECT_NAME} ==="
  fi
  exit "$exit_code"
}
trap cleanup EXIT

echo "=== 验证项目名：${COMPOSE_PROJECT_NAME}（与日常开发隔离）==="

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
