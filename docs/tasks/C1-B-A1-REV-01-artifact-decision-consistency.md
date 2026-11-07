# Trae 任务卡：C1-B-A1-REV-01 Artifact 状态与 Decision 最终一致性

## 开始前

读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. `docs/tasks/C1-B-A1-story-artifact-concept.md`
5. 本卡

基线：`93548c2 C1-B-A1: 补充第三项灵敏度验证记录`。
执行方：Trae。工作区除 `.tmp/` 外必须干净；未得到用户明确要求，不推送远端。

## 复审结论

C1-B-A1 主体实现通过，但数据库还缺一个卡内明确要求的最终一致性约束：

```text
artifact.status approved / rejected
必须与当前 revision 的 decision 值完全相同
```

当前触发器只检查“当前 revision 存在 decision”，没有比较 decision 值。

已复现：

```text
artifact = pending_approval
decision(revision=current) = rejected
同一事务把 artifact.status 改为 approved
→ 数据库错误接受
```

还存在反向漏洞：

```text
pending_approval + 写入 decision
若事务不更新 artifact status
→ 也能提交，留下状态与 decision 不一致
```

本卡只修这个 P2，不扩展业务。

## 修改范围

本卡必须修改**尚未推送的同一份 migration**：

```text
packages/db/prisma/migrations/20261107090000_c1b_a1_novel_artifacts/migration.sql
```

不得新增 migration；不得改更早的历史 migration。

## 数据库修复

### 1. 立即门禁比较 decision 值

修改 `novel_artifacts_guard()`：

- 读取当前 revision 的 decision 值，而不是只读 `EXISTS`；
- `NEW.status = 'approved'` 时：
  - 必须有当前 revision decision；
  - decision 必须为 `approved`；
- `NEW.status = 'rejected'` 时：
  - 必须有当前 revision decision；
  - decision 必须为 `rejected`；
- `draft / pending_approval`：
  - 当前 revision 不得已有 decision。

### 2. 增加 deferred 最终一致性触发器

新增函数，例如：

```text
novel_artifact_decision_consistency()
```

在以下时机以 `DEFERRABLE INITIALLY DEFERRED` 检查：

- `novel_artifact_decisions` AFTER INSERT；
- `novel_artifacts` AFTER INSERT / UPDATE（若现有 immediate guard 已覆盖，仍保留最终检查）。

事务提交时校验：

```text
status = approved ⇔ current decision = approved
status = rejected ⇔ current decision = rejected
status = draft / pending_approval ⇒ current revision 无 decision
```

这样既覆盖：

- decision 插入后同步更新 artifact 的正确事务；
- decision 插入但不更新 artifact 的错误事务；
- artifact 状态与 decision 值不匹配的错误事务。

### 3. 保持既有约束

不得放宽：

- `UNIQUE(artifact_id, revision_no)`；
- decision 只能针对 current / pending revision；
- revision / decision append-only；
- approved 终态；
- `current_revision = MAX(revision_no)`；
- 作者复合外键。

## 测试

在 `packages/workflow/test/novel-concept-service.test.ts` 增加真实 PostgreSQL 用例。

至少：

1. `decision=rejected` + artifact.status=`approved` → 事务失败；
2. `decision=approved` + artifact.status=`rejected` → 事务失败；
3. 插入 decision 但不更新 artifact，直接 commit → 失败；
4. 正确 approved 事务 → 成功；
5. 正确 rejected 事务 → 成功；
6. rejected 后生成 revision 2 draft，旧 revision 的 rejected decision 保留，不触发误报；
7. 现有服务层的 approve / reject / idempotency / stale 测试不回归。

测试清理继续使用本地受控 `DISABLE TRIGGER USER` 模式。

## 文档

更新：

- `docs/03`：状态与 decision 自洽约束、deferred trigger；
- `docs/08`：artifact state / decision 最终一致性；
- `docs/09`：本次复审问题、修复状态、测试数、决策；
- `docs/07`：C1-B-A1-REV-01 状态与下一步 C1-B-A2。

## 验证

```bash
pnpm --filter @novel/db test
pnpm --filter @novel/workflow test
pnpm --filter @novel/web test
pnpm --filter @novel/worker test
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
git diff --check
git show --check
```

必须：

- 全新空库 migration；
- 全量单测；
- 浏览器 E2E 回归；
- 至少两次灵敏度验证。

建议灵敏度：

1. artifact guard 回退为只检查 `EXISTS` → decision 值错配用例失败；
2. 删除 decision deferred trigger → “decision 不更新 artifact”用例失败。

## 不做

- Coordinator / API / UI；
- Work 绑定；
- World / Character / Plot / Outline；
- 新 migration；
- 远端推送。

## 交付

本地提交，不推送。汇报：

- 提交号、HEAD、工作区；
- migration 内修复内容；
- 5 个正反一致性测试结果；
- 全量单测、E2E 回归、空库 migration；
- format / lint / typecheck / build；
- 两次灵敏度；
- 未做项；
- 等待复审。
