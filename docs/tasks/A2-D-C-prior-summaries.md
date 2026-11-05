# WorkBuddy 任务卡：A2-D-C Reviewer 前章摘要接线

## 开始前

读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. 本任务卡
4. `packages/workflow/src/chapter/review.ts`
5. `packages/workflow/src/chapter/review-workflow.ts`
6. `packages/workflow/src/chapter/summary.ts`
7. `packages/workflow/src/chapter/reviewer.ts`
8. `packages/workflow/test/chapter-review-workflow.test.ts`
9. `packages/workflow/test/chapter-summary-workflow.test.ts`

前置条件：

- A2-D-B 与 A2-D-B-REV-01 已验收；
- `chapter_summaries` 只包含成功摘要；
- 工作区干净；
- 本轮只接线 Reviewer 的 `priorSummaries`，不做 API / UI / RAG。

## 目标

审阅当前章节候选时，为 Reviewer 提供**同作品、前序、当前仍定稿且摘要对应当前
最新正式版本**的章节摘要。

没有摘要时不猜测、不用正文临时生成、不跨作品补全。

## 选择规则

固定规则：

- 只选 `chapterNo < 当前章节 chapterNo`；
- 只选 chapter status = `finalized`；
- summary 的 sourceVersionId 必须是该前序章节当前最新正式版本；
- 同一章节最多一条；
- 不跨作品；
- 按 chapterNo 倒序取最近的 20 条，再按 chapterNo 升序放入
  `priorSummaries`，保持叙事时间顺序；
- 每条 `{ chapterNo, summary }`，summary 已由 A2-D-A 保证 ≤1000；
- 不读取秘密字段、不读正文来填充缺失摘要。

## 实现要求

- 扩展 `buildChapterReviewContext` / 对应事务查询；
- 查询必须显式带 `work_id` 与 status 条件，禁止跨作品；
- 必须在 Reviewer 输入 Schema 上限内：最多 20 条、每条 ≤1000；
- `task_contexts` 可增加 `chapter_summary` 来源，只记录 summary id / 前章号；
  不复制摘要全文；
- 当前章节自己的摘要不得进入；
- 未来章节摘要不得进入；
- 前章已 revision / in_review 时，其旧摘要不得进入；
- 前章重新定稿且新摘要成功后，应使用新版本摘要；
- 不存在摘要时数组为 `[]`，Reviewer 照常运行。

## 测试

至少覆盖：

1. 两个前序定稿章节摘要按 chapterNo 升序进入 Reviewer 输入；
2. 当前章节摘要不被选中；
3. 未来章节摘要不被选中；
4. 其它作品摘要不被选中；
5. 前序章节 revision 后 status != finalized，旧摘要不进入；
6. 前序章节重新定稿并有新摘要后，使用新摘要；
7. 同一章节不会因历史摘要出现多条；
8. 21 个前序摘要只取最近 20 章，顺序正确；
9. 无摘要时 `priorSummaries=[]`；
10. task_contexts 不含摘要正文；
11. 现有 Reviewer 输出语义校验 / 失败隔离不回归。

必须使用真实 PostgreSQL，不联网、不使用 skip。

## 文档

- `docs/08-workflow-and-agents.md` 增加接线说明；
- `docs/09-project-memory.md` 更新能力、下一步、测试数、风险；
- `docs/07-master-roadmap.md` 更新 A2-D-C 状态与历史行；
- 不新增 migration，除非出现无法避免的数据完整性问题（先报告）。

## 验证

```bash
pnpm --filter @novel/workflow build
pnpm --filter @novel/workflow typecheck
pnpm --filter @novel/workflow test
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

灵敏度验证：

1. 取消 `chapterNo < 当前章` 条件，确认未来章节泄漏用例失败，恢复后通过；
2. 取消 `status='finalized'` 或 latest-version 条件，确认 revision 旧摘要用例失败，
   恢复后通过。

## 不做

- 摘要读取 API / UI；
- 事实 UI；
- RAG / embedding / 图谱；
- 摘要回写正文；
- high severity 采纳门禁；
- 推送远端。

## 交付

本地提交，不推送。报告提交号、选择规则、测试数、全量门禁、两次灵敏度、
未做项和工作区状态，等待复审。
