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
# 流程（A1-4A-CI-FIX-02：迁移必须在拉起 web/worker 之前）：
#   1. 校验 compose 配置
#   2. 构建镜像（SKIP_BUILD=1 时跳过）
#   3. **只**启动 PostgreSQL 并等待健康
#   4. 用**宿主机**连接串执行迁移（127.0.0.1:${POSTGRES_PORT}）
#   5. 再启动四个服务并等待健康（此时表已存在，Worker 才会 ready）
#   6. 验证四个健康检查端点（任一失败即退出非零）
#   7. 清理本次验证创建的容器与卷
#
# 为什么不能直接 `up` 四个服务：全新数据卷里没有表，Worker 的 queueLoop 会停在
# retrying，/healthz 按 readiness 返回 503，`up --wait` 会一直等到超时。
# 这是启动顺序问题，**不要**通过放宽 /healthz（或改用 livez）来"解决"。
#
# 连接串（两份，职责不同）：
#   DATABASE_URL       容器内服务用的连接串，必须走服务名 `postgres:5432`；
#   HOST_DATABASE_URL  只在执行 `pnpm db:deploy` 这一条命令时用于宿主机（127.0.0.1）。
# 两者都**不会**被打印；脚本不输出明文口令。
#
# 环境变量：
#   POSTGRES_PASSWORD  数据库密码（默认仅用于本地验证的占位值）
#   POSTGRES_PORT      宿主机映射端口（默认 5432）
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

# compose 命令用**数组**：避免 `$COMPOSE ...` 的分词/通配符隐患，
# 也避免路径或项目名里出现空格时被拆开。
COMPOSE=(docker compose -p "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}")

export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-ci-placeholder}"
export POSTGRES_USER="${POSTGRES_USER:-novel}"
export POSTGRES_DB="${POSTGRES_DB:-novel}"
# 端口同时用于 compose 的端口映射与宿主机迁移连接串，保持一致。
export POSTGRES_PORT="${POSTGRES_PORT:-5432}"
# 容器内连接串：容器里 127.0.0.1 指向容器自身，必须用服务名 `postgres`。
# 密码必须与 POSTGRES_PASSWORD 一致，否则配置校验通过但数据库实际连接失败。
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public"
# 宿主机连接串：只给 `pnpm db:deploy` 这一条命令用，不 export、不打印。
HOST_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}?schema=public"
export NODE_ENV="${NODE_ENV:-production}"

cleanup() {
  local exit_code=$?
  if [ "${SKIP_CLEANUP:-0}" != "1" ]; then
    echo "=== 清理验证项目 ${COMPOSE_PROJECT_NAME}（容器 + 卷）==="
    if verify_project_name; then
      "${COMPOSE[@]}" down -v --remove-orphans || true
    fi
  else
    echo "=== 已跳过清理（SKIP_CLEANUP=1），验证项目：${COMPOSE_PROJECT_NAME} ==="
  fi
  exit "$exit_code"
}
trap cleanup EXIT

echo "=== 验证项目名：${COMPOSE_PROJECT_NAME}（与日常开发隔离）==="

echo "=== 1. 校验 compose 配置 ==="
"${COMPOSE[@]}" config --quiet
echo "compose 配置校验通过 ✓"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "=== 2. 构建镜像 ==="
  "${COMPOSE[@]}" build
else
  echo "=== 2. 已跳过镜像构建（SKIP_BUILD=1）==="
fi

echo "=== 3. 只启动 PostgreSQL 并等待健康 ==="
"${COMPOSE[@]}" up -d --wait --wait-timeout 120 postgres

echo "=== 4. 用宿主机连接串执行数据库迁移（127.0.0.1:${POSTGRES_PORT}）==="
# 只对这一条命令覆盖 DATABASE_URL：其余步骤（含 compose 插值）仍用容器连接串。
DATABASE_URL="${HOST_DATABASE_URL}" pnpm db:deploy

echo "=== 5. 启动四个服务并等待健康 ==="
"${COMPOSE[@]}" up -d --wait --wait-timeout 300
"${COMPOSE[@]}" ps

echo "=== 6. 验证健康检查端点 ==="
bash scripts/verify-healthchecks.sh

echo "=== 7. 完成 ==="
echo "本地容器栈验证全部通过 ✓"
