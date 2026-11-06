# WorkBuddy 任务卡：A2-D-E 章节版本摘要展示 UI

## 开始前

读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. 本任务卡
5. `docs/08-workflow-and-agents.md` §30
6. `apps/web/src/lib/chapter-summary-view.ts`
7. `apps/web/src/lib/api.ts` 的 `fetchChapterVersionSummary`
8. `apps/web/app/works/[id]/chapters/[chapterId]/page.tsx` 的正式版本 / 阅读区
9. 章节工作台现有 E2E

前置条件：

- A2-D-D 已验收；
- 工作区干净；
- 本轮只做摘要展示，不改后端、不触发摘要任务、不新增 migration；
- 不做摘要重试 / 重建。

## 目标

在章节工作台的正式版本区域展示所选版本的已落库摘要：

- 版本被选中后读取该 `versionId` 的摘要；
- v1 / v2 等历史版本各自展示自己的摘要；
- 无摘要时显示信息态；
- 读取错误只影响摘要面板，不影响版本正文阅读、diff、恢复或定稿。

## UI 行为

### 1. 加载与请求身份

- 选中正式版本后立即读取 summary；
- 切换版本、离开页面、卸载时停止旧请求；
- 请求身份使用单调序号，不用 versionId；
  - 同一版本重新读取；
  - v2 → v1 → v2 快速切换；
  - 只有最新请求可写 summary / error / loading；
- 旧请求晚返回必须完全静默。

### 2. 状态展示

- 加载中：`正在读取版本摘要…`
- 成功：折叠式或独立卡片展示摘要；
- 404 `SUMMARY_NOT_FOUND`：
  - 文案 `该版本暂无摘要`
  - 说明 `摘要可能仍在生成、生成失败，或定稿时模型未配置。`
  - 信息态，不是 red error；
- 网络 / 5xx / 解析失败：
  - `版本摘要读取失败`
  - 局部「重新读取」按钮；
  - 不覆盖正文、错误、版本操作提示。

### 3. 摘要展示

- 使用 React 纯文本节点；
- `white-space: pre-wrap`，保留换行；
- 禁止 `dangerouslySetInnerHTML`；
- 显示版本号与生成时间；
- 不显示 provider / model / task / prompt / requestId；
- 摘要不写入 URL、localStorage、sessionStorage；
- 移动端自然换行，不横向撑破。

### 4. 与版本操作边界

- 查看摘要不改变所选版本、正文、diff、恢复、定稿状态；
- 摘要缺失或失败不改变任何按钮的可用性；
- 摘要不自动回写正文；
- 若版本编辑器打开，摘要读取失败不得关闭编辑器或覆盖未保存内容。

## 实现建议

- 新增纯展示辅助模块，集中加载 / 缺失 / 错误文案；
- 摘要状态放在页面或版本阅读组件局部状态；
- 可增加 `fetchChapterVersionSummary` 的可选 AbortSignal，但不改变现有调用；
- 不新增全局 Toast；
- 不新增轮询：当前 API 不提供摘要任务状态，404 不能证明“正在生成”。

## 测试

### 纯函数 / 客户端状态

1. loading / ready / notfound / error 文案与色调；
2. 摘要保留换行与中文；
3. 未知状态安全回退；
4. 请求序号边界。

### 浏览器 E2E

1. 选中版本后显示对应摘要；
2. 历史版本显示自己的摘要，不被最新版覆盖；
3. `SUMMARY_NOT_FOUND` 显示“该版本暂无摘要”，正文仍可读；
4. 读取失败只影响摘要卡片，局部重试可用；
5. 快速切换版本，旧请求晚返回不覆盖；
6. 摘要中含 `<script>` / HTML 文本时按纯文本显示，不执行；
7. 打开编辑器后读取摘要失败，未保存草稿仍在；
8. 移动端摘要卡片不横向撑破；
9. 现有 diff / 恢复 / 定稿 / 编辑流程不回归。

E2E 可拦截 summary 请求提供确定性响应，不得依赖真实模型。

## 文档

- `docs/08-workflow-and-agents.md` 增加摘要 UI 行为；
- `docs/09-project-memory.md` 更新能力、下一步、测试数、风险；
- `docs/07-master-roadmap.md` 更新摘要 UI 状态与历史行；
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

1. 移除摘要请求序号检查，确认快速切换版本用例失败，恢复后通过；
2. 把摘要改成 HTML 渲染，确认纯文本安全用例失败，恢复后通过。

## 明确不做

- 摘要重试 / 重建 / 回写正文；
- 摘要任务状态查询；
- Reviewer UI 修改；
- 事实 UI；
- RAG / 图谱；
- 后端 / migration 修改；
- 推送远端。

## 交付

本地提交，不推送。汇报提交号、UI 状态、请求隔离、纯文本安全证据、测试与 E2E、
两次灵敏度、未做项和工作区状态，等待复审。
