# 08 工作流与 Agent（A1-1 / A1-2 / A1-3 / A1-4）

- 版本：v1.6
- 日期：2026-11-05
- 对应代码：`packages/workflow`、`apps/web/app/api/works/**`、`apps/worker`
- 对应迁移：`20261104010000_a1_workflow_kernel`、`20261104020000_a1_chapter_draft`、
  `20261104030000_a1_chapter_versions`（A1-3B / A1-3C / A1-4A / A1-4B-A 均无新增迁移）

---

## 1. 三层职责（不可越级）

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| **工作流（控制层）** | 步骤顺序、状态迁移、租约、重试、取消、幂等、持久化 | 生成正文、理解语义 |
| **Agent（语义节点）** | 把结构化输入变成结构化输出（严格 Schema） | 访问数据库、决定下一步、写任务状态 |
| **作者（最终签发者）** | 确认事实/设定/正文，决定采纳或重写 | 手工维护队列与锁 |

一句话：**工作流是控制层、Agent 是语义节点、作者是最终签发者。**
模型输出永远只是候选，不能绕过作者直接改变作品状态。

---

## 2. A1-1 / A1-2 / A1-3A / A1-3B / A1-3C 范围

**A1-1 交付**：确定性工作流内核、Provider 抽象、Agent 运行基础设施、
PostgreSQL 任务队列（领取/租约/心跳/重试/取消/幂等）、四张基础表。

**A1-2 交付**：`chapter.draft` 单章候选流水线（Planner → Writer）、
确定性 ContextBuilder、`chapter_contracts` / `chapter_candidates` 两张表；
通过 `WorkerRunner` 集成测试运行真实工作流，**不提供 HTTP API / UI**。

**A1-3A 交付**：候选采纳服务 `adoptChapterCandidate` 与正式版本 `chapter_versions`。
只有数据库与服务层：采纳事务、版本号分配、候选 `candidate → adopted` 受控迁移、
章节状态推进、审计与幂等/并发保证。**不提供 HTTP API、章节 UI、差异对比与版本恢复**。

**A1-3B 交付**：章节 / 生成任务 / 候选 / 采纳的 HTTP API 与前端客户端函数。
作者可以创建章节、提交生成任务、轮询任务状态、取消任务、读取候选并采纳。
**没有章节 UI / 编辑器 / `human` 版本 / 版本恢复 / diff**，也不启动 Worker 常驻循环。

**A1-3C 交付**：`apps/worker` 常驻进程真正消费任务。
Worker 启动时只构造一次 Provider、注册 `chapter.draft`、并发启动健康检查与轮询；
领取任务后先做 provider/model 预检（不一致 → 不可重试的
`TASK_MODEL_CONFIG_MISMATCH`），再进入 Kernel；SIGTERM / SIGINT 优雅关闭。
后端端到端测试覆盖「API 创建任务 → Worker 生成候选 → API 读取候选 → API 采纳版本」。
仍然**没有章节 UI**。

**A1-3C-REV-01 交付**：循环本身有显式状态与健康语义。
`starting / ready / retrying / stopping / failed` 五态；只有瞬态基础设施错误
（Prisma 初始化/连接、P2021 缺表、57P01/57P03 等）退避重试；P2022、未知错误、
编程错误与业务错误一律 `failed` + 退出 1。`/healthz` 在循环未 ready 时返回 503。

**不交付**：章节编辑器 UI、`human` 版本、版本恢复 / diff、
Reviewer/Continuity/Fact、RAG/图数据库、资源流水、多人功能。
A1-4 才做章节工作台。

---

## 3. 组件与调用关系

```
apps/worker（A1-3C 常驻进程）
  ├─ /healthz                读取 supervisor 快照；未 ready → 503
  └─ WorkerLoopSupervisor（A1-3C-REV-01）
        ├─ runOnce()             直接调用，不走 start()
        ├─ 状态机               starting / ready / retrying / stopping / failed
        ├─ 错误分类             isRetryableWorkerLoopError（瞬态）/ 永久
        └─ WorkerRunner.runOnce
              ├─ sweepExpiredTasks      回收过期租约
              ├─ claimNextTask          FOR UPDATE SKIP LOCKED
              ├─ provider/model 预检     与当前 Provider 身份比对
              ├─ heartbeatTask          定时续租（失败 → abort）
              └─ WorkflowKernel
                    └─ WorkflowDefinition（固定步骤）
                          └─ AgentRunner（可选）
                                └─ ModelProvider（Mock / OpenAI 兼容）

Provider 只在进程启动时构造一次：同一个实例
  ├─ 交给 createChapterDraftWorkflow（实际生成）
  └─ 交给 WorkerRunner（预检 name / defaultModel）
```

- Kernel 不碰数据库：进度、取消、租约由 Worker 以回调注入；
- AgentRunner 不碰数据库：LLM 计量由调用方写入 `llm_call_logs`；
- Provider 只做 HTTP/确定性输出，不读环境之外的任何状态。

---

## 4. 数据表（A1-1 / A1-2 / A1-3A）

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `chapters` | 最小章节骨架 | `UNIQUE(work_id, chapter_no)`、`chapter_no >= 1`、状态六态、FK works RESTRICT |
| `generation_tasks` | 任务队列 + 租约 | `UNIQUE(work_id, request_id)`、`input_hash`（64 位 SHA-256）、状态白名单、processing 必须有锁/租约、状态迁移触发器、终态不可变 |
| `task_contexts` | 任务引用的上下文摘要 | `(task_id, context_type, ref_id)` 唯一、snippet ≤ 500、rank ≥ 0 |
| `llm_call_logs` | 模型调用计量 | 只有 token/延迟/成功/error_code；**没有 prompt/正文列** |
| `chapter_contracts` | 冻结的章节合同 | 每任务最多一份、`UNIQUE(chapter_id, version_no)`、`target_words` 2500–4000、复合外键绑定 work/chapter/task |
| `chapter_candidates` | 正文候选（非正式版本） | 每任务最多一份、`word_count >= 1200`、复合外键绑定同任务合同、状态仅 `candidate / adopted` |
| `chapter_versions` | **正式章节版本**（A1-3A） | `UNIQUE(chapter_id, version_no)`、`source_candidate_id` 部分唯一、`word_count 1200..char_length`、`content 1200..200000`、append-only 触发器 |

设计细节：

- `input_snapshot` 只放结构化输入（≤ 64 KiB），**不放 prompt、正文、API Key**；
- `input_hash` 是请求内容的 SHA-256（64 位小写 hex），覆盖
  `chapterId / taskType / inputSnapshot / provider / model / maxAttempts`；
  只存摘要，表里没有正文或完整 prompt 列；
- `error_message_sanitized` 只存服务端映射后的固定文案；
- `generation_tasks.chapter_id` 在 A1-1 **有意允许为空**（非章节型任务）；
  A1-2 由服务层按 `task_type` 强制章节任务必填（不在本轮实现）；
- 与早期数据模型的差异见 `03-data-model.md` §3.8。

---

## 5. 任务状态机

```
queued ──claim──▶ processing ──complete──▶ succeeded
  │                   │
  │                   ├──retryable fail（attempt < max）──▶ queued
  │                   ├──non-retryable / attempts 用尽────▶ failed
  │                   └──cancel_requested_at────────────────▶ cancelled
  └──cancel（尚未领取）────────────────────────────────────▶ cancelled

succeeded / failed / cancelled 为终态，不可修改。
```

**取消优先于成功与失败**：`processing` 中只要 `cancel_requested_at` 非空，
终态就只能是 `cancelled` —— 即使步骤正常返回、或抛出的是可重试错误、或
`attempt_count` 还没用尽，都不会写成 `succeeded`，也不会回到 `queued`。

- 判断与写入在**同一条 UPDATE** 里完成：
  - `completeTask` 用 `CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'succeeded' END`，
    返回 `succeeded | cancelled | lost`；
  - `failTask` 同一个 `CASE` 先判取消，再判重试，返回 `queued | failed | cancelled | lost`；
  - 两者都清空 `locked_by / lease_until`；取消时 `error_code / error_message_sanitized`
    置 `NULL`（取消不是失败，不留错误码）；
- Worker 只按 finalize 的返回值写 outcome，不再"先查取消、再写状态"；
- 迁移合法性由数据库触发器 `generation_tasks_status_transition` 兜底，
  直接用 SQL 也绕不过去；
- 每次 Worker 写入都带 `locked_by = 当前 Worker`（fencing）：
  租约被抢走后旧 Worker 的 `UPDATE` 影响 0 行，不会覆盖新 Worker。

---

## 6. 租约、心跳与崩溃恢复

1. `claimNextTask`：`queued` 中按 `created_at` 取一条，
   `FOR UPDATE SKIP LOCKED`，写 `locked_by / lease_until / heartbeat_at`，
   `attempt_count + 1`；
2. Worker 每 `leaseMs / 3` 心跳一次；续租失败（0 行）立即 `abort`，
   停止后续步骤；
3. 崩溃后：租约到期，下一轮 `sweepExpiredTasks` 按顺序处理：
   - 有 `cancel_requested_at` → `cancelled`（作者意图优先）；
   - `attempt_count >= max_attempts` → `failed` + `LEASE_EXHAUSTED`；
   - 其余 → `queued` + `LEASE_EXPIRED`，等待重新领取；
4. 因此不存在"永久 processing"的行。

**为什么 attempt 在领取时 +1**：领取即代表一次执行尝试；
崩溃也算一次，避免"无限崩溃—无限重领"。

---

## 7. 幂等（request_id + input_hash）

- `(work_id, request_id)` 唯一，且**只有 `input_hash` 相同才算同一个请求**：
  - 同键同指纹 → 返回既有任务，`created=false`，不覆盖、不新增；
  - 同键异指纹 → `TASK_REQUEST_CONFLICT`（409），不覆盖、不新建。
- `input_hash` 覆盖所有影响任务语义的字段：
  `chapterId / taskType / inputSnapshot / provider / model / maxAttempts`；
  其中 `chapterId` 使用规范化后的小写 UUID。
- `inputSnapshot` 先转 **canonical JSON** 再算 SHA-256：
  - 对象 key 递归排序；数组保持原顺序；
  - 拒绝 `undefined`、函数、Symbol、BigInt、非有限数字、非纯对象（如 `Date`）、
    循环引用与过深嵌套 —— 这些值无法稳定序列化，必须报 `VALIDATION_FAILED`，
    而不是像 `JSON.stringify` 那样静默丢弃。
- 落库的只有 64 位小写十六进制摘要（数据库 `CHECK` 兜底），
  **不含正文、完整 prompt 或 API Key**。
- 并发：两条不同内容的请求同时用同一个 `request_id`，唯一索引保证只有一条能插入，
  另一个在读回既有行后比较指纹并稳定报冲突 —— 结果必然是"一行任务 + 一个冲突"。
- 执行：同一条任务重试只增加 `attempt_count`，不新建任务。

---

## 8. Provider

```ts
interface ModelProvider {
  generateJson(input: ModelJsonInput): Promise<ModelJsonResult>;
  generateText(input: ModelTextInput): Promise<ModelTextResult>;
}
```

| 实现 | 用途 | 行为 |
| --- | --- | --- |
| `MockProvider` | 单测 / CI / 无网络 | 输出确定、可注入固定值或纯函数、token 由字符数估算、latency 固定 |
| `OpenAICompatibleProvider` | 真实模型 | `POST {baseUrl}/chat/completions`；JSON 模式带 `response_format`；只依赖 `fetch` |

切换只由环境变量决定：

```bash
MODEL_PROVIDER=mock                # 默认
MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=https://api.example.com/v1
MODEL_NAME=your-model
MODEL_API_KEY=...                  # 只进请求头，不落库、不进日志
MODEL_TIMEOUT_MS=60000
```

错误分类（全部可安全落库）：`MODEL_NOT_CONFIGURED / MODEL_NETWORK_ERROR /
MODEL_TIMEOUT / MODEL_ABORTED / MODEL_HTTP_ERROR / MODEL_INVALID_RESPONSE`。
HTTP 429/5xx 可重试；4xx 与解析失败不可重试。

---

## 9. Agent 基础

```ts
interface AgentDefinition {
  name: string;           // 小写标识符
  promptVersion: string;  // 例如 1.0.0
  model: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  maxOutputTokens: number;
  rolePrompt: string;
}
```

- `AgentRegistry` 以 `name@promptVersion` 唯一注册，支持同 name 多版本；
- `AgentRunner`：输入校验 → 调 Provider → 输出严格校验；
  未声明字段默认拒绝，`additionalProperties` 默认 `false`；
- 校验失败只返回路径与原因，不回显字段值；
- AgentRunner 不访问数据库、不决定下一步；
- `DETERMINISTIC_TEST_AGENT` 只用于证明链路可运行，不进入生产注册表。

---

## 10. 安全与日志

- **权限边界**：作者侧 `create/get/cancel` 必须传 `authorId`（只来自会话），
  统一走 `requireOwnedWork`；非所有者与管理员一律 404。
  Worker 的 `claim/heartbeat/complete/fail` 是内部接口，不接受作者身份。
- **不新增公开 API**：A1-1 没有 HTTP 路由；未来 API 只能从会话取 `authorId`，
  不能接受请求体里的作者字段。
- **日志**：只允许 taskId / taskType / status / errorCode 等定位字段；
  禁止 input_snapshot、prompt、正文、模型原始错误、API Key。
- **模型一致性**：任务行记录的 provider/model 必须与 Worker 当前配置一致；
  不一致直接 `TASK_MODEL_CONFIG_MISMATCH`（不可重试），禁止静默换模型执行。
- **不落库**：API Key、完整 prompt、正文、响应正文。

---

## 11. 测试策略

| 层 | 方式 |
| --- | --- |
| Schema / Agent / Kernel / Provider | 纯单测，不联网、不连库 |
| 队列 / 租约 / 状态机 / 章节隔离 | 真实 PostgreSQL，每用例独立作品并清理 |
| Worker | 真实 PostgreSQL + 测试工作流（含 Agent 集成、心跳、取消、重试、崩溃恢复） |
| 迁移 | 全新空库执行全部 migration；既有表不动 |

A1-1 系列（含 A1-1-REV-01）新增 118 个测试；A1-2 系列（含 REV-01）新增 35 个；
既有 390 个测试不减少。workflow 包当前共 **153** 个测试。

---

## 12. A1-2 单章候选流水线

### 12.1 流水线（taskType = `chapter.draft`）

```
WorkerRunner
  └─ WorkflowKernel（固定 6 步，顺序不可由模型改变）
       1 assemble_context              工作流：确定性装配上下文 + task_contexts
       2 plan_chapter                  Planner Agent（planner.chapter@1.0.0）
       3 validate_and_freeze_contract  工作流：代码校验 + 事务冻结合同 → 章节 outlined
       4 write_draft                   Writer Agent（writer.chapter@1.0.0；开始前 → drafting）
       5 validate_draft                工作流：trim + 服务端字数（≥ 1200）
       6 persist_candidate             工作流：事务写候选 → 章节 in_review
```

- 每一步之前由 Kernel 统一检查 `status / cancel_requested_at / locked_by`；
- 3 / 4 / 6 是写入步骤：事务内 `SELECT ... FOR UPDATE` 锁任务行并再次确认
  `locked_by = 当前 Worker`，租约被抢走就立即停止，不写任何业务数据；
- 步骤成功写 `current_step`；任务终态仍是 `succeeded / failed / cancelled`，
  **不新增任务状态**（"候选就绪"由 `chapter_candidates` 的存在表达）。

### 12.2 Planner（planner.chapter@1.0.0，简称 planner-v1）

输入（确定性代码组装，不含 prompt）：

- 作品方向（规则包当前 schemaRef 的字段，标签 → 展示值）；
- 人物 / 境界 / 势力摘要（秘密类字段被剔除）；
- 章节号、标题、目标字数；写作风格参数。

输出严格 JSON：

```json
{
  "goal": "string",
  "mustInclude": ["string"],
  "mustNotInclude": ["string"],
  "characters": ["string"],
  "scenes": [
    { "purpose": "string", "location": "string", "conflict": "string", "outcome": "string" }
  ],
  "targetWords": 2500
}
```

代码校验（Schema 之后再做一遍）：

- `goal` trim 后非空；`scenes` 至少 1 个，四个字段 trim 后都非空；
- `targetWords` 必须是 2500–4000 的整数，且**必须等于本次上下文请求的目标字数**
  （Planner 不能自行改动）；
- `characters` 只能引用本次上下文中真实存在的人物（精确匹配 `name`），
  不允许新增未提供人物；空数组允许，但非空时必须全部合法；
- 数组项 trim 后不能为空，按原顺序去重；
- 未知字段由 Schema 直接拒绝；任何一项不满足 → **不可重试失败**，不写合同。

### 12.3 Writer（writer.chapter@1.0.0，简称 writer-v1）

输入：已冻结的合同、合同点名的人物摘要、境界摘要、风格参数、目标字数。
输出：`{ "text": "正文" }`（正文作为 JSON 字段返回，便于复用严格 Schema）。

代码校验：

- `text` 去首尾空白后按"非空白字符数"统计，少于 1200 → 不可重试失败，不写候选；
- `word_count` 永远由服务端计算，**不读取模型自报的字数**（Schema 也不允许该字段）；
- 超过 200,000 字符直接拒绝。

### 12.4 上下文装配（确定性 ContextBuilder）

固定优先级与 `rank`：

| 顺序 | context_type | 来源 | rank |
| --- | --- | --- | --- |
| 1 | `chapter` | 章节号 / 标题 / 目标字数 / 视角与节奏 | 1 |
| 2 | `character` | 当前作品未删除人物（不含 secret） | 100 + i |
| 3 | `realm_level` | 境界体系 | 200 + i |
| 4 | `faction` | 势力 | 300 + i |
| 5 | `work_direction` | 作品方向（ref_id = workId） | 400 |

- 只按 `work_id` 读取；章节额外校验 `chapter.work_id`，**不跨作品**；
- 只读当前 `schemaRef` 的属性；`secret` / `secretKnownBy` 永不进入摘要与模型输入；
- 人物引用的境界 / 势力会解析为名称后再给模型；
- **每类实体最多 50 条**（人物 / 境界 / 势力各自计算），顺序固定为
  `order_index asc → createdAt asc → id asc`；超过 50 条时只取前 50 条，
  并在 `task_contexts` 末尾追加一条 `context_type='context.truncated'`、
  `ref_id=null`、`rank=500` 的安全提示（只说明哪类被截断，不包含实体内容）；
- 不调用模型决定上下文、不做 RAG；
- 每条来源写入 `task_contexts`（snippet ≤ 500）；写入采用**同事务先删后插**，
  重试不会重复、也不会留下上一轮已失效的来源（`context.truncated` 的 `ref_id`
  为 NULL，不能依赖唯一键去重）。

### 12.5 合同与候选的数据边界

- `chapter_contracts`：`goal / must_include / must_not_include / scene_beats / target_words`；
  `scene_beats = { version, characters, scenes }`（人物名单与场景节拍同属计划）；
  `status` 只有 `frozen`；同一任务最多一份，同一章节按 `version_no` 递增；
- `chapter_candidates`：`content / word_count / structured_plan`；
  `structured_plan = { version, contractId, contractVersion, goal, ..., scenes, targetWords }`；
  `status` 只有 `candidate / adopted`（A1-3A 起；迁移由采纳事务完成）；
- `chapter_contracts` / `chapter_candidates` 用**复合外键**绑定
  `(work_id, chapter_id, generation_task_id)`：章节必须属于作品、合同必须属于同章同任务、
  候选必须引用同任务合同；
- 合同 / 候选写入、章节状态更新、审计在**同一事务**提交；审计只记 ids、版本、
  字数与状态，**不记 goal / 场景 / 正文 / prompt**；
- 两张表都有数据库级**不可变保护**：
  - `chapter_contracts`：`BEFORE UPDATE / BEFORE DELETE` 一律 `restrict_violation`；
  - `chapter_candidates`：`BEFORE DELETE` 一律拒绝；`BEFORE UPDATE` 只放行
    `candidate → adopted` 这一条迁移，其余（含 `adopted → candidate`、改正文 / 字数 /
    计划 / 归属 / 创建时间）全部拒绝；
  - 因此直接 SQL 也改不了合同、删不掉候选；正常重试只做 SELECT，不受影响；
- A1-2 **不建 `chapter_versions`**：候选不是正式正文。正式版本与采纳见 §13。

### 12.6 模型选择（AgentDefinition.model 允许为空）

- `AgentDefinition.model` 表示"任务角色希望使用的模型"，**允许为空**；
- `ModelProvider.defaultModel` 是 Provider 的默认模型（非空）：
  - `MockProvider` → `mock-model`（可通过构造参数覆盖）；
  - `OpenAICompatibleProvider` → 环境变量 `MODEL_NAME`；
- `AgentRunner.resolveModel(agent)`：
  - `agent.model` 非空 → 使用它（显式覆盖）；
  - 为空 → 使用 `provider.defaultModel`；
- 章节 Planner / Writer 的 `model` 都是空字符串：真实环境自动使用 `MODEL_NAME`，
  单测 / CI 使用 Mock 的默认模型，不会把 `mock-model` 带进生产；
- `llm_call_logs` 成功记录 Provider 返回的实际 `model`；失败记录
  `resolveModel()` 的结果，**不允许空字符串**。

### 12.7 重试幂等

同一个 `generation_task` 重试时：

1. 合同已存在 → `plan_chapter` **不调用 Planner**，直接复用冻结合同；
2. 候选已存在 → `write_draft` **不调用 Writer**，复用候选正文；
3. `persist_candidate` 看到候选已存在 → 不再插入、不再写候选审计；
4. 章节状态按需补齐（合同 → outlined，候选 → in_review），状态已到位则不重复审计；
5. `llm_call_logs` 只对应**实际发生**的模型调用：重试跳过 Planner 时不会多出 planner 日志。

### 12.8 章节状态

```
planned ──合同冻结──▶ outlined ──Writer 开始──▶ drafting ──候选写入──▶ in_review
   └────────────────────── 采纳候选（A1-3A）──────────────────────────┘
```

- 只允许向前推进，不降级；`finalized / abandoned` 不会被本流程覆盖；
- 失败 / 取消时停在最后一个已提交的里程碑：
  Planner 失败 → 仍为 `planned`；Writer 失败或取消 → `drafting`；
- 任何失败都不会产生候选，因此不存在"正式正文"被写一半的情况；
- 采纳候选时若章节仍是 `planned / outlined / drafting`，直接推进到 `in_review`；
  `finalized / abandoned` 拒绝采纳（`CHAPTER_STATE_INVALID_FOR_ADOPTION`）。

---

## 13. A1-3A：候选采纳与正式版本

### 13.1 采纳事务（`adoptChapterCandidate`）

```
adoptChapterCandidate({ workId, chapterId, candidateId, authorId, meta? })
  └─ runWorkWrite（作品级 advisory lock，与设定 / 物品事件 / 生成任务共用）
       1  事务内重读作品归属 —— authorId 只来自会话；他人作品 / 管理员 404
       2  SELECT 章节 FOR UPDATE（锁内读到 status）
       3  SELECT 候选 FOR UPDATE（WHERE id + work_id + chapter_id）
       4  幂等：候选已 adopted 且版本存在 → 直接返回既有版本（deduplicated=true）
       5  状态校验：候选必须 candidate；章节必须 planned/outlined/drafting/in_review
       6  version_no = max(version_no) + 1；parent_version_id = 上一正式版本
       7  INSERT chapter_versions（source='ai'，content / word_count 原样复制）
       8  UPDATE 候选 status = 'adopted'（带 status='candidate' 条件）
       9  章节 → in_review（已是 in_review 则保持），变化时写 chapter.status_changed
      10  写 chapter.candidate_adopted 审计
```

- 全部在**同一个事务**：任何一步失败（包含审计写入失败）整体回滚，
  不会出现"候选 adopted 但无版本"或"有版本但章节没推进"的半成品；
- 候选正文与字数**原样复制**，服务层不改写、不 trim；正式版本正文与候选逐字节一致；
- 审计 detail 只含 `workId / chapterId / candidateId / versionId / versionNo / wordCount`，
  不含正文、goal 或 prompt；
- `meta` 是为 A1-3B 的 HTTP 层预留的请求追踪字段：**不落库、不进审计、不参与幂等**，
  采纳结果只由 `(workId, chapterId, candidateId)` 决定。

### 13.2 幂等与并发

| 场景 | 结果 |
| --- | --- |
| 同一候选重复采纳 | 返回既有版本，`deduplicated=true`；不新增版本、不重复审计（章节后来被定稿也不影响） |
| 同一候选并发采纳 | 作品级锁串行化：后到请求看到 `adopted` 后返回既有版本；`source_candidate_id` 部分唯一兜底，最多 1 个版本 |
| 同章节不同候选并发采纳 | 版本号在锁内按 `max+1` 分配，得到 1、2；`UNIQUE(chapter_id, version_no)` 兜底 |
| 候选已 adopted 但版本缺失 | `CHAPTER_VERSION_CONFLICT`（409）：只能是被绕过服务层的写入破坏 |

### 13.3 错误码

| 错误码 | HTTP | 触发 |
| --- | --- | --- |
| `CHAPTER_CANDIDATE_NOT_FOUND` | 404 | 候选不存在，或不在该作品该章节（含跨作品 / 跨章节） |
| `CHAPTER_CANDIDATE_NOT_ADOPTABLE` | 409 | 候选状态已不是 `candidate` |
| `CHAPTER_VERSION_CONFLICT` | 409 | 版本号 / 来源候选唯一冲突，或 adopted 候选缺版本 |
| `CHAPTER_STATE_INVALID_FOR_ADOPTION` | 409 | 章节处于 `finalized` / `abandoned` |
| `NOT_FOUND` | 404 | 作品或章节不属于当前作者（管理员同样 404） |
| `CONCURRENT_MODIFICATION` | 409 | 死锁 / 序列化失败（可重试） |

A1-3A **没有新增 HTTP 路由**；错误码已同时加入 `packages/auth` 与 `apps/web` 的文案表，
A1-3B 直接使用，不再遗漏。

### 13.4 数据边界

- `chapter_versions` 是**正式正文**，append-only（`BEFORE UPDATE / DELETE` 拒绝），
  修订只能追加新版本；
- `source_candidate_id` 部分唯一：一个候选最多生成一个正式版本；
- 复合外键保证"章节属于作品、来源候选与父版本同章节同作品"；
- `source` 目前只写 `ai`；`human`（人工撰写）留给 A1-B；
- 候选状态只允许 `candidate → adopted`，`adopted → 其它` 与删除始终拒绝；
- **没有**版本恢复、差异对比、采纳 UI、`apps/worker` 常驻循环。

---

## 14. A1-3B：章节 / 生成任务 / 候选 / 采纳 HTTP API

> 本轮**只有后端接口与前端客户端函数**：没有章节 UI、没有编辑器、没有 `human` 版本、
> 没有版本恢复 / diff、没有 Reviewer / RAG，也没有启动 `apps/worker` 常驻循环。

### 14.1 路由清单

全部在 `/api/works/:workId/...` 下；写接口一律校验 Origin，身份只来自会话 Cookie。

| 方法 | 路径 | 说明 | 成功 |
| --- | --- | --- | --- |
| POST | `/chapters` | 创建章节（`chapterNo` + `title`） | 201 `{ chapter }` |
| GET | `/chapters/:chapterId` | 章节 + 最新任务摘要 + 候选摘要列表 | 200 `{ chapter, latestTask, candidates }` |
| POST | `/chapters/:chapterId/generate` | 提交 `chapter.draft` 任务 | 201（新建）/ 200（幂等命中）`{ task }` |
| GET | `/generation-tasks/:taskId` | 任务状态 | 200 `{ task }` |
| POST | `/generation-tasks/:taskId/cancel` | 请求取消 | 200 `{ task }` |
| GET | `/chapters/:chapterId/candidates/:candidateId` | 候选正文 + 计划 | 200 `{ candidate }` |
| POST | `/chapters/:chapterId/candidates/:candidateId/adopt` | 采纳候选 | 201（首次）/ 200（重复）`{ version }` |

### 14.2 请求 / 响应 DTO

**创建章节**（严格白名单 `chapterNo / title`）：

```jsonc
// 请求
{ "chapterNo": 1, "title": "初入青云" }
// 响应（201）
{ "chapter": { "id", "workId", "chapterNo", "title", "status": "planned", "createdAt", "updatedAt" } }
```

- `status` / `createdAt` / `authorId` 都不接受客户端提交；
- 章号在作品内唯一，重复 → `409 CHAPTER_NO_TAKEN`；
- 审计 `chapter.created` 的 detail 只有 `workId / chapterId / chapterNo`。

**提交生成任务**（严格白名单 `requestId / targetWords / style`）：

```jsonc
// 请求
{ "requestId": "<uuid>", "targetWords": 3000,
  "style": { "tone": "克制", "pointOfView": "第三人称限知", "pacing": "中速" } }
// 落库 input_snapshot（只有这两个字段）
{ "targetWords": 3000, "style": { "tone": "克制", "pointOfView": "第三人称限知", "pacing": "中速" } }
```

- `provider` / `model` **只来自服务端配置**：`MODEL_PROVIDER` 决定 Provider，
  实际模型名取 `provider.defaultModel`（OpenAI 兼容 = `MODEL_NAME`，Mock = `mock-model`）；
- 客户端提交 `provider` / `model` / `authorId` / `status` / `workId` / `inputSnapshot`
  一律 400；
- 同 `requestId` 同内容 → 200 + 同一任务（`created=false`）；
  异内容 → `409 TASK_REQUEST_CONFLICT`。

**任务摘要**（GET / cancel）：`id / chapterId / status / currentStep / attemptCount /
maxAttempts / cancelRequestedAt / errorCode / errorMessage / createdAt / updatedAt`。

刻意**不返回** `inputSnapshot` / `inputHash` / `requestId` / `lockedBy` / `leaseUntil` /
`heartbeatAt` / `provider` / `model`：这些是调度与幂等内部字段。

**候选详情**：`id / chapterId / contractId / status / wordCount / content /
structuredPlan / createdAt`；已 `adopted` 的候选仍可读取（确认正式版本来源）。

**采纳**（严格白名单，只允许可选的 `requestId`）：

```jsonc
// 请求
{ "requestId": "trace-only" }
// 响应
{ "version": { "versionId", "versionNo", "wordCount", "chapterStatus", "deduplicated" } }
```

- **不返回正文**，正文由后续章节 / 版本读取接口提供；
- `requestId` 只用于追踪，不参与幂等（幂等由 `(workId, chapterId, candidateId)` 决定）；
- 首次采纳 201，重复采纳 200 + `deduplicated=true`；
- 章节 `finalized / abandoned` → `409 CHAPTER_STATE_INVALID_FOR_ADOPTION`。

### 14.3 归属与权限

| 场景 | 结果 |
| --- | --- |
| 未登录 / 会话失效 | 401 `UNAUTHENTICATED` |
| 管理员调用任意章节接口 | 403 `FORBIDDEN`（`requireAuthorSession` 只放行 author） |
| 他人作品（含任务、候选、采纳） | 404 `NOT_FOUND`（不区分"不存在"与"不属于你"） |
| 跨章节候选 | 404 `CHAPTER_CANDIDATE_NOT_FOUND` |
| 写接口缺 Origin | 403 `INVALID_ORIGIN` |
| 未知字段 / 非法参数 | 400 `VALIDATION_FAILED` |
| 其它异常 | 500 `INTERNAL_ERROR`，不回显原始异常 |

### 14.4 与工作流的分工

HTTP 层只做四件事：**会话与 Origin 校验 → 请求体白名单 → 调用服务层 → 映射错误码**。
它不生成正文、不决定上下文、不推进章节状态：

- 任务创建后停在 `queued`，由 Worker（`WorkerRunner`）领取执行；
- 候选由 `chapter.draft` 工作流写入，HTTP 层只读；
- 采纳调用 `adoptChapterCandidate`（作品锁 + 行锁 + 同事务审计），HTTP 层不重复实现幂等。

### 14.5 前端客户端

`apps/web/src/lib/api.ts` 新增：`ChapterSummary` / `ChapterDetail` /
`GenerationTaskSummary` / `ChapterCandidateDetail` / `ChapterVersionSummary` 类型与
`createChapter` / `fetchChapter` / `startChapterGeneration` / `fetchGenerationTask` /
`cancelGenerationTask` / `fetchChapterCandidate` / `adoptChapterCandidate` 函数。
本轮**没有页面**：客户端函数只被测试与后续 A1-4 的工作台使用。

### 14.6 章节状态边界（生成与采纳统一）

| 章节状态 | 提交生成任务 | Worker 执行 | 采纳候选 |
| --- | --- | --- | --- |
| `planned / outlined / drafting / in_review` | ✅ 201 | ✅ 正常推进 | ✅（推进到 `in_review`） |
| `finalized / abandoned` | ❌ 409 `CHAPTER_STATE_INVALID_FOR_GENERATION` | ❌ 不可重试 `TASK_INPUT_INVALID` | ❌ 409 `CHAPTER_STATE_INVALID_FOR_ADOPTION` |

**`startChapterDraft` 的判定顺序（幂等优先）**

```
规范化 workId / chapterId / requestId
  → 校验作品归属（他人作品 404）
  → 查 (workId, requestId) 是否已有任务
       ├─ 有：跳过章节状态检查，交给 createGenerationTask 比较 input_hash
       │       ├─ 同内容 → 200 + 既有任务（不新增、不重复审计）
       │       └─ 异内容 → 409 TASK_REQUEST_CONFLICT
       └─ 无：检查章节存在且处于开放状态
               ├─ finalized / abandoned → 409 CHAPTER_STATE_INVALID_FOR_GENERATION
               └─ 通过 → 创建任务
```

- **requestId 幂等优先于章节状态检查**：已存在同 `(workId, requestId)` 的任务时，
  即使章节随后被定稿 / 废弃，同内容重试仍返回原任务、异内容仍报
  `TASK_REQUEST_CONFLICT` —— 不会因为章节关闭把"重试"变成另一种错误；
- **只有新请求受章节关闭限制**：关闭态不建 `generation_task`、不写审计；
- **不绕过 `input_hash`**：幂等路径不自己比较内容，统一走 `createGenerationTask`，
  避免两条路径的指纹口径漂移；
- **Worker 第二道闸门**（覆盖"新请求创建过程中章节被并发关闭"的竞态）：
  - `buildChapterDraftContext` 读到关闭态 → 抛 `TASK_INPUT_INVALID`（不可重试），
    任务 `failed`，不冻结合同；
  - `ensureChapterStatus` 不再"静默保持原状"：读到关闭态直接抛错，
    防止合同冻结 / 候选写入越过定稿；
- **统一白名单**：生成与采纳共用 `types.ts` 的 `isChapterOpenForGeneration`
  （`planned / outlined / drafting / in_review`）；采纳的错误码保持独立
  （`CHAPTER_STATE_INVALID_FOR_ADOPTION`），已在 `adopted` 的候选在关闭章节重复采纳
  仍返回既有版本（幂等分支先于状态检查，行为未变）；
- **不自动重开**：已定稿章节不会因为生成请求被改回开放态；重新打开属于后续功能；
- 允许状态在生成过程中不受影响：`drafting / in_review` 直接进入流程，
  终态仍是 `in_review`。

---

## 15. A1-3C：Worker 常驻运行与后端闭环

### 15.1 启动装配

`apps/worker/src/index.ts` 的顺序固定：

```
读取 Worker 运行配置（非法 → 安全错误 + 退出码 1）
  → 构造 Provider（唯一一次）+ WorkflowRegistry
  → 注册 chapter.draft（createChapterDraftWorkflow({ db, provider })）
  → 构造 supervisor（初始 starting）
  → 启动 /healthz HTTP 服务（读取 supervisor 快照，fail-closed）
  → supervisor.run()：直接调用 runOnce()
```

- `apps/worker/src/config.ts`：只读环境变量，纯函数、可单测；
- `apps/worker/src/runtime.ts`：`createWorkerRuntime(db, env)` 负责装配，不监听端口、
  不连数据库；测试可注入 Provider 工厂验证"只构造一次"；
- `apps/worker/src/supervisor.ts`：状态机、退避、可中断 sleep；
- `apps/worker/src/loop-errors.ts`：瞬态/永久错误分类与安全 code；
- `apps/worker/src/index.ts`：进程生命周期（启动 / 信号 / 异常）。

### 15.2 运行配置

| 变量                  | 默认   | 校验                                             |
| --------------------- | ------ | ------------------------------------------------ |
| `WORKER_ID`           | 自动   | 可选；1..128 字符；空白视为未设置                |
| `WORKER_LEASE_MS`     | 30000  | 100..3600000 的整数                              |
| `WORKER_HEARTBEAT_MS` | 租约/3 | 1..600000；显式设置时必须**严格小于**租约        |
| `WORKER_POLL_MS`      | 1000   | 1..600000 的整数                                 |
| `WORKER_SWEEP_MS`     | 5000   | 1..600000 的整数                                 |
| `WORKER_PORT`         | 3001   | 1..65535 的整数                                  |
| `MODEL_PROVIDER`      | mock   | `mock` / `openai-compatible`（web 必须同值）     |

只接受十进制整数：`1.5`、`1e3`、空串以外的非数字写法一律拒绝。
错误只含字段名与范围，不回显同环境的其它变量（包括 `MODEL_API_KEY`、`DATABASE_URL`）。

### 15.3 provider/model 预检

`claimNextTask` 之后、启动 heartbeat / Kernel 之前：

```
task.provider === provider.name
且 task.model === provider.defaultModel ?
  ├─ 是 → 正常执行（心跳 → Kernel 固定 6 步）
  └─ 否 → failTask(retryable=false, TASK_MODEL_CONFIG_MISMATCH)
          不启动心跳、不调用 Agent、不写合同/候选/上下文
          返回 failed（若已有取消请求，仍按取消优先返回 cancelled）
```

- 错误码：`TASK_MODEL_CONFIG_MISMATCH`（不可重试）；
  它只出现在任务行 / 任务摘要（`errorCode` + 安全 `errorMessage`），
  不是 HTTP 路由错误码，不会作为 API 的 4xx 响应返回；
- 安全文案：**任务模型配置已变化，请重新提交生成任务**；
- 不允许"静默用当前模型重跑"：换模型会改变产物，必须由作者重新提交；
- 预检只比较 `name / defaultModel`，不读取也不记录 Key 或 prompt；
- 任务信封 `WorkflowTaskEnvelope` 新增 `provider` / `model` 两个字段，
  由 Worker 从任务行填充，Kernel 只透传。

### 15.4 循环状态、错误分类与关闭

**状态机**

```
starting ──runOnce 正常返回──▶ ready
   │                              │
   │ 瞬态错误                      │ 瞬态错误
   ▼                              ▼
retrying ──runOnce 正常返回──▶ ready
   │
   │ 永久错误
   ▼
failed ──▶ 进程退出 1
任意状态 ──stop()──▶ stopping ──▶ 健康端口关闭 ──▶ 退出 0
```

| 状态       | 进入条件                                 | `/healthz`           |
| ---------- | ---------------------------------------- | -------------------- |
| `starting` | 进程已启动，尚未完成第一次 `runOnce`     | **503**（error）     |
| `ready`    | 至少一次 `runOnce` **正常返回**          | 200（ok）            |
| `retrying` | 瞬态基础设施错误，退避等待中             | **503**（error）     |
| `stopping` | 收到 SIGTERM / SIGINT，正在关闭          | 200（degraded/warn） |
| `failed`   | 永久错误，进程即将以退出码 1 退出        | **503**（error）     |

`runOnce` 正常返回的 `idle / succeeded / retried / failed / cancelled / lease-lost`
全部算**循环健康**：`consecutiveFailures` 归零、`errorCode` 清空、`nextRetryMs` 清空、
`lastSuccessAt` 更新。任务级失败不是循环失败。

快照字段（`WorkerLoopSnapshot`）只有：`state / consecutiveFailures / errorCode /
nextRetryMs / lastSuccessAt`；不含 message、prompt、正文、Key、连接串。

**瞬态 vs 永久**（`isRetryableWorkerLoopError`）

| 分类 | 条件 | 行为 |
| --- | --- | --- |
| 瞬态 | `PrismaClientInitializationError`；P1001 / P1002 / P1008 / P1017 / P2021 / P2024；原始查询缺表 `42P01`（统一映射 `P2021`）；SQLSTATE 57P01 / 57P03；`ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT` / `EPIPE` / `ENOTFOUND` / `EHOSTUNREACH` / `ENETUNREACH` / `EAI_AGAIN`；显式 `RetryableWorkerLoopError` | `retrying`，1s → 2s → 4s → 5s（上限） |
| 永久 | P2022 缺列；其它 Prisma 已知请求错误；`PrismaClientUnknownRequestError`；所有 `WorkflowError`（业务错误，循环级不重试）；`TypeError` / `ReferenceError` / 断言错误 / 未知异常 | `failed`，记录稳定 code，进程退出 1 |

**空库启动**：`generation_tasks` 不存在时：
进程不退出 → `retrying` → `/healthz` **503** → 日志只记 `P2021`（映射后）；
迁移完成后下一轮 `runOnce` 正常返回 → `ready` → 200。
若运行期发现 P2022 缺列或未知代码错误 → `failed` + 退出 1，不无限重试。

**SIGTERM / SIGINT**：

```
supervisor.stop()（先置 stopping，唤醒退避 sleep，不再启动新一轮 runOnce）
  → server.close()（健康检查端口释放）
  → 等待 in-flight runOnce 退出
  → disconnectPrisma()
  → process.exit(0)
```

总时限 15 秒；超时强制退出（未完成任务的租约由其它 Worker 回收，语义与进程崩溃一致）。

**未捕获异常 / 未处理的 Promise 拒绝**：只打印稳定错误码
（`safeWorkerLoopErrorCode`）并退出码 1；启动配置错误只打印字段与固定文案。
任何路径都不打印原始异常消息（可能含连接串）、prompt、正文或任务快照。

### 15.5 后端端到端测试

`apps/web/test/chapter-backend-e2e.test.ts`，真实 PostgreSQL + MockProvider：

```
POST /chapters                                  创建章节
POST /chapters/:id/generate                    创建 chapter.draft 任务（provider=mock/model=mock-model）
WorkerRunner.runOnce()                         领取 → 预检 → Planner → 合同 → Writer → 候选
GET  /generation-tasks/:taskId                 轮询到 succeeded
GET  /chapters/:chapterId                      latestTask=succeeded + 候选摘要
GET  .../candidates/:candidateId               正文 = DRAFT（≥1200 字）
（持有作品锁）POST 采纳 + POST 创建章节          两个写操作都阻塞 → 证明共用同一把 work lock
POST .../adopt                                 201，versionNo=1，chapter in_review
再次 POST .../adopt                            200，deduplicated=true，版本数仍为 1
```

- 候选正文与正式版本逐字节一致，`source='ai'`、`source_candidate_id` 指向候选；
- `llm_call_logs` 恰好两条（planner / writer），无正文；
- 结束时该作品无 `queued / processing` 残留。

### 15.6 安全边界

- Worker 不监听业务 HTTP 请求、不接收请求正文，只提供 `/healthz`；
- Worker 的 Prisma 客户端关闭自身日志（`log: []`）：数据库原始错误（含表名、
  连接串片段）不进入 stdout/stderr，只由 supervisor 记录稳定 code；
- 任务快照 / prompt / 正文 / Key 不写日志；
- Agent 调用日志仍只写 token / 延迟 / 成功标志 / 稳定错误码；
- 管理员不是作者，仍无任务执行入口；没有新增公开执行接口；
- `llm_call_logs` 与 `task_contexts` 只由 Worker 内部写，HTTP 层不暴露。

### 15.7 健康检查

- `/healthz` 结构不变：`service / version / stage / status / components / uptimeSeconds`；
- 组件固定为 `worker`（恒 `ok`）、`queueLoop`（循环快照）、`database`（探测结果）；
- `queueLoop` 映射：`ready → ok`；`starting / retrying / failed → error`；
  `stopping → degraded`；
- **未 ready（starting / retrying / failed）一律 HTTP 503**，包括"数据库 ping 正常但
  循环 retrying"的情况，避免假健康；
- 迁移完成 / 连接恢复 → 循环 ready → `/healthz` 自动回到 200；
- `queueLoop.detail` 只含 `state / failures / code / nextRetryMs`，不含原始错误；
- 未接入 supervisor 时 fail-closed（`WORKER_LOOP_STATE_UNAVAILABLE` → 503）；
- 数据库不可用 → 整体 `error` + HTTP 503，`detail` 只保留 Prisma 错误首行，不含连接串；
- 停止信号后端口释放，旧连接不会挂住进程；
- compose 的 worker healthcheck 与 Caddy `/worker/healthz` 行为不变。

### 15.8 测试

- A1-3C：worker 27 / workflow 4 / web 后端 e2e 1；
- A1-3C-REV-01：worker 新增 34（错误分类 14 / supervisor 14 / 健康检查 5 /
  空库恢复 1），workflow 与 web 不变；
- 全量单测 **651**（web 160 / workflow 176 / worker 63 / shared 15 / db 10 /
  auth 95 / works 132）；浏览器 E2E 仍为 **67**，本阶段未改 UI。

---

## 16. A1-4A：章节工作台（已完成）

- 章节列表与创建、章节工作台（生成 / 轮询 / 取消 / 候选预览 / 采纳 / 正式阅读）；
- 只读 API：章节列表、版本摘要、版本正文；
- 与 A1-4B 的边界：**没有**编辑器、`human` 版本、diff / 恢复。

## 17. A1-4B-A：人工章节版本保存

> 本轮**只有服务层与 HTTP API**（+ 前端客户端函数）：没有 Markdown 编辑器、
> 没有版本恢复 / diff、没有局部重写，也不写候选表。

### 17.1 路由与 DTO

| 方法 | 路径 | 说明 | 成功 |
| --- | --- | --- | --- |
| POST | `/api/works/:workId/chapters/:chapterId/versions` | 保存人工版本 | 201 `{ version }` |

**严格白名单**：`content`（string）、`baseVersionId`（string \| null）。

```jsonc
// 请求（首版）
{ "content": "……", "baseVersionId": null }
// 请求（基于当前最新版本）
{ "content": "……", "baseVersionId": "<当前最大版本的 id>" }
// 响应（201，**不含正文**）
{ "version": { "versionId", "versionNo", "wordCount", "source": "human",
               "parentVersionId", "chapterStatus" } }
```

- `source` / `versionNo` / `createdBy` / `chapterId` / `workId` / 任何时间戳提交即 400；
- `baseVersionId` **必须显式出现**：漏传 → 400（不能默认成 null），
  `null` 表示"预期章节还没有正式版本"；
- 写接口校验 Origin；只允许作品作者（他人作品 404、管理员 403、未登录 401）；
- 请求体上限放宽到 150 万字符（正文可到 20 万字符，JSON 转义会放大长度），
  长度校验仍由服务层统一报 `CHAPTER_CONTENT_INVALID`。

### 17.2 事务与并发（`saveHumanChapterVersion`）

```
runWorkWrite（作品级 advisory lock）
  → requireOwnedWork
  → SELECT … FROM chapters WHERE id=? AND work_id=? FOR UPDATE
  → 读当前最大版本 latest
  → baseVersionId 与 latest 比对：不一致 → 409（绝不 last-write-wins）
  → 插入 chapter_versions(version_no = latest.version_no + 1,
        source='human', source_candidate_id=NULL,
        parent_version_id=baseVersionId, created_by=作者)
  → 章节 status → in_review
  → 审计 chapter.version_created
```

- **同 base 并发**：作品锁 + 章节行锁把写入串行化，第一个提交后第二个读到的
  latest 已变 → 恰好一个 201、一个 409，只新增一个版本；
- **不同 base 并发**：`baseVersionId=null` 且已有版本 → 直接 409；
  版本号只由 `max+1` 决定，不会跳号，也不会覆盖旧版本；
- 唯一约束（`chapter_id + version_no`）与死锁分别翻译成
  `CHAPTER_VERSION_CONFLICT` 与 `CONCURRENT_MODIFICATION`（都可重试）。

### 17.3 章节状态

| 保存前 | 保存后 | 说明 |
| --- | --- | --- |
| `planned` / `outlined` / `drafting` / `in_review` | `in_review` | 推进或保持 |
| `finalized` | `in_review` | 定稿后修订：允许保存，章节回到待定稿 |
| `abandoned` | 不变 | 拒绝：`409 CHAPTER_STATE_INVALID_FOR_SAVE` |

白名单见 `SAVE_CHAPTER_STATUSES` / `isChapterOpenForSave`（新增状态默认拒绝）。

### 17.4 正文校验

- 服务端 `trim` 后判断：空 → 拒绝；
- 大于 200000 字符 → 拒绝（与数据库 CHECK 一致）；
- 少于 1200 个非空白字符（`countWords`，与 AI 候选同一口径）→ 拒绝；
- 三类统一 `400 CHAPTER_CONTENT_INVALID`，文案「章节正文不合法，请检查字数和内容」；
  不回显正文、不提示差多少字；
- `wordCount` 由服务端按 `trim` 后的正文重新计算，**不接受客户端提交**。

### 17.5 审计

`chapter.version_created`，detail **只有**
`workId / chapterId / versionId / versionNo / source / wordCount / parentVersionId`；
不含正文、不含 prompt。审计失败 → 整个事务回滚（版本与章节状态一起回退）。

### 17.6 错误码

| 错误码 | HTTP | 触发 |
| --- | --- | --- |
| `CHAPTER_CONTENT_INVALID` | 400 | 正文空白 / 过短 / 超长 |
| `CHAPTER_VERSION_CONFLICT` | 409 | `baseVersionId` 不是当前最大版本，或版本号唯一冲突 |
| `CHAPTER_STATE_INVALID_FOR_SAVE` | 409 | 章节已废弃 |
| `CONCURRENT_MODIFICATION` | 409 | 数据库死锁 / 序列化失败（可重试） |
| `NOT_FOUND` | 404 | 作品 / 章节不属于当前作者 |

### 17.7 编辑器与后续阶段

A1-4B-B 已在本契约之上提供 **Markdown 人工编辑器**（章节工作台「正式版本」区）：
textarea 纯文本编辑、实时非空白字符数、`Ctrl/Cmd+S` 保存、dirty 取消确认、
冲突后「载入最新版本」、无版本时手写首版。编辑器只调用本节的
`POST /chapters/:chapterId/versions`，**不新增服务端契约**；字数仍由服务端重算。

**仍不提供**：版本 diff、历史版本恢复、局部重写、定稿流程按钮（A1-4B-C）。
人工版本 append-only（数据库触发器兜底），旧版本永久保留。
