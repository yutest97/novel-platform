# Trae 任务卡：C1-A-REV-01 Coordinator Runtime 复审修复

## 开始前

读取：

1. `AGENTS.md`
2. `docs/09-project-memory.md`
3. `docs/07-master-roadmap.md`
4. `docs/plans/C1-coordinator-agent-runtime.md`
5. `docs/tasks/C1-A-coordinator-runtime.md`
6. 本卡

基线：`a5e3707 C1-A: 实现 Coordinator Runtime 与动态问答`。
执行方：Trae。工作区除本地 `.tmp/` 外必须干净。未得到用户明确要求，不推送远端。

## 目标

只修复复审确认的问题，不扩展 C1-B 能力：

1. 模型硬超时不得被误判为租约丢失，不得形成无限重试或永久 `running`；
2. 每次实际模型调用都要留下脱敏审计与 token 计量；
3. Mock 不得把作者原文回显进受安全校验的输出；
4. 页面隐藏时必须真正暂停轮询；
5. 恢复 `ask_user.options` 的 0..6 契约；
6. 运行与最后问题必须在同一数据库快照读取；
7. 补齐复审指出的测试与文档，不改故事规划、Work、大纲、正文能力。

## P1：超时、重试与租约必须分开

现问题：

- 当前硬超时和心跳共用同一个 `AbortController`；
- 超时 abort 后，`checkFence()` 把任何 aborted signal 都当成租约丢失；
- Provider 实际被调用后，run 仍停在 `running`，租约过期后再次调用，可能反复循环。

修复要求：

- 使用两个独立信号：
  - `leaseAbort`：只由心跳失败、取消或实际 lease fence 失败触发；
  - 每次 attempt 独立的 `attemptAbort`：只负责单次模型调用超时。
- 新增可注入的 `modelCallTimeoutMs`（生产默认仍为 60 秒），测试不得等待 60 秒。
- 单次超时必须：
  - 记一次 `MODEL_TIMEOUT` 调用；
  - 作为该 attempt 的可重试失败；
  - 使用新的 `attemptAbort` 继续下一次 attempt；
  - attempt 用尽后在**同一 run** 提交 failed step + 状态 `failed`。
- 只有以下情况可以返回 `lease-lost`：
  - `locked_by` 不匹配；
  - `state_version` 不匹配；
  - 实际 lease 已丢失；
  - 取消优先导致状态不再可提交。
- Provider 必须通过 `Promise.race` 或等价机制被硬超时截断，即使 Provider 不主动监听 signal。
- 超时重试不得重置本 attempt 预算，也不得超过 `maxAttempts`。

必须新增测试：

1. Provider 不返回且不监听 signal → 超时；
2. 前两次 `MODEL_TIMEOUT`、第三次成功 → succeeded；
3. 全部 `MODEL_TIMEOUT` → failed，不产生永久 running；
4. 超时后不得重复领取无限循环；
5. 真实 lease 丢失仍返回 lease-lost，不能误写成 failed。

## P2：每次实际模型调用必须可计量

任务契约中的“每次实际模型调用一条 `novel_agent_calls`”与旧实现冲突：

- 当前只在 step/state 最终提交的事务里批量写调用日志；
- 取消、超时、旧 Worker 晚返回时，实际调用已经发生，但日志和 token 消耗丢失；
- token 预算只统计已提交日志，因此可被反复丢弃实际调用来绕过。

修复口径：

- `novel_agent_calls` 是**调用遥测**，不是业务状态提交；
- 每次实际调用前后生成稳定调用 id；调用完成后立即 append 一条脱敏日志；
- 调用日志与 run/step 的状态提交分离：
  - 旧 Worker 可以追加它实际发生的 call 日志；
  - 旧 Worker **仍不得**写 step、state、问题或任何创作资料；
- `step_id` 允许为 null；不要为了关联 step 而延迟日志写入；
- token 预算必须读取所有实际调用日志；
- 日志仍不得包含 prompt、回答、正文、原始响应、Key 或 Provider 原始异常；
- 同一逻辑调用不得重复写两条；如实现需要，可在未推送 migration 中给
  `novel_agent_calls` 增加唯一调用键，并同步 Prisma / docs / 空库迁移验证。

必须新增测试：

1. 成功调用一条日志；
2. Schema 失败 + 成功重试共两条日志；
3. 超时 attempt 也留日志；
4. 取消发生在模型调用期间：call 有日志，但 step/state 不被旧 Worker 改写；
5. 旧 Worker lease-lost 晚返回：可留 call 遥测，但不得写 step / state；
6. token 预算包含取消 / 超时产生的实际调用。

## P2：Mock 不得回显作者原文

现问题：

`createNovelCoordinatorMockProvider()` 的 finish 分支把 `requestText` 拼进
`decisionSummary`。作者输入包含 SQL、HTML、路径或 shell 片段时，Mock 输出会被
统一安全检查拒绝，默认 Mock 流程因此失败。

修复要求：

- Mock 的 `decisionSummary` 只使用固定安全文案与结构化计数；
- 不把 `requestText`、`latestAnswer`、`knownFacts` 的原文复制进 action 输出；
- 作者数据可以进入 Coordinator 输入，但不能未经处理变成带安全语义的输出字段。

必须新增测试：

- `requestText` 含 SQL / HTML / Windows 路径 / shell 片段；
- `latestAnswer = 结束`；
- Mock 输出仍通过 Schema + 语义校验并成功进入 completed。

## P2：页面隐藏必须真正暂停轮询

现问题：

- 页面隐藏时只清除当前 timer；
- 已经在途的请求晚返回后，成功 / 失败分支仍会安排下一次 timer；
- 初次 effect 在页面已经隐藏时仍会直接 `tick()`。

修复要求：

- 增加明确的 `isPageHidden()` 判定；
- 初始 tick 前、每次成功 / 失败调度下一次 timer 前都检查可见性；
- 隐藏时清 timer，不安排新 timer；
- 恢复可见时立即拉取一次并重置 1s → 2s → 5s 退避；
- 旧请求仍使用单调序号 + AbortController，迟到响应完全静默。

必须新增测试：

1. `hidden` 时不发起初始请求；
2. 在途请求返回时页面已 hidden，不再安排下一次请求；
3. 恢复 visible 后立即补一次；
4. 旧响应不能覆盖新一轮状态；
5. 回答 version / answer 冲突只提示并重新拉取。

可以把可见性判定抽成纯函数，但必须至少有一个覆盖真实 effect 生命周期的页面测试；
只有 `nextNovelPollDelay()` 等纯函数测试不算完成本项。

## P2：恢复 `ask_user.options` 0..6 契约

原任务卡写明 `options 0..6`，当前代码要求至少 1 个。

修复要求：

- `ask_user` 允许 `options === []`，最多 6 个；
- 有选项时仍要求每个 trim 后非空且不重复；
- 无选项时由页面 textarea 接收开放式回答；
- finish 仍必须 `question === null && options.length === 0`；
- 同步更新 `docs/08`、`docs/09` 和测试，不允许文档静默改成 1..6。

必须新增测试：

- 空 options 的 ask_user 合法；
- 1..6 个合法；
- 7 个拒绝；
- 空白 / 重复 option 拒绝；
- 页面无 options 时仍可提交纯文本回答。

## P3：读取 run 与当前问题必须同快照

现问题：

- `readNovelRun()` 先读 run，再单独读取最近成功 step；
- Worker 可在两个查询之间提交下一步，可能返回“旧 version + 新 question”。

修复要求：

- 使用 RepeatableRead 事务读取 run + 最新成功 step；
- 或使用一条 SQL 同时取 run 与当前问题；
- 不改变 API DTO；
- 不返回 stateSummary、step 原始 decision、lease 或模型字段。

建议测试：

- 两次读取中间推进 run 时，任一响应内部的 status / version / question 自洽。

## C1-B 前置说明

当前 migration 把 `novel_runs.work_id` 设为不可变，而完整方案写着 C1-B
“创建或绑定 Work”。本卡不实现 Work 功能，但必须明确：

- C1-B 开工前需要一个受控的一次性绑定方案；
- 可选择新增专用绑定表，或在新的未发布 migration 中允许 `NULL → work_id` 单次迁移；
- 绑定必须校验作品属于同一作者，且只能发生一次。

不要把 Work 绑定塞进本修复卡。

## 不做

- 故事规划 Agent、`novel_artifacts`、作者确认、故事圣经；
- Work 创建 / 绑定；
- Writer / Reviewer / Continuity / Librarian；
- 新工具白名单；
- RAG / 图谱；
- 推送远端。

## 验证

除按卡修复外，必须执行：

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
- 全新空库 migration；
- 至少两次灵敏度验证。

建议灵敏度：

1. 删除硬超时 → 超时重试用例失败；
2. 恢复“abort signal 一律视为 lease-lost” → run 不应无限运行的用例失败；
3. 删除隐藏页可见性检查 → 隐藏后不再调度 timer 的用例失败；
4. Mock 恢复回显 requestText → 非安全用户文本完成用例失败。

## 交付

本地提交，不推送。汇报：

- 提交号、HEAD、工作区；
- 两类 AbortSignal 与超时状态如何分离；
- 实际调用日志与 token 预算证据；
- Mock、可见性、options、read snapshot 修复；
- 新增测试数与全量测试数；
- 空库 migration / 表 / 触发器；
- E2E、format、lint、typecheck、build；
- 灵敏度结果；
- 未做项；
- 等待复审。
