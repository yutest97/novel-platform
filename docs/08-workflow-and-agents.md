# 08 工作流与 Agent（A1-1）

- 版本：v1.0
- 日期：2026-11-04
- 对应代码：`packages/workflow`
- 对应迁移：`20261104010000_a1_workflow_kernel`

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

## 2. A1-1 范围

**交付**：确定性工作流内核、Provider 抽象、Agent 运行基础设施、
PostgreSQL 任务队列（领取/租约/心跳/重试/取消/幂等）、四张基础表。

**不交付**：Planner/Writer 业务 Agent、章节生成 API/UI、
章节契约/候选/版本、Reviewer/Continuity/Fact、RAG/图数据库、资源流水、多人功能。
A1-2 才接入 Plan → Draft 的真实流水线。

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

## 4. 数据表（A1-1）

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `chapters` | 最小章节骨架 | `UNIQUE(work_id, chapter_no)`、`chapter_no >= 1`、状态六态、FK works RESTRICT |
| `generation_tasks` | 任务队列 + 租约 | `UNIQUE(work_id, request_id)`、状态白名单、processing 必须有锁/租约、状态迁移触发器、终态不可变 |
| `task_contexts` | 任务引用的上下文摘要 | `(task_id, context_type, ref_id)` 唯一、snippet ≤ 500、rank ≥ 0 |
| `llm_call_logs` | 模型调用计量 | 只有 token/延迟/成功/error_code；**没有 prompt/正文列** |

设计细节：

- `input_snapshot` 只放结构化输入（≤ 64 KiB），**不放 prompt、正文、API Key**；
- `error_message_sanitized` 只存服务端映射后的固定文案；
- `generation_tasks.chapter_id` 在 A1-1 允许为空（非章节型任务）；A1-2 起正文任务必填；
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

## 7. 幂等

- 创建：`(work_id, request_id)` 唯一。已存在时返回既有任务（`created=false`），
  不覆盖输入、不新增行；并发创建只有一个成功。
- 执行：同一条任务重试只增加 `attempt_count`，不新建任务。
- A1-1 **不做输入指纹比较**：同一 `request_id` 配不同输入会返回原任务；
  调用方必须把 `request_id` 与逻辑请求一一对应（A1-2 若需要，再引入 input_hash 与 409）。

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

A1-1 新增 98 个测试；既有 390 个测试不减少。

---

## 12. A1-2 预告（不在本轮）

- 注册 `planner.chapter` 与 `writer.draft` 两个 Agent（promptVersion 从 1.0.0 起）；
- 新增章节生成任务类型与 API（会话 authorId）；
- 生成 API 只创建任务并返回 taskId，不直接返回正文；
- 章节工作台读取任务进度与候选；
- 作者确认后才产生 `chapter_versions`。
