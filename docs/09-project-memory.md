# 09 项目记忆（当前事实快照）

- 更新日期：2026-11-05
- 最后已验收产品基线：`0f23683`
- 对应 CI：A2-B-CI-FIX-01，CI #23 绿色
- 当前产品阶段：A1 已完成；A2-A / A2-B 已完成；准备进入 A2-C

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
| A2-C | Reviewer Agent | 下一步 |
| A2-D | Summarizer Agent | 待开始 |
| A2-E | 事实候选只读审阅 UI | 待开始 |
| A3 | Consistency Agent、检索/图谱 | 待评估 |

说明：

- FactExtractor 比最初 Agent 时间表提前完成，不回退；
- 事实 UI 优先级低于 Reviewer / Summarizer；
- Reviewer 初期建议以结构化警告为主，不直接阻止作者采纳；
- Summarizer 只处理正式定稿版本；
- RAG、embedding、关系图和 Neo4j 不是当前前置。

---

## 4. 当前下一步：A2-C Reviewer Agent

目标：Writer 完成后增加受工作流约束的 Reviewer Agent。

当前可执行任务卡：`docs/tasks/A2-C-A-reviewer-agent.md`。

初步边界：

- 输入：冻结合同、正文候选、必要上下文与已有连续性摘要；
- 输出：严格 JSON；
- 问题字段至少包含：`severity`、`type`、`evidence`、`suggestion`；
- Reviewer 不重写正文；
- Reviewer 不直接决定采纳；
- 工作流决定如何保存和展示结构化问题；
- 无 API/UI 的新增需要单独阶段或同一任务内明确边界；
- 不引入 RAG。

尚待产品确认：

- high severity 是否阻止候选展示/采纳，还是只警告；
- Reviewer 是否每次 Writer 后自动运行；
- Reviewer 失败是否影响正文候选保存；
- 是否允许作者手动重新检查。

建议默认：

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

截至最后已验收基线 `0f23683`：

| 项目 | 数量 |
| --- | --- |
| 全量单测 | 868 |
| 浏览器 E2E | 118 |
| migrations | 11 |
| 数据表 | 20 |
| 数据库触发器 | 10 |
| deploy 版本守卫行为测试 | 22 |

最近新增质量门禁：

- attempt fencing；
- 事实提交阶段二次校验；
- candidate/run 复合外键；
- deploy `caniuse-lite` 精确版本守卫；
- 默认 Mock 事实提取；
- 单 SQL 列表快照。

---

## 7. 活跃风险

1. 上下文文档过长，历史聊天不能作为当前事实来源；
2. `docs/06-open-questions.md` 含有已完成或已冻结的问题；
3. `docs/04` 与 `docs/08` 体量大，只应按任务局部读取；
4. Reviewer / Summarizer 的产品门禁尚未确认；
5. 事实候选质量尚未经过真实章节批量审阅；
6. 本地 PostgreSQL 可能被后台进程回收，测试前必须确认连接；
7. Prisma/应用时间写库与数据库时钟在部分环境可能有偏移，关键租约和时间戳优先使用数据库时钟。

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
