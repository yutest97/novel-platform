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

| 变量                     | 说明                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`      | 数据库密码（compose 会强制要求该项存在）                             |
| `DATABASE_URL`           | Prisma 连接串。compose 内用服务名 `postgres`；本机直连用 `127.0.0.1` |
| `ADMIN_EMAIL`            | 初始管理员邮箱（只在 `pnpm admin:create` 时读取，不入 Git）          |
| `ADMIN_INITIAL_PASSWORD` | 初始管理员口令（≥12 字符，不入 Git；首次登录必须改密）               |
| `AUTH_SESSION_*`         | 会话绝对/空闲有效期（默认 12 小时 / 30 分钟）                        |
| `APP_ORIGIN`             | 期望站点来源；留空则按请求 Host 同源校验                             |
| `MODEL_API_KEY`          | 模型密钥。**M1-B1 阶段 worker 不调用模型**，留空即可                 |

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

### 首次启动后执行数据库迁移

```bash
pnpm db:deploy           # 执行迁移（= pnpm --filter @novel/db migrate:deploy）
pnpm db:status           # 查看迁移状态
```

> `pnpm db:deploy` 调用的是 **Prisma 迁移**（`prisma migrate deploy`），
> **不是** `pnpm deploy` 包部署命令。
> 迁移要求显式设置 `DATABASE_URL`；缺失时会以非零码退出并给出明确错误，
> 不会退回到占位连接串执行迁移（保护见 `packages/db/scripts/require-database-url.mjs`）。

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
`works`、`rule_packages`、`work_settings`（M2-A 作品核心）。

**不包含**章节、场景、人物、境界、势力、时间线、事实等业务表，
也不包含任何模型调用相关表 —— 那些属于后续阶段。

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

### 浏览器 E2E（Playwright Chromium）

```bash
# 需要先有一个干净数据库 + 一次性管理员，并让应用指向它
BASE_URL=https://localhost:8443 \
ADMIN_EMAIL='e2e-admin@example.test' ADMIN_INITIAL_PASSWORD='…' \
  pnpm --filter @novel/web exec playwright test
```

覆盖（29 个用例，分三个 spec 文件：账号管理 / 作品流程 / 账号上限）：
未登录跳转、首登强制改密、管理员列表、一次性口令只出现一次、
刷新不可回看、作者首登改密、作者越权被拒、重置后旧会话失效、停用后登录被拒、
启用后可登录、退出后保持未登录、第 11 个账号的上限提示，
以及 **REV-01** 新增的：弹窗背景 `inert` + Tab 循环 + Esc 不关闭 + 焦点回归、
会话临近到期自动退出、管理员页清除 Cookie 后执行操作跳回登录页、
作者工作台清除 Cookie 后重新获得焦点跳回登录页、390×844 手机宽度下的
登录 / 表格横向滚动 / 一次性口令弹窗可操作；
**作品流程**：管理员创建两个作者 → 作者 A 创建作品、刷新后仍在 → 打开详情 →
作者 B 看不到且直接访问被拒 → 退出重登后仍在 → 重复标题与校验失败提示可被读屏获取 →
移动端创建作品 → 页面不出现人物/章节/AI 生成入口。

> Playwright 按**文件名字母序**执行，因此 `z-account-limit.spec.ts`（会故意把账号
> 补齐到 10 个）排在最后；管理员改密后的口令通过 `apps/web/.e2e-admin-password`
> 在 spec 文件之间共享（该文件不入仓库、不进镜像上下文）。

移动端截图：`docs/screenshots/m1b3-mobile-login.png`、`m1b3-mobile-admin.png`、
`m1b3-mobile-one-time-password.png`（一次性口令区域同样做模糊处理）。

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

> **执行顺序要求**：`lint` / `typecheck` / `test` 都依赖 `@novel/shared`、`@novel/db`、
> `@novel/auth` 的 `dist` 产物（workspace 依赖以 `dist` 为入口）。因此必须**先执行
> `pnpm build:packages`**，再执行 lint / typecheck / test。干净克隆后尤其要注意。

> **数据库集成测试**：`packages/auth` 与 `apps/web` 的认证测试直接连接**真实
> PostgreSQL**（不使用 mock 替代数据库），因此运行 `pnpm test` 前必须：
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
`test:deploy-symlinks` → `pnpm build:apps` → `format:check`（构建后）→
构建后 Git 工作区洁净检查 → `docker compose config` → `license:check` + `license:check:dev` →
`license:report` + `license:report:dev` → 上传两份许可证清单。

**job `docker`**（容器验收）：
`docker compose build` → `docker compose up -d --wait`（等待四个服务健康）→
`scripts/verify-healthchecks.sh`（校验 web / worker / Caddy→web / Caddy→worker 四个端点）→
容器内加载 `@node-rs/argon2` 做一次 hash/verify → 对容器数据库 `pnpm db:deploy` +
`pnpm admin:create` → `scripts/verify-auth-smoke.sh`
（经 Caddy HTTPS 完成：登录 → 强制改密 → 创建作者 → 列表校验 → 作者首登改密 →
重置密码 → 停用/启用 → 账号上限）→
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
│   │   ├── app/api/healthz  # 健康检查
│   │   ├── app/api/auth/    # login / logout / me / change-password
│   │   └── src/             # HTTP 适配层与认证运行期单例
│   └── worker/              # 独立 Node Worker（/healthz）
├── packages/
│   ├── shared/              # 前后端共享类型与纯函数（健康状态逻辑）
│   ├── db/                  # Prisma 迁移与连接（users / sessions / audit_logs）
│   └── auth/                # 账号、argon2id 哈希、会话、审计、限流、Origin 校验
│       └── scripts/         # seed-admin.mjs（一次性创建管理员）
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

| 文档                                   | 内容                         |
| -------------------------------------- | ---------------------------- |
| `docs/00-product-brief.md`             | 产品目标、用户、范围边界     |
| `docs/01-mvp-scope.md`                 | 功能清单、优先级、阶段工期   |
| `docs/02-user-flows.md`                | 用户流程与页面清单           |
| `docs/03-data-model.md`                | 数据模型与题材解耦边界       |
| `docs/04-acceptance-tests.md`          | 验收用例与追踪矩阵           |
| `docs/05-architecture-and-licenses.md` | 架构、部署、备份、许可证准入 |
| `docs/06-open-questions.md`            | 待负责人决策的问题           |
