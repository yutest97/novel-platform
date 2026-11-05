# WorkBuddy 任务卡：A2-D-A Summarizer Agent 契约与校验

## 开始前

只读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. 本任务卡
5. `packages/workflow/src/agent.ts`
6. `packages/workflow/src/chapter/reviewer.ts`
7. `packages/workflow/src/chapter/reviewer-mock.ts`
8. `packages/workflow/test/chapter-reviewer-agent.test.ts`

前置条件：

- A2-C-B-REV-01 已验收；
- 当前 HEAD 工作区干净；
- 本卡只建立 Agent 契约层，不接数据库、不接工作流、不接 API / UI / Worker。

## 目标

新增：

```text
summarizer.chapter@1.0.0
```

它只把一章正式定稿版本的正文变成可追溯的章节摘要；实际“是否已定稿、是否最新正式
版本、幂等与落库”由后续 A2-D-B 工作流负责，本卡不得自行访问数据库。

## 输入契约

严格 JSON，未知字段一律拒绝：

```json
{
  "chapter": {
    "id": "uuid",
    "chapterNo": 1,
    "title": "章节标题"
  },
  "sourceVersion": {
    "id": "uuid",
    "versionNo": 1
  },
  "chapterText": "正式定稿正文"
}
```

约束：

- `chapter.id`、`sourceVersion.id` 必须是 UUID；
- `chapterNo / versionNo` 必须是 1..100000 的整数；
- `title` trim 后非空，≤200 字符；
- `chapterText` 1..200000 字符；
- 不接受 `prompt`、`secret`、`secretKnownBy`、模型原始响应、API Key；
- `sourceVersion` 是追溯标识，不要求 Agent 自己判断数据库状态。

## 输出契约

严格 JSON：

```json
{
  "summary": "本章摘要"
}
```

约束：

- 只允许 `summary`，未知字段拒绝；
- Schema 上限 1000 字符；代码在 trim 后再次确认非空、≤1000；
- 摘要应包含：本章关键事件、人物状态变化、重要物品/关系/境界变化、
  未解决线索；没有的类别不编造；
- 摘要不得包含 Markdown 标题、代码块、prompt、密钥或数据库内部字段；
- 错误只返回路径 / 固定原因，不回显正文或摘要内容；
- 非法输出统一使用稳定 `AGENT_OUTPUT_INVALID` 语义错误。

## Agent 与 Mock

`summarizer.chapter@1.0.0`：

- `model` 为空，由 Provider 决定；
- `maxOutputTokens` 合理覆盖 1000 字摘要；
- role prompt 明确“只摘要、不续写、不修改正文、不输出多个方案”。

新增 `createChapterSummarizerMockProvider()`：

- `name=mock`、`defaultModel=mock-model`；
- 默认输出确定、合法、非空，且不读系统时钟 / Key / 网络；
- 可注入固定 summary 供测试；
- 不修改通用 `MockProvider`。

新增纯内存 `runChapterSummarizer()`：

- 先经 `AgentRunner` 做输入 / Schema 校验；
- 再执行专用 `validateSummarizerOutput()`；
- 不写日志、不写数据库、不决定下一步。

## 测试

新增 `packages/workflow/test/chapter-summarizer-agent.test.ts`，至少覆盖：

1. Agent 定义合法，完整输入和合法输出通过；
2. 缺 chapter / sourceVersion / chapterText；
3. 非 UUID、版本号越界、标题空白；
4. chapterText 上限与 200001 拒绝；
5. 顶层 / 嵌套未知字段拒绝；
6. prompt / secret / secretKnownBy / 原始响应字段拒绝；
7. summary 空白、纯换行、超长；
8. summary 恰好 1000 字符可接受；
9. 中文、emoji、换行保留；
10. 输出未知字段拒绝；
11. 非法输出为 `AGENT_OUTPUT_INVALID` 且不泄露正文；
12. Mock 默认输出合法、名称和模型正确；
13. Mock 注入固定 summary；
14. 通过 `AgentRunner` + fake Provider 完成一次调用。

所有测试为纯单测，不联网、不连库。

## 边界

不做：

- `chapter_summaries` 表 / migration；
- 定稿版本查询、幂等、租约、attempt fencing；
- `chapter.summarize` 任务 / Worker 注册；
- Reviewer `priorSummaries` 接线；
- API / UI；
- RAG / embedding / 图谱；
- 自动摘要回写章节或正式版本。

## 文档

完成后：

- `docs/03-data-model.md` 本卡不改；
- `docs/08-workflow-and-agents.md` 只追加 A2-D-A Agent 契约小节；
- `docs/09-project-memory.md` 更新当前下一步、测试数、风险和决策；
- `docs/07-master-roadmap.md` 更新 A2-D-A 状态；
- 不修改已验收历史 migration。

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

1. 移除 `summary.trim()` 后的空白检查，确认空白用例失败，恢复后全绿；
2. 移除输出 Schema 的未知字段拒绝或改为允许，确认未知字段用例失败，恢复后全绿。

## 交付

- 本地提交，不推送；
- 汇报提交号、输入 / 输出契约、Mock、测试数、验证结果；
- 汇报灵敏度结果、未做项和工作区状态；
- 等待复审。
