# WorkBuddy 任务卡：A2-C-B-REV-01 Reviewer 终态一致性修复

## 开始前

只读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/tasks/A2-C-B-reviewer-execution.md`
4. 本任务卡
5. `docs/03-data-model.md` §3.12
6. `docs/08-workflow-and-agents.md` §24
7. `packages/db/prisma/migrations/20261106090000_a2c_review_runs/migration.sql`
8. `packages/workflow/src/chapter/review.ts`
9. `packages/workflow/src/chapter/review-workflow.ts`
10. `packages/workflow/test/chapter-review-workflow.test.ts`

前置条件：

- 当前 HEAD 必须包含 A2-C-B 提交 `a194a33`；
- 工作区必须干净；
- 不要 cherry-pick 任何历史本地修补提交；按当前代码和本卡重新实现；
- 不修改已验收的历史 migration；
- 本轮只修 A2-C-B 一致性与回归测试，不开始 Summarizer / API / UI。

## 复审发现

### 阻塞问题：终态 run 仍可追加 issue

当前迁移只拒绝 `chapter_review_issues` 的 UPDATE / DELETE。run 已经
`succeeded / failed` 后，仍可直接 INSERT 新 issue：

- `chapter_review_runs.issue_count` 会与真实 issue 数量失配；
- 成功结论不再不可变；
- 现有“问题表归属与顺序”测试正是在已成功 run 后插问题，掩盖了该缺口。

### 测试缺口：failed 终态兜底未直接验证

迁移已有 `generation_tasks_close_review_run`：

- 已覆盖 `processing → cancelled`；
- 未直接覆盖 `processing → failed` 时关闭仍在 running 的 run。

触发器实现方向正确，本轮需要补真实 PostgreSQL 回归测试；不要另造第二套状态机。

## 修复要求

### 1. 在同一个未推送 migration 内增加 INSERT 守卫

修改 `20261106090000_a2c_review_runs/migration.sql`，不新增 migration。

增加 `chapter_review_issues` 的 `BEFORE INSERT` trigger：

- 仅当对应 run 的
  `id / candidate_id / chapter_id / work_id` 全部匹配且 `status='running'` 时放行；
- `succeeded / failed`、run 不存在或归属不一致时拒绝；
- 稳定拒绝原因必须明确表达“只有 running 的 review run 可以追加问题”；
- 不改变 `persist_review_result` 的合法顺序：
  同一事务先 INSERT running issues，再把 run 标为 succeeded。

迁移文件头部注释同步说明：

- UPDATE / DELETE 永远拒绝；
- INSERT 只允许 running；
- 成功后 `issue_count` 不会被后续追加破坏。

### 2. 调整既有数据库约束测试

`问题表的归属与顺序由数据库兜底` 目前先用完整工作流把 run 变为 succeeded，再直接
插入测试 issue。新守卫生效后这是非法操作。

改为：

- Writer 候选完成后领取 review task；
- 调用 `prepareReviewRun()`，让 run 停在 `running`；
- 在 running 状态下继续覆盖复合外键 / UNIQUE / CHECK；
- 测试结束后由现有 cleanup 清理 running run，不要降低约束覆盖。

### 3. 新增终态一致性回归

在 `chapter-review-workflow.test.ts` 增加至少：

1. 任务从 `processing` 以不可重试错误调用 `failTask(..., retryable:false)` →
   task `failed`，仍为 running 的 run 被触发器改为 `failed`，稳定 errorCode 保留，
   `finished_at` 非空，候选正文与章节状态不变；
2. succeeded run 后直接 INSERT issue 被拒绝；
3. failed run 后直接 INSERT issue 被拒绝；
4. running run 仍允许合法 issue INSERT（由既有约束用例覆盖）。

使用原生 SQL 断言插入守卫时，`restrict_violation` 可能被 Prisma 包装成外键错误；
应断言数据库确实拒绝，不依赖 ORM 包装后的固定文案。

### 4. 计数与文档

修复完成后按实际结果更新：

- `docs/03-data-model.md` §3.12；
- `docs/08-workflow-and-agents.md` §24；
- `docs/09-project-memory.md` 的测试 / 表 / 触发器数量；
- `docs/07-master-roadmap.md` 的 A2-C-B 历史行。

预期方向：

- 表仍为 22；
- 新 migration 内触发器由 13 增至 14；
- workflow 测试至少新增 2 个；
- 如果实现与本卡测试数量不同，以实际执行结果为准，不要猜。

## 禁止

- 不新增 API / UI / Worker 工作流；
- 不改变 high severity 的采纳规则；
- 不修改 `chapter.draft` 六步；
- 不修改已验收历史 migration；
- 不记录正文 / prompt / evidence 到日志或审计；
- 不使用 `skip` / `fixme`；
- 不推送远端。

## 验证

先确认数据库可用，并在**全新空库**应用 12 个 migration：

```bash
pnpm --filter @novel/db generate
pnpm db:deploy
pnpm --filter @novel/db test
pnpm --filter @novel/workflow build
pnpm --filter @novel/workflow typecheck
pnpm --filter @novel/workflow test
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

再做两次灵敏度验证：

1. 临时移除 INSERT 守卫，确认“终态后追加 issue”用例失败，恢复后通过；
2. 临时移除 `generation_tasks_close_review_run`，确认“processing → failed
   关闭 running run”用例失败，恢复后通过。

如本地存在与代码无关的 `bash` 平台限制，必须明确列出未能执行的既有用例；
不得把它们改成 skip。

## 交付

- 本地提交，不推送；
- 汇报提交号、修改文件、新增测试数、空库迁移结果、两次灵敏度结果；
- 汇报全量测试 / format / lint / typecheck / build；
- 汇报 migration / 表 / trigger 数；
- 工作区干净后等待复审。
