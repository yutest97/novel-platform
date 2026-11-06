# C1：单 Coordinator Agent 小说创作运行时

- 状态：方案冻结，待 C1-A 实施
- 目标基线：A2 CI #25 已验收（`07cb346`）
- 执行方：Trae
- 替代方案：固定 8 步 N1 向导方案

## 1. 核心决策

项目只保留一套**语义调度中心**：

```text
Coordinator Agent
  = 唯一决定“下一步做什么”的 Agent
```

现有 `WorkflowKernel`、`WorkerRunner`、PostgreSQL 租约和重试不会删除，但降级为
**基础设施**：

- 任务执行与持久化；
- 崩溃恢复；
- 租约、心跳、重试、取消；
- 权限和幂等；
- 工具调用；
- 预算和最大循环次数。

它们不再决定小说创作阶段的顺序。

## 2. 总架构

```text
用户目标 / 回答 / 确认
  ↓
Novel Coordinator Runtime
  ↓ 读取持久化状态
Coordinator Agent
  ↓ 输出严格 JSON 下一步动作
Runtime 校验动作、预算与作者权限
  ↓
执行工具 / 专用 Agent
  ├─ 创意候选
  ├─ 世界观候选
  ├─ 人物候选
  ├─ 全书 / 分卷 / 章节大纲候选
  ├─ 正文候选
  ├─ Reviewer 问题
  └─ 摘要 / 事实候选
  ↓
保存步骤结果与新的创作状态
  ↓
继续 / 等待作者 / 完成 / 失败
```

Coordinator 可以自由判断“先补世界观还是先补人物”“是否需要回退”“什么时候开始写正文”，
但必须通过 Runtime 的工具白名单和作者确认门禁。

## 3. 状态模型

### `novel_runs`

一次长流程创作会话：

```text
id
author_id
work_id nullable
status running | waiting_user | completed | failed | cancelled
request_text
state jsonb
state_version integer
current_goal
last_decision_summary
step_count
max_steps
created_at / updated_at / completed_at
```

`state` 只保存结构化创作状态，不保存 Chain-of-Thought、API Key、Cookie 或原始 prompt。

建议状态字段：

```json
{
  "brief": {},
  "concept": {},
  "world": {},
  "characters": [],
  "masterOutline": {},
  "volumes": [],
  "currentChapterOutline": {},
  "pendingApproval": null,
  "confirmedArtifacts": [],
  "openQuestions": []
}
```

### `novel_run_steps`

Coordinator 每次决策和工具执行的可追溯记录，append-only：

```text
id
run_id
step_no
decision jsonb
tool_name
input_hash
output jsonb
status started | succeeded | failed
error_code
started_at / finished_at
```

### 创作产物

- 故事草稿先作为候选保存在 run state / artifact 表；
- 作者确认后才写现有 `works`、`work_settings`、`entities`；
- 全书 / 分卷 / 章节大纲使用受约束表，不塞入不可查询的大 JSON；
- 已确认产物有版本，Coordinator 不得静默覆盖。

## 4. Coordinator 动作契约

Coordinator Agent 只输出动作，不直接输出最终数据库写命令。

示例：

```json
{
  "action": "ask_user",
  "objective": "确定题材和核心冲突",
  "tool": "ask_user",
  "input": {
    "question": "你更想写哪一种故事？",
    "options": ["玄幻升级", "都市异能", "悬疑推理"]
  },
  "decisionSummary": "基础信息不足，先询问作者。"
}
```

动作白名单：

- `ask_user`
- `generate_concept`
- `generate_world`
- `generate_characters`
- `generate_master_outline`
- `generate_volume_outline`
- `generate_chapter_outline`
- `validate_outline`
- `generate_chapter_draft`
- `review_chapter`
- `summarize_chapter`
- `extract_facts`
- `request_artifact_approval`
- `finish`

规则：

- 只允许一个 action；
- 未知 tool / 未知字段 / 非白名单动作拒绝；
- input 由 Runtime 做严格 Schema 校验；
- Coordinator 不输出 SQL、Prisma 调用、文件路径或任意 shell；
- `decisionSummary` 面向作者展示，不是隐藏推理；
- 同一状态重复同一动作超过阈值时，Runtime 中止并报告循环风险。

## 5. Runtime 安全边界

Runtime 负责：

1. 从数据库加载 run state；
2. 用状态摘要 + 用户最新回答调用 Coordinator；
3. 校验动作是否合法；
4. 校验预算、最大步骤数、重复动作；
5. 执行白名单工具；
6. 原子保存 step、output、state；
7. 返回继续、等待用户、作者确认或完成；
8. 崩溃后从最后成功 step 恢复。

Agent 不直接访问数据库。作者确认：

- `ask_user` 后 run 进入 waiting_user；
- 用户回答后创建下一次执行；
- 故事圣经、全书/分卷/章节大纲必须经过 `request_artifact_approval`；
- 作者点确认后，代码事务才写入正式模型；
- 未确认大纲不得进入正文写作；
- 作者拒绝时回到对应生成工具，不自动无限重试。

## 6. 工具与 Agent

Coordinator 本身只调度，具体能力由工具实现：

| 工具 | 类型 | 输出 |
| --- | --- | --- |
| Concept | Agent | 核心创意候选 |
| Worldbuilding | Agent | 世界观候选 |
| Character | Agent | 人物/关系候选 |
| Outline | Agent | 全书/分卷/章节大纲候选 |
| Composer | 确定性 Service | Writer 上下文包 |
| Writer | Agent | 正文候选 |
| Reviewer | Agent | 结构化问题 |
| Continuity | Agent/Service | 连续性冲突 |
| Summarizer | Agent | 正式版本摘要 |
| FactExtractor | Agent | 事实候选 |
| Librarian | 受控 Service | 作者确认后写回故事圣经 |

每个 Agent 可以加载内部“Skill”：

- 版本化写作规则；
- 题材规则包；
- 节奏与文风规范；
- 大纲方法；
- 去 AI 味规则。

这些 Skill 是软件内部数据 / 提示词模块，不是 Codex Skill 文件。

## 7. 用户界面

“写新小说”进入 Coordinator 创作页：

- 左侧：Coordinator 的问题、建议和当前目标；
- 中间：作者回答、选项和确认按钮；
- 右侧：实时故事圣经与大纲状态；
- 顶部：当前阶段、预算、步骤和保存状态；
- 用户可主动说“先改世界观”“把主角改成女性”“重新生成第二卷大纲”；
- Coordinator 根据新要求选择工具，而不是固定下一步；
- 候选内容可编辑，未经确认不进入正式作品。

## 8. 实施阶段

### C1-A：Coordinator Runtime

- Coordinator Agent 严格动作 Schema；
- `novel_runs` / `novel_run_steps`；
- Runtime 循环、预算、重复动作保护、崩溃恢复；
- `ask_user` / `finish` 最小工具；
- 确定性 Mock Coordinator；
- 最小 API，不含完整 UI 和专用创作 Agent。

### C1-B：故事规划工具

- Concept / Worldbuilding / Character / Outline Agent；
- 工具注册表与 Skill 版本；
- 候选、编辑、批准、拒绝；
- 故事圣经与大纲持久化。

### C1-C：章节生产工具

- Composer / Writer / Reviewer / Continuity / Summarizer / FactExtractor；
- 已确认章节大纲进入正文生成；
- 作者采纳、定稿和记忆更新；
- 复用现有 A1/A2 能力。

### C1-D：创作界面

- Coordinator 对话框；
- 问题选项；
- 故事 bible / 大纲实时面板；
- 作者确认流；
- 移动端和 E2E。

## 9. 验收原则

- Coordinator 是唯一路线决策者；
- Runtime 不根据固定写小说阶段自行推进；
- Agent 不能越权写库或绕过作者；
- 任意一步失败可恢复；
- 每步输入输出可追溯；
- 同一 run 不因重试产生重复故事产物；
- 自由调度不等于无限循环：有硬预算和熔断。
