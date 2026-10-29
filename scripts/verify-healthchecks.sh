#!/usr/bin/env bash
#
# 健康检查端点验证脚本（可移植）。
#
# 前提：四个服务已通过 docker compose 启动：
#   docker compose -f infra/docker-compose.yml up -d --wait
#
# 本脚本对四个端点逐一发起 HTTP 请求并**校验状态码与响应体**，
# 任一端点失败即以非零状态码退出（CI 随之失败）。
#
# 端点覆盖：
#   1. web    直连      http://127.0.0.1:${WEB_PORT}/api/healthz
#   2. worker 直连      http://127.0.0.1:${WORKER_PORT}/healthz
#   3. Caddy  → web     http://127.0.0.1:${CADDY_HTTP_PORT}/api/healthz
#   4. Caddy  → worker  http://127.0.0.1:${CADDY_HTTP_PORT}/worker/healthz
#
# 环境变量：
#   WEB_PORT       默认 3000
#   WORKER_PORT    默认 3001
#   CADDY_HTTP_PORT 默认 8080
#
set -euo pipefail

WEB_PORT="${WEB_PORT:-3000}"
WORKER_PORT="${WORKER_PORT:-3001}"
CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-8080}"
HOST="${HEALTHCHECK_HOST:-127.0.0.1}"

failures=0

# 校验单个端点：HTTP 状态码必须为 200，且响应体 status 必须为 "ok"。
check_endpoint() {
  local label="$1"
  local url="$2"
  local body_file
  body_file="$(mktemp)"

  local status
  status="$(curl --silent --show-error --max-time 30 --output "$body_file" --write-out '%{http_code}' "$url" || echo '000')"

  if [ "$status" != "200" ]; then
    echo "::error::$label 失败 —— HTTP $status（期望 200）: $url"
    echo "响应体：$(cat "$body_file")"
    rm -f "$body_file"
    failures=$((failures + 1))
    return
  fi

  # 响应体应为 JSON 且 status 字段为 ok（用 node 解析，避免依赖 jq）。
  local report
  report="$(node -e '
    const fs = require("fs");
    try {
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const ok = data.status === "ok";
      const components = Array.isArray(data.components)
        ? data.components.map((c) => `${c.name}=${c.status}`).join(",")
        : "(无)";
      console.log(`${data.status ?? "(缺失)"} [${components}]`);
      process.exit(ok ? 0 : 1);
    } catch (error) {
      console.log(`(解析失败: ${error.message})`);
      process.exit(1);
    }
  ' "$body_file" || echo '(解析失败)')"

  if [ "$report" = "(解析失败)" ] || [[ "$report" != ok* ]]; then
    echo "::error::$label 失败 —— 响应体 status 不是 ok: $url"
    echo "响应体：$(cat "$body_file")"
    failures=$((failures + 1))
  else
    echo "✓ $label → HTTP 200，$report"
  fi

  rm -f "$body_file"
}

echo "=== 健康检查端点验证 ==="

check_endpoint "web 直连" "http://${HOST}:${WEB_PORT}/api/healthz"
check_endpoint "worker 直连" "http://${HOST}:${WORKER_PORT}/healthz"
check_endpoint "Caddy → web" "http://${HOST}:${CADDY_HTTP_PORT}/api/healthz"
check_endpoint "Caddy → worker" "http://${HOST}:${CADDY_HTTP_PORT}/worker/healthz"

echo
if [ "$failures" -ne 0 ]; then
  echo "::error::健康检查失败：${failures} 个端点未通过"
  exit 1
fi

echo "✓ 四个健康检查端点全部通过"
