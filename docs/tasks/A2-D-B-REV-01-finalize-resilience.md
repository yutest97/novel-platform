# WorkBuddy 任务卡：A2-D-B-REV-01 定稿不被摘要配置阻断

## 开始前

读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/tasks/A2-D-B-summarizer-workflow.md`
4. 本任务卡
5. `apps/web/app/api/works/[id]/chapters/[chapterId]/finalize/route.ts`
6. `apps/web/test/chapter-finalize-api.test.ts`
7. `packages/workflow/src/chapter/finalize.ts`
8. `packages/workflow/src/provider.ts`
9. `packages/workflow/src/providers/openai-compatible.ts`
10. `packages/workflow/test/chapter-summary-workflow.test.ts`

前置条件：

- 当前 HEAD 包含 A2-D-B 提交 `5bdec97`；
- 工作区干净；
- 只在同一未推送的 A2-D-B 范围内修复审问题；
- 不新增 API 字段，不修改已验收历史 migration；
- 需要空库时使用一次性临时数据库，不删除 `_prisma_migrations`。

## 复审阻塞问题

当前 finalize 路由在调用 `finalizeChapter()` 之前执行：

```ts
const provider = createModelProvider(readProviderConfig());
```

`OpenAICompatibleProvider` 构造时会校验 Base URL、API Key 和模型名，缺失或非法会抛
`MODEL_NOT_CONFIGURED`。

结果是：**模型服务配置异常时，章节无法定稿**。这违反已冻结原则：

- 摘要只是派生数据；
- 摘要任务 / Provider 失败不得回滚定稿；
- 作者即使不使用 AI，也应能完成正式版本定稿。

第二个同源问题：摘要 task 已存在时，如果 provider / model 配置后来变化，
`ensureDeterministicTask` 会因为新 inputHash 与旧 task 不同而抛内部错误。
这会让“同版本幂等定稿”在模型配置漂移后变成失败，也会阻断作者继续工作。

## 修复目标

把“定稿”和“摘要任务可调度性”解耦：

1. 模型配置正常 → finalize 与摘要任务同事务提交，保持现有行为。
2. 模型配置缺失 / 非法 → **定稿仍然成功**，不创建摘要任务；
   HTTP 请求 / 响应字段不变，不在响应里暴露 Provider 配置错误。
3. 后续同版本幂等定稿在配置恢复后，可以补齐缺失的摘要 task。
4. 任何情况下都不得构造模型请求、联网或读取 Key 到响应 / 日志。

推荐实现方向：

- finalize API 在服务端做 **best-effort summary spec 解析**；
- 配置合法时返回 `{ provider, model }`；
- 捕获 `ModelProviderError('MODEL_NOT_CONFIGURED')` 并返回 `null`，不得把错误
  传给 finalize 调用；
- `FinalizeChapterInput.summary` 改为可空；
- `summary === null` 时：
  - 首次定稿照常写状态与审计，只跳过 summary task；
  - 已定稿幂等返回不创建 task；
  - `FinalizedChapter.summaryTaskId` 需要允许 null，或改为内部 optional；
  - HTTP 响应仍不包含 summary task 字段。

不要用假的 provider / model 或 `"unconfigured"` 占位值创建任务。

已有 summary task 的幂等规则：

- 若同一 requestId / taskType / chapterId / sourceVersionId 的 task 已存在：
  - 即使当前 provider/model 与旧 task 不同，也必须返回既有 task；
  - 不得覆盖旧 provider/model，不得新建第二行，不得让 finalize 失败；
  - 仍然由 Worker 的 provider/model 预检决定旧 task 是否可执行；
- requestId 对应的逻辑输入不一致（例如 sourceVersionId / chapter / taskType 不同）
  才按内部错误拒绝；
- 这项规则只用于确定性内部任务，不改变作者显式生成任务的 request-conflict 语义。

## 测试要求

### API

新增 / 调整 `chapter-finalize-api.test.ts`：

1. `MODEL_PROVIDER=openai-compatible` 且缺 Base URL / Key / Model 时，
   finalize 仍返回 200，章节为 finalized；
2. 上述情况不创建 `chapter.summarize` task，不产生 LLM 日志；
3. 响应字段仍只有原有 5 个 chapter 字段，不出现配置错误或 provider/model；
4. 配置恢复为 mock 后，同版本重复定稿返回 200 `deduplicated=true`，
   并补齐一个 summary task；
5. 合法 OpenAI-compatible 配置路径仍记录正确的 provider/model 元数据，
   但测试不得联网；
6. summary task 已存在且 provider/model 配置漂移时，重复定稿仍返回 200
   `deduplicated=true`，复用既有 task，不覆盖 provider/model、不新增任务；
7. 配置漂移后的 Worker 预检仍按既有规则返回模型配置不一致；
   不得由 finalize 静默改写 task。

### Workflow

保持并复跑 A2-D-B 的：

- 首次定稿原子入队；
- 同版本幂等；
- task 缺失恢复；
- stale / revision；
- append-only；
- 旧 Worker / 取消；
- LLM 日志边界。

## 文档

更新：

- `docs/08-workflow-and-agents.md` §26：说明配置不可用时只跳过摘要调度，不阻断定稿；
- `docs/09-project-memory.md`：完成后更新能力、风险、测试数与下一步；
- `docs/07-master-roadmap.md`：A2-D-B 状态与历史行；
- 不需要 migration / 数据表变化。

明确记录：模型配置恢复后，需要对已定稿版本再次调用幂等 finalize 才会补任务；
本轮不新增手动重建接口。

## 验证

```bash
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

灵敏度验证：

1. 恢复“Provider 构造失败直接阻断 finalize”的行为，确认新 API 用例失败，
   修复后通过；
2. 配置恢复后的幂等 finalize 不补 task，确认恢复用例失败，修复后通过。
3. 恢复“inputHash 不同即拒绝”的行为，确认配置漂移下的幂等定稿用例失败，
   修复后通过。

## 不做

- 新 API / UI；
- 手动重建摘要入口；
- Reviewer `priorSummaries` 接线；
- 修改章节定稿业务状态机；
- 伪造 Provider 配置或静默记录 Key；
- 推送远端。

## 交付

本地提交，不推送。汇报提交号、配置失败下的定稿证据、恢复补任务证据、
测试数与全量门禁、灵敏度结果、未做项和工作区状态，等待复审。
