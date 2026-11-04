# AI 小说写作平台

> 封闭源码的中文 AI 小说写作 Web 系统。当前方向：**个人可用版优先**（单作者、单实例）。
> 当前阶段：**A1-3B（章节 / 生成任务 / 候选 / 采纳 HTTP API）**。

已交付：账号/会话/审计、作品与设定中心、物品事件流水与时间线、A1-1 工作流内核、
A1-2 单章候选流水线（合同 + 正文候选）、A1-3A 候选采纳与 `chapter_versions`、
A1-3B 章节与生成任务 HTTP API（**均无章节 UI**）。
暂停：资源余额流水（M2-B4，不删除）；多用户运营后置。路线见 `docs/07-master-roadmap.md`，
工作流设计见 `docs/08-workflow-and-agents.md`。产品范围以 `docs/00-product-brief.md` 为准。

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

| 变量                     | 说明                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`      | 数据库密码（compose 会强制要求该项存在）                             |
| `DATABASE_URL`           | Prisma 连接串。compose 内用服务名 `postgres`；本机直连用 `127.0.0.1` |
| `ADMIN_EMAIL`            | 初始管理员邮箱（只在 `pnpm admin:create` 时读取，不入 Git）          |
| `ADMIN_INITIAL_PASSWORD` | 初始管理员口令（≥12 字符，不入 Git；首次登录必须改密）               |
| `AUTH_SESSION_*`         | 会话绝对/空闲有效期（默认 12 小时 / 30 分钟）                        |
| `APP_ORIGIN`             | 期望站点来源；留空则按请求 Host 同源校验                             |
| `MODEL_API_KEY`          | 模型密钥。Mock 模式可留空；OpenAI 兼容模式必须配置                   |
| `MODEL_PROVIDER`         | `mock`（默认，不联网）/ `openai-compatible`；web 与 worker 必须一致  |
| `WORKER_*`               | Worker 租约 / 心跳 / 轮询 / 清扫（见 A1-3C 章节，默认值即可）        |

> API Key 的唯一来源是环境变量 / Docker secret，**不入数据库、不入管理页面、不入日志**。
> 管理员初始口令同样只从环境变量读取，**不入 Git、不入日志、不入数据库明文**。

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
而是用 `pnpm deploy --config.node-linker=hoisted` 生成**扁平**的
生产依赖目录（第三方依赖与 workspace 包均为实体目录），再配合
`next build`（Webpack）产物 + `next start` 运行。
原因见 §7「容器镜像的可移植性设计」。

### 首次启动：先迁移，再等四服务健康

**全新数据卷**上不能直接 `pnpm compose:up`：表还没建出来，Worker 的 queueLoop 会停在
`retrying`，`/healthz` 按设计返回 **503**，`up --wait` 会一直等到超时。
正确顺序是先只起数据库、迁移完再拉起全部服务：

```bash
# 1) 只启动 PostgreSQL（迁移前不拉起 web/worker）
docker compose -f infra/docker-compose.yml up -d --wait --wait-timeout 120 postgres

# 2) 在宿主机上执行迁移：容器内用服务名 postgres，宿主机必须用 127.0.0.1
DATABASE_URL='postgresql://novel:密码@127.0.0.1:5432/novel?schema=public' pnpm db:deploy

# 3) 再启动四个服务并等待健康
pnpm compose:up   # = docker compose -f infra/docker-compose.yml up -d --wait --wait-timeout 300
```

已经迁移过的数据卷可以继续直接 `pnpm compose:up`。

```bash
pnpm db:deploy           # 执行迁移（= pnpm --filter @novel/db migrate:deploy）
pnpm db:status           # 查看迁移状态
```

> `pnpm db:deploy` 调用的是 **Prisma 迁移**（`prisma migrate deploy`），
> **不是** `pnpm deploy` 包部署命令。
> 迁移要求显式设置 `DATABASE_URL`；缺失时会以非零码退出并给出明确错误，
> 不会退回到占位连接串执行迁移（保护见 `packages/db/scripts/require-database-url.mjs`）。
>
> **迁移前 Worker 不健康是预期行为**：`/healthz` 的 readiness 语义（queue loop 未就绪
> 或数据库缺表 → 503）不会因为部署顺序而放宽。发布流程按上面的顺序执行，
> 而不是把探针改成"先绿"（不允许用 `/livez` 之类的方式绕过 readiness）。

### 创建初始管理员（一次性）

```bash
# 邮箱与口令只从环境变量 / 本地 .env 读取，不进入 Git、日志或数据库明文
ADMIN_EMAIL='admin@example.com' \
ADMIN_INITIAL_PASSWORD='至少12位的口令' \
  pnpm admin:create
```

- **不开放注册**：没有注册接口、没有自助注册页面，本命令是创建账号的唯一途径。
- 幂等：邮箱已存在时不覆盖、不改密码。
- 新账号 `must_change_password = true`：首次登录只能访问改密与退出。
- 口令以 **argon2id** 哈希入库（`$argon2id$v=19$m=19456,t=2,p=1$…`）。

### 认证接口（M1-B1）

| 接口                        | 方法 | 说明                                 |
| --------------------------- | ---- | ------------------------------------ |
| `/api/auth/login`           | POST | 邮箱 + 密码登录，成功下发会话 Cookie |
| `/api/auth/logout`          | POST | 退出并清除 Cookie（幂等）            |
| `/api/auth/me`              | GET  | 读取当前用户与会话有效期             |
| `/api/auth/change-password` | POST | 修改自己的密码，成功后**轮换会话**   |

行为约定：

| 场景                                  | 响应                                       |
| ------------------------------------- | ------------------------------------------ |
| 未登录 / 会话过期                     | `401 UNAUTHENTICATED`                      |
| 账号不存在 **或** 密码错误            | `401 INVALID_CREDENTIALS`（文案完全一致）  |
| 账号已停用                            | `403 ACCOUNT_DISABLED`（并吊销其全部会话） |
| 首登未改密时访问其它接口              | `403 PASSWORD_CHANGE_REQUIRED`             |
| 修改数据的接口缺少/伪造 `Origin`      | `403 INVALID_ORIGIN`                       |
| 登录失败超过阈值（默认 15 分钟 5 次） | `429 RATE_LIMITED`                         |

安全设计要点：

- 口令哈希：**argon2id**（m=19456 KiB, t=2, p=1），不存明文或可逆密文。
- 密码策略：**≥12 字符**、允许任意字符（不强制大小写/数字，依据 NIST SP 800-63B
  以长度为主要强度来源）；空值、与当前密码相同、示例占位值一律拒绝。
- 会话令牌：32 字节安全随机数（base64url），数据库只存 **SHA-256 哈希**。
- Cookie：`HttpOnly` + `Secure` + `SameSite=Lax` + `Path=/`。
  生产（默认 compose）`AUTH_COOKIE_SECURE=true`；仅本地用 **http** 调试时，
  叠加 `infra/docker-compose.dev.yml` 会把它设为 `false`（浏览器不会在 http 下保存
  Secure Cookie）。生产 HTTPS 环境**必须**保持 `true`。
- 会话同时具备**绝对有效期**与**空闲有效期**，每次校验都会滑动空闲期。
- 每账号最多 **5** 个活跃会话，第 6 个出现时淘汰最旧会话；
  并发建会话使用 `pg_advisory_xact_lock` 串行化，避免并发下突破上限。
- **每次请求都重新查库**校验账号状态与 `must_change_password`，不信任 Cookie 内容。
- 停用账号：立即吊销其全部会话，且后续请求返回 403。
- 管理员操作（停用/启用、重置密码）统一走**管理员治理事务**：
  事务开始先取固定 `pg_advisory_xact_lock`，再**在事务内重新读取** actor
  （存在 / `active` / `role=admin` / 已改密），随后才读目标、更新、吊销会话、写审计。
  作者 / 已停用管理员 / 不存在的操作者 / 首登未改密的管理员一律 403，且无任何副作用。
- **最后管理员保护**：停用 active admin 前统计其他 active admin，为 0 时返回稳定的
  `403 LAST_ADMIN_PROTECTED`；两个管理员并发互相停用后仍恰好保留 1 个 active admin。
- 登录失败使用统一文案，账号不存在时也执行一次等时 argon2 校验，避免时序侧信道。
- 限流额度在**进入数据库查询与 argon2 校验之前**同步预留：
  并发 20 次错误登录时只有 5 次会真正进入完整校验，其余立即 429。
- 客户端 IP **只信任** Caddy 覆盖写入的 `X-Real-IP`（见 `infra/docker/caddy/Caddyfile`）；
  应用不读取 `X-Forwarded-For`，因此伪造该头无法绕过按 IP 的限流。
- 审计为 **append-only**：数据库触发器禁止 `UPDATE` / `DELETE`，写入前对
  `detail` 脱敏（密码、令牌、密钥类字段直接丢弃）。
- 审计与业务修改**同事务**：停用/启用、重置密码、创建管理员时，
  审计写失败会连业务修改一起回滚，不会出现"改了但没审计"。

数据表：`users`、`sessions`、`audit_logs`（账号体系）、
`works`、`rule_packages`、`work_settings`（M2-A 作品核心）、
`entities`、`entity_attributes`、`entity_versions`（M2-B1 通用实体骨架）。

**不包含**章节、场景、人物、势力、功法、物品、时间线、事实等业务表，
也不包含任何模型调用相关表 —— 那些属于后续阶段。
境界体系走**通用实体**（`entity_type = 'realm_level'`），不单独建表。

### 管理接口（M1-B2）

仅管理员可用；actor 一律来自**当前会话**，不接受客户端传入 actorId。
所有写操作在 `runAdminGovernance` 事务内（固定 advisory lock → 重读 actor →
读目标/计数 → 写入 → 审计）完成。

| 接口                                  | 方法  | 说明                                     |
| ------------------------------------- | ----- | ---------------------------------------- |
| `/api/admin/users`                    | GET   | 账号列表（创建时间正序，不分页）         |
| `/api/admin/users`                    | POST  | 创建作者账号（role 固定 `author`）       |
| `/api/admin/users/:id/reset-password` | POST  | 重置指定账号密码                         |
| `/api/admin/users/:id/status`         | PATCH | 停用 / 启用（`status=active\|disabled`） |

约定：

- 列表字段固定为 `id / email / role / status / mustChangePassword / createdAt / updatedAt`，
  永不返回 `passwordHash`、会话令牌或审计详情。
- 创建：`{ email, initialPassword? }`。未提供口令时服务器生成 ≥20 字符高熵口令，
  **只在本次 201 响应中出现一次**；管理员显式提供口令时**不回显**。
  邮箱统一小写，重复返回 `409 EMAIL_TAKEN`。
- 重置：`{ newPassword? }`，同上的一次性口令规则；重置后 `mustChangePassword=true`
  并吊销该账号全部会话。
- 停用：立即吊销该账号全部会话；继续执行最后管理员保护
  （停用唯一 active admin → `403 LAST_ADMIN_PROTECTED`）。
- 账号总数上限 **10（含 disabled）**：在事务内 `count + insert`，并发创建也无法突破；
  超限返回 `409 USER_LIMIT_REACHED`。**不提供删除账号接口**。
- 未登录 `401`；非管理员 / 停用管理员 / 首登未改密管理员 `403`；
  写接口缺少或伪造 `Origin` → `403 INVALID_ORIGIN`。

审计动作：`admin.user_created`、`admin.password_reset`、`user.disabled`、`user.enabled`
（detail 只含邮箱、角色、状态变化、mustChangePassword 等非敏感信息）。

### 页面（M1-B3）

| 页面               | 说明                                                               |
| ------------------ | ------------------------------------------------------------------ |
| `/login`           | 中文登录页；无注册入口；失败统一文案；429 提示稍后重试             |
| `/change-password` | 首登/被重置后强制改密；前端校验两次一致；成功后进入角色首页        |
| `/workspace`       | 作者工作台：邮箱、角色、会话有效期、退出；仅一句"下一阶段开放"占位 |
| `/admin/users`     | 管理员账号管理：列表、新建作者、重置密码、停用/启用、退出          |

前端安全：

- 认证只依赖 **HttpOnly Cookie**，前端不读取、不存储令牌；密码只存在于组件内存，
  不写 URL / localStorage / sessionStorage / 日志；
- 所有写请求走同源 `fetch`，由浏览器自动带 `Origin`；
- 不渲染任何服务端 HTML 字符串（无 `innerHTML`），错误只按**稳定错误码**映射中文文案；
- 一次性口令用**不可关闭**的弹窗展示（仅"我已保存"可关闭），关闭即清空状态；
  刷新后无法再从接口取回；口令区域在截图时会被模糊，入库存档的截图不含可用口令；
- 守卫：未登录 → `/login`；账号停用 → `/login?reason=disabled`；
  首登未改密 → `/change-password`；作者访问管理页 → `/workspace`。

> **关于 Caddy 配置的说明**：`infra/docker/caddy/Caddyfile` 是本项目**自己的实现说明**
> （在官方 Caddy 文档之外补充的项目约定），不是 Caddy 官方文档的复制品。
> 官方语法参考 <https://caddyserver.com/docs/caddyfile>。

### 会话失效与弹窗行为（REV-01）

会话失效的统一处理集中在 `apps/web/src/lib/session-errors.ts`：

| 接口返回                   | 前端行为                          |
| -------------------------- | --------------------------------- |
| `UNAUTHENTICATED`          | 立即跳转 `/login`                 |
| `ACCOUNT_DISABLED`         | 立即跳转 `/login?reason=disabled` |
| `PASSWORD_CHANGE_REQUIRED` | 立即跳转 `/change-password`       |

- 管理页的列表 / 创建 / 重置 / 停启用请求一旦命中上述错误，**立即跳转**，
  不会只显示一行错误文本；
- 同一时刻多个并发请求同时失败时只跳转一次（1.5 秒去重窗口）；
- 工作台与管理页依据最近一次 `/api/auth/me` 返回的 `idleExpiresAt` /
  `absoluteExpiresAt`（取较早者）设置**自动退出**计时器，到期跳
  `/login?reason=expired`；
- 页面 `visibilitychange` 恢复可见或窗口重新获得焦点时，重新调用
  `/api/auth/me` 校验会话；因此清除 Cookie 后下一次交互即回到登录页。

**活跃会话续期（REV-02）**：`useRequireSession` 除了返回会话状态，还提供
`refreshSession()`。管理页在**列表加载成功、创建作者成功、重置密码成功、
停用/启用成功**之后调用它：重新读取 `/api/auth/me`，用新的
`idleExpiresAt` / `absoluteExpiresAt` 重置自动退出计时器。服务端在每次校验时
本身就会滑动空闲有效期，因此活跃的管理员不会被误踢出；若到期时间没有变化，
前端**不更新状态**（避免重复计时器与无谓重渲染）。不触发续期时，到期依旧
跳 `/login?reason=expired`。**服务端有效期配置未做任何修改。**

**改密页的错误处理**：`/change-password` 统一走 `handleSessionError`：
`ACCOUNT_DISABLED` → `/login?reason=disabled`，`UNAUTHENTICATED` → `/login`，
`PASSWORD_CHANGE_REQUIRED` 则**保持改密页**并提示「请先完成首次改密」。

弹窗（`ModalShell`）的模态隔离：

- 通过 Portal 渲染到 `body`，同时把应用根节点 `#app-root` 设为 `inert`，
  背景既不可点击也不可聚焦；
- `Tab` / `Shift+Tab` 只在弹窗内循环；
- 关闭后焦点回到打开弹窗的按钮；
- `OneTimeSecret` 仍**不能**通过 Escape、遮罩点击或关闭按钮关闭，
  只有「我已保存」可关闭；`ConfirmDialog` 保留「取消」按钮，焦点默认落在取消上。

### 作品核心（M2-A）

数据库（迁移 `packages/db/prisma/migrations/20261101000000_m2a_work_core/`）：

| 表              | 说明                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `works`         | 作品：`author_id`、`title`、`genre_rule_package`、`summary`、`target_chapters`、`target_words_per_chapter`；同一 `author_id` 下 `title` 唯一 |
| `rule_packages` | 题材规则包：`code` 唯一、`name`、`version`、`active`、`field_schema`(jsonb)；迁移内种入最小 `xuanhuan`（玄幻升级）                           |
| `work_settings` | 作品设定：`work_id + setting_key + schema_ref` 唯一，值放 jsonb                                                                              |

题材字段**不进入 works 的固定列** —— 玄幻专属字段将来放 `work_settings`，
由 `schema_ref` 区分。

API（全部只允许 active、已改密的**作者**，作者身份只从会话取）：

| 接口                       | 方法  | 说明                                                                                                                                               |
| -------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/works`               | GET   | 列出**当前作者**的作品，按更新时间倒序                                                                                                             |
| `/api/works`               | POST  | 创建作品；标题去首尾空白；章数默认 10（1—100）、单章字数默认 3000（1200—10000）；题材必须来自启用中的规则包；同作者重复标题 `409 WORK_TITLE_TAKEN` |
| `/api/works/:id`           | GET   | 作品详情 + 安全的作品设定；**非所有者一律 404**（不泄露是否存在）                                                                                  |
| `/api/works/:id`           | PATCH | 改标题/简介/两个目标值；`authorId`、`genreRulePackage`、`createdAt`、`updatedAt` 等**不可变字段**出现在请求体里一律 400（不静默忽略）              |
| `/api/works/rule-packages` | GET   | 可用题材（只返回启用中的）                                                                                                                         |

- 管理员**不能**通过作品接口读取或修改作者作品（角色不符 → 403）；
- 写接口校验 Origin；创建/更新与 `work.created` / `work.updated` 审计**同事务**
  （审计失败则业务回滚）；审计 detail 只含 workId / title / authorId / 配置摘要，
  **不记录简介与任何正文**；
- 所有查询都带 `author_id` 隔离，无法通过改 URL、请求体或本地存储切换作者。

页面：

| 页面         | 说明                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `/workspace` | 作者作品工作台：账号信息、创建作品表单、作品列表卡片；题材固定显示「玄幻升级」；不显示管理员入口 |
| `/works/:id` | 作品基础信息 + 作品设定占位；明确提示人物/境界/卷纲/章节后续开放；无伪造编辑器或生成按钮         |

> 作品详情当前直接显示题材**代码**（`xuanhuan`）。把它映射成规则包名称
> （如「玄幻升级」）留待后续阶段实现 —— 本轮不强制。

### 设定中心与境界体系（M2-B1）

数据库（迁移 `packages/db/prisma/migrations/20261101000001_m2b1_entities/`）：

| 表                  | 说明                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entities`          | 通用实体：`work_id`、`entity_type`、`name`、`order_index`、`deleted_at`；同作品同类型下**未删除**实体名称唯一（部分唯一索引，软删除后同名可复用） |
| `entity_attributes` | 实体属性：`entity_id + attr_key + schema_ref` 唯一，值放 jsonb                                                                                    |
| `entity_versions`   | 版本快照：`entity_id + version_no` 唯一；每次编辑**追加**一版，旧版本保留                                                                         |

**xuanhuan 的 `field_schema`（版本 2）** 定义了两个字段组：

| 字段组                   | 字段（按 order）                                                             | 类型                    | 必填       |
| ------------------------ | ---------------------------------------------------------------------------- | ----------------------- | ---------- |
| 作品方向 `workDirection` | subGenre、goldenFinger、toneStyle、protagonistPosition                       | string                  | 前两个必填 |
| 实体类型 `realm_level`   | minorLevelCount、breakthroughCondition、lifespan、powerBaseline、description | integer / string / text | 前两个必填 |

每个字段都带 `label`、`help`（帮助文本）与 `order`（顺序）。
玄幻专属定义**只**存在规则包里，不写进通用核心表。

API（全部要求 active、已改密的作者会话；管理员 403；他人作品 404）：

| 接口                                        | 方法   | 说明                                                                                          |
| ------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `/api/works/:id/settings`                   | GET    | 作品方向 + 规则包公开 schema 摘要 + **`entityGroups`**（按类型分区）                          |
| `/api/works/:id/settings`                   | PATCH  | 更新作品方向；字段必须符合 field_schema；不可变字段（规则包 code / schemaRef / 归属）一律 400 |
| `/api/works/:id/entities?type=<entityType>` | GET    | 列出实体，按 `order_index` 升序；类型必须是规则包声明且本轮支持的类型                         |
| `/api/works/:id/entities`                   | POST   | 新建实体；同作品同类型重名 `409 ENTITY_NAME_TAKEN`                                            |
| `/api/works/:id/entities/:entityId`         | PATCH  | 编辑实体（追加版本快照）；`id`/`workId`/`entityType`/`orderIndex` 等不可变                    |
| `/api/works/:id/entities/:entityId`         | DELETE | 软删除；被引用时 `409 ENTITY_IN_USE`（附安全引用摘要）                                        |
| `/api/works/:id/entities/reorder`           | PUT    | 排序：只接受完整、无重复、全部属于当前作品的**同类型**集合                                    |

- 写接口校验 Origin；写操作与审计**同事务**（`settings.updated` / `entity.created` /
  `entity.updated` / `entity.deleted` / `entity.reordered`）；
- 审计 detail 只记录 workId / entityId / entityType / **字段名**，不记录完整设定值；
- 页面 `/works/:id/settings`：作品方向（标签与帮助文本来自 schema）+ 境界体系
  （新增 / 编辑 / 软删除 / 上下移动）；作品详情页有「进入设定中心」入口。

### 设定实体：势力 / 人物 / 物品 / 功法（M2-B2 + M2-B3-A）

迁移：`20261102000000_m2b2_character_faction`（v3，势力 + 人物）、
`20261103000000_m2b3a_item_technique`（v4，物品 + 功法）。
规则包当前为 **xuanhuan@4.0.0**（`field_schema.version = 4`，所有字段组 `schemaRef = xuanhuan@4.0.0`）。

**存量数据升级口径**：每次升级只把**上一版契约**的
`work_settings` / `entity_attributes` 行改到新版本（v3 迁移只动 `2.0.0`，
v4 迁移只动 `3.0.0`）。
`xuanhuan@1.0.0`（M2-A）与 `xuanhuan@2.0.0`（M2-B1）是历史契约行，升级前后都不可见，
**不迁移、不删除、不重新暴露**（有测试逐列证明其行数与内容不变）。
因为唯一索引含 `schema_ref`，某键同时存在 `1.0.0` / `2.0.0` / `3.0.0` 时，
把 `3.0.0` 改成 `4.0.0` 后组合为 `1.0.0 + 2.0.0 + 4.0.0`，不会冲突，
所以迁移**不需要 DELETE 合并**。

| 实体类型    | 字段（按 order）                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `faction`   | `type`(enum，必填：sect/family/dynasty/alliance/guild/other)、`tier`、`headquarters`、`powerRating`、`allies`(entityRefs→faction)、`enemies`(entityRefs→faction)、`description`                    |
| `character` | `identity`、`personality`、`goal`、`secret`、`secretKnownBy`(entityRefs→character)、`initialRealm`(entityRef→realm_level)、`faction`(entityRef→faction)                                            |
| `item`      | `category`(enum，必填：weapon/armor/pill/talisman/artifact/material/consumable/other)、`quality`(enum，必填：mortal/spirit/mystic/earth/heaven/immortal)、`acquisition`(text)、`description`(text) |
| `technique` | `type`(enum，必填：cultivation/martial/secret/divine/innate/other)、`realmRequirement`(entityRef→realm_level)、`effect`(text)、`sideEffect`(text)、`description`(text)                             |

姓名仍来自 `entities.name`；`faction.type`、`item.category`、`item.quality`、`technique.type` 必填，
其余业务字段可选。`enum` 入库值是 `value`（ASCII），`label` 仅用于展示。

> **`item` 没有持有人字段**。物品持有人以 M2-B3-B 的 `item_events` 流水为唯一真相，
> 本轮不提供可编辑的持有属性，避免"先写属性、再废弃"的双写不一致。

**字段类型**：`string | text | integer | enum | entityRef | entityRefs`。
`entityRef` 存单个实体 UUID；`entityRefs` 存 UUID 数组（保持输入顺序，硬上限 50，
重复值直接 400 而不静默去重，空数组表示清空）。

**引用校验**（作品级 advisory lock 内、同一事务）：
目标必须存在、未软删除、属于同一作品、`entity_type` 等于**该字段**的 `refType`；
禁止引用自身。不存在 / 已删除 / 跨作品**统一**返回「引用目标不存在」，
不泄露其它作品是否存在。
校验是**逐字段、逐 id** 的：同一个 UUID 若同时出现在两个 `refType` 不同的
引用字段里，两个字段各自都必须满足自己的 `refType`，否则整个请求 400。

**规则包契约校验**：读取规则包后、任何业务判断之前统一校验 `field_schema`，
任一项不满足都返回 `INVALID_RULE_PACKAGE`（不静默返回残缺 schema）：

- `enum` 的 `options` 必须非空，且每个 `value` 非空、不重复；
- `entityRef` / `entityRefs` 必须有 `refType`，且该 `refType` 已在
  `field_schema.entityTypes` 中声明（未声明 → `INVALID_RULE_PACKAGE`）；
- `entityRefs.maxItems` 如果出现，必须是正整数（统一硬上限仍为 50）；
- 字段类型必须是已知的六种之一。

**排序接口**：`PUT /entities/reorder` 的 `entityType` 可省略（默认 `realm_level`），
但一旦出现就必须是非空字符串 —— 数字 / `null` / 数组 / 对象一律
`400 VALIDATION_FAILED`，不会被静默当成默认类型。

**删除保护**：只扫描当前契约、且规则包声明为 `entityRef`/`entityRefs` 的属性
（自由文本与旧契约属性不算引用）；只统计仍存活、同作品的引用者。
被引用时返回 `409 ENTITY_IN_USE` 并附安全摘要：

```json
{
  "error": {
    "code": "ENTITY_IN_USE",
    "message": "该实体当前被引用，无法删除",
    "references": {
      "total": 1,
      "items": [{ "id": "…", "entityType": "character", "name": "林青" }]
    }
  }
}
```

`items` 最多 20 条，只含 `id` / `entityType` / `name` —— **不含属性值、秘密或正文**。
允许互相引用（双方都会删除失败，作者需先编辑其中一方解除引用）。

**设定中心响应改为规范化的 `entityGroups`**（`realms` 字段已移除，不保留别名）：

```json
{ "settings": { "workId": "…", "workTitle": "…", "direction": { },
  "schema": { "code": "xuanhuan", "version": "4.0.0", "entityTypes": [ … ] },
  "entityGroups": [
    { "entityType": "realm_level", "title": "境界体系", "schemaRef": "xuanhuan@4.0.0", "order": 1, "entities": [ … ] },
    { "entityType": "faction", "title": "势力", "schemaRef": "xuanhuan@4.0.0", "order": 2, "entities": [ … ] },
    { "entityType": "character", "title": "人物", "schemaRef": "xuanhuan@4.0.0", "order": 3, "entities": [ … ] },
    { "entityType": "item", "title": "物品", "schemaRef": "xuanhuan@4.0.0", "order": 4, "entities": [ … ] },
    { "entityType": "technique", "title": "功法", "schemaRef": "xuanhuan@4.0.0", "order": 5, "entities": [ … ] }
  ] } }
```

`entityGroups` 按组级 `order` 升序；组内 `entities` 按 `order_index` 升序；
只包含规则包已声明且本轮启用 CRUD 的类型。
每个类型有**独立的** `order_index`（各自 1..N），排序不会互相影响。

**设定中心 UI（B2-B / B3-A）**：`/works/:id/settings` 现在是六段 —— 作品方向 + 五个实体分区
（境界体系 / 势力 / 人物 / 物品 / 功法）。分区顺序与标题直接取 `entityGroups`（组级 `order`），
**没有硬编码**：新增实体类型只需改规则包，页面自动多出分区。

- 控件全部由 `field_schema` 驱动：`string` → 单行、`text` → 多行、`integer` → number、
  `enum` → `select`（显示 label、提交 value）、`entityRef` → 单选候选、
  `entityRefs` → 「选择 → 添加」的**有序**多选（提交顺序 = 选择顺序，上限取 `maxItems` 且不超过 50）；
- 引用候选来自 `GET /entities?type=refType`，只含当前作品、未删除、类型匹配的实体；
  编辑中的实体会从候选里排除（禁止自引用）；没有候选时显示空态并提示先去对应分区创建；
- 每个分区独立支持新增 / 编辑 / 软删除 / 上移下移 / 数量展示，五个分区的 `order_index` 互不影响；
- 删除被拒（`409 ENTITY_IN_USE`）时展示 `references.total` 与最多 20 条「类型 · 名称」，
  **不含属性值、秘密或正文**；作者解除引用后即可正常删除；
- 设定值（含人物「秘密」）只存在于组件内存：不写 URL、`localStorage`、`sessionStorage`，
  也不写任何日志。

#### 交付口径（M2-B3-A / B3-B1 / B3-B2）

| 需求                                                     | 状态                                                                                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-WRK-09 功法/能力（名称、类型、境界门槛、效果、副作用） | **完成**：`technique` 五个字段齐全，`realmRequirement` 引用境界，删除被引用境界 → `409` + 摘要                                                           |
| F-WRK-07 物品/法宝（名称、类别、品质、持有人、获取方式） | **完成**：持有人由 `item_events` 回放派生；item 卡片「持有人 / 事件」可查看时间线并追加 / 冲正；删除当前持有人 → `409` + 物品清单；**`AT-CHK-4` 待章节** |
| F-WRK-11 物品获得/消耗/丢失/转手事件流水                 | **完成**：追加 / 冲正 / 回放 / 序号 / append-only + 时间线 UI（分页、二次确认、错误映射）+ E2E；**`AT-CHK-4` 待章节**                                    |
| F-WRK-08 资源流水                                        | **暂停**（个人可用版优先；代码与文档保留，不删除）                                                                                                       |

> `AT-CHK-4`（正文使用但无转手事件 / 同时被两人持有 → 「物品归属矛盾」）
> **仍未交付**：它需要章节正文与场景节拍（M2-D/M2-E），不是 B3-B2 能验证的。

### 物品事件流水（M2-B3-B1）

迁移：`packages/db/prisma/migrations/20261104000000_m2b3b_item_events/`。
**本轮不改规则包**（仍 `xuanhuan@4.0.0`），因此没有 v5。

**唯一真相**：`item` 规则包里没有 `holder` 字段，属性表也不存持有人；
持有人与生命周期状态**只**由 `item_events` 全量回放得出，不存在双写。

**表约束**

- `(item_entity_id, seq_no)` 唯一；`seq_no` 在作品级锁内取 `max+1`，唯一索引兜底；
- `(item_entity_id, idempotency_key)` 唯一；
- `reversal_of` 部分唯一（一个原事件只能被冲正一次）；
- CHECK：事件类型白名单、每种类型的持有人形态、`seq_no >= 1`、
  不能冲正自己、幂等键 8–128、`note <= 500`；
- **append-only 触发器**：`UPDATE` / `DELETE` 直接 SQL 也抛 `restrict_violation`；
- 外键一律 `ON DELETE RESTRICT`（项目没有作品/实体硬删除入口）；
- **不建 `chapter_id`**：等 `chapters` 迁移落地时同批补列 + FK。

**状态机**（服务端校验，非法转移 `409 ITEM_EVENT_INVALID_TRANSITION`）

| 当前状态     | obtained | transferred | consumed   | lost   |
| ------------ | -------- | ----------- | ---------- | ------ |
| `unrecorded` | → held   | 409         | 409        | 409    |
| `held`       | 409      | → held      | → consumed | → lost |
| `consumed`   | → held   | 409         | 409        | 409    |
| `lost`       | → held   | 409         | 409        | 409    |

**回放口径**：冲正行与其目标行**同时**从有效流剔除，回放等价于"该冲正从未发生"。
冲正行的 `from/to` 只用于展示，不参与状态计算。

**冲正**：只允许冲正当前最新、且未被冲正过的普通事件；
冲正通过追加反向事件完成，历史行一个字都不改；
冲正事件自身不能再被冲正（因此无法连续回退更早的事件）。

**接口**

| 方法 | 路径                                                    | 说明                                                             |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| GET  | `/api/works/:id/items/:itemId/events?afterSeq=&limit=`  | 事件列表，seq 升序，`limit` 1–100                                |
| POST | `/api/works/:id/items/:itemId/events`                   | 追加事件（白名单：eventType / toHolder / note / idempotencyKey） |
| POST | `/api/works/:id/items/:itemId/events/:eventId/reversal` | 冲正（白名单：note / idempotencyKey）                            |
| GET  | `/api/works/:id/items/:itemId/state`                    | 派生状态：持有人 / 生命周期 / 事件数 / 最后 seq                  |

**客户端不能提交 `from_holder`**：出现即 400（严格白名单，不静默忽略）。

**幂等**：`idempotencyKey` 必填。同键 + 同内容（append 比较 eventType/toHolder/note，
reversal 比较 reversalOf/note）返回既有事件（HTTP 200，`deduplicated: true`）；
同键不同内容 → `409 ITEM_EVENT_IDEMPOTENCY_CONFLICT`。
查重在**锁内、状态机校验之前**执行，否则重试会被误判成"非法转移"。

**删除保护**：删除人物时，若它仍是某**存活物品**的当前持有人 →
`409 ENTITY_IN_USE` 并列出物品；已被转走的历史持有人**不阻止**删除
（否则任何一次转手都会把人物永久锁死）。

**审计**：`item.event_recorded` / `item.event_reversed`，
detail 只有 `workId / itemId / eventId / eventType / seq`（冲正额外记 `reversalOf`）；
**不含 `note`、不含持有人姓名**。

### 物品持有人 / 事件时间线 UI（M2-B3-B2）

入口在 `/works/:id/settings` 的**物品卡片**上（只有 `entityType='item'` 有，其它实体不受影响）：
摘要徽标（未登记 / 持有中 · 某人 / 已消耗 / 已丢失）+「持有人 / 事件」按钮。
面板也可用 `?item=<itemId>` 深链直达，用于查看**已软删物品**的历史。

**时间线与 APIs 的对应关系**

| 区域     | 展示与规则                                                                                                                                                                       | 对应接口                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 状态摘要 | 当前状态、当前持有人（无则「暂无持有人」）、事件总数、有效事件数、最后 seq                                                                                                       | `GET .../state`                     |
| 时间线   | 按 `seq` 升序：seq、中文事件类型、`from → to`、备注、时间、冲正关系；持有人只展示 `{id,name,deleted}`，`deleted=true` 显示「已删除角色」                                         | `GET .../events?afterSeq=&limit=`   |
| 分页     | 首屏 `limit=50`；「加载更多事件」带 `afterSeq` 续读，合并按事件 id 去重                                                                                                          | 同上                                |
| 追加事件 | 未登记 / 已消耗 / 已丢失 → 只能「登记获得」；持有中 → 转手 / 消耗 / 丢失；人物候选只来自当前作品且未删除，转手时排除当前持有人；**没有 `fromHolder` 输入**；备注 ≤500 且实时计数 | `POST .../events`                   |
| 冲正     | 只有「当前最新 + 未被冲正 + 自身不是冲正行」显示按钮；点击后二次确认并可填备注；冲正行显示「冲正 #N」，被冲正的目标行标「已冲正」并置灰                                          | `POST .../events/:eventId/reversal` |

**规则与安全**

- 事件类型只显示中文 label（获得 / 转手 / 消耗 / 丢失），不把英文 `eventType` 写进可见文本；
  冲正行不沿用它镜像出来的类型，避免被误读成一次真实获得 / 转手；
- 空状态区分「从未登记」（正常引导）与「没有任何事件但状态不是未登记 / 状态说有事件却读不到」
  （安全错误提示，不假装正常）；
- 错误码统一映射中文：`ITEM_EVENT_INVALID_TRANSITION`、`ITEM_EVENT_NOT_REVERSIBLE`、
  `ITEM_EVENT_IDEMPOTENCY_CONFLICT`、`ITEM_EVENTS_CLOSED`、`CONCURRENT_MODIFICATION`；
  都**不会跳登录**；状态可能已过期时（非法转移 / 不可冲正 / 并发冲突）额外提供
  「刷新状态后重试」入口，`ITEM_EVENTS_CLOSED` 只提示物品已删除、不再提供写入入口；
- 幂等键：每次新表单提交生成 `crypto.randomUUID()`；请求失败且内容未变时复用同一个键，
  成功或内容变化即换新；只存在于组件内存（`useRef`），不写 URL / localStorage / sessionStorage；
- 备注草稿同理只在内存，关闭面板即销毁；
- 软删物品：历史与状态仍可读（深链进入），面板隐藏追加 / 冲正并提示「物品已删除」；
  服务端仍以 `ITEM_EVENTS_CLOSED` 做最终校验；
- 删除保护沿用 `ENTITY_IN_USE` 摘要：删除仍是当前持有人的角色 → `409`，显示「物品 · 名称」；
  把物品转走后该角色即可删除，UI 不提供任何强制级联。

**未交付项（不得标记完成）**：`F-WRK-15 人物「当前知道/不知道」信息清单`
**仍由 M6 事实版本系统交付**，依赖 `fact_id` + 事实版本
（`03-data-model.md` §3.11 `knowledge_marks`）。
本轮 `character.secretKnownBy` 只表示**设定层「谁知道这个秘密」**，
不构成事实级认知模型，也不等同于 F-WRK-15。

### 工作流内核、Provider 与 PostgreSQL Worker（A1-1）

迁移：`packages/db/prisma/migrations/20261104010000_a1_workflow_kernel/`。
A1-1 只搭**确定性工作流基础设施**；A1-2 在其上接入 Planner/Writer，
但仍不提供生成 API/UI，也不建 `chapter_versions`。

| 表                 | 用途            | 关键约束                                                                                        |
| ------------------ | --------------- | ----------------------------------------------------------------------------------------------- |
| `chapters`         | 最小章节骨架    | `UNIQUE(work_id, chapter_no)`、`chapter_no >= 1`、状态六态、FK works RESTRICT                   |
| `generation_tasks` | 任务队列 + 租约 | `UNIQUE(work_id, request_id)`、状态白名单、processing 必须有锁/租约、状态迁移触发器、终态不可变 |
| `task_contexts`    | 任务上下文摘要  | `(task_id, context_type, ref_id)` 唯一、snippet ≤ 500、rank ≥ 0                                 |
| `llm_call_logs`    | 模型调用计量    | 只有 token / 延迟 / 成功 / `error_code`，**没有 prompt / 正文列**                               |

**Provider**（Mock / 真实只由配置切换）：

```bash
MODEL_PROVIDER=mock                 # 默认：不联网、确定性输出（单测 / CI）
MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=https://api.example.com/v1
MODEL_NAME=your-model
MODEL_API_KEY=...                   # 只进请求头，不落库、不进日志
MODEL_TIMEOUT_MS=60000
```

- `MockProvider`：固定输出或纯函数，token 由字符数估算，供单测/CI；
- `OpenAICompatibleProvider`：只依赖标准 `fetch`，JSON 模式；错误只含固定文案 + HTTP 状态码，
  429/5xx 可重试；
- 不引入 Agent 框架；不提供管理页面 Key 输入。

**Agent 与工作流**：

- `AgentDefinition(name / promptVersion / model / inputSchema / outputSchema / maxOutputTokens / rolePrompt)`；
- 输入与输出都做**严格 JSON Schema** 校验（未声明字段默认拒绝）；Agent 不访问数据库、
  不决定工作流下一步；
- `WorkflowKernel` 只按注册表里的固定步骤执行，进度/取消/租约由 Worker 回调注入；
- `DETERMINISTIC_TEST_AGENT` 只用于证明"注册 → 校验 → Provider → 输出校验"链路。

**Worker**：

- `FOR UPDATE SKIP LOCKED` 领取 `queued`，写 `locked_by / lease_until / heartbeat_at`，`attempt_count + 1`；
- 心跳失败立即停止后续步骤；租约过期由 sweep 回收（取消优先 → 次数用尽判 failed → 其余回 queued）；
- 所有 Worker 写都带 `locked_by` fencing，旧 Worker 不会覆盖新 Worker；
- 崩溃不会留下永久 `processing`；同一 `work_id + request_id` 只创建一个任务；
- `input_hash`（canonical JSON 的 SHA-256）覆盖
  `chapterId / taskType / inputSnapshot / provider / model / maxAttempts`：
  同键同指纹返回既有任务，异指纹 `TASK_REQUEST_CONFLICT`，不覆盖、不新建；
- **取消优先**：`cancel_requested_at` 非空时，成功、失败与重试都收敛为 `cancelled`，
  不写 `succeeded`、不回 `queued`，并清空锁、租约与错误字段。

**权限与日志**：A1-1 **没有新增公开 API**；作者侧服务（创建/读取/取消）必须传会话里的
`authorId` 并经 `requireOwnedWork`，管理员没有普通任务入口（测试覆盖 404）。
任务与模型日志只记录 ids / 状态 / 稳定错误码，不含 API Key、prompt、正文或模型原始错误。

**测试**：A1-1 系列（含 A1-1-REV-01）新增 118 个（Provider 14 / Schema 20 / Agent 15 /
Kernel 11 / Queue 27 / Worker 15 / Mock 5 / canonical JSON + 指纹 11）。

### 单章候选流水线（A1-2）

迁移：`packages/db/prisma/migrations/20261104020000_a1_chapter_draft/`（2 张表 + 复合外键）。
taskType = `chapter.draft`，固定 6 步：

```
assemble_context → plan_chapter → validate_and_freeze_contract
  → write_draft → validate_draft → persist_candidate
```

- `planner.chapter@1.0.0`：输出 `goal / mustInclude / mustNotInclude / characters / scenes / targetWords`；
  Schema + 代码双重校验（空值、场景四字段、2500–4000 字），通过后冻结为 `chapter_contracts`；
- `writer.chapter@1.0.0`：输出 `{ text }`；服务端按"非空白字符数"重新统计，
  少于 1200 字直接失败，不写候选；`word_count` 不信任模型；
- **模型选择**：章节 Agent 的 `model` 为空 → 使用 Provider 的 `defaultModel`
  （OpenAI 兼容 = `MODEL_NAME`，Mock = `mock-model`）；显式 `model` 仍可覆盖；
  成功 / 失败日志都记录解析后的实际模型，不允许空字符串；
- 确定性 ContextBuilder：章节 → 人物 → 境界 → 势力 → 作品方向，写入 `task_contexts`
  （snippet ≤500）；**不跨作品**，`secret` 类字段不进入模型输入；
  人物/境界/势力各最多 50 条，截断时追加 `context.truncated` 安全提示；
- Planner 输出的人物必须来自上下文（精确匹配），`targetWords` 不得改动；
- 合同与候选有数据库级不可变触发器（UPDATE/DELETE 一律拒绝；候选只放行 `candidate → adopted`）；
- 合同 / 候选 / 章节状态 / 审计同事务；失败或取消不留下候选；
- 重试幂等：同任务已有合同 → 不再调 Planner；已有候选 → 不再调 Writer、不重复插行；
- 章节状态：合同 `outlined` → Writer 开始 `drafting` → 候选 `in_review`；任务终态仍是 `succeeded`；
- 不建 `chapter_versions`、不提供采纳接口（A1-2 范围）；正式版本见下一节。

**测试**：A1-2 系列（含 REV-01）新增 35 个（流水线 21 / Agent 校验 9 / Provider 4 /
Agent 基础 1）；workflow 包 **153** 个；全量单测 **543** 个。

### 候选采纳与正式章节版本（A1-3A）

迁移：`packages/db/prisma/migrations/20261104030000_a1_chapter_versions/`。
A1-3A **只有数据库与服务层**：没有 HTTP API、没有章节 UI、没有版本恢复与 diff。

`adoptChapterCandidate({ workId, chapterId, candidateId, authorId, meta? })`：

```
runWorkWrite（作品级 advisory lock）
  → 事务内重读归属（他人作品 / 管理员 404）
  → 锁章节行 + 锁候选行
  → 幂等：已 adopted 且有版本 → 返回既有版本（deduplicated=true）
  → version_no = max+1；插入 chapter_versions（source='ai'，正文原样复制）
  → 候选 candidate → adopted → 章节 in_review → 两条审计
```

- `chapter_versions`：`UNIQUE(chapter_id, version_no)`、`source_candidate_id` **部分唯一**
  （一个候选最多一个正式版本）、`word_count 1200..char_length(content)`、
  `content 1200..200000`、`source ai|human`（本轮只写 `ai`）；
- 归属由**复合外键**保证：章节属于作品，来源候选与父版本必须同章节同作品；
- 正式版本 **append-only**：`BEFORE UPDATE / DELETE` 一律拒绝；
- 候选只允许 `candidate → adopted`，`adopted → 其它`、改正文 / 字数、删除全部拒绝；
- 正文与字数从候选**原样复制**，逐字节一致；`word_count` 由服务端统计，不信任模型；
- 幂等：重复采纳不新增版本、不重复审计；并发同候选只产生 1 个版本；
  同章节不同候选并发得到版本号 1、2；
- 事务边界：审计写入失败 → 候选状态、版本、章节状态全部回滚；
- 新错误码（已同时加入 auth 与 web 文案表）：`CHAPTER_CANDIDATE_NOT_FOUND`（404）、
  `CHAPTER_CANDIDATE_NOT_ADOPTABLE`、`CHAPTER_VERSION_CONFLICT`、
  `CHAPTER_STATE_INVALID_FOR_ADOPTION`（409）。

**测试**：A1-3A 新增 15 个（`test/chapter-adoption.test.ts`）；workflow 包 **168** 个。

### 章节与生成任务 HTTP API（A1-3B）

无新增迁移。全部在 `/api/works/:workId/...`；写接口校验 Origin，身份只来自会话。

| 方法 | 路径                                                 | 说明                              | 成功                    |
| ---- | ---------------------------------------------------- | --------------------------------- | ----------------------- |
| POST | `/chapters`                                          | 创建章节（`chapterNo` + `title`） | 201 `{ chapter }`       |
| GET  | `/chapters/:chapterId`                               | 章节 + 最新任务摘要 + 候选摘要    | 200                     |
| POST | `/chapters/:chapterId/generate`                      | 提交 `chapter.draft` 任务         | 201 / 200 `{ task }`    |
| GET  | `/generation-tasks/:taskId`                          | 任务状态                          | 200 `{ task }`          |
| POST | `/generation-tasks/:taskId/cancel`                   | 请求取消                          | 200 `{ task }`          |
| GET  | `/chapters/:chapterId/candidates/:candidateId`       | 候选正文 + 计划                   | 200 `{ candidate }`     |
| POST | `/chapters/:chapterId/candidates/:candidateId/adopt` | 采纳候选                          | 201 / 200 `{ version }` |

- **严格白名单**：创建章节只接受 `chapterNo / title`；生成只接受
  `requestId / targetWords / style`；采纳只接受可选 `requestId`。
  `provider` / `model` / `authorId` / `status` / `inputSnapshot` 一律 400；
- **provider / model 只来自服务端配置**：`MODEL_PROVIDER` 决定 Provider，
  `provider.defaultModel`（OpenAI 兼容 = `MODEL_NAME`，Mock = `mock-model`）决定模型；
  `input_snapshot` 只写 `targetWords / style`；
- **requestId 幂等**：同键同内容返回同一任务（200），异内容
  `409 TASK_REQUEST_CONFLICT`；
- 任务 DTO 不返回 `inputSnapshot` / `inputHash` / `requestId` / 租约 / provider / model；
- 未登录 401、管理员 403、他人作品 404、缺 Origin 403；
- 采纳直接调用 `adoptChapterCandidate`，响应只有版本摘要（不含正文）；
- 章号重复 `409 CHAPTER_NO_TAKEN`；章节 `finalized / abandoned` 采纳
  `409 CHAPTER_STATE_INVALID_FOR_ADOPTION`；
- **章节状态边界（生成 / 采纳统一）**：`finalized / abandoned` 章节提交生成
  → `409 CHAPTER_STATE_INVALID_FOR_GENERATION`（不建任务、不写审计）；
  Worker 执行时再校验一次（`TASK_INPUT_INVALID`，不可重试），
  覆盖"排队期间被定稿"的竞态；不会为已定稿章节自动重开；
- **requestId 幂等优先**：同 `(workId, requestId)` 已有任务时跳过章节状态检查，
  同内容返回原任务、异内容 `TASK_REQUEST_CONFLICT`；只有新请求受章节关闭限制；
  生成与采纳共用 `isChapterOpenForGeneration` 白名单；
- 前端只新增 `apps/web/src/lib/api.ts` 的类型与客户端函数，**没有页面**。

**测试**：A1-3B 系列（含 REV-01/02）新增 27 个（`test/chapter-api.test.ts` 23 /
`test/chapter-workflow.test.ts` +4）；web 包 **159** 个、workflow 包 **172** 个；
全量单测 **585** 个。

### Worker 常驻运行与后端闭环（A1-3C）

`apps/worker` 不再是健康检查骨架：常驻进程同时提供 `/healthz` 并领取 `chapter.draft` 任务，
把「HTTP 创建任务 → Worker 生成候选 → HTTP 读取候选 → HTTP 采纳版本」串成真实闭环。

```bash
# 本地开发（与 web 并行）
pnpm dev
# 或只启动 worker
pnpm --filter @novel/worker dev

# 生产构建与运行
pnpm build:packages && pnpm --filter @novel/worker build
node apps/worker/dist/index.js
# 容器：pnpm compose:up
```

启动装配（`src/runtime.ts` / `src/supervisor.ts`）：

- Provider 只在启动时构造**一次**，同一个实例既交给 `chapter.draft` 工作流，
  也交给 `WorkerRunner` 的预检；Provider 选择只来自 `MODEL_PROVIDER`；
- `WorkflowRegistry` 注册 `chapter.draft`（`createChapterDraftWorkflow({ db, provider })`）；
- supervisor 初始为 `starting`，健康检查读取它的实时快照并与轮询并发启动；
- **只有第一次 `runOnce()` 正常返回后才进入 `ready`**，在此之前 `/healthz` 一律 503。

| 变量                  | 默认   | 说明                                                       |
| --------------------- | ------ | ---------------------------------------------------------- |
| `WORKER_ID`           | 自动   | 可选；缺省 `host:pid:random`，最长 128                     |
| `WORKER_LEASE_MS`     | 30000  | 租约 100..3600000                                          |
| `WORKER_HEARTBEAT_MS` | 租约/3 | 可选；显式设置时必须**严格小于** `WORKER_LEASE_MS`         |
| `WORKER_POLL_MS`      | 1000   | 空队列轮询间隔 1..600000                                   |
| `WORKER_SWEEP_MS`     | 5000   | 过期租约清扫间隔 1..600000                                 |
| `WORKER_PORT`         | 3001   | 健康检查端口                                               |
| `MODEL_PROVIDER`      | mock   | `mock` / `openai-compatible`；web 与 worker 必须使用同一份 |

**provider/model 预检**：`WorkerRunner` 领取任务后、启动心跳与 Kernel 之前，
比较任务行记录的 `provider` / `model` 与当前 Provider 的 `name` / `defaultModel`：

- 一致 → 正常执行；
- 不一致 → 非重试失败 `TASK_MODEL_CONFIG_MISMATCH`，安全文案
  「任务模型配置已变化，请重新提交生成任务」；不启动心跳、不调用 Agent、
  不写合同/候选，任务直接 `failed`（若此刻已有取消请求，仍按取消优先记 `cancelled`）。

因此**修改 `MODEL_PROVIDER` / `MODEL_NAME` 前应先清空排队任务**；已经创建的任务不会
被静默换模型重跑。web 与 worker 的 `MODEL_PROVIDER` / `MODEL_NAME` 必须一致，
compose 已把这两项同时注入两个服务。

循环状态与健康检查：

| 状态       | 含义                              | `/healthz`           |
| ---------- | --------------------------------- | -------------------- |
| `starting` | 进程已起，尚未完成第一次轮询      | **503**（error）     |
| `ready`    | 至少一次轮询正常返回              | 200（ok）            |
| `retrying` | 瞬态基础设施错误，退避重试中      | **503**（error）     |
| `stopping` | 收到停止信号，正在关闭            | 200（degraded/warn） |
| `failed`   | 永久错误，进程即将以退出码 1 退出 | **503**（error）     |

**瞬态 vs 永久**（`src/loop-errors.ts`）：

- 退避重试（1s → 5s）：Prisma 初始化/连接错误、P1001/P1002/P1008/P1017/P2021/P2024、
  空库缺表（P2021 或原始查询 `42P01`，统一映射为 `P2021`）、PostgreSQL 57P01/57P03、
  `ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT` 等连接类错误、显式
  `RetryableWorkerLoopError`；
- 永久失败（退出 1，不伪装健康）：P2022 缺列、其它 Prisma 已知/未知请求错误、
  业务 `WorkflowError`、`TypeError` / `ReferenceError` / 断言错误 / 未知异常。

`runOnce` 正常返回的 `idle / succeeded / retried / failed / cancelled / lease-lost`
都算循环健康：连续失败数归零、状态回到 `ready`。任务级失败不是循环失败。

**空库启动**：`generation_tasks` 不存在时进程不退出，进入 `retrying`，
`/healthz` 返回 **503**（只记录映射后的 `P2021`，不打印原始异常/连接串）；
迁移完成后下一轮自动 `ready` + 200。若遇到 P2022 缺列或未知代码错误，
则 `failed` 并退出 1，由容器重启策略决定，不再无限重试。

**关闭流程**：`SIGTERM` / `SIGINT` → supervisor 先置 `stopping` →
关闭健康检查端口 → 等待当前 `runOnce` 退出（**退避 sleep 会被立即唤醒**，
期间不再启动新一轮）→ `prisma.$disconnect()` → 退出码 0；
总时限 15 秒，超时强制退出（未完成任务的租约由其它 Worker 回收）。

**异常**：未捕获异常 / 未处理的 Promise 拒绝只打印稳定错误码并退出码 1；
启动配置错误（`WorkerConfigError` / `ModelProviderError`）只打印字段与固定文案。
Worker 的 Prisma 客户端关闭自身日志，数据库原始错误（表名 / 连接串片段）不进入
stdout/stderr；任何日志与健康报告都不含 prompt、正文、API Key、任务快照、
原始异常 message 或连接串。

**测试**：A1-3C + REV-01 新增 66 个（worker 61 = A1-3C 27 + REV-01 34、
workflow 预检 4、web 后端 e2e 1）；全量单测 **651** 个（web 160 / workflow 176 /
worker 63 / shared 15 / db 10 / auth 95 / works 132）。真实模型仍需人工 smoke；
CI 只使用 MockProvider / fake fetch，不联网。

### 章节工作台（A1-4A）

作者首次可以在浏览器中完成「创建章节 → 提交生成 → 查看进度 → 预览候选 → 采纳 → 阅读正式版本」。

```
/works/:id                     作品详情 →「进入章节创作」
/works/:id/chapters            章节列表 + 创建（章号 / 标题）+ 状态徽标
/works/:id/chapters/:chapterId 工作台：生成 / 轮询 / 取消 / 候选 / 采纳 / 正式版本
```

- **生成**：`targetWords` 默认取作品 `targetWordsPerChapter`，并经
  `clampChapterTargetWords` 收敛到 2500..4000（作品允许 1200..10000，页面仍显示原始目标）；
  `tone / pointOfView / pacing` 可选；`requestId` 由 `crypto.randomUUID()` 生成，
  **只存在组件内存**，同内容重复点击复用同一个 id，任务终态或**取消成功**后立即作废；
- **轮询**：1s 起、每次 +1s、最大 5s；只轮询 `queued / processing`；
  `succeeded / failed / cancelled` 立即停止；页面隐藏暂停，重新可见立即刷新一次；
  组件卸载清理 timer；
- **进度**：`currentStep` 显示中文（装配设定 / 规划章节 / 冻结合同 / 写正文 / 校验正文 / 保存候选）；
  只有 `queued / processing` 用「正在…」，终态显示「最后步骤：保存候选」；
  `queued / processing` 显示取消；取消后刷新章节、任务与候选，下一次生成必定换新 `requestId`；
- **顶部提示**：完全由任务状态推导（`generationNotice`），不再停留在提交那一刻——
  `queued / processing` 显示「正在等待 Worker 领取…」，已请求取消显示「已请求取消生成」，
  `succeeded` 显示「生成完成，候选已保存」，`cancelled` 显示「生成任务已取消」，
  `failed` 不显示提示（失败详情只走红色 `task-error`）；采纳成功后由版本提示覆盖；
- **候选**：章节详情只返回摘要；点击候选后才请求正文；`pre-wrap` 纯文本渲染；
  结构化计划可折叠查看目标 / 场景 / 必须包含；
- **采纳**：仅 `candidate` 显示按钮，二次确认；成功显示「已生成正式版本 N」并自动选中
  最大版本；重复采纳显示已存在（`deduplicated`），不做乐观更新；
- **正式阅读**：`pre-wrap` 纯文本，显示版本号 / 来源（AI/人工）/ 字数 / 时间；刷新后仍在；
- `finalized / abandoned` 章节不显示生成控件，显示稳定提示；
- 401 跳登录，404 显示作品 / 章节不存在，管理员 403；正文、requestId 不写 URL/Storage。

**Mock 演示**：`MODEL_PROVIDER=mock` 时 Worker 使用章节专用 MockProvider，
Planner 输出合法合同、Writer 输出 1600 字确定性正文，因此无需真实模型即可跑通全链路。
生成仍需要 **Worker 常驻进程** 在运行。

**尚未开放**：Markdown 人工编辑、`human` 版本、版本 diff / 恢复、Reviewer / RAG。

**测试**：A1-4A 新增 31 个（只读 API 7、展示纯函数 10、浏览器 E2E 10、
workflow 章节 Mock 4）；**A1-4A-REV-01** 再补 9 个（只读 API 1、展示纯函数 6、浏览器 E2E 2）；
**REV-02** 再补 7 个（展示纯函数 6、浏览器 E2E 1：终态提示一致性）；全量单测 **685** 个
（web 190 / workflow 180 / worker 63 / shared 15 / db 10 / auth 95 / works 132）；
浏览器 E2E 合计 **80**。

### 浏览器 E2E（Playwright Chromium）

```bash
# 需要先有一个干净数据库 + 一次性管理员，并让 web 与 **真实 Worker** 指向同一数据库
# Worker：DATABASE_URL=… MODEL_PROVIDER=mock node apps/worker/dist/index.js
# DATABASE_URL 还用于 A1-4A 把第 2 章置为 finalized（仅测试种子）
BASE_URL=https://localhost:8443 \
DATABASE_URL='postgresql://…' \
ADMIN_EMAIL='e2e-admin@example.test' ADMIN_INITIAL_PASSWORD='…' \
  pnpm --filter @novel/web exec playwright test
```

覆盖（80 个用例，分六个 spec 文件：账号管理 / 章节工作台 / 物品事件 / 设定中心 /
作品流程 / 账号上限）：
未登录跳转、首登强制改密、管理员列表、一次性口令只出现一次、
刷新不可回看、作者首登改密、作者越权被拒、重置后旧会话失效、停用后登录被拒、
启用后可登录、退出后保持未登录、第 11 个账号的上限提示，
以及 **REV-01** 新增的：弹窗背景 `inert` + Tab 循环 + Esc 不关闭 + 焦点回归、
会话临近到期自动退出、管理员页清除 Cookie 后执行操作跳回登录页、
作者工作台清除 Cookie 后重新获得焦点跳回登录页、390×844 手机宽度下的
登录 / 表格横向滚动 / 一次性口令弹窗可操作；
**作品流程**：管理员创建两个作者 → 作者 A 创建作品、刷新后仍在 → 打开详情 →
作者 B 看不到且直接访问被拒 → 退出重登后仍在 → 重复标题与校验失败提示可被读屏获取 →
移动端创建作品 → 页面不出现人物/章节/AI 生成入口；
**设定中心（M2-B1）**：填写并保存作品方向（刷新后仍在）→ 清空可选方向字段后刷新仍为空 →
创建炼气/筑基/金丹 → 修改筑基（刷新后仍在）→ 调整顺序（刷新后保持）→ 删除未被引用的境界 →
作者 B 进不去 A 的设定页 → 移动端编辑方向并新增境界 → 只出现本阶段四个分区，
不出现物品/功法/地点/关系图/AI 入口；
**设定中心（M2-B2-B 多类型）**：分区顺序取自 `entityGroups.order` → 创建势力 A/B（enum 显示 label）→
创建人物引用境界与势力、候选为空时的空态 → 把所属势力改为 B → 把另一人物加入 `secretKnownBy`
（顺序保留、刷新仍在、自身不在候选里）→ 删除被引用的境界 `409` 并列出「人物 · 林青」→
解除引用后可删 → 删除被引用的势力 `409` 摘要 → 解除后可删 → 三类实体各自排序互不影响 →
enum 只有规则包给的固定选项（非法值即使绕过界面也被服务端拒绝）→
候选不含其它作者作品数据 → 390×844 移动端完成人物创建与多选且不撑破视口。
**设定中心（M2-B3-A 物品 / 功法）**：物品分区两个 enum 只有规则包选项、页面**没有持有人字段** →
创建 / 编辑 / 删除物品 → 功法引用境界、删除被引用境界 `409` 并列出「功法 · 青元剑诀」→
解除引用后可删 → 390×844 移动端创建物品与功法且五分区不撑破视口。
**物品持有人 / 事件（M2-B3-B2）**：物品卡片入口（人物卡片没有）→ 首次打开同时请求 state 与
events（`limit=50`）→ 未登记空态 → 登记获得（备注不进 URL/storage，关闭清空草稿）→ 转手
（当前持有人不在候选里）→ 消耗 → 冲正消耗（目标行「已冲正」、冲正行「冲正 #3」）→
冲正行不再可冲正 → 删除当前持有人 `409` 并显示「物品 · 青锋剑」→ 390×844 完成登记 / 转手 / 冲正
且按钮 ≥40px → 转走后可删（历史行只显示「已删除角色」）→ 另一作者 `404`、管理员 `403` →
软删物品后深链可读但只读 → 截图不含口令 / 邮箱 / Cookie / 令牌。
**章节工作台（A1-4A）**：作品详情进入章节页 → 创建第 1 章并打开 → Mock 生成 →
真实 Worker 领取 → 页面轮询到 succeeded → 候选预览（正文 + 计划）→ 二次确认采纳 →
正式版本 1 与正文 → 刷新后仍在 → 第 2 章置为 finalized 后无生成控件 →
未登录 401 / 不存在作品 404 / 管理员 403 → 390×844 移动端创建、生成、候选预览与正式阅读 →
页面与截图不含邮箱 / 口令 / Cookie / 令牌 →
**REV-01**：取消后用**完全相同参数**重新生成换新 `requestId`（测试替身把任务钉在
queued/processing，取消接口伪造 `processing + cancelRequestedAt`）、页面只跟踪新任务 →
作品目标字数 1200 时生成表单默认值收敛为 2500、页面仍显示 1200 →
**REV-02**：提交后显示等待 Worker，轮询成功后换成「生成完成，候选已保存」；
种子任务覆盖 failed（只有红色错误、无绿条）/ cancelled（生成任务已取消）/
processing + cancelRequestedAt（已请求取消生成）；刷新已完成任务不再回到等待提示。

> Playwright 按**文件名字母序**执行，因此 `z-account-limit.spec.ts`（会故意把账号
> 补齐到 10 个）排在最后；管理员改密后的口令通过 `apps/web/.e2e-admin-password`
> 在 spec 文件之间共享，既有 `e2e-author` 的邮箱与口令通过
> `apps/web/.e2e-author.json` 共享（两个文件都不入仓库、不进镜像上下文）。
> 章节工作台 spec 复用该作者，不新建账号。

移动端截图：`docs/screenshots/m1b3-mobile-login.png`、`m1b3-mobile-admin.png`、
`m1b3-mobile-one-time-password.png`（一次性口令区域同样做模糊处理）；
物品事件：`docs/screenshots/m2b3b-item-events-desktop.png`、`m2b3b-mobile-item-events.png`、
`m2b3b-item-holder-cards.png`；
章节工作台：`docs/screenshots/a1_4a-chapters-empty.png`、`a1_4a-workbench.png`、
`a1_4a-candidate.png`、`a1_4a-reading.png`、`a1_4a-mobile-chapters.png`、
`a1_4a-mobile-workbench.png`、`a1_4a-mobile-candidate.png`、`a1_4a-mobile-reading.png`。

CI 的 `docker` job 会另建一个独立数据库（库名含 `run_id` 与 `run_attempt`，
重跑不会撞上已存在的库）并把 web 重建指向它，用运行时生成的凭据跑同一套用例。

> **两个连接串**：宿主机上的迁移与建号用 `127.0.0.1:5432`（端口映射），
> 容器内的 web 必须用服务名 `postgres:5432` —— 容器里的 `127.0.0.1` 指向容器自己，
> 两者不能混用。健康检查前会打印容器内实际生效的（脱敏）连接串作为诊断。

**失败产物保护**：Playwright 的 `error-context.md`（可访问性快照）会原样包含
密码输入框的值，因此配置里关闭了 trace / 截图 / 视频自动产物；E2E 运行期把用到的
全部口令记入 `apps/web/.e2e-secrets.txt`（不入仓库），CI 在上传 artifact 之前
运行 `scripts/verify-no-plaintext-secrets.sh`，扫描并**删除**任何含明文口令的产物，
保证上传内容里不含可用口令。

口令清单的写入**失败即抛错**（`apps/web/e2e/secret-ledger.ts`）：清单是这条保证的
唯一依据，静默失败会让 CI 上传出可用口令。清单文件既不在 `.gitignore` 也在
`.dockerignore` 中排除，不会进入仓库或镜像上下文。

## 5. 健康检查地址

| 端点                                   | 返回内容                             | 失败语义                                           |
| -------------------------------------- | ------------------------------------ | -------------------------------------------------- |
| `http://127.0.0.1:3000/api/healthz`    | web 应用状态 + 数据库连接状态        | 数据库不可用 → **HTTP 503**                        |
| `http://127.0.0.1:3001/healthz`        | worker 进程 + 任务循环 + 数据库状态  | 任一 error → **HTTP 503**（循环未 ready 也是 503） |
| `http://127.0.0.1:8080/api/healthz`    | 经 Caddy 代理到 web                  | 同上                                               |
| `http://127.0.0.1:8080/worker/healthz` | 经 Caddy 代理到 worker（前缀被剥离） | 同上                                               |

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

> **执行顺序要求**：`lint` / `typecheck` / `test` 都依赖 `@novel/shared`、`@novel/db`、
> `@novel/auth` 的 `dist` 产物（workspace 依赖以 `dist` 为入口）。因此必须**先执行
> `pnpm build:packages`**，再执行 lint / typecheck / test。干净克隆后尤其要注意。

> **数据库集成测试**：`packages/auth`、`packages/works`、`packages/workflow`、`apps/web`
> 与 `apps/worker`（健康检查）的集成测试直接连接**真实 PostgreSQL**
> （不使用 mock 替代数据库），因此运行 `pnpm test` 前必须：
>
> ```bash
> export DATABASE_URL='postgresql://novel:密码@127.0.0.1:5432/novel?schema=public'
> pnpm db:deploy      # 先应用迁移
> pnpm test
> ```
>
> 缺少 `DATABASE_URL` 时集成测试会**直接失败**（而不是静默跳过），
> 以免在没有数据库的情况下显示为通过。CI 通过 `postgres` service 提供该数据库。
>
> **测试串行执行**：根脚本为 `pnpm -r --workspace-concurrency=1 test`。
> auth 包的故障注入测试会临时在 `audit_logs` 上挂触发器（使 INSERT 抛错），
> 若与 web 的接口测试并行访问同一数据库会互相干扰，因此 workspace 之间必须串行。

### 容器与健康检查验证（需要 Docker）

```bash
pnpm verify:stack        # 完整流程：compose 校验 → 构建镜像 → 启动 → 健康检查 → 清理
pnpm verify:health       # 仅验证四个健康检查端点（服务已在运行时）
```

`verify:stack` 与 CI 的 `docker` job 执行**同一套命令**，任一端点失败即以非零状态码退出。

### 登录烟测（容器内真实链路）

容器与数据库都就绪后，可验证"真实容器内"的认证链路（含容器内的原生 argon2）：

```bash
# 1) 建库结构与初始管理员（宿主机经映射端口连容器内 PostgreSQL）
DATABASE_URL='postgresql://novel:密码@127.0.0.1:5432/novel?schema=public' pnpm db:deploy
ADMIN_EMAIL='smoke@example.test' ADMIN_INITIAL_PASSWORD='Smoke-Pass-2026' pnpm admin:create

# 2) 先确认 Caddy 的 HTTPS 入口可握手（失败时看 docker compose logs caddy --tail 100）
curl -k --ipv4 --resolve localhost:8443:127.0.0.1 \
  https://localhost:8443/api/healthz

# 3) 经 Caddy HTTPS 走一遍登录 → 强制改密 → /me → 退出
BASE=https://localhost:8443 \
ADMIN_EMAIL='smoke@example.test' ADMIN_INITIAL_PASSWORD='Smoke-Pass-2026' \
  bash scripts/verify-auth-smoke.sh
```

脚本断言：登录 200 + Cookie 含 `HttpOnly/Secure/SameSite=Lax/Path=/`、
响应体不含明文口令、首登 `403 PASSWORD_CHANGE_REQUIRED` → 强制改密并轮换会话、
`/me` 200、退出后 `Max-Age=0`、退出后 `/me` 401。
CI 的 `docker` job 还会额外 `docker compose exec web node -e` 直接加载
`@node-rs/argon2` 完成一次 hash/verify，证明镜像内原生模块可用。

> **关于 `-k` 与 `--resolve`**：`-k` **只**用于忽略 Caddy **internal 自签 CA** 的
> 信任问题；它不改变 Cookie 属性，HTTPS 下脚本仍强制断言 `Secure`。
> `--resolve localhost:8443:127.0.0.1 --ipv4` 用于把 localhost 明确解析到 IPv4 环回
> （compose 端口只绑定 `127.0.0.1`），避免 localhost 先解析到 `::1` 导致握手失败。
> 生产环境必须使用受信任证书并保持 `AUTH_COOKIE_SECURE=true`——
> **任何情况下都不要为了"让请求通过"而在生产关闭 Secure**。
> 本地若确需用 http 调试，才叠加 `infra/docker-compose.dev.yml`（它会把
> `AUTH_COOKIE_SECURE` 设为 `false`），且该模式不能用于验收。

### 容器镜像的可移植性设计

pnpm 默认的 isolated linker 会创建**指向构建机绝对路径**的符号链接
（如 `node_modules/@novel/db -> /home/runner/work/xxx/packages/db`）。
Docker `COPY` 会原样保留这些链接，容器内将无法解析 workspace 依赖。

因此镜像构建使用 `scripts/build-deploy.sh`：

```bash
pnpm --filter <应用> deploy --prod --legacy --config.node-linker=hoisted /out
```

它生成**扁平**的生产依赖目录：第三方依赖与 workspace 包都是实体目录，
仅保留 `node_modules/.bin/` 下的**相对**符号链接（如 `tsc -> ../typescript/bin/tsc`）。

脚本按下列规则**逐条分类校验**符号链接（不再使用"链接数必须为 0"的简单规则，
因为 `.bin` 下的相对链接完全可移植）：

| 情形                                   | 判定                                 |
| -------------------------------------- | ------------------------------------ |
| 相对路径 + 解析后仍在输出目录内 + 有效 | 允许（`node_modules/.bin` 另行标注） |
| 绝对路径                               | 拒绝 → 先尝试用目标真实内容复制替换  |
| 相对路径但解析后逃逸输出目录           | 拒绝                                 |
| 断链（目标不存在）                     | 拒绝                                 |

每个链接都会打印：路径、`readlink` 目标、是否为绝对路径、`realpath` 结果、
是否位于输出目录内、判定依据。替换采用"复制真实内容"，**不删除依赖**。

脚本随后校验关键依赖版本与 `pnpm-lock.yaml` 一致，并对产物重新执行许可证扫描。
任一步失败即中止镜像构建。

校验器自身的 5 组行为测试（内部相对链接通过 / 逃逸失败 / 绝对失败 / 断链失败 /
绝对链接被复制替换后通过）：`pnpm test:deploy-symlinks`。

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

**job `verify`**（质量门禁，附带 `postgres:16-alpine` service）：
`pnpm install --frozen-lockfile` → `pnpm build:packages` → `pnpm db:deploy`（应用迁移）→
`format:check`（构建前）→ `lint` → `typecheck` → `test`（含数据库集成测试）→
`test:deploy-symlinks` → `check:ci-order` + `test:ci-order`（Docker 启动顺序守卫）→
`pnpm build:apps` → `format:check`（构建后）→
构建后 Git 工作区洁净检查 → `docker compose config` → `license:check` + `license:check:dev` →
`license:report` + `license:report:dev` → 上传两份许可证清单。

**job `docker`**（容器验收）：
`docker compose build` → **只启动 postgres**（`up -d --wait --wait-timeout 120 postgres`）→
宿主机连接串（`127.0.0.1:5432`）执行 `pnpm db:deploy` →
`docker compose up -d --wait`（等待四个服务健康；此时表已存在，Worker 才能 ready）→
`scripts/verify-healthchecks.sh`（校验 web / worker / Caddy→web / Caddy→worker 四个端点）→
容器内加载 `@node-rs/argon2` 做一次 hash/verify → `pnpm admin:create`（迁移已在前一步完成）→
`scripts/verify-auth-smoke.sh`
（经 Caddy HTTPS 完成：登录 → 强制改密 → 创建作者 → 列表校验 → 作者首登改密 →
重置密码 → 停用/启用 → 账号上限）→
浏览器 E2E 准备：建独立 E2E 库 + 宿主机串迁移建号 → **同时重建 web 与 worker**
（容器串 `postgres:5432`），`/api/healthz` 与 `/worker/healthz` 都返回 200 才继续 →
Playwright → 输出容器状态与日志 → `docker compose down -v --remove-orphans` 清理。

> 只重建 web 会让 worker 继续消费默认库，E2E 提交的章节任务永远不会被领取，
> 因此重建命令固定为 `up -d --force-recreate --no-deps --wait web worker`。
> 顺序约束由 `scripts/check-ci-compose-order.mjs` 在 `verify` job 里守住。

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
│   │   ├── app/api/healthz  # 健康检查
│   │   ├── app/api/auth/    # login / logout / me / change-password
│   │   └── src/             # HTTP 适配层与认证运行期单例
│   └── worker/              # 独立 Node Worker（/healthz）
├── packages/
│   ├── shared/              # 前后端共享类型与纯函数（健康状态逻辑）
│   ├── db/                  # Prisma 迁移与连接（账号 / 作品 / 设定 / 物品事件 / 任务）
│   ├── auth/                # 账号、argon2id 哈希、会话、审计、限流、Origin 校验
│   │   └── scripts/         # seed-admin.mjs（一次性创建管理员）
│   ├── works/               # 作品、规则包、设定实体与物品事件流水
│   └── workflow/            # 工作流内核、Provider、Agent、任务队列、单章候选流水线
├── infra/
│   ├── docker-compose.yml       # postgres / web / worker / caddy（默认 production）
│   ├── docker-compose.dev.yml   # 开发模式 override（不改变默认 production）
│   └── docker/                  # Dockerfile 与 Caddyfile
├── scripts/
│   ├── license-check.mjs          # 许可证门禁（--dev 开发依赖 / --dir 扫描 deploy 产物）
│   ├── check-deploy-versions.mjs  # 校验 deploy 产物关键依赖版本与 lockfile 一致
│   ├── check-deploy-symlinks.mjs  # 符号链接逐条分类校验（绝对/断链/逃逸 → 失败）
│   ├── test-deploy-symlinks.mjs   # 上述校验器的 5 组行为测试
│   ├── build-deploy.sh            # 生成可移植生产依赖（链接校验 + 版本/许可证校验）
│   ├── verify-healthchecks.sh     # 四个健康检查端点验证（可移植）
│   ├── verify-auth-smoke.sh       # 登录/退出烟测（容器内真实链路）
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

| 文档                                   | 内容                           |
| -------------------------------------- | ------------------------------ |
| `docs/00-product-brief.md`             | 产品目标、用户、范围边界       |
| `docs/01-mvp-scope.md`                 | 功能清单、优先级、阶段工期     |
| `docs/02-user-flows.md`                | 用户流程与页面清单             |
| `docs/03-data-model.md`                | 数据模型与题材解耦边界         |
| `docs/04-acceptance-tests.md`          | 验收用例与追踪矩阵             |
| `docs/05-architecture-and-licenses.md` | 架构、部署、备份、许可证准入   |
| `docs/06-open-questions.md`            | 待负责人决策的问题             |
| `docs/07-master-roadmap.md`            | 个人可用版优先的总路线         |
| `docs/08-workflow-and-agents.md`       | A1-1 工作流、Provider 与 Agent |
