# WorkBuddy 任务卡：A2-F-A 事实候选决策记录与 API

## 开始前

读取 `AGENTS.md`、`docs/09-project-memory.md`、`docs/07-master-roadmap.md`、本卡、
`docs/08-workflow-and-agents.md` §21、§22、§32、`facts.ts`、`fact-read.ts` 与现有审计模式。

前置：A2-E 已验收，工作区干净。本轮只记录作者接受 / 拒绝决定，**不写回任何实体**。

## 目标

新增 `chapter_fact_decisions`，记录作者对成功事实候选的终态决定：

```text
id / work_id / chapter_id / source_version_id / candidate_id
decision(accepted|rejected) / decided_by / decided_at
```

- `UNIQUE(candidate_id)`；
- 复合外键绑定 candidate / chapter / sourceVersion / work；
- append-only，UPDATE / DELETE 拒绝；
- 不保存正文、prompt、payload 副本；
- 接受只表示“可作为后续写回输入”，不修改任何实体或物品事件。

## API

```text
POST /api/works/:workId/chapters/:chapterId/facts/:candidateId/decision
```

请求体只允许 `{ "decision": "accepted" | "rejected" }`。

- 作者必须拥有作品；跨作品 / 章节 / 随机候选 → 404；管理员 403、未登录 401；
- 只允许成功 run 的候选；
- 只允许当前 finalized 且 sourceVersionId 为最新的候选，否则 409
  `CONTINUITY_FACT_DECISION_STALE`；
- 同 decision 重复请求 → 200 `deduplicated=true`；
- 不同 decision → 409 `CONTINUITY_FACT_ALREADY_DECIDED`，不翻转；
- 首次决定 → 201；
- 响应只含 candidateId / decision / decidedAt / deduplicated。

事务使用 `runWorkWrite` 作品锁，事务内重查归属、成功 run、定稿与最新版本。
同事务写审计 `continuity.fact_decided`，detail 只含 ids 与 decision，不含 payload / 正文。

## 测试

覆盖 accepted / rejected、同决定幂等、不同决定冲突、非定稿 / 旧版本 stale、
失败 run / 跨作品 / 跨章节 / 随机 id、并发单行与单审计、数据库 append-only、
响应与审计脱敏，以及“决定后五类实体和物品事件全部不变”。

## 文档与验证

更新 `docs/03`、`docs/08`、`docs/09`、`docs/07`；新 migration 必须空库验证。

```bash
pnpm db:deploy
pnpm --filter @novel/db test
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

灵敏度：

1. 去掉最新版本 / 定稿校验 → stale 用例失败，恢复后通过；
2. 去掉 candidate 归属条件 → 跨章节 / 跨作品用例失败，恢复后通过。

## 不做

实体 / 物品事件写回、批量决定、撤销 / 改判、UI、自动采纳、RAG / 图谱、推送远端。

## 交付

本地提交，不推送。汇报提交号、表 / API、幂等与冲突、空库迁移、测试与门禁、
两次灵敏度、未做项和工作区状态，等待复审。
