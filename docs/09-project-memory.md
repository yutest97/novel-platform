# 09 项目记忆（当前事实快照）

- 更新日期：2026-11-06
- 最后已验收产品基线：`1482573`（A2-C-A）
- 对应 CI：A2-C-A，CI #24 绿色
- 当前产品阶段：A1 已完成；A2-A / A2-B / A2-C-A 已验收；
  **A2-C-B（含 REV-01）、A2-D-A、A2-D-B（含 REV-01）、A2-D-C、A2-C-D、A2-C-E 均本地完成，待复审**

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
- 列表使用单条 SQL 保证 `total` 与集合同快照。

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

### A2-C-B Reviewer 候选审阅执行与持久化（本地完成，待复审）

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

### A2-D-A Summarizer Agent 契约（本地完成，待复审）

- `summarizer.chapter@1.0.0`：输入只有章节标识、正式版本追溯标识与正文（1..200000 字符）；
- 标题 trim 后必须非空（Schema 兜不住纯空白，`assertSummarizerInput` 在代码侧拒绝）；
- 输出只有 `summary`（1..1000 字符），拒绝未知字段、空白、Markdown 标题与代码块；
- 错误统一 `AGENT_INPUT_INVALID` / `AGENT_OUTPUT_INVALID`，只带路径与固定原因；
- `createChapterSummarizerMockProvider()` 默认输出确定、非空，可注入固定 summary；
- `runChapterSummarizer()` 纯内存：输入校验 → AgentRunner → 专用语义校验；
- **未接**数据库、`chapter.summarize` 任务、Worker、API / UI，Reviewer 的
  `priorSummaries` 仍未接线。

### A2-D-B 定稿章节摘要任务与持久化（本地完成，待复审）

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

### A2-D-B-REV-01 定稿不被摘要配置阻断（本地完成，待复审）

- finalize 路由对 summary spec 做 best-effort 解析：`MODEL_NOT_CONFIGURED` →
  `summary = null`，**定稿照常成功**，只跳过摘要任务；
- 不伪造 provider / model 占位值，不构造模型请求，不联网，错误不进响应 / 日志 / 审计；
- 配置恢复后，同版本**再次幂等 finalize** 才补齐任务（无手动重建接口）；
- 确定性内部任务按 requestId + taskType + chapterId + inputSnapshot 判同一逻辑任务，
  **不再比较 input_hash**：配置漂移时复用既有 task 且不覆盖其 provider / model；
  旧 task 是否可执行仍由 Worker 预检决定（`TASK_MODEL_CONFIG_MISMATCH`）。

### A2-D-C Reviewer 前章摘要接线（本地完成，待复审）

- `buildChapterReviewContext` 新增 `loadPriorSummaries()`：一条 SQL 选出
  「同作品 + `chapter_no <` 当前章 + 前章 `finalized` + 摘要对应该章当前最新正式版本」
  的摘要，按 `chapter_no DESC` 取 20 条再反转为升序；
- 当前章 / 未来章 / 跨作品 / 已 revision 的旧摘要都不会进入；
  重新定稿后使用新版本摘要；同一章节只一条；
- 无摘要时为 `[]`（不猜测、不用正文补）；
- `task_contexts` 新增 `chapter_summary` 来源：只记 summary id 与 `第N章摘要`，
  不复制摘要正文；
- 无 migration、无 API / UI。

---

## 2. 当前冻结决策

### 控制层与 Agent

```text
Agent 产出候选
工作流负责校验、门禁、落库和推进
作者负责最终采纳
```

- Agent 不直接写数据库；
- Agent 不决定下一步；
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
| A2-C | Reviewer Agent | A2-C-A 已验收；A2-C-B（含 REV-01）本地完成待复审；**A2-C-D 只读 API + A2-C-E 结果展示 UI 均本地完成** |
| A2-D | Summarizer Agent | A2-D-A / A2-D-B（含 REV-01）本地完成；**A2-D-C `priorSummaries` 接线本地完成待复审** |
| A2-E | 事实候选只读审阅 UI | 待开始；Reviewer 问题展示也未做 |
| A3 | Consistency Agent、检索/图谱 | 待评估 |

说明：

- FactExtractor 比最初 Agent 时间表提前完成，不回退；
- 事实 UI 优先级低于 Reviewer / Summarizer；
- Reviewer 初期建议以结构化警告为主，不直接阻止作者采纳；
- Summarizer 只处理正式定稿版本；
- RAG、embedding、关系图和 Neo4j 不是当前前置。

---

## 4. 当前下一步

A2-C-B（含 REV-01）、A2-D-A、A2-D-B（含 REV-01）、A2-D-C、A2-C-D、A2-C-E
均已在本地完成，等待负责人复审：

- `docs/tasks/A2-C-B-REV-01-review-integrity.md`（已完成修复的追溯记录，不再派发）
- `docs/tasks/A2-D-A-summarizer-agent.md`（契约层）
- `docs/tasks/A2-D-B-summarizer-workflow.md`（工作流与落库）
- `docs/tasks/A2-D-B-REV-01-finalize-resilience.md`（定稿不被摘要配置阻断）
- `docs/tasks/A2-D-C-prior-summaries.md`（Reviewer 前章摘要接线）
- `docs/tasks/A2-C-D-review-results-api.md`（Reviewer 结果只读 API）
- `docs/tasks/A2-C-E-review-ui.md`（Reviewer 结果展示 UI）

A2-D-B-REV-01、A2-D-C、A2-C-D、A2-C-E 的本地实现已通过代码复审；当前等待整体复审 / CI。

复审通过前不推送。复审通过后的候选顺序：

1. 摘要读取 API（卡已备：`docs/tasks/A2-D-D-summary-read-api.md`；
   摘要已落库、Reviewer 已在用，但作者看不到）；摘要 UI 随后单独开卡；
2. A2-E 事实候选只读审阅 UI；
3. 是否给 high severity 加采纳门禁——仍需产品确认；
4. 是否允许作者手动重新检查（当前每次生成只审一次，UI 只提供"重新读取"）。

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

截至最后已验收基线 `1482573`：

| 项目 | 数量 |
| --- | --- |
| 全量单测 | 886 |
| 浏览器 E2E | 118 |
| migrations | 11 |
| 数据表 | 20 |
| 数据库触发器 | 10 |
| deploy 版本守卫行为测试 | 22 |

A2-C-A 新增 18 个 workflow 纯单测，workflow 包当时 **262** 个测试。
migrations / 数据表 / 触发器保持 **11 / 20 / 10**。

A2-C-B（本地，未推送）后的当前数字：

| 项目 | 数量 |
| --- | --- |
| 全量单测 | **1011**（web 358 / workflow 338 / works 132 / auth 95 / worker 63 / shared 15 / db 10） |
| 浏览器 E2E | **127** |
| migrations | **13** |
| 数据表 | **23** |
| 数据库触发器 | **15** |

新增 24 个 workflow 集成测试（`chapter-review-workflow.test.ts`）；
另有 1 个既有用例拆成两个参数化用例（正文状态 drafting / in_review）；
A2-D-A 再新增 17 个纯单测（`chapter-summarizer-agent.test.ts`）；
A2-D-B 新增 20 个 workflow 集成测试（`chapter-summary-workflow.test.ts`）
与 1 个定稿 API 用例；A2-D-B-REV-01 再补 5 个定稿 API 用例与 2 个 workflow 用例；
A2-D-C 新增 12 个 workflow 用例（前章摘要选择规则）；
A2-C-D 新增 17 个只读 API 用例（`chapter-review-api.test.ts`）与 9 个
响应解析用例（`chapter-review-view.test.ts`）；A2-C-E 再新增 17 个面板纯函数用例
（`chapter-review-panel.test.ts`）与 9 个浏览器 E2E（`chapter-review-ui.spec.ts`），
因此 web **358**、全量 **1011**、E2E **127**。

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
  evidence 与 suggestion 全程纯文本渲染，high severity 不改变采纳可用性。

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
12. 摘要已落库但**没有读取接口 / UI**，作者看不到；Reviewer 侧已在 A2-D-C 接线
    （覆盖范围限制见风险 16）；
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
    看到有没有问题。

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
