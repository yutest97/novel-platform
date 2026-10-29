# Web 应用镜像（Next.js standalone 输出）
#
# 构建上下文为仓库根目录（见 infra/docker-compose.yml 的 build.context）。
# 该镜像只包含运行时所需产物，不包含任何密钥。

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
# 用完整安装保证 workspace 内部依赖与 lockfile 一致（--frozen-lockfile 保证可复现）
RUN pnpm install --frozen-lockfile

# ---------- 构建层 ----------
FROM deps AS builder
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/web apps/web
# 依赖包需先编译为 dist（web 与 worker 均以 dist 为入口）
RUN pnpm --filter @novel/shared build \
 && pnpm --filter @novel/db generate \
 && pnpm --filter @novel/db build \
 && pnpm --filter @novel/web build

# ---------- 运行层 ----------
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 运行所需文件：standalone 输出 + 静态资源
# 注意：apps/web/public 目录当前不存在（Next 会在缺失时回退到根路径），
# 因此不 COPY 该目录，避免构建失败。
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
