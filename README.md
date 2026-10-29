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

版本统一由 `.nvmrc` / `.node-version` / `packageManager` 固定，CI 亦使用相同版本。

## 2. 安装依赖

```bash
corepack enable                 # 启用 corepack，自动使用 packageManager 指定的 pnpm
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

四个服务：

| 服务     | 容器名         | 宿主机地址                 | 说明                                 |
| -------- | -------------- | -------------------------- | ------------------------------------ |
| postgres | novel-postgres | `127.0.0.1:5432`           | 命名卷 `novel-pgdata` 持久化         |
| web      | novel-web      | `127.0.0.1:3000`           | Next.js 16 standalone 输出           |
| worker   | novel-worker   | `127.0.0.1:3001`           | 独立 Node 进程                       |
| caddy    | novel-caddy    | `127.0.0.1:8080` / `:8443` | 本地反向代理，自签证书，**不出公网** |

所有端口均绑定 `127.0.0.1`，不对局域网/公网暴露。

### 首次启动后执行迁移

```bash
pnpm db:deploy           # 应用迁移（可重复执行，重复执行不报错）
pnpm db:status           # 查看迁移状态
```

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
pnpm compose:down        # 停止并移除容器（命名卷保留，数据不丢）
pnpm compose:down -v     # 同时删除卷 —— 会丢失数据库数据，慎用
pnpm compose:logs        # 跟随查看全部服务日志
pnpm compose:logs web    # 只看某个服务
```

本地原生进程（非容器）方式：

```bash
pnpm dev                 # 同时启动 web / worker 开发模式
```

## 7. 运行测试与质量检查

```bash
pnpm lint                # ESLint（类型感知规则）
pnpm format:check        # Prettier 格式校验
pnpm typecheck           # tsc --noEmit，全部包
pnpm test                # Vitest 单元测试
pnpm build               # 生成 Prisma Client + 构建全部包
pnpm license:check       # 依赖许可证门禁（GPL/LGPL/AGPL/SSPL/未知 → 失败）
pnpm license:report      # 生成 THIRD_PARTY_LICENSES.md
```

CI（`.github/workflows/ci.yml`）依次执行：
`pnpm install --frozen-lockfile` → `pnpm db:generate` → `format:check` → `lint` →
`typecheck` → `test` → `build` → `docker compose config` → `license:check` → `license:report`。

## 8. 许可证说明

产品保持**封闭源码**。依赖准入规则见 `docs/05-architecture-and-licenses.md` §6：

- **禁用**：GPL / LGPL / AGPL / SSPL / 未注明许可证 → CI 直接失败。
- **允许**：MIT / Apache-2.0 / BSD / ISC 等宽松许可证 → 需在 `THIRD_PARTY_LICENSES.md` 保留声明。
- **已人工审阅**：CC-BY-4.0（`caniuse-lite` 浏览器兼容数据集，要求署名，无 copyleft 传染）。

本轮门禁实际拦截并已处理的两项：

| 依赖                          | 许可证                           | 处理方式                                                                           |
| ----------------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `@img/sharp-*`（26 个平台包） | Apache-2.0 AND LGPL-3.0-or-later | 加入 `pnpm.ignoredOptionalDependencies` 排除；Next.js 回退到内置 WASM 版 sharp     |
| `elkjs`                       | EPL-2.0                          | 通过 `pnpm.overrides` 移除（来自 Next.js 可选的 `@visx` 图表依赖链，本项目不需要） |

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
│   ├── docker-compose.yml   # postgres / web / worker / caddy
│   └── docker/              # Dockerfile 与 Caddyfile
├── scripts/
│   ├── license-check.mjs    # 许可证门禁
│   └── verify-local.sh      # 本地端到端验证脚本
├── docs/                    # 七份方案文档（产品/架构/验收/许可证）
├── .github/workflows/ci.yml # CI
└── THIRD_PARTY_LICENSES.md  # 生成的第三方许可证清单
```

## 11. 回滚

```bash
git checkout <上一个提交> && pnpm install --frozen-lockfile
docker compose -f infra/docker-compose.yml down
docker compose -f infra/docker-compose.yml up -d
```

- 数据库数据保存在命名卷 `novel-pgdata` 中，`down` 不删数据，`down -v` 才删除。
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
