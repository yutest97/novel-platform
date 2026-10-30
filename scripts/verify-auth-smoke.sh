#!/usr/bin/env bash
#
# 登录烟测（容器验收用）。
#
# 在四个容器健康之后执行，验证"真实容器内"的认证链路：
#   login（容器内 argon2 校验）→ Set-Cookie 属性 → /me 200 → logout → /me 401
#
# 用法（默认走 Caddy 的 HTTPS 入口；自签 internal CA → 需要 -k）：
#   BASE=https://localhost:8443 \
#   ADMIN_EMAIL=ci-admin@example.test \
#   ADMIN_INITIAL_PASSWORD='…' \
#     bash scripts/verify-auth-smoke.sh
#
# 关于 `-k`：**仅**用于忽略 Caddy internal 自签 CA 的信任问题，
# 与 Cookie 的 Secure 属性无关；HTTPS 下仍强制断言 Set-Cookie 带 Secure。
#
# 关于 `--resolve/--ipv4`：把 localhost 明确解析到 IPv4 环回，
# 避免 localhost 先解析到 ::1、而 compose 端口只绑定 127.0.0.1 时握手失败。
#
# 任一步不符合预期即以非零码退出（CI 必须因此失败）。
set -euo pipefail

BASE="${BASE:-https://localhost:8443}"
ORIGIN="${ORIGIN:-$BASE}"
EMAIL="${ADMIN_EMAIL:?需要 ADMIN_EMAIL}"
PASSWORD="${ADMIN_INITIAL_PASSWORD:?需要 ADMIN_INITIAL_PASSWORD}"

WORKDIR="$(mktemp -d)"
JAR="$WORKDIR/cookies.txt"
HEADERS="$WORKDIR/headers.txt"
BODY="$WORKDIR/body.json"
trap 'rm -rf "$WORKDIR" 2>/dev/null || true' EXIT

# 从 BASE 中取出 host:port，供 --resolve 使用（仅本机回环场景）。
HOSTPORT="${BASE#*://}"
HOSTPORT="${HOSTPORT%%/*}"
HOST_ONLY="${HOSTPORT%%:*}"

CURL=(curl -sS -k --max-time 30)
if [ "$HOST_ONLY" = "localhost" ] || [ "$HOST_ONLY" = "127.0.0.1" ]; then
  RESOLVE_IP="${RESOLVE_IP:-127.0.0.1}"
  CURL+=(--ipv4 --resolve "${HOSTPORT}:${RESOLVE_IP}")
fi

fail() {
  echo "[smoke] ✗ $*" >&2
  if [ -s "$BODY" ]; then
    echo "[smoke]   响应体：$(head -c 300 "$BODY")" >&2
  fi
  exit 1
}

request() {
  # $1=方法 $2=路径 $3=是否带 Cookie(jar|no) $4=是否带 JSON body $5=body $6=jar 文件(可选)
  local method="$1" path="$2" use_jar="$3" with_body="${4:-no}" payload="${5:-}"
  local jar_file="${6:-$JAR}"
  # -c 保存 Cookie、-b 发送 Cookie：两者都需要，否则登录拿到的会话不会进入后续请求。
  local args=("${CURL[@]}" -o "$BODY" -D "$HEADERS" -c "$jar_file" -w '%{http_code}' -X "$method" "$BASE$path")
  args+=(-H "origin: $ORIGIN")
  if [ "$use_jar" = "jar" ]; then
    args+=(-b "$jar_file")
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

# ================= M1-B2 管理接口烟测 =================
AUTHOR_JAR="$WORKDIR/author-cookies.txt"
ANON_JAR="$WORKDIR/anon-cookies.txt"

# 从响应体中取第一个字段值（本脚本只用于取 id / 口令这类简单字段）
json_field() {
  grep -o "\"$1\":\"[^\"]*\"" "$BODY" | head -1 | cut -d'"' -f4
}

# ---------- 5. 管理员用改密后的口令重新登录 ----------
STATUS="$(request POST /api/auth/login jar yes "{\"email\":\"$EMAIL\",\"password\":\"$NEW_PASSWORD\"}")"
[ "$STATUS" = "200" ] || fail "管理员改密后重新登录失败（$STATUS）"
echo "[smoke] ✓ 管理员重新登录"

# ---------- 6. 创建作者（服务器生成一次性口令） ----------
AUTHOR_EMAIL="smoke-author-$(date +%s)@example.test"
STATUS="$(request POST /api/admin/users jar yes "{\"email\":\"$AUTHOR_EMAIL\"}")"
case "$STATUS" in 200|201) ;; *) fail "创建作者应返回 201，实际 $STATUS" ;; esac
if grep -qi 'passwordHash' "$BODY"; then fail "创建响应包含 passwordHash"; fi
AUTHOR_ID="$(json_field id)"
INITIAL_PASSWORD="$(json_field initialPassword)"
[ -n "$AUTHOR_ID" ] || fail "创建响应缺少 user.id"
[ -n "$INITIAL_PASSWORD" ] || fail "创建响应缺少一次性 initialPassword"
[ "${#INITIAL_PASSWORD}" -ge 20 ] || fail "初始口令长度不足 20"
echo "[smoke] ✓ 创建作者 201，一次性口令长度 ${#INITIAL_PASSWORD}，响应无哈希"

# ---------- 7. 列表：作者存在且无 passwordHash ----------
STATUS="$(request GET /api/admin/users jar no "" "$JAR")"
[ "$STATUS" = "200" ] || fail "账号列表应返回 200，实际 $STATUS"
grep -q "$AUTHOR_EMAIL" "$BODY" || fail "账号列表中没有新建的作者"
if grep -qi 'passwordHash\|tokenHash\|argon2' "$BODY"; then fail "账号列表泄露敏感字段"; fi
echo "[smoke] ✓ 列表包含作者且无哈希字段"

# ---------- 8. 作者首次登录并改密 ----------
STATUS="$(request POST /api/auth/login jar yes "{\"email\":\"$AUTHOR_EMAIL\",\"password\":\"$INITIAL_PASSWORD\"}" "$AUTHOR_JAR")"
[ "$STATUS" = "200" ] || fail "作者首次登录失败（$STATUS）"
AUTHOR_NEW_PASSWORD="${SMOKE_AUTHOR_NEW_PASSWORD:-$INITIAL_PASSWORD-a}"
STATUS="$(request POST /api/auth/change-password jar yes "{\"currentPassword\":\"$INITIAL_PASSWORD\",\"newPassword\":\"$AUTHOR_NEW_PASSWORD\"}" "$AUTHOR_JAR")"
[ "$STATUS" = "200" ] || fail "作者首登改密失败（$STATUS）"
echo "[smoke] ✓ 作者首登改密成功"

# ---------- 9. 管理员重置作者密码 → 作者旧会话失效 ----------
STATUS="$(request POST "/api/admin/users/$AUTHOR_ID/reset-password" jar yes '{}' "$JAR")"
[ "$STATUS" = "200" ] || fail "重置作者密码失败（$STATUS）"
if grep -qi 'passwordHash' "$BODY"; then fail "重置响应包含 passwordHash"; fi
RESET_PASSWORD="$(json_field newPassword)"
[ -n "$RESET_PASSWORD" ] || fail "重置响应缺少一次性 newPassword"

STATUS="$(request GET /api/auth/me jar no "" "$AUTHOR_JAR")"
[ "$STATUS" = "401" ] || fail "重置后作者旧会话应 401，实际 $STATUS"
echo "[smoke] ✓ 重置密码成功，作者旧会话 401"

# ---------- 10. 停用作者 → 作者登录 403 ----------
STATUS="$(request PATCH "/api/admin/users/$AUTHOR_ID/status" jar yes '{"status":"disabled"}' "$JAR")"
[ "$STATUS" = "200" ] || fail "停用作者失败（$STATUS）"
STATUS="$(request POST /api/auth/login nologin yes "{\"email\":\"$AUTHOR_EMAIL\",\"password\":\"$RESET_PASSWORD\"}" "$ANON_JAR")"
[ "$STATUS" = "403" ] || fail "停用后作者登录应 403，实际 $STATUS"
echo "[smoke] ✓ 停用后作者登录 403"

# ---------- 11. 启用作者 → 可重新登录 ----------
STATUS="$(request PATCH "/api/admin/users/$AUTHOR_ID/status" jar yes '{"status":"active"}' "$JAR")"
[ "$STATUS" = "200" ] || fail "启用作者失败（$STATUS）"
STATUS="$(request POST /api/auth/login nologin yes "{\"email\":\"$AUTHOR_EMAIL\",\"password\":\"$RESET_PASSWORD\"}" "$ANON_JAR")"
[ "$STATUS" = "200" ] || fail "启用后作者应能登录，实际 $STATUS"
echo "[smoke] ✓ 启用后作者可登录"

# ---------- 12. 账号上限：创建到 10 个后第 11 个失败 ----------
LIMIT_HIT=0
for index in $(seq 1 15); do
  STATUS="$(request POST /api/admin/users jar yes "{\"email\":\"smoke-bulk-${index}-$(date +%s%N)@example.test\"}" "$JAR")"
  if [ "$STATUS" = "409" ]; then
    grep -q 'USER_LIMIT_REACHED' "$BODY" || fail "上限错误码不是 USER_LIMIT_REACHED"
    LIMIT_HIT=1
    break
  fi
  [ "$STATUS" = "201" ] || fail "批量创建返回意外状态 $STATUS"
done
[ "$LIMIT_HIT" = "1" ] || fail "创建到上限后仍未返回 USER_LIMIT_REACHED"

STATUS="$(request GET /api/admin/users jar no "" "$JAR")"
ACCOUNT_COUNT="$(grep -o '\"id\":\"' "$BODY" | wc -l | tr -d ' ')"
[ "$ACCOUNT_COUNT" -le 10 ] || fail "账号总数超过 10（实际 $ACCOUNT_COUNT）"
echo "[smoke] ✓ 账号上限生效：当前 ${ACCOUNT_COUNT} 个账号，第 11 个被拒"

echo "[smoke] 全部通过。"
