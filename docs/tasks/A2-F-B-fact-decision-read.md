# WorkBuddy 任务卡：A2-F-B 事实决策状态读取模型

## 开始前

读取 `AGENTS.md`、`docs/09-project-memory.md`、`docs/07-master-roadmap.md`、本卡、
`docs/08-workflow-and-agents.md` §22、§33、`fact-read.ts`、`fact-decision.ts` 与事实 UI/API 测试。

前置：A2-F-A 已验收，工作区干净。本卡只补 decision 读取，不新增写回/UI。

## 目标

让事实列表与候选详情返回作者已有的决定状态：

```json
{
  "decision": {
    "value": "accepted | rejected",
    "decidedAt": "ISO-8601"
  }
}
```

未决定时 `decision=null`。

## 契约

- `GET /facts` 的每条 fact 增加 `decision: { value, decidedAt } | null`；
- `GET /facts/:candidateId` 的 fact 同样增加 decision；
- 不改已有字段语义；
- 不返回 `decidedBy`、payload 副本、正文、prompt、provider/model；
- decision 必须按 candidateId 归属当前作品 / 章节读取；
- 列表一次查询完成 decision LEFT JOIN，不做 N+1；
- 排序、total/truncated 语义不变，仍只包含成功 run 的候选；
- 只读，不写审计，不改 task/run/candidate/decision。

## 实现

- 更新 workflow DTO 与 `listChapterFacts` / `getChapterFactCandidate`；
- API / client 类型同步；
- 对 `value` 只接受 accepted/rejected，异常值不展示；
- 更新事实 UI 消费类型，但本卡不新增按钮；
- 无 migration；不修改 `UNIQUE(candidate_id)` 或 append-only 约束。

## 测试

1. 未决定 → decision=null；
2. accepted / rejected 正确回显且时间 ISO；
3. 列表混合已决/未决；
4. filter + total/truncated 与 decision 同时正确；
5. 候选详情回显 decision；
6. 跨作品 / 章节 / 随机 id 404；
7. decision JOIN 不引入其它作品 / 章节决定；
8. 单条 SQL / 无 N+1（测试或查询守卫）；
9. 只读不写审计、不修改任何表；
10. 响应不含 decidedBy / payload / prompt / provider。

## 文档与验证

更新 `docs/08`、`docs/09`、`docs/07`；`docs/03` 仅在字段说明需要时补充，无 migration。

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

灵敏度：

1. 去掉 decision 的 candidate/chapter/work 归属条件 → 跨章决定用例失败；
2. 把未决定错误映射成 rejected → null / 混合状态用例失败。

## 不做

决策 UI、接受/拒绝按钮、实体写回、撤销/改判、批量视图、migration、推送远端。

## 交付

本地提交，不推送。汇报提交号、DTO/查询、隔离证据、测试与门禁、两次灵敏度、
未做项和工作区状态，等待复审。
