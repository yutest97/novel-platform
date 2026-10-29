# 05 架构与许可证（Architecture & Licenses）

- 版本：v1.0（方案稿，待技术负责人审查）
- 状态：**未获批准。**

本文给出推荐技术架构、运行服务、部署、备份恢复方案，以及**许可证准入规则**与首批依赖检查清单。技术方向以项目负责人给定为基线，本文仅提出取舍说明与少量修正建议，**不自行切换技术栈**。

---

## 1. 推荐技术架构（基线 + 取舍）

### 1.1 总体形态

```
浏览器 (作者/管理员)
   │ HTTPS
Caddy (反向代理 + 自动 TLS + 静态/API 分流)
   ├─ web (Next.js + TypeScript, Node 运行时, SSR/API Routes)
   │      └─ 服务端权限校验层 (author_id 注入 + RLS)
   ├─ worker (独立 Node 进程, 消费任务队列)
   │      └─ OpenAI 兼容适配层 (统一 base_url/model/key, 不在浏览器)
   └─ postgres (PostgreSQL 16, 单实例)
```

- 前端与后端同仓库（Next.js 全栈），Worker 为独立进程。
- 任务队列：**PostgreSQL 表轮询**（`generation_tasks` 作队列），第一版**不引入 Redis/BullMQ**。理由见 1.4。

### 1.2 组件清单

| 组件 | 技术 | 备注 |
| --- | --- | --- |
| Web 框架 | Next.js + TypeScript | App Router；API Route 做 BFF |
| 数据库 | PostgreSQL 16 | 任务队列 + 业务数据同库 |
| ORM | Prisma（或 Drizzle，二选一，见 `06`） | 迁移脚本受版本控制 |
| 认证 | 自建会话表 + argon2id + HttpOnly Cookie | 不引入 Auth.js 等重框架（首版 10 人） |
| 后台任务 | 独立 Node Worker | 任务表轮询 + `FOR UPDATE SKIP LOCKED` 抢任务 |
| 模型适配 | 自写 OpenAI 兼容适配层 | 统一 `/chat/completions` 风格；多 base_url 可配 |
| 反向代理 | Caddy | 自动 HTTPS、静态资源、限流 |
| 部署 | Docker Compose + 单台 VPS | 无 K8s、无微服务 |
| 一致性检查器 | 规则包注册的检查器插件（TS 模块） | 题材逻辑进规则包，不进核心 |

### 1.3 与"给定技术方向"的关系

| 方向 | 结论 | 说明 |
| --- | --- | --- |
| Next.js + TS | 采纳 | 无异议 |
| PostgreSQL | 采纳 | 单库承载业务 + 队列，够用 |
| 独立 Worker + PG 持久化任务 | 采纳 | 见 1.4 |
| Docker Compose + Caddy + 单 VPS | 采纳 | 首版规模正确 |
| 不引入 Redis/K8s/微服务 | 采纳 | 明确不做，写入不做清单 |
| OpenAI 兼容适配层 | 采纳 | 建议适配层支持**流式**与**非流式**双模式，并支持超时/重试/降级 |
| API Key 三不进 | 采纳 | Key 存服务端环境变量/密钥文件，Worker 与 web 均可读，但绝不进浏览器/Git/日志 |
| 服务端权限校验 | 采纳 | 见 1.5 |

### 1.4 取舍：为何用 PG 队列而非 Redis/BullMQ

| 方案 | 优点 | 缺点 | 首版选择 |
| --- | --- | --- | --- |
| PG 表轮询 | 少一个组件、任务可查询、崩溃可恢复、单机够用 | 高吞吐下轮询开销大 | **选用** |
| Redis + BullMQ | 延迟低、生态成熟 | 多一个组件、持久化配置复杂、内存成本 | 不选 |

触发条件：首版并发生成 ≤ 2/作者、总作者 ≤10，PG 队列完全够用；**若未来出现"单作者并发 >2"或"全局并发 >50"的需求，才重新评估 Redis**，届时单独立项决策，不默认升级。

### 1.5 服务端权限校验要点

- 每个 API Route 先解析会话 → 得到 `user_id + role`。
- 数据访问服务强制注入 `author_id`；RLS 作为 DB 兜底（是否启用 RLS 见 `06` 待定项）。
- 管理员运维视图为独立 service，普通作者接口不暴露该能力。
- 前端路由守卫仅是体验，**不构成安全边界**。

---

## 2. 运行服务（Docker Compose 拓扑）

```
services:
  web:      build ./web        ports: 内部 3000
  worker:   build ./worker     依赖 postgres
  postgres: postgres:16        持久卷 pgdata
  caddy:    caddy:2            端口 80/443
```

- 环境变量统一由 `.env`（不入库、`.gitignore`）注入；生产密钥建议放 VPS 上由部署脚本注入。
- Worker 与 web 共享模型适配层代码（monorepo 内 shared 包）。
- 健康检查：postgres `pg_isready`；web/worker HTTP `/healthz`。

---

## 3. 部署方案（单台 VPS）

1. `git clone` 私有仓库（**仓库必须为私有，禁止公开**，见 §6 许可证与保密联动）。
2. 配置 `.env`：DB 密码、模型 base_url/key、Caddy 域名。
3. `docker compose up -d` 启动 web + worker + postgres + caddy。
4. Caddy 自动申请 TLS（域名需已解析到 VPS）。
5. 初始管理员账号：首次启动种子脚本创建（或部署时注入）。

回滚：`docker compose down` → 拉取旧镜像 tag → 重新 up；数据卷不随容器删除。

---

## 4. 数据备份与恢复

| 项 | 方案 |
| --- | --- |
| 备份对象 | PostgreSQL 全量（`pg_dump`，每日）+ 生成的文件导出（若存磁盘） |
| 备份方式 | `pg_dump -Fc` 自定义格式，可做 PITR 则用 WAL 归档（可选） |
| 备份周期 | 每日一次全量，保留最近 7 天；每周归档一份保留 30 天 |
| 异地 | 备份文件同步到另一台机器/对象存储（管理员自配，首版给出脚本） |
| 恢复演练 | 每月一次，恢复到临时库并校验关键表行数（呼应 `04` AT-R1） |
| 恢复步骤 | `pg_restore` 到新库 → 校验和 → 切换连接 |

**验证口径**：恢复后 `works/chapter_versions/generation_tasks` 行数一致，抽样 1 部作品正文逐字节一致。

---

## 5. 安全基线（与许可证并列的合规要求）

- 仓库私有、`gitignore` 排除 `.env`、密钥与 Key。
- 依赖锁定（`package-lock.json` / `pnpm-lock.yaml`）入库，构建可复现。
- 定期 `npm audit`，高危依赖评估修复。
- 日志脱敏：不打印 API Key、正文内容默认不打日志（正文属敏感内容）。
- 登录限流、密码策略见 `01` §2.1。

---

## 6. 许可证准入规则

### 6.1 硬规则（不可违背）

1. 产品保持**闭源**；不接受"修改后须按 AGPL 开源"的传染义务。
2. **禁止**复制/修改/吸收 InkOS、AI_NovelGenerator 及其他 AGPL/GPL 项目的代码进仓库。
3. 可将其作为**竞品研究**，但研究产出（笔记/结论）不包含其源码片段；如需引用，只引用公开文档描述，且不复制代码。
4. 允许闭源分发的依赖（MIT / Apache-2.0 / BSD-2/3-Clause / ISC 等）可用，但必须**保留许可证与版权声明**（随发行提供 LICENSE/NOTICE）。
5. 提交任何代码前，必须检查**直接 + 传递**依赖许可证。
6. 发现某依赖可能要求开源本产品 → **立即停止使用并上报**，不得自行绕过。

### 6.2 判定表（首版常见类别）

| 许可证 | 闭源可用 | 需保留声明 | 注意 |
| --- | --- | --- | --- |
| MIT | 是 | 是 | 宽松 |
| Apache-2.0 | 是 | 是（含 NOTICE） | 注意专利条款 |
| BSD-2/3-Clause | 是 | 是 | 宽松 |
| ISC | 是 | 是 | 宽松 |
| GPL / LGPL / AGPL / SSPL | 否（AGPL/SSPL 传染，尤其网络服务） | — | **禁用**（静态/动态链接均谨慎） |
| 未注明许可证 | 否 | — | 默认拒绝，除非书面确认 |

> 说明：LGPL 在"动态链接 + 不改源码"下可能可用，但首版为避免合规复杂度，**默认不引入任何 GPL 系**，统一走宽松许可证。

### 6.3 检查工具与方法

- 使用 `license-checker` / `licensee` / `pnpm licenses` 等工具扫描 `node_modules` 生成清单（阶段二落地）。
- 建立 `docs/licenses/` 目录存放生成的许可证清单与 `NOTICE`。
- CI 加入许可证门禁：发现 GPL 系即失败。

---

## 7. 首批依赖许可证检查清单（预登记，阶段二落地核对）

> 下列为**预期**会用到且通常宽松许可证的依赖；实际版本许可证以 `license-checker` 扫描结果为准，本清单仅为预登记，**不视为已检查通过**。

| 依赖 | 用途 | 预期许可证 | 待确认项 |
| --- | --- | --- | --- |
| next / react / react-dom | Web | MIT | — |
| typescript | 编译 | Apache-2.0 | — |
| prisma（或 drizzle-orm） | ORM | Apache-2.0（Prisma）/ Apache-2.0（Drizzle） | 二选一待定 |
| pg | PG 驱动 | MIT | — |
| argon2（或 bcryptjs） | 密码哈希 | MIT | 原生模块构建 |
| zod | 校验 | MIT | — |
| tailwindcss | 样式 | MIT | — |
| markdown-it（或 remark） | Markdown 渲染 | MIT | — |
| diff（或 jsdiff） | 版本 diff | MIT | 选型 |
| openai（可选；或自写 fetch 适配） | 模型调用 | Apache-2.0 | 若自写适配层可不用 SDK |
| caddy | 反向代理 | Apache-2.0 | 二进制分发 |
| postgres:16 | 数据库 | PostgreSQL License（宽松） | — |

**红线**：任何一步引入疑似 GPL/AGPL/SSPL 依赖（如某些 PDF/文档库），立即停用并上报（见 `06` 待定项：导出 Word 的实现方式需确认许可证）。

---

## 8. 架构层面的待定项（转 `06`）

- ORM 选 Prisma 还是 Drizzle。
- 是否启用 PostgreSQL RLS 作为第二道防线。
- 导出 Word（.docx）的实现方式（自研 zip 写 OOXML vs 引入 docx 库的许可证确认）。
- 模型适配层是否用官方 `openai` SDK 还是自写 fetch（影响依赖面与许可证）。
- 一致性检查器是"规则引擎 JSON 驱动"还是"代码插件 + JSON 配置"（影响解耦程度与实现成本）。
