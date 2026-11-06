# Trae 任务卡：C1-A 单 Coordinator Runtime 与持久化

## 开始前

读取 `AGENTS.md`、`docs/09-project-memory.md`、`docs/07-master-roadmap.md`、
`docs/plans/C1-coordinator-agent-runtime.md`、本卡，并按需读取当前 AgentRunner、
WorkerRunner、WorkflowKernel、generation task 和 migration 模式。

基线：`07cb346`，工作区干净。执行方是 Trae。

## 目标

建立唯一 Coordinator 调度循环：

```text
load run state → Coordinator decides → Runtime validates
→ execute one tool → persist step/state → continue | wait user | finish
```

C1-A 只做运行时、持久化、动作 Schema、Mock 和最小 API：

- 不接 Concept / World / Character / Outline / Writer；
- 不做完整创作 UI；
- 不写形成品设定或大纲。

## Coordinator Agent

新增 `novel.coordinator@1.0.0`：

- 输入：用户目标、最新回答、结构化 run state 摘要、可用工具清单、剩余预算；
- 输出严格 JSON：`action / objective / tool / input / decisionSummary`；
- 一次只允许一个 action；
- 未知字段拒绝；
- 不输出 SQL、文件路径、shell 或数据库命令。

C1-A 只开放工具：

```text
ask_user
finish
```

后续阶段再扩展白名单，但 Coordinator 契约不得要求 Runtime 写死创作阶段。

## Runtime

新增独立 `NovelCoordinatorRuntime`（或等价命名），复用现有 Worker/任务底层：

- 加载 `novel_runs`；
- 调 Coordinator Agent；
- 校验动作白名单和 input Schema；
- 预算、最大步骤数、重复动作保护；
- 执行一个工具；
- append step；
- 原子更新 run state/version；
- 等待用户 / 完成 / 失败。

说明：

- Agent 不访问数据库；
- Runtime 不根据固定“世界观→人物→大纲”顺序推进；
- `ask_user` 后 run status=`waiting_user`；
- 用户回答后版本校验并启动下一轮；
- 所有写操作幂等，重试不得重复 step。

## 数据表

新增 migration：

### `novel_runs`

```text
id, author_id, work_id nullable,
status(running|waiting_user|completed|failed|cancelled),
request_text, state jsonb, state_version,
current_goal, last_decision_summary,
step_count, max_steps,
created_at, updated_at, completed_at
```

### `novel_run_steps`

```text
id, run_id, step_no,
decision jsonb, tool_name, input_hash, output jsonb,
status(started|succeeded|failed), error_code,
started_at, finished_at
UNIQUE(run_id, step_no)
```

约束：

- 作者只能访问自己的 run；
- step append-only；
- 旧 run version / 旧 step 晚返回不能覆盖新状态；
- run 终态不可回 running；
- 不保存 prompt、正文、API Key 或模型原始响应；
- steps 记录工具输入 hash，不复制长正文。

## 最小 API

```text
POST /api/novel-runs
GET  /api/novel-runs/:runId
POST /api/novel-runs/:runId/answer
POST /api/novel-runs/:runId/cancel
```

- start 接收创作目标；
- answer 接收 `expectedVersion + answer`；
- start/answer 幂等；
- 作者归属 404，管理员 403，未登录 401；
- 写接口严格 Origin；
- 返回状态、当前问题、摘要、版本、stepCount，不返回内部 prompt。

## Worker

- 注册协调执行任务（例如 `novel.coordinator.step`）；
- 不改变现有 chapter.draft / review / summarize 工作流；
- 同一 run 同一时刻只允许一个执行 attempt；
- 租约丢失、取消、重试继续使用现有基础设施；
- 重复 action 超过阈值时进入 failed 并产生稳定错误码。

## Mock

新增 `createNovelCoordinatorMockProvider()`：

- 无用户目标时 `ask_user`；
- 有回答但未结束时可继续 `ask_user`；
- 收到明确结束指令时 `finish`；
- 输出严格、确定、不联网、不读时钟。

## 测试

1. 合法 Coordinator 动作通过；未知 action/tool/字段拒绝；
2. start → ask_user → waiting_user；
3. answer 后恢复并记录 step；
4. finish 后终态；
5. 预算/step 上限；
6. 重复动作熔断；
7. 重试不重复 step；
8. old run version / lease 晚返回隔离；
9. cancel / crash recovery；
10. 作者隔离、管理员 403、未登录 401、Origin；
11. API 响应脱敏；
12. 数据库 run/steps 约束。

真实 PostgreSQL，不联网、不 skip。

## 文档与验证

新增/更新 `docs/03`、`docs/08`、`docs/09`、`docs/07`。

```bash
pnpm --filter @novel/db generate
pnpm db:deploy
pnpm --filter @novel/db test
pnpm --filter @novel/workflow build
pnpm --filter @novel/workflow typecheck
pnpm --filter @novel/workflow test
pnpm --filter @novel/web test
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

灵敏度：

1. 跳过 Runtime 动作白名单 → 恶意 tool 用例失败；
2. 去掉 run version / step fence → 旧响应覆盖用例失败。

## 不做

- 创意 / 世界观 / 人物 / 大纲 Agent；
- Writer 接入；
- 完整创作 UI；
- 正式故事圣经写入；
- RAG / 图谱；
- 推送远端。

## 交付

本地提交，不推送。汇报提交号、Agent/Runtime、数据表、API、预算和恢复证据、
测试与门禁、两次灵敏度、未做项和工作区状态，等待复审。
