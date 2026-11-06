# WorkBuddy 任务卡：A2-E 事实候选只读审阅 UI

## 开始前

读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. 本任务卡
5. `docs/08-workflow-and-agents.md` §21、§22
6. `apps/web/src/lib/api.ts` 的连续性事实客户端
7. 事实 extract / list / candidate / run 的现有 API 与测试
8. 章节工作台现有版本 / 摘要 / Reviewer 面板模式

前置条件：

- A2-B 已验收；
- 当前工作区干净；
- 只做事实候选只读 UI；
- 不做事实接受 / 拒绝 / 写回实体，不改 migration。

## 目标

在章节工作台增加事实审阅区：

- 对当前定稿最新版本显式触发事实提取；
- 展示六类事实候选；
- 支持 `factType` 过滤；
- 展示 `total / truncated`、空态、加载和稳定错误态；
- 不自动修改人物、物品、势力、关系或境界。

## UI 行为

### 1. 提取入口

- 仅当章节 `finalized` 且所选版本是当前最新正式版本时显示“提取事实”；
- 点击后调用 `extractChapterFactsFromApi(workId, chapterId, sourceVersionId)`；
- 同版本已有成功 run（`created=false`）提示“已读取既有结果”；
- 提取中按钮禁用，不重复提交；
- `IN_PROGRESS` / `LEASE_LOST` / `NOT_FINALIZED` / `SOURCE_VERSION_STALE` 使用稳定中文提示；
- 成功后刷新候选列表，不自动采纳。

### 2. 过滤与列表

- 筛选项：全部、人物状态、关系变化、物品变化、境界进展、情节线索、人物位置；
- 使用 `fetchChapterFacts` 的 `factType`，不客户端伪造过滤；
- 请求使用单调序号，快速切换 filter 时旧响应静默；
- 展示 `total`；
- `truncated=true` 时明确提示“仅显示最近 200 条”，不得静默；
- 空结果分两种文案：
  - 尚无候选：提示提取；
  - 当前 filter 为空：提示切换筛选。

### 3. 候选卡片

每条展示：

- 中文 factType；
- summary / reason；
- subjectId / objectId / name / threadStatus 只以安全名称或简短 id 展示；
- 创建时间；
- 不展示正文、prompt、模型原始响应或 attemptToken；
- 所有文本使用 React 纯文本节点，禁止 `dangerouslySetInnerHTML`；
- summary / reason 长文本自然换行，移动端不横向撑破。

### 4. 错误与边界

- 读取失败只影响事实区，不覆盖正文 / 版本 / 摘要 / Reviewer / 编辑器；
- 提供局部重新读取；
- 不新增接受 / 拒绝 / 批量选择 / 自动写回按钮；
- 不修改章节状态、版本、实体或物品事件；
- 抽取中的页面刷新不得留下 UI 永久 loading；刷新后可按 API 状态重新读取。

## 实现建议

- 新增纯展示模块集中六类标签、空态、截断和错误文案；
- 页面状态只保存在组件内存，不写 localStorage / sessionStorage；
- 不把正文或候选 payload 写入 URL / 日志；
- 不新增事实轮询，除非 API 已明确提供可轮询 run 状态；如增加轮询，需用序号 + abort。

## 测试

### 纯函数

1. 六类标签与未知值回退；
2. total / truncated 文案；
3. 无候选与 filter 空态文案；
4. 提取错误码中文文案；
5. 请求序号边界。

### 浏览器 E2E

1. 定稿最新版可触发提取，created=true 后显示候选；
2. created=false 提示既有结果；
3. 六类 filter 请求与结果正确；
4. truncated=true 显示截断提示；
5. 空结果与 filter 空态区别；
6. 提取 / list 错误只影响事实区，正文可读；
7. 快速切换 filter 时旧响应不覆盖；
8. summary / reason 中 HTML 按纯文本显示；
9. 不存在接受 / 写回按钮；
10. 移动端不横向撑破。

## 文档

- `docs/08-workflow-and-agents.md` 增加事实 UI 行为；
- `docs/09-project-memory.md` 更新能力、下一步、测试数、风险；
- `docs/07-master-roadmap.md` 更新 A2-E 状态与历史行；
- `docs/03` 不改（无 schema 变化）。

## 验证

```bash
pnpm --filter @novel/web test
pnpm --filter @novel/web typecheck
pnpm --filter @novel/web build
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm --filter @novel/web test:e2e
git diff --check
```

灵敏度验证：

1. 去掉 filter 请求序号检查，确认快速切换用例失败，恢复后通过；
2. 让 truncated 不展示提示，确认截断用例失败，恢复后通过。

## 明确不做

- 事实接受 / 拒绝；
- 实体或物品事件写回；
- 批量决策；
- 自动重写 / 摘要重建；
- RAG / 图谱；
- migration / 推送远端。

## 交付

本地提交，不推送。汇报提交号、UI 状态、提取与筛选证据、纯文本安全、测试与 E2E、
两次灵敏度、未做项和工作区状态，等待复审。
