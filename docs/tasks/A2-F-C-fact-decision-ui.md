# WorkBuddy 任务卡：A2-F-C 事实候选决策 UI

## 前置

读取 `AGENTS.md`、`docs/09-project-memory.md`、`docs/07-master-roadmap.md`、本卡、
`docs/08-workflow-and-agents.md` §32–§34、事实面板、decision API 与现有 E2E。

A2-F-B 已验收，工作区干净。本卡只记录接受/拒绝，不写回任何实体或物品事件。

## 目标

- 未决定：接受 / 拒绝按钮；
- 已决定：accepted / rejected 徽章与决定时间；
- 冲突、过期、网络错误稳定提示；
- 只在章节 finalized 且候选属于当前最新正式版本时允许决定；
- 决策终态，不提供撤销 / 改判。

## UI 规则

### 可决定条件

- 章节 `finalized`；
- `candidate.sourceVersionId === 当前最新版本 id`；
- `candidate.decision === null`；
- 当前候选没有在提交决定。

旧版本显示「仅当前最新定稿版本可做决定」，按钮不可用。

### 操作

- 调用 `decideChapterFactFromApi`；
- 提交中两按钮禁用并显示「记录中…」；
- 成功后用响应更新该候选 decision，不重载整个列表；
- 同决定幂等成功也展示已决状态；
- `ALREADY_DECIDED` → 已做不同决定，不能改判；
- `DECISION_STALE` → 章节或版本已变化，不能继续决定；
- 其它错误只影响当前候选。

### 已决展示

- accepted：`已接受`，ok 色调；
- rejected：`已拒绝`，muted / warn 色调；
- 显示决定时间；
- 隐藏接受 / 拒绝按钮；
- 明确「决定已记录；当前不会自动修改人物、物品、势力、关系或境界。」

### 并发

- 每条候选独立 in-flight；
- 双击 / 同时点两按钮只发一个请求；
- filter / 列表刷新后旧响应不得覆盖新列表；
- 使用列表版本身份或请求序号；
- 决定失败不清空列表或覆盖提取提示。

## 数据边界

不展示 decidedBy、payload 副本、正文、prompt、provider/model；不写 Web Storage / URL；
无批量、撤销、改判或写回按钮。

## 测试

纯函数：canDecide 门禁、accepted/rejected 文案与色调、stale/already/网络错误、
未知 decision 回退。

E2E：接受成功、拒绝成功、同决定幂等、不同决定冲突且不翻转、旧版本/非定稿无按钮、
双击单请求、filter 切换旧响应不覆盖、失败只影响当前候选、提示不写回实体、移动端不撑破。

## 文档与验证

更新 `docs/08`、`docs/09`、`docs/07`；不改 `docs/03`，无 migration。

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

灵敏度：

1. 移除同一候选 in-flight 防重 → 双击用例失败；
2. 移除最新版本门禁 → 历史版本按钮用例失败。

## 不做

实体 / 物品事件写回、撤销 / 改判、批量决策、决策历史、RAG / 图谱、migration、推送远端。

## 交付

本地提交，不推送。汇报提交号、按钮 / 状态、幂等冲突证据、测试与 E2E、
两次灵敏度、未做项和工作区状态，等待复审。
