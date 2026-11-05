# WorkBuddy 任务卡：A2-C-A Reviewer Agent 契约与校验

## 开始前

只读取以下内容，不要加载 `docs/04` / `docs/08` 全文：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. 本任务卡
4. `packages/workflow/src/agent.ts`
5. `packages/workflow/src/chapter/agents.ts`
6. `packages/workflow/src/chapter/workflow.ts`
7. 对应 Agent 测试与 Mock Provider 模式

基线：开始任务时的当前 `HEAD`，工作区必须干净。前置文档提交应包含
`AGENTS.md`、`docs/09-project-memory.md` 和本任务卡。

## 目标

新增受工作流约束的章节 Reviewer Agent 定义、严格输入/输出 Schema、
确定性语义校验和专用 Mock Provider。

本轮只做 **Agent 契约层**：

- 不接现有 `chapter.draft` 工作流；
- 不写数据库；
- 不新增 migration；
- 不提供 API / UI；
- 不做自动重写、自动采纳或 Reviewer 门禁。

## Agent 定义

新增：

```text
reviewer.chapter@1.0.0
```

输入必须包含：

```json
{
  "chapter": {
    "id": "uuid",
    "chapterNo": 1,
    "title": "章节标题"
  },
  "contract": {
    "goal": "章节目标",
    "mustInclude": ["必须事件"],
    "mustNotInclude": ["禁止事件"],
    "scenes": [
      {
        "purpose": "场景目的",
        "location": "地点",
        "conflict": "冲突",
        "outcome": "结果"
      }
    ]
  },
  "draft": "候选正文",
  "characters": [
    { "id": "uuid", "name": "人物名", "summary": "安全摘要" }
  ],
  "items": [
    { "id": "uuid", "name": "物品名", "summary": "安全摘要" }
  ],
  "realms": [
    { "id": "uuid", "name": "境界名", "summary": "安全摘要" }
  ],
  "factions": [
    { "id": "uuid", "name": "势力名", "summary": "安全摘要" }
  ],
  "priorSummaries": [
    { "chapterNo": 1, "summary": "前章安全摘要" }
  ]
}
```

约束：

- 正文最大 200000 字符；
- 实体每类最多 100 条；
- 前章摘要最多 20 条，每条最多 1000 字符；
- 不接受 `secret` / `secretKnownBy`、prompt、模型原始响应或密钥字段；
- Reviewer 不获得数据库访问能力。

输出严格为：

```json
{
  "passed": false,
  "issues": [
    {
      "severity": "high",
      "type": "setting_contradiction",
      "evidence": "正文中的原句",
      "suggestion": "修改建议"
    }
  ]
}
```

字段约束：

- `passed`：boolean；
- `issues`：最多 20 条；
- `severity`：`high | medium | low`；
- `type` 白名单：
  - `contract_violation`
  - `setting_contradiction`
  - `timeline_conflict`
  - `item_state_conflict`
  - `plot_thread_conflict`
  - `character_consistency`
  - `prose_quality`
- `evidence`：非空、≤300 字符；
- `suggestion`：非空、≤500 字符；
- 未知字段一律拒绝；
- `passed` 必须与 `issues.length === 0` 一致。

代码级语义校验：

- `severity` / `type` 必须是白名单；
- trim 后不得为空；
- `evidence` 必须是 `draft` 的子串，拒绝模型编造引文；
- 重复的 `type + evidence` 问题去重或拒绝，需在代码注释中明确；
- 非法输出抛出稳定 `AGENT_OUTPUT_INVALID` 语义错误，错误不包含正文。

## 专用 Mock

新增确定性 Mock：

```text
createChapterReviewerMockProvider()
```

- `name = mock`
- `defaultModel = mock-model`
- 默认输出：

```json
{ "passed": true, "issues": [] }
```

- 支持构造参数注入固定问题结果，供测试使用；
- 不联网、不读 Key、不读系统时钟；
- 不修改通用 MockProvider。

## 测试

新增 `packages/workflow/test/chapter-reviewer-agent.test.ts`，至少覆盖：

1. 合法无问题输出；
2. 合法 high / medium / low 问题；
3. 七种 type；
4. 未知 severity / type；
5. 未知字段；
6. 空或纯空白 evidence / suggestion；
7. evidence 不是 draft 子串；
8. passed 与 issues 数量矛盾；
9. 超过 20 条问题；
10. evidence / suggestion 超长；
11. 重复问题处理规则；
12. 中文、emoji、换行；
13. 输入缺章节 / 合同 / draft；
14. secret 类输入字段被 Schema 拒绝；
15. Mock 默认 passed；
16. 通过 AgentRunner 完成一次 fake Provider 调用，不联网。

## 边界

禁止：

- 修改 `chapter.draft` 六步工作流；
- 修改 generation task、candidate、version、finalize 或 facts；
- 新增 API / UI / Worker 注册；
- 新增 migration；
- 让 Reviewer 自动重写正文；
- 让 Reviewer 自动阻断作者采纳；
- 把正文、prompt、API Key 写入日志或错误。

## 验证

```bash
pnpm --filter @novel/workflow build
pnpm --filter @novel/workflow typecheck
pnpm --filter @novel/workflow test
pnpm format:check
pnpm lint
git diff --check
git show --check
```

做一次灵敏度验证：移除 evidence 子串校验，确认对应用例失败，恢复后全绿。

## 交付

更新 `docs/09-project-memory.md` 的本阶段状态与新增测试数，
必要时在 `docs/08` 增加 Reviewer Agent 契约小节。

本地提交，不推送。报告：

- 提交号；
- Agent 输入输出契约；
- 校验与 Mock；
- 新增测试数；
- 灵敏度验证；
- 工作区状态；
- 明确未做项。

完成后停止，等待复审。
