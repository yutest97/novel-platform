# C1：单 Coordinator Agent 小说创作运行时

- 状态：方案 v2.1，待 C1-A 实施
- 目标基线：A2 CI #25 已验收（`07cb346`）
- 执行方：Trae
- 替代方案：固定 8 步 N1 向导方案

## 1. 产品目标

作者点击“写新小说”后，不应该先面对一套写死的章节表单。系统应先理解作者目标，
通过动态问答逐步建立：

```text
核心创意
→ 世界观
→ 人物与关系
→ 主线/关键转折/结局
→ 全书大纲
→ 分卷大纲
→ 章节大纲
→ 故事圣经确认
→ 开始逐章写作
```

这只是默认创作路径，不是 Runtime 中写死的阶段顺序。Coordinator 可以根据作者回答、
已有产物和冲突决定先补哪一块、回到哪一块、何时请求确认。例如作者要求“先定世界规则”，
Coordinator 可以先调用世界观 Agent；作者发现人物动机不足时，也可以回到人物 Agent，
而不必把前面所有阶段重跑一遍。

产品最终交付的是一套面向作者的创作软件，而不是只展示工作流、任务表和 Agent 日志的
基础设施控制台。

## 2. 不可突破的架构

系统只有一个**语义调度中心**：

```text
Coordinator Agent
  = 唯一决定“下一步调用哪个受控能力”的 Agent
```

其他 Agent 全部是 Coordinator 可调用的语义工具。它们：

- 只接收结构化输入并返回严格 Schema 的结构化候选；
- 不决定下一步；
- 不互相自由对话；
- 不直接访问数据库、文件系统或 shell；
- 不自动采纳、自动定稿或自动写回故事圣经。

确定性 Runtime 仍是控制层：

- 校验动作和工具白名单；
- 校验工具输入与 Agent 输出；
- 执行作者、作品和状态权限检查；
- 管理预算、步骤数、重复动作和失败熔断；
- 执行工具；
- 原子保存 step、候选和状态变更；
- 保存作者确认结果；
- 复用现有租约、重试、取消、幂等与崩溃恢复能力。

现有 `WorkflowKernel`、`WorkerRunner`、PostgreSQL 任务状态和 A1/A2 章节能力继续保留。
章节工作流可以被 Coordinator 调用，但不得反过来决定整本小说的创作路线。

## 3. Agent 与工作流

Agent 和工作流不是两张平行清单，而是同一套系统的两个层面：

```text
Agent  = 谁来做语义工作
工作流 = 按什么顺序、在什么条件下放行、回退、重试和提交
```

Agent 数量与工作流形态彼此独立。C1 不采用单一固定 DAG，也不采用“Coordinator 想做什么
就做什么”的纯自由编排，而是三层组合：

### 3.1 三层工作流

| 层级 | 控制方式 | 职责 |
| --- | --- | --- |
| Coordinator 动态编排层 | 状态驱动 + LLM 语义路由 | 读取当前创作状态，选择一个合法 tool；不直接写库 |
| Tool 领域工作流层 | 固定步骤 / 小型 DAG / 有限状态机 | guard → Agent → validate → commit；每个 tool 自己定义允许的输入、输出和成功迁移 |
| 队列与事务层 | 确定性代码 + PostgreSQL | 租约、心跳、重试、超时、取消、幂等、fencing、原子提交与崩溃恢复 |

因此：

- “下一步做世界观还是人物”属于 Coordinator 的动态编排；
- “生成世界观时必须先加载确认设定、校验输出、写候选、再等待作者确认”属于固定 tool 工作流；
- “旧 Worker 晚返回不能覆盖新状态”属于事务/队列层；
- Agent 只在 tool 的语义节点内工作，不能自行跳过 guard、确认或 commit。

### 3.2 两层路由

```text
第一层：Coordinator 选择 tool
  concept.generate / world.generate / outline.chapter.generate / chapter.draft / …

第二层：ToolWorkflow 固定执行该 tool
  guard → load input → call agent → semantic validation
  → create candidate / commit approved state → checkpoint
```

第一层可以因语义状态改变路线；第二层不能由模型临时改变步骤顺序。这样既允许作者说
“先定世界观”或“退回重做人物”，又不会让一次模型输出绕过 Schema、作者确认或事务边界。

### 3.3 PostgreSQL 是唯一工作流状态源

不使用 `status.md` 或文件式阶段标记。状态分布在各自有约束的表中：

- `novel_runs.status`：run 当前是执行、等待作者、等待确认、完成、失败还是取消；
- `novel_run_steps`：已经提交的决策与工具执行轨迹；
- `novel_artifacts.status` + revisions：候选、待确认、已确认、已拒绝、已替代；
- `chapters` / `generation_tasks` / candidate / review / summary / fact 表：
  继续作为章节生产和记忆的权威状态；
- `confirmed` 数据不可被静默覆盖，修改必须追加 revision。

### 3.4 主状态机

#### Coordinator run

```text
queued
→ deciding
→ tool_running
→ validating
→ committing
   ├─ queued                继续下一动作
   ├─ waiting_user          等待作者回答
   ├─ waiting_approval      等待作者确认候选
   ├─ completed
   ├─ failed
   └─ cancelled
```

`deciding / tool_running / validating / committing` 是执行内阶段，可由 run step / lease
字段表达，不必全部扩成公开 API 状态。任何提交都必须带 run version 与 lease fence。

#### 创作候选

```text
missing
→ candidate
→ pending_approval
   ├─ approved
   ├─ rejected
   └─ superseded
```

- 作者编辑或重新生成产生新 revision；
- 已确认 revision 不变，新 revision 通过后替换 current pointer；
- rejected 可以触发 Coordinator 重新规划，但不能无限自动重试。

#### 正文与修订单章

```text
确认章节大纲
→ draft candidate
→ review
   ├─ passed → 等待作者采纳
   └─ issues → revise → 再次 review（最多 N 轮）
→ 作者采纳
→ 正式 chapter version
→ finalize
→ summary / fact candidates
```

“是否通过”由工作流根据结构化问题、严重级别和门禁规则决定，Reviewer 只提交问题，
不能自宣通过；作者仍是正文和事实的最终签发者。

#### 记忆写回

```text
finalized version
→ summary / fact candidates
→ 作者接受或拒绝
→ 校验事实仍属于当前有效版本
→ Librarian 确定性事务写回
→ 追加实体版本 / 物品事件 / 结构化状态
```

任何候选、失败任务或未确认 revision 都不能污染后续生成使用的权威记忆。

### 3.5 门禁与回退规则

| 交接点 | Agent 负责 | 工作流负责 |
| --- | --- | --- |
| 生成前 | 接收已装配的结构化输入 | 确认依赖产物存在且已确认；控制预算和工具可用性 |
| Agent 输出后 | 返回严格 Schema 的候选 / 问题 | Schema、业务语义、安全字段和内容边界校验 |
| 质量门禁 | Reviewer 返回结构化问题 | 根据严重级别、循环次数和作者策略决定放行 / 修订 / 等待 |
| 正式提交前 | 不接触数据库 | run version、lease、作者权限、当前版本和事务内二次校验 |
| 回退 | 接收定向问题并生成新候选 | 决定回到哪个已注册 tool；记录 revision 和 superseded 关系 |
| 记忆写回 | 提供候选事实 | 校验作者决定、版本有效性、冲突和原子性 |

回退只追加新候选 revision，不原地修改已提交数据。相同工具可重试，但 `review → revise`
有最大轮数；连续重复 action、超预算或同一状态无进展时熔断，交回作者，不进入无限循环。

### 3.6 并行边界

- C1 默认一次只执行一个会改变权威状态的动作，保证可解释与可恢复；
- 后续只有在依赖图明确、彼此只读或只产生独立候选时，才允许有限并行；
- 任何并行分支都必须有显式 join / aggregator，不能并发写同一 run state、同一 artifact
  current pointer 或同一正式故事资料；
- 并行失败仍按各分支工作流回滚候选，不留下半个正式状态。

### 3.7 与现有实现的映射

- `AgentRunner`：执行一个语义节点；
- `WorkflowKernel`：继续承载固定步骤的章节工具（draft / review / summarize）；
- `WorkerRunner`：继续承载现有 generation task 的租约、重试、取消和检查点；
- `NovelCoordinatorRuntime`：新增动态 Coordinator 路由，但每个 tool 仍调用有明确步骤的
  ToolWorkflow；
- `novel_runs` / `novel_run_steps`：保存动态编排状态与已提交审计；
- PostgreSQL 约束和事务：负责最终放行与原子提交。

## 4. 运行模型

每次运行执行**一个动作**，完成并持久化后再决定下一次动作：

```text
加载 run 与精简创作状态
→ Coordinator 决定一个 action
→ Runtime 校验 action / tool / input / budget / author gate
→ 执行一个工具或专用 Agent
→ 语义校验并保存候选
→ 原子提交 step + state_version
→ continue | wait_for_user | wait_for_approval | finish | fail
```

run 状态建议：

```text
queued
running
waiting_user
waiting_approval
completed
failed
cancelled
```

硬边界优先于 Coordinator 的语义选择：

- 未确认的核心创意不能作为正式故事圣经；
- 未确认的全书/分卷/章节大纲不能驱动正文写作；
- 正文候选未经作者采纳不能成为正式版本；
- 事实候选未经作者决定不能写回人物、物品、关系、势力或境界；
- 作者拒绝候选时，Coordinator 可以重新规划或修改候选，但不能无限自动重试。

## 5. Coordinator 动作契约

Coordinator 只输出一个动作，不输出整本小说计划，也不输出 SQL、Prisma、文件路径或 shell。

### 5.1 询问作者

```json
{
  "action": "ask_user",
  "objective": "确定题材和核心冲突",
  "input": {
    "question": "你更想写哪一种故事？",
    "options": ["玄幻升级", "都市异能", "悬疑推理", "自定义"]
  },
  "decisionSummary": "基础信息不足，先向作者确认题材。"
}
```

### 5.2 调用工具

```json
{
  "action": "call_tool",
  "objective": "补齐主角与反派的核心冲突",
  "tool": "characters.generate",
  "input": {
    "focus": "主角、反派、关系与成长弧",
    "constraints": ["不新增未确认的世界规则"]
  },
  "decisionSummary": "世界观候选已确认，人物动机仍不足以支撑主线。"
}
```

### 5.3 请求作者确认

```json
{
  "action": "request_approval",
  "objective": "确认全书大纲",
  "tool": "artifact.request_approval",
  "input": {
    "artifactId": "…",
    "revisionNo": 3
  },
  "decisionSummary": "全书大纲候选已完成，进入作者确认。"
}
```

### 5.4 结束

```json
{
  "action": "finish",
  "objective": "完成本次创作准备",
  "input": {
    "reason": "stories_ready_for_writing"
  },
  "decisionSummary": "故事圣经与章节大纲已确认，可以开始正文生产。"
}
```

规则：

- 一次只允许一个 action；
- 顶层与嵌套对象都拒绝未声明字段；
- `tool` 必须来自当前状态可用的工具清单；
- 工具输入由对应工具的严格 Schema 校验；
- `decisionSummary` 是给作者看的产品说明，不是隐藏推理；
- 任何 action 或工具不能携带 prompt、API Key、Cookie、任意文件路径；
- 同一状态重复同一动作超过阈值时，Runtime 以 `COORDINATOR_LOOP_DETECTED` 终止。

## 6. Agent 全集与落地性质

“Agent 全集”是产品能力地图，不等于所有条目都必须成为独立 LLM Agent。以下分类只决定
实现方式，不改变其作为 Coordinator 受控能力的产品边界。

### 6.1 规划与构建

| 能力 | 稳定工具名 | 职责 | 实现性质 | 阶段 |
| --- | --- | --- | --- | --- |
| 创意 Agent | `concept.generate` | 一句话创意扩展为核心冲突、卖点、目标读者、故事方向 | LLM Agent | C1-B |
| 世界观 Agent | `world.generate` | 生成世界背景、规则、限制、势力、地理与社会结构 | LLM Agent | C1-B |
| 人物 Agent | `characters.generate` | 生成主角、反派、配角、关系、秘密、动机、成长弧 | LLM Agent | C1-B |
| 剧情 Agent | `plot.generate` | 设计主线、关键转折、高潮、结局与伏笔意图 | LLM Agent | C1-B |
| 全书大纲 Agent | `outline.master.generate` | 把创意与设定整理为全书结构 | LLM Agent | C1-B |
| 分卷大纲 Agent | `outline.volume.generate` | 拆卷并确定每卷目标、冲突、升级和高潮 | LLM Agent | C1-B |
| 章节大纲 Agent | `outline.chapter.generate` | 拆章并确定目标、场景、冲突、结果与伏笔 | LLM Agent | C1-B |

### 6.2 写作与上下文

| 能力 | 稳定工具名 | 职责 | 实现性质 | 阶段 |
| --- | --- | --- | --- | --- |
| 上下文编排 Agent | `context.compose` | 从故事圣经、确认大纲、前章摘要和事实中选择本章资料 | 确定性 Composer 为主；模型只给筛选建议 | C1-C |
| Writer Agent | `chapter.draft` | 按确认的章节大纲生成正文候选 | LLM Agent；复用并扩展现有 Writer | C1-C |
| 多稿 Writer Agent | `chapter.draft_variants` | 用不同风格生成多个正文候选供作者选择 | 可选 LLM 模式，不默认开启 | C1-E |
| 文风 Agent | `style.apply` | 按题材、节奏、视角和语言规范约束候选 | 版本化 Skill/规则包 + 可选 LLM 改写 | C1-E |

### 6.3 审校与修改

| 能力 | 稳定工具名 | 职责 | 实现性质 | 阶段 |
| --- | --- | --- | --- | --- |
| Reviewer Agent | `chapter.review` | 检查正文对本章大纲与冻结合同的符合度 | 现有 LLM Agent | C1-C |
| Continuity Agent | `continuity.review` | 检查人物、物品、境界、地点、时间线矛盾 | LLM Agent + 确定性事实查询 | C1-D |
| 设定审查 Agent | `world_rules.review` | 检查是否违反世界观规则与力量体系 | LLM Agent | C1-D |
| 文风审查 Agent | `style.review` | 检查 AI 味、重复句式、节奏与水字 | 规则检测 + LLM Agent 混合 | C1-D |
| Reviser Agent | `chapter.revise` | 根据结构化问题做定向修改，不改确认大纲 | LLM Agent | C1-C |
| 质量裁定 Agent | `draft.judge` | 多稿写作时比较候选并给出排序和建议 | 可选 LLM Agent，不替作者采纳 | C1-E |

### 6.4 记忆与状态

| 能力 | 稳定工具名 | 职责 | 实现性质 | 阶段 |
| --- | --- | --- | --- | --- |
| Summarizer Agent | `chapter.summarize` | 为正式定稿章节生成简短摘要 | 现有 LLM Agent | C1-C |
| FactExtractor Agent | `facts.extract` | 从定稿正文提取连续性事实候选 | 现有 LLM Agent | C1-C |
| Librarian Agent | `library.apply_approved_changes` | 把作者确认的事实/变更写回故事资料 | 确定性受控事务；不自由写库 | C1-D |
| 伏笔 Agent | `foreshadow.plan` | 管理伏笔开启、推进、推迟和回收 | 结构化状态 + LLM 建议 | C1-D |
| 故事一致性 Agent | `story_state.reconcile` | 维护“当前世界真相”的唯一权威状态 | 确定性投影 + LLM 冲突解释 | C1-D |

### 6.5 调度

| 能力 | 稳定名称 | 职责 | 实现性质 | 阶段 |
| --- | --- | --- | --- | --- |
| Coordinator Agent | `novel.coordinator@1.0.0` | 根据当前语义状态选择下一个受控 action | 唯一调度 Agent | C1-A |

说明：

- `context.compose`、`Librarian`、`story_state.reconcile` 不获得任意写权限；
- 每个工具只能通过自己的 Schema、事务和作者门禁落库；
- 每个 LLM Agent 都可以绑定版本化内部 Skill/规则包，但 Codex Skill 不是应用运行时；
- “多稿”“文风”“质量裁定”是可选能力，不能在个人 MVP 中默认放大模型成本。

## 7. 状态与数据模型

### 7.1 `novel_runs`

```text
id
author_id
work_id nullable
status
request_text
state_summary jsonb
state_version integer
current_goal
last_decision_summary
step_count
max_steps
locked_by
lease_until
heartbeat_at
cancel_requested_at
created_at / updated_at / completed_at
```

`state_summary` 只保存调度所需的结构化摘要：

```json
{
  "knownFacts": [],
  "openQuestions": [],
  "artifactVersions": {},
  "pendingApproval": null,
  "confirmedArtifacts": [],
  "healthWarnings": [],
  "nextAllowedTools": []
}
```

完整人物、设定、章节和大纲正文从各自表读取，不把整本小说反复塞入 run JSON。
`nextAllowedTools` 由 Runtime 每次根据数据库真实状态重新计算，不能信任模型自报。

### 7.2 `novel_run_steps`

append-only：

```text
id
run_id
step_no
decision jsonb
tool_name
input_hash
output_summary jsonb
status succeeded | failed
error_code
created_at / finished_at
UNIQUE(run_id, step_no)
```

重试不得生成第二个成功 step；旧 attempt 晚返回时由 run version / lease fence 拒绝提交。

### 7.3 `novel_agent_calls`

每个实际模型调用一条：

```text
id
run_id
step_id nullable
call_kind coordinator | tool
agent_name
agent_version
provider
model
prompt_tokens
completion_tokens
latency_ms
success
error_code
created_at
```

不保存 prompt、正文、模型原始响应或 API Key。

### 7.4 创作候选

C1-B 引入受控候选层：

```text
novel_artifacts
  id, run_id, author_id, work_id nullable,
  artifact_type, status, current_revision,
  created_at / updated_at

novel_artifact_revisions
  id, artifact_id, revision_no, schema_version,
  content jsonb, source_step_id, created_at
  UNIQUE(artifact_id, revision_no)
```

`artifact_type` 至少覆盖：

```text
concept
world
characters
plot
master_outline
volume_outline
chapter_outline
```

候选 revision append-only。作者确认后，确定性服务把确认版本投影到现有
`works`、`work_settings`、`entities`，以及后续新增的结构化大纲表。

正式故事资料不依赖不可查询的大 JSON：

- 人物、势力、物品、境界等继续使用现有 `entities` / `entity_attributes`；
- 世界观规则使用受约束的 setting / outline 表；
- 分卷与章节大纲使用有序节点表；
- 候选 revision 与正式投影之间有可追溯的确认记录。

## 8. 工具执行边界

每个工具注册时必须声明：

```text
name + version
input_schema
output_schema
side_effect: read_only | create_candidate | commit_approved | external_cost
required_state
allowed_artifact_types
max_output_tokens
requires_author_approval
```

Runtime 执行顺序：

1. 先按数据库状态计算当前可用工具；
2. Coordinator 只能看到这份工具清单；
3. 校验 action 与 tool 白名单；
4. 校验工具输入 Schema；
5. 校验预算和步骤上限；
6. 获取 run lease 与 run version；
7. 执行一个工具；
8. 校验 Agent 输出 Schema 与业务语义；
9. 在作品锁 / run 锁事务内写候选、step、state；
10. 仅所有写入成功后返回 `continue / waiting_* / finish`。

重复调用、工具失败和取消：

- 失败不自动切换到另一个创作阶段；
- 可重试错误留在同一 action，使用 attempt 预算；
- 不可重试错误进入 `failed`，并给出稳定错误码；
- 作者取消立即停止后续工具；
- 迟到结果不能覆盖新 run version；
- 连续重复 action 触发熔断，交由作者重新下指令。

## 9. 作者确认与写回

作者确认分为三类，不能混成一个“同意继续”按钮：

1. **资料确认**：核心创意、世界观、人物、关系、主线；
2. **大纲确认**：全书、分卷、章节大纲；
3. **正文与事实确认**：正文候选采纳、事实接受/拒绝、正式版本定稿。

每个确认记录：

```text
author_id
run_id
artifact_id
revision_no
decision
decided_at
```

约束：

- 确认是 append-only，改稿产生新 revision；
- Coordinator 不得静默覆盖已经确认的 revision；
- 作者编辑候选后产生新 revision，并重新进入确认；
- 未确认的章节大纲不能调用 `chapter.draft`；
- 事实接受仍只表示“可作为写回输入”，真正写回由 Librarian 的确定性事务执行；
- 写回必须校验事实仍属于当前有效版本，旧事实一律拒绝。

## 10. 内部 Skill / 规则包

Agent 可以加载版本化内部 Skill：

- 题材规则；
- 世界观一致性规则；
- 人物弧与关系规则；
- 节奏、视角、文风规范；
- 去 AI 味规则；
- 大纲方法；
- 伏笔管理规则。

运行方式：

```text
Coordinator 选择工具
→ Runtime 根据工具定义选择 Agent
→ Runtime 固定该 Agent 的 promptVersion + skillBundleVersion
→ Agent 产出结构化候选
```

Coordinator 不能自行指定文件路径、加载任意 Skill 或读取本机文件。Codex Skill 只可用于
本项目开发过程，不是最终小说软件的 Agent 运行时。

## 11. 实施阶段

每个阶段都交付可被作者感知的最小纵向切片，避免再次出现“后端很完整，但软件不像写作产品”。

### C1-A：Coordinator Runtime 与动态问答壳

- `novel.coordinator@1.0.0` 严格动作 Schema；
- `novel_runs`、`novel_run_steps`、`novel_agent_calls`；
- 单 run 租约、版本 fence、预算、步数、重复动作熔断；
- Coordinator Worker 循环；
- `ask_user` / `finish` 两个最小工具；
- start / read / answer / cancel 最小 API；
- 一个最小“新小说”对话页：显示 Coordinator 当前问题、选项、自定义回答、
  步骤与等待状态；
- 不生成世界观、人物或大纲。

### C1-B：故事规划与确认

- 创意、世界观、人物、剧情、全书/分卷/章节大纲 Agent；
- `novel_artifacts` / revisions / confirmation；
- 作者编辑、重新生成、确认和拒绝；
- 故事圣经与大纲面板；
- 足够信息后确定性创建或绑定 `Work`；
- 作者明确确认章节大纲后，创作准备阶段才完成。

### C1-C：正文生产闭环

- 上下文 Composer；
- Writer 复用 A1 章节候选；
- Reviser 按结构化问题生成新候选；
- 现有 Reviewer、Summarizer、FactExtractor 接入 Coordinator 工具；
- “确认大纲 → 生成正文 → 审阅 → 作者采纳/退回修改 → 定稿”的页面闭环；
- 不自动无限重写。

### C1-D：连续性与故事记忆

- Continuity、设定审查、文风审查；
- 伏笔状态；
- Librarian 受控写回；
- 故事一致性投影；
- 作者确认事实后的资料更新；
- 连续性问题、冲突解释与修订候选。

### C1-E：高级可选能力

- 多稿 Writer；
- 质量裁定；
- 文风 Skill 包；
- 跨卷伏笔视图；
- 批量记忆维护；
- 只有真实使用证明需要时才启用，不进入默认 MVP 主路径。

## 12. 验收原则

- 至少两条不同创作路径都能完成到“章节大纲已确认”，证明 Runtime 没有写死阶段顺序；
- 作者中途说“先改世界观”或“退回重做人物”时，Coordinator 能选择正确工具并保留已确认产物；
- 未确认大纲不能进入正文写作；
- Agent 不能越权写库或绕过作者；
- 每次重试不产生重复成功 step 或重复候选；
- 任意一步崩溃后可以从最后成功 step 恢复；
- 预算、最大步数和循环熔断真实生效；
- 单次模型调用恰好一条脱敏调用日志；
- 不同作者、不同作品、不同 run 完全隔离；
- 所有候选、确认、正文采纳、事实决定均有稳定 Schema 和数据库约束；
- 每阶段同时交付 UI、服务、测试和 E2E，不只交付后台表或任务日志。

灵敏度验证必须能证明核心边界：

1. 写死“世界观 → 人物 → 大纲”的顺序 → 动态路径用例失败；
2. 去掉作者确认门禁 → 未确认大纲进入写作的用例失败；
3. 去掉工具白名单 → 非法工具 / SQL / 文件路径用例失败；
4. 去掉 run version / step fence → 旧响应覆盖用例失败；
5. 去掉重复动作熔断 → 无限循环保护用例失败。
