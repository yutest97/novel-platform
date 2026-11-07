# Trae 任务卡：C1-A-REV-02 调用计量、数据库租约与文档收尾

## 开始前

读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. `docs/08-workflow-and-agents.md` 第 36 节
5. `docs/tasks/C1-A-REV-01-coordinator-runtime.md`
6. 本卡

基线：`a40a0dd C1-A-REV-01: 分离模型硬超时与租约，调用遥测解耦，修复隐藏轮询与 options 契约`。
执行方：Trae。工作区除本地 `.tmp/` 外必须干净。未得到用户明确要求，不推送远端。

## 复审结论

C1-A-REV-01 已修复上一轮 P1：

- 模型超时与 lease abort 已分离；
- 硬超时不再被误判为 lease-lost；
- 调用遥测与 step/state 提交已解耦；
- Mock 回显、隐藏页轮询、options 0..6、RepeatableRead 读取均已修复；
- 全量单测 1179、E2E 160 已通过。

本卡只处理复审剩余的三个 P2，不新增业务能力：

1. Schema-invalid / invalid-JSON 实际调用仍丢失 token usage；
2. lease fence 仍用应用 `Date.now()` 判断数据库租约；
3. `docs/07` / `docs/09` 状态、测试数和风险未同步。

## P2：失败调用的 usage 必须保留

现问题：

- Provider 已经完成调用并返回 usage 后，`AgentRunner` 在输出 Schema 校验失败时抛出
  `AgentOutputInvalidError`；
- 该异常没有携带 provider / model / usage / latency；
- Runtime 在 catch 分支只能把 prompt / completion token 记为 0。

因此当前测试中的“Schema 失败一次 + 成功一次”只统计成功调用 token，失败调用成本丢失。

修复要求：

- 输出 Schema 校验失败时，把已获得的调用元数据附在安全错误上：
  - provider；
  - model；
  - promptTokens；
  - completionTokens；
  - latencyMs。
- 不允许把原始模型输出、prompt、正文或底层异常附在错误上。
- Runtime 写 `novel_agent_calls` 时必须优先使用该元数据，而不是固定 0。
- 解析模型响应内容的 JSON 失败时，如果 Provider 已从响应体读到 usage，也要尽量保留；
  可以扩展现有安全错误类型或增加专用错误，但不能泄露 response content。
- 只有在 Provider 确实没有返回 usage 时，token 才能记 0。
- 不改变 `novel_agent_calls` 的无 prompt / 正文 / 原始响应约束。

建议实现：

- 给 `AgentOutputInvalidError` 增加可选安全元数据；
- `AgentRunner` 在 Provider 返回后校验 Schema，失败时把 result 的 provider / model /
  usage / latency 传给错误；
- Runtime 的 `runModelAttempt` catch 读取错误元数据写 call telemetry；
- OpenAI-compatible Provider 在 content JSON 解析失败前已读取外层 `usage` 时，
  保留该 usage 到安全错误。

必须新增测试：

1. Provider 返回 Schema 非法输出，usage 为 17 + 23，call 日志必须记 40 token；
2. Provider 返回非法内容 JSON，但外层响应含 usage，call 日志保留该 usage；
3. usage 确实缺失时仍安全记 0；
4. 一次失败调用 usage 40 + 一次成功调用 usage 20，token 预算统计为 60；
5. 失败调用日志不包含 prompt、原始 output、正文或 Provider 原始异常。

## P2：租约有效性必须由数据库时钟判断

现问题：

- 领取与心跳使用 `clock_timestamp()`；
- `checkFence()` 却使用 `state.lease_until.getTime() > Date.now()`；
- 应用时钟漂移时可能误判“租约已过期”；
- 最终条件 UPDATE 没有再次验证 `lease_until`。

修复要求：

- 删除应用进程对 `lease_until` 的 `Date.now()` 比较；
- `checkFence()` 让 PostgreSQL 计算租约是否有效，例如返回
  `lease_until > clock_timestamp() AS lease_valid`；
- `commitSuccess`、`commitFailure`、`failWithoutStep` 的条件 UPDATE 都增加
  `lease_until > clock_timestamp()`；
- heartbeat 继续使用数据库时钟；
- sweep 的租约回收逻辑不变，仍使用数据库时钟；
- 应用时钟即使明显偏快或偏慢，也不得影响 lease fence 结果。

必须新增测试：

1. 数据库租约仍有效、应用 `Date.now()` 偏快 1 小时 → 仍可正常提交；
2. 数据库租约已过期、应用 `Date.now()` 偏慢 1 小时 → 不得提交，返回 lease-lost；
3. fence 通过后、UPDATE 前租约过期 → 条件 UPDATE 无行，不写 step/state；
4. heartbeat 条件仍以 locked_by / state_version / cancel / DB clock 为准。

## P2：文档和项目状态必须收尾

`a40a0dd` 的代码已修复，但文档仍是旧状态：

- [docs/07-master-roadmap.md](../../docs/07-master-roadmap.md) 仍写“C1-A-REV-01 修复中”；
- [docs/09-project-memory.md](../../docs/09-project-memory.md) 顶部仍写“首次复审不通过，
  REV-01 为下一步”；
- 快速入口仍把 REV-01 写成“下一步”；
- 质量基线仍是 1170 / 159，不是修复后的 1179 / 160；
- 风险 43 / 44 已修复却仍列在活跃风险；
- 没有记录 REV-01 新增测试数与两次灵敏度结果。

修复要求：

- `docs/07`：
  - C1-A 状态改为“REV-01 修复完成，REV-02 待复审”；
  - 增加 REV-01 变更记录；
  - 不把 C1-B 标成开始。
- `docs/09`：
  - 顶部当前阶段只保留一份当前事实；
  - C1-A / REV-01 状态一致；
  - 快速入口改为“REV-02 修复卡 / 等待复审”，不再是 REV-01 下一步；
  - 全量单测 **1179**，浏览器 E2E **160**；
  - migrations / 表 / 触发器保持 **15 / 26 / 19**；
  - 记录 REV-01 新增 8 个 workflow 用例、1 个 web 用例、1 个 E2E；
  - 记录 Mock 脱敏和超时/租约分离两次灵敏度；
  - 风险 43 / 44 从“活跃风险”中移除或明确标为已修复；
  - 当前下一步改为“REV-02 复审”，不是 C1-B。
- `docs/08`：
  - 补充失败调用的 usage 保留规则；
  - 补充 lease fence 必须由数据库时钟判断。
- `docs/03` 本轮无 schema 变化，可不改。

文档一致性检查：

```bash
rg -n "1–6|1\.\.6|1170|159|REV-01.*下一步|首次复审不通过.*REV-01" docs/07-master-roadmap.md docs/09-project-memory.md
rg -n "1179|160|REV-02|数据库时钟|usage" docs/07-master-roadmap.md docs/09-project-memory.md docs/08-workflow-and-agents.md
```

第一条如仍有命中的历史记录，必须明确区分“历史行”和“当前状态”，不能让读者误判当前阶段。

## 不做

- 故事规划 Agent、`novel_artifacts`、作者确认、故事圣经；
- Work 创建 / 绑定；
- Writer / Reviewer / Continuity / Librarian；
- 新工具白名单；
- 新 migration；
- RAG / 图谱；
- 推送远端。

## 验证

```bash
pnpm --filter @novel/workflow test
pnpm --filter @novel/web test
pnpm --filter @novel/worker test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
git diff --check
git show --check
```

并完成：

- 全量单测；
- 浏览器 E2E；
- 空库 migration 检查；
- 至少两次灵敏度验证。

建议灵敏度：

1. 让 `AgentOutputInvalidError` 丢失 usage → Schema 失败调用 token 用例失败；
2. 恢复 `Date.now()` 比较 lease_until → 应用时钟漂移用例失败；
3. 删除 UPDATE 中的 `lease_until > clock_timestamp()` → 到期后晚提交用例失败。

## 交付

本地提交，不推送。汇报：

- 提交号、HEAD、工作区；
- Schema-invalid 与 invalid-JSON usage 保留证据；
- token 预算累计证据；
- 数据库时钟租约 fence 证据；
- docs/07 / docs/09 / docs/08 同步结果；
- 全量测试数、E2E、migration 检查；
- format / lint / typecheck / build；
- 至少两次灵敏度；
- 未做项；
- 等待复审。
