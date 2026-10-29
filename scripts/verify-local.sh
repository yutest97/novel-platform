#!/usr/bin/env bash
# M1-A 本地验证脚本（一次性跑完 postgres → 迁移 → web → worker → 健康检查 → 故障注入）
# 说明：本机无 Docker daemon，故以原生进程方式验证各服务；compose 结构另行校验。
set -uo pipefail

REPO="/e/小说开发"
PGBIN="/c/pg16/bin"
PGDATA="/c/pg16/data"
LOGDIR="/tmp/m1a-logs"
mkdir -p "$LOGDIR"

export DATABASE_URL="postgresql://novel:novel@127.0.0.1:5432/novel?schema=public"
export NODE_ENV=production
export WEB_PORT=3000
export WORKER_PORT=3001

hr() { printf '\n========== %s ==========\n' "$1"; }

hr "1. 启动 PostgreSQL 16.14"
cd /c/pg16
runas /trustlevel:0x20000 "C:\pg16\bin\postgres.exe -D C:\pg16\data -p 5432 -h 127.0.0.1" >"$LOGDIR/postgres.log" 2>&1 &
# 等待数据库真正可接受查询（仅端口监听不够：此时仍处于 "database system is starting up"）
PG_READY=0
for i in $(seq 1 60); do
  if cd "$REPO/packages/db" && node -e "
const { Client } = require('pg');
const c = new Client({ host: '127.0.0.1', port: 5432, user: 'novel', password: 'novel', database: 'postgres' });
c.connect().then(() => c.query('SELECT 1')).then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));
" 2>/dev/null; then
    PG_READY=1; echo "PostgreSQL 已就绪（等待 ${i}s）"; break
  fi
  sleep 1
done
[ "$PG_READY" = "1" ] || { echo "PostgreSQL 未在 60s 内就绪"; tail -20 "$LOGDIR/postgres.log"; exit 1; }
tail -5 "$LOGDIR/postgres.log" 2>/dev/null || true

hr "2. 创建数据库 novel"
cd "$REPO/packages/db"
node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ host: '127.0.0.1', port: 5432, user: 'novel', password: 'novel', database: 'postgres' });
  await c.connect();
  const v = await c.query('SELECT version()');
  console.log('版本: ' + v.rows[0].version.split(',')[0]);
  const ex = await c.query(\"SELECT 1 FROM pg_database WHERE datname='novel'\");
  if (ex.rowCount === 0) { await c.query('CREATE DATABASE novel OWNER novel'); console.log('已创建数据库 novel'); }
  else { console.log('数据库 novel 已存在'); }
  await c.end();
})().catch(e => { console.error('失败: ' + e.message); process.exit(1); });
"

hr "3. 执行 Prisma 迁移（可重复执行性验证）"
cd "$REPO"
echo "--- 第一次执行 migrate deploy ---"
pnpm --filter @novel/db migrate:deploy 2>&1 | tail -12
echo "--- 第二次执行 migrate deploy（幂等性）---"
pnpm --filter @novel/db migrate:deploy 2>&1 | tail -8
echo "--- 迁移状态 ---"
pnpm --filter @novel/db migrate:status 2>&1 | tail -8

hr "4. 校验数据库中无业务表"
cd "$REPO/packages/db"
node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ host: '127.0.0.1', port: 5432, user: 'novel', password: 'novel', database: 'novel' });
  await c.connect();
  const r = await c.query(\"SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name\");
  console.log('public schema 表清单: ' + JSON.stringify(r.rows.map(x => x.table_name)));
  await c.end();
})().catch(e => { console.error('失败: ' + e.message); process.exit(1); });
"

hr "5. 启动 web（Next.js standalone 生产模式，与 Docker 镜像一致）"
cd "$REPO/apps/web"
if [ -f .next/standalone/apps/web/server.js ]; then
  ( cd .next/standalone && PORT=3000 HOSTNAME=127.0.0.1 node apps/web/server.js ) >"$LOGDIR/web.log" 2>&1 &
else
  pnpm exec next start -p 3000 >"$LOGDIR/web.log" 2>&1 &
fi
WEB_PID=$!
for i in $(seq 1 40); do
  if curl -s -o /dev/null http://127.0.0.1:3000/api/healthz 2>/dev/null; then break; fi
  sleep 1
done
echo "--- web 启动日志 ---"; tail -8 "$LOGDIR/web.log"

hr "6. 启动 worker（独立 Node 进程）"
cd "$REPO/apps/worker"
node dist/index.js >"$LOGDIR/worker.log" 2>&1 &
WORKER_PID=$!
sleep 3
echo "--- worker 启动日志 ---"; tail -8 "$LOGDIR/worker.log"

hr "6.5 启动 Caddy（本地开发配置，自签证书，不出公网）"
mkdir -p /c/tmp/caddy-data /c/tmp/caddy-config
cat > /c/tmp/caddy-data/Caddyfile <<'CADDYEOF'
{
	admin off
	auto_https off
}

:80 {
	handle /api/healthz* {
		reverse_proxy 127.0.0.1:3000
	}

	handle_path /worker/* {
		reverse_proxy 127.0.0.1:3001
	}

	handle {
		reverse_proxy 127.0.0.1:3000
	}

	log {
		output stdout
		format console
	}
}
CADDYEOF
/c/gopath/bin/caddy.exe run --config /c/tmp/caddy-data/Caddyfile --adapter caddyfile >"$LOGDIR/caddy.log" 2>&1 &
CADDY_PID=$!
sleep 4
echo "--- caddy 启动日志 ---"; tail -6 "$LOGDIR/caddy.log"

hr "6.6 通过 Caddy 反向代理访问健康检查"
echo "--- Caddy :80 → web /api/healthz ---"
curl -s -w "\nHTTP_STATUS=%{http_code}\n" --max-time 15 http://127.0.0.1:80/api/healthz
echo "--- Caddy :80 → worker /worker/healthz ---"
curl -s -w "\nHTTP_STATUS=%{http_code}\n" --max-time 15 http://127.0.0.1:80/worker/healthz
echo "--- Caddy :80 → web 首页 ---"
curl -s -o /dev/null -w "HTTP_STATUS=%{http_code}\n" --max-time 15 http://127.0.0.1:80/

hr "7. 健康检查实际响应（数据库正常）"
echo "--- web /api/healthz ---"
curl -s -w "\nHTTP_STATUS=%{http_code}\n" http://127.0.0.1:3000/api/healthz
echo "--- worker /healthz ---"
curl -s -w "\nHTTP_STATUS=%{http_code}\n" http://127.0.0.1:3001/healthz

hr "8. 故障注入：停止数据库后再次检查（必须返回失败，不能永远 OK）"
cd /c/pg16
runas /trustlevel:0x20000 "C:\pg16\bin\pg_ctl.exe -D C:\pg16\data stop -m fast" >/dev/null 2>&1
sleep 4
echo "--- web /api/healthz（数据库已停止）---"
curl -s -w "\nHTTP_STATUS=%{http_code}\n" --max-time 15 http://127.0.0.1:3000/api/healthz
echo "--- worker /healthz（数据库已停止）---"
curl -s -w "\nHTTP_STATUS=%{http_code}\n" --max-time 15 http://127.0.0.1:3001/healthz

hr "9. 恢复数据库并再次确认 200"
cd /c/pg16
runas /trustlevel:0x20000 "C:\pg16\bin\postgres.exe -D C:\pg16\data -p 5432 -h 127.0.0.1" >"$LOGDIR/postgres2.log" 2>&1 &
for i in $(seq 1 30); do
  if node -e "const n=require('net');const s=n.connect(5432,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));" 2>/dev/null; then break; fi
  sleep 1
done
sleep 2
echo "--- web /api/healthz ---"
curl -s -w "\nHTTP_STATUS=%{http_code}\n" --max-time 15 http://127.0.0.1:3000/api/healthz
echo "--- worker /healthz ---"
curl -s -w "\nHTTP_STATUS=%{http_code}\n" --max-time 15 http://127.0.0.1:3001/healthz

hr "10. 停止服务"
kill $WEB_PID 2>/dev/null || true
kill $WORKER_PID 2>/dev/null || true
sleep 1
echo "服务已停止"

hr "日志文件位置"
ls -la "$LOGDIR"
