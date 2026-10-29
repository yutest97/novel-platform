# Worker 镜像（独立 Node 进程）
#
# 构建上下文为仓库根目录（见 infra/docker-compose.yml 的 build.context）。

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
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/worker apps/worker
RUN pnpm --filter @novel/shared build \
 && pnpm --filter @novel/db generate \
 && pnpm --filter @novel/db build \
 && pnpm --filter @novel/worker build

# ---------- 运行层 ----------
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV WORKER_PORT=3001

# 运行时依赖与编译产物
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma

EXPOSE 3001
CMD ["node", "apps/worker/dist/index.js"]
