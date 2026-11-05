# WorkBuddy 任务卡：A2-C-E Reviewer 结果展示 UI

## 开始前

读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. 本任务卡
5. `docs/08-workflow-and-agents.md` §24、§28
6. `apps/web/src/lib/chapter-review-view.ts`
7. `apps/web/src/lib/api.ts` 的 `fetchChapterReview`
8. `apps/web/app/works/[id]/chapters/[chapterId]/page.tsx`
9. 章节工作台现有 E2E

前置条件：

- A2-C-D 已验收；
- 工作区干净；
- 本轮只做 Reviewer 结果展示，不改后端、review 数据或采纳规则；
- 不新增 migration、API、手动重检入口。

## 目标

在章节工作台的候选正文区域展示对应审阅状态和结构化问题：

- 候选被选中后读取 `GET /candidates/:candidateId/review`；
- queued / processing / run=null 时轮询；
- 成功后展示 passed 或问题；
- 失败 / 取消时展示安全、可理解的状态；
- 历史候选没有审阅任务时展示“暂无审阅结果”，不是整页错误；
- **high severity 只是警告，不阻止候选采纳**。

## UI 行为

### 1. 加载与轮询

- 选择候选后立即请求 review；
- task `queued / processing` 或 `run.status='running'` 时轮询；
- 推荐 1s → 2s → 5s 退避，任务终态停止；
- task 已终态但 run=null：
  - `cancelled` → “审阅已取消”；
  - `failed` → “审阅失败”；
  - `succeeded` 但 run=null 属于异常响应，显示稳定错误态，不无限轮询；
- 切换候选、离开页面、卸载时停止旧轮询；
- 旧请求晚返回不得覆盖新候选的 review / error / loading 状态。

### 2. 状态展示

- task queued：`等待审阅…`
- processing：按白名单步骤显示
  - `load_review_input`：`准备审阅上下文…`
  - `run_reviewer`：`模型审阅中…`
  - `persist_review_result`：`保存审阅结果…`
- run failed / task failed：`审阅未完成，不影响当前候选采纳`
- task cancelled：`审阅已取消`
- run succeeded + passed=true：`未发现结构性问题`
- run succeeded + passed=false：显示问题总数与 high / medium / low 统计

### 3. 问题展示

按 ordinal 顺序显示：

- severity 中文标签：`高 / 中 / 低`；
- type 中文标签：
  - 合同偏离
  - 设定矛盾
  - 时间线冲突
  - 物品状态冲突
  - 情节线冲突
  - 人物一致性
  - 文风问题
- evidence 与 suggestion 使用 React 纯文本渲染；
- 禁止 `dangerouslySetInnerHTML`；
- evidence 是正文原句，允许换行但不得注入 HTML；
- 列表过长时自然换行，移动端不得横向撑破。

### 4. 错误与缺失

- `REVIEW_NOT_FOUND` → 信息态“暂无审阅结果”，不是红色系统错误；
- `INTERNAL_ERROR` / 网络失败 → 显示“审阅结果读取失败”，提供局部“重新读取”按钮；
- 错误只影响 review 面板，不影响候选正文读取、采纳按钮或其它页面；
- 没有审阅结果时不显示“重新审阅”按钮（本轮无手动重检）。

### 5. 采纳边界

- 采纳按钮的可用性仍只由现有章节 / 候选状态决定；
- high / medium / low 均不禁止或二次阻塞采纳；
- 可保留普通确认弹窗；
- UI 文案明确“检查结果仅供作者参考”，不自动修改正文。

## 实现建议

- 新增纯展示辅助模块，集中 severity / type / task step 中文标签与统计；
- 将 review 状态放入页面局部状态，不写 localStorage / sessionStorage；
- 不把候选正文或 evidence 放入 URL；
- 不修改 `fetchChapterReview` 的成功返回契约；
- 可增加 `fetchChapterReview` 的可选 AbortSignal，但不得改变现有调用；
- 不新增全局 Toast 或会覆盖生成 / 采纳提示的错误。

## 测试

### 纯函数测试

至少覆盖：

1. severity / type / step 中文标签；
2. high / medium / low 统计；
3. 未知值不崩溃，回退为安全通用文案；
4. passed / failed / cancelled / queued 的展示状态。

### 浏览器 E2E

至少覆盖：

1. 候选预览后显示审阅中，再显示“未发现结构性问题”；
2. 有 high / medium / low 问题时可展开/查看，evidence 与 suggestion 正确；
3. evidence 中含 `<script>` / HTML 文本时按纯文本显示，不执行；
4. high severity 存在时采纳按钮仍可点击；
5. `REVIEW_NOT_FOUND` 显示“暂无审阅结果”，候选仍可采纳；
6. 读取失败只影响 review 面板，局部重试可用；
7. 快速切换两个候选，旧候选晚返回不覆盖新候选 review；
8. 移动端视口下问题列表不横向撑破；
9. 现有生成、候选预览、采纳、版本流程不回归。

E2E 可使用 request interception 提供确定性 review 响应；不得依赖真实模型。

## 文档

- `docs/08-workflow-and-agents.md` 增加 UI 展示行为与采纳边界；
- `docs/09-project-memory.md` 更新能力、下一步、测试数、风险；
- `docs/07-master-roadmap.md` 更新 A2-C-E 状态与历史行；
- 不修改 `docs/03`（无 schema 变化）。

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

1. 恢复旧请求可覆盖状态的行为，确认快速切换候选用例失败，修复后通过；
2. 让 high severity 禁用采纳按钮，确认“high 仍可采纳”用例失败，恢复后通过。

## 明确不做

- 手动重检 / 重试 / 取消审阅；
- high severity 采纳门禁；
- 自动重写正文；
- 摘要读取 API / UI；
- 事实 UI；
- 后端 / migration 修改；
- 推送远端。

## 交付

本地提交，不推送。汇报提交号、UI 状态、轮询 / 旧请求隔离、纯文本安全证据、
测试与 E2E、两次灵敏度、未做项和工作区状态，等待复审。
