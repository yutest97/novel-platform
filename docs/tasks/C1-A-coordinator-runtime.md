# Trae 任务卡：C1-A Coordinator Runtime、工作流、持久化与动态问答壳

## 开始前

读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. `docs/plans/C1-coordinator-agent-runtime.md`
5. 本卡

再按需读取当前 `AgentRunner`、`WorkflowKernel`、`WorkerRunner`、Worker supervisor、
generation task、Web API、章节工作台轮询和 migration 模式。

产品代码验收基线是 `07cb346`；执行前以交付给 Trae 的最新本地 HEAD 为准。
执行方是 Trae。未得到用户明确要求，不推送远端。

## 目标

交付 C1 的第一个可感知纵向切片：

```text
作者点击“写新小说”
→ 打开 Coordinator 动态问答页
→ Coordinator 根据目标决定问什么
→ 作者回答
→ run / step / call 持久化
→ 继续提问或结束
```

C1-A 只开放 `ask_user` 和 `finish`。这是为了先证明唯一 Coordinator 调度循环、
作者等待点和持久化边界，不是固定问卷：后续 C1-B 会加入故事规划工具，Runtime 不写死
“世界观 → 人物 → 大纲”的顺序。

## 架构决定

### 为什么不是直接复用 `generation_tasks`

现有 `generation_tasks.work_id` 非空，而“新小说”可能在 `Work` 建立前就开始问答。
C1-A 使用独立的 run 队列表，不修改已验收的 `generation_tasks`：

- 语义调度中心仍只有 Coordinator；
- 基础设施可以有不同队列；
- Worker 进程同时轮询现有 generation tasks 和 novel runs；
- 后续若抽象出安全可复用的 lease adapter，再做重构，不在本卡大改 WorkerRunner。

不得创建一个假的 `Work`、临时作者或占位 genre rule package 来绕过约束。

### 控制流

```text
load queued run
→ acquire run lease
→ load state + latest author answer
→ call Coordinator Agent
→ validate strict action
→ execute one tool
→ persist agent call + step + state/version atomically
→ continue | waiting_user | finish | fail
```

## 工作流定义

C1-A 必须同时交付“动态路由”和“确定性工作流”，不能只实现一个调用模型的循环。

### run 状态机

```text
POST start
→ queued
→ worker 领取
→ running(deciding → tool_running → validating → committing)
   ├─ ask_user 提交成功 → waiting_user
   ├─ finish 提交成功 → completed
   ├─ 可重试失败 → queued（attempt 未耗尽）
   ├─ 永久失败 → failed
   └─ author cancel / cancel_requested_at → cancelled

POST answer（仅 waiting_user）
→ queued
→ running

POST cancel（queued / running / waiting_user）
→ cancelled
```

所有状态迁移由代码决定：

- `queued → running`：领取 lease 且 run version 未变化；
- `running → waiting_user/completed/failed`：step + state + call 在同一事务提交；
- `waiting_user → queued`：只有作者 answer 且 `expectedVersion` 匹配；
- 任意合法非终态 → `cancelled`：只设置取消请求或直接进入终态，之后不再执行工具；
- 终态不得回到 `queued/running`；
- `waiting_approval` 为后续阶段预留，C1-A 不得产生。

### ToolWorkflow

C1-A 的工具不能只是任意函数。每个工具注册一个最小确定性 workflow 描述：

```text
name
allowedFromStatus
inputSchema
execute(context)
successTransition
sideEffect: read_only | create_candidate | external_cost
maxAttempts
timeoutMs
```

C1-A 只注册：

| tool | allowed from | 成功迁移 | 副作用 |
| --- | --- | --- | --- |
| `ask_user` | running | waiting_user | 写 pending question，不写创作资料 |
| `finish` | running | completed | 写终态，不写创作资料 |

内部 action 工作流固定为：

```text
guard
→ call coordinator
→ validate action
→ validate tool / input
→ check budget + duplicate action
→ execute tool
→ persist call + step + state/version
→ apply success transition
```

Agent 只发生在 `call coordinator`。它不能执行 guard、不能改 successTransition、不能直接写库。

### 错误分类与回退

- `AGENT_INPUT_INVALID` / `AGENT_OUTPUT_INVALID`：不重试同一原始输出，使用剩余 attempt
  重新调用模型；耗尽后 failed；
- Provider 瞬态错误 / 超时：有限重试，仍在同一 run / action 语义下；
- `NOVEL_RUN_LEASE_LOST` / version conflict：旧 attempt 不提交，新 attempt 接管；
- 工具白名单 / 状态迁移 / 输入冲突：不可重试，进入 failed 或版本冲突响应；
- 重复 action 超阈值：`COORDINATOR_LOOP_DETECTED`，不继续自动调用；
- 取消优先于重试：一旦观察到取消，未提交结果全部丢弃。

C1-A 的“回退”体现为同一 run 重新执行一个合法 action，不修改已提交 step；后续阶段
的 `review → revise → review` 等业务回退必须在各自 ToolWorkflow 中显式定义，禁止
Coordinator 直接改表或跳过门禁。

## Coordinator Agent

新增 `novel.coordinator@1.0.0`，复用现有 `AgentRunner` / `AgentDefinition` /
Provider，不直接访问数据库。

输入只允许：

```text
requestText
latestAnswer nullable
stateSummary
allowedTools
remainingSteps
```

输入中不得包含其它作者的数据、prompt、密钥或无限历史。

### 严格输出

使用当前 JSON Schema 校验器支持的结构，避免不可用的 `oneOf`。顶层只允许：

```json
{
  "action": "ask_user",
  "objective": "确认故事题材",
  "input": {
    "question": "你更想写哪一种故事？",
    "options": ["玄幻升级", "都市异能", "悬疑推理", "自定义"],
    "finishReason": null
  },
  "decisionSummary": "缺少题材，先询问作者。"
}
```

或：

```json
{
  "action": "finish",
  "objective": "结束本次问答",
  "input": {
    "question": null,
    "options": [],
    "finishReason": "author_requested_finish"
  },
  "decisionSummary": "作者明确要求结束。"
}
```

Schema + 代码侧语义校验要求：

- `action` 只允许 `ask_user` / `finish`；
- `ask_user`：question 非空、options 0..6、finishReason 必须为 null；
- `finish`：question 必须为 null、options 必须为空、finishReason 非空；
- objective / question / option / finishReason / decisionSummary 都限制长度；
- 顶层与 input 都拒绝未知字段；
- 不接受 SQL、Prisma、文件路径、shell、工具调用或任意 HTML；
- 输出不合法统一 `AGENT_OUTPUT_INVALID`，原始响应不进入业务状态或日志。

## Mock

新增 `createNovelCoordinatorMockProvider()`：

- 无 latestAnswer：确定性地 `ask_user`，询问题材或核心创意；
- 有 latestAnswer 且未明确结束：确定性地追问一个人物/目标读者问题；
- latestAnswer 为明确结束指令（例如 `结束` / `先到这里`）：
  确定性 `finish`；
- 不读时钟、不随机、不联网、不读环境 Key；
- 输出必须是通过同一严格校验的合法 JSON。

不得使用通用 Mock 的任意合法 JSON，也不得靠测试替换整个 Runtime。

## Runtime 与 Worker

新增 `NovelCoordinatorRuntime`（或等价命名）：

- 只调度一个 action；
- 工具白名单由 Runtime 按状态计算，不信任模型；
- 校验 step/token 预算；
- 重复 action 超过阈值返回 `COORDINATOR_LOOP_DETECTED`；
- `ask_user` 成功后 status=`waiting_user`；
- `finish` 成功后 status=`completed`；
- 失败写稳定错误码，不泄露 Provider 原始异常；
- 每次实际 Coordinator 模型调用写且只写一条 `novel_agent_calls`；
- `novel_run_steps` 只记录最终提交的 action；瞬时失败重试不重复成功 step；
- 永久失败可记录一个 failed step 后结束，唯一键仍保证不重复。

新增 Coordinator Worker poller：

- 领取 `queued` run，使用 `FOR UPDATE SKIP LOCKED`；
- 设置 `locked_by` / `lease_until` / `heartbeat_at`；
- 过期 lease 可被接管；
- 取消信号在模型调用前、调用后和提交前检查；
- 提交必须同时满足 run id、当前 `state_version`、`locked_by` 与未取消；
- 旧 Worker 晚返回得到 `NOVEL_RUN_LEASE_LOST`，不能写 step、调用日志或 state；
- 进程退出仍由现有 Worker supervisor 管理；
- 不改变 `chapter.draft` / `chapter.review` / `chapter.summarize` 注册与行为。

## 数据库 migration

新增一份 migration，不改已验收历史 migration。

### `novel_runs`

```text
id uuid pk
author_id uuid not null -> users
work_id uuid null
status text not null
request_text text not null
state_summary jsonb not null
state_version integer not null default 0
current_goal text not null
last_decision_summary text not null
step_count integer not null default 0
max_steps integer not null
locked_by text null
lease_until timestamptz(3) null
heartbeat_at timestamptz(3) null
cancel_requested_at timestamptz(3) null
created_at / updated_at / completed_at
```

约束：

- status 只允许 `queued|running|waiting_user|waiting_approval|completed|failed|cancelled`；
  C1-A 不产生 `waiting_approval`，但预留稳定枚举；
- requestText、currentGoal、lastDecisionSummary 长度受限；
- `max_steps` 1..100；
- `step_count` 0..max_steps；
- 终态 `completed|failed|cancelled` 不可重新进入 running；
- run status 与 `completed_at` 自洽；
- author 只能访问自己的 run，管理员普通接口 403；
- `work_id` 在 C1-A 保持 null；若未来非空，必须验证作品属于 author。

### `novel_run_steps`

```text
id uuid pk
run_id uuid not null -> novel_runs
step_no integer not null
decision jsonb not null
tool_name text not null
input_hash text not null
output_summary jsonb not null
status text not null
error_code text null
created_at / finished_at
UNIQUE(run_id, step_no)
```

- `status` 只允许 `succeeded|failed`；
- UPDATE / DELETE 由触发器拒绝；
- `decision` 只保存通过校验的动作，不保存 prompt / 原始响应；
- `output_summary` 只保存安全展示字段；
- failed step 的 errorCode 只允许稳定错误码。

### `novel_agent_calls`

```text
id uuid pk
run_id uuid not null -> novel_runs
step_id uuid null -> novel_run_steps
call_kind text not null
agent_name text not null
agent_version text not null
provider text not null
model text not null
prompt_tokens integer not null
completion_tokens integer not null
latency_ms integer not null
success boolean not null
error_code text null
created_at
```

- `call_kind` C1-A 只允许 `coordinator`；
- token / latency 非负；
- success=false 必须有稳定 errorCode；success=true 必须无 errorCode；
- append-only；
- 不保存 prompt、回答、正文、模型原始响应、Key。

所有新表必须在全新空库验证。不要通过修改 `07cb346` 的历史 migration 实现。

## 最小 API

```text
POST /api/novel-runs
GET  /api/novel-runs/:runId
POST /api/novel-runs/:runId/answer
POST /api/novel-runs/:runId/cancel
```

### start

请求只允许：

```json
{ "requestText": "我想写一本东方玄幻长篇" }
```

返回 `runId / status / version`。服务端创建 `queued` run，由 Worker 执行第一次
Coordinator 决策。不接受 authorId、status、tool、provider 或 model。

### read

只回显：

```text
runId
status
version
currentGoal
decisionSummary
question nullable
options[]
stepCount
createdAt / updatedAt
```

不返回 prompt、stateSummary、lockedBy、lease、agent raw output、provider/model。

### answer

请求只允许：

```json
{ "expectedVersion": 3, "answer": "东方玄幻，偏群像" }
```

- 只有 `waiting_user` 可回答；
- version 不匹配返回 409 `NOVEL_RUN_VERSION_CONFLICT`；
- answer 长度受限；
- 成功后清空 pending question、status=`queued`、version+1；
- 同一 `expectedVersion + same answer` 重试幂等，不重复入队；
- 同一 version 不同 answer → `NOVEL_RUN_ANSWER_CONFLICT`。

### cancel

- 作者可取消 queued/running/waiting_user；
- 已终态保持原状态并幂等返回；
- 终态不可恢复；
- 取消后不执行未开始工具。

所有接口：

- 未登录 401；
- 普通作者只能访问自己的 run，越权与随机 id 统一 404 `NOVEL_RUN_NOT_FOUND`；
- 管理员普通接口 403；
- 写接口强制 Origin；
- 返回 `Cache-Control: no-store`；
- 错误码稳定，不返回原始异常或模型响应。

## 前端动态问答壳

在作品列表页增加主入口「写新小说」，点击后：

1. 弹出一个简洁目标输入，或进入“描述你想写的故事”页；
2. 成功后跳转 `/novel-runs/:runId`；
3. 页面只显示 Coordinator 当前目标、最新说明、问题、选项和自定义回答；
4. `queued/running` 显示“正在整理下一步…”并按 1s → 2s → 5s 轮询；
5. `waiting_user` 停止轮询，显示问题与回答框；
6. `completed` 停止轮询并显示“本次创作准备已结束”；
7. `failed/cancelled` 显示稳定文案；
8. 页面隐藏暂停轮询，恢复可见补一次；
9. 请求使用**单调序号 + AbortController**，旧响应不得覆盖新 run；
10. 回答提交中禁止重复提交，冲突时重新读取而不是覆盖。

## 测试

至少覆盖：

1. Coordinator 合法 ask_user / finish；未知 action、字段、空问题、错误 finish 拒绝；
2. start → worker → waiting_user，页面可读到 question/options；
3. answer → 新 version → worker → next question；
4. finish → completed；
5. 工具白名单：C1-A 虚构 `generate_world` / SQL / 文件路径输出被拒绝；
6. max step / duplicate action 熔断；
7. 同一 answer 幂等，不同 answer 冲突；
8. 旧 Worker 晚返回不能写 step / call / state；
9. 租约过期接管，失败重试不产生重复成功 step；
10. cancel 与终态不可恢复；
11. author 隔离、管理员 403、未登录 401、Origin；
12. API 与页面脱敏：无 prompt、stateSummary、lease、provider/model；
13. 每次模型调用恰好一条 `novel_agent_calls`，语义失败记 success=false；
14. migration 状态 CHECK、step/call append-only、run 终态约束；
15. 非法状态迁移（终态恢复、非 waiting_user 回答、错误工具来源）全部拒绝；
16. 前端轮询暂停/恢复、旧响应静默、回答冲突重新读取；
17. 浏览器 E2E：新小说 → 动态问题 → 回答 → 下一问题 → 完成/取消。

真实 PostgreSQL，不联网、不 skip、不使用 fixme。

## 文档与验证

新增/更新 `docs/03`、`docs/08`、`docs/09`、`docs/07`。
`docs/03` 记录新表与约束；`docs/08` 记录 Coordinator 动作和 Runtime 边界；
`docs/09` 更新能力、下一步、测试数、migration/表/触发器、风险与决策；
`docs/07` 更新 C1 阶段状态。

```bash
pnpm --filter @novel/db generate
pnpm db:deploy
pnpm --filter @novel/db test
pnpm --filter @novel/workflow build
pnpm --filter @novel/workflow typecheck
pnpm --filter @novel/workflow test
pnpm --filter @novel/web test
pnpm --filter @novel/web typecheck
pnpm --filter @novel/worker test
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
git diff --check
git show --check
```

另外必须验证：

- 全新空库 migration；
- 浏览器 E2E；
- 至少两次灵敏度验证，恢复后相关测试全绿。

建议灵敏度：

1. 跳过 Runtime 工具白名单 → 恶意 tool / 文件路径用例失败；
2. 去掉 run version + `locked_by` fence → 旧 Worker 晚返回用例失败；
3. 把 `ask_user` 直接改成固定三步问卷 → 动态路径测试和 Mock 分派失败。

## 不做

- 创意 / 世界观 / 人物 / 剧情 / 全书/分卷/章节大纲 Agent；
- `novel_artifacts` / 作者确认 / 故事圣经写回；
- Writer、Reviser、Continuity、Librarian、伏笔和质量裁定；
- 完整故事圣经 / 大纲 UI；
- 固定八步问卷；
- 修改 `generation_tasks` 或既有章节工作流语义；
- 自动创建假的 Work；
- 长正文进入 run state / step / call 日志；
- RAG / 图谱；
- 推送远端。

## 交付

本地提交，不推送。汇报：

- 提交号、工作区状态、HEAD；
- Coordinator Agent / Runtime / Worker 的实现位置；
- 3 张表及 migration / 表 / 触发器数量；
- 4 个 API 与最小动态问答页；
- 预算、循环、租约、取消、幂等和脱敏证据；
- 测试数、E2E、build / typecheck / lint / format；
- 空库 migration；
- 至少两次灵敏度结果；
- 未做项；
- 等待用户复审。
