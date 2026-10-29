# Worker 镜像（独立 Node 进程）
#
# 构建上下文为仓库根目录（见 infra/docker-compose.yml 的 build.context）。
#
# 可移植性说明（关键）：
# pnpm 默认的 isolated linker 会创建**指向构建机绝对路径**的符号链接
# （如 node_modules/@novel/db -> /home/runner/work/xxx/packages/db），
# Docker COPY 会原样保留这些链接，容器内将无法解析 workspace 依赖。
#
# 因此这里用 `pnpm deploy --config.node-linker=hoisted` 生成
# **扁平、无符号链接**的生产依赖目录（deploy 产物 0 个符号链接），
# 运行时只依赖该目录，可随镜像整体移动。

FROM node:22.22.2-bookworm-slim AS base
ENV PNPM_HOME=/usr/local/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate

# ---------- 依赖层 ----------
FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile

# ---------- 构建层 ----------
FROM deps AS builder
WORKDIR /app
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/worker apps/worker

# 先构建库包（@novel/shared、@novel/db 的 dist 是 workspace 依赖的入口）
RUN pnpm --filter @novel/shared build \
 && pnpm --filter @novel/db generate \
 && pnpm --filter @novel/db build \
 && pnpm --filter @novel/worker build

# 生成可移植的生产依赖目录（hoisted → 无符号链接）
RUN bash scripts/build-deploy.sh @novel/worker /out

# ---------- 运行层 ----------
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV WORKER_PORT=3001

# deploy 产物：package.json + dist + 扁平 node_modules（无符号链接）
COPY --from=builder /out ./

EXPOSE 3001
CMD ["node", "dist/index.js"]
