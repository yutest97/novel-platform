# WorkBuddy 任务卡：A2-F-C-REV-01 移除越界 E2E 口令脚本

## 背景

A2-F-C 提交 `59bf06f` 顺带新增：

```text
packages/auth/scripts/reset-e2e-author.mjs
```

该脚本读取 `apps/web/.e2e-author.json`、重写数据库账号口令，并输出账号邮箱。
它不属于事实决策 UI 任务卡，也引入了额外的凭据处理面。

## 要求

- 删除 `packages/auth/scripts/reset-e2e-author.mjs`；
- 不新增替代脚本；
- 不修改 A2-F-C 的事实决策 UI；
- 不修改 A2-E 已合理更新的“无采纳 / 写回 / 批量入口”测试；
- 如 package 脚本或其他文档引用它，一并移除；
- 更新 `docs/09`，说明本地 E2E 口令轮换仍由既有测试流程处理，不在本阶段引入新工具。

## 验证

```bash
pnpm --filter @novel/web test
pnpm --filter @novel/web typecheck
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

确认仓库内不再存在 `reset-e2e-author` 引用。本地提交，不推送。
