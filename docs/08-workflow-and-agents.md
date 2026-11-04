# 08 工作流与 Agent（A1-1 / A1-2）

- 版本：v1.1
- 日期：2026-11-04
- 对应代码：`packages/workflow`
- 对应迁移：`20261104010000_a1_workflow_kernel`、`20261104020000_a1_chapter_draft`

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

## 2. A1-1 / A1-2 范围

**A1-1 交付**：确定性工作流内核、Provider 抽象、Agent 运行基础设施、
PostgreSQL 任务队列（领取/租约/心跳/重试/取消/幂等）、四张基础表。

**A1-2 交付**：`chapter.draft` 单章候选流水线（Planner → Writer）、
确定性 ContextBuilder、`chapter_contracts` / `chapter_candidates` 两张表；
通过 `WorkerRunner` 集成测试运行真实工作流，**不提供 HTTP API / UI**。

**不交付**：章节生成 API、章节编辑器 UI、候选采纳、`chapter_versions`、
Reviewer/Continuity/Fact、RAG/图数据库、资源流水、多人功能。
A1-3 才做采纳、正式版本与章节工作台。

---

## 3. 组件与调用关系

```
WorkerRunner (apps/worker 未来接入)
  ├─ sweepExpiredTasks      回收过期租约
  ├─ claimNextTask          FOR UPDATE SKIP LOCKED
  ├─ heartbeatTask          定时续租（失败 → abort）
  └─ WorkflowKernel
        └─ WorkflowDefinition（固定步骤）
              └─ AgentRunner（可选）
                    └─ ModelProvider（Mock / OpenAI 兼容）
```

- Kernel 不碰数据库：进度、取消、租约由 Worker 以回调注入；
- AgentRunner 不碰数据库：LLM 计量由调用方写入 `llm_call_logs`；
- Provider 只做 HTTP/确定性输出，不读环境之外的任何状态。

---

## 4. 数据表（A1-1 / A1-2）

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `chapters` | 最小章节骨架 | `UNIQUE(work_id, chapter_no)`、`chapter_no >= 1`、状态六态、FK works RESTRICT |
| `generation_tasks` | 任务队列 + 租约 | `UNIQUE(work_id, request_id)`、`input_hash`（64 位 SHA-256）、状态白名单、processing 必须有锁/租约、状态迁移触发器、终态不可变 |
| `task_contexts` | 任务引用的上下文摘要 | `(task_id, context_type, ref_id)` 唯一、snippet ≤ 500、rank ≥ 0 |
| `llm_call_logs` | 模型调用计量 | 只有 token/延迟/成功/error_code；**没有 prompt/正文列** |
| `chapter_contracts` | 冻结的章节合同 | 每任务最多一份、`UNIQUE(chapter_id, version_no)`、`target_words` 2500–4000、复合外键绑定 work/chapter/task |
| `chapter_candidates` | 正文候选（非正式版本） | 每任务最多一份、`word_count >= 1200`、复合外键绑定同任务合同 |

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
  `status` 只有 `candidate`；
- `chapter_contracts` / `chapter_candidates` 用**复合外键**绑定
  `(work_id, chapter_id, generation_task_id)`：章节必须属于作品、合同必须属于同章同任务、
  候选必须引用同任务合同；
- 合同 / 候选写入、章节状态更新、审计在**同一事务**提交；审计只记 ids、版本、
  字数与状态，**不记 goal / 场景 / 正文 / prompt**；
- 两张表都有数据库级**不可变保护**：
  - `chapter_contracts`：`BEFORE UPDATE / BEFORE DELETE` 一律 `restrict_violation`；
  - `chapter_candidates`：`BEFORE DELETE` 一律拒绝；`BEFORE UPDATE` 本轮一律拒绝，
    触发器里保留了 A1-3 `candidate → adopted` 的扩展分支（当前不开放）；
  - 因此直接 SQL 也改不了合同、删不掉候选；正常重试只做 SELECT，不受影响；
- 本轮**不建 `chapter_versions`**，候选不是正式正文；候选状态迁移与正式版本创建
  都留给 A1-3。

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
```

- 只允许向前推进，不降级；`finalized / abandoned` 不会被本流程覆盖；
- 失败 / 取消时停在最后一个已提交的里程碑：
  Planner 失败 → 仍为 `planned`；Writer 失败或取消 → `drafting`；
- 任何失败都不会产生候选，因此不存在"正式正文"被写一半的情况。

---

## 13. A1-3 预告（不在本轮）

- 章节工作台（列表 / 正文编辑 / 候选查看）；
- 候选采纳接口与 `chapter_versions`（正式版本、版本链、来源候选唯一）；
- 生成 API（会话 authorId）与任务进度查询；
- 按 `task_type` 强制章节任务必填 `chapter_id`（A1-1/A1-2 由工作流校验）；
- 重新生成与人工修订；仍不接 Reviewer。
