# WorkBuddy 任务卡：A2-D-B 定稿章节摘要任务与持久化

## 开始前

只读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. 本任务卡
5. `docs/03-data-model.md` 的章节版本与事实 run 相关章节
6. `docs/08-workflow-and-agents.md` §12、§21、§25
7. `packages/workflow/src/chapter/summarizer.ts`
8. `packages/workflow/src/chapter/finalize.ts`
9. `packages/workflow/src/chapter/facts.ts`
10. `packages/workflow/src/chapter/persistence.ts`
11. `packages/workflow/src/chapter/review-workflow.ts`
12. `apps/worker/src/runtime.ts`
13. 对应 migration / workflow / worker 测试

前置条件：

- A2-C-B（含 REV-01）和 A2-D-A 已验收；
- 当前 HEAD 工作区干净；
- 新 migration 必须能在全新空库执行；
- 不修改已验收历史 migration；
- **禁止**通过 DROP 业务表/函数、删除 `_prisma_migrations` 记录或重置共享开发库
  来同步 checksum；需要空库验证时使用一次性随机命名数据库，结束后只删除该临时库；
- 本轮不接 Reviewer `priorSummaries`，不做 API / UI。

## 目标

把已完成的 `summarizer.chapter@1.0.0` 接入受工作流约束的后端：

- 章节首次定稿时，在同一事务内创建唯一的 `chapter.summarize` 任务；
- 只处理**当前仍为 finalized 且 sourceVersionId 是最新正式版本**的章节；
- 摘要按 sourceVersionId 幂等落库、可追溯；
- 摘要失败不回滚章节定稿、正式版本或其它作者数据；
- 不提供读取 API / UI，也不把摘要写回章节正文。

## 冻结行为

1. 每个正式章节版本最多生成一条摘要。
2. 任务与源版本通过 `sourceVersionId` 关联；正文不进入任务快照。
3. 重复定稿、崩溃恢复、任务重试不得重复生成摘要或摘要任务。
4. 章节在摘要执行期间发生人工 revision / 再定稿时，旧 sourceVersion 立即变为 stale；
   提交阶段必须重新校验，不得把旧版本摘要冒充当前定稿摘要。
5. Reviewer `priorSummaries` 本轮仍固定为 `[]`；下一阶段再接线。
6. 摘要只是派生数据，不改变章节状态、正式版本、候选、采纳权。

## 1. `chapter.summarize` 任务

新增稳定任务类型：

```text
chapter.summarize
```

任务输入只允许：

```json
{ "sourceVersionId": "uuid" }
```

约束：

- 未知字段、非 UUID、缺少 sourceVersionId 一律拒绝；
- `input_snapshot` 不含正文、prompt、摘要或密钥；
- requestId 使用确定性的 `summary:<sourceVersionId>`（≤128 字符）；
- inputHash 复用现有 canonical JSON / request hash；
- provider / model 由现有 finalize API 在**服务端**按
  `readProviderConfig()` / Provider 构造结果解析后传给 `finalizeChapter`；
  请求体仍不得提交 provider / model，事务内不得读取环境；
- maxAttempts 使用现有默认值；
- 在 `finalizeChapter` 的同一作品锁事务内幂等确保任务存在：
  - 首次定稿 → 创建；
  - 已定稿同版本且任务缺失（恢复）→ 补齐；
  - 同 requestId / inputHash → 不重复创建；
  - 不使用会触发事务 aborted 的“先 INSERT 再处理唯一冲突”写法。

现有作者侧章节详情 / 列表继续只展示 `chapter.draft`，不得让
`chapter.summarize` 成为“最新正文任务”。

现有 `POST /finalize` 的请求 / 响应字段不变；只在其服务端装配中增加
summary task spec，不能把 provider / model 暴露给客户端。

## 2. 数据表

新增一个 migration（不改历史 migration）：

### `chapter_summaries`

至少包含：

```text
id
work_id
chapter_id
source_version_id
agent_name
agent_version
provider
model
summary
created_at
```

约束：

- `UNIQUE(source_version_id)`：每版最多一条摘要；
- 复合外键绑定 `(source_version_id, chapter_id, work_id)` →
  `chapter_versions(id, chapter_id, work_id)`；
- summary `trim` 后非空，数据库 CHECK 1..1000；
- append-only：UPDATE / DELETE 一律拒绝；
- 不保存正文、prompt、模型原始响应或密钥；
- 命名、索引与触发器风格复用 `chapter_fact_runs` / `chapter_fact_candidates`；
- 不新增 `final_version_id`。

任务失败状态沿用 `generation_tasks` 与 `llm_call_logs`，不另造一套运行状态机。

## 3. 固定工作流

新增：

```text
load_summary_input → summarize_chapter → persist_summary
```

### `load_summary_input`

- 锁任务行并确认 `locked_by / status / cancel_requested_at` fence；
- 解析 sourceVersionId；
- 校验 work / chapter / sourceVersion 归属一致；
- 要求章节当前 `status='finalized'`；
- 要求 sourceVersionId 是该章节当前最新正式版本；
- 已有同版本摘要 → 标记 skip，不再调用模型；
- `task_contexts` 只记录 chapter / sourceVersion 的 id、版本号、字数，
  不记录正文、摘要或 prompt。

### `summarize_chapter`

- 调用 `summarizer.chapter@1.0.0`；
- 必须运行现有 `assertSummarizerInput` 与 `validateSummarizerOutput`；
- 输入正文只来自该正式版本 `chapter_versions.content`；
- 每次实际 Provider 调用写且只写一条 `llm_call_logs`；
- Schema / 语义失败记 `success=false`，稳定错误码
  `AGENT_OUTPUT_INVALID` / `AGENT_INPUT_INVALID`；
- 日志不含正文、摘要、prompt、原始响应或密钥。

### `persist_summary`

- `runWorkWrite` + 任务行锁 / lease fence；
- 同一事务内再次校验章节 finalized、sourceVersion 仍是最新；
- 写入 `chapter_summaries` 与成功 LLM 日志（若调用发生）；
- 已存在同版本摘要时不重复插入；
- 不修改章节、版本、候选、合同或采纳状态；
- 不写 audit_logs：摘要是派生数据，任务日志与摘要行就是追溯记录。

控制层错误 `TASK_LEASE_LOST` / 取消检查必须向上抛，不得吞掉。

## 4. Worker 与 Mock

- `apps/worker/src/runtime.ts` 注册 `chapter.summarize`；
- 仍只构造一次 Provider；
- `createChapterMockProvider()` 增加 summarizer 分派：
  `CHAPTER_SUMMARIZER_MOCK_OUTPUT`；
- 通用 `MockProvider` 与 A2-D-A 专用 Mock 的既有语义不得改变；
- 测试 Worker 必须能依次完成 draft、review、summarize 队列，不串错 Provider。

## 5. 测试

新增 `packages/workflow/test/chapter-summary-workflow.test.ts`，至少覆盖：

1. 首次定稿与 summary task 同事务创建；
2. 同版本重复定稿不重复建 task；
3. 已定稿但 task 缺失可恢复补齐；
4. 默认 Mock 完成摘要，表行、provider/model/agent 版本正确；
5. 同 sourceVersion 重试复用同一 task，不重复摘要；
6. 非 finalized / 旧版本 / 跨作品版本被拒绝；
7. revision 在模型调用期间发生 → 提交 stale，不写摘要；
8. 旧 Worker 晚返回不能写摘要；
9. 取消 / 租约丢失不留下成功摘要或错误正文；
10. 非法摘要输出使 summary task 失败，但定稿与版本不受损；
11. 摘要表 append-only、复合外键、UNIQUE、长度 CHECK；
12. `llm_call_logs` 成功 / 失败各一条且不含正文；
13. 现有章节详情 / 列表不显示 summary task；
14. Worker 注册后能领取并完成 summary task。
15. finalize API 响应字段不变，provider / model 不出现在请求契约或响应中。

使用真实 PostgreSQL，不新增 `skip` / `fixme`。

## 6. 文档

完成后更新：

- `docs/03-data-model.md`：`chapter_summaries` 字段、复合外键、append-only；
- `docs/08-workflow-and-agents.md`：`chapter.summarize` 固定步骤、幂等与 stale 规则；
- `docs/09-project-memory.md`：能力、下一步、测试 / migration / 表 / trigger 数量、风险；
- `docs/07-master-roadmap.md`：A2-D-B 状态与历史行；
- 不把正文 / 摘要 / prompt / Key 复制进文档。

## 验证

```bash
pnpm --filter @novel/db generate
pnpm db:deploy
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

灵敏度验证至少两次：

1. 移除 finalize 事务内的 summary task 入队，确认自动入队用例失败，恢复后全绿；
2. 移除 `persist_summary` 的 finalized / latest 二次校验，确认 revision stale 用例失败，
   恢复后全绿。

## 明确不做

- Reviewer `priorSummaries` 接线；
- API / UI；
- high severity 采纳门禁；
- 自动重写正文；
- 摘要回写 `chapters` 或正式正文；
- RAG / embedding / 图谱；
- 推送远端。

## 交付

本地提交，不推送。报告提交号、任务与数据表、空库迁移、幂等 / stale 证据、
测试与数量、两次灵敏度、未做项和工作区状态，等待复审。
