# WorkBuddy 任务卡：A2-C-B Reviewer 候选审阅执行与持久化

## 开始前

只按需读取，不要加载 `docs/04` / `docs/08` 全文：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. 本任务卡
5. `docs/08-workflow-and-agents.md` 的 §1、§9、§10、§12、§21、§23
6. `packages/workflow/src/agent.ts`
7. `packages/workflow/src/chapter/reviewer.ts`
8. `packages/workflow/src/chapter/reviewer-mock.ts`
9. `packages/workflow/src/chapter/workflow.ts`
10. `packages/workflow/src/chapter/persistence.ts`
11. `packages/workflow/src/chapter/facts.ts`
12. `packages/workflow/src/worker.ts`
13. `apps/worker/src/runtime.ts`
14. `packages/db/prisma/schema.prisma`
15. 对应 workflow / worker / migration 测试

前置条件：

- 当前 HEAD 必须包含 A2-C-A 提交 `1482573`；
- 工作区必须干净；
- 负责人把本卡交给 WorkBuddy，即表示 A2-C-A 已允许进入下一阶段；
- WorkBuddy 不自行复审 Agent 契约，也不得修改历史 migration；
- PostgreSQL 可用时先执行 `prisma migrate status`；不可用属于环境阻塞，
  不得把集成测试改成 `skip`。

## 目标

把 `reviewer.chapter@1.0.0` 接入受工作流控制的候选审阅：

- Writer 候选保存后自动创建一个独立的 `chapter.review` 任务；
- Reviewer 任务读取不可变候选、冻结合同与安全上下文；
- 严格输出先过现有 Schema / 语义校验，再落运行状态与问题；
- Reviewer 失败、重试、取消都不得回滚候选或改变作者采纳权；
- 本轮不提供检查结果 API / UI。

## 本卡冻结的产品行为

1. **每个候选最多一个审阅运行**；重复入队、任务重试不得产生第二个 run。
2. 候选保存与审阅任务入队必须在**同一个作品锁事务**内提交。
3. `chapter.draft` 与 `chapter.review` 是两个任务：
   - Writer 候选成功保存后，正文任务可以成功结束；
   - Reviewer 失败只影响 review task / review run，不回滚候选；
   - Reviewer 重试由现有 generation task 重试机制负责。
4. Reviewer 问题只作警告。`high` 不阻止候选展示、采纳或定稿。
5. 不自动重写正文，不根据 issues 自动再次调用 Writer，不自动采纳。
6. 候选被采纳后才开始审阅也允许继续；候选正文与冻结合同均不可变。
7. A2-D Summarizer 尚未实现，本轮 `priorSummaries` 固定为 `[]`；
   不得拿草稿、候选正文或正式正文冒充“前章摘要”。

## 实现范围

### 1. `chapter.review` 任务

新增稳定任务类型：

```text
chapter.review
```

任务输入只允许：

```json
{ "candidateId": "uuid" }
```

约束：

- 未知字段、非 UUID、缺少 candidateId 一律拒绝；
- `input_snapshot` 不含正文、contract 内容、prompt、evidence 或密钥；
- requestId 使用确定性的 `review:<candidateId>`（总长 ≤128）；
- inputHash 复用现有 canonical JSON / request hash 逻辑；
- provider / model 按当前 Worker Provider 与
  `runner.resolveModel(REVIEWER_CHAPTER_AGENT)` 记录；
- `maxAttempts` 使用现有默认值，不另造重试机制；
- `persistChapterCandidate` 在同一事务内幂等确保 review task 存在：
  - 新候选 → 创建；
  - 候选已存在但 review task 缺失（崩溃恢复）→ 补齐；
  - task 已存在且 inputHash 相同 → 不重复创建；
  - 不得用“先提交候选、再另开事务入队”的两段式流程。

现有章节详情 / 章节列表等作者读接口只能继续展示 `chapter.draft` 任务；
在本轮不提供的 Reviewer UI 中，不得让内部 `chapter.review` 任务成为
“最新正文生成任务”而改变现有页面。该过滤是兼容修正，不新增 API 合同。

### 2. 数据表

新增一个新 migration（不要修改已推送/已验收的 11 个历史 migration）：

#### `chapter_review_runs`

至少包含：

```text
id
work_id
chapter_id
candidate_id
generation_task_id
agent_name
agent_version
provider
model
status                 running | succeeded | failed
passed                 boolean nullable
issue_count            integer 0..20
error_code             nullable stable code
created_at
started_at
finished_at             nullable
```

约束：

- `UNIQUE(candidate_id)`：每个候选最多一个 run；
- `UNIQUE(generation_task_id)`：一个 review task 对应一个 run；
- candidate / task 必须有复合外键，保证同作品、同章节、同候选；
- 为 issues 提供 `UNIQUE(id, candidate_id, chapter_id, work_id)`；
- 数据库检查 `issue_count 0..20`；
- 成功时 `passed=true` 必须对应 `issue_count=0`，
  `passed=false` 必须对应 `issue_count 1..20`；
- running / failed 时 `passed IS NULL`；
- 不允许保存正文副本、prompt、模型原始响应或密钥。

#### `chapter_review_issues`

至少包含：

```text
id
run_id
work_id
chapter_id
candidate_id
ordinal                0..19
severity               high | medium | low
type                   现有七类白名单
evidence               ≤300
suggestion             ≤500
created_at
```

约束：

- 复合外键绑定 run / work / chapter / candidate；
- `UNIQUE(run_id, ordinal)`；
- severity / type / 长度使用数据库检查兜底；
- issues append-only：UPDATE / DELETE 一律由 trigger 拒绝；
- run 只允许受控状态更新，成功后不可回改/删除；
- `evidence` 是 Reviewer 输出的一部分，允许按原样保存；
  但不得把完整 draft 另存，也不得写入日志、审计或 task_contexts。

### 3. 审阅上下文

Reviewer 输入必须由确定性代码组装：

- `chapter`：来自候选所属章节；
- `contract`：来自候选的不可变冻结合同；
- `draft`：读取 `chapter_candidates.content`；
- `characters / items / realms / factions`：
  - 只读同作品未删除实体；
  - 每类最多 100，顺序固定 `orderIndex asc → createdAt asc → id asc`；
  - summary 复用安全字段格式化，`secret*` 永不进入；
- `priorSummaries`：本轮固定 `[]`。

要求：

- candidate / contract / chapter / work 必须全部匹配，跨作品直接拒绝；
- 章节在审阅时即使已定稿也允许读取；review 不修改章节状态；
- 候选即使已被采纳仍可读取和审阅；
- task_contexts 可记录章节 / 合同 / 候选的 id 与安全摘要；
  不得记录 draft、evidence、prompt 或模型响应。
- 本轮不新增审计 action；review run、issues 与现有 llm_call_logs 就是审阅记录。

### 4. Review workflow

新增固定三步工作流：

```text
load_review_input
  → run_reviewer
  → persist_review_result
```

`load_review_input`：

- 锁 review task 并确认当前 Worker 所有权；
- 解析任务输入、读取候选 / 合同 / 安全上下文；
- 创建或复用 run 并置为 `running`；
- 已成功 run → 记录“无需再调用模型”，后续步骤跳过；
- failed run → 允许当前合法 attempt 重新置为 running；
- 写入确定性的 task_contexts。

`run_reviewer`：

- 调用 `reviewer.chapter@1.0.0`；
- 必须运行现有 `validateReviewerOutput`；
- 每次实际 Provider 调用写且只写一条 `llm_call_logs`；
- Schema / 语义错误记录 `success=false` 与 `AGENT_OUTPUT_INVALID`；
- 日志不包含 prompt、正文、evidence、suggestion 或原始响应。

`persist_review_result`：

- `runWorkWrite` + generation task 行锁 / lease fence；
- 同一事务写 issues、run succeeded / passed / issue_count / finished_at；
- issues 数量必须与 `issues.length` 和 run.issue_count 一致；
- run 已是 succeeded 时不重复插 issue；
- 旧 Worker、丢租约、取消后晚返回都不得写入 issues 或覆盖 run。
- review 成功 / 失败均不写 audit_logs。

失败处理：

- Provider / Agent / 语义失败：在仍持有任务 fence 时把 run 标为 failed，
  保存稳定 errorCode，再按现有任务错误分类抛出；
- 失败不修改 candidate、contract、chapter、adoption 或 draft task；
- `TASK_LEASE_LOST`、取消检查等控制层错误必须继续抛出，不得吞掉；
- 任务重试复用同一个 run，不新建第二行。

### 5. Worker 与 Mock

- `apps/worker/src/runtime.ts` 注册 `chapter.review` 工作流；
- 仍然只构造一次 Provider；
- 现有 provider / model 预检、租约、心跳、取消、重试逻辑不得复制或削弱；
- `createChapterMockProvider()` 增加 `reviewer.chapter` 分派：
  默认 `{ "passed": true, "issues": [] }`；
- 通用 `MockProvider` 继续不改；
- 测试夹具按 system prompt 分派 planner / writer / reviewer，
  并记录 Reviewer 的实际输入用于断言。

## 测试要求

新增 `packages/workflow/test/chapter-review-workflow.test.ts`，并调整受影响的既有测试。
至少覆盖：

1. Writer 候选保存后自动创建唯一 `chapter.review` task；
2. task 输入只有 candidateId，不含正文 / prompt / evidence；
3. 候选重试 / 已有候选时复盘不会重复入队；
4. 默认 Mock 审阅成功，run succeeded、passed=true、issue_count=0；
5. high / medium / low 和七类问题至少覆盖代表样例与稳定顺序；
6. run、issues 的复合归属约束与真实落库；
7. 非法 Reviewer 输出使 review task 失败，但候选和 draft task 结果不受损；
8. Provider 失败可重试，重试复用同一 run、不重复 issue；
9. 旧 Worker 晚返回不能写 issue / 覆盖 run；
10. 跨作品 / 错章节 / 错候选请求被拒绝；
11. secret / secretKnownBy 不进入 Reviewer 输入；
12. items 与四类实体上限、排序和截断行为确定；
13. priorSummaries 固定为空；
14. issues append-only、run 成功终态不可改、非法状态迁移被数据库拒绝；
15. `llm_call_logs` 成功/失败各一条且不含正文；
16. 现有章节详情 / 列表不把 review task 暴露为最新正文任务；
17. Worker 注册后 `runOnce` 能依次完成 draft 与 review；
18. 取消 / 租约丢失不会留下永久 running run；
19. review 成功 / 失败均不新增审计行。

测试必须使用真实 PostgreSQL；不要新增 `skip` / `fixme`。

## 迁移与文档

- 新 migration 必须在全新空库执行成功；
- 更新数据表 / 触发器 / 测试数量；
- 更新 `docs/03-data-model.md` 的 Reviewer run / issue 数据模型；
- 更新 `docs/08-workflow-and-agents.md` 的 `chapter.review` 固定步骤、
  自动入队、失败隔离和数据边界；
- 更新 `docs/09-project-memory.md` 的完成内容、当前下一步、测试数量、风险和决策；
- 更新 `docs/07-master-roadmap.md` 的 A2-C 子阶段状态；
- 不把 evidence / 正文 / prompt / Key 复制进文档示例。

## 验证

先确认 `prisma migrate status`，再运行：

```bash
pnpm --filter @novel/db generate
pnpm --filter @novel/db test
pnpm --filter @novel/workflow build
pnpm --filter @novel/workflow typecheck
pnpm --filter @novel/workflow test
pnpm --filter @novel/worker test
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

另做至少两次灵敏度验证：

1. 临时移除候选事务内的 review task 入队，确认“自动入队”用例失败，恢复后全绿；
2. 临时移除 review 写入前的 task fence，确认旧 Worker / 丢租约用例失败，恢复后全绿。

## 明确不做

- 新 HTTP API、前端、E2E UI；
- Reviewer 结果读取模型；
- high severity 采纳门禁；
- 自动重写 / 自动重试 Writer；
- 人工重新检查；
- Summarizer、RAG、embedding、图数据库；
- 修改已验收的历史 migration；
- 推送远端。

## 交付

本地提交，不推送。报告：

- 提交号；
- 任务类型、数据表、工作流步骤；
- 自动入队和失败隔离证据；
- 新增测试数与全量验证结果；
- 两次灵敏度验证结果；
- migration / 表 / trigger 数量；
- 未做项；
- 工作区状态；
- 等待负责人复审。
