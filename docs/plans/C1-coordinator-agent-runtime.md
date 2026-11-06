# C1：单 Coordinator Agent 小说创作运行时

- 状态：方案 v2，待 C1-A 实施
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

## 3. 运行模型

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

## 4. Coordinator 动作契约

Coordinator 只输出一个动作，不输出整本小说计划，也不输出 SQL、Prisma、文件路径或 shell。

### 4.1 询问作者

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

### 4.2 调用工具

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

### 4.3 请求作者确认

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

### 4.4 结束

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

## 5. Agent 全集与落地性质

“Agent 全集”是产品能力地图，不等于所有条目都必须成为独立 LLM Agent。以下分类只决定
实现方式，不改变其作为 Coordinator 受控能力的产品边界。

### 5.1 规划与构建

| 能力 | 稳定工具名 | 职责 | 实现性质 | 阶段 |
| --- | --- | --- | --- | --- |
| 创意 Agent | `concept.generate` | 一句话创意扩展为核心冲突、卖点、目标读者、故事方向 | LLM Agent | C1-B |
| 世界观 Agent | `world.generate` | 生成世界背景、规则、限制、势力、地理与社会结构 | LLM Agent | C1-B |
| 人物 Agent | `characters.generate` | 生成主角、反派、配角、关系、秘密、动机、成长弧 | LLM Agent | C1-B |
| 剧情 Agent | `plot.generate` | 设计主线、关键转折、高潮、结局与伏笔意图 | LLM Agent | C1-B |
| 全书大纲 Agent | `outline.master.generate` | 把创意与设定整理为全书结构 | LLM Agent | C1-B |
| 分卷大纲 Agent | `outline.volume.generate` | 拆卷并确定每卷目标、冲突、升级和高潮 | LLM Agent | C1-B |
| 章节大纲 Agent | `outline.chapter.generate` | 拆章并确定目标、场景、冲突、结果与伏笔 | LLM Agent | C1-B |

### 5.2 写作与上下文

| 能力 | 稳定工具名 | 职责 | 实现性质 | 阶段 |
| --- | --- | --- | --- | --- |
| 上下文编排 Agent | `context.compose` | 从故事圣经、确认大纲、前章摘要和事实中选择本章资料 | 确定性 Composer 为主；模型只给筛选建议 | C1-C |
| Writer Agent | `chapter.draft` | 按确认的章节大纲生成正文候选 | LLM Agent；复用并扩展现有 Writer | C1-C |
| 多稿 Writer Agent | `chapter.draft_variants` | 用不同风格生成多个正文候选供作者选择 | 可选 LLM 模式，不默认开启 | C1-E |
| 文风 Agent | `style.apply` | 按题材、节奏、视角和语言规范约束候选 | 版本化 Skill/规则包 + 可选 LLM 改写 | C1-E |

### 5.3 审校与修改

| 能力 | 稳定工具名 | 职责 | 实现性质 | 阶段 |
| --- | --- | --- | --- | --- |
| Reviewer Agent | `chapter.review` | 检查正文对本章大纲与冻结合同的符合度 | 现有 LLM Agent | C1-C |
| Continuity Agent | `continuity.review` | 检查人物、物品、境界、地点、时间线矛盾 | LLM Agent + 确定性事实查询 | C1-D |
| 设定审查 Agent | `world_rules.review` | 检查是否违反世界观规则与力量体系 | LLM Agent | C1-D |
| 文风审查 Agent | `style.review` | 检查 AI 味、重复句式、节奏与水字 | 规则检测 + LLM Agent 混合 | C1-D |
| Reviser Agent | `chapter.revise` | 根据结构化问题做定向修改，不改确认大纲 | LLM Agent | C1-C |
| 质量裁定 Agent | `draft.judge` | 多稿写作时比较候选并给出排序和建议 | 可选 LLM Agent，不替作者采纳 | C1-E |

### 5.4 记忆与状态

| 能力 | 稳定工具名 | 职责 | 实现性质 | 阶段 |
| --- | --- | --- | --- | --- |
| Summarizer Agent | `chapter.summarize` | 为正式定稿章节生成简短摘要 | 现有 LLM Agent | C1-C |
| FactExtractor Agent | `facts.extract` | 从定稿正文提取连续性事实候选 | 现有 LLM Agent | C1-C |
| Librarian Agent | `library.apply_approved_changes` | 把作者确认的事实/变更写回故事资料 | 确定性受控事务；不自由写库 | C1-D |
| 伏笔 Agent | `foreshadow.plan` | 管理伏笔开启、推进、推迟和回收 | 结构化状态 + LLM 建议 | C1-D |
| 故事一致性 Agent | `story_state.reconcile` | 维护“当前世界真相”的唯一权威状态 | 确定性投影 + LLM 冲突解释 | C1-D |

### 5.5 调度

| 能力 | 稳定名称 | 职责 | 实现性质 | 阶段 |
| --- | --- | --- | --- | --- |
| Coordinator Agent | `novel.coordinator@1.0.0` | 根据当前语义状态选择下一个受控 action | 唯一调度 Agent | C1-A |

说明：

- `context.compose`、`Librarian`、`story_state.reconcile` 不获得任意写权限；
- 每个工具只能通过自己的 Schema、事务和作者门禁落库；
- 每个 LLM Agent 都可以绑定版本化内部 Skill/规则包，但 Codex Skill 不是应用运行时；
- “多稿”“文风”“质量裁定”是可选能力，不能在个人 MVP 中默认放大模型成本。

## 6. 状态与数据模型

### 6.1 `novel_runs`

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

### 6.2 `novel_run_steps`

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

### 6.3 `novel_agent_calls`

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

### 6.4 创作候选

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

## 7. 工具执行边界

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

## 8. 作者确认与写回

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

## 9. 内部 Skill / 规则包

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

## 10. 实施阶段

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

## 11. 验收原则

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
