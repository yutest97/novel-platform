# WorkBuddy 任务卡：A2-D-D 章节版本摘要只读 API

## 开始前

读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. 本任务卡
5. `docs/08-workflow-and-agents.md` §26
6. `packages/workflow/src/chapter/summary.ts`
7. `packages/workflow/src/chapter/review-read.ts`
8. 现有章节版本只读 API 与测试
9. `apps/web/src/lib/api.ts` 的严格客户端模式

前置条件：

- A2-D-B（含 REV-01）已验收；
- 工作区干净；
- 本轮只新增摘要只读 API 与客户端函数；
- 不做摘要 UI，不新增 migration，不触发摘要任务。

## 目标

新增：

```text
GET /api/works/:workId/chapters/:chapterId/versions/:versionId/summary
```

返回某个正式章节版本已成功生成的摘要。摘要按 version 定位，避免把“当前最新版本”
误当成历史版本的摘要。

## 响应契约

```json
{
  "summary": {
    "id": "uuid",
    "chapterId": "uuid",
    "sourceVersionId": "uuid",
    "versionNo": 3,
    "summary": "章节摘要",
    "agentName": "summarizer.chapter",
    "agentVersion": "1.0.0",
    "createdAt": "ISO-8601"
  }
}
```

边界：

- 只返回已成功落库的摘要，不返回 generation task、provider/model、租约或 prompt；
- summary 已由数据库 CHECK 保证 1..1000 且非空；
- 不返回正文全文，不返回未成功的摘要 task；
- HTTP 日期统一 ISO 字符串；`Cache-Control: no-store`；
- 无摘要 → 404 `SUMMARY_NOT_FOUND`。

## 查询与权限

- 先 `requireOwnedWork`，再校验 chapter 属于 work、version 属于 chapter；
- 非作者 / 跨作品 / 跨章节 / 随机 id 统一 404 `SUMMARY_NOT_FOUND`；
- 管理员普通作品路由 403，未登录 401；
- summary 按 `(sourceVersionId, chapterId, workId)` 读取；
- versionNo 通过 `chapter_versions` 关联读取，不信任记忆中的版本号；
- 只读，不写审计，不修改章节 / 版本 / summary / task。

## 实现边界

- 新增 workflow 显式 DTO 与 `getChapterVersionSummaryForAuthor`；
- 新增 Next route；
- 新增 `SUMMARY_NOT_FOUND` 到 auth error code 与 status / message 映射；
- 新增前端 `fetchChapterVersionSummary()`，严格解析成功响应；
- 不新增 UI 状态。

## 测试

至少覆盖：

1. 有摘要 → 200、字段完整、日期 ISO；
2. 无摘要但版本存在 → 404 SUMMARY_NOT_FOUND；
3. 跨作品 / 跨章节 / 随机 versionId → 404；
4. 未登录 401、管理员 403；
5. 响应不含正文、provider/model、task 字段；
6. 只读请求不新增 audit_logs，也不改任何表；
7. 客户端严格解析成功；
8. 客户端解析失败收敛为 INTERNAL_ERROR；
9. 404 保留 SUMMARY_NOT_FOUND；
10. 历史版本的摘要可单独读取，不会被当前版本摘要替换。

使用真实 PostgreSQL，不联网、不使用 skip。

## 文档

- `docs/08-workflow-and-agents.md` 增加 A2-D-D API 小节；
- `docs/09-project-memory.md` 更新能力、下一步、测试数、风险；
- `docs/07-master-roadmap.md` 更新摘要读取状态与历史行；
- 不修改 `docs/03`（无 schema 变化）。

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

1. 忽略 chapter 归属条件，确认跨章节读取用例失败，恢复后通过；
2. 用当前最新版本摘要代替 sourceVersionId 查询，确认历史版本摘要用例失败，
   恢复后通过。

## 不做

- 摘要 UI；
- 摘要重试 / 手动重建；
- Reviewer UI 修改；
- 事实 UI；
- RAG / 图谱；
- migration / 推送远端。

## 交付

本地提交，不推送。汇报提交号、路由 / DTO、权限隔离、测试数、全量门禁、
两次灵敏度、未做项和工作区状态，等待复审。
