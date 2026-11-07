# Trae 任务卡：C1-B-A1 故事候选域与 Concept Agent

## 开始前

读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. `docs/plans/C1-coordinator-agent-runtime.md`
5. 本卡

按需读取：

- `docs/03-data-model.md` 中 C1 / artifact / 触发器模式；
- `docs/08-workflow-and-agents.md` 第 36 节；
- `packages/workflow/src/novel/*`；
- 现有 migration、append-only、复合外键、AgentRunner 和测试夹具。

基线：`5b1e4a8`（C1-A-REV-02，本地复审通过）。
执行方：Trae。工作区除 `.tmp/` 外必须干净；未得到用户明确要求，不推送远端。

## 边界

C1-B 已拆成：

- **C1-B-A1（本卡）**：artifact 数据域 + Concept Agent + Mock + 服务层；
- C1-B-A2：Coordinator 1.1、`concept.generate` / approval tool、API、UI、E2E；
- C1-B-B：World / Character / Plot Agent；
- C1-B-C：三级大纲；
- C1-B-D：编辑、Work 绑定与完整故事圣经。

本卡**不**接 Coordinator、不做 HTTP API / UI、不创建 Work、不生成其它 Agent。

## 目标

建立“故事候选”领域：

```text
Concept Agent 输出
→ 新 artifact revision
→ 申请作者确认
→ 作者批准 / 拒绝
→ 批准版本成为后续 Agent 的唯一可依赖版本
```

本卡先把该状态机做成可测试的服务与数据库能力，下一张卡再接 Coordinator 和页面。

## 数据模型

新增一份 migration，不改已验收历史 migration。

### `novel_artifacts`

```text
id uuid pk
run_id uuid not null -> novel_runs
author_id uuid not null -> users
work_id uuid null
artifact_type text not null
status text not null
current_revision integer not null
created_at / updated_at
UNIQUE(run_id, artifact_type)
```

本卡只允许 `artifact_type = 'concept'`。

状态：

```text
draft
pending_approval
approved
rejected
```

约束：

- author 必须与 run 的 author 一致；
- work_id 本卡固定 null；
- current_revision >= 1；
- DELETE 拒绝；
- run_id / author_id / work_id / artifact_type / created_at 不可修改；
- 允许迁移：
  - `draft → pending_approval`
  - `pending_approval → approved | rejected`
  - `rejected → draft`（生成新 revision）
- approved 为终态；
- status 与 decision 表必须自洽。

### `novel_artifact_revisions`

```text
id uuid pk
artifact_id uuid not null
revision_no integer not null
schema_version text not null
content jsonb not null
source_agent text not null
source_agent_version text not null
source_step_id uuid null
created_at
UNIQUE(artifact_id, revision_no)
```

约束：

- revision 必须通过复合关系钉到同一 run / author 的 artifact；
- schema_version 本卡只允许 `concept@1.0.0`；
- content 必须是 object，序列化长度 1..131072；
- source_step_id 若存在，必须属于同一 run；
- UPDATE / DELETE 拒绝；
- revision append-only。

### `novel_artifact_decisions`

```text
id uuid pk
artifact_id uuid not null
revision_no integer not null
author_id uuid not null
decision text not null
decided_at
UNIQUE(artifact_id, revision_no)
```

约束：

- decision 只允许 `approved | rejected`；
- author 必须等于 artifact / run 的 author；
- 决策必须通过复合外键引用同一 artifact revision；
- UPDATE / DELETE 拒绝；
- 同一 revision 只能有一条 decision；
- rejected 后可产生新 revision；approved 后禁止新 revision。

### `novel_agent_calls`

本卡开始允许 `call_kind = 'tool'`：

- Concept Agent 实际调用写一条脱敏 call；
- provider / model / usage / latency / success / error_code 规则沿用 C1-A；
- 不保存 prompt、原始输出、正文或 Key；
- step_id 允许 null，A2 接 Runtime 后可关联 step。

## Concept Agent

新增：

```text
novel.concept@1.0.0
tool: concept.generate
```

输入只允许：

```text
requestText
knownFacts[]
authorFocus nullable
```

不得包含其它作者数据、prompt、密钥、任意工具或数据库行。

输出严格 JSON：

```json
{
  "titleSuggestions": ["1..3 个短标题"],
  "logline": "一句话故事钩子",
  "coreConflict": "核心冲突",
  "targetAudience": "目标读者",
  "tone": "叙事基调",
  "sellingPoints": ["3..6 个卖点"],
  "themes": ["1..5 个主题"],
  "storyPromise": "持续兑现的阅读承诺",
  "openQuestions": ["0..5 个仍需作者决定的问题"]
}
```

语义规则：

- 所有字符串 trim 后非空；
- 数组元素 trim、去重；
- 标题 1..3，卖点 3..6，主题 1..5，问题 0..5；
- logline / coreConflict / storyPromise 设合理长度上限；
- 拒绝 HTML、Markdown 标题、代码围栏、SQL / Prisma / 文件路径 / shell；
- 不允许 Agent 输出下一步 tool、数据库命令或正式写入意图；
- 非法输出统一 `AGENT_OUTPUT_INVALID`，不回显原始内容。

新增确定性 `createNovelConceptMockProvider()`：

- 不读时钟、Key、网络；
- 输出通过同一 Schema + 语义校验；
- 不复制作者原文到输出；
- 默认生成完整、非空 concept。

## 服务层

新增内部服务，不暴露 HTTP：

### `createConceptCandidate`

输入：

```text
authorId
runId
sourceStepId nullable
provider
```

流程：

1. 读取并锁 run；
2. 校验作者归属和 run 状态；
3. 读取 call telemetry 预算所需数据（如果 A1 尚未接 Runtime，可先只做归属与状态）；
4. 已有 approved concept → 拒绝新 revision；
5. 无 artifact → 创建 artifact + revision 1；
6. rejected / draft artifact → revision N+1，status 回到 draft；
7. 同一内容不重复创建 revision（hash 幂等）；
8. 每次实际 Concept Agent 调用写 `call_kind='tool'` 遥测；
9. artifact / revision / call / checkpoint 关联在可恢复事务中。

### `requestConceptApproval`

```text
authorId, runId, artifactId, revisionNo, expectedRunVersion
```

- 校验 artifact 属于 run / author，revision 是 current；
- draft → pending_approval；
- run → waiting_approval，version+1；
- 并发版本不符 409。

### `decideConceptArtifact`

```text
authorId, runId, artifactId, revisionNo,
expectedRunVersion, decision
```

- 只有 pending / current revision 可决策；
- approved → artifact approved，run queued；
- rejected → artifact rejected，run queued；
- 写 append-only decision；
- 同版本同决定幂等；
- 不同决定 / stale revision / version 冲突使用稳定错误；
- artifact、decision、run requeue 同一事务。

### `readConceptArtifact`

作者归属内返回：

```text
artifactId
runId
status
currentRevision
content
revisionNo
schemaVersion
sourceAgent / sourceAgentVersion
decision { value, decidedAt } | null
```

不得返回 stateSummary、prompt、provider/model 调用日志、租约或其它候选。

## 稳定错误码

至少新增：

```text
NOVEL_ARTIFACT_NOT_FOUND
NOVEL_ARTIFACT_VERSION_CONFLICT
NOVEL_ARTIFACT_DECISION_STALE
NOVEL_ARTIFACT_ALREADY_DECIDED
NOVEL_ARTIFACT_ALREADY_APPROVED
```

不泄露“存在但不属于当前作者”的差异。

## 测试

真实 PostgreSQL，不联网、不 skip、不使用 fixme。

### Concept Agent / Mock

1. 合法输出；
2. 未知字段、空字段、重复数组、数量越界拒绝；
3. HTML / Markdown / SQL / 路径 / shell 拒绝且不回显；
4. 作者恶意原文不被 Mock 回显；
5. Mock 确定性、Schema + 语义全通过；
6. 失败调用的 provider / model / usage 仍写安全 telemetry。

### 数据域

1. artifact / revision / decision 复合外键、唯一性、CHECK；
2. revision / decision append-only；
3. artifact 状态机：draft → pending → approved / rejected；
4. rejected → 新 revision 回到 draft；
5. approved 后禁止新 revision；
6. content 大小上限；
7. 同 run / artifact 的 current_revision 与 revision 最大号一致。

### 服务

1. 首次生成 revision 1；
2. 同内容幂等，不新增 revision；
3. 拒绝后生成 revision 2；
4. 批准后 create 被拒绝；
5. request approval 成功后 run waiting_approval；
6. approved / rejected 后 run queued；
7. 同决定幂等、不同决定冲突；
8. 旧 expectedVersion / 旧 revision 冲突；
9. 跨作者统一 404；
10. 事务失败不留下半条 artifact / revision / decision；
11. 旧 Worker 晚返回不能覆盖新 artifact state（使用 source step / run version fence）。

### 文档

更新：

- `docs/03`：三表、状态机、约束、触发器；
- `docs/08`：Concept Agent、call_kind=tool、artifact service；
- `docs/09`：能力、测试数、migration/表/触发器、风险和下一步 C1-B-A2；
- `docs/07`：C1-B-A1 状态与 C1-B-A2 下一步。

## 验证

```bash
pnpm --filter @novel/db generate
pnpm db:deploy
pnpm --filter @novel/db test
pnpm --filter @novel/workflow test
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
git diff --check
git show --check
```

必须：

- 全新空库 migration；
- 全量单测；
- 至少两次灵敏度验证。

建议灵敏度：

1. 删除 approved 门禁 → approved 后新 revision 用例失败；
2. 删除 revision / decision 复合 fence → 旧 revision 决策用例失败；
3. 删除 call telemetry 安全字段 → 脱敏 / usage 用例失败。

本卡没有 HTTP / UI，因此不新增浏览器 E2E；C1-B-A2 必须补。

## 不做

- Coordinator 1.1 / concept.generate tool；
- HTTP API / UI / E2E；
- Work 创建 / 绑定；
- World / Character / Plot / Outline；
- 正式故事资料投影；
- RAG / 图谱；
- 推送远端。

## 交付

本地提交，不推送。汇报：

- 提交号、HEAD、工作区；
- Concept Agent / Mock / 服务层；
- 3 张 artifact 表及 migration / 表 / 触发器数量；
- 幂等、状态机、旧 Worker fence、脱敏证据；
- 全量单测、静态检查、build、空库 migration；
- 至少两次灵敏度；
- 未做项；
- 等待复审。
