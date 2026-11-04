# 08 工作流与 Agent（A1-1 / A1-2 / A1-3A / A1-3B）

- 版本：v1.3
- 日期：2026-11-04
- 对应代码：`packages/workflow`、`apps/web/app/api/works/**`
- 对应迁移：`20261104010000_a1_workflow_kernel`、`20261104020000_a1_chapter_draft`、
  `20261104030000_a1_chapter_versions`（A1-3B 无新增迁移）

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

## 2. A1-1 / A1-2 / A1-3A / A1-3B 范围

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

---

## 15. A1-4 预告（不在本轮）

- 章节工作台（列表 / 正文阅读 / 候选查看与采纳按钮 / 任务轮询）；
- 正式版本读取接口与版本列表；
- 人工修订（`source='human'`）；
- 重新生成与差异对比；
- `apps/worker` 常驻循环接入部署；
- 仍不接 Reviewer / RAG。
