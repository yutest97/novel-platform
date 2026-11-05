# 07 总路线（个人可用版优先）

- 版本：v1.5
- 日期：2026-11-05
- 当前基线：`408cb05`（A1-4B-C-C-REV-01 已验收）+ A2-A（本地提交）
- 状态：执行中

---

## 1. 方向调整

项目优先交付**个人可用版**：单作者、单实例、可在一台机器上跑完
"设定 → 大纲 → 正文 → 检查 → 定稿"的最小闭环。

- 多用户账号体系、管理员后台、10 人协作**保留但后置**，不删除、不回退既有实现；
- 账号/会话/审计等既有能力继续维护，但不再作为下一阶段的验收门槛；
- 资源流水（M2-B4）**暂停**，不标记删除；何时恢复由本路线后续阶段决定。

> 这一调整不改变"工作流是控制层、Agent 是语义节点、作者是最终签发者"的产品原则，
> 反而让它更容易落地：先让单个作者稳定跑通，再谈协作与运营。

---

## 2. 执行原则

1. **确定性优先**：工作流的步骤顺序、状态迁移、重试与取消都由代码决定；
   模型只负责语义节点的输入→输出，不决定"下一步做什么"。
2. **作者签发**：任何正文/设定变更都必须经过作者确认；Agent 不直接写库。
3. **可恢复**：任务崩溃后必须能继续或明确失败，绝不留下永久 `processing`。
4. **可计量**：每次模型调用只记录 token / 延迟 / 成功标志与稳定错误码，
   不记录 prompt、正文或 API Key。
5. **不删除既有能力**：暂停的功能保留代码、数据与文档，恢复时不需要重写。
6. **每阶段可验收**：每个阶段都有独立的 migration、测试与门槛，不做"大爆炸"式合入。

---

## 3. 阶段路线

| 阶段 | 目标 | 交付物 | 状态 |
| --- | --- | --- | --- |
| **A1-1** | 工作流内核 + Provider + Agent 基础 + PostgreSQL Worker | `packages/workflow`、四张表、Mock/OpenAI 兼容 Provider、租约队列、测试与文档 | 已完成（本地提交） |
| **A1-2** | 单章候选流水线（Planner → Writer） | `planner.chapter` / `writer.chapter` 两个 Agent、`chapter.draft` 任务类型、`chapter_contracts` / `chapter_candidates`、确定性上下文、检查点与 LLM 日志；**无 HTTP API / UI** | 已完成（本地提交） + REV-01 |
| **A1-3A** | 候选采纳 + 正式版本（数据库与服务层） | `chapter_versions`、候选 `candidate → adopted` 受控迁移、`adoptChapterCandidate`（作品锁 + 行锁 + 同事务审计）、幂等与并发；**无 HTTP API / UI** | 已完成（本地提交） |
| **A1-3B** | 章节 / 生成任务 / 候选 / 采纳 HTTP API（单作者） | 7 个路由、严格白名单、会话与 Origin 校验、requestId 幂等、任务取消、候选读取与采纳；前端只加客户端函数，**无 UI** | 已完成（本地提交）+ REV-01/02 |
| **A1-3C** | Worker 常驻运行与后端端到端闭环 | `apps/worker` 常驻轮询、`chapter.draft` 注册、Provider 单次构造、provider/model 预检（`TASK_MODEL_CONFIG_MISMATCH`）、循环状态机与健康检查、优雅关闭、后端 e2e；**无章节 UI** | 已完成（本地提交）+ REV-01 |
| **A1-4A** | 章节工作台（生成 / 轮询 / 候选采纳 / 正式阅读） | 章节列表与创建、章节工作台、Mock/真实 Worker 生成、1s→5s 轮询、取消、候选预览、采纳、正式版本阅读、3 个只读 API、E2E；**无人工编辑**；REV-01 修取消后重新生成、目标字数默认值与终态步骤文案；REV-02 修生成提示与任务状态一致性 | 已完成 + REV-01/02（本地提交） |
| **A1-4B-A** | 人工章节版本保存（服务 + API） | `POST /chapters/:chapterId/versions`、`saveHumanChapterVersion`（`baseVersionId` 乐观并发 + 章节行锁）、`source='human'` 追加版本、`finalized → in_review`、`CHAPTER_CONTENT_INVALID` / `CHAPTER_STATE_INVALID_FOR_SAVE`、审计 `chapter.version_created`；**无 UI** | **本轮完成** |
| **A1-4B-B** | Markdown 人工编辑器与 human 版本保存 UI | 正式版本区编辑入口（首版 / 最新版本）、textarea 纯文本编辑、实时字数下限提示、dirty 状态、`Ctrl/Cmd+S` 保存、取消二次确认与 `beforeunload`、冲突后「载入最新版本」、旧版本只读、移动端可用；**无 diff / 恢复** | 已完成 + REV-01/02（本地提交） |
| **A1-4B-C-A** | 章节版本 diff（服务 + 只读 API） | `GET /chapters/:chapterId/versions/diff?fromVersionId=&toVersionId=`、`diffChapterVersions`（归属校验 + 行级 LCS diff）、`equal/added/removed` + 双侧行号 + `stats`、换行归一化、`CHAPTER_DIFF_TOO_LARGE`（20 万字符 / 行数 / 编辑距离上限，超编辑距离退化为整段替换）、只读不写审计；**无 UI、无恢复、无迁移** | 已完成（本地提交） |
| **A1-4B-C-B** | 版本对比 UI 与历史版本恢复 | 正式版本区按需展开的对比面板（双选择器、双列行号、added/removed 中文标签、空 diff / 超大 / 冲突提示、移动端不撑破）、`GET /versions/diff` 前端严格解析、`POST /versions/:versionId/restore`、新错误码 `CHAPTER_VERSION_ALREADY_LATEST`、审计 `chapter.version_restored`；**不含定稿流程** | **本轮完成** |
| **A1-4B-C-C** | 章节定稿流程 | `POST /chapters/:chapterId/finalize`、`finalizeChapter`（作品锁 + 章节行锁、只锁当前最新版本、同版本幂等）、`in_review → finalized`、`CHAPTER_STATE_INVALID_FOR_FINALIZE`、审计 `chapter.finalized`；定稿后生成 / 采纳 / 恢复关闭，人工保存 revision 回到 `in_review`；**无撤销定稿、无 migration** | **本轮完成** |
| **A2-A** | 连续性事实提取契约与候选存储 | `continuity.extractor@1.0.0`（六类事实、严格 Schema + 语义校验）、`extractChapterFacts`（定稿 + 最新版本前置、同版本幂等、失败可重试、审计 `continuity.facts_extracted`）、`chapter_fact_runs` / `chapter_fact_candidates`（复合外键 + 受控更新 + append-only）；**提交阶段二次校验**（模型调用期间的新 revision 一律拒绝）、候选 run 外键为**复合外键**、running **租约**（10 分钟，CAS 接管）、重试记录本次实际 provider / model、上下文**按类型**截断；**无 API / UI / Worker 注册 / RAG** | **本轮完成** |
| **A2-B** | 事实候选审阅与状态写回 | 候选列表 / 采纳 UI、人物/物品/势力状态写回、冲突提示；`A2-A` 的候选是唯一数据来源 | 待开始 |
| **A3** | 检索与图谱（可选） | 设定检索、RAG、关系图；按个人版实际痛点决定是否引入 | 待评估 |
| **M2-B4** | 资源余额流水 | 表、API、UI、E2E | **暂停**（不删除） |
| **多人/运营** | 多作者、管理员运营、配额 | 既有账号体系扩展 | **后置** |

---

## 4. A1-1 的边界

**做了**：

- `chapters / generation_tasks / task_contexts / llm_call_logs` 四张表与约束；
- 任务状态机、`FOR UPDATE SKIP LOCKED` 领取、租约/心跳/回收/重试/取消/幂等；
- `ModelProvider` 统一接口、`MockProvider`、`OpenAICompatibleProvider`；
- `AgentDefinition` 与严格输入/输出 Schema 校验、确定性测试 Agent；
- 工作流 Kernel（固定步骤、检查点、错误分类、取消检查）；
- 服务层作者边界（作者 id 只来自会话；管理员无普通任务入口）。

**没做（明确不在本轮）**：

- Planner / Writer 业务 Agent 与任何正文生成；
- `chapter_contracts / chapter_candidates / chapter_versions`；
- 生成 API 与章节 UI；
- Reviewer / Continuity / Fact Agent；
- RAG、向量库、Neo4j；
- 资源流水（M2-B4，暂停）；
- 任何多人账号功能；
- `apps/worker` 常驻循环（A1-3C 才启用；A1-1/A1-3B 只创建任务，由测试内的 `WorkerRunner` 执行）。

> A1-3C 已把 `apps/worker` 接入常驻循环；本节保留 A1-1 当时的历史边界。

---

## 5. 阶段门槛（通用）

每个阶段合入前必须满足：

- `format:check` / `lint` / `typecheck` / `build:apps` 全通过；
- 新 migration 在**全新空库**成功，既有迁移不修改；
- 既有测试数量不减少，新增能力有独立测试；
- E2E 全通过（涉及 UI 的阶段）；
- 干净克隆可构建、可跑测试；
- `git diff --check` 无输出，工作区干净，本地提交、不推送。

---

## 6. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-04 | 建立本路线；个人可用版优先；M2-B4 暂停；A1-1 启动 |
| 2026-11-04 | A1-1-REV-01 复审通过；A1-2 单章候选流水线完成（无 HTTP API/UI，采纳与版本留给 A1-3） |
| 2026-11-04 | A1-2-REV-01 复审通过；A1-3A 候选采纳与正式版本完成（数据库 + 服务层，无 API/UI） |
| 2026-11-04 | A1-3A 复审通过；A1-3B 章节 / 生成任务 / 候选 / 采纳 HTTP API 完成（无 UI） |
| 2026-11-04 | A1-3B-REV-02 复审通过；A1-3C Worker 常驻循环、provider/model 预检与后端端到端闭环完成（无 UI） |
| 2026-11-04 | A1-3C-REV-01：循环状态机与健康检查（starting/ready/retrying/stopping/failed）、瞬态/永久错误分类、空库仅 P2021 重试、P2022/未知错误退出 1 |
| 2026-11-04 | A1-3C-REV-01 复审通过；A1-4A 章节工作台完成（生成 / 轮询 / 候选采纳 / 正式阅读），A1-4 拆分为 A1-4A / A1-4B |
| 2026-11-04 | A1-4A-REV-01：取消成功后作废 requestId（即使仍是 processing）、目标字数默认值收敛到 2500..4000、终态步骤改「最后步骤：…」 |
| 2026-11-04 | A1-4A-REV-02：顶部提示改为按任务状态推导（等待 / 完成 / 已取消 / 已请求取消；失败不出绿条），采纳提示覆盖生成提示 |
| 2026-11-04 | A1-4A-CI-FIX-01/02：Docker 启动顺序（先 postgres → 宿主串迁移 → 起四服务）落到 CI 与 `verify-local.sh`，并加无 Docker 的顺序守卫 |
| 2026-11-04 | A1-4A-CI-FIX-02B：Playwright 步骤显式注入宿主机 `DATABASE_URL`（127.0.0.1 + 本次 run 的 E2E 库），守卫新增 4 组夹具 |
| 2026-11-05 | A1-4B-A：人工章节版本保存（服务 + API），baseVersionId 乐观并发、finalized 回 in_review、审计 chapter.version_created |
| 2026-11-05 | A1-4B-B：章节工作台 Markdown 人工编辑器（`Ctrl+S`、dirty 取消确认、冲突重新载入、首版手写），A1-4B-C 承接 diff / 恢复 |
| 2026-11-05 | A1-4B-B-REV-01：应用内离开保护（返回 / 后退 / 退出登录先确认，保留 `beforeunload`）与冲突「载入最新版本」二次确认 |
| 2026-11-05 | A1-4B-B-REV-02：后退哨兵生命周期（dirty 归零即释放、确认离开先消费哨兵再导航），补齐撤销 / 冲突重载 / 退出登录 / 后退确认的 E2E |
| 2026-11-05 | A1-4B-C 拆分为 C-A（diff 服务 + 只读 API，本轮完成）与 C-B（diff UI / 历史恢复 / 定稿） |
| 2026-11-05 | A1-4B-C-B：版本对比 UI（按需展开、双选择器、行级标签、移动端）与历史版本恢复（`CHAPTER_VERSION_ALREADY_LATEST`、审计 `chapter.version_restored`）；定稿流程独立为 C-C，仍未实现 |
| 2026-11-05 | A1-4B-C-B-REV-01：diff 请求身份改为单调序号（选择器组合无法区分相同组合的旧请求），收起 / 切换 / 展开均使在途请求失效，旧请求不得写结果 / 错误 / loading |
| 2026-11-05 | A1-4B-C-C：章节定稿（只锁当前最新版本、同版本幂等、审计 chapter.finalized）；定稿后生成 / 采纳 / 恢复关闭，人工保存 revision 回到待定稿；不新增 final_version_id / migration |
| 2026-11-05 | A1-4B-C-C-REV-01：定稿入口增加编辑器 / 版本读取 / 恢复 / 保存 / 提交中的前置条件（编辑器打开时改提示），requestFinalize 同步防御；不改服务与 API |
| 2026-11-05 | A2-A：连续性事实候选（六类事实契约、`continuity.extractor@1.0.0`、`extractChapterFacts`、`chapter_fact_runs` / `chapter_fact_candidates`）；只产生候选，不写回任何实体 |
| 2026-11-05 | A2-A-REV-01：提交阶段二次校验（版本 / 定稿 / run 归属）、候选与 run 复合外键、running 租约 CAS 接管、重试元数据以本次实际 provider / model 为准、上下文按类型截断；同一未推送迁移内升级，不新增迁移 |
