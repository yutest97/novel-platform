# WorkBuddy 任务卡：A2-C-D Reviewer 结果只读 API

## 开始前

读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. 本任务卡
5. `docs/08-workflow-and-agents.md` §14、§21、§22、§24
6. `packages/workflow/src/chapter/review.ts`
7. `packages/workflow/src/chapter/review-workflow.ts`
8. `packages/workflow/src/chapter/fact-read.ts`
9. 现有章节候选 / 事实只读 API 的 route、HTTP 校验和测试
10. `apps/web/src/lib/api.ts` 的只读客户端模式

前置条件：

- A2-C-B（含 REV-01）已验收；
- 当前工作区干净；
- 本轮只新增 Reviewer 结果读取 API，不做前端 UI；
- 不新增 migration，不修改 review run / issues。

## 目标

新增只读接口，让作者读取候选对应的 `chapter.review` 任务状态、review run 和 issues：

```text
GET /api/works/:workId/chapters/:chapterId/candidates/:candidateId/review
```

接口只读，不触发 Reviewer、不重试、不采纳、不写审计。

## 响应契约

统一返回：

```json
{
  "review": {
    "candidateId": "uuid",
    "task": {
      "id": "uuid",
      "status": "queued | processing | succeeded | failed | cancelled",
      "currentStep": "load_review_input | run_reviewer | persist_review_result | null",
      "attemptCount": 1,
      "errorCode": "STABLE_CODE | null"
    },
    "run": null
  }
}
```

存在 review run 时：

```json
{
  "review": {
    "candidateId": "uuid",
    "task": {
      "id": "uuid",
      "status": "succeeded",
      "currentStep": "persist_review_result",
      "attemptCount": 1,
      "errorCode": null
    },
    "run": {
      "id": "uuid",
      "status": "succeeded | failed | running",
      "passed": true,
      "issueCount": 1,
      "errorCode": null,
      "agentName": "reviewer.chapter",
      "agentVersion": "1.0.0",
      "startedAt": "ISO-8601",
      "finishedAt": "ISO-8601",
      "issues": [
        {
          "id": "uuid",
          "ordinal": 0,
          "severity": "high",
          "type": "setting_contradiction",
          "evidence": "正文原句",
          "suggestion": "修改建议"
        }
      ]
    }
  }
}
```

字段边界：

- `issues` 按 `ordinal asc`，最多 20 条；
- run running 时 `passed=null`、issues 为空；
- run failed 时 `passed=null`、issues 为空、errorCode 只回显稳定码；
- task `errorCode` 只回显稳定码；
- 不返回正文全文、prompt、模型原始响应、provider/model、租约或 attempt token；
- evidence 本身就是问题证据，按已落库内容返回；
- 不返回 inputSnapshot、inputHash、requestId 或其它内部任务字段。

## 查询与权限

- 先 `requireOwnedWork`，再校验 chapter 属于作品、candidate 属于章节和作品；
- 非作者 / 跨作品 / 随机 candidateId 一律 404，不通过错误码泄露存在性；
- 管理员普通作品路由 403；
- 未登录 401；
- review task 通过确定性 requestId `review:<candidateId>` 与
  `taskType='chapter.review'` 查找；
- run 通过 `generationTaskId` / `candidateId` 查找；
- 同一逻辑请求使用一个事务或等价的一致读取，避免 task 与 run 来自明显不同快照；
- 无 review task 的历史候选 → 404 `REVIEW_NOT_FOUND`（稳定错误码）；
- 有 task 但 run 尚未创建 → 200，`run=null`，供 UI 轮询；
- 只读，不写审计。

## 实现边界

- 新增 workflow 只读服务 + 显式 DTO，不直接返回 Prisma row；
- 新增 route，执行 Origin / session / params 校验；
- 新增前端客户端函数，只做严格响应解析，不新增页面 / 组件；
- 所有日期转 ISO 字符串；
- 响应使用 `Cache-Control: no-store`；
- 不暴露正文 / prompt / Key / 原始模型响应。

建议命名：

```text
getChapterReviewForAuthor(...)
REVIEW_NOT_FOUND
```

## 测试

新增 API / service 测试，至少覆盖：

1. queued task、run=null；
2. processing + running run；
3. succeeded/passed=true、issues=[]；
4. succeeded/passed=false，issue ordinal / severity / type 顺序稳定；
5. failed run 的稳定 errorCode 与 passed=null；
6. cancelled task 的合法响应；
7. 无 review task → 404 REVIEW_NOT_FOUND；
8. task 存在但 run 尚未创建 → 200；
9. 跨作品 / 错章节 / 错候选 → 404；
10. 管理员 → 403，未登录 → 401，缺 Origin → 403；
11. 响应不含正文、prompt、provider/model、inputSnapshot、requestId、租约字段；
12. 只读请求不新增 audit_logs，也不改 task / run / issue。

所有数据库测试使用真实 PostgreSQL，不联网。

## 文档

- `docs/08-workflow-and-agents.md` 增加只读 API 小节；
- `docs/09-project-memory.md` 更新能力、下一步、测试数、风险；
- `docs/07-master-roadmap.md` 更新 Reviewer 结果读取状态与历史行；
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

1. 移除 candidate / chapter / work 归属条件，确认跨作品或错候选用例失败，
   恢复后通过；
2. 移除 `taskType='chapter.review'` 条件，确认错误 task 不会被读取，
   或构造同 requestId 的异常数据验证隔离。

## 明确不做

- Reviewer UI；
- 手动重检 / 重试 / 取消；
- 采纳门禁；
- 摘要读取 API / UI（单独阶段）；
- 事实 UI；
- migration / RAG / 图谱；
- 推送远端。

## 交付

本地提交，不推送。汇报提交号、路由与 DTO、权限 / 隔离证据、测试数、
全量门禁、灵敏度结果、未做项和工作区状态，等待复审。
