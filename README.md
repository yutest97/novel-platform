# AI 小说写作平台

> 封闭源码、限定用户使用的中文 AI 小说写作 Web 系统。
> 当前阶段：**M1-A（工程骨架与持续集成）**。

本阶段**只交付工程骨架**：monorepo 结构、四个服务的容器编排、数据库连接与迁移框架、
健康检查、代码质量与许可证门禁。

**本阶段不包含**：注册/登录/会话/权限、小说业务表与 CRUD、真实模型 API 接入、模型 SDK、
玄幻规则、事实回写、生成流程。产品范围见 `docs/`，以 `docs/00-product-brief.md` 为准。

---

## 1. 本地环境要求

| 组件             | 版本                   | 说明                                                                            |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------- |
| Node.js          | **22.22.2**            | 见 `.nvmrc` / `.node-version`；`package.json` 的 `engines` 限定 `>=22.22.2 <23` |
| pnpm             | **10.34.9**            | 见 `package.json` 的 `packageManager`；由 corepack 管理                         |
| Docker + Compose | v2（`docker compose`） | 用于本地起四个服务                                                              |
| PostgreSQL       | **16**                 | 容器镜像 `postgres:16-alpine`                                                   |

版本统一由 `.nvmrc` / `.node-version` / `packageManager` 固定。
**CI 使用 `corepack prepare pnpm@10.34.9 --activate` 安装与本地完全相同的 pnpm 版本**
（`.github/workflows/ci.yml` 的 `PNPM_VERSION` 与 `packageManager` 保持一致）。

## 2. 安装依赖

```bash
corepack enable                 # 启用 corepack，自动使用 packageManager 指定的 pnpm 10.34.9
corepack prepare pnpm@10.34.9 --activate
pnpm install --frozen-lockfile  # 按 lockfile 精确安装
pnpm db:generate                # 生成 Prisma Client
```

> `pnpm install` 会跳过 `pnpm.ignoredOptionalDependencies` 中列出的包
> （`@img/sharp-*`、`@visx/*` 等）。原因见 §8 许可证说明 —— 这些包会引入 LGPL/EPL 组件。

## 3. 配置环境变量

```bash
cp .env.example .env            # .env 已被 .gitignore 排除，切勿提交
```

`.env.example` 中**只有占位符**，不含任何真实密钥。至少需要修改：

| 变量                | 说明                                                                 |
| ------------------- | -------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | 数据库密码（compose 会强制要求该项存在）                             |
| `DATABASE_URL`      | Prisma 连接串。compose 内用服务名 `postgres`；本机直连用 `127.0.0.1` |
| `MODEL_API_KEY`     | 模型密钥。**M1-A 阶段 worker 不调用模型**，留空即可                  |

> API Key 的唯一来源是环境变量 / Docker secret，**不入数据库、不入管理页面、不入日志**。

## 4. 启动服务

```bash
pnpm compose:up          # 等价于 docker compose -f infra/docker-compose.yml up -d
pnpm compose:config      # 校验 compose 配置
```

四个服务（容器名由 compose 按 `COMPOSE_PROJECT_NAME` 自动生成，不再硬编码）：

| 服务     | 容器名（默认项目）        | 宿主机地址                 | 说明                                          |
| -------- | ------------------------- | -------------------------- | --------------------------------------------- |
| postgres | novel-platform-postgres-1 | `127.0.0.1:5432`           | 命名卷 `novel-platform_pgdata` 持久化         |
| web      | novel-platform-web-1      | `127.0.0.1:3000`           | Next.js 16（**Webpack 构建** + `next start`） |
| worker   | novel-platform-worker-1   | `127.0.0.1:3001`           | 独立 Node 进程                                |
| caddy    | novel-platform-caddy-1    | `127.0.0.1:8080` / `:8443` | 本地反向代理，自签证书，**不出公网**          |

所有端口均绑定 `127.0.0.1`，不对局域网/公网暴露。

**容器运行模式默认 `production`**。如需开发模式，叠加 override 文件（不改默认值）：

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up
```

**镜像依赖布局**：web/worker 镜像不使用 Next 的 standalone 输出，
而是用 `pnpm deploy --config.node-linker=hoisted` 生成**扁平、无符号链接**的
生产依赖目录，再配合 `next build`（Webpack）产物 + `next start` 运行。
原因见 §7「容器镜像的可移植性设计」。

### 首次启动后执行数据库迁移

```bash
pnpm db:deploy           # 执行迁移（= pnpm --filter @novel/db migrate:deploy）
pnpm db:status           # 查看迁移状态
```

> `pnpm db:deploy` 调用的是 **Prisma 迁移**（`prisma migrate deploy`），
> **不是** `pnpm deploy` 包部署命令。
> 迁移要求显式设置 `DATABASE_URL`；缺失时会以非零码退出并给出明确错误，
> 不会退回到占位连接串执行迁移（保护见 `packages/db/scripts/require-database-url.mjs`）。

## 5. 健康检查地址

| 端点                                   | 返回内容                             | 失败语义                    |
| -------------------------------------- | ------------------------------------ | --------------------------- |
| `http://127.0.0.1:3000/api/healthz`    | web 应用状态 + 数据库连接状态        | 数据库不可用 → **HTTP 503** |
| `http://127.0.0.1:3001/healthz`        | worker 状态 + 数据库连接状态         | 数据库不可用 → **HTTP 503** |
| `http://127.0.0.1:8080/api/healthz`    | 经 Caddy 代理到 web                  | 同上                        |
| `http://127.0.0.1:8080/worker/healthz` | 经 Caddy 代理到 worker（前缀被剥离） | 同上                        |

响应示例：

```json
{
  "service": "web",
  "version": "0.1.0",
  "status": "ok",
  "components": [
    { "name": "app", "status": "ok", "detail": "stage=M1-A" },
    { "name": "database", "status": "ok", "detail": "连接正常", "latencyMs": 25 }
  ],
  "uptimeSeconds": 3,
  "timestamp": "2026-10-29T11:29:21.917Z",
  "stage": "M1-A"
}
```

**数据库连接失败时健康检查必须返回失败（503），不会永远返回 OK。**
该行为由 `packages/shared` 的状态聚合逻辑保证，并由 `packages/db` 的单元测试覆盖。

## 6. 停止服务与查看日志

```bash
pnpm compose:down        # 停止并移除容器，**保留数据卷**（默认，安全）
pnpm compose:reset       # 停止并移除容器，**同时删除数据卷**（会丢数据，慎用）
pnpm compose:logs        # 跟随查看全部服务日志
pnpm compose:logs web    # 只看某个服务
```

> **`compose:down`（默认）** 对应 `docker compose down --remove-orphans`，**不删卷**，
> 数据库数据得以保留。
>
> **`compose:reset`** 对应 `docker compose down -v --remove-orphans`，
> ⚠️ **会永久删除命名卷 `novel-platform_pgdata` 中的全部数据**。
> 仅在确实需要清空数据库重来时使用。

本地原生进程（非容器）方式：

```bash
pnpm dev                 # 同时启动 web / worker 开发模式
```

### 验证脚本的数据隔离

`pnpm verify:stack` 使用独立 Compose 项目名 `novel-verify-<pid>`，
其容器、网络、数据卷均带该前缀，与日常开发环境（`novel-platform_*`）完全隔离。
脚本在清理前会校验项目名必须以 `novel-verify-` 开头，否则拒绝执行——
**不会误删日常开发数据卷**。

## 7. 运行测试与质量检查

以下命令均为**可复现**的检查，CI 执行的是同一套命令：

```bash
pnpm lint                # ESLint（类型感知规则）
pnpm format:check        # Prettier 格式校验
pnpm typecheck           # tsc --noEmit，全部包
pnpm test                # Vitest 单元测试
pnpm build:packages      # 生成 Prisma Client + 构建 @novel/shared、@novel/db（产出 dist）
pnpm build:apps          # 构建 web 与 worker
pnpm build               # = build:packages + build:apps
pnpm license:check       # 生产依赖许可证门禁（GPL/LGPL/AGPL/SSPL/未知 → 失败）
pnpm license:check:dev   # 开发依赖许可证门禁（同上，独立扫描）
pnpm license:report      # 生成 THIRD_PARTY_LICENSES.md（生产依赖）
pnpm license:report:dev  # 生成 THIRD_PARTY_LICENSES.dev.md（开发依赖）
```

> **执行顺序要求**：`lint` / `typecheck` / `test` 都依赖 `@novel/shared` 与 `@novel/db`
> 的 `dist` 产物（workspace 依赖以 `dist` 为入口）。因此必须**先执行
> `pnpm build:packages`**，再执行 lint / typecheck / test。干净克隆后尤其要注意。

### 容器与健康检查验证（需要 Docker）

```bash
pnpm verify:stack        # 完整流程：compose 校验 → 构建镜像 → 启动 → 健康检查 → 清理
pnpm verify:health       # 仅验证四个健康检查端点（服务已在运行时）
```

`verify:stack` 与 CI 的 `docker` job 执行**同一套命令**，任一端点失败即以非零状态码退出。

### 容器镜像的可移植性设计

pnpm 默认的 isolated linker 会创建**指向构建机绝对路径**的符号链接
（如 `node_modules/@novel/db -> /home/runner/work/xxx/packages/db`）。
Docker `COPY` 会原样保留这些链接，容器内将无法解析 workspace 依赖。

因此镜像构建使用 `scripts/build-deploy.sh`：

```bash
pnpm --filter <应用> deploy --prod --legacy --config.node-linker=hoisted /out
```

它生成**扁平、无符号链接**的生产依赖目录（实测 0 个符号链接），可随镜像整体移动。
脚本会依次校验：符号链接数必须为 0 → 关键依赖版本与 `pnpm-lock.yaml` 一致 →
对产物重新执行许可证扫描。任一步失败即中止镜像构建。

**关于 `--legacy`**：pnpm 10 起，部署 workspace 包默认要求
`inject-workspace-packages=true`，否则报 `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`。
当前仓库未启用注入模式，因此必须使用 `--legacy`。
代价是该模式**不读取 workspace lockfile**、会重新解析依赖，存在版本漂移风险，
故用上述"版本一致性校验 + 许可证复扫"兜底。

> 另：Next 构建使用 **Webpack**（`next build --webpack`）。
> Next 16 默认的 Turbopack 会对 pnpm 布局的外部包生成带 hash 的引用
> （如 `pg-<hash>`）并把实体放在 `.next/node_modules/`——该目录会被 `pnpm deploy`
> 跳过，容器内会报 `Cannot find module 'pg-<hash>'`。

### CI 流程（`.github/workflows/ci.yml`）

**job `verify`**（质量门禁）：
`pnpm install --frozen-lockfile` → `pnpm build:packages` → `format:check`（构建前）→
`lint` → `typecheck` → `test` → `pnpm build:apps` → `format:check`（构建后）→
构建后 Git 工作区洁净检查 → `docker compose config` → `license:check` + `license:check:dev` →
`license:report` + `license:report:dev` → 上传两份许可证清单。

**job `docker`**（容器验收）：
`docker compose build` → `docker compose up -d --wait`（等待四个服务健康）→
`scripts/verify-healthchecks.sh`（校验 web / worker / Caddy→web / Caddy→worker 四个端点）→
输出容器状态与日志 → `docker compose down -v --remove-orphans` 清理。

> CI 的 docker job 使用 `COMPOSE_PROJECT_NAME=novel-ci-<run_id>` 独立项目名，
> 与开发环境隔离，`down -v` 只清理该次 CI 创建的资源。
> CI 中 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 的密码**保持一致**，
> 避免"compose config 校验通过但数据库实际连接失败"。
> 容器内 `NODE_ENV=production`。
> 若 CI 环境无法运行 Docker，**不得**将该 job 标记为通过。

## 8. 许可证说明

产品保持**封闭源码**。依赖准入规则见 `docs/05-architecture-and-licenses.md` §6：

- **禁用**：GPL / LGPL / AGPL / SSPL / 未注明许可证 → CI 直接失败。
- **允许**：MIT / Apache-2.0 / BSD / ISC 等宽松许可证 → 需在清单中保留声明。
- **已人工审阅的例外**：必须**绑定具体包名与版本**（见 `scripts/license-check.mjs` 的
  `REVIEWED_PACKAGES`），并写明审阅结论；清单中同步署名。

扫描范围覆盖**直接依赖与传递依赖**，生产与开发依赖分别扫描、分别出清单：

| 清单                          | 覆盖范围                                |
| ----------------------------- | --------------------------------------- |
| `THIRD_PARTY_LICENSES.md`     | 生产依赖（`pnpm licenses list --prod`） |
| `THIRD_PARTY_LICENSES.dev.md` | 开发依赖（`pnpm licenses list --dev`）  |

当前唯一的审阅例外：`caniuse-lite@1.0.30001820`（CC-BY-4.0，浏览器兼容数据集，
要求署名、无 copyleft 传染）。

门禁已拦截并处理的三项（均已**移除**，未登记为例外）：

| 依赖                          | 许可证                           | 出现位置 | 处理方式                                                                       |
| ----------------------------- | -------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `@img/sharp-*`（26 个平台包） | Apache-2.0 AND LGPL-3.0-or-later | 生产     | `pnpm.ignoredOptionalDependencies` 排除；Next.js 回退到内置 WASM 版 sharp      |
| `elkjs`                       | EPL-2.0                          | 生产     | `pnpm.overrides` 移除（来自 Next.js 可选的 `@visx` 图表依赖链，本项目不需要）  |
| `lightningcss`                | MPL-2.0                          | 开发     | `pnpm.overrides` 移除（来自 vite/vitest 的 CSS 处理器，本项目无 CSS 处理需求） |

**InkOS / AI_NovelGenerator 等 AGPL/GPL 项目的代码未被复制、修改或以任何形式引入本仓库。**

## 9. 常见环境问题

| 现象                                         | 原因                                                           | 处理                                                                  |
| -------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm: command not found`                    | corepack 未启用                                                | `corepack enable` 后重开终端                                          |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | pnpm 10 在非交互环境需要确认                                   | 加 `CI=true` 前缀，或设置 `confirmModulesPurge=false`                 |
| `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`          | `ignoredOptionalDependencies`/`overrides` 改动后 lockfile 过期 | `pnpm install --no-frozen-lockfile` 后提交新 lockfile                 |
| `P1001: Can't reach database server`         | 数据库未启动或 `DATABASE_URL` 主机名不对                       | compose 内用 `postgres`，本机直连用 `127.0.0.1`；先 `pnpm compose:up` |
| `the database system is starting up`         | PostgreSQL 端口已监听但尚未就绪                                | 等待数秒后重试（`pg_isready` 语义）                                   |
| web 返回 503                                 | 数据库不可达（**这是预期行为**）                               | 检查 postgres 容器状态与 `DATABASE_URL`                               |
| `ACCOUNT_LIMIT_REACHED`                      | —                                                              | M1-A 阶段不涉及账号体系                                               |
| 端口被占用                                   | 宿主机端口冲突                                                 | 修改 `.env` 中的 `WEB_PORT` / `WORKER_PORT` / `CADDY_HTTP_PORT` 等    |
| `format:check` 报 `next-env.d.ts`            | Next 自动生成文件曾被格式化                                    | 该文件已加入 `.prettierignore`，不应出现此问题                        |
| `compose up` 后 web 一直 unhealthy           | `DATABASE_URL` 与 `POSTGRES_PASSWORD` 密码不一致               | 两者保持一致（见 `scripts/verify-local.sh` 的导出变量）               |

## 10. 目录结构

```
.
├── apps/
│   ├── web/                 # Next.js 16 + React 19（App Router）
│   │   ├── app/             # 页面与 API Route（/api/healthz）
│   │   └── src/             # web 内部逻辑（健康报告组装）
│   └── worker/              # 独立 Node Worker（/healthz）
├── packages/
│   ├── shared/              # 前后端共享类型与纯函数（健康状态逻辑）
│   └── db/                  # Prisma 迁移框架与连接（无业务表）
├── infra/
│   ├── docker-compose.yml       # postgres / web / worker / caddy（默认 production）
│   ├── docker-compose.dev.yml   # 开发模式 override（不改变默认 production）
│   └── docker/                  # Dockerfile 与 Caddyfile
├── scripts/
│   ├── license-check.mjs          # 许可证门禁（--dev 开发依赖 / --dir 扫描 deploy 产物）
│   ├── check-deploy-versions.mjs  # 校验 deploy 产物关键依赖版本与 lockfile 一致
│   ├── build-deploy.sh            # 生成可移植生产依赖（0 符号链接 + 版本/许可证校验）
│   ├── verify-healthchecks.sh     # 四个健康检查端点验证（可移植）
│   └── verify-local.sh            # 本地容器栈验证（独立项目名，与开发环境隔离）
├── docs/                    # 七份方案文档（产品/架构/验收/许可证）
├── .github/workflows/ci.yml # CI（质量门禁 + 容器验收两个 job）
├── THIRD_PARTY_LICENSES.md      # 生产依赖许可证清单（自动生成）
└── THIRD_PARTY_LICENSES.dev.md  # 开发依赖许可证清单（自动生成）
```

## 11. 回滚

```bash
git checkout <上一个提交> && pnpm install --frozen-lockfile
docker compose -f infra/docker-compose.yml down          # 保留数据卷
docker compose -f infra/docker-compose.yml up -d --wait
```

- 数据库数据保存在命名卷 `novel-platform_pgdata` 中。
  `compose:down` **不删数据**；只有 `compose:reset`（`down -v`）才会删除。
- 回滚到旧版本镜像前，建议先 `pnpm db:status` 确认迁移状态；Prisma 迁移不做自动回滚。

## 12. 相关文档

| 文档                                   | 内容                         |
| -------------------------------------- | ---------------------------- |
| `docs/00-product-brief.md`             | 产品目标、用户、范围边界     |
| `docs/01-mvp-scope.md`                 | 功能清单、优先级、阶段工期   |
| `docs/02-user-flows.md`                | 用户流程与页面清单           |
| `docs/03-data-model.md`                | 数据模型与题材解耦边界       |
| `docs/04-acceptance-tests.md`          | 验收用例与追踪矩阵           |
| `docs/05-architecture-and-licenses.md` | 架构、部署、备份、许可证准入 |
| `docs/06-open-questions.md`            | 待负责人决策的问题           |
