# Web 应用镜像（Next.js 生产模式）
#
# 构建上下文为仓库根目录（见 infra/docker-compose.yml 的 build.context）。
# 该镜像只包含运行时所需产物，不包含任何密钥。
#
# 关键设计（两个坑，均已在本机实测确认）：
#
# 1. 不用 Next 的 standalone 输出：
#    standalone 的 outputFileTracing 在 pnpm monorepo 下无法追踪到 workspace 依赖
#    （@novel/shared、@novel/db 不在 standalone 内）。
#
# 2. 不用 Turbopack 构建（见 apps/web/package.json 的 `next build --webpack`）：
#    Turbopack 会对 pnpm 布局的外部包生成带 hash 的引用（如 pg-<hash>），
#    并把实体放在 .next/node_modules/ —— 该目录会被 pnpm deploy 跳过，
#    容器内运行时将报 "Cannot find module 'pg-<hash>'"。
#
# 因此改用 `pnpm deploy --config.node-linker=hoisted` 生成
# 扁平的生产依赖目录：第三方依赖与 workspace 包均为实体目录，仅保留
# `node_modules/.bin/` 下的相对符号链接（详见 scripts/build-deploy.sh 的校验规则），
# 配合 Webpack 构建产物 + `next start` 运行。

FROM node:22.22.2-bookworm-slim AS base
ENV PNPM_HOME=/usr/local/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate

# ---------- 依赖层 ----------
FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/works/package.json packages/works/package.json
# 用完整安装保证 workspace 内部依赖与 lockfile 一致（--frozen-lockfile 保证可复现）
RUN pnpm install --frozen-lockfile

# ---------- 构建层 ----------
FROM deps AS builder
WORKDIR /app
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/auth packages/auth
COPY packages/works packages/works
COPY apps/web apps/web
# 依赖包需先编译为 dist（web 与 worker 均以 dist 为入口）
RUN pnpm --filter @novel/shared build \
 && pnpm --filter @novel/db generate \
 && pnpm --filter @novel/db build \
 && pnpm --filter @novel/auth build \
 && pnpm --filter @novel/works build \
 && pnpm --filter @novel/web build

# 生成可移植的生产依赖目录（hoisted；校验器逐条判定链接可移植性）
RUN bash scripts/build-deploy.sh @novel/web /out

# ---------- 运行层 ----------
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# deploy 产物：package.json + 扁平 node_modules + .next 构建产物
COPY --from=builder /out ./
# 注意：apps/web/public 目录当前不存在（Next 在缺失时回退到根路径），
# 因此不 COPY 该目录，避免构建失败。

EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
