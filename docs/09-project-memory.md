# 09 项目记忆（当前事实快照）

- 更新日期：2026-11-07
- 最后已验收产品基线：`07cb346`（A2-F-C-REV-01）
- 对应 CI：A2-F-C-REV-01，CI #25 绿色
- 当前产品阶段：A1 / A2 已验收；C1-A-REV-02 本地复审通过；C1-B-A1 本地完成待复审
  （均未推送、未过远端 CI）；下一步为 C1-B-A2 Coordinator 创意工具与确认 UI；
  事实写回与高级审阅门禁后移

当前本地提交状态一律以 `git status --short --branch` 为准，不在本文硬编码
“ahead / clean”等会随提交立即失效的信息。

> 本文是给新会话、新 Agent 和复审者的短上下文入口。
> 详细契约仍以 `docs/03` / `docs/04` / `docs/08` 和当前代码为准。
> 本文不重复全部历史，只记录当前真相、冻结决策、风险和下一步。

---

## 1. 当前已交付

### 账号、作品与设定中心

- 管理员/作者账号、会话、权限、审计；
- 作品、作品方向、人物、势力、境界、物品、功法；
- 物品持有人、物品事件流水、时间线与冲正；
- 作者归属隔离、管理员普通作品接口 403。

### A1 章节生产闭环

- `generation_tasks` 工作流状态机、租约、心跳、取消、重试、幂等；
- MockProvider / OpenAI 兼容 Provider；
- Planner Agent、Writer Agent；
- 章节合同 `chapter_contracts`、正文候选 `chapter_candidates`；
- 作者采纳候选后生成 append-only 正式版本 `chapter_versions`；
- Worker 常驻循环、provider/model 预检和健康检查；
- 章节列表、工作台、生成轮询、候选预览、采纳；
- Markdown 人工编辑器、人工版本保存；
- 正式版本 diff、历史版本恢复；
- 章节定稿；定稿后人工 revision 会回到 `in_review`。

### A2 连续性事实

- `continuity.extractor@1.0.0`；
- 六类事实候选：人物状态、关系、物品、境界、情节线索、人物位置；
- `chapter_fact_runs`、`chapter_fact_candidates`；
- 只允许定稿章节的当前最新正式版本；
- 同版本幂等、running 租约、attempt_token fencing；
- 提交阶段重新校验定稿状态和最新版本；
- 事实候选 append-only，不自动写回实体；
- 事实提取 API、候选列表/详情、run 状态；
- 默认 Mock 可成功提取空事实；
- 列表使用单条 SQL 保证 `total` 与集合同快照；
- 章节工作台事实审阅区：定稿最新版显式提取、六类筛选、total / truncated 提示、
  两种空态与局部重读；
- 事实候选决策 API：`chapter_fact_decisions`（UNIQUE(candidate_id) + 复合外键 +
  append-only），接受 / 拒绝只记录决定，**不写回任何实体或物品事件**；
  同决定幂等、不同决定 409、过期候选 409；
- 事实列表 / 详情回显 `decision: { value, decidedAt } | null`（单条 SQL LEFT JOIN、
  无 N+1），只暴露 value 与时间，不含 decidedBy；
- 事实审阅区的**决策 UI**：未决定候选显示接受 / 拒绝按钮（只在章节已定稿、
  候选属于当前最新正式版本时出现）；已决显示「已接受」/「已拒绝」徽章与决定时间，
  并声明"决定已记录；当前不会自动修改人物、物品、势力、关系或境界"；
  冲突 / 过期 / 网络错误各有稳定文案且只影响当前候选；
  每条候选独立 in-flight，双击与同时点两个按钮只发一个请求；
  列表有版本身份，切筛选后到达的旧决定响应被完全丢弃。
  **没有**批量决定、撤销、改判或写回入口。

### A2-C-A Reviewer Agent 契约（已验收）

- `reviewer.chapter@1.0.0`：严格输入 / 输出 Schema，正文上限 20 万字符；
- 输入只含章节标识、冻结合同、正文候选、四类安全实体摘要与前章摘要；
- `secret*`、prompt、模型原始响应、Key 等未声明字段一律拒绝；
- 输出为 `passed + issues[]`，问题只允许固定 severity / type 白名单；
- 代码语义校验拒绝空白、超长、非正文子串 evidence、重复 `type + evidence`
  以及 `passed` 与 issues 数量矛盾，统一为 `AGENT_OUTPUT_INVALID`；
- `createChapterReviewerMockProvider()` 默认无问题，可注入固定问题；
- 尚未接入 `chapter.draft`、数据库、API、UI 或 Worker。
- CI #24 绿色；提交 `1482573` 已进入远端 `main`。

### A2-C-B Reviewer 候选审阅执行与持久化（已验收）

- 独立 `chapter.review` 任务：输入只有 `{ candidateId }`，requestId `review:<candidateId>`；
- Writer 候选保存与审阅任务入队在**同一个作品锁事务**内提交，崩溃不会留下没有审阅任务的候选；
- `chapter_review_runs` / `chapter_review_issues`：`UNIQUE(candidate_id)`、
  `UNIQUE(generation_task_id)`、issue 复合外键、结论自洽 CHECK、append-only 触发器；
- issue 只允许写入 running run；succeeded / failed 终态后不可追加，避免 issue_count 失真；
- 固定三步 `load_review_input → run_reviewer → persist_review_result`；
- run 复用：成功跳过、失败重试复用同一行、失去租约的 running 被接管；
- 失败只影响 review task / run，不回滚候选、不改变章节状态与采纳权；
- 取消 / 重试用尽由 `generation_tasks_close_review_run` 触发器兜底，不留永久 running；
- 作者读接口只展示 `chapter.draft` 任务，审阅任务不会成为"最新正文任务"；
- 仍**没有**检查结果 API / UI，`priorSummaries` 固定为空（A2-D 未实现）。

### A2-D-A Summarizer Agent 契约（已验收）

- `summarizer.chapter@1.0.0`：输入只有章节标识、正式版本追溯标识与正文（1..200000 字符）；
- 标题 trim 后必须非空（Schema 兜不住纯空白，`assertSummarizerInput` 在代码侧拒绝）；
- 输出只有 `summary`（1..1000 字符），拒绝未知字段、空白、Markdown 标题与代码块；
- 错误统一 `AGENT_INPUT_INVALID` / `AGENT_OUTPUT_INVALID`，只带路径与固定原因；
- `createChapterSummarizerMockProvider()` 默认输出确定、非空，可注入固定 summary；
- `runChapterSummarizer()` 纯内存：输入校验 → AgentRunner → 专用语义校验；
- **未接**数据库、`chapter.summarize` 任务、Worker、API / UI，Reviewer 的
  `priorSummaries` 仍未接线。

### A2-D-B 定稿章节摘要任务与持久化（已验收）

- 章节定稿与 `chapter.summarize` 任务入队在**同一个作品锁事务**内提交；
- 任务输入只有 `{ sourceVersionId }`，requestId `summary:<sourceVersionId>`；
  provider / model 由 finalize API 在服务端解析，请求体与响应字段不变；
- `chapter_summaries`：`UNIQUE(source_version_id)`、复合外键、
  1..1000 字且 btrim 非空 CHECK、append-only 触发器；
- 固定三步 `load_summary_input → summarize_chapter → persist_summary`；
- 只处理"当前 finalized 且该版本是最新正式版本"；提交阶段再次校验，
  模型调用期间的 revision 会得到 `SUMMARY_SOURCE_VERSION_STALE` 且不写摘要；
- 已有同版本摘要 → skip（不调用模型）；任务重试复用同一 task；
- 失败 / 取消不修改章节、版本、候选、合同或采纳权，不写 audit_logs；
- 仍**没有**摘要读取 API / UI，Reviewer `priorSummaries` 仍固定为空。

### A2-D-B-REV-01 定稿不被摘要配置阻断（已验收）

- finalize 路由对 summary spec 做 best-effort 解析：`MODEL_NOT_CONFIGURED` →
  `summary = null`，**定稿照常成功**，只跳过摘要任务；
- 不伪造 provider / model 占位值，不构造模型请求，不联网，错误不进响应 / 日志 / 审计；
- 配置恢复后，同版本**再次幂等 finalize** 才补齐任务（无手动重建接口）；
- 确定性内部任务按 requestId + taskType + chapterId + inputSnapshot 判同一逻辑任务，
  **不再比较 input_hash**：配置漂移时复用既有 task 且不覆盖其 provider / model；
  旧 task 是否可执行仍由 Worker 预检决定（`TASK_MODEL_CONFIG_MISMATCH`）。

### A2-D-C Reviewer 前章摘要接线（已验收）

- `buildChapterReviewContext` 新增 `loadPriorSummaries()`：一条 SQL 选出
  「同作品 + `chapter_no <` 当前章 + 前章 `finalized` + 摘要对应该章当前最新正式版本」
  的摘要，按 `chapter_no DESC` 取 20 条再反转为升序；
- 当前章 / 未来章 / 跨作品 / 已 revision 的旧摘要都不会进入；
  重新定稿后使用新版本摘要；同一章节只一条；
- 无摘要时为 `[]`（不猜测、不用正文补）；
- `task_contexts` 新增 `chapter_summary` 来源：只记 summary id 与 `第N章摘要`，
  不复制摘要正文；
- 无 migration、无 API / UI。

### C1-A Coordinator Runtime 与动态问答（REV-02 复审通过，本地未推送）

- `novel.coordinator@1.0.0`：严格输入 / 输出 Schema，只允许 `ask_user` / `finish`；
  `ask_user` 允许 0–6 个选项（空数组表示开放式回答；非空时 trim 后非空且不重复），
  `finish` 必须带结束原因；输出中的 SQL / Prisma / 文件路径 / shell / HTML 片段一律拒绝；
- `NOVEL_TOOL_WORKFLOWS`：每个工具声明允许状态、输入 Schema、成功迁移、
  sideEffect、重试上限与超时；Runtime 负责工具白名单、状态迁移、预算、
  重复动作熔断、取消优先、租约 fencing 与落库；
- 超时与租约分离：`leaseAbort` 只响应心跳失败 / 取消 / 真实 fence 失败；
  每次 attempt 的 `attemptAbort` 只负责单次模型硬超时（可注入
  `modelCallTimeoutMs`，生产默认 60 秒）。超时记 `MODEL_TIMEOUT` 可重试调用；
- `novel_agent_calls` 是调用遥测：每次实际调用完成后立即追加（`step_id` 可为空），
  与 step / state 提交解耦；旧 Worker 可补真实调用遥测，但不得写 step / state；
  token 预算统计所有实际调用；
- 失败调用的 usage 保留：Schema 校验失败或内容 JSON 解析失败时，Provider 已返回的
  provider / model / usage / latency 会附在安全错误上并写入调用遥测；只有 Provider
  确实未返回 usage 时才记 0；错误与日志不含 prompt、原始输出或底层异常；
- 租约有效性由 PostgreSQL `clock_timestamp()` 判断，应用时钟漂移不影响 fence；
  `commitSuccess` / `commitFailure` / `failWithoutStep` 的条件 UPDATE 都再次校验
  `lease_until > clock_timestamp()`；
- `novel_runs` / `novel_run_steps` / `novel_agent_calls`：
  CHECK + 触发器保证状态迁移合法、`request_text` / `max_steps` / 归属不可变、
  step 与 call append-only、run 不可删除；
- Worker 新增独立 novel 轮询循环，与 generation 循环共用健康检查端口并合并状态；
- 4 个 API：创建、读取、回答（带 `expectedVersion`）、取消；
  `readNovelRun()` 在 `RepeatableRead` 同一快照读取 run 与最新成功 step；
- `/novel-runs/[runId]` 动态问答页：1s → 2s → 5s 轮询；页面隐藏时初始 tick 与
  后续调度都真正暂停，恢复可见立即补一次并重置退避；回答冲突提示并重取；
- C1-A 只产生 `waiting_user` / `completed` / `failed` / `cancelled`，
  **不产生 `waiting_approval`**；不创建 Work、章节或正文。

### C1-B-A1 故事候选域与 Concept Agent（本地完成，待复审）

- 迁移 `20261107090000_c1b_a1_novel_artifacts`：三张 append-only 候选表
  `novel_artifacts` / `novel_artifact_revisions` / `novel_artifact_decisions`；
  复合外键把 revision / decision 钉到同一 run + author，`current_revision` 与
  revision 最大编号用**延迟约束触发器**在提交时校验；
- artifact 状态机：`draft → pending_approval → approved | rejected`，
  `rejected → draft`（仅随新 revision），approved 终态且禁止新 revision；
- `novel.concept@1.0.0`：输入只允许 `requestText` / `knownFacts[]` / `authorFocus`，
  输出严格 Schema（1–3 标题、3–6 卖点、1–5 主题、0–5 问题等），
  拒绝 HTML / Markdown / SQL / Prisma / 路径 / shell / 下一步工具 / 数据库写入意图，
  非法输出统一 `AGENT_OUTPUT_INVALID` 且不回显原文；
- `createNovelConceptMockProvider()` 确定性、不读时钟 / Key / 网络、不回显作者原文；
- `createConceptCandidate` / `requestConceptApproval` / `decideConceptArtifact` /
  `readConceptArtifact`：run + artifact 双行锁、`state_version` 与
  `current_revision` 双 fence、内容哈希幂等、同决定幂等 / 不同决定冲突；
- 每次实际模型调用写 `novel_agent_calls`（`call_kind='tool'`，`step_id` 可空），
  只存 provider / model / usage / latency / success / error_code，不存 prompt / 原始输出 / Key；
- 新错误码：`NOVEL_ARTIFACT_NOT_FOUND` / `NOVEL_ARTIFACT_VERSION_CONFLICT` /
  `NOVEL_ARTIFACT_DECISION_STALE` / `NOVEL_ARTIFACT_ALREADY_DECIDED` /
  `NOVEL_ARTIFACT_ALREADY_APPROVED`；跨作者与不存在统一 404；
- `novel_runs` 状态机扩展 `queued / running / waiting_user → waiting_approval`
  与 `waiting_approval → completed / failed / cancelled`；
- **不接** Coordinator / HTTP API / UI / E2E，不创建 Work，不生成其它 Agent。

---

## 2. 当前冻结决策

### 控制层与 Agent

```text
Coordinator 选择下一个受控 action
Runtime 负责校验、门禁、工具执行、落库和状态推进
专用 Agent 产出候选
作者负责最终采纳
```

- Agent 不直接写数据库；
- 除 Coordinator 外，Agent 不决定下一步；
- Agent 不自动采纳；
- 不允许 Agent 自由对话或无限自动重写；
- 工作流使用 PostgreSQL 状态，不使用文件式 `status.md`。

### 正文版本

- 正式版本 append-only；
- AI 正文先进入候选，作者明确采纳后才成为正式版本；
- 定稿只锁定当前最新正式版本；
- 定稿后可以人工 revision，但会回到待定稿；
- 历史版本恢复会追加新版本，不覆盖旧版本。

### 事实与连续性

- FactExtractor 已在 A2 提前完成后端；
- 事实只从定稿版本产生；
- 事实候选不自动修改任何实体或物品事件；
- attempt_token 防止被接管旧调用晚返回后覆盖新调用；
- 用户尚未确认事实候选的采纳/拒绝语义和写回时机。

### 依赖与部署

- pnpm 固定 `10.34.9`，Node 固定 `22.22.2`；
- `pnpm deploy --legacy` 不读 workspace lockfile，deploy 后必须独立校验版本与许可证；
- `caniuse-lite` 精确锁定 `1.0.30001822`；
- CC-BY-4.0 不按许可证整体放行，只按包名和精确版本审阅；
- `caniuse-lite` 已属于 deploy 关键版本守卫。

### CI 连接串

- Web / Worker 容器：`@postgres:5432`；
- Playwright 与宿主机 Prisma：`@127.0.0.1:5432`；
- 首次启动顺序：PostgreSQL → `db:deploy` → 四服务；
- Worker 空库未迁移时保持健康端口生命、`retrying + 503`，迁移后自动 ready。

---

## 3. Agent 顺序与后续路线

当前确认的目标顺序：

| 阶段 | Agent / 能力 | 状态 |
| --- | --- | --- |
| A1 | Planner、Writer | 已完成 |
| A2-A/B | FactExtractor 后端与 API | 已完成；提前实现 |
| A2-C | Reviewer Agent | 已验收（CI #25）：契约、执行、持久化、结果 API 与展示 UI |
| A2-D | Summarizer Agent | 已验收（CI #25）：契约、定稿任务、摘要落库、前章摘要接线、摘要 API 与 UI |
| A2-E | 事实候选只读审阅 UI | 已验收（CI #25）：提取、六类筛选、total / truncated、空态与纯文本展示 |
| A2-F | 事实候选决策 | A2-F-A/B/C 已验收（CI #25）：决策记录/API、状态读取、决策 UI；不写回实体 |
| C1-A | Coordinator Runtime + 工作流 + 动态问答壳 | REV-02 本地复审通过：失败调用 usage 保留、数据库时钟 lease fence、隐藏轮询与 options 已验收；未推送 / 未过远端 CI |
| C1-B-A1 | 故事候选域与 Concept Agent | 本地完成待复审：artifact 三表、`novel.concept`、Mock、候选 / 决策服务；不接 API/UI |
| C1-B-A2 | Coordinator 创意工具与确认 UI | 下一步：Coordinator 1.1、`concept.generate` / approval tool、API、UI、E2E |
| C1-B-B | 世界观、人物与剧情 Agent | 待 C1-B-A2：扩展世界规则、人物关系与主线候选 |
| C1-B-C | 三级大纲 | 待 C1-B-B：全书 / 分卷 / 章节大纲候选与确认门禁 |
| C1-B-D | 故事圣经编辑与 Work 绑定 | 待 C1-B-C：完整编辑、历史 revision、确认投影与受控 Work 绑定 |
| C1-C | 正文生产闭环 | 待 C1-B：Composer/Writer/Reviser，复用 Reviewer/Summarizer/FactExtractor，确认大纲后写作 |
| C1-D | 连续性与故事记忆 | 待 C1-C：Continuity/设定审查/文风审查/伏笔/Librarian 写回/故事一致性 |
| C1-E | 高级可选能力 | 待 C1-D：多稿、质量裁定、文风 Skill、跨卷伏笔与批量记忆 |
| A3 | Consistency Agent、检索/图谱 | 待评估 |

说明：

- FactExtractor 比最初 Agent 时间表提前完成，不回退；
- 事实 UI 优先级低于 Reviewer / Summarizer；
- Reviewer 初期建议以结构化警告为主，不直接阻止作者采纳；
- Summarizer 只处理正式定稿版本；
- RAG、embedding、关系图和 Neo4j 不是当前前置。

---

## 4. 当前下一步

产品方向已根据作者选择重新收敛：只保留一个语义调度中心——Coordinator Agent。
现有 WorkflowKernel / Worker 保留为持久化、租约、重试和工具执行基础设施，不再
硬编码小说创作阶段顺序。

### C1-A 现状（REV-02 本地复审通过）

- Runtime / 工具工作流 / 三张表 / Worker 轮询 / 4 个 API / 动态问答页与浏览器 E2E 已完成；
- `C1-A-REV-01` 已修复六类复审问题：超时/租约分离、即时调用遥测、Mock 脱敏、
  隐藏页真正暂停轮询、`ask_user.options` 0..6、`readNovelRun()` 同快照读取；
- `C1-A-REV-02` 已修复三个 P2：Schema-invalid / invalid-JSON 失败调用保留已发生的
  usage；lease fence 与最终条件 UPDATE 改由数据库 `clock_timestamp()` 判断；
  `docs/07` / `docs/08` / `docs/09` 状态、测试数和已修复风险已同步；
- 当前 Runtime 不产生 `waiting_approval`（C1-B-A1 已扩展 run 状态机白名单，
  但尚未接入 Runtime）；
- C1-A-REV-02 已本地复审通过：全量单测 1189、E2E 160、15 migrations /
  26 表 / 19 触发器；尚未推送，也未经过远端 CI；
- C1-B-A1 已本地完成待复审：artifact 三表、Concept Agent / Mock / 服务层；
  全量单测 1227、E2E 160、16 migrations / 29 表 / 25 触发器；
- 当前下一步：`C1-B-A2` Coordinator 1.1 与 `concept.generate` / approval tool、
  HTTP API、最小候选 UI 与 E2E；
- C1-B 前置：`novel_runs.work_id` 在 C1-A migration 中不可变。C1-B 开工前必须
  设计受控的一次性绑定方案（专用绑定表，或新的未发布 migration 允许
  `NULL → work_id` 单次迁移），校验作品属于同一作者且只能绑定一次；
  本卡不实现任何 Work 功能。

C1 方案 v2 已把完整 Agent 能力地图纳入规划：创意、世界观、人物、剧情、全书/分卷/
章节大纲、Composer、Writer、多稿、文风、Reviewer、Continuity、设定审查、文风审查、
Reviser、质量裁定、Summarizer、FactExtractor、Librarian、伏笔和故事一致性。
“全集”是能力地图，不代表每一项都必须是独立 LLM Agent：

- 纯语义生成优先由严格 Schema 的 LLM Agent 完成；
- 上下文装配、正式资料写回和故事状态投影以确定性服务为骨架；
- 多稿、质量裁定和高级文风能力是 C1-E 可选能力，不进入默认 MVP 主路径；
- 除 Coordinator 外，任何 Agent 都不能选择下一步或互相自由对话。

Agent 与工作流按两个维度落地：

- Agent 负责“谁做”：在节点内输出结构化候选或问题；
- Coordinator 动态编排层负责“语义上下一刀切哪里”；
- 每个 tool 内部仍有固定 guard → execute → validate → commit 工作流；
- PostgreSQL 状态、租约、fencing、重试、取消、回退和原子提交由确定性代码控制；
- Reviewer 等 Agent 只给问题，是否通过、修订、等待作者或失败由工作流门禁决定。

完整方案：`docs/plans/C1-coordinator-agent-runtime.md`。

C1-A 实施卡：`docs/tasks/C1-A-coordinator-runtime.md`（首次实现已提交 `a5e3707`，
复审不通过）。
C1-A-REV-01 卡：`docs/tasks/C1-A-REV-01-coordinator-runtime.md`（代码已提交
`a40a0dd`）。
C1-A-REV-02 卡：`docs/tasks/C1-A-REV-02-coordinator-runtime.md`（本地复审通过）。
C1-B-A1 卡：`docs/tasks/C1-B-A1-story-artifact-concept.md`（本地完成待复审）。
C1-B-A2 卡：下一张，Coordinator 1.1 与确认 UI。
C1-A 同时交付最小“写新小说”动态问答页，确保每个阶段都有作者可感知的纵向切片。

C1 的默认产品路径是“核心创意 → 世界观 → 人物 → 剧情 → 全书/分卷/章节大纲 →
故事圣经确认 → 开始写作”，但这是 Coordinator 的默认判断，不是 Runtime 写死的阶段。
作者可以要求先补世界观、退回重做人物，或直接调整已确认大纲。

A2 的 Agent 功能链已经通过 CI #25：

```text
定稿 → 摘要 → Reviewer（含前章摘要）→ 事实提取 → 事实审阅 → 接受/拒绝记录
```

当前事实侧已经形成“提取 → 只读审阅 → 决策记录 → 决策回显 → 决策 UI”的闭环。

C1 完成前，A2 的实体写回、摘要批量视图、高级 Reviewer 门禁和人工重检不抢占主线；
其中事实写回在 C1-D 由 Librarian 的确定性事务承接，仍必须服从作者确认与版本有效性。

尚待产品确认：

- high severity 是否阻止候选展示/采纳，还是只警告（当前实现落库 + 页面展示，**不阻断**采纳）；
- Reviewer 是否每次 Writer 后自动运行（当前是自动入队，但没有开关）；
- Reviewer 失败是否影响正文候选保存（当前明确不影响）；
- 是否允许作者手动重新检查（当前没有入口，只有读取失败时的"重新读取"）。

建议默认（已按此实现）：

- Reviewer 问题只警告，不自动阻止作者；
- Reviewer 自身失败不回滚已保存的 Writer 候选；
- 作者可显式查看警告后采纳；
- 后续根据真实误报率决定是否加强对采纳的门禁。

---

## 5. 已暂停 / 后置

- M2-B4 资源余额流水：暂停，不删除；
- 多作者邀请、运营配额：后置；
- 事实自动写回人物/物品/势力/关系/境界：未做；
- 事实接受/拒绝：未做；
- RAG / embedding / 图数据库：未做；
- 自动无限重写循环：明确不做。

---

## 6. 当前质量基线

截至最后已验收基线 `07cb346`：

| 项目 | 数量 |
| --- | --- |
| 全量单测 | **1128** |
| 浏览器 E2E | **158** |
| migrations | **14** |
| 数据表 | **24** |
| 数据库触发器 | **16** |
| deploy 版本守卫行为测试 | 22 |

A2-C-A 新增 18 个 workflow 纯单测，workflow 包当时 **262** 个测试。
migrations / 数据表 / 触发器保持 **11 / 20 / 10**。

A2 完整 Agent 能力链通过 CI #25 后的当前数字：

| 项目 | 数量 |
| --- | --- |
| 全量单测 | **1128**（web 445 / workflow 368 / works 132 / auth 95 / worker 63 / shared 15 / db 10） |
| 浏览器 E2E | **158** |
| migrations | **14** |
| 数据表 | **24** |
| 数据库触发器 | **16** |

新增 24 个 workflow 集成测试（`chapter-review-workflow.test.ts`）；
另有 1 个既有用例拆成两个参数化用例（正文状态 drafting / in_review）；
A2-D-A 再新增 17 个纯单测（`chapter-summarizer-agent.test.ts`）；
A2-D-B 新增 20 个 workflow 集成测试（`chapter-summary-workflow.test.ts`）
与 1 个定稿 API 用例；A2-D-B-REV-01 再补 5 个定稿 API 用例与 2 个 workflow 用例；
A2-D-C 新增 12 个 workflow 用例（前章摘要选择规则）；
A2-C-D 新增 17 个只读 API 用例（`chapter-review-api.test.ts`）与 9 个
响应解析用例（`chapter-review-view.test.ts`）；A2-C-E 再新增 17 个面板纯函数用例
（`chapter-review-panel.test.ts`）与 9 个浏览器 E2E（`chapter-review-ui.spec.ts`）；
A2-D-D 再新增 7 个摘要只读 API 用例（`chapter-summary-api.test.ts`）与 8 个
响应解析用例（`chapter-summary-view.test.ts`）；A2-D-E 又新增 11 个摘要卡片纯函数用例
（`chapter-summary-panel.test.ts`）与 9 个浏览器 E2E（`chapter-summary-ui.spec.ts`）；
A2-E 再新增 24 个事实面板纯函数用例（`chapter-facts-panel.test.ts`）与 12 个浏览器 E2E
（`chapter-facts-ui.spec.ts`）；A2-F-A 再新增 19 个决策服务集成用例
（`chapter-fact-decision.test.ts`）与 14 个决策 API 用例
（`chapter-fact-decision-api.test.ts`）；A2-F-B 再新增 11 个决策读取集成用例
（`chapter-fact-decision-read.test.ts`，含单条 SQL / 无 N+1 的计数代理守卫）
与 3 个 HTTP 层决策回显用例（并入 `chapter-facts-api.test.ts`）；
A2-F-C 再新增 20 个决策面板纯函数用例（`chapter-fact-decision.test.ts`）
与 10 个浏览器 E2E（`chapter-fact-decision-ui.spec.ts`），
因此 web **445**、workflow **368**、全量 **1128**、E2E **158**。

C1-A 首次完成（REV-01 修复前）的历史数字：

| 项目 | 数量 |
| --- | --- |
| 全量单测 | **1170**（web 457 / workflow 398 / works 132 / auth 95 / worker 63 / shared 15 / db 10） |
| 浏览器 E2E | **159** |
| migrations | **15** |
| 数据表 | **26**（不含 `_prisma_migrations`） |
| 数据库触发器 | **19** |

C1-A-REV-01 修复完成后的当前数字：

| 项目 | 数量 |
| --- | --- |
| 全量单测 | **1179**（web 458 / workflow 406 / works 132 / auth 95 / worker 63 / shared 15 / db 10） |
| 浏览器 E2E | **160** |
| migrations | **15** |
| 数据表 | **26**（不含 `_prisma_migrations`） |
| 数据库触发器 | **19** |

REV-01 新增 8 个 workflow 用例、1 个 web 用例与 1 个浏览器 E2E
（`novel-run-visibility.spec.ts`）。两处灵敏度验证：

1. Mock 输出回显作者原文（移除脱敏过滤）→ Mock 安全用例失败；
2. 模型硬超时复用 lease abort → 「超时不应误判为 lease-lost」用例失败；
   恢复后相关测试全绿。

C1-A-REV-02 修复后的当前数字：

| 项目 | 数量 |
| --- | --- |
| 全量单测 | **1189**（web 458 / workflow 416 / works 132 / auth 95 / worker 63 / shared 15 / db 10） |
| 浏览器 E2E | **160** |
| migrations | **15** |
| 数据表 | **26**（不含 `_prisma_migrations`） |
| 数据库触发器 | **19** |

REV-02 新增 10 个 workflow 用例（`novel-runtime.test.ts`）：
5 个失败调用 usage 保留 / token 预算累计，5 个数据库时钟租约 fence
（应用时钟偏快 / 偏慢、fence 后 UPDATE 前过期、心跳 locked_by / state_version）。

C1-B-A1 完成后的当前数字：

| 项目 | 数量 |
| --- | --- |
| 全量单测 | **1227**（web 458 / workflow 454 / works 132 / auth 95 / worker 63 / shared 15 / db 10） |
| 浏览器 E2E | **160**（本卡无新增 E2E） |
| migrations | **16** |
| 数据表 | **29**（不含 `_prisma_migrations`） |
| 数据库触发器 | **25**（distinct trigger） |

C1-B-A1 新增 38 个 workflow 用例：15 个 Concept Agent / Mock 纯单测
（`novel-concept-agent.test.ts`）与 23 个真实 PostgreSQL 用例
（`novel-concept-service.test.ts`，覆盖三表约束、append-only、状态机、
approved 终态、内容长度、revision / decision 一致性、幂等、双 fence、
跨作者 404、失败调用脱敏遥测）。空库 migration 与 E2E 都在全新库上重跑：
29 表 / 16 migrations / 25 触发器 / 86 CHECK。

C1-B-A1 的三处灵敏度验证：

1. 删除事务内 approved 门禁（保留调用前快照门禁）→
   「旧 Worker 晚返回：批准后不能覆盖新 artifact state」失败（1/454）；
2. 删除 `decideConceptArtifact` 的 `expectedRunVersion` fence →
   「旧 expectedRunVersion / 旧 revision 使用稳定错误且不留决定」失败（1/454）；
3. 删除 tool 遥测的 `error_code` 字段 →
   「失败调用仍写脱敏遥测（provider / model / usage / error_code）」失败（1/454）；
   三处改动均已还原，workflow 恢复全绿。


A2-F-C 的两处灵敏度验证：

1. 去掉同一候选的 in-flight 判定（改用 state）→ 「双击与同时点两个按钮只发一个请求」
   用例失败；
2. 去掉"候选必须属于当前最新正式版本"的门禁 → 「旧版本候选没有决定按钮」用例失败。

A2-F-C 附带把 A2-E E2E 的「事实区没有任何接受 / 拒绝 / 写回入口」用例改为
「事实区没有采纳 / 写回 / 批量入口」：接受 / 拒绝从 A2-F-C 起是**合法入口**，
必须保留的边界是"不写回、不批量"。

最近新增质量门禁：

- attempt fencing；
- 事实提交阶段二次校验；
- candidate/run 复合外键；
- deploy `caniuse-lite` 精确版本守卫；
- 默认 Mock 事实提取；
- 单 SQL 列表快照；
- Reviewer 输入字段封锁与 evidence 子串校验；
- 审阅任务的**任务行锁 + `locked_by` fence**（旧 Worker 晚返回写不进 issue）；
- review run 的结论自洽 CHECK 与 append-only 触发器；issue 只能在 running run 追加；
- review 任务终态时由触发器关闭 running run（取消不留下永久 running）；
- 元数据摘要（实体摘要加载）在事实提取与 Reviewer 之间共用同一套 secret 过滤；
- 审阅结果只读接口按 `work + chapter + taskType + requestId + 快照 candidateId` 五重定位，
  run / issues 用 RepeatableRead 同快照读取；只回显白名单错误码与三步名；
- UI 侧以**单调序号**（不是候选 id）作审阅请求身份，旧请求 / 旧轮询一律静默；
  evidence 与 suggestion 全程纯文本渲染，high severity 不改变采纳可用性；
- 事实面板的过滤键是**单调序号**（不是 filter 值），截断必须显式提示，
  提取入口同时受"定稿 + 最新版本 + 空闲"三重门禁；
- 事实决策 `UNIQUE(candidate_id)` + 复合候选外键 + append-only：同决定幂等、
  不同决定 409、过期候选 409，数据库最多一行、审计最多一条；
- 事实列表用单条 SQL LEFT JOIN 带出决策（不放大行数、不做 N+1），
  测试用计数代理守卫「1 次 `$queryRaw`、0 次决定代理访问」；
- 摘要只读接口按 `source_version_id + chapter_id + work_id` 三条件定位，
  历史版本读自己的摘要；HTTP 层只回显 8 个字段，无正文 / 任务 / provider；
- 摘要卡片以**单调序号 + abort** 隔离旧请求，摘要正文走 React 文本节点（pre-wrap），
  读取失败不影响编辑器草稿与任何版本操作。

---

## 7. 活跃风险

1. 上下文文档过长，历史聊天不能作为当前事实来源；
2. `docs/06-open-questions.md` 含有已完成或已冻结的问题；
3. `docs/04` 与 `docs/08` 体量大，只应按任务局部读取；
4. Reviewer / Summarizer 的产品门禁尚未确认；
5. 事实候选质量尚未经过真实章节批量审阅；
6. 本地 PostgreSQL 可能被后台进程回收，测试前必须确认连接；
7. Prisma/应用时间写库与数据库时钟在部分环境可能有偏移，关键租约和时间戳优先使用数据库时钟；
8. Reviewer 结论已在候选面板展示（A2-C-E），但 UI 只反映**最近一次** run：问题 append-only、
   run 复用同一行，重新审阅会覆盖作者的看到的历史结论；没有"审阅历史"视图；
9. 只读接口用确定性 `review:<candidateId>` 定位任务：A2-C-B 之前的历史候选没有审阅任务，
   统一 404 `REVIEW_NOT_FOUND`，前端必须把这种情况展示成"未审阅"而不是错误；
10. 每次正文生成都会多出一个 `chapter.review` 任务，Worker 吞吐与真实模型成本相应增加；
11. `summarizer.chapter@1.0.0` 只有契约，摘要既不落库也无人消费；真实摘要质量与
    长度分布尚未经过样本验证；
12. 摘要已有只读 API（A2-D-D）与展示 UI（A2-D-E），但只在**选中版本时**按需读取：
    仍没有"哪些版本已有摘要"的列表，作者需要逐个版本点开才知道；
13. 定稿后再人工 revision 会让已排队的旧摘要任务以
    `SUMMARY_CHAPTER_NOT_FINALIZED` / `SOURCE_VERSION_STALE` 失败（预期行为，
    但会在任务列表里留下失败记录，后续需要只读 UI 时要注意展示口径）；
14. 真实模型下每次定稿都会额外产生一次摘要调用，成本与延迟尚未评估；
15. 模型配置不可用期间定稿的章节**不会自动补摘要任务**：必须由作者再次幂等定稿，
    当前没有手动重建入口，也没有提示；配置长期不可用会让摘要长期缺失；
16. `priorSummaries` 只覆盖「已定稿且有摘要」的前 20 章：未定稿章节、摘要失败或
    配置长期不可用期间定稿的章节会静默缺失，Reviewer 无法感知"这里本该有摘要"；
17. 审阅问题的 `evidence` 是正文原句，会随只读接口与页面原样展示给作者；当前只对作品作者
    可见（管理员 403），若将来开放给编辑 / 读者角色，需要重新评估这一字段的暴露边界；
18. 候选预览期间会按 1s → 2s → 5s 轮询审阅结果：单作者单页面可接受，但多候选反复预览
    会产生额外只读请求；页面隐藏后不会继续安排轮询，但隐藏瞬间已排定的一个请求仍可能完成；
19. 审阅面板只覆盖"当前选中的候选"：候选列表本身不显示审阅徽标，作者仍需逐个预览才能
    看到有没有问题；
20. 摘要接口只有 404 一种"没有"语义：UI 只能给"可能仍在生成、生成失败，或定稿时模型未配置"
    的统一说明，无法告诉作者到底属于哪种，也没有轮询；
21. 历史版本摘要可读，但**没有列表接口**：作者必须知道版本 id 才能查询，
    做 UI 时需要按版本逐个请求（当前没有批量能力）；
22. 事实列表是**章节级**而非版本级：多次提取（不同版本）的候选会混在同一列表里，
    只能靠卡片上的「版本 vN」区分；旧版本候选不会被隐藏，也没有"仅看当前版本"的筛选；
23. 事实候选没有"已读 / 已处理"标记：
    作者看完只能自己记住，重复提取也不会告知"这条是新出现的"；
24. 提取是**同步 HTTP**：真实模型下按钮会一直显示「提取中…」直到整个提取完成，
    期间没有进度、不能取消；超时或网络中断后需重新点击（已有 run 会幂等复用）；
25. 事实面板不读 run 状态：只显示候选列表，看不到"上次提取失败 / 被取消"，
    失败只体现在一次性的提取错误提示上（刷新后消失）；
26. 决策 UI 从 A2-F-C 起可用，但**没有决策历史视图**：页面只显示当前列表里
    候选的决定徽标；被过滤掉的候选的决定看不到，也没有"这条是谁决定的"入口；
27. 决策是**终态且不可撤销**：选错只能等新版本的新候选，没有改判 / 撤销入口；
    这张卡有意如此（append-only），但真实使用中误点代价不低；
28. 决策与**写回**之间没有约束：A2-F-A 只记录"可作为写回输入"，
    真正写回实体 / 物品事件时仍需一方校验"决定仍有效"，否则可能出现
    "候选已过期但决定被当作最新"的错觉；
29. 决策不区分"谁看过"：可以决定一条从未在 UI 展示过的候选（当前也没有 UI），
    审计只记录决定本身，不记录来源（手动 / 批量 / 未来自动）；
30. 列表 / 详情回显的 `decision` 是**读取时快照**：页面拿到后不会自动刷新，
    同一候选在别处被决定后，当前页面要重新读取才能看到（决策 UI 需要自带刷新策略）；
31. 回显只有 `value` 与 `decidedAt`，没有 `decidedBy`：多人协作或未来引入编辑角色时，
    无法从页面回答"这是谁决定的"（审计日志里有，但不对外开放）；
32. 决定与候选一对一、候选按**章节**聚合：旧版本候选的 `decision` 仍会显示（历史记录），
    但按 A2-F-A 已不能再对它做新决定——UI 必须自己区分"可决策"与"仅历史"；
33. 决策 UI 的决定结果**只更新当前列表里那一条候选**：如果期间切了筛选，
    迟到的响应会被完全丢弃（列表版本身份），页面需要重新读取才能看到决定；
    这是"旧响应不覆盖新列表"的取舍，与 A2-E 的筛选行为一致。
34. 现有入口仍是“先建作品、再逐章生成”，世界观和人物通过设定中心手工维护；
    缺少作者期望的“核心创意 → 世界观 → 人物 → 全书/分卷/章节大纲 → 开始写作”
    动态创作入口。C1-A 先交付 Runtime 与动态问答壳，C1-B 再接入故事规划 Agent。
35. Coordinator 是唯一路线决策者，调度质量成为新的单点风险：模型可能反复询问、
    过早写作或漏掉关键规划；必须以工具清单、硬门禁、预算、循环熔断和可恢复状态兜底。
36. 完整 Agent 全集会放大模型调用次数、延迟和费用；C1-B/C/D 必须按工具独立预算，
    多稿与质量裁定只能作为可选能力，不能默认串行全开。
37. 故事候选使用带 `schema_version` 的 revision；如果各 artifact type 只共用一个宽松
    JSON Schema，会出现“能存不能验证”的漂移风险。每种候选仍需独立业务语义校验。
38. 动态调度产生更多合法路径，E2E 不能只测一条固定问卷；至少覆盖先世界观、先人物、
    退回修改和确认后再写作等不同路径，并验证已确认产物不会被静默覆盖。
39. Agent 与工作流的职责必须同时验收：只实现一个“模型调用循环”不足以称为工作流系统；
    每个 tool 都要有 guard、允许状态、成功迁移、失败分类、重试上限、幂等提交与回退路径，
    否则 Coordinator 仍可能绕过业务门禁。
40. C1-A 默认使用 Mock Coordinator；真实模型下的提问质量、轮次长度与费用尚未验证，
    C1-B 接入真实规划工具后必须重新校准追问上限与预算。
41. 旧 Worker 的迟到结果由条件 UPDATE + 租约/版本 fence 丢弃，但被中断的 running run
    要等 sweep 周期才会重排；期间该 run 不会被第二个 Worker 领取，表现为短暂停滞。
42. `novel_runs` 的状态迁移白名单目前只覆盖 C1-A 的 `ask_user` / `finish`；
    C1-B 引入 `waiting_approval` 或新工具时必须新增 migration，不允许绕过 CHECK。
43. （已修复，C1-A-REV-01）模型硬超时已与 lease abort 拆成独立 signal，
    `attemptAbort` 不参与 fence；超时不再被误判为 lease-lost，且有有限重试上限。
44. （已修复，C1-A-REV-01 / REV-02）调用日志已与 step/state 提交解耦；
    Schema-invalid / invalid-JSON 失败调用也会保留 Provider 已返回的 usage，
    token 预算覆盖所有实际模型调用；只有 Provider 未返回 usage 时才记 0。
45. `novel_runs.work_id` 当前不可变，而 C1-B 规划需要把 run 绑定到 Work；
    C1-B 开工前必须设计一次性受控绑定，不允许直接放开任意更新。
46. Concept 候选目前只有服务层：approved 候选还不能被后续 Agent 读取为正式输入；
    C1-B-A2 接入时必须只读已批准 revision，禁止把 draft / rejected 当成设定。
47. `novel_runs` 白名单已开放 `waiting_approval`，但 Runtime 尚未产生该状态；
    C1-B-A2 若忘接，run 会停在 `waiting_approval` 或绕过作者确认，必须补运行时与 E2E。
48. artifact 的 `work_id` 固定为 NULL，尚无 Work 绑定方案；绑定前候选不能视为作品级设定。
49. Concept 的“不安全文本”校验是启发式正则，真实模型可能用同义表达绕过；
    它只用于档住明显越权输出，不能替代 Runtime 的工具白名单与作者确认。

---

## 8. 决策日志

只追加；如需推翻，必须写明替代决策和原因。

```text
D-001 工作流控制步骤，Agent 只作为语义节点。
D-002 Agent 只产出候选，作者负责正文采纳与定稿。
D-003 A1 使用 Planner + Writer，不让 Agent 自由编排。
D-004 FactExtractor 已在 A2-A/A2-B 提前完成后端，不回退。
D-005 A2-C 优先 Reviewer，事实审阅 UI 后移。
D-006 Reviewer 初期默认只提示问题，不直接替代作者决定。
D-007 正式版本与事实候选均 append-only；旧版本不覆盖。
D-008 事实候选不自动写回实体，写回必须另立阶段并由作者确认。
D-009 RAG、向量库、Neo4j 仅在个人版实际需要时评估。
D-010 deploy --legacy 产物必须独立做版本与许可证扫描。
D-011 Reviewer 是独立任务：候选保存成功后同事务入队，失败不回滚候选、不改变采纳权。
D-012 Reviewer 结论只落 run / issues，不写 audit_logs；成功是终态，问题 append-only。
D-013 A2-D 之前 `priorSummaries` 固定为空，不得用候选正文或正式正文冒充前章摘要。
D-014 Summarizer 只处理正式定稿版本；本卡只交付契约，落库 / 幂等 / 租约属于 A2-D-B。
D-015 摘要是派生数据：按 sourceVersionId 幂等、append-only、不写审计、不改章节与版本。
D-016 摘要调度是 best-effort：模型配置不可用时只跳过摘要任务，绝不阻断定稿；
      配置恢复需作者再次幂等定稿才补任务。
D-017 确定性内部任务按逻辑输入判等，不按 input_hash：配置漂移必须复用既有 task，
      可执行性交给 Worker 预检，不允许 finalize 静默改写任务元数据。
D-018 前章摘要只取「同作品 + 前序 + 已定稿 + 对应当前最新正式版本」的最近 20 章；
      缺失即空，不猜测、不用正文补、不跨作品补全。
D-019 Reviewer 结果是只读资源：接口不触发审阅、不写审计、不改 task / run / issue；
      任务定位必须同时满足 work + chapter + taskType + requestId + 快照 candidateId，
      任一不符统一 404 `REVIEW_NOT_FOUND`（不泄露存在性）。
D-020 只读 GET 不做 Origin 校验（同源 fetch 不带 Origin，写接口仍强制）；
      审阅结果的 run / issues 在 RepeatableRead 同快照内读取，不返回 provider / model。
D-021 Reviewer 结果只做展示：面板不改正文、不写存储、不参与采纳判定；
      high / medium / low 都不禁用采纳，只有读取失败才提供"重新读取"（同一候选的重试）。
D-022 审阅请求身份用单调序号而非候选 id（同一候选重新读取 / 切换后再切回 id 相同）；
      旧请求与旧轮询必须完全静默，不得覆盖新候选的 review / error / loading。
D-023 摘要按 sourceVersionId 定位，不按"当前最新版本"：历史版本必须读到自己的摘要；
      查询必须同时带 chapter_id + work_id，缺失任一条件都可能跨章节 / 跨作品泄漏。
D-024 摘要只读接口只回显 8 个字段（id / chapterId / sourceVersionId / versionNo /
      summary / agentName / agentVersion / createdAt），不返回任务、provider / model、正文。
D-025 摘要卡片按版本读取、只读展示：不轮询、不重试、不回写正文；
      404 一律信息态（三种成因无法区分），读取失败只给局部「重新读取」，不影响编辑器草稿。
D-026 摘要请求以单调序号 + abort 双保险隔离旧请求：序号保证"只有最新请求可落地"，
      abort 只是提前释放连接，不能替代序号判断。
D-027 事实提取入口必须同时满足「章节 finalized + 选中当前最新正式版本 + 空闲」；
      历史版本、未定稿章节都不给入口，只在面板内说明原因，不做隐式回退。
D-028 事实列表的请求身份用单调序号（不用 filter 值）：同一 filter 可能因来回切换
      重复出现，只有序号能识别当前请求；旧响应不写列表 / 错误 / loading。
D-029 事实面板只做只读审阅：不提供接受 / 拒绝 / 批量 / 写回；
      截断必须显式提示完整 total，空态必须区分"没有候选"与"筛选为空"。
D-030 事实决策是**记录**而非写回：accepted 只表示"可作为后续写回输入"，
      A2-F-A 不修改实体 / 属性 / 关系 / 境界 / 物品事件，也不改章节或版本。
D-031 决策 append-only 且不提供改判：同决定幂等（200 deduplicated）、
      不同决定 409；撤销 / 改判若要做，必须新开表或新开阶段，不复用这一行。
D-032 决策只允许「成功 run + 当前定稿 + 该版本仍是最新」的候选，
      过期候选一律 409 STALE，即使此前已有决定也不再接受新的决定请求。
D-033 决策状态通过**单条 SQL LEFT JOIN** 带出，不新增按候选的二次查询：
      列表必须保持一次 `$queryRaw`，`total` 与集合仍在同一快照。
D-034 回显只给 `value + decidedAt`：`decidedBy` 不外露，异常 `value`
      只按"未决定"处理，绝不把数据库里的脏枚举带到界面。
D-035 凭据处理不进入仓库工具：本地 E2E 的共享口令轮换由既有测试流程
      （`admin-flow` / `item-events-flow` + `.e2e-author.json`）处理，
      不新增读取口令文件、改写账号口令的脚本；单文件重跑以干净库为前提。
D-036 用户明确选择单 Coordinator Agent：Coordinator 是唯一决定小说创作下一步的语义调度中心；
      WorkflowKernel 降级为持久化、租约、重试、幂等、工具执行和作者确认门禁。
      旧固定 N1 八步向导方案废弃；动态动作仍受 Runtime 白名单、预算和作者确认约束。
D-037 完整 Agent 全集是能力地图，不是“所有能力都必须独立成 LLM Agent”：
      Composer、Librarian、故事状态投影以确定性服务为主；多稿、质量裁定和高级文风
      属于可选能力。任何专用 Agent 都只作为 Coordinator 的受控工具，不决定下一步。
D-038 C1 采用纵向切片交付：C1-A 起每个阶段同时交付最小 UI、服务、Schema、测试与 E2E，
      不再先堆若干后端表再集中做界面；默认产品路径可展示，但 Runtime 不写死该顺序。
D-039 Agent 与工作流是同一系统的角色层/控制层，不是两张平行清单：
      Coordinator 只负责动态语义路由；每个 tool 内部使用固定 guard → execute → validate
      → commit 工作流；状态迁移、质量门禁、回退、重试、取消、幂等和事务提交由代码决定。
D-040 C1-A 只注册 ask_user / finish，且不产生 waiting_approval；
      Coordinator 输出必须同时通过 JSON Schema 与业务语义校验（ask 必须有 1–6 个不重复选项，
      finish 必须给原因）；Runtime 拒绝未注册工具、非法状态和超预算动作；
      step / call append-only，旧 Worker 的迟到结果整事务丢弃。
D-041 模型调用超时与 lease 丢失必须使用不同信号：超时是有限 attempt 内的可重试失败，
      lease fence 失败才是丢弃提交；任何 Provider 调用都必须有硬超时兜底。
      本条替代 D-040 中“超时/旧 Worker 结果整事务丢弃”的笼统表述。
D-042 `novel_agent_calls` 是实际调用遥测，不是业务状态提交：调用发生后立即脱敏追加；
      旧 Worker 可写其真实 call 遥测，但不得写 step / state / 问题或创作资料。
      本条替代 D-040 中“旧 Worker 一律不能写 call”的表述。
D-043 `ask_user.options` 恢复为 0..6：空数组表示开放式问题，页面始终保留纯文本回答；
      有选项时仍必须非空、去重且最多 6 个。本条替代 D-040 中 1–6 的下限。
D-044 已发生的模型调用必须保留 Provider 返回的 usage；Schema-invalid /
      invalid-JSON 也不得丢 token。租约有效性只由 PostgreSQL `clock_timestamp()` 判断，
      fence 与所有终态条件 UPDATE 都必须再次校验租约。
D-045 故事候选域按 artifact → revision → decision 三段 append-only：
      artifact 只保存当前指针与状态，revision 不可改不可删，decision 只追加；
      approved 为终态且禁止新 revision；revision / decision 必须通过复合外键
      钉在同一 run + author，`current_revision` 与最大 revision 编号用延迟约束触发器
      在提交时校验；候选生成与决策同时受 run `state_version` 和 artifact
      `current_revision` 双 fence 保护。
```

---

## 9. 维护规则

每个阶段完成或冻结一项产品决策后更新本文：

1. 更新“最后已验收产品基线”；
2. 更新完成能力和当前下一步；
3. 只把真正冻结的决策写入决策日志；
4. 更新测试、迁移、表、触发器数量；
5. 不复制详细 API、Schema 或验收表；链接到详细文档；
6. 不把临时失败、聊天猜测或未提交实验写成既定事实。

复审者发现代码、CI 与本文不一致时，以代码和 CI 为准，并先修正本文。
