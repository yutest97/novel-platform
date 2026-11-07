# 08 工作流与 Agent（A1-1 / A1-2 / A1-3 / A1-4 / A2）

- 版本：v2.7
- 日期：2026-11-06
- 对应代码：`packages/workflow`、`apps/web/app/api/works/**`、`apps/worker`
- 对应迁移：`20261104010000_a1_workflow_kernel`、`20261104020000_a1_chapter_draft`、
  `20261104030000_a1_chapter_versions`、`20261105090000_a2_continuity_facts`、
  `20261106090000_a2c_review_runs`（A1-3B / A1-3C / A1-4A / A1-4B-A / A2-B 均无新增迁移）

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

## 18. A1-4B-C-A：章节正式版本 diff

> 只读服务 + 只读 HTTP API。**没有** diff UI、历史版本恢复、定稿流程、局部重写，
> 也**没有**新迁移（沿用 `20261104030000_a1_chapter_versions`）。

### 18.1 路由与 DTO

| 方法 | 路径 | 说明 | 成功 |
| --- | --- | --- | --- |
| GET | `/api/works/:workId/chapters/:chapterId/versions/diff?fromVersionId=&toVersionId=` | 两个正式版本的行级差异 | 200 `{ diff }` |

- **query 白名单**：只允许 `fromVersionId` / `toVersionId`，出现其它参数 → 400；
- 两个参数都必须**恰好出现一次**：漏传、空值、重复传参一律 400
  `VALIDATION_FAILED`（不做"取第一个 / 取最后一个"的隐式兜底）；
- UUID 形态由服务层 `normalizeUuid` 校验（非法 → 400）；
- GET 只读，**不校验 `Origin`**（写接口才需要）；
- 两个 id 可以相同（对比自己），不是错误。

```jsonc
// 响应（200，**不含完整正文**）
{
  "diff": {
    "fromVersion": { "id", "versionNo", "source", "wordCount" },
    "toVersion":   { "id", "versionNo", "source", "wordCount" },
    "lines": [
      { "kind": "equal",   "oldLineNo": 1,    "newLineNo": 1,    "text": "第一行" },
      { "kind": "removed", "oldLineNo": 2,    "newLineNo": null, "text": "旧句子" },
      { "kind": "added",   "oldLineNo": null, "newLineNo": 2,    "text": "新句子" }
    ],
    "stats": { "added": 1, "removed": 1, "unchanged": 1 }
  }
}
```

**行模型**（方向 `from → to`）：

| `kind` | `oldLineNo` | `newLineNo` | 含义 |
| --- | --- | --- | --- |
| `equal` | 有 | 有 | 两侧同一行（行号可能因前文增删而不同） |
| `removed` | 有 | `null` | 只在旧版本 |
| `added` | `null` | 有 | 只在新版本 |

- 行号从 1 起，按各自版本独立计数；
- `text` 不含换行符；
- `stats` 由 `lines` 统计得出：`unchanged` 是 `equal` 条数，不是"相同字符数"。

### 18.2 算法与确定性

```
splitDiffLines：CRLF / CR → LF，按 \n 切分，去掉末尾换行产生的空元素
  → 去公共前缀 / 后缀
  → 中间段 Myers O(ND) 最短编辑脚本
  → 回溯还原 equal / added / removed
  → summarizeDiff 统计
```

- **换行归一化**：`"a\r\nb"`、`"a\rb"`、`"a\nb"` 视为同一组行；
  `"a\n"` 与 `"a"` 无 diff 行（章节正文里末尾换行不是内容差异）；
- **中间空行保留**：`"a\n\nb"` 是 3 行，中间那行是空字符串；
- 中文与 emoji **按整行字符串比较**，不按 UTF-16 码元拆分（不会切坏代理对）；
- **确定性**：公共前后缀 + Myers 固定 tie-break，同样输入必得同样输出，
  与"请求次数 / 已有多少版本"无关；
- **方向性**：交换 `from` / `to` 后 `added` 与 `removed` 互换，行号各自从 1 重新计。

### 18.3 规模边界

| 常量 | 值 | 超限行为 |
| --- | --- | --- |
| `MAX_DIFF_CONTENT_CHARS` | 200000 | 400 `CHAPTER_DIFF_TOO_LARGE` |
| `MAX_DIFF_LINES_PER_SIDE` | 20000 | 400 `CHAPTER_DIFF_TOO_LARGE` |
| `MAX_DIFF_EDIT_DISTANCE` | 500 | **不报错**，中间段退化为"整段删除 + 整段新增" |

- 20 万字符与数据库 `chapter_versions_content_length_check` 一致，
  即正常保存过的正文不会因为字符数被 diff 拒绝；
- 行数上限防的是"20 万字符塞进极多短行"导致的行数组膨胀；
- 退化策略保证**有界**：编辑距离超限时不再追求最小脚本，但结果仍然确定、
  仍然可解释（该段标为全删 + 全增），不会挂起或耗尽内存；
- 以上均为内存计算，不落库、不写日志、不截断正文。

### 18.4 归属、权限与信息隐藏

```
requireOwnedWork(workId, authorId)          -- 他人作品 → 404
requireChapterInWork(workId, chapterId)     -- 章节不属于该作品 → 404
findMany({ where: { workId, chapterId, id: { in: [from, to] } } })
```

- 版本查询**同时**带 `workId + chapterId`：跨作品、跨章节、不存在的 id
  统一 404「版本不存在」，不泄露"这个 id 是否存在于别处"；
- 先校验作品归属再查版本，因此他人作品不会走到版本层；
- 未登录 401；管理员（非作者）403；
- 响应与错误体都不含正文片段、作者 id、数据库错误信息。

### 18.5 只读语义

- 单次 `findMany`，只 `select` `id / versionNo / source / wordCount / content`；
- 不写审计、不新增 / 修改 `chapter_versions`、不改章节状态、不动 `updated_at`；
- 正文只在内存中参与比较，不进入日志、不进入响应。

### 18.6 错误码

| 错误码 | HTTP | 触发 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | query 缺参 / 重复 / 空值 / 未知参数 / 非法 UUID |
| `CHAPTER_DIFF_TOO_LARGE` | 400 | 字符数 > 200000 或单侧行数 > 20000 |
| `NOT_FOUND` | 404 | 作品 / 章节不属于当前作者，或版本不属于该章节 / 作品 / 不存在 |
| `UNAUTHORIZED` | 401 | 未登录 |
| `FORBIDDEN` | 403 | 非作者（含管理员）访问他人作品 |

### 18.7 后续阶段

A1-4B-C-B 承接：diff 视图 UI（并列 / 行级高亮）、历史版本恢复为新版本、
恢复前确认、定稿流程。本节的服务契约即为 UI 的唯一数据来源，
**恢复不得原地改写旧版本**（`chapter_versions` append-only）。

## 19. A1-4B-C-B：版本对比 UI 与历史版本恢复

> 本轮完成 diff 的**前端消费**与**历史版本恢复**（服务 + API + UI）。
> 不实现定稿流程、不删除 / 覆盖历史版本、不做 diff 内局部编辑、
> 不修改 `chapter_versions` 表结构、不新增 migration。

### 19.1 版本对比 UI（只读）

正式版本区的「版本对比」按钮**按需展开**：折叠态不渲染面板、不预取 diff，
点击后才用默认组合请求一次。

| 行为 | 规则 |
| --- | --- |
| 默认选择 | 目标 = 列表第一个（最新版本）；起始 = 第二个（上一版）；**只有一个版本时自己比自己** |
| 切换选择器 | 立即清空旧结果并重新请求；响应按"最近一次选择"校验，被后发请求顶掉的结果直接丢弃 |
| 结果 | 两侧版本元信息（版本号 · 来源 · 字数）、`stats` 中文统计、行列表 |
| 行展示 | 双列行号（`·` 占位）+ 中文标签（`新增` / `删除`）+ 文本；`equal` 无标签 |
| 空 diff | `stats.added === 0 && stats.removed === 0` → 「两个版本内容一致。」 |
| 错误 | `CHAPTER_DIFF_TOO_LARGE` 显示稳定文案；404 / 会话错误走既有统一处理 |
| 只读 | 不改当前选中版本、不打开编辑器、不写 URL / localStorage / sessionStorage |
| 渲染安全 | 行文本用 React 文本节点（`{line.text}`），**不使用** `dangerouslySetInnerHTML` |
| 移动端 | 390×844 选择器竖排、行内文本 `pre-wrap + overflow-wrap: anywhere`、diff 区纵向滚动；不横向撑破 |

**严格解析**（`apps/web/src/lib/chapter-diff-view.ts`）：
逐字段校验版本元信息 / 行 / 统计；`kind` 与两侧行号必须自洽
（`equal` 两侧都有、`removed` 只有旧侧、`added` 只有新侧）；
`stats` 必须与 `lines` 实际条数一致。任何不一致都按 `INTERNAL_ERROR` 拒绝，
**不渲染半截结果**。

### 19.2 恢复契约（服务）

`restoreChapterVersion({ db, authorId, workId, chapterId, sourceVersionId, baseVersionId })`

```
runWorkWrite（作品级 advisory lock）
  → requireOwnedWork
  → SELECT … FROM chapters WHERE id=? AND work_id=? FOR UPDATE
  → 读 sourceVersion（必须同 workId + chapterId，否则 404）
  → 读 latest（versionNo desc）
  → baseVersionId !== latest.id → 409 CHAPTER_VERSION_CONFLICT
  → sourceVersionId === latest.id → 409 CHAPTER_VERSION_ALREADY_LATEST
  → 插入新版本（content / wordCount 原样复制，source='human'，
        parent_version_id=baseVersionId，version_no=latest+1）
  → 章节 status → in_review（复用人工保存的推进逻辑）
  → 审计 chapter.version_restored
```

- **旧版本只读**：恢复只新增一行，`chapter_versions` 的不可变触发器照常生效；
- **不重算字数**：`word_count` 与 `content` 一起从来源版本复制（来源已通过保存校验）；
- **baseVersionId 必须非空**：恢复永远基于"当前最大版本"，`null` 在 HTTP 层直接 400；
- 同一章节的保存 / 恢复 / 采纳共用同一把作品锁与章节行锁，因此并发恢复
  **恰好一个 201 + 一个 409**，版本号连续、不跳号。

### 19.3 恢复 HTTP API

| 方法 | 路径 | 成功 |
| --- | --- | --- |
| POST | `/api/works/:workId/chapters/:chapterId/versions/:versionId/restore` | 201 `{ version }` |

请求体**严格白名单**：只有 `baseVersionId`（string，**不允许 null**）。

```jsonc
// 请求
{ "baseVersionId": "<当前最大版本 id>" }
// 响应 201（**不含正文**）
{
  "version": {
    "versionId": "…",
    "versionNo": 3,
    "wordCount": 2181,
    "source": "human",
    "parentVersionId": "…",
    "restoredFromVersionId": "…",
    "chapterStatus": "in_review"
  }
}
```

- 写接口校验 Origin；未登录 401、非作者（含管理员）403；
- 他人作品 404；跨章节 / 跨作品 / 随机版本 id 统一 404「版本不存在」；
- 未知字段 / 缺 `baseVersionId` / null / 空串 / 非法 UUID → 400；
- 响应不含正文、作者 id、数据库错误。

### 19.4 审计

`chapter.version_restored`，detail **只有 7 个字段**：

`workId / chapterId / versionId / versionNo / sourceVersionId / parentVersionId / wordCount`

不含正文；审计写入失败 → 版本、章节状态整体回滚（同一事务）。

### 19.5 错误码

| 错误码 | HTTP | 触发 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 缺 / null / 非法 `baseVersionId`，未知字段，非法 UUID |
| `CHAPTER_VERSION_ALREADY_LATEST` | 409 | `sourceVersionId` 已是当前最新版本 |
| `CHAPTER_VERSION_CONFLICT` | 409 | `baseVersionId` 不是当前最大版本（含章节尚无版本 / 唯一约束冲突） |
| `CHAPTER_STATE_INVALID_FOR_SAVE` | 409 | 章节已废弃 |
| `CONCURRENT_MODIFICATION` | 409 | 数据库死锁 / 序列化失败（可重试） |
| `NOT_FOUND` | 404 | 作品 / 章节不属于当前作者，或历史版本不属于该章节 + 作品 |
| `UNAUTHORIZED` / `FORBIDDEN` | 401 / 403 | 未登录 / 非作者 |

### 19.6 恢复 UI

选中**历史版本**（非最新）时，只读提示区出现「恢复此版本为新版本」：

1. 点击 → 二次确认：「确认从版本 N 恢复为新版本？这会基于当前最新版本创建一个新版本，
   版本 N 不会被删除或修改。」
2. 确认 → 用**当前最大版本 id** 作为 `baseVersionId` 提交；恢复中按钮禁用；
3. 成功 → 关闭对比面板、提示「已从版本 N 恢复为版本 M」、
   刷新版本列表并自动选中最新版本；
4. 失败保留原状态：
   - `CHAPTER_VERSION_CONFLICT` → 稳定提示 + 「载入最新版本」（刷新列表并选中最新）；
   - `CHAPTER_VERSION_ALREADY_LATEST` → 直接刷新列表（恢复入口对最新版本本来就不显示）；
   - 会话错误 → 统一跳转。

**不提供**覆盖 / 删除历史版本的操作；恢复永远产生新版本。

### 19.7 未做

定稿流程（章节定稿按钮、定稿后只读）、diff 内局部编辑、版本删除 / 覆盖、
AI 候选采纳逻辑改动、`chapter_versions` 表结构变更、第三方 diff 依赖。

## 20. A1-4B-C-C：章节定稿

> 定稿 = 把章节锁定在**当前最新正式版本**上。不新增 `final_version_id`、
> 不新增 migration、不改 `chapter_versions` 触发器；旧版本继续 append-only。

### 20.1 状态机

```
planned / outlined / drafting ──✗──> finalized   （409 STATE_INVALID_FOR_FINALIZE）
abandoned ─────────────────────✗──> finalized   （409 STATE_INVALID_FOR_FINALIZE）
in_review ─────────────────────✓──> finalized   （唯一入口）
finalized + 同一最新版本 ──────✓──> finalized   （幂等，200 deduplicated=true）
finalized + 不同版本 ──────────✗──> finalized   （409 STATE_INVALID_FOR_FINALIZE）
finalized ──人工保存 revision──> in_review      （可重新定稿）
```

白名单：`isChapterFinalizable(status)` 只接受 `in_review`；未知状态默认拒绝。

### 20.2 事务顺序（`finalizeChapter`）

```
runWorkWrite（作品级 advisory lock）
  → requireOwnedWork
  → SELECT chapter FOR UPDATE
  → 读当前最大版本 latest
  → 已 finalized：latest 存在且 versionId === latest.id → 幂等返回（不写审计）
                  否则 → 409 STATE_INVALID_FOR_FINALIZE
  → 非 in_review 或 latest === null → 409 STATE_INVALID_FOR_FINALIZE
  → versionId !== latest.id → 409 CHAPTER_VERSION_CONFLICT
  → UPDATE chapters SET status='finalized'（带 status 条件，防并发覆盖）
  → 审计 chapter.finalized
  → 任一步失败整体回滚
```

并发：与保存 / 恢复 / 采纳共用同一把作品锁与章节行锁，因此两个并发定稿串行化：
一个首次写入（`deduplicated=false`），一个幂等（`deduplicated=true`），审计最多一条。

### 20.3 定稿后的写操作边界

| 写操作 | 定稿后 | 错误码 |
| --- | --- | --- |
| 生成候选 `startChapterDraft` | 拒绝 | 409 `CHAPTER_STATE_INVALID_FOR_GENERATION` |
| 采纳候选 `adoptChapterCandidate` | 拒绝（未采纳候选） | 409 `CHAPTER_STATE_INVALID_FOR_ADOPTION` |
| 恢复历史版本 `restoreChapterVersion` | 拒绝 | 409 `CHAPTER_STATE_INVALID_FOR_SAVE` |
| 人工保存 revision `saveHumanChapterVersion` | **允许** | —（保存后回到 `in_review`） |

- 生成 / 采纳沿用既有 `GENERATION_CHAPTER_STATUSES` 白名单（不含 `finalized`）；
- 恢复改用新的 `RESTORE_CHAPTER_STATUSES`（同样不含 `finalized`），
  与"保存仍允许"区分开：定稿后可以人工改稿，但不能用旧版本覆盖当前正文；
- 已采纳候选的重复采纳仍走幂等分支（不产生新版本），不视为绕过。

### 20.4 API

| 方法 | 路径 | 成功 |
| --- | --- | --- |
| POST | `/api/works/:workId/chapters/:chapterId/finalize` | 200 `{ chapter }` |

请求体严格白名单：只有 `versionId`（string，非空；不允许 null）。

```jsonc
// 请求
{ "versionId": "<当前最新正式版本 id>" }
// 响应 200（**不含正文**）
{
  "chapter": {
    "chapterId": "…",
    "status": "finalized",
    "versionId": "…",
    "versionNo": 5,
    "deduplicated": false
  }
}
```

- 写接口校验 Origin；未登录 401、非作者（含管理员）403、他人作品 404；
- 跨章节 / 跨作品 / 随机版本 id → 409 `CHAPTER_VERSION_CONFLICT`（不泄露存在性）；
- 未知字段 / 缺 `versionId` / null / 空串 / 非字符串 / 非法 UUID → 400；
- 响应不含正文、作者 id、数据库错误。

### 20.5 审计

`chapter.finalized`，detail **只有 5 个字段**：
`workId / chapterId / versionId / versionNo / wordCount`。
不含正文；幂等重试不写审计；审计失败 → 章节状态整体回滚。

### 20.6 错误码

| 错误码 | HTTP | 触发 |
| --- | --- | --- |
| `CHAPTER_STATE_INVALID_FOR_FINALIZE` | 409 | 无正式版本；状态不是 `in_review`；已定稿但版本不是当前最新 |
| `CHAPTER_VERSION_CONFLICT` | 409 | `versionId` 不是当前最新版本（in_review 分支）/ 唯一约束冲突 |
| `VALIDATION_FAILED` | 400 | 缺 / null / 非法 `versionId`、未知字段、非法 UUID |
| `NOT_FOUND` | 404 | 作品 / 章节不属于当前作者 |
| `CONCURRENT_MODIFICATION` | 409 | 死锁 / 序列化失败 / 状态被并发修改 |
| `UNAUTHORIZED` / `FORBIDDEN` | 401 / 403 | 未登录 / 非作者 |

### 20.7 UI

- `in_review` 且选中**最新**版本 → 「定稿最新版本（版本 N）」；
- `in_review` 且选中历史版本 → 「定稿仅支持最新版本，请先选择最新版本」；
- 其他状态不显示任何定稿入口；
- 二次确认：「定稿版本 N 会锁定当前正文；之后人工修订会重新进入待定稿。」；
- 成功：提示「章节已定稿，版本 N」、刷新并保持选中最新、状态徽标「已完成」，
  生成 / 采纳 / 恢复入口按状态关闭；
- 冲突：保留页面状态 + 「载入最新版本」；状态不允许：稳定文案 + 刷新章节状态。

### 20.8 未做

撤销定稿按钮、版本删除 / 覆盖、`final_version_id`、migration、
定稿后禁止 diff（diff 仍只读可用）。

### 20.9 定稿入口的前置条件（A1-4B-C-C-REV-01）

定稿锁定的是**数据库中的当前最新正式版本**，不包含编辑器里的未保存草稿。
因此「定稿最新版本」必须同时满足：

```
detail.chapter.status === 'in_review'
&& selectedVersion !== null
&& selectedVersion.id === versions[0].id      // 当前最新
&& editor === null                            // 编辑器未打开（含未修改）
&& !versionLoading                            // 未在读取其它版本
&& !restoring && !savingVersion && !finalizing
&& 详情与版本列表已加载
```

- `editor !== null`：不渲染按钮，显示「请先保存当前正文或关闭编辑器，再定稿。」
  （`data-testid="finalize-editor-hint"`），无论草稿是否有未保存修改；
- `versionLoading === true`：不渲染按钮也不显示历史版本提示 —— 此时
  `selectedVersion` 还是上一个版本，不能据此发起定稿；
- `requestFinalize` 内部重复以上全部判断（函数层防御，UI 之外无法绕过）；
- 保存编辑器成功后编辑器关闭、章节回到 `in_review`，入口按新版本重新出现；
- 放弃编辑器（无修改直接关闭 / 有修改确认放弃）后入口重新出现。

## 21. A2-A：章节连续性事实候选

> 定位：把「**已定稿**章节正文 + 当前设定摘要」变成**结构化候选**。
> 不自动写回人物 / 物品 / 势力 / 关系 / 境界，不创建实体；
> 不提供 HTTP API / UI / Worker 注册 / RAG / embedding。

### 21.1 事实类型（稳定白名单）

| factType | 必要字段 | 语义 |
| --- | --- | --- |
| `character_state` | `subjectId`（人物 id）、`summary`、`reason` | 人物状态变化 |
| `relationship_change` | `subjectId` + `objectId`（两个不同人物 id） | 关系变化 |
| `item_change` | `subjectId`（物品 id） | 持有人 / 状态变化 |
| `realm_progress` | `subjectId`（人物 id） | 境界变化 |
| `plot_thread` | `threadStatus`（`new` / `advanced` / `resolved`） | 线索 / 伏笔 / 未解决问题 |
| `location_change` | `subjectId`（人物 id）+ `name`（地点名） | 地点变化 |

约束：
- 所有引用必须来自上下文；**未知 id 直接拒绝**（不静默丢弃）；
- 地点允许未登记名称（规范化后 ≤120 字），但不得把地点名塞进 `subjectId`；
- `summary` / `reason` 必须非空（去空白后）且 ≤500 字；单次最多 50 条；
- 越界字段（例如 `character_state.name`）视为模型越界，直接拒绝；
- `{"facts": []}` 合法，表示本章没有可提取变化。

### 21.2 Agent

`continuity.extractor@1.0.0`（`packages/workflow/src/chapter/facts.ts`）：

- 输入：`work{id,title}` / `chapter{id,chapterNo,title}` / `sourceVersion{versionId,versionNo}`
  / `characters[]` / `items[]` / `realms[]` / `factions[]`（各含 `id,name,summary`）/ `chapterText`；
- 输出：严格 JSON `{ facts: [...] }`，先过 JSON Schema，再走代码语义校验；
- **正文只进入模型请求**：不写 run / 候选 / 审计 / 日志；
- `secret*` 属性永不进入摘要（`loadFactContext` 显式过滤）；
- 不调用 RAG、不生成 embedding；模型由 Provider 决定（`agent.model` 为空）。

### 21.3 数据表

```
chapter_fact_runs
  id, work_id, chapter_id, source_version_id,
  agent_name, agent_version, provider, model,
  status(running|succeeded|failed), error_code,
  created_at, started_at, attempt_token, finished_at
  UNIQUE(source_version_id)
  UNIQUE(id, source_version_id, chapter_id, work_id)

chapter_fact_candidates
  id, run_id, work_id, chapter_id, source_version_id,
  fact_type(白名单), payload(jsonb), status='candidate', created_at
  FK (run_id, source_version_id, chapter_id, work_id)
     → chapter_fact_runs(id, source_version_id, chapter_id, work_id)
```

- `attempt_token UUID NOT NULL DEFAULT gen_random_uuid()`：本次尝试的身份（fencing token）。
  新建时由数据库生成，`failed → running` **必须**轮换；
  只允许在该迁移中变化，`running → succeeded` 与 `succeeded` 之后都不可改；
- 归属：候选的 run 外键是**复合外键**，候选的 work / chapter / version 必须与它引用的
  run 完全一致。只用 `run_id` 单列外键时，候选可以挂在 run A 上却把三者指向另一个
  合法组合，数据库无法拒绝；现在这种组合直接被 `chapter_fact_candidates_run_fkey` 拒绝。
  另有独立的 `(chapter_id, work_id)` 与 `(source_version_id, chapter_id, work_id)`
  外键，保证三者本身也是有效组合；
- `started_at` 是**本次尝试**的开始时间，同时充当 running 租约的起点；
- `runs` 只允许受控更新（`running → succeeded/failed`、`failed → running`），
  归属 / Agent 身份 / `created_at` 不可变；`provider` / `model` 只允许在 `running`
  期间（记录本次实际模型）或重试开始时更新；`started_at` 只允许在重试开始时刷新；
  成功后不可再改、不可删除；
- `candidates` append-only（UPDATE / DELETE 一律拒绝）；
- 测试清理沿用 `DISABLE TRIGGER USER` 受控策略。

### 21.4 幂等、并发、running 租约与 attempt fencing

```
runWorkWrite（作品锁）
  → 归属 / 定稿 / 最新版本校验
  → 已有 succeeded run？→ 返回既有 run + 候选（created=false，不写审计）
  → 已有 running run？
      · started_at 未超出租约（10 分钟）→ 409 CONTINUITY_EXTRACTION_IN_PROGRESS
      · 已超出租约（进程崩溃）→ CAS 接管：标 failed 再复用同一行 running
  → 已有 failed run？→ 复用同一行置回 running（轮换 attempt_token，刷新 started_at
                       与本次 provider/model）
  → 否则插入 running（attempt_token 由数据库 gen_random_uuid() 生成）
（锁外调用模型）
runWorkWrite（作品锁）
  → 提交阶段二次校验（见 21.5）
  → 校验 attempt_token 仍是 run 的当前 attempt
  → 写候选 + run succeeded（带 token 的 CAS）+ 审计（同一事务）
```

**双层 fencing**：

| 层 | 作用 | 失效表现 |
| --- | --- | --- |
| 租约 `started_at` | 决定**什么时候允许接管** | 未到期 → 409 `IN_PROGRESS`；到期 → 后来的请求可接管 |
| `attempt_token` | 决定**谁的写入有效** | token 不匹配 → 409 `CONTINUITY_EXTRACTION_LEASE_LOST` |

- **租约过期只触发接管，不保证旧进程立即停止**：旧 attempt 的模型调用可能仍在运行、
  稍后才返回。此时它的成功结果会被 token 校验拒绝（不写候选、不写审计、
  不覆盖 provider / model、不标记 succeeded），失败也不会把新 attempt 标成 failed；
- 成功写入是 CAS：`WHERE id = ? AND status = 'running' AND attempt_token = ?`，
  更新数必须为 1，否则整个事务回滚并返回 `LEASE_LOST`；
- 失败标记同样是 CAS：旧 attempt 的 `markRunFailed` 影响 0 行时**不覆盖任何新 attempt**，
  调用方返回 `LEASE_LOST`（写库异常时保留原始错误，run 由租约兜底）；
- token 轮换由数据库生成（`gen_random_uuid()`），调用方无法把旧值写回去；
  触发器要求 `failed → running` **必须**轮换，`running → succeeded` 与 `succeeded`
  之后都不可变；
- `UNIQUE(source_version_id)` 兜底"同一版本只有一个 run"；`succeeded` 永远不被接管；
- 失败不写候选；失败 run 可重试（复用同一行，不产生第二条）；
- 正文不落库，候选 `payload` 只含结构化字段。

### 21.5 提交阶段二次校验

模型调用可能耗时数十秒，期间作者完全可以保存新 revision（章节回到 `in_review`
并产生更新的版本）。因此**提交事务内必须重新读取并校验**：

```
chapter 属于当前 work
run.workId / chapterId / sourceVersionId 与本次调用一致
当前最大 chapterVersion.id === run.sourceVersionId   → 否则 CONTINUITY_SOURCE_VERSION_STALE
chapter.status === 'finalized'                      → 否则 CONTINUITY_CHAPTER_NOT_FINALIZED
```

- 先判版本、再判定稿：新 revision 会同时造成两者，此时"版本过期"是更具体、
  更可操作的错误；
- 任一校验失败 → **事务内不插入任何候选、不写成功审计**，整体回滚；
- 回滚后把 run 标记为 `failed`（带对应 `error_code`），保留可重试语义；
- 新版本重新定稿后再次提取会创建**新的 run**（`source_version_id` 不同），
  旧 run 保持 failed，不会被覆盖。

### 21.6 审计

`continuity.facts_extracted`，detail 只允许 10 个字段：
`workId / chapterId / sourceVersionId / runId / agentName / agentVersion /
provider / model / factCount / factTypeCounts`。
不含正文、prompt、模型原始响应、secret 或 Key。

- `provider` / `model` 记录的是**本次实际成功**的值（`AgentRunResult.provider/model`），
  不是第一次失败 attempt 的配置，也不一定是 `defaultModel`（Provider 可能路由 / 降级）；
- `finished_at` / `started_at` 全部使用数据库 `clock_timestamp()`，
  避免应用与数据库的时钟 / 时区偏移。

### 21.7 上下文截断规则

`loadFactContext` **按类型分别查询**，而不是"一次全局 take 再按类型切"：

| 类型 | 上限 | 顺序 |
| --- | --- | --- |
| `character` | 100 | `orderIndex asc → createdAt asc → id asc` |
| `item` | 100 | 同上 |
| `realm_level` | 100 | 同上 |
| `faction` | 100 | 同上 |

全局 take 会让大量人物把物品 / 势力整类挤掉；按类型查询后每类都有独立预算，
整体上限仍是 400 条（不会无界），且同一份数据每次得到完全相同的上下文。

### 21.8 错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `CONTINUITY_CHAPTER_NOT_FINALIZED` | 409 | 章节未定稿（或无正式版本，含提交时已不再是定稿） |
| `CONTINUITY_SOURCE_VERSION_STALE` | 409 | 指定版本不是当前最新（含模型调用期间产生的 new revision） |
| `CONTINUITY_EXTRACTION_IN_PROGRESS` | 409 | 同版本已有进行中的提取（租约未到期） |
| `CONTINUITY_EXTRACTION_LEASE_LOST` | 409 | 本次尝试已被新尝试接管，结果被丢弃（不写候选 / 审计） |
| `CONTINUITY_FACTS_INVALID` | 422 | 模型输出不合法（**不可重试**，不写候选） |
| `CONTINUITY_EXTRACTION_FAILED` | 502 | Provider / 内部失败（可重试） |

### 21.9 未做

HTTP API、候选审阅 / 采纳 UI、Worker 常驻注册、事实写回人物/物品/势力/关系/境界、
冲突检测、RAG / embedding / 图谱、自动修改任何实体。

## 22. A2-B：连续性事实 API

> 在 `extractChapterFacts` 与候选存储之上只加**作者 API 与只读模型**：
> 不新增 migration、不做 UI、不自动采纳、不写回实体、不注册 Worker。

### 22.1 路由

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| POST | `/api/works/:workId/chapters/:chapterId/facts/extract` | 手动触发当前定稿版本的事实提取 |
| GET | `/api/works/:workId/chapters/:chapterId/facts?factType=` | 候选列表（只读） |
| GET | `/api/works/:workId/chapters/:chapterId/facts/:candidateId` | 候选详情 + run 安全元信息 |
| GET | `/api/works/:workId/chapters/:chapterId/fact-runs/:runId` | 一次提取运行的状态 |

- POST 校验 Origin；三个 GET 不校验 Origin；
- 未登录 401、管理员 403、他人作品 / 跨章节 / 随机 id 404；
- 路由注册在章节下，与版本 / 定稿接口共用 `requireAuthorSession` 与 `requireOwnedWork`。

### 22.2 提取请求与响应

请求体严格白名单：只有 `sourceVersionId`（必须显式出现，不允许 null）。

```jsonc
// 201 created=true（首次）/ 200 created=false（同版本幂等命中）
{
  "extraction": {
    "runId": "…",
    "created": true,
    "sourceVersionId": "…",
    "sourceVersionNo": 5,
    "agentName": "continuity.extractor",
    "agentVersion": "1.0.0",
    "provider": "…",
    "model": "…",
    "factCount": 3,
    "factTypeCounts": { "character_state": 1, "plot_thread": 2 }
  }
}
```

**不返回**：正文、prompt、模型原始响应、`attemptToken`、数据库错误、其它作品实体。

状态码：

| 情况 | 状态 / 错误码 |
| --- | --- |
| 首次提取 | 201 `created=true` |
| 同版本已有成功 run | 200 `created=false`（不新增候选与审计，不再调用模型） |
| 章节未定稿 / 无版本 | 409 `CONTINUITY_CHAPTER_NOT_FINALIZED` |
| `sourceVersionId` 不是当前最新 | 409 `CONTINUITY_SOURCE_VERSION_STALE` |
| 同版本正在提取（租约未到期） | 409 `CONTINUITY_EXTRACTION_IN_PROGRESS` |
| 本次 attempt 已被接管 | 409 `CONTINUITY_EXTRACTION_LEASE_LOST` |
| Provider / 内部失败 | 502 `CONTINUITY_EXTRACTION_FAILED` |
| 模型输出不合法 | 422 `CONTINUITY_FACTS_INVALID` |
| 未知字段 / null / 非法 UUID / 异常 query | 400 `VALIDATION_FAILED` |
| 缺 Origin | 403 |
| 未登录 / 管理员 / 他人作品 | 401 / 403 / 404 |

### 22.3 候选列表

- 只返回**成功 run** 的候选；默认 `createdAt desc → id desc`；
- `factType` 可选，取值必须是六类之一；其它 query / 重复传参 / 空值 → 400；
- 硬上限 `MAX_CHAPTER_FACT_LIST = 200`；被截断时 `truncated=true` 且 `total` 是过滤后的完整数量
  （**不静默截断**）；
- 每条只含 `id / runId / sourceVersionId / sourceVersionNo / factType / summary / reason /
  subjectId / objectId / name / threadStatus / createdAt`。

### 22.4 候选详情与 run 状态

- 候选必须同时属于该作品与该章节，否则 404；
- 详情返回 `{ fact, run }`：`run` 只含 `runId / sourceVersionId / sourceVersionNo / status /
  agentName / agentVersion / provider / model / errorCode / factCount / createdAt / startedAt / finishedAt`；
- `errorCode` 只回显**稳定码**（`CONTINUITY_*`），其它值一律 `null`；
- run 状态接口不返回 `deduplicated`（那是提取响应的语义）、`attemptToken`、原始错误消息。

### 22.5 服务层

| 函数 | 说明 |
| --- | --- |
| `listChapterFacts` | 归属校验 + 过滤 + 计数 + 版本号关联，返回 `{ facts, total, truncated }` |
| `getChapterFactCandidate` | 归属 + 作品 / 章节双重过滤，返回 `{ fact, run }` |
| `getChapterFactRun` | 归属 + 作品 / 章节双重过滤，返回运行状态 |

- 全部复用 `requireOwnedWork` 与 `requireChapterInWork`，不复制归属逻辑；
- 显式构造 DTO（不把 Prisma row 直接交给 HTTP）；
- **只读**：不写审计、不改 run / candidate；
- `sourceVersionNo` 通过 `chapter_versions` 关联读取（候选与 run 只存版本 id）。

### 22.6 Provider 解析

`apps/web/src/fact-provider.ts`：

- 生产：`createModelProviderFromEnv()`（与 Worker 完全一致的 `MODEL_PROVIDER` 等变量）；
- 测试：`setChapterFactProvider()` 注入确定性替身，`null` 复原。

### 22.7 未做

候选列表 / 采纳 UI、事实采纳与拒绝、写回人物 / 物品 / 势力 / 关系 / 境界、
冲突检测、批量提取、Worker 常驻任务、RAG / embedding / 图谱。

### 22.8 默认 Mock 与配置错误（A2-B-REV-01）

**Mock 模式必须能跑通提取**：通用 `MockProvider` 的默认输出是 `{ok:true}`，
过不了 `factOutputSchema`（`MODEL_PROVIDER=mock` 是默认值，本地与 CI 都不联网）。
因此 `createChapterFactProviderFromEnv()` 在 mock 分支使用
`createContinuityFactsMockProvider()`：

- 固定输出 `{"facts": []}`（对任意章节 / 实体上下文都合法，表示"本章无变化"）；
- 身份仍是 `name=mock / defaultModel=mock-model`；
- 不联网、不读 Key、不读系统时钟。

`setChapterFactProvider()` 仍可注入替身，优先级高于环境变量。

**配置错误的稳定映射**：`readProviderConfig` / `OpenAICompatibleProvider` 构造会抛
`ModelProviderError`（`MODEL_NOT_CONFIGURED`）。Provider 在**任何数据库事务之前**创建，
因此 `chapterFactProvider()` 在构造边界把它映射为
502 `CONTINUITY_EXTRACTION_FAILED`：

- 不建 run、不写候选、不写成功审计；
- 不回显 Key、Base URL、环境变量名或底层异常文案；
- 生产路径不把 Provider 构造塞进事务（否则配置错误会变成事务内异常）。

### 22.9 列表统计与集合的快照一致性

`listChapterFacts` 用**一条 SQL** 同时取行与总数，而不是 `count()` + `findMany()`：

```sql
SELECT c.id, c.run_id, c.source_version_id, c.fact_type, c.payload, c.created_at,
       COUNT(*) OVER() AS total
FROM chapter_fact_candidates c
JOIN chapter_fact_runs r ON r.id = c.run_id
WHERE c.work_id = $1::uuid AND c.chapter_id = $2::uuid
  [AND c.fact_type = $3]
  AND r.status = 'succeeded'
ORDER BY c.created_at DESC, c.id DESC
LIMIT 200
```

- `COUNT(*) OVER()` 在 LIMIT **之前**计算，`total` 是过滤后的完整数量；
- 窗口计数与返回集合来自同一语句、同一快照：不会出现 `total < facts.length`；
- 空结果没有窗口行 → `total = 0`；
- `truncated = total > facts.length`；
- 全部参数化（work / chapter / fact_type / limit），不拼接用户输入；
- 仍只读，不写审计、不改任何表。

## 23. A2-C-A：Reviewer Agent 契约（已验收，CI #24）

> 本轮只建立 Agent 契约、语义校验、Mock 和纯单测。
> **没有接入 `chapter.draft`**，不写数据库，不新增 API / UI / Worker，
> 不自动重写正文，也不自动阻止作者采纳。

### 23.1 Agent

`reviewer.chapter@1.0.0`（`packages/workflow/src/chapter/reviewer.ts`）：

- 输入：`chapter{id,chapterNo,title}`、冻结合同
  `{goal,mustInclude,mustNotInclude,scenes[]}`、`draft`、
  `characters[] / items[] / realms[] / factions[]`、`priorSummaries[]`；
- 实体只含 `{id,name,summary}`，id 必须是 UUID；不传 `secret` / `secretKnownBy`；
- `draft ≤ 200000` 字符；四类实体各 ≤100 条；前章摘要 ≤20 条、每条 ≤1000 字符；
- 顶层和嵌套对象都拒绝未声明字段（prompt、原始响应、Key 等不会进入契约）；
- `agent.model` 为空，由 Provider 决定实际模型。

### 23.2 输出与语义校验

```json
{
  "passed": false,
  "issues": [
    {
      "severity": "high",
      "type": "setting_contradiction",
      "evidence": "正文中的原句",
      "suggestion": "修改建议"
    }
  ]
}
```

- `issues ≤ 20`；severity 只允许 `high / medium / low`；
- type 只允许：
  `contract_violation / setting_contradiction / timeline_conflict /
  item_state_conflict / plot_thread_conflict / character_consistency / prose_quality`；
- evidence / suggestion trim 后非空；evidence ≤300、suggestion ≤500；
- evidence trim 后必须是本次 `draft` 的连续子串，防止模型编造引文；
- `passed` 必须严格等于 `issues.length === 0`；
- 重复 `type + evidence` 直接拒绝；不在本阶段静默去重或修复；
- 所有失败统一为 `AGENT_OUTPUT_INVALID`，错误只带路径 / 固定原因，
  不含正文、引文、建议、prompt 或原始响应。

`runChapterReviewer()` 是纯内存包装：先经 `AgentRunner` 做输入 / Schema 校验，
再强制调用专用语义校验；不记录日志、不写数据库、不决定下一步。

### 23.3 专用 Mock

`createChapterReviewerMockProvider()`：

- `name=mock`、`defaultModel=mock-model`；
- 默认输出 `{"passed":true,"issues":[]}`；
- 可通过 `issues` 构造参数注入固定问题；
- 不联网、不读 Key、不读系统时钟；通用 `MockProvider` 未被修改。

### 23.4 未做

Writer 后自动运行、Reviewer run / issue 持久化、HTTP API、UI、采纳门禁、
作者手动重检、失败回滚策略、RAG / embedding。

## 24. A2-C-B：Reviewer 候选审阅执行与持久化

> 把 `reviewer.chapter@1.0.0` 接入受工作流控制的候选审阅：
> 独立 `chapter.review` 任务、候选保存后同事务入队、run / issue 落库。
> **不提供**检查结果 API / UI / 自动重写 / 采纳门禁 / 人工重检。

### 24.1 任务与自动入队

```
persist_candidate（chapter.draft 的最后一步）
  └─ runWorkWrite（作品锁）内同一事务
       ├─ 写入 chapter_candidates
       ├─ chapter.status → in_review + 审计 chapter.candidate_created
       └─ ensureReviewTask：request_id = review:<candidateId>，input = { candidateId }
```

- `chapter.draft` 与 `chapter.review` 是**两个任务**：Writer 候选保存成功后正文任务
  正常 `succeeded`；Reviewer 失败只影响 review task / run；
- `input_snapshot` 只有 `{ candidateId }`，requestId 确定性（总长 43 ≤ 128），
  `input_hash` 复用现有 canonical JSON / request hash；
- `provider / model` 取 Worker 当前配置与 `runner.resolveModel(REVIEWER_CHAPTER_AGENT)`
  （`agent.model` 为空 → `defaultModel`）；
- `maxAttempts` 用现有默认值（3），不另造重试机制；
- 幂等：候选已存在但 review task 缺失（崩溃恢复）→ 同一事务补齐；
  任务已存在且 `input_hash` 相同 → 不重复创建；
- 不允许"先提交候选、再另开事务入队"。

作者读接口（章节详情 / 列表）**只**展示 `chapter.draft` 任务：
`chapter.review` 是内部任务，不能成为"最新正文任务"而改变既有页面。

### 24.2 固定三步

```
load_review_input → run_reviewer → persist_review_result
```

| 步骤 | 职责 |
| --- | --- |
| `load_review_input` | 锁 review task 并确认 Worker 所有权；解析输入；读取候选 / 合同 / 安全上下文；创建或复用 run 并置 `running`；写 `task_contexts` |
| `run_reviewer` | 调 `reviewer.chapter@1.0.0`；运行 `validateReviewerOutput`；每次实际调用写一条 `llm_call_logs` |
| `persist_review_result` | `runWorkWrite` + 任务行锁 / fence；同一事务写 issues 与 run 终态（`passed / issue_count / finished_at`） |

复用 semantics：

- 已有 `succeeded` run → 记录"无需再调用模型"，后续两步跳过（不重复插 issue）；
- 已有 `failed` run → 复用同一行置回 `running`（刷新 `started_at` 与本次 provider / model）；
- 已有 `running` run 但任务被重新领取（上一 attempt 失去租约）→ 先标 `failed`
  （`TASK_LEASE_LOST`）再复用同一行，不产生第二条。

### 24.3 数据表

`chapter_review_runs` / `chapter_review_issues`：字段、复合外键、CHECK 与触发器
见 `docs/03-data-model.md` §3.12。要点：

- `UNIQUE(candidate_id)` + `UNIQUE(generation_task_id)`；
- issue 的 `(run_id, candidate_id, chapter_id, work_id)` 是**复合外键**；
- issues append-only；只有 `running` run 可 INSERT，进入 `succeeded / failed`
  终态后不能再追加；run 成功后不可改、不可删；
- 表里没有正文副本 / prompt / 模型原始响应 / 密钥列。

### 24.4 失败隔离与重试

- Provider / Agent / 语义失败：**仍持有任务 fence 时**把 run 标 `failed` 并保存稳定
  `error_code`（`MODEL_*` / `AGENT_OUTPUT_INVALID` / `TASK_INPUT_INVALID`），
  再按现有错误分类抛出（Provider 网络错误可重试）；
- 失败**不修改**候选、合同、章节、采纳状态与 draft 任务；
- `TASK_LEASE_LOST`、取消检查等控制层错误继续抛出，不被失败标记吞掉；
- 任务重试复用同一个 run（`failed → running`），不新建第二行、不重复 issue；
- 取消 / 重试用尽：任务进入 `cancelled / failed` 时，数据库触发器
  `generation_tasks_close_review_run` 把仍在 `running` 的 run 标 `failed`，
  不留下永久 running；
- 旧 Worker、丢租约、取消后晚返回：写入前 `SELECT ... FOR UPDATE` 锁任务行并校验
  `locked_by / status / cancel_requested_at`，任一不符抛 `TASK_LEASE_LOST`，
  问题与 run 都不会被写入或覆盖；
- review 成功 / 失败均**不写** `audit_logs`：run、issues 与 `llm_call_logs` 就是审阅记录。

### 24.5 上下文与数据边界

- `chapter`：候选所属章节（**定稿后仍可审阅**；review 不修改章节状态）；
- `contract`：候选的不可变冻结合同（`goal / mustInclude / mustNotInclude / scenes`）；
- `draft`：`chapter_candidates.content`，只进入本次模型请求；
- `characters / items / realms / factions`：同作品未删除实体，每类最多 100 条，
  顺序固定 `orderIndex asc → createdAt asc → id asc`，`secret*` 永不进入；
- `priorSummaries`：由 A2-D-C 接线，只取「同作品 + 前序章节 + 当前 finalized +
  摘要对应当前最新正式版本」的摘要；见 §27；
- 候选即使已被采纳仍可读取与审阅；candidate / contract / chapter / work 必须全部匹配，
  跨作品直接拒绝；
- `task_contexts` 只记章节 / 合同 / 候选的 id 与安全摘要（字数、场景数），
  **不记** draft、evidence、prompt 或模型响应。

### 24.6 Worker 与 Mock

- `apps/worker/src/runtime.ts` 注册 `chapter.review`，仍只构造一次 Provider；
- `createChapterMockProvider()` 增加 `reviewer.chapter` 分派：默认
  `{ "passed": true, "issues": [] }`；通用 `MockProvider` 未改动；
- 测试夹具按 system prompt 分派 planner / writer / reviewer，并记录 Reviewer 实际输入。

### 24.7 未做

检查结果读取 API、前端展示、high severity 采纳门禁、自动重写 / 自动重试 Writer、
人工重新检查、Summarizer（`priorSummaries` 仍为空）、RAG / embedding / 图谱。

## 25. A2-D-A：Summarizer Agent 契约

> 只建立 `summarizer.chapter@1.0.0` 的输入 / 输出契约、代码语义校验、专用 Mock 与纯单测。
> **不接数据库、不接工作流、不接 API / UI / Worker**；定稿校验、幂等、租约与落库属于 A2-D-B。

### 25.1 输入契约

```json
{
  "chapter": { "id": "uuid", "chapterNo": 1, "title": "章节标题" },
  "sourceVersion": { "id": "uuid", "versionNo": 1 },
  "chapterText": "正式定稿正文"
}
```

- `chapter.id` / `sourceVersion.id` 必须是 UUID；
- `chapterNo` / `versionNo` 是 1..100000 的整数；
- `chapter.title` 1..200 字符，且 **trim 后非空**（Schema 的 `minLength` 挡不住纯空白，
  由 `assertSummarizerInput` 在代码侧拒绝，错误路径 `$.chapter.title`）；
- `chapterText` 1..200000 字符；
- 顶层与嵌套对象都拒绝未声明字段：`prompt`、`secret`、`secretKnownBy`、
  模型原始响应、API Key 无法进入契约；
- `sourceVersion` 只是**追溯标识**：Agent 不判断"是否定稿、是否最新版本"。

### 25.2 输出契约

```json
{ "summary": "本章摘要" }
```

- 只允许 `summary`，未知字段拒绝；
- Schema 上限 1000 字符；代码在 `trim()` 后再次确认非空、≤1000；
- 拒绝 Markdown 标题（行首 `#`）与代码块围栏（连续三个反引号）：它们是格式残留，
  不是摘要内容；
- 保留中文、emoji 与换行；首尾空白被去掉后再落库；
- 摘要应覆盖本章关键事件、人物状态变化、重要物品 / 关系 / 境界变化、未解决线索，
  没有的类别不编造；
- 错误只返回路径与固定原因，不回显正文或摘要内容；
- 所有失败统一为稳定 `AGENT_OUTPUT_INVALID`（输入问题为 `AGENT_INPUT_INVALID`）。

### 25.3 Agent、Mock 与运行入口

- `summarizer.chapter@1.0.0`：`model` 为空由 Provider 决定，`maxOutputTokens = 2048`，
  role prompt 明确"只摘要、不续写、不改写正文、不输出多个方案"；
- `createChapterSummarizerMockProvider({ summary? })`：`name=mock`、`defaultModel=mock-model`，
  默认输出确定、合法、非空，不联网 / 不读 Key / 不读系统时钟；通用 `MockProvider` 未改动；
- `runChapterSummarizer()` 是纯内存包装：先 `assertSummarizerInput`（Schema + 标题 trim），
  再 `AgentRunner`（Schema + Provider 调用），最后强制 `validateSummarizerOutput`；
  不写日志、不写数据库、不决定下一步。

### 25.4 未做

`chapter_summaries` 表 / migration、定稿版本查询与幂等、租约 / attempt fencing、
`chapter.summarize` 任务与 Worker 注册、Reviewer `priorSummaries` 接线、API / UI、
RAG / embedding / 图谱、摘要回写章节或正式版本。

## 26. A2-D-B：定稿章节摘要任务与持久化

> 把 `summarizer.chapter@1.0.0` 接入受工作流约束的后端：定稿同事务入队
> `chapter.summarize`、按 `sourceVersionId` 幂等落库。**不接** Reviewer
> `priorSummaries`，不做 API / UI。

### 26.1 任务与自动入队

```
finalizeChapter（作品锁 + 章节行锁，同一事务）
  ├─ chapters.status → finalized
  ├─ audit chapter.finalized
  └─ ensureSummaryTask：request_id = summary:<sourceVersionId>
       input_snapshot = { sourceVersionId }
```

- `chapter.summarize` 任务输入只允许 `sourceVersionId`（UUID）；
  未知字段 / 非 UUID / 缺字段一律 `TASK_INPUT_INVALID`；
- `provider / model` 由 **finalize API 在服务端**按 `readProviderConfig()` 与
  Provider 构造结果解析后传入 `finalizeChapter`；请求体仍不得提交，
  事务内不读环境；HTTP 响应字段不变；
- `maxAttempts` 用默认值；`input_hash` 复用现有 canonical JSON / request hash；
- 幂等：首次定稿创建；已定稿同版本重复定稿不重复创建；任务缺失时（崩溃恢复）
  由幂等定稿补齐；不使用"先 INSERT 再处理唯一冲突"的写法；
- 作者侧章节详情 / 列表仍只展示 `chapter.draft`，`chapter.summarize` 不会成为
  "最新正文任务"。

### 26.2 固定三步

```
load_summary_input → summarize_chapter → persist_summary
```

| 步骤 | 职责 |
| --- | --- |
| `load_summary_input` | 锁任务行 + fence；解析 `sourceVersionId`；校验章节 `finalized` 且该版本是最新正式版本；已有同版本摘要 → 标记 skip；写 `task_contexts`（章节 / 版本 id、版本号、字数） |
| `summarize_chapter` | 调 `summarizer.chapter@1.0.0`；运行 `assertSummarizerInput` + `validateSummarizerOutput`；每次实际调用写一条 `llm_call_logs` |
| `persist_summary` | `runWorkWrite` + 任务行锁 / fence；同一事务内**再次**校验定稿与最新版本；写 `chapter_summaries` |

- skip 分支：已有同版本摘要时不调用模型、不写日志、不重复插入；
- 失败 / 取消：不修改章节、正式版本、候选、合同或采纳权；不写 `audit_logs`；
- 控制层错误（`TASK_LEASE_LOST`、取消检查）原样向上抛。

### 26.3 幂等与 stale 规则

| 场景 | 结果 |
| --- | --- |
| 同一 `sourceVersionId` 重复定稿 | 复用同一 task，不重复摘要 |
| 已定稿但任务缺失 | 幂等定稿补齐任务 |
| 章节已不是 `finalized`（人工 revision / 放弃） | `SUMMARY_CHAPTER_NOT_FINALIZED`（不可重试） |
| `sourceVersionId` 已不是最新版本 | `SUMMARY_SOURCE_VERSION_STALE`（不可重试） |
| 模型调用期间发生 revision | 提交阶段重新校验 → stale，**不写摘要** |
| 旧 Worker 晚返回 / 丢租约 | 任务行 fence 拒绝，摘要不被写入或覆盖 |
| 已有同版本摘要的新任务 | skip，模型调用数为 0 |

- 先判版本、再判定稿：新 revision 会同时造成两者，此时"版本过期"是更具体、
  更可操作的错误；
- 任务重试复用同一个 task（`attempt_count` 递增），成功只写一条摘要。

### 26.4 数据边界

- 正文只来自 `chapter_versions.content`，只进入模型请求；
  不进入任务快照、`task_contexts`、`llm_call_logs` 或摘要行；
- 摘要行只有 `summary` 文本与 agent / provider / model 元数据；
- 表定义与约束见 `docs/03-data-model.md` §3.13。

### 26.5 模型配置不可用时不阻断定稿（A2-D-B-REV-01）

摘要只是派生数据，**不得让模型配置问题阻断作者定稿**。

- finalize 路由对 summary spec 做 **best-effort 解析**：`readProviderConfig()` +
  Provider 构造成功 → `{ provider, model }`；抛 `MODEL_NOT_CONFIGURED`
  （缺 Base URL / Key / 模型名、地址非法）→ 返回 `null`；
  其它异常照常向上抛；
- `summary === null` 时：首次定稿照常写章节状态与审计，只是**跳过**摘要任务；
  已定稿幂等返回不创建任务；`summaryTaskId` 为 `null`；
- **不伪造 provider / model 占位值**（那会生成永远无法执行的脏任务），
  不构造模型请求、不联网、不读取 Key，错误不进响应、日志或审计；
- HTTP 请求 / 响应字段完全不变，不暴露配置错误；
- 配置恢复后，作者对同一版本再次调用**幂等 finalize** 才会补任务
  （本轮不提供手动重建接口）。

**配置漂移下的幂等**：确定性内部任务按「requestId + taskType + chapterId +
inputSnapshot」判断是否同一逻辑任务，**不再比较 `input_hash`**
（`input_hash` 覆盖 provider / model，配置一变就不同）。因此：

- 已有 task 时，即使当前 provider / model 与旧 task 不同，也复用既有 task；
- 不覆盖旧 provider / model、不新建第二行、不让 finalize 失败；
- 旧 task 是否可执行仍由 **Worker 的 provider / model 预检**决定
  （`TASK_MODEL_CONFIG_MISMATCH`），finalize 不会静默改写 task；
- 只有逻辑输入（sourceVersionId / chapter / taskType）不一致才按内部错误拒绝；
- 该规则只用于确定性内部任务，作者显式生成的 `chapter.draft` 仍走
  `TASK_REQUEST_CONFLICT` 语义。

### 26.6 未做

Reviewer `priorSummaries` 接线、摘要读取 API / UI、摘要回写章节或正文、
high severity 采纳门禁、自动重写、RAG / embedding / 图谱。

## 27. A2-D-C：Reviewer 前章摘要接线

> 审阅当前章节候选时，为 Reviewer 提供**同作品、前序、当前仍定稿且摘要对应当前
> 最新正式版本**的章节摘要。缺失时为空数组：不猜测、不用正文临时生成、不跨作品补全。

### 27.1 选择规则（固定）

| 条件 | 说明 |
| --- | --- |
| `chapter_no < 当前章 chapterNo` | 不含当前章自己的摘要，也不含未来章节 |
| `chapters.status = 'finalized'` | 前章人工 revision 后（回到 `in_review`）旧摘要立即失效 |
| `summary.source_version_id = 该章当前最新正式版本` | 重新定稿后只有新版本摘要可见 |
| 同作品（显式 `work_id`） | 不跨作品 |
| 每章最多一条 | `UNIQUE(source_version_id)` + 最新版本条件共同保证 |
| 最近 20 章 | 按 `chapter_no DESC` 取 20 条，再反转为**升序**放入 `priorSummaries` |

实现：`buildChapterReviewContext` 内的 `loadPriorSummaries()`，一条 SQL 完成
「chapters JOIN chapter_summaries + 最新版本子查询」，不使用 N+1 查询。

### 27.2 数据边界

- `priorSummaries` 每条 `{ chapterNo, summary }`；summary 已由 A2-D-A / 数据库 CHECK
  保证 1..1000 字，Reviewer 输入 Schema 上限 20 条；
- `task_contexts` 新增 `chapter_summary` 来源：只记 `summary id` 与 `第N章摘要`，
  **不复制摘要正文**；rank 10..29，不影响实体来源（100+）；
- 不读取 `secret*`、不读取正文来填充缺失摘要；
- 没有摘要时数组为 `[]`，Reviewer 照常运行。

### 27.3 未做

摘要读取 API / UI、事实 UI、RAG / embedding / 图谱、摘要回写正文、
high severity 采纳门禁。

## 28. A2-C-D：Reviewer 结果只读 API

> 让作者能读到候选对应的 `chapter.review` 任务状态、review run 与 issues。
> **只读**：不触发审阅、不重试、不采纳、不写审计，也不修改 task / run / issue。
> 本轮**不做** UI、手动重检、采纳门禁、摘要读取接口。

### 28.1 接口

```text
GET /api/works/:workId/chapters/:chapterId/candidates/:candidateId/review
```

```json
{
  "review": {
    "candidateId": "uuid",
    "task": {
      "id": "uuid",
      "status": "queued | processing | succeeded | failed | cancelled",
      "currentStep": "load_review_input | run_reviewer | persist_review_result | null",
      "attemptCount": 1,
      "errorCode": "STABLE_CODE | null"
    },
    "run": {
      "id": "uuid",
      "status": "running | succeeded | failed",
      "passed": true,
      "issueCount": 1,
      "errorCode": null,
      "agentName": "reviewer.chapter",
      "agentVersion": "1.0.0",
      "startedAt": "ISO-8601",
      "finishedAt": "ISO-8601",
      "issues": [
        {
          "id": "uuid",
          "ordinal": 0,
          "severity": "high",
          "type": "setting_contradiction",
          "evidence": "正文原句",
          "suggestion": "修改建议"
        }
      ]
    }
  }
}
```

- `run = null`：任务已入队但审阅尚未开始，前端可安全轮询；
- `run.status = running`：`passed = null`、`issues = []`、`finishedAt = null`；
- `run.status = failed`：`passed = null`、`issues = []`，`errorCode` 为稳定码
  （含 `MODEL_*` / `AGENT_*` / `TASK_*` / `TASK_CANCELLED`）；
- `issues` 按 `ordinal` 升序，最多 20 条（与 `reviewer.chapter` 输出上限一致）；
- 响应头 `Cache-Control: no-store`（沿用 `authJson`）。

### 28.2 查询、一致性与 404 语义

实现：`packages/workflow/src/chapter/review-read.ts` 的 `getChapterReviewForAuthor`。

1. `requireOwnedWork`（会话里的作者 id）→ 他人作品 404 `NOT_FOUND`；
2. `requireChapterInWork` → 章节不属于作品 404 `NOT_FOUND`；
3. **同一 RepeatableRead 事务**内读候选、任务、run、issues，避免
   "task 已 succeeded、run 还是上一 attempt 的 running" 这类跨快照组合；
4. 候选与任务定位：
   - 候选必须 `(id, work_id, chapter_id)` 全匹配；
   - 任务必须 `work_id + chapter_id + task_type='chapter.review' + requestId='review:<candidateId>'`；
   - 任务快照里的 `candidateId` 必须与路径一致（作者可提交任意 `requestId`，
     只按 requestId 认领会把 `chapter.draft` 任务当成审阅任务）；
   - run 必须 `candidate_id + generation_task_id + work_id + chapter_id` 全匹配。
5. 任一不满足 → 统一 404 `REVIEW_NOT_FOUND`，不区分"不存在"与"不是你的"。

### 28.3 字段边界

- 只回显：任务 id / 状态 / 步骤 / 次数 / 稳定错误码；run 状态 / 结论 / 计数 /
  Agent 身份 / 起止时间 / 问题列表；
- **不返回**：正文全文、prompt、模型原始响应、`provider` / `model`、
  `inputSnapshot` / `inputHash` / `requestId`、`lockedBy` / `leaseUntil`、
  `attemptToken`；
- `currentStep` 只回显本章工作流的三步之一，未知值收敛为 `null`；
- `errorCode` 走白名单（`STABLE_REVIEW_ERROR_CODES`），历史 / 内部值收敛为 `null`；
- `evidence` 是问题证据本身，按已落库内容原样返回；不是正文副本。

### 28.4 前端

`apps/web/src/lib/chapter-review-view.ts` + `fetchChapterReview()`：

- 严格解析：字段缺失、状态未知、`passed` 与 `status` 不自洽、
  `issueCount ≠ issues.length`、ordinal 非升序、时间戳不可解析 → 整份拒绝；
- 解析失败收敛为 `ApiError('INTERNAL_ERROR')`，不展示半截审阅结果；
- 404 保留 `REVIEW_NOT_FOUND`，文案"该候选还没有审阅结果"；
- **只读接口不做 Origin 校验**（与章节 / 候选 / 事实的只读 GET 一致）：
  同源 `fetch` 不会带 Origin，要求 Origin 反而会让轮询失败。写接口仍强制 Origin。

### 28.5 未做

Reviewer UI（问题列表 / 严重度筛选 / 采纳前确认）、手动重检 / 重试 / 取消、
high severity 采纳门禁、摘要读取 API / UI、事实 UI、migration、RAG / 图谱。

## 29. A2-C-E：Reviewer 结果展示 UI

> 在章节工作台的候选面板里展示审阅状态与结构化问题。
> **只读展示**：不改后端、不改 review 数据、不加手动重检、不加采纳门禁。

### 29.1 数据流

```
点击候选「预览」
  ├─ GET /candidates/:candidateId            （正文，既有）
  └─ GET /candidates/:candidateId/review     （审阅，A2-C-D）
       ├─ queued / processing / run.running → 轮询（1s → 2s → 5s）
       └─ 终态 → 停止轮询
```

- 审阅状态只存在组件内存（`useState`），不写 `localStorage` / `sessionStorage`，也不进 URL；
- 页面**不**因为审阅读取失败而影响候选正文、采纳按钮或其它区块；
- 生成 / 采纳 / 版本流程完全复用既有实现，审阅面板只是新增一块只读区域。

### 29.2 旧请求隔离

- 请求身份是**单调序号**（`reviewSeqRef`），不是候选 id：同一候选「重新读取」、
  切换后再切回都会得到相同 id，只有序号能区分新旧请求；
- 每次加载 / 切换 / 手动重试都自增；旧请求（无论先发后到）完全静默：
  不写 review、不写 error、不改变 loading；
- 轮询循环同样带序号：切换候选后旧循环的下一次响应直接被丢弃并停止调度；
- 卸载 / 切换时清理定时器与 `visibilitychange` / `focus` 监听。

### 29.3 状态文案

| 条件 | 文案 | 色调 |
| --- | --- | --- |
| 选择候选后立即 | 正在读取审阅结果… | info |
| task `queued` | 等待审阅… | info |
| task `processing` | 按步骤：准备审阅上下文… / 模型审阅中… / 保存审阅结果… | info |
| run `succeeded` + `passed` | 未发现结构性问题 | ok |
| run `succeeded` + `!passed` | 发现 N 个问题 + `高 x · 中 y · 低 z` | warn |
| run / task `failed` | 审阅未完成，不影响当前候选采纳 | warn |
| task `cancelled` | 审阅已取消 | muted |
| task `succeeded` 但 `run=null` | 审阅结果异常（可「重新读取」，**不轮询**） | danger |
| `REVIEW_NOT_FOUND` | 暂无审阅结果 + 该候选还没有审阅记录，不影响预览与采纳。 | muted |
| 网络 / 500 | 审阅结果读取失败 + 局部「重新读取」 | danger |

- 未知 severity / type / step 一律回退到安全文案（`未标注严重度` / `其它问题` / `审阅中…`），
  不暴露内部枚举值，也不抛错；
- 通过时不显示分档统计（全 0 是噪音）。

### 29.4 问题展示与安全

- 按 `ordinal` 升序；severity 徽章 `高 / 中 / 低`（high = danger、medium = warn、low = 中性），
  type 用中文标签（合同偏离 / 设定矛盾 / 时间线冲突 / 物品状态冲突 / 情节线冲突 /
  人物一致性 / 文风问题）；
- `evidence` 与 `suggestion` 用 **React 文本节点**渲染，全链路无
  `dangerouslySetInnerHTML`：`<script>` / `<img onerror>` 只会作为文字显示；
  保留换行（`white-space: pre-wrap`）；
- 长文本 `overflow-wrap: anywhere` + `min-width: 0`，移动端不横向撑破。

### 29.5 采纳边界

- 采纳按钮的可用性**只**由既有章节 / 候选状态决定（`generatable` + 候选状态）；
- high / medium / low 一律不禁用、不二次确认、不追加门禁；
- 通过时提示"检查结果仅供作者参考，不会自动修改正文"，有问题时同样不免除作者的最终决定权；
- 面板不提供「重新审阅」按钮（本轮无手动重检），只有失败时的「重新读取」（同一次读取的重试）。

### 29.6 未做

手动重检 / 重试 / 取消审阅、high severity 采纳门禁、自动重写正文、
摘要读取 API / UI、事实 UI、后端 / migration 修改。

## 30. A2-D-D：章节版本摘要只读 API

> 让作者读到某个**正式版本**已成功生成的摘要。
> **只读**：不触发摘要任务、不重试、不重建，也不写审计；不做 UI。

### 30.1 接口

```text
GET /api/works/:workId/chapters/:chapterId/versions/:versionId/summary
```

```json
{
  "summary": {
    "id": "uuid",
    "chapterId": "uuid",
    "sourceVersionId": "uuid",
    "versionNo": 3,
    "summary": "章节摘要",
    "agentName": "summarizer.chapter",
    "agentVersion": "1.0.0",
    "createdAt": "ISO-8601"
  }
}
```

- 摘要按 **`sourceVersionId`** 定位：历史版本读到的是**那个版本**的摘要，
  不会被"当前最新版本"的摘要替换；
- `versionNo` 由 `chapter_versions` 关联读取（JOIN），不信任客户端或记忆中的版本号；
- 只返回已成功落库的摘要行；不返回 generation task、provider / model、prompt、
  租约或正文全文；
- `summary` 已由数据库 CHECK 保证 1..1000 且非空；
- 响应头 `Cache-Control: no-store`（沿用 `authJson`）。

### 30.2 查询与 404 语义

实现：`packages/workflow/src/chapter/summary-read.ts` 的
`getChapterVersionSummaryForAuthor`。

1. `requireOwnedWork`（会话里的作者 id）→ 他人作品 404 `NOT_FOUND`；
2. `requireChapterInWork` → 章节不属于作品 404 `NOT_FOUND`；
3. 单条查询同时取摘要与版本号，`where` 必须同时满足
   `source_version_id + chapter_id + work_id`：只按来源版本会让跨章节 / 跨作品
   读到别人的摘要；`chapter_summaries` 的复合外键
   `(source_version_id, chapter_id, work_id)` 保证三者一致；
4. 任一不满足（含"版本存在但还没有摘要""任务仍在排队 / 失败 / 被取消"）→
   统一 404 `SUMMARY_NOT_FOUND`，不区分"尚未生成"与"不是你的"。

### 30.3 前端

`apps/web/src/lib/chapter-summary-view.ts` + `fetchChapterVersionSummary()`：

- 严格解析：字段缺失 / 空串、`versionNo` 非正整数、`createdAt` 不可解析、
  摘要超长（>1000）→ 整份拒绝，收敛为 `ApiError('INTERNAL_ERROR')`；
- 404 保留 `SUMMARY_NOT_FOUND`，文案"该版本还没有摘要"；
- 只读接口不做 Origin 校验（与其它只读 GET 一致）；**本轮不加任何 UI 状态**。

### 30.4 未做

摘要 UI（版本阅读器里的摘要展示）、手动重试 / 重建、摘要回写正文、
Reviewer UI 修改、事实 UI、migration、RAG / 图谱。

## 31. A2-D-E：章节版本摘要展示 UI

> 在章节工作台的正式版本区展示**所选版本**已落库的摘要。
> 只读展示：不改后端、不触发摘要任务、不重试 / 重建、不写回正文。

### 31.1 数据流

```
选中正式版本（版本列表 / 采纳后自动选中 / 恢复后刷新）
  ├─ GET /versions/:versionId               （正文，既有）
  └─ GET /versions/:versionId/summary       （摘要，A2-D-D）
       ├─ 200 → 版本摘要卡片（版本号 + 生成时间 + 纯文本摘要）
       ├─ 404 SUMMARY_NOT_FOUND → 信息态
       └─ 5xx / 解析失败 → 读取失败 + 局部「重新读取」
```

- 摘要**按版本**读取：v1 / v2 / v3 各自展示自己的摘要，不会被最新版覆盖；
- 摘要状态只存在组件内存（`useState`），不写 `localStorage` / `sessionStorage`、不进 URL；
- 不轮询：接口只有 404 一种"没有"语义，无法据此判断"正在生成"。

### 31.2 旧请求隔离

- 请求身份是**单调序号**（`summarySeqRef`），不是 `versionId`：
  「同一版本重新读取」与「v2 → v1 → v2 切回」都会得到相同 id，只有序号能区分；
- 每次加载 / 切换 / 手动重试都自增，并 `abort` 上一次在途请求；
- 旧请求（序号过期）完全静默：不写 summary / error，也不改变 loading；
- 组件卸载时中止在途请求。

### 31.3 状态文案

| 条件 | 文案 | 色调 |
| --- | --- | --- |
| 加载中 | 正在读取版本摘要… | info |
| 成功 | 版本摘要 + `版本 vN · 生成于 …` + 摘要正文 | ok |
| 404 `SUMMARY_NOT_FOUND` | 该版本暂无摘要 / 摘要可能仍在生成、生成失败，或定稿时模型未配置。 | muted |
| 5xx / 解析失败 | 版本摘要读取失败 + 局部「重新读取」 | danger |
| 尚未读取 / 未知状态 | 尚未读取版本摘要 / 版本摘要状态未知 | muted |

- 404 是**信息态**，不是红色错误：它同时可能是"仍在生成"、「生成失败」、「定稿时模型未配置」；
- 未知状态回退到安全文案，不暴露内部枚举。

### 31.4 展示与边界

- 摘要正文用 React 文本节点渲染，`white-space: pre-wrap` 保留换行；
  全链路无 `dangerouslySetInnerHTML`，`<script>` / `<img onerror>` 只作为文字显示；
- 只显示版本号与生成时间，不显示 provider / model / task / prompt / requestId；
- 长文本 `overflow-wrap: anywhere` + `min-width: 0`，移动端不横向撑破；
- 摘要读取失败**不**关闭编辑器、不清空未保存草稿、不改变所选版本 / 正文 / diff /
  恢复 / 定稿的可用性；摘要也不回写正文。

### 31.5 未做

摘要重试 / 重建、摘要写回正文、摘要任务状态查询（因此无轮询）、
Reviewer UI 修改、事实 UI、RAG / 图谱、migration。

## 32. A2-E：连续性事实候选只读审阅 UI

> 在章节工作台增加事实审阅区：对**当前定稿的最新正式版本**显式触发提取、
> 按六类过滤查看候选。**只读**：没有接受 / 拒绝 / 批量决策 / 写回实体，
> 不改章节状态、版本、实体或物品事件，也不改后端。

### 32.1 提取入口

| 条件 | 行为 |
| --- | --- |
| 章节 `finalized` + 选中当前最新正式版本 + 空闲 | 显示「提取事实」 |
| 章节未定稿 | 不显示；提示「章节定稿后才能提取连续性事实候选。」 |
| 选中历史版本 | 不显示；提示「提取仅针对最新正式版本，请先选择最新版本。」 |
| 正在读取另一个版本（`versionLoading`） | 不显示（`selectedVersion` 还是旧值，不能用它发请求） |
| 提交中 | 按钮保留但禁用、文案「提取中…」（不能靠消失表达进度） |

- 点击调用 `extractChapterFactsFromApi(workId, chapterId, selectedVersion.id)`；
- `created=true` → 「已提取 N 条候选，仅作审阅，不会自动修改设定。」；
  `created=false` → 「已读取既有结果（N 条候选），本次没有新增。」；
- 成功后按**当前筛选**重读列表；不自动采纳、不跳转、不改任何其它区块；
- `IN_PROGRESS` / `LEASE_LOST` / `NOT_FINALIZED` / `SOURCE_VERSION_STALE` /
  `FACTS_INVALID` / `EXTRACTION_FAILED` 各自映射到固定中文文案，
  未知错误码与非 API 错误回退到「提取失败，请稍后重试。」，不回显原始异常；
- 提取中刷新页面：`extracting` 只存在组件内存，刷新即消失；页面按
  `GET /facts` 的真实结果重新渲染，不会留下永久 loading。

### 32.2 过滤与列表

- 过滤项固定为「全部 + 六类」（人物状态 / 关系变化 / 物品变化 / 境界进展 /
  情节线索 / 人物位置），值直接使用 `factType` 白名单；
- 过滤只在**服务端**做（`GET /facts?factType=...`），客户端不裁剪结果；
  「全部」不带 `factType` 参数；
- 请求身份是**单调序号**（`factSeqRef`），不是过滤值：「人物状态 → 全部 →
  人物状态」首尾参数完全相同，只有序号能识别当前请求；旧响应完全静默，
  不写列表 / 错误 / loading；
- 不轮询：列表只在进入页面、切换筛选、手动重读、提取成功后请求；
- 展示 `total`：「全部」为「共 N 条候选」，筛选态为「当前筛选共 N 条候选」；
- `truncated=true` 必须显示「结果较多：共 N 条候选，仅显示最近 200 条。」，
  不允许静默截断；
- 空态分两种：
  - 完全没有候选（`全部` 的 total 为 0）→「还没有事实候选」+ 提示提取；
  - 只是当前筛选为空（`全部` 的 total > 0）→「当前筛选下没有候选」+ 提示切换；
  - `全部` 从未读取成功过（total 未知）→ 不声称"没有任何候选"。

### 32.3 候选卡片

- 中文 `factType` 徽章、`版本 vN`、创建时间；
- `summary` 与 `reason` 用 React 文本节点 + `pre-wrap`，换行保留；
- `subjectId` / `objectId` 只展示前 8 位（`主体 11111111…` / `客体 …`），
  地点名展示为 `地点 xxx`，线索状态展示为 `线索新线索 / 有推进 / 已解决`；
- **不展示**：正文、prompt、模型原始响应、`attemptToken`、provider / model、
  run / task 的内部字段；
- 未知 `factType` / 线索状态一律回退到安全文案，不回显原始枚举。

### 32.4 错误与边界

- 列表读取失败只影响事实区：正文、版本元信息、摘要卡片、Reviewer 面板、
  编辑器草稿都不受影响；失败给「重新读取」（同一筛选重试）；
- 提取失败同样只影响事实区，错误显示在面板内；
- 面板内只有：提取、7 个筛选、失败时的「重新读取」；**没有**接受 / 拒绝 /
  采纳 / 批量 / 写回入口；
- 事实状态只存在组件内存：不写 `localStorage` / `sessionStorage`、不进 URL、
  不写日志；候选 payload 只在内存中渲染。

### 32.5 未做

事实接受 / 拒绝、批量决策、实体与物品事件写回、事实编辑、按候选查看 run 详情、
自动重写 / 摘要重建、RAG / embedding / 图谱、migration、后端改动。

## 33. A2-F-A：事实候选决策记录与 API

> 让作者对成功事实候选记录终态决定（接受 / 拒绝）。
> **只记录决定**：不写回人物 / 物品 / 势力 / 关系 / 境界，不创建或修改物品事件，
> 不做批量、不做撤销 / 改判，也没有 UI。

### 33.1 决策语义

| decision | 语义 | 副作用 |
| --- | --- | --- |
| `accepted` | 可作为**后续写回**的输入 | 仅写 `chapter_fact_decisions` 一行 + 一条审计 |
| `rejected` | 明确不采纳该候选 | 同上 |

- 决定是**终态**：`UNIQUE(candidate_id)` + append-only，数据库拒绝 UPDATE / DELETE；
- 同决定重复提交 → 200 `deduplicated=true`（不新增行、不新增审计、`decidedAt` 不变）；
- 不同决定 → 409 `CONTINUITY_FACT_ALREADY_DECIDED`，**不翻转**；
- 首次决定 → 201。

### 33.2 接口

```text
POST /api/works/:workId/chapters/:chapterId/facts/:candidateId/decision
{ "decision": "accepted" | "rejected" }
```

```json
{
  "decision": {
    "candidateId": "uuid",
    "decision": "accepted",
    "decidedAt": "ISO-8601",
    "deduplicated": false
  }
}
```

- 请求体严格白名单：只有 `decision`；缺字段 / `null` / 非字符串 /
  `accepted` 之外的取值（含大小写变体）一律 400，不做"默认接受"；
- 写接口**校验 Origin**（`INVALID_ORIGIN` 403）；未登录 401、管理员 403；
- 作者必须拥有作品：他人作品 404；跨作品 / 跨章节 / 随机候选 404（不区分）；
- 只允许**成功 run** 的候选（失败 run 从不产生候选，这里是防御性拒绝）；
- 只允许**当前定稿**且候选所属版本仍是**当前最新正式版本**的候选，
  否则 409 `CONTINUITY_FACT_DECISION_STALE`；
- 响应只含 `candidateId / decision / decidedAt / deduplicated`：
  不含 payload、summary / reason、正文、prompt、模型原始响应或 provider / model。

### 33.3 事务、并发与审计

`runWorkWrite` 作品级 advisory lock 内一次完成：

1. `requireOwnedWork`；
2. 候选归属（`id + work_id + chapter_id`）与 run 状态；
3. 章节状态与最新版本；
4. 已有决定（幂等 / 冲突）；
5. 插入决定 + 写审计 `continuity.fact_decided`（同一事务，审计失败整体回滚）。

- 审计 `detail` 固定 5 个键：`workId / chapterId / sourceVersionId / candidateId /
  decision`；**不含** payload、summary / reason、正文或模型响应；
- 并发同决定：一个 201、一个 200 幂等，数据库一行、审计一条；
- 并发不同决定：一个 201、一个 409，仍只有一行；
- 死锁 / 序列化失败 → 409 `CONCURRENT_MODIFICATION`。

### 33.4 数据边界

- 决策表没有正文、payload 副本、prompt 或密钥列；
- 接受**不会**修改实体、属性、关系、境界或物品事件：E2E / 集成测试对
  实体快照、属性快照、物品事件数量、章节状态、版本数量逐一比对；
- 决策不改变章节状态与版本：人工 revision 后旧候选的决定保留为历史记录，
  但**不能再做新决定**（STALE）。

### 33.5 未做

实体 / 物品事件写回、批量决定、撤销 / 改判、决策 UI、决策历史视图、
自动采纳、事实候选质量评估、RAG / embedding / 图谱。

## 34. A2-F-B：事实决策状态读取模型

> 让事实列表与候选详情回显作者已有的决定，供后续决策 UI 消费。
> **只读**：不新增写接口、不改任何表、不做 UI、不做统计汇总。

### 34.1 契约

```json
{
  "decision": {
    "value": "accepted | rejected",
    "decidedAt": "ISO-8601"
  }
}
```

- `GET /api/works/:workId/chapters/:chapterId/facts` 的**每条** fact 增加
  `decision: { value, decidedAt } | null`；
- `GET /api/works/:workId/chapters/:chapterId/facts/:candidateId` 的 `fact` 同样增加；
- 未决定（LEFT JOIN 未命中）→ `decision = null`；
- 已有字段语义不变：排序仍是 `created_at desc → id desc`，`total` / `truncated` 不变，
  仍只包含**成功 run** 的候选；
- **不返回** `decidedBy`、payload 副本、正文、prompt、provider / model；
- 只读：不写审计、不改 task / run / candidate / decision。

### 34.2 查询

```sql
FROM "chapter_fact_candidates" c
JOIN "chapter_fact_runs" r ON r."id" = c."run_id"
LEFT JOIN "chapter_fact_decisions" d
  ON d."candidate_id" = c."id"
 AND d."work_id" = c."work_id"
 AND d."chapter_id" = c."chapter_id"
WHERE ... AND r."status" = 'succeeded'
```

- **单条 SQL**：列表仍只有一次 `$queryRaw`，`count(*) over()` 与集合同快照；
  `UNIQUE(candidate_id)` 保证 LEFT JOIN 不会放大行数，因此 `total` 不受影响；
- 不做 N+1：列表路径**不访问** `chapterFactDecision` 代理（测试用计数代理守卫）；
- 详情路径按 `candidateId + chapterId + workId` 三条件读取决定；
- 三条件中的 `candidate_id` 是决定性的（决定与候选一一对应）；
  `work_id` / `chapter_id` 是纵深防御——数据库的复合外键已经保证三者一致，
  单独移除这两个条件在现有约束下不可观测，但保留可以防止将来放宽唯一性后跨章节串读。

### 34.3 异常值处理

- `value` 只接受 `accepted` / `rejected`；历史 / 损坏值一律按"未决定"处理（`null`），
  不把数据库里的异常枚举带到界面上；
- 决定行缺少 `decidedAt` 同样按"未决定"处理（不显示半个决定）。

### 34.4 未做

决策 UI（接受 / 拒绝按钮、已决标记）、决策统计、批量决定、撤销 / 改判、
实体写回、migration、新的写接口。

## 35. A2-F-C：事实候选决策 UI

> 让作者在事实审阅区对候选记录终态决定（接受 / 拒绝）。
> **只记录**：不写回人物 / 物品 / 势力 / 关系 / 境界，也没有撤销 / 改判。

### 35.1 可决定条件

| 条件 | 不满足时的表现 |
| --- | --- |
| 章节 `finalized` | 面板级说明「章节定稿后才能对事实候选做出决定。」，不出现任何决定按钮 |
| `candidate.sourceVersionId === 当前最新正式版本 id` | 候选级说明「仅当前最新定稿版本可做决定。」，不出现该候选的决定按钮 |
| `candidate.decision === null` | 已决候选显示徽章与决定时间，**隐藏**接受 / 拒绝按钮 |
| 该候选当前没有在提交 | 提交中两个按钮都禁用，文案变为「记录中…」 |

判定顺序固定：已决 → 章节未定稿 → 候选版本过期 → 提交中 → 可决定。
**已决排在最前**，保证已决定候选永远不会被当成可决定。

### 35.2 操作

- 调用 `decideChapterFactFromApi(workId, chapterId, candidateId, decision)`；
- 成功后**只更新该候选的 decision**，不重载整个列表；
- 同决定幂等（200 `deduplicated=true`）同样展示已决状态，不报错；
- 失败只影响当前候选：不清空列表、不覆盖提取提示。

### 35.3 已决展示

| 决定值 | 徽章 | 色调 |
| --- | --- | --- |
| `accepted` | 已接受 | `badge--ok`（成功色） |
| `rejected` | 已拒绝 | 默认徽章（中性色） |

- 同时显示决定时间（「决定于 …」）；
- 隐藏接受 / 拒绝按钮（决定是终态，不提供撤销 / 改判）；
- 给出统一声明：「决定已记录；当前不会自动修改人物、物品、势力、关系或境界。」

### 35.4 错误文案

| 错误码 | 文案 |
| --- | --- |
| `CONTINUITY_FACT_ALREADY_DECIDED` | 该候选已做出不同决定，不能改判。 |
| `CONTINUITY_FACT_DECISION_STALE` | 章节或版本已变化，不能继续决定。 |
| 其它错误码 / 网络异常 | 决定提交失败，请稍后重试。 |

未知错误码与非 API 错误（网络失败）都回退到通用文案，**不回显原始异常**。

### 35.5 并发

- **每条候选独立 in-flight**：一条在提交不影响其它候选；
- in-flight 用 **ref** 判定（不是 state）：state 更新是异步的，同一个 tick 内的
  重复点击会在 state 生效前再发一次请求；
- 双击 / 同时点接受与拒绝**只发一个请求**，且第一个请求胜出；
- 事实列表有**版本身份**：每次发起列表读取自增。决定请求发出时记下当时的版本，
  响应回来时若版本已变（期间切换了筛选或重新读取过列表），这次响应**完全静默**
  ——不写决定、不写徽章、不写错误，避免旧响应覆盖新列表；
  当前列表来自服务端，本身就是权威。

### 35.6 数据边界

- 不展示 `decidedBy`、payload 副本、正文、prompt、provider / model；
- 决定状态只存在组件内存：不写 Web Storage / URL / 日志；
- 没有批量决定、撤销、改判或写回入口。

### 35.7 未做

实体 / 物品事件写回、撤销 / 改判、批量决定、决策历史视图、决策统计、
migration、新的写接口。

---

## 36. C1-A：Coordinator Agent 契约与 Runtime

C1-A 把“小说创作”从固定步骤向导切换为**单 Coordinator Agent 动态问答**。
Runtime 仍是代码控制的持久化与执行层；Coordinator 只输出结构化的下一步 action。

### 36.1 Agent 契约

- `novel.coordinator@1.0.0`，`maxOutputTokens = 1024`；
- 输入：作者 id、原始 `requestText`、当前目标、步骤摘要、回答历史与预算信息；
- 输出（严格 JSON Schema）：

```json
{
  "action": "ask_user | finish",
  "objective": "当前步骤目标",
  "input": {
    "question": "string | null",
    "options": ["string"],
    "finishReason": "string | null"
  },
  "decisionSummary": "给作者看的一句话"
}
```

- JSON Schema 允许 `question` / `finishReason` 为 `string | null`，交叉语义由
  `validateNovelCoordinatorAction` 负责：
  - `ask_user`：`question` 非空、`options` 0–6 个（空数组表示开放式回答；非空时每项
    trim 后必须非空且不重复）、`finishReason === null`；
  - `finish`：`question === null`、`options` 为空、`finishReason` 非空；
  - `objective` / `decisionSummary` 非空且长度受限；
  - 任何 SQL、Prisma 调用、文件路径、shell 或 HTML 片段一律拒绝。

### 36.2 工具工作流

`NOVEL_TOOL_WORKFLOWS` 是唯一工具注册表，当前只注册：

| 工具 | 允许来源状态 | 成功迁移 | sideEffect | 重试 | 超时 |
| --- | --- | --- | --- | --- | --- |
| `ask_user` | `running` | `waiting_user` | `read_only` | 1 | 60s |
| `finish` | `running` | `completed` | `read_only` | 1 | 60s |

Runtime 的校验顺序固定为：注册表 → `NOVEL_ALLOWED_TOOLS` → 来源状态 →
工具 `inputSchema`。任一失败都写 failed step（或直接失败），不产生业务副作用。
C1-A **不产生 `waiting_approval`**，也不创建 Work、章节或正文。

### 36.3 Runtime 边界

`NovelCoordinatorWorker.runOnce()` 负责：

- 过期租约回收：有 `cancel_requested_at` 的 running run 直接 `cancelled`，否则重排 `queued`；
- `FOR UPDATE SKIP LOCKED` 领取单条 run，写 `locked_by / lease_until / heartbeat_at`；
- 心跳与 fence：所有提交条件都带 `status = 'running' AND locked_by = 本 Worker
  AND state_version = 读取时版本 AND cancel_requested_at IS NULL AND
  lease_until > clock_timestamp()`；租约是否有效由 PostgreSQL 计算，禁止应用进程用
  `Date.now()` 比较 `lease_until`。fence 通过后、最终条件 UPDATE 前租约若过期，
  UPDATE 必须返回 0 行并放弃 step / state 提交；
- 两个独立信号：`leaseAbort` 只由心跳失败、取消或真实 fence 失败触发；每次 attempt
  使用独立的 `attemptAbort`，只负责单次模型调用超时。`attemptAbort` 不参与
  `checkFence`，超时不得被误判为租约丢失；
- 模型硬超时：`Promise.race` 截断 Provider，即使 Provider 不监听 signal；
  `modelCallTimeoutMs` 可注入（生产默认 60 秒，测试用更短值）。单次超时记一条
  `MODEL_TIMEOUT` 调用、作为该 attempt 的可重试失败，下一次 attempt 使用新的
  `attemptAbort`；attempt 用尽后在同一 run 提交 failed step + `failed`；
- 调用遥测与状态提交解耦：每次实际模型调用完成后立即 append 一条脱敏
  `novel_agent_calls`（`step_id = NULL`），使用调用级稳定 UUID 作为主键，同一逻辑
  调用只写一次。旧 Worker 晚返回时可以补写它实际发生的调用日志，但不得写 step、
  state、问题或任何创作资料；
- 失败调用的 usage 保留：Provider 已返回 usage 后，即使输出 Schema 校验失败
  或内容 JSON 解析失败，也必须把 `provider / model / promptTokens /
  completionTokens / latencyMs` 附在安全错误上，由 Runtime 写入调用遥测；
  只有 Provider 确实没有返回 usage 时才记 0。错误与调用日志不得携带 prompt、
  原始输出、正文或底层异常；
- 预算：`remainingSteps <= 0` 直接失败且不写 step；token 预算读取所有实际调用日志
  （含失败重试、超时、取消），超限写 failed step 并记录
  `NOVEL_RUN_BUDGET_EXCEEDED`；
- 循环熔断：`hash(action + question/options/finishReason)` 连续 3 次相同 →
  `COORDINATOR_LOOP_DETECTED`；
- 成功提交：条件 UPDATE run + 插入一条 `novel_run_steps`，在同一事务；旧 Worker
  条件 UPDATE 无行时抛 `CommitAborted('lease-lost')`，整事务回滚，`runOnce` 返回
  `'lease-lost'`；
- 读取：`readNovelRun()` 使用 `RepeatableRead` 事务在同一快照读取 run 与最新成功
  step，避免返回“旧 version + 新 question”；DTO 不变。

### 36.4 持久化

`novel_runs` / `novel_run_steps` / `novel_agent_calls` 的列、CHECK 与触发器见
[`03-data-model.md`](03-data-model.md) 的 3.15。要点：

- `request_text`、`max_steps`、归属与创建时间不可变；
- 状态迁移白名单由触发器把关，终态不可离开；
- step / call append-only，run 不可删除；
- step 的 `input_hash` 与 call 日志都不包含 prompt、原始响应或密钥。

### 36.5 Worker 与健康检查

- `apps/worker` 同时运行 generation 循环与 novel 循环；
- 两个循环共享 `/healthz`，`mergeWorkerLoopSnapshots` 取最严重状态
  （`ready < starting < retrying < stopping < failed`），合并连续失败、错误码、
  退避与最早成功时间；
- 任一循环永久失败或抛错 → 进程以退出码 1 优雅关闭；
- Mock 模式使用 `createNovelCoordinatorMockProvider()`，真实模式复用
  `createModelProvider(providerConfig)`。

### 36.6 API 与动态问答页

| 方法与路径 | 行为 |
| --- | --- |
| `POST /api/novel-runs` | 创建 run；只接受 `requestText`，1–2000 字；201 只返回 `runId/status/version` |
| `GET /api/novel-runs/:runId` | 读取当前视图；跨作者或畸形 id 统一 404 |
| `POST /api/novel-runs/:runId/answer` | 只接受 `expectedVersion` 与 `answer`；幂等 / 冲突 / 非法状态用稳定错误码 |
| `POST /api/novel-runs/:runId/cancel` | 非终态幂等取消；终态原样返回 |

所有写接口都校验登录、作者角色与 Origin；管理员无普通 run 入口。

页面 `/novel-runs/[runId]`：

- 1s → 2s → 5s 轮询；`isPageHidden()` 在初始 tick 前、每次成功/失败安排下一次 timer
  前都会检查：隐藏时清 timer 且不排新 timer，恢复可见立即补一次并重置退避；
- 请求带单调 `seq` 与 `AbortController`，旧响应不能覆盖新状态；
- 回答提交带当前 `version`；409 时提示并立即重取，不覆盖作者输入；
- 终态停止轮询并展示结论；取消按钮只在非终态出现；
- 问题、选项、摘要、错误全部按纯文本渲染，不使用 `dangerouslySetInnerHTML`；
- 顶部「写作台 → 写新小说」只有一个目标输入框，不做题材预设或向导。

### 36.7 C1-B 前置：Work 绑定

C1-A 的 migration 把 `novel_runs.work_id` 设为不可变（创建后不能 UPDATE），
这是为了防止问答中途篡改归属。C1-B 若要在同一 run 上“创建或绑定 Work”，
开工前必须先设计受控的一次性绑定方案，二选一：

- 新增专用绑定表（run_id ↔ work_id，唯一约束 + 作者校验），不改 run 的可变字段；
- 或在新的一份**未发布** migration 中允许 `NULL → work_id` 的单次迁移，并由触发器
  保证只能发生一次。

无论哪种方案都必须满足：

- 绑定的作品属于同一作者（`works.id + works.author_id` 复合校验）；
- 只能从未绑定变为已绑定一次，不允许改绑或解绑；
- 不把 Work 创建 / 绑定能力塞进本次 C1-A 修复卡。

本次修复不实现任何 Work 功能。

### 36.8 未做

故事规划 Agent（创意 / 世界观 / 人物 / 剧情 / 三级大纲）、World / Character /
Plot Agent、三级大纲、正式故事圣经投影、创建 Work、正文生成、事实写回、
RAG、图数据库与任何自动采纳。

C1-B-A1 只完成「故事候选」数据域 + Concept Agent + 内部服务；
Coordinator 1.1、`concept.generate` 工具、HTTP API、UI 与浏览器 E2E 留给 C1-B-A2。
`waiting_approval` 状态与作者确认闭环已在 C1-B-A1 的服务 / 数据层打通，但尚未接
Coordinator。

### 36.9 C1-B-A1：Concept Agent 与故事候选域

- Agent：`novel.concept@1.0.0`，工具名 `concept.generate`（尚未注册到 Runtime
  的白名单，C1-B-A2 再接）；
- 输入只允许 `requestText`、`knownFacts[]`、`authorFocus`（nullable）；不包含
  prompt、密钥、数据库行或任意工具；
- 输出严格 JSON：`titleSuggestions`（1–3）、`logline`、`coreConflict`、
  `targetAudience`、`tone`、`sellingPoints`（3–6）、`themes`（1–5）、
  `storyPromise`、`openQuestions`（0–5）；
- 语义校验：所有字符串 trim 后非空；数组元素 trim、去重；拒绝 HTML / Markdown
  标题 / 代码围栏 / SQL / Prisma / 文件路径 / shell，以及任何“下一步工具 / 数据库命令 /
  正式写入”意图；失败统一 `AGENT_OUTPUT_INVALID`，错误只含路径与固定原因，不回显原文；
- `createNovelConceptMockProvider()`：确定、非空、不读时钟 / Key / 网络，
  不复制作者原文，输出通过同一 Schema + 语义校验；
- 内部服务（不暴露 HTTP）：
  - `createConceptCandidate`：首次创建 artifact + revision 1；draft / rejected
    每次生成 revision N+1 并回到 draft；同内容（规范 JSON 哈希）不新增 revision；
    每次实际调用写一条 `call_kind = 'tool'` 脱敏遥测；
  - `requestConceptApproval`：draft → pending_approval，run → waiting_approval；
  - `decideConceptArtifact`：pending / 当前 revision 才能决定；approved / rejected
    后 run 回到 queued；同决定幂等，不同决定 409；
  - `readConceptArtifact`：只返回 artifact / 当前 revision 内容 / decision；
    不返回 `stateSummary`、prompt、provider / model 调用日志、租约或其它候选；
- Fence：模型调用前后都校验 run `state_version` 与 artifact `current_revision`；
  旧 Worker 晚返回不能覆盖新 artifact state；真实发生的调用遥测仍保留；
- 稳定错误码：`NOVEL_ARTIFACT_NOT_FOUND`（404，跨作者统一）、
  `NOVEL_ARTIFACT_VERSION_CONFLICT`、`NOVEL_ARTIFACT_DECISION_STALE`、
  `NOVEL_ARTIFACT_ALREADY_DECIDED`、`NOVEL_ARTIFACT_ALREADY_APPROVED`；
- 数据域：`novel_artifacts` / `novel_artifact_revisions` / `novel_artifact_decisions`
  三张表；revision / decision append-only；artifact 与 decision 状态自洽；
  `current_revision` 与 revision 最大编号一致；
- `novel_agent_calls` 自本卡起允许 `call_kind = 'tool'`，`step_id` 允许为空（
  A2 接 Runtime 后关联 step）；
- `novel_runs` 状态机扩展：`queued / waiting_user → waiting_approval`，
  使未接 Runtime 的内部服务也能完成作者确认闭环；`waiting_approval → queued`
  已存在。C1-B-A2 的实际路径仍是 `running → waiting_approval`。
- 本卡没有 HTTP API / UI / 浏览器 E2E，也没有 Work 创建 / 绑定。
