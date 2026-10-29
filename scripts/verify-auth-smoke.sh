#!/usr/bin/env bash
#
# 登录烟测（容器验收用）。
#
# 在四个容器健康之后执行，验证"真实容器内"的认证链路：
#   login（容器内 argon2 校验）→ Set-Cookie 属性 → /me 200 → logout → /me 401
#
# 用法（默认走 Caddy 的 HTTPS 入口，自签证书 → 需要 -k）：
#   BASE=https://127.0.0.1:8443 \
#   ADMIN_EMAIL=ci-admin@example.test \
#   ADMIN_INITIAL_PASSWORD='…' \
#     bash scripts/verify-auth-smoke.sh
#
# 任一步不符合预期即以非零码退出（CI 必须因此失败）。
set -euo pipefail

BASE="${BASE:-https://127.0.0.1:8443}"
ORIGIN="${ORIGIN:-$BASE}"
EMAIL="${ADMIN_EMAIL:?需要 ADMIN_EMAIL}"
PASSWORD="${ADMIN_INITIAL_PASSWORD:?需要 ADMIN_INITIAL_PASSWORD}"

WORKDIR="$(mktemp -d)"
JAR="$WORKDIR/cookies.txt"
HEADERS="$WORKDIR/headers.txt"
BODY="$WORKDIR/body.json"
trap 'rm -rf "$WORKDIR" 2>/dev/null || true' EXIT

CURL=(curl -sS -k --max-time 30)

fail() {
  echo "[smoke] ✗ $*" >&2
  if [ -s "$BODY" ]; then
    echo "[smoke]   响应体：$(head -c 300 "$BODY")" >&2
  fi
  exit 1
}

request() {
  # $1=方法 $2=路径 $3=是否带 Cookie(jar|no) $4=是否带 JSON body $5=body
  local method="$1" path="$2" use_jar="$3" with_body="${4:-no}" payload="${5:-}"
  # -c 保存 Cookie、-b 发送 Cookie：两者都需要，否则登录拿到的会话不会进入后续请求。
  local args=("${CURL[@]}" -o "$BODY" -D "$HEADERS" -c "$JAR" -w '%{http_code}' -X "$method" "$BASE$path")
  args+=(-H "origin: $ORIGIN")
  if [ "$use_jar" = "jar" ]; then
    args+=(-b "$JAR")
  fi
  if [ "$with_body" = "yes" ]; then
    args+=(-H 'content-type: application/json' -d "$payload")
  fi
  "${args[@]}"
}

echo "[smoke] 目标：$BASE（Origin: $ORIGIN）"

# ---------- 1. 登录 ----------
STATUS="$(request POST /api/auth/login jar yes "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
[ "$STATUS" = "200" ] || fail "登录应返回 200，实际 $STATUS（容器内 argon2 或数据库不可用）"
grep -qi '^set-cookie:.*novel_session=' "$HEADERS" || fail "登录未下发会话 Cookie"

COOKIE_LINE="$(grep -i '^set-cookie:' "$HEADERS" | head -1)"
for attr in HttpOnly 'SameSite=Lax' 'Path=/'; do
  echo "$COOKIE_LINE" | grep -qi "$attr" || fail "Cookie 缺少属性：$attr"
done
# Secure 仅在 HTTPS 入口下强制要求（本地 http + AUTH_COOKIE_SECURE=false 属于开发配置）
case "$BASE" in
  https://*) echo "$COOKIE_LINE" | grep -qi 'Secure' || fail "HTTPS 下 Cookie 必须带 Secure" ;;
  *) echo "[smoke] 注意：当前为 HTTP 入口，跳过 Secure 断言（仅限本地开发配置）" ;;
esac
echo "[smoke] ✓ 登录 200，Cookie 属性符合预期"

# 响应体不得包含口令
if grep -qF "$PASSWORD" "$BODY"; then
  fail "登录响应体中出现了明文口令"
fi
echo "[smoke] ✓ 登录响应不含明文口令"

# ---------- 2. /me（首登会要求强制改密） ----------
STATUS="$(request GET /api/auth/me jar)"
if [ "$STATUS" = "403" ]; then
  grep -q 'PASSWORD_CHANGE_REQUIRED' "$BODY" || fail "/me 返回 403 但原因不是 PASSWORD_CHANGE_REQUIRED"
  echo "[smoke] 首登未改密 → 符合预期地返回 403 PASSWORD_CHANGE_REQUIRED"

  NEW_PASSWORD="${SMOKE_NEW_PASSWORD:-$PASSWORD-changed}"
  STATUS="$(request POST /api/auth/change-password jar yes "{\"currentPassword\":\"$PASSWORD\",\"newPassword\":\"$NEW_PASSWORD\"}")"
  [ "$STATUS" = "200" ] || fail "改密应返回 200，实际 $STATUS"
  grep -qi '^set-cookie:.*novel_session=' "$HEADERS" || fail "改密未轮换会话 Cookie"
  echo "[smoke] ✓ 强制改密 200 且会话轮换"

  STATUS="$(request GET /api/auth/me jar)"
fi
[ "$STATUS" = "200" ] || fail "/me 应返回 200，实际 $STATUS"
grep -q "\"email\":\"$EMAIL\"" "$BODY" || fail "/me 未返回预期账号"
echo "[smoke] ✓ /me 200 且账号正确"

# ---------- 3. 退出 ----------
STATUS="$(request POST /api/auth/logout jar yes '{}')"
[ "$STATUS" = "200" ] || fail "退出应返回 200，实际 $STATUS"
grep -qi '^set-cookie:.*Max-Age=0' "$HEADERS" || fail "退出未清除 Cookie"
echo "[smoke] ✓ 退出 200 且清除 Cookie"

# ---------- 4. 退出后 /me ----------
STATUS="$(request GET /api/auth/me jar)"
[ "$STATUS" = "401" ] || fail "退出后 /me 应返回 401，实际 $STATUS"
echo "[smoke] ✓ 退出后 /me 401"

echo "[smoke] 全部通过。"
