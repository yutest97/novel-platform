# 04 验收测试（Acceptance Tests）

- 版本：v1.3（方案稿，退回修订中，待技术负责人第四次定向复审）
- 状态：**未获批准。**

本文定义可执行的验收用例，覆盖：创建作品→导出章节全流程、10 章连续性、七类一致性检查、服务重启/API 失败/重复任务/双 Worker/租约过期/事实回写/stale/隐私授权/会话安全等场景。用例编号供阶段验收引用。

---

## 0. 测试环境与前置

- 前置数据：管理员 1 名、作者 2 名（作者 A、作者 B）、一个已配置的 OpenAI 兼容模型供应商。
- **两类测试环境**：
  - **桩模型自动化测试**：用确定性桩模型（返回预设文本、可注入错误），CI 可重复运行，验证**流程/幂等/一致性框架/故障**，不依赖真实模型。
  - **真实模型质量测试**：用真实模型，人工执行，验证**生成质量与 10 章连续性**，记录成本、耗时、人工改写比例、关键事实符合率（见 §9）。
- 测试数据可重复构建（seed 脚本），测试可重复运行。

---

## 1. 全流程验收（创建作品 → 导出）

### AT-FLOW-1 完整创作闭环（v1.2 修正顺序：最终版本确定后再提取事实）

| 步骤 | 预期 |
| --- | --- |
| 管理员创建作者 A | 成功，初始密码一次性展示，不落库明文 |
| A 首登改密 | 强制改密（must_change_password 布尔）后进入"我的作品" |
| A 新建玄幻作品《测试·寒山》 | 题材仅 1 项；进入向导 |
| A 完成方向/世界/人物/境界体系/势力/物品 | 最小设定集满足（主角 + 境界 ≥3 层）；方向参数存 work_settings |
| A 生成卷纲 | 卷纲落库，可查看上下文来源 |
| A 生成十章阶段目标 | 每章 1—3 条目标 |
| A 生成第 1 章细纲 → 节拍 | 节拍字数预算偏差 ≤20% |
| A 生成第 1 章正文 | 2500—4000 字，进入**候选区** |
| A 采纳候选 → 转正式版本 | 版本号 = 1；候选 status=adopted |
| A 人工编辑 → 保存 | 产生 human 版本（version_no=2） |
| A 一致性检查 | 返回 7 类检查结果 |
| A 局部重写 → 应用 | 未选段落逐字节不变，产生 version_no=3 |
| A 确认正文为**最终版本** → 提取事实 | 候选事实 + 结构化影响落库（基于最终版本） |
| A 接受/拒绝事实 | 接受后回写人物/资源/设定状态 |
| A 导出 | 导出含正文+卷纲+设定附录 |

**失败判据**：任一步骤无法完成，或越权/半写/重复记录等硬性要求被破坏；事实提取发生在最终版本确定之前（顺序错误）即失败。

---

## 2. 数据隔离与权限测试

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| AT-SEC-1 | 作者 B 直接请求作者 A 作品/章节/设定的接口 | `403`，不返回任何 A 数据 |
| AT-SEC-2 | 作者 B 通过"猜测 work_id"访问 A 的章节 | `403` 或 `404`（不可区分是否存在） |
| AT-SEC-3 | 作者请求管理员接口（建号/配置/用量） | `403` |
| AT-SEC-4 | 未登录访问任意业务接口 | `401` |
| AT-SEC-5 | 停用作者 A 后，A 的现有会话请求 | 立即 `403`（不等 token 过期） |
| AT-SEC-6 | 前端隐藏他人作品入口 | 服务端仍拦截（UI 隐藏仅体验） |

**失败判据**：任何一条返回他人数据或越权成功。

---

## 3. 隐私：正文临时查看授权测试（v1.2 强化，对应 F-PRV）

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| AT-PRV-1 | **未授权**：管理员直接请求作者正文接口 | `403`，默认无正文读取权限 |
| AT-PRV-2 | **作者站内批准**：管理员发起授权 → 作者在站内批准 → 管理员查看 | 授权成功，查看成功，落审计（who/when/what/why） |
| AT-PRV-3 | **作者站内拒绝**：作者拒绝授权请求 | 拒绝留痕（审计），管理员查看仍 `403` |
| AT-PRV-4 | **待处理请求提示** | 作者有 pending 请求时，工作台显示"有 N 条请求待处理" |
| AT-PRV-5 | **管理员自批**（若负责人决策为 B） | 自批生效但**必须记录为负责人决策**；审计留痕 |
| AT-PRV-6 | **授权过期**：超过默认 1 小时再访问 | `403`，需重新发起授权 |
| AT-PRV-7 | **越范围读取**：授权章节 A，请求章节 B 正文 | `403`，范围外拒绝 |
| AT-PRV-8 | **审计不可缺失**：任意一次查看后查审计日志 | 必有一条完整记录（who/when/what/why），不可篡改 |
| AT-PRV-9 | **密码重置留审计**：管理员重置某账号密码 | append-only 审计记录，含操作者/目标/时间 |
| AT-PRV-10 | **账号停用留审计**：管理员停用账号 | 审计记录不可缺失 |
| AT-PRV-11 | **密码重置后访问**：被重置账号的旧会话 | 立即失效 `403`；重置事件在审计中可查 |

---

## 4. 候选区与版本可恢复性测试

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| AT-CAND-1 | 生成两稿，均进候选区 | 两个 candidate 并存，status=pending |
| AT-CAND-2 | 采纳候选 A | 产生正式版本 version_no=1；候选 A status=adopted |
| AT-CAND-3 | 再采纳候选 B | 产生 version_no=2；候选 B adopted |
| AT-CAND-4 | 重复采纳候选 A | 幂等，返回已有 version_no=1，不新增版本 |
| AT-CAND-5 | 放弃候选 C | 候选 C status=discarded；不产生正式版本 |
| AT-CAND-6 | 采纳已放弃候选 | `409` 拒绝 |
| AT-CAND-7 | **两个并发请求同时采纳同一候选** | 只产生**一个**正式版本；`source_candidate_id` 唯一约束兜底 |
| AT-CAND-8 | **两个并发请求同时采纳不同候选** | 版本号不冲突（章节行锁串行化分配） |
| AT-VER-1 | 生成失败（模拟模型报错） | 无新候选、无新正式版本，旧版本完好 |
| AT-VER-2 | 人工编辑保存 | 产生 human 版本，父版本可追溯 |
| AT-VER-3 | 局部重写未选段落 | 未选段落逐字节一致 |
| AT-VER-4 | 恢复历史版本 | 恢复写新版本，历史版本只增不减 |
| AT-VER-5 | 任意两版本 diff | 差异正确高亮 |

**失败判据**：任何旧版本被覆盖或丢失；重复/并发采纳产生重复正式版本。

---

## 5. 七类一致性检查测试

> 每类均需**至少 1 条可真实触发的规则**（桩模型注入矛盾数据 + 结构化事实库构造）。

| 编号 | 类别 | 构造的矛盾 | 预期问题证据 |
| --- | --- | --- | --- |
| AT-CHK-1 | 境界 | 人物境界从"筑基"跳"金丹"，无突破事件 | 命中"境界跳跃"，含原文引用+建议位置 |
| AT-CHK-2 | 战力 | 金丹被炼气击败且无解释 | 命中"战力倒挂" |
| AT-CHK-3 | 资源 | 灵石余额 100，花费 500 无补充 | 命中"资源透支" |
| AT-CHK-4 | 物品 | 法宝乙使用但无转手事件 | 命中"物品归属矛盾" |
| AT-CHK-5 | 认知 | 人物甲知道 fact F 但 knowledge_marks 中 known=false | 命中"认知越界" |
| AT-CHK-6 | 时间线 | 因果边"果早于因" | 命中"时序矛盾" |
| AT-CHK-7 | 伏笔 | 伏笔 planted 后到 planned_resolve_chapter 仍未 resolved | 命中"伏笔未回收" |

**证据格式断言**：每条 issue 必须含 `rule_key/category/severity/evidence_quote/evidence_locator/suggestion`（见 `03` §5.3），缺一即失败。

### 5.1 伏笔专项（v1.2 新增，回应审查第 4 条）

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| AT-FORE-1 | 伏笔被 `reinforced`（强化） | **不视为已回收**，status 仍 unresolved |
| AT-FORE-2 | 伏笔被 `resolved` | 视为已回收，status=resolved |
| AT-FORE-3 | 伏笔被**带理由** `abandoned` | 视为结束，status=abandoned；无理由的 abandoned 无效 |
| AT-FORE-4 | **章节插入/重排后**，伏笔 `planned_resolve_chapter_id` 指向的章节 | 仍正确指向原章节（稳定 ID，不随章号变化） |

---

## 6. 10 章连续性测试

### AT-CONT-1 连续生成 10 章（真实模型）

- 步骤：按 AT-FLOW-1 闭环连续完成第 1—10 章（每章至少 1 个 human 版本 + 1 次检查 + 1 次事实确认）。
- 预期：10 章全部 `finalized`；卷纲/阶段目标/细纲/节拍/正文/版本/检查报告/事实链完整。
- 记录指标：见 §10（成本、耗时、人工改写比例、关键事实符合率）。

### AT-CONT-2 跨章实体状态一致

- 步骤：检查 10 章中某人物境界、某资源余额、某物品持有人，按故事顺序回放事件流水。
- 预期：流水回放结果与各章正文陈述一致，无跳变。

### AT-CONT-3 设定变更不污染已生成章节

- 步骤：在第 6 章定稿后修改境界体系，再回看第 6 章。
- 预期：第 6 章历史版本内容不变；"当时设定版本"快照仍可回放。

---

## 7. 故障与持久化测试

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| AT-R1 | 服务重启 | 重启后作品/章节/版本/候选/设定/任务状态全量无损 |
| AT-R2 | 生成中 Worker 崩溃 | 任务状态可恢复（failed 或可重试），无半写章节 |
| AT-F1 | 模型 API 超时/502 | 任务 `failed`，错误记录可查，旧章节不受影响 |
| AT-F2 | 模型返回 <1200 字 | 不写候选表，任务 `failed`，可重试 |
| AT-C2 | 重复点击"生成"（同 request_id） | 仅 1 个 task，仅 0/1 个候选（幂等） |
| AT-C3 | 正文写入与状态更新的原子性 | 模拟写入中途失败 → 无半写态 |
| AT-C4 | 并发编辑同章节 | 一方 `409`，另一方成功，版本号不冲突 |

### 7.1 任务队列与幂等专项（v1.2 修正，回应审查第 1 条）

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| AT-Q1 | **同 request_id 并发提交**（同一作品两个请求同 request_id 同时到达） | 仅产生 1 个 task（`UNIQUE(work_id, request_id)` 阻止并发重复提交） |
| AT-Q2 | **同 request_id、不同 input_hash** | 返回 `409 TASK_REQUEST_CONFLICT`（request_id 被用于不同内容，不覆盖、不新建） |
| AT-Q3 | **不同 request_id、相同 input_hash**（用户明确再次生成） | **允许**创建新任务（input_hash 无唯一约束） |
| AT-Q4 | **任务完成后再生成**（同用户、新 request_id、同输入） | 允许创建新任务，产生新候选，不影响旧版本 |
| AT-Q5 | **Worker 自动重试**（租约过期/崩溃后重抢） | **同一 task**，`attempt_count + 1`，不新建 task |
| AT-Q6 | **双 Worker 抢同一任务** | 仅 1 个 Worker 拿到锁（SKIP LOCKED），不重复执行 |
| AT-Q7 | **租约过期** | 超 lease 的任务可被重新执行，不永久卡死 |
| AT-Q8 | **attempt 超限** | 达上限（默认 3）后标 `failed` |
| AT-Q9 | **用户取消** | `cancel_requested_at` 生效，Worker 停止后续动作 |
| AT-Q10 | **request_id 为空** | 服务端拒绝（`422`） |

---

## 8. 事实提取与状态回写测试（v1.2 强化）

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| AT-FACT-1 | 最终版本确定后提取事实 | 产出候选事实 + 结构化影响（fact_effects），含来源版本与原文证据 |
| AT-FACT-2 | 接受事实 → 回写 | 事实版本/人物状态/资源状态/设定版本同事务提交，无半写 |
| AT-FACT-3 | 正文定稿但回写失败 | 整体回滚，事实保持 candidate，无半写状态 |
| AT-FACT-4 | 重复回写同一事实版本 | 幂等，不重复追加流水 |
| AT-FACT-5 | 回写回滚 | 模拟资源流水写入失败 → 人物状态等一并回滚，库中无残留 |
| AT-FACT-6 | 拒绝事实 | 事实 status=rejected，不回写状态 |
| AT-FACT-7 | 待确认事实不阻塞下一章 | 有 pending 事实时仍可生成下一章，仅顶部提示 |
| AT-FACT-8 | **正文修改导致事实失效** | 新版本取代旧版本 → 旧版本派生的 accepted 事实自动标记 stale |
| AT-FACT-9 | **重新提取 → 确认 → 恢复** | stale 事实经重新提取（新候选）→ 确认后恢复 accepted |
| AT-FACT-10 | **过期事实不进上下文** | 生成下一章时，stale/rejected/candidate 事实**不得**出现在上下文中；仅 accepted 且未 stale 的事实被检索 |
| AT-FACT-11 | **knowledge_marks 指向存在的事实版本** | fact_version 为外键，指向不存在的版本时写入失败 |
| AT-FACT-12 | **删除旧事实影响（冲正）** | 事实 stale 后，其 `applied` 的 fact_effect_applications 自动冲正：资源追加反向流水、物品追加反向事件、人物属性恢复 old_value；application 标记 reversed |
| AT-FACT-13 | **修改资源变化 / 修改人物境界** | 作者修正 fact_effect 的 old/new/delta 后重应用，产生新流水/新快照，不复用已冲正历史 |
| AT-FACT-14 | **两个事实同时修改同一资源** | 先到者应用；后到者 old_value 校验失败 → `409 FACT_STATE_CONFLICT`，不写流水不写 application |
| AT-FACT-15 | **物品转手失效** | 物品转手事实 stale 后冲正，持有人恢复；重新确认后按新 effect 重应用 |
| AT-FACT-16 | **存在 stale 事实时禁止生成下一章** | 返回 `FACT_PENDING_CORRECTION`，处理完（冲正/重确认）后才能继续 |

---

## 9. 上下文与成本可追溯测试

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| AT-CTX-1 | 查看某章生成时用了哪些设定/历史章节/摘要 | 返回上下文来源清单，与生成时一致 |
| AT-CTX-2 | 管理员查看 Token 用量 | 可按作者/时间聚合，与账单误差 ≤10% |
| AT-CTX-3 | API Key 保密 | 前端不可见、Git 无提交、日志无明文、**管理页面无输入/保存入口** |
| AT-CTX-4 | 每日预算硬上限 | 触发上限后任务被拒绝/中止，不静默继续 |
| AT-CTX-5 | 单任务 Token 硬上限 | 单任务预估超限直接拒绝 |

---

## 10. 真实模型 10 章质量测试

> 与桩模型自动化测试分开：此测试**必须用真实模型**，人工执行，产出**质量报告**而非简单通过/失败。

| 指标 | 口径 |
| --- | --- |
| 总成本 | 10 章累计 Token 费用（按模型单价估算） |
| 总耗时 | 10 章生成 + 人工修改的总人时 |
| 单章平均生成耗时 | 每章生成任务 wall time |
| 人工改写比例 | 每章 human 版本相对 AI 初稿的字符差异率 |
| 关键事实符合率 | 随机抽 N 个关键事实（境界/资源/物品/伏笔），人工核对正文陈述一致的比例 |
| 一致性检查误报/漏报 | 人工复核 7 类检查的命中质量 |

**通过线**（建议值，最终由技术负责人定）：关键事实符合率 ≥ 90%；人工改写比例不高于预设阈值；7 类检查无系统性漏报。

---

## 11. 导出测试

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| AT-EXP-1 | 导出 Markdown | 正文 + 卷纲 + 设定附录完整，编码 UTF-8 |
| AT-EXP-2 | 导出纯文本 | 同上，无 Markdown 标记 |
| AT-EXP-3 | 导出 Word（若许可证确认，P1） | 可打开，章节分页正确 |

---

## 12. 认证与会话安全测试（v1.2 强化，回应审查第 8/10 条）

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| AT-AUTH-1 | 账号数上限（含停用）**真实 PostgreSQL 并发创建** | 两个事务并发创建，`pg_advisory_xact_lock` 串行化，总数不突破 10 |
| AT-AUTH-2 | 停用账号会话立即失效 | 逐请求校验，立即 `403` |
| AT-AUTH-3 | 首登强制改密 | 未改密前除改密/退出外的接口一律 `403 PASSWORD_CHANGE_REQUIRED`（前端页面跳转在管理后台阶段实现） |
| AT-AUTH-4 | 登录失败限流 | 第 6 次返回 `429 RATE_LIMITED`；并发 20 次错误登录时最多 5 次进入完整校验 |
| AT-AUTH-5 | **初始密码一次性展示** | 创建后仅展示一次；刷新后不可回看，只能重置；不落日志、不落库明文 |
| AT-AUTH-6 | **argon2id 哈希** | 库中密码字段为 argon2id 哈希，无明文/可逆密文 |
| AT-AUTH-7 | **管理员重置密码** | 重置后旧密码失效，新密码一次性展示，被重置账号会话立即失效 |
| AT-AUTH-8 | **会话轮换** | 登录成功/改密后会话 ID 更换，旧会话失效（防会话固定） |
| AT-AUTH-9 | **绝对有效期** | 超过绝对有效期（默认 12 小时，可经 `AUTH_SESSION_ABSOLUTE_HOURS` 调整）的会话失效 |
| AT-AUTH-10 | **空闲有效期** | 超过空闲有效期（默认 30 分钟）的会话失效；活动后顺延 |
| AT-AUTH-11 | **多设备上限** | 单账号第 6 个会话建立时，最旧会话被踢出（上限 ≤5） |
| AT-AUTH-12 | **Secure Cookie** | 生产环境会话 Cookie 带 Secure 标记 |
| AT-AUTH-13 | **CSRF / Origin 防护** | 修改数据接口：无 Origin 或跨站 Origin → `403` |
| AT-AUTH-14 | **密码策略** | 长度 ≥12 字符即通过（不强制大小写/数字）；<12 字符、与当前密码相同、纯空白 → 拒绝 |
| AT-AUTH-15 | **管理员授权** | 作者 / 已停用管理员 / 不存在的 actor 调用管理员操作 → `403`，且业务数据不变 |
| AT-AUTH-16 | **审计原子性** | 审计写入失败时业务修改回滚（不出现"改了但没审计"） |
| AT-AUTH-17 | **限流抗伪造来源** | 伪造 `X-Forwarded-For` 不影响限流计数；仅信任 Caddy 覆盖的 `X-Real-IP` |
| AT-AUTH-18 | **最后管理员保护** | 停用唯一的 active admin 返回 `403 LAST_ADMIN_PROTECTED`；两个管理员并发互相停用后恰好保留 1 个 active admin |
| AT-AUTH-19 | **管理员治理事务** | 授权在事务内取固定 advisory lock 后重读 actor；首登未改密的管理员执行管理操作被拒，且无业务修改与审计 |
| AT-ADM-1 | **账号列表** | 字段仅 id/email/role/status/mustChangePassword/createdAt/updatedAt；无 passwordHash / 令牌 / 审计详情 |
| AT-ADM-2 | **创建作者** | role 固定 author；未提供口令时服务器生成 ≥20 字符并只返回一次；显式提供时不回显；重复邮箱 `409 EMAIL_TAKEN` |
| AT-ADM-3 | **账号上限** | 总数 ≤10（含 disabled）；并发创建不突破；超限 `409 USER_LIMIT_REACHED`；无删除接口 |
| AT-ADM-4 | **重置密码 / 停用启用** | 重置后旧会话立即失效且必须改密；停用立即失效、启用后可登录；最后管理员保护仍生效 |
| AT-ADM-5 | **管理接口授权** | actor 取自会话；作者 / 停用管理员 / 首登未改密管理员一律 403；写接口校验 Origin |
| AT-UI-1 | **会话失效统一处理** | 管理接口返回 `UNAUTHENTICATED` / `ACCOUNT_DISABLED` / `PASSWORD_CHANGE_REQUIRED` 时页面**立即跳转**（`/login`、`/login?reason=disabled`、`/change-password`），不是只显示错误文本；并发失败只跳一次 |
| AT-UI-2 | **会话自动退出** | 依据 `idleExpiresAt` / `absoluteExpiresAt`（较早者）设置自动退出计时器，到期跳 `/login?reason=expired` |
| AT-UI-3 | **重新可见重校验** | `visibilitychange` / 窗口重新获得焦点时重新调用 `/api/auth/me`；清除 Cookie 后下一次交互即回登录页 |
| AT-UI-4 | **弹窗模态隔离** | 弹窗打开时背景为 `inert`；Tab / Shift+Tab 只在弹窗内循环；关闭后焦点回到触发按钮；一次性口令弹窗不可用 Escape / 遮罩 / 关闭按钮关闭 |
| AT-UI-5 | **手机宽度可用** | 390×844 下登录可提交、表格在 `.table-wrap` 内横向滚动且不撑破 body、一次性口令弹窗完整显示且按钮可点、触控目标 ≥40px |
| AT-UI-6 | **失败产物无明文口令** | 关闭 trace / 截图 / 视频自动产物；上传 artifact 前扫描并删除含明文口令的失败产物 |
| AT-UI-7 | **活跃会话续期** | 管理页的列表加载 / 创建作者 / 重置密码 / 停用启用成功后重新读取会话并用**新的** `idleExpiresAt`/`absoluteExpiresAt` 重置自动退出计时器；到期时间未变化时不重置（不产生重复计时器）；不刷新会话时到期仍跳 `/login?reason=expired`；**不修改服务端任何有效期配置** |
| AT-UI-8 | **改密页会话错误** | `ACCOUNT_DISABLED` → `/login?reason=disabled`；`UNAUTHENTICATED` → `/login`；`PASSWORD_CHANGE_REQUIRED` → 保持改密页并给出提示 |
| AT-UI-9 | **口令清单写入失败必须中止** | 口令清单写入失败时 E2E 直接失败（不得静默 catch）；清单文件既不入仓库也不进镜像上下文 |
| AT-WORK-1 | **作品列表隔离** | `GET /api/works` 只返回当前会话作者的作品，按更新时间倒序；不返回其他作者数据 |
| AT-WORK-2 | **创建作品** | 仅 active、已改密的作者可创建；`authorId`/`role` 只从会话取，客户端提交被拒绝；章数 1—100、字数 1200—10000；题材必须来自**启用中**的规则包 |
| AT-WORK-3 | **标题唯一** | 同一作者下重复标题返回 `409 WORK_TITLE_TAKEN`；不同作者可以有同名作品 |
| AT-WORK-4 | **跨作者访问** | 作者 B 通过 id 访问作者 A 的作品（读或改）一律 404，不泄露作品是否存在 |
| AT-WORK-5 | **审计原子性** | 创建与更新与 `work.created`/`work.updated` 同事务；审计写失败则作品回滚；detail 不含简介与正文 |
| AT-WORK-6 | **不可越权修改** | 更新不允许改 `authorId` 与 `genreRulePackage`；管理员不能通过作品接口读取或修改作者作品 |
| AT-WORK-6b | **PATCH 不可变字段** | `authorId`/`author_id`/`role`/`id`/`genreRulePackage`/`genre_rule_package`/`createdAt`/`created_at`/`updatedAt`/`updated_at` 出现在 PATCH 请求体里一律 `400 VALIDATION_FAILED`，**不静默忽略**；作品不被改动；POST 仍允许 `genreRulePackage` |
| AT-WORK-6c | **E2E 动态口令入清单** | 运行期生成/拼接的口令（作者初始口令、改密后口令、共享管理员口令）在使用前记入口令清单；失败产物扫描能识别并删除含这些口令的文件；共享管理员口令文件在扫描后被删除 |
| AT-WORK-7 | **工作台页面** | `/workspace` 展示账号信息、创建表单与作品列表卡片；题材固定显示「玄幻升级」；不显示管理员入口 |
| AT-WORK-8 | **作品详情页** | `/works/:id` 只显示基础信息与设定占位；明确提示人物/境界/卷纲/章节后续开放；无伪造编辑器或生成入口 |
| AT-SET-1 | **设定访问权限** | 仅 active、已改密的作者可访问设定；管理员 403；作者 B 访问作者 A 的设定 404 |
| AT-SET-2 | **schema 校验** | 作品方向与实体属性按 xuanhuan field_schema 校验：未知字段 / 缺失必填 / 类型错 / 越界一律 400 |
| AT-SET-3 | **实体版本快照** | 创建实体写第一版快照；编辑追加新版本且旧版本保留 |
| AT-SET-4 | **实体命名唯一** | 同作品同类型重名 `409 ENTITY_NAME_TAKEN`；不同作品允许同名；软删除后同名可重建 |
| AT-SET-5 | **排序约束** | 排序只接受完整、无重复、全部属于当前作品的集合；越界一律 400 |
| AT-SET-6 | **软删除与引用保护** | 被同作品内其它实体引用时删除返回 `409 ENTITY_IN_USE` 且不删除；软删除后不再出现在默认列表 |
| AT-SET-7 | **审计原子性** | 设定更新与实体的创建/更新/删除/排序均与审计同事务；审计失败则业务回滚；detail 不含完整设定值 |
| AT-SET-8 | **审计不记录正文** | 审计 detail 只含 workId / entityId / entityType / 字段名，不含设定值或小说正文 |

---

## 13. 备份恢复测试

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| AT-BK-1 | 备份后恢复 | `pg_restore` 到新库，works/chapter_versions/generation_tasks 行数一致，抽样正文逐字节一致 |
| AT-BK-2 | 恢复演练记录 | 演练结果落库可查 |

---

## 14. 设定模块验收（M2-B2 / M2-B3-A / M2-B3-B1 / M2-B3-B2：境界 / 势力 / 人物 / 物品 / 功法 / 物品流水）

M2-B2 交付范围：`realm_level`（境界体系）、`faction`（势力）、`character`（人物）；
M2-B3-A 在此基础上新增 `item`（物品）与 `technique`（功法），规则包升级到 **xuanhuan@4.0.0**；
M2-B3-B1 新增 `item_events` 流水（追加 / 冲正 / 回放，**不改规则包**）；
M2-B3-B2 交付物品持有人 / 事件时间线 UI 与对应 E2E（`AT-SET-21/22`）。
五类实体共用 `entities / entity_attributes / entity_versions` 通用骨架，五类都有
**契约、接口、设定中心 UI 与 E2E**。

**交付状态**：B3-B1 后端交付事件流水、派生持有人与删除保护（`AT-SET-16..20`）；
B3-B2 交付 item 卡片入口、时间线（分页 / 冲正关系）、追加表单（按状态只开放合法操作）、
冲正二次确认、错误映射与移动端布局（`AT-SET-21/22`）。
**未交付**且不得标记完成：
地点、关系图、资源流水（M2-B4）、时间线、伏笔；
`AT-CHK-4`（物品归属矛盾）依赖章节正文与场景节拍（M2-D / M2-E），仍未交付；
`F-WRK-15`（人物「当前知道/不知道」信息清单）仍由 M6 事实版本系统交付
（依赖 `fact_id` + 事实版本），`character.secretKnownBy` 只表示**设定层「谁知道这个秘密」**，
不构成事实级认知模型。

| 用例 | 覆盖内容 | 自动化位置 |
| --- | --- | --- |
| AT-SET-1 | 规则包 v3：三类字段组、`schemaRef` 恒等、enum 选项来自规则包 | `packages/works/test/entities-multitype.test.ts` |
| AT-SET-2 | v2 → v3 升级：只迁 `2.0.0`、`1.0.0` 行数内容不变、作者可见数据逐字段一致、跨版本同键重复不冲突 | `packages/works/test/migration-v3-upgrade.test.ts` |
| AT-SET-3 | 字段契约坏数据（options 空/重复、refType 缺失/未声明、maxItems 非正整数）→ `INVALID_RULE_PACKAGE` | `packages/works/test/schema-contract.test.ts` |
| AT-SET-4 | 引用写校验：存在、未删除、同作品、类型一致、禁自引用、重复 400；同一 UUID 落在两个 `refType` 不同字段必须整体 400 | `entities-multitype.test.ts`、`entities-reference-typing.test.ts` |
| AT-SET-5 | 删除保护：只扫当前契约的引用字段、只计存活引用者、`409 ENTITY_IN_USE` 附安全摘要（≤20 条、仅 id/类型/名称） | `entities-multitype.test.ts`、`apps/web/test/settings-api.test.ts` |
| AT-SET-6 | 多类型 CRUD、每类型独立 `1..N` 排序、reorder 完整集合、`entityType` 出现即必须是字符串 | `packages/works/test/*`、`apps/web/test/settings-api.test.ts` |
| AT-SET-7 | 设定中心 DTO：`entityGroups` 按组级 `order`、组内按 `order_index`、`realms` 已移除 | `apps/web/test/settings-api.test.ts` |
| AT-SET-8 | UI：四分区（方向/境界/势力/人物，顺序来自 `entityGroups.order`）、schema 驱动控件（enum → select、entityRef → 单选、entityRefs → 有序多选）、无候选空态、禁止自引用 | `apps/web/e2e/settings-flow.spec.ts` 用例 10–13、18–20 |
| AT-SET-9 | UI 删除保护：`409` 展示引用总数与引用者「类型 · 名称」、解除引用后可删 | `apps/web/e2e/settings-flow.spec.ts` 用例 14–16 |
| AT-SET-10 | 三类实体排序互不影响；候选不含他人作品数据；移动端 390×844 不撑破视口 | `apps/web/e2e/settings-flow.spec.ts` 用例 17、19、20 |
| AT-SET-11 | 规则包 v4：五类字段组、`schemaRef` 恒等；`item` 字段恰为 category/quality/acquisition/description（**无 holder**） | `packages/works/test/entities-multitype.test.ts` |
| AT-SET-12 | v3 → v4 升级：只迁 `3.0.0`；`1.0.0`/`2.0.0` 行内容逐列不变；三代同键重复不冲突；升级前后 `getSettingsCenter` 语义相等；迁移幂等 | `packages/works/test/migration-v4-upgrade.test.ts` |
| AT-SET-13 | item / technique 契约：enum 必填与取值、`holder` 作为未知字段 400、`technique.realmRequirement` 的存在/未删除/同作品/类型一致/禁自引用 | `entities-item-technique.test.ts`、`apps/web/test/settings-api.test.ts` |
| AT-SET-14 | 删除保护（B3-A 口径）：删除被功法引用的境界 `409` + 引用摘要（含功法名称），解引用后可删；删除物品永远允许 | 同上 |
| AT-SET-15 | UI：物品 / 功法分区自动出现（顺序 4、5）、两个 enum 只有规则包选项、页面无「持有人」控件、删除被引用境界展示「功法 · X」、五分区排序互不影响、移动端不撑破视口 | `apps/web/e2e/settings-flow.spec.ts` 用例 9、10、21–23 |
| AT-SET-16 | `item_events` 迁移：应用到已有 v4 数据的库后既有表**逐字节不变**、规则包仍 4.0.0（无 v5）；CHECK（类型/形态/序号/幂等键/备注）、三个唯一索引、append-only 触发器（直接 SQL 的 UPDATE/DELETE 也失败） | `packages/works/test/migration-item-events.test.ts` |
| AT-SET-17 | 状态机与回放：四类事件的合法/非法转移；冲正行与目标行同时剔除；冲正 obtained/transferred/consumed/lost 均回到冲正前状态；冲正非最新 / 冲正冲正行 / 二次冲正均 409 | `packages/works/test/item-events.test.ts` |
| AT-SET-18 | 事件接口：`fromHolder` 400、幂等（同键同内容 200+deduplicated、同键异内容 409）、`afterSeq` 分页、软删物品 409 `ITEM_EVENTS_CLOSED` 但历史可读、他人作品 404、管理员 403、畸形 UUID 400 | `apps/web/test/item-events-api.test.ts` |
| AT-SET-19 | 事件并发：10 并发转手 seq 连续唯一；同一幂等键并发只 1 行；并发冲正只 1 条冲正行；追加与物品软删并发不产生"已删物品上的事件"；转手与删除该人并发二者只成功一个；物品事件写与实体写受**同一把**作品级锁约束 | `packages/works/test/item-events-concurrency.test.ts` |
| AT-SET-20 | 删除人物：仍是存活物品的当前持有人 → 409 并列出物品；已被转走的历史持有人不阻止删除；事件 DTO 只含 id/name/deleted | `packages/works/test/item-events.test.ts`、`apps/web/test/item-events-api.test.ts` |
| AT-SET-21 | 时间线 UI 规则（单测）：四种状态 → 合法操作集合；冲正按钮只在「最新 + 未冲正 + 非冲正行」；冲正行显示「冲正 #N」、目标行置灰；空状态区分「从未登记」与安全异常；备注 ≤500；幂等键复用 / 更换 / 成功清空；五个事件错误码中文映射且 `CONCURRENT_MODIFICATION` 不跳登录 | `apps/web/test/item-events-ui.test.ts` |
| AT-SET-22 | 时间线 UI（E2E）：item 卡片入口（其它实体没有）、首次打开同时请求 state/events（`limit=50`）、登记获得 → 转手（当前持有人不在候选）→ 消耗 → 冲正（目标行「已冲正」、冲正行不可再冲正）、备注与幂等键不写 URL/storage、删除当前持有人 409 并列出物品、转走后可删（历史显示「已删除角色」）、另一作者 404 / 管理员 403、软删物品后只读、390×844 按钮 ≥40px 且不撑破视口、截图无口令/邮箱/Cookie/令牌 | `apps/web/e2e/item-events-flow.spec.ts` |

**事件时间线与 APIs 的对应关系（B3-B2）**

| 面板区域 | 行为                                                                                                     | 接口                                |
| -------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 状态摘要 | 打开面板时读取；显示状态 / 当前持有人 / 事件总数 / 有效事件数 / 最后 seq                                  | `GET /api/works/:id/items/:itemId/state` |
| 时间线   | 首屏 `limit=50`，按 `seq` 升序；「加载更多」用 `afterSeq` 续读；持有人只渲染 `{id,name,deleted}`          | `GET /api/works/:id/items/:itemId/events` |
| 追加事件 | 按当前状态只提交合法 `eventType`；`toHolder` 仅获得/转手必填；`fromHolder` 永远不由客户端提交             | `POST /api/works/:id/items/:itemId/events` |
| 冲正     | 只对最新、未冲正、非冲正行开放；二次确认后提交可选备注                                                    | `POST /api/works/:id/items/:itemId/events/:eventId/reversal` |
| 删除保护 | 删除当前持有人时展示 `references` 摘要（「物品 · 名称」），不提供强制级联                                 | `DELETE /api/works/:id/entities/:entityId` |

---

## 15. 追踪矩阵（P0 功能 → 用例，v1.3 按实际 ID 更新）

| P0 功能 | 覆盖用例 |
| --- | --- |
| F-AUTH-01 | AT-AUTH-5（初始密码一次性展示）、AT-FLOW-1 |
| F-AUTH-02 | AT-AUTH-3（首登强制改密） |
| F-AUTH-03 | AT-AUTH-7（管理员重置密码）、AT-AUTH-2（停用生效） |
| F-AUTH-04 | AT-AUTH-1（真实 PG 并发创建不突破上限） |
| F-AUTH-05 | AT-AUTH-6（argon2id） |
| F-AUTH-06 | AT-AUTH-8/9/10/11/12（轮换/有效期/多设备/Secure） |
| F-AUTH-11 | AT-AUTH-13（CSRF/Origin） |
| F-WRK-01 | AT-FLOW-1（新建作品） |
| F-WRK-02 | AT-FLOW-1（方向参数存 work_settings） |
| F-WRK-03 | AT-FLOW-1（世界观设定） |
| F-WRK-04 | AT-SET-4/5/8（人物设定，M2-B2 已交付部分）、AT-FLOW-1 |
| F-WRK-05 | AT-SET-4/8（势力设定，M2-B2 已交付部分）、AT-FLOW-1 |
| F-WRK-06 | AT-SET-1/2/6/10（境界体系）、AT-FLOW-1、AT-CONT-3 |
| F-WRK-07 | AT-SET-13/14/15/16/17/19/20/22（**完成**：持有人由事件流回放派生、item 卡片时间线入口、删除当前持有人 409；**AT-CHK-4 待章节**）、AT-FLOW-1 |
| F-WRK-08 | AT-CHK-3（资源）、AT-FACT-2 —— **暂停**（个人可用版优先，A1 工作流内核先行；不删除） |
| F-WRK-09 | AT-SET-11/13/15（**已完成**）、AT-FLOW-1（功法） |
| F-WRK-11 | AT-SET-16/17/18/19/21/22（**完成**：追加 / 冲正 / 回放 / 序号 / append-only + 时间线 UI 与 E2E；**AT-CHK-4 待章节**） |
| F-WRK-15 | AT-CHK-5（认知）——**仍待 M6 事实版本系统交付，M2-B2 未交付** |
| F-WRK-16 | AT-FORE-1/2/3/4（伏笔） |
| F-WRK-17 | AT-CHK-6（时间线） |
| F-OL-01 | AT-FLOW-1（卷纲） |
| F-OL-02 | AT-FLOW-1（阶段目标） |
| F-OL-03 | AT-FLOW-1（细纲） |
| F-OL-04 | AT-FLOW-1（节拍） |
| F-OL-06 | AT-FLOW-1（状态流转） |
| F-DRAFT-01 | AT-FLOW-1（生成正文）、AT-F1/F2 |
| F-DRAFT-02 | AT-VER-1~5（版本不覆盖） |
| F-DRAFT-03 | AT-CAND-1~8（候选区与并发采纳） |
| F-DRAFT-04 | AT-C2、AT-Q1（幂等） |
| F-DRAFT-05 | AT-VER-2（人工编辑） |
| F-DRAFT-06 | AT-VER-3（局部重写） |
| F-DRAFT-08 | AT-VER-4（版本恢复） |
| F-DRAFT-10 | AT-Q4（任务完成后再生成） |
| F-REV-01 | AT-CHK-1~7 |
| F-REV-02 | AT-CHK-* 证据格式断言 |
| F-REV-03 | AT-CHK-*（问题定位） |
| F-REV-06 | AT-CHK-*（规则包驱动） |
| F-CTX-01 | AT-R1/R2、AT-Q1~10 |
| F-CTX-02 | AT-CTX-1 |
| F-CTX-03 | AT-CTX-2 |
| F-CTX-04 | AT-Q9（取消）、AT-Q3/Q4（再次生成）、AT-Q5（Worker 重试） |
| F-FACT-01 | AT-FACT-1 |
| F-FACT-02 | AT-FACT-2/6 |
| F-FACT-03 | AT-FACT-3/4/5（原子/幂等/回滚） |
| F-FACT-04 | AT-FACT-8/9、AT-FACT-12/13/15（stale 冲正/重应用/物品转手失效） |
| F-FACT-05 | AT-FACT-10（过期事实不进上下文）、AT-FACT-11 |
| F-FACT-06 | AT-FACT-14（并发冲突 409） |
| F-FACT-07 | AT-FACT-16（stale 阻塞下一章） |
| F-EXP-01 | AT-EXP-1/2 |
| F-ADM-01 | AT-AUTH-1/7 |
| F-ADM-02 | AT-CTX-3/4/5 |
| F-ADM-03 | AT-CTX-2 |
| F-PRV-01 | AT-PRV-1/2/6/7/8 |
| F-PRV-02 | AT-PRV-5（管理员自批，若决策为 B） |
| F-PRV-03 | AT-PRV-3/4（站内拒绝/待处理提示） |
| F-PRV-04 | AT-PRV-9/10/11（密码重置/停用/重置后访问审计） |

---

## 16. 验收通过口径（呼应 `00` §8）

- P0 用例 100% 通过，P1 ≥90%（桩模型自动化部分）。
- 存在 1 部作品完成 10 章（AT-CONT-1，真实模型），且质量指标达标（§10）。
- 故障无半写、无重复：AT-R1/AT-F1/AT-F2/AT-C2/AT-C3/AT-Q1/AT-Q6/AT-FACT-3/AT-FACT-5/AT-CAND-7 全绿。
- 一致性：AT-CHK-1~7 全绿（7 类检查均可触发且证据完整）。
- 事实闭环：AT-FACT-8/9/10/12/14/16 全绿（stale 冲正/上下文过滤/并发冲突/阻塞）。
- 隐私：AT-PRV-1/2/6/7/8/9 全绿。
- 备份恢复：AT-BK-1 全绿。
- 许可证检查通过（见 `05` §6）。

> 说明：上述用例由实现方在阶段二落地为自动化测试（桩模型优先）；本轮仅定义用例，**不视为已通过**。

---

## 17. 工作流内核验收（A1-1）

> 对应 `docs/07-master-roadmap.md` A1-1、`docs/08-workflow-and-agents.md`。
> A1-1 **不交付** Planner/Writer、生成 API/UI、章节候选/版本；这些属于 A1-2/A1-3。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-1 | Provider 接口与 MockProvider | Mock 不联网、输出确定、深拷贝隔离；同一输入两次结果相等 | `test/mock-provider.test.ts` |
| AT-WF-2 | 非法 JSON 被 Schema 拒绝 | 缺字段/类型错/未声明字段/超长/非法枚举均被拒绝；错误只带路径与原因 | `test/json-schema.test.ts`、`test/agent.test.ts` |
| AT-WF-3 | API Key / prompt 不出现在错误与日志 | Provider 错误只含固定文案与状态码；`llm_call_logs` 无 prompt/正文列；任务错误只存安全文案 | `test/openai-provider.test.ts`、`test/worker.test.ts`、`test/queue.test.ts` |
| AT-WF-4 | 两个 Worker 并发领取同一任务 | 只有一个成功；`attempt_count` 只 +1 | `test/queue.test.ts`、`test/worker.test.ts` |
| AT-WF-5 | 租约过期可恢复 | 过期后 sweep 重新排队；新 Worker 可完成；旧 Worker 写入全部 0 行 | `test/queue.test.ts`、`test/worker.test.ts` |
| AT-WF-6 | heartbeat 延长租约 | `lease_until` 明显后移；执行期间可观察到心跳更新 | `test/queue.test.ts`、`test/worker.test.ts` |
| AT-WF-7 | attempt_count / max_attempts | 未用尽回到 queued；用尽转 failed；不可重试一次即 failed | `test/queue.test.ts`、`test/worker.test.ts` |
| AT-WF-8 | cancel_requested_at 阻止后续步骤，且优先于完成/失败 | 步骤之间检测到取消即停止；queued 取消后不再被领取；processing 中取消后即使步骤成功或抛可重试错误也进入 cancelled，不 requeue、不写 succeeded，且清空锁/租约/错误字段 | `test/kernel.test.ts`、`test/worker.test.ts`、`test/queue.test.ts` |
| AT-WF-9 | 同 work_id + request_id 只创建一个任务（request_id + input_hash） | 同键同指纹（对象 key 顺序不同）返回既有任务；chapterId/taskType/inputSnapshot/provider/model/maxAttempts 任一变化 → `TASK_REQUEST_CONFLICT`；并发同键异内容只有一行 + 一个冲突；`input_hash` 为 64 位摘要，不含正文/prompt | `test/queue.test.ts`、`test/request-hash.test.ts` |
| AT-WF-10 | 非法状态迁移被拒绝 | queued→succeeded 被数据库拒绝；终态不可再修改 | `test/queue.test.ts` |
| AT-WF-11 | chapters 数据隔离 | `UNIQUE(work_id, chapter_no)`；不同作品可同章号；跨作品章节不能建任务 | `test/queue.test.ts` |
| AT-WF-12 | 既有测试不减少 | 既有 390 个测试全绿；A1-1 系列（含 REV-01）新增 118 个 | 全量 `pnpm test` |

**未交付（不得标记完成）**：生成 API、章节 UI、候选采纳、`chapter_versions`、
Reviewer/Continuity/Fact、RAG/图数据库、资源流水（M2-B4 暂停）、多人功能。

---

## 18. 单章候选流水线验收（A1-2）

> 对应 `docs/07-master-roadmap.md` A1-2、`docs/08-workflow-and-agents.md` §12。
> A1-2 **不交付** HTTP API、章节 UI、候选采纳与 `chapter_versions`；这些属于 A1-3。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-13 | MockProvider 跑通 assemble → planner → contract → writer → candidate | 任务 `succeeded`、`current_step = persist_candidate`、章节 `in_review`、候选 ≥1200 字 | `test/chapter-workflow.test.ts` |
| AT-WF-14 | 合同正确落库 | `goal / must_include / must_not_include / scene_beats(characters+scenes) / target_words` 与 Planner 输出一致；`version_no = 1`、`status = frozen` | 同上 |
| AT-WF-15 | task_contexts 真实来源与顺序 | `chapter → character → realm_level → faction → work_direction`，rank `1/100…/200…/300…/400`，snippet ≤500，秘密字段不出现 | 同上 |
| AT-WF-16 | LLM 调用日志 | planner 与 writer 各一条成功记录（stage / provider / token / 延迟）；失败调用也落一条 `success=false` + 稳定错误码 | 同上 |
| AT-WF-17 | Planner 非法输出 | 缺字段 / 空 scenes / targetWords 越界 / 未声明字段 → `failed`，无合同、无候选，章节仍 `planned` | `test/chapter-agents.test.ts`、`test/chapter-workflow.test.ts` |
| AT-WF-18 | Planner 代码校验 | 空白 goal / 空白场景字段 → `failed`，不写合同 | `test/chapter-agents.test.ts`、`test/chapter-workflow.test.ts` |
| AT-WF-19 | Writer 少于 1200 字 | `failed`，无候选，章节停在 `drafting` | `test/chapter-workflow.test.ts` |
| AT-WF-20 | Provider 超时 | 可重试（`MODEL_TIMEOUT`），无合同/候选；重试后成功且只有一份合同/候选 | 同上 |
| AT-WF-21 | 合同复用 | Writer 超时重试不复用 Planner：合同只有 1 份、planner 日志只有 1 条、writer 日志 2 条 | 同上 |
| AT-WF-22 | 候选复用 | 已有候选（模拟写候选后崩溃）重试：不重复插行、不再调用模型、llm 日志为 0 | 同上 |
| AT-WF-23 | 字数由服务端计算 | `word_count = countWords(content)`，与正文空白无关，不读取模型自报字数 | 同上 |
| AT-WF-24 | 失败 / 取消后的章节状态 | Planner 失败 `planned`；Writer 失败/取消 `drafting`；均无候选、无正式正文 | 同上 |
| AT-WF-25 | 审计脱敏 | 合同冻结 / 三次状态迁移 / 候选创建均有审计；detail 不含正文、goal、API Key、邮箱 | 同上 |
| AT-WF-26 | 跨作品隔离 | 模型输入与 task_contexts 只含本作品数据，不含另一作品的名称/方向/账号 | 同上 |
| AT-WF-27 | 数据库归属约束 | 复合外键拒绝"跨作品的合同"与"跨任务引用合同"的候选 | 同上 |
| AT-WF-28 | 既有测试不减少 | 既有 508 个测试全绿；A1-2 + REV-01 共新增 35 个（workflow 153） | 全量 `pnpm test` |
| AT-WF-29 | 模型解析 | 章节 Agent 空模型 → OpenAI 请求体使用 `MODEL_NAME`；显式模型覆盖生效；失败日志记录解析后的模型且不含 Key/prompt | `test/openai-provider.test.ts`、`test/agent.test.ts`、`test/mock-provider.test.ts`、`test/chapter-workflow.test.ts` |
| AT-WF-30 | 合同/候选不可变 | 直接 SQL / Prisma 更新合同 goal/scene_beats、删除合同、更新候选 content/word_count/structured_plan、删除候选全部失败；唯一放行 `candidate → adopted`；正常读取不受影响 | `test/chapter-workflow.test.ts` |
| AT-WF-31 | Planner 语义校验 | 虚构人物、改动 targetWords → `failed`，合同/候选 0；合法人物通过 | `test/chapter-agents.test.ts`、`test/chapter-workflow.test.ts` |
| AT-WF-32 | 上下文 50 条上限 | 60 个人物时 Planner 输入恰好 50 条、Schema 不失败；task_contexts 只含选中实体；`context.truncated`（ref_id=null、rank=500）留痕 | `test/chapter-workflow.test.ts` |

**未交付（不得标记完成）**：生成 API、章节工作台 UI、`source='human'` 的人工修订、
版本恢复与 diff、Reviewer/Continuity/Fact、RAG/图数据库、资源流水（M2-B4 暂停）、多人功能。

---

## 19. 候选采纳与正式版本验收（A1-3A）

> 对应 `docs/07-master-roadmap.md` A1-3A、`docs/08-workflow-and-agents.md` §13。
> A1-3A **只交付数据库与服务层**：没有 HTTP API、没有章节 UI、没有版本恢复 / diff。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-33 | 正常采纳 | 候选 `adopted`、正式版本 `version_no=1`、`source='ai'`、`parent_version_id=NULL`、`created_by=作者`、章节 `in_review` | `test/chapter-adoption.test.ts` |
| AT-WF-34 | 正文与字数 | 正式版本 `content` 与候选逐字节一致（含空白/换行）；`word_count = countWords(content)` 且等于候选字数 | 同上 |
| AT-WF-35 | 版本链 | 第二个候选得到 `version_no=2`，`parent_version_id` 指向版本 1 | 同上 |
| AT-WF-36 | 重复采纳幂等 | `deduplicated=true`、返回同一 `versionId`；版本数不变、采纳审计不增加；章节后来被 `finalized` 也不影响 | 同上 |
| AT-WF-37 | 并发同候选 | 只生成 1 个正式版本；后到请求返回既有版本或 `CHAPTER_VERSION_CONFLICT` | 同上 |
| AT-WF-38 | 并发不同候选 | 同章节两个候选并发采纳得到版本号 1 / 2，`parent_version_id` 正确 | 同上 |
| AT-WF-39 | 状态拒绝 | `finalized` / `abandoned` 章节 → `CHAPTER_STATE_INVALID_FOR_ADOPTION`；候选仍 `candidate`、版本 0、章节状态不变 | 同上 |
| AT-WF-40 | 归属与存在性 | 跨作品 / 跨章节候选 → `CHAPTER_CANDIDATE_NOT_FOUND`（404）；他人作品 → `NOT_FOUND`（404） | 同上 |
| AT-WF-41 | 非 candidate 状态 | 候选被绕过服务层写成 `adopted` 但无版本 → `CHAPTER_VERSION_CONFLICT`，不产生版本 | 同上 |
| AT-WF-42 | 审计与回滚 | 采纳审计 detail 仅 `workId/chapterId/candidateId/versionId/versionNo/wordCount`，不含正文；审计写入失败 → 候选、版本、章节状态全部回滚 | 同上 |
| AT-WF-43 | 正式版本 append-only | 直接 SQL 修改 `version_no` / `content` 或删除版本全部失败 | 同上 |
| AT-WF-44 | adopted 候选不可改 | 修改 adopted 候选正文 / 字数、回退状态、删除全部失败 | 同上 + `test/chapter-workflow.test.ts` |
| AT-WF-45 | 既有测试不减少 | 既有 543 个测试全绿；A1-3A 新增 15 个（workflow 168） | 全量 `pnpm test` |

---

## 20. 章节与生成任务 API 验收（A1-3B）

> 对应 `docs/07-master-roadmap.md` A1-3B、`docs/08-workflow-and-agents.md` §14。
> A1-3B **只有后端接口与前端客户端函数**：没有章节 UI、编辑器、`human` 版本、
> 版本恢复 / diff，也没有启动 `apps/worker` 常驻循环。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-46 | 未登录 | 任意章节接口 → 401 `UNAUTHENTICATED` | `test/chapter-api.test.ts` |
| AT-WF-47 | 创建章节 | 201、`status=planned`、标题 trim；`chapter.created` 审计 detail 仅 `workId/chapterId/chapterNo` | 同上 |
| AT-WF-48 | 章号与参数 | 重复章号 → 409 `CHAPTER_NO_TAKEN`；章号 0 / 负数 / 小数 / 字符串、空标题、超长标题、提交 `status` / `createdAt` → 400 | 同上 |
| AT-WF-49 | 归属与角色 | 他人作品 → 404；管理员 → 403；缺 Origin 的写接口 → 403 | 同上 |
| AT-WF-50 | 创建生成任务 | 201；`taskType=chapter.draft`；`provider` / `model` 等于服务端配置（`openai-compatible` / `MODEL_NAME`）；`input_snapshot` 只含 `targetWords/style` | 同上 |
| AT-WF-51 | 客户端不可覆盖服务端字段 | 提交 `provider` / `model` / `authorId` / `status` / `workId` / `inputSnapshot` → 400，且不建任务 | 同上 |
| AT-WF-52 | requestId 幂等 | 同键同内容 → 200 + 同一任务、库中 1 行；同键异内容 → 409 `TASK_REQUEST_CONFLICT` | 同上 |
| AT-WF-53 | 任务读取与取消 | GET 只返回安全摘要（无 `inputSnapshot`/`requestId`/租约）；取消 queued → `cancelled` 且清空锁；取消 processing → 保留 `processing` + `cancel_requested_at` | 同上 |
| AT-WF-54 | 候选读取隔离 | 作者可读完整正文与 `wordCount`；他人 404；管理员 403；跨章节 → 404 `CHAPTER_CANDIDATE_NOT_FOUND` | 同上 |
| AT-WF-55 | 采纳 | 201 + `versionNo=1` / `chapterStatus=in_review` / `deduplicated=false`，响应不含正文；重复采纳 200 + `deduplicated=true`，版本仍 1 条 | 同上 |
| AT-WF-56 | 采纳边界 | `finalized` 章节 → 409 `CHAPTER_STATE_INVALID_FOR_ADOPTION`；跨作品候选 → 404；缺 Origin → 403；未知字段 → 400 | 同上 |
| AT-WF-57 | 响应脱敏 | 任务 / 候选 / 采纳响应不含 `inputSnapshot`、`requestId`、API Key 或正文错误细节 | 同上 |
| AT-WF-59 | 生成入口状态闸门（A1-3B-REV-01） | `finalized` / `abandoned` 章节提交生成 → 409 `CHAPTER_STATE_INVALID_FOR_GENERATION`，任务数与审计数均不变；`planned/outlined/drafting/in_review` 均可创建任务 | `test/chapter-api.test.ts` |
| AT-WF-60 | Worker 侧竞态保护（A1-3B-REV-01） | 任务排队后章节被 `finalized` / `abandoned` → Worker `failed`（`TASK_INPUT_INVALID`），合同 / 候选 / 正式版本均 0；合同冻结后、候选写入前被定稿 → 持久化抛错、无候选；`drafting / in_review` 不受影响 | `test/chapter-workflow.test.ts` |
| AT-WF-61 | requestId 幂等优先（A1-3B-REV-02） | 章节定稿后用同 requestId 同内容重试 → 200 返回原任务、任务数不变；同 requestId 不同 `targetWords` → 409 `TASK_REQUEST_CONFLICT`（不是状态错误）；同场景换全新 requestId → 409 `CHAPTER_STATE_INVALID_FOR_GENERATION` | `test/chapter-api.test.ts` |
| AT-WF-62 | 共享章节开放白名单（A1-3B-REV-02） | 生成与采纳共用 `isChapterOpenForGeneration`；采纳关闭态仍报 `CHAPTER_STATE_INVALID_FOR_ADOPTION`；已 adopted 候选在定稿章节重复采纳仍返回既有版本 | `test/chapter-adoption.test.ts`、`test/chapter-workflow.test.ts` |
| AT-WF-58 | 既有测试不减少 | 既有 582 个测试全绿；A1-3B-REV-02 新增 3 个（web 159） | 全量 `pnpm test` |

## 21. 章节工作台验收（A1-4A）

> 对应 `docs/07-master-roadmap.md` A1-4A、`README`「章节工作台」。
> 本轮只开放：章节列表 / 创建、提交生成、轮询、取消、候选预览、采纳、正式正文阅读。
> **不提供**人工编辑、`human` 版本、版本 diff / 恢复、Reviewer / RAG。
> **A1-4A-REV-01** 追加：取消后作废 requestId（AT-WF-68）、目标字数默认值收敛（AT-WF-67A）、
> 终态步骤文案改为「最后步骤：…」（AT-WF-67）。
> **A1-4A-REV-02** 追加：顶部提示随任务状态变化（AT-WF-68A）。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-63 | 章节列表 API | `GET /chapters` 按 `chapterNo` 升序；只含 `id/workId/chapterNo/title/status/latestTaskStatus/latestTaskStep/updatedAt`，无正文；未登录 401、他人作品 404、管理员 403 | `test/chapter-read-api.test.ts` |
| AT-WF-64 | 版本摘要 API | `GET /versions` 按 `versionNo` 倒序；只含 `id/versionNo/source/wordCount/createdAt`，无正文；他人 404、管理员 403 | 同上 |
| AT-WF-65 | 版本正文 API | `GET /versions/:versionId` 返回正文与元信息；跨作品 / 跨章节 / 不存在 → 404；管理员 403；响应不含 prompt / 任务快照 / Key | 同上 |
| AT-WF-66 | 页面入口 | 作品详情出现「进入章节创作」；章节列表空态、创建表单、章号冲突稳定中文、状态徽标 | `e2e/chapter-workbench.spec.ts` |
| AT-WF-67 | 生成与轮询 | requestId 仅在组件内存（同内容重复点击复用，终态或取消成功后作废）；1s→5s 轮询；只轮询 queued/processing；六步 `currentStep` 中文（进行中「正在…」、终态「最后步骤：…」）；隐藏页暂停、re-focus 立即刷新；卸载清理 timer | `test/chapter-workbench.test.ts`、`e2e/chapter-workbench.spec.ts` |
| AT-WF-67A | 目标字数默认值 | 作品目标 1200..10000 与表单 2500..4000 不一致时，表单默认值经 `clampChapterTargetWords` 收敛，页面仍显示作品原始值；1200→2500、6000→4000、NaN/3000.5→3000 | `test/chapter-workbench.test.ts`、`e2e/chapter-workbench.spec.ts` |
| AT-WF-68 | 取消与关闭态 | queued/processing 显示取消；取消后刷新章节/任务/候选并作废 requestId（即使接口仍返回 processing + cancelRequestedAt，再次生成必须换新 id）；`finalized/abandoned` 无生成控件并显示稳定提示 | 同上 |
| AT-WF-68A | 生成提示一致性 | 只有 `queued/processing` 显示「正在等待 Worker 领取…」；`succeeded` → 「生成完成，候选已保存」；`cancelled` → 「生成任务已取消」；`failed` → 无顶部提示（只留红色 `task-error`）；`cancelRequestedAt` 非空 → 「已请求取消生成」；采纳成功提示覆盖生成提示；刷新已完成任务不回到等待提示 | `test/chapter-workbench.test.ts`、`e2e/chapter-workbench.spec.ts` |
| AT-WF-69 | 候选预览 | 章节详情只含摘要；点击候选后才 GET 正文；纯文本 `pre-wrap`；显示字数/状态/时间；结构化计划可折叠 | 同上 |
| AT-WF-70 | 采纳 | 仅 `candidate` 显示采纳；二次确认；首次 201、重复 200 `deduplicated`；成功后刷新并自动选中最大版本，显示「已生成正式版本 N」；失败不做乐观更新 | 同上 |
| AT-WF-71 | 正式阅读 | `pre-wrap` 纯文本；显示版本号 / 来源 AI/人工 / 字数 / 时间；刷新后仍在；提示人工编辑下阶段开放 | 同上 |
| AT-WF-72 | 权限与脱敏 | 401 跳登录；404 显示作品/章节不存在；管理员 403；页面与截图不含邮箱、口令、Cookie、令牌 | 同上 |
| AT-WF-73 | 移动端 | 390×844 可创建章节、生成、候选预览与正式阅读，`scrollWidth <= viewport + 1` | 同上 |
| AT-WF-74 | 既有测试不减少 | 全量单测 **685**（A1-3C 651 + A1-4A 21 + REV-01 7 + REV-02 6）；浏览器 E2E 67 + A1-4A 10 + REV-01 2 + REV-02 1 = **80** | 全量 `pnpm test`、`playwright test` |

## 22. 人工章节版本保存验收（A1-4B-A）

> 对应 `docs/07-master-roadmap.md` A1-4B-A、`docs/08` 第 17 节。
> 本轮只开放**服务层与 HTTP API**（以及前端客户端函数）：
> **不提供** Markdown 编辑器 UI、版本 diff / 恢复、局部重写、定稿流程按钮。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-75 | 首版 | 无正式版本时 `baseVersionId=null` → 201，`versionNo=1`、`source=human`、`parentVersionId=null`，章节进入 `in_review` | `test/chapter-human-version.test.ts` |
| AT-WF-76 | 追加版本 | 基于版本 1 保存 → `versionNo=2`、`parentVersionId=版本 1`；版本 1 原样保留 | 同上 |
| AT-WF-77 | 字数服务端计算 | 服务端 `trim` 后写入，`wordCount` 按非空白字符重新计算，忽略客户端任何字数声明 | 同上 |
| AT-WF-78 | 正文校验 | 空白 / <1200 非空白字符 / >200000 字符 → 400 `CHAPTER_CONTENT_INVALID`，文案「章节正文不合法，请检查字数和内容」，不产生版本 | 同上 |
| AT-WF-79 | 基线冲突 | 旧 `baseVersionId`、或已有版本却传 `null` → 409 `CHAPTER_VERSION_CONFLICT`，无新版本 | 同上 |
| AT-WF-80 | 并发同 base | 两个并发请求同一 base → 恰好 201 + 409，只新增一个版本，版本号连续 | 同上 |
| AT-WF-81 | 并发不同 base | 不跳号、不覆盖；旧 base 一方 409 | 同上 |
| AT-WF-82 | 章节状态 | `finalized` 保存后回到 `in_review`；`abandoned` → 409 `CHAPTER_STATE_INVALID_FOR_SAVE`；`planned/outlined/drafting` 保存后进入 `in_review` | 同上 |
| AT-WF-83 | 权限与白名单 | 跨作品 / 跨章节 404；管理员 403；缺 Origin 403；未登录 401；`source` / `versionNo` / `createdBy` / 归属 / 时间戳 → 400；缺 `baseVersionId` → 400 | 同上 |
| AT-WF-84 | 审计与回滚 | 审计 `chapter.version_created` 的 detail 只含 7 个字段、不含正文；审计写入失败 → 版本与章节状态整体回滚 | 同上 |
| AT-WF-85 | 既有测试不减少 | 全量单测 **703**（A1-4A 685 + A1-4B-A 18）；浏览器 E2E 仍 **80** | 全量 `pnpm test`、`playwright test` |

## 23. 章节人工编辑器验收（A1-4B-B）

> 对应 `docs/07-master-roadmap.md` A1-4B-B、`README`「章节人工编辑」。
> 本轮只开放**编辑器与保存 UI**：**不提供**版本 diff、历史版本恢复、局部重写、定稿流程按钮。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-86 | 编辑入口 | 无正式版本时显示「手动创建第一版」（`baseVersionId=null`）；有版本时只在选中**最新**版本时显示「编辑最新版本（版本 N）」；选中旧版本显示「历史版本只读，请先选择最新版本再编辑」且不提供编辑器 | `e2e/chapter-workbench.spec.ts` |
| AT-WF-87 | 编辑器 | textarea 预填最新正式正文；实时显示非空白字符数、距 1200 下限差额、是否 dirty；`Ctrl/Cmd+S` 保存并阻止默认行为；保存中禁用输入与按钮；草稿不写 URL / localStorage / sessionStorage | `test/chapter-editor.test.ts`、`e2e/chapter-workbench.spec.ts` |
| AT-WF-88 | 保存成功 | 关闭编辑器、提示「已保存正式版本 N」、刷新版本列表与章节状态、自动选中最新版本并展示正文；旧版本原样保留；新版本来源显示「人工」，AI 版本仍显示「AI」；刷新后仍在 | 同上 |
| AT-WF-89 | 编辑器内取消保护 | 有修改时点击取消弹二次确认（可继续编辑）；放弃后编辑器关闭、草稿消失且未落 URL / localStorage / sessionStorage（`beforeunload` 单独见 AT-WF-96） | 同上 |
| AT-WF-90 | 失败处理 | 短正文 → `CHAPTER_CONTENT_INVALID` 且草稿保留；`CHAPTER_VERSION_CONFLICT` → 「正文已被其他操作更新，请重新载入最新版本」+「载入最新版本」按钮，草稿保留；`CONCURRENT_MODIFICATION` 可重试；`CHAPTER_STATE_INVALID_FOR_SAVE` 稳定文案；会话错误走统一处理 | 同上 |
| AT-WF-91 | 首版手写 | 无正式版本时手动创建版本 1（`source=human`、`parentVersionId=null`），章节进入 `in_review` | 同上 |
| AT-WF-92 | 移动端 | 390×844 可编辑、保存、刷新阅读，`scrollWidth <= viewport + 1` | 同上 |
| AT-WF-93 | 安全 | Markdown 以纯文本编辑与 `pre-wrap` 阅读，不使用 `dangerouslySetInnerHTML`；页面、DOM 与截图不含口令 / 邮箱 / Cookie / 令牌 / 其它作者数据 | 同上 |
| AT-WF-94 | 既有测试不减少 | 全量单测 **716**（703 + 编辑器纯逻辑 13）；浏览器 E2E 80 + 7 = **87**（REV-01 后见 AT-WF-99） | 全量 `pnpm test`、`playwright test` |

### A1-4B-B-REV-01 追加：草稿丢失保护

> **修正说明**：AT-WF-89 原先写作「`beforeunload` 提示」，但此前只有代码监听、
> 没有自动化断言（浏览器原生 `beforeunload` 弹窗无法脚本断言）。本轮拆分为：
> 编辑器内取消（AT-WF-89）、应用内离开（AT-WF-95）、`beforeunload` 监听（AT-WF-96），
> 三者分别有自动化覆盖。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-95 | 应用内离开保护 | 有未保存修改时，点击「返回章节列表」、浏览器后退、退出登录都会先弹「放弃未保存的修改」；取消后停留原页，正文 / 基线 / 错误提示 / dirty 状态**完全不变**；确认后才执行原离开动作；无修改时直接离开、不弹窗。三个入口分别由用例 **21**（返回链接）、**22**（后退取消）、**28**（退出登录取消 + 确认）覆盖；确认后的落地页与历史由 **27**（返回链接）、**29**（后退）覆盖 | `e2e/chapter-workbench.spec.ts` 用例 21/22/27/28/29、`test/chapter-editor.test.ts` |
| AT-WF-96 | `beforeunload` 监听 | 有未保存修改时派发合成 `BeforeUnloadEvent` → `defaultPrevented === true`；放弃草稿后同一事件 `defaultPrevented === false`（只断言事件被阻止，不断言浏览器原生弹窗） | `e2e/chapter-workbench.spec.ts` 用例 23 |
| AT-WF-97 | 冲突重载确认 | `CHAPTER_VERSION_CONFLICT` 后点「载入最新版本」先弹「载入将替换当前未保存草稿」；取消则草稿、错误、dirty 全保留；确认后草稿替换为最新正文、`baseVersionId` / baseline 更新、dirty 归零；载入期间按钮禁用 | `e2e/chapter-workbench.spec.ts` 用例 24、`test/chapter-editor.test.ts` |
| AT-WF-98 | 离开保护纯逻辑 | `leaveDecision` / `pendingLeaveFor`（只有 navigate 带地址）/ 三个入口的文案与按钮文案 / `needsReloadConfirmation` | `test/chapter-editor.test.ts` |
| AT-WF-99 | 测试数 | 全量单测 **721**（716 + 离开保护 5）；浏览器 E2E **91**（87 + 4） | 全量 `pnpm test`、`playwright test` |

### A1-4B-B-REV-02 追加：后退哨兵生命周期

> **根因**：REV-01 只在「编辑器关闭 / 保存成功 / 放弃草稿」时释放哨兵；
> `draftDirty` 从 true 变 false 但编辑器仍打开（撤销回原文、冲突后载入最新版）时
> 只移除了 popstate 监听，哨兵留在历史里 —— 第一次后退停在同 URL，
> 确认离开后还会在历史中留下重复的章节 URL。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-100 | 哨兵生命周期纯逻辑 | `sentinelTransition`：脏→`arm`、脏且已压→`keep`、**干净且已压→`release`**；`backStepsToLeave(armed)` 为 2/1；`hasEarlierEntry(压哨兵前条目数)`；`isSentinelState` 识别自己的 state | `test/chapter-editor.test.ts` |
| AT-WF-101 | 撤销回干净 | 修改后改回原文 → dirty 显示「无修改」→ 哨兵被释放（`history.state` 不再带标记）→ 后退一次回到章节列表，不停在同 URL | `e2e/chapter-workbench.spec.ts` 用例 25 |
| AT-WF-102 | 冲突重载后 | `CHAPTER_VERSION_CONFLICT` → 确认「载入最新版本」→ dirty 归零（编辑器仍打开）→ 哨兵释放 → 后退一次即离开 | 用例 26 |
| AT-WF-103 | 确认离开后历史干净 | dirty → 确认「返回章节列表」→ 后退 #1 回到章节页、后退 #2 回到更早的列表页；若残留哨兵，后退 #2 会停在同 URL 的章节页 | 用例 27 |
| AT-WF-104 | 退出登录 / 后退确认 | 退出登录：取消后仍登录、停在编辑器、草稿完整；确认后到 `/login`。后退确认：到达真实上一页，且 500ms 观察窗内不出现第二次弹窗 | 用例 28/29 |
| AT-WF-105 | 测试数 | 全量单测 **725**（721 + 哨兵 4）；浏览器 E2E **96**（91 + 5） | 全量 `pnpm test`、`playwright test` |

## 24. 章节版本 diff 验收（A1-4B-C-A）

> 对应 `docs/07-master-roadmap.md` A1-4B-C-A、`docs/08` 第 18 节。
> 本轮只开放**diff 服务与只读 HTTP API**：**不提供** diff UI、历史版本恢复为新版本、
> 定稿流程、局部重写；不改数据库结构（无新迁移）。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-106 | diff 契约 | `GET /api/works/:id/chapters/:chapterId/versions/diff?fromVersionId=&toVersionId=` → 200 `{ diff }`；`fromVersion` / `toVersion` 各含 `id` / `versionNo` / `source` / `wordCount`；`lines[]` 每项 `kind`（`equal` / `added` / `removed`）、`oldLineNo` / `newLineNo`（无对应侧为 `null`）、`text`；`stats` 为 `{added,removed,unchanged}` 且与 `lines` 实际条数一致，响应**不含完整正文** | `test/chapter-diff-api.test.ts` |
| AT-WF-107 | 换行归一化 | `\r\n` / `\r` / `\n` 视为同一种换行；末尾换行不再产生额外空行（`'a\n'` 与 `'a'` 无 diff 行）；中间空行保留；空正文得到空行数组 | `test/chapter-diff.test.ts` |
| AT-WF-108 | 行级语义 | 纯新增 / 纯删除 / 单行替换 / 多段修改各自只产生对应 `kind`，未变行保留为 `equal` 上下文；中文与 emoji 按整行比较，不拆分代理对 | 同上 |
| AT-WF-109 | 方向与确定性 | 同一版本对比自己 → 全 `equal`、`stats.added/removed` 为 0，不是错误；交换 `from` / `to` 后 `added` 与 `removed` 互换、行号各自从 1 开始；同一请求重复执行结果完全一致；后加新版本不影响已选两个版本的 diff | `test/chapter-diff.test.ts`、`test/chapter-diff-api.test.ts` |
| AT-WF-110 | 版本归属隔离 | 版本属于同一作者的**其它章节** → 404；属于**其它作品** → 404；随机 / 不存在的版本 id → 404；三种情况文案一致，不泄露 id 是否存在于别处（HTTP 与服务层直调均验证） | `test/chapter-diff-api.test.ts` |
| AT-WF-111 | 权限 | 未登录 401；管理员（非作者）403；他人作品 404；响应体不含作者 id、正文片段与数据库错误 | 同上 |
| AT-WF-112 | query 校验 | 缺 `fromVersionId` / 缺 `toVersionId` / 参数重复 / 空值 / 出现未知参数 → 400 `VALIDATION_FAILED`；非 UUID → 400；GET 不要求 `Origin`，不产生写入 | 同上 |
| AT-WF-113 | 规模保护 | 两侧任一侧字符数 > 200000 或行数超上限 → 400 `CHAPTER_DIFF_TOO_LARGE`（「章节正文规模超出对比上限」）；中间段编辑距离超上限时**退化为整段替换**（仍为确定结果，不报错、不挂起） | `test/chapter-diff.test.ts`；错误码登记见 `packages/auth/src/errors.ts`、`apps/web/src/lib/api.ts` |
| AT-WF-114 | 只读语义 | 单次 `findMany` 读取，不写审计、不新增 / 修改版本行、不改章节状态；调用前后版本行数与 `updatedAt` 不变 | `test/chapter-diff-api.test.ts` |
| AT-WF-115 | 既有测试不减少 | 全量单测 **756**（A1-4B-B 725 + diff 纯函数 17 + diff API 14）；浏览器 E2E 仍 **96**（本轮无 UI 变更） | 全量 `pnpm test`、`playwright test` |

## 25. 版本对比 UI 与历史版本恢复验收（A1-4B-C-B）

> 对应 `docs/07-master-roadmap.md` A1-4B-C-B、`docs/08` 第 19 节、`README`「版本对比与历史恢复」。
> 本轮**不实现**定稿流程（独立为 A1-4B-C-C）、不删除 / 覆盖历史版本、
> 不做 diff 内局部编辑、不修改 `chapter_versions` 表结构、不新增 migration。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-116 | 对比入口与默认选择 | 正式版本区「版本对比」按需展开：折叠态不渲染面板、不请求 diff；展开时默认目标=最新版本、起始=上一版；只有一个版本时自己比自己（起始=目标=该版本） | `e2e/chapter-workbench.spec.ts` 用例 30、`test/chapter-diff-view.test.ts` |
| AT-WF-117 | 对比结果 | 展示两侧版本元信息（版本号 · 来源 · 字数）、`stats` 中文统计、行列表；双列行号（无对应侧 `·` 占位）；`added` / `removed` 有「新增」「删除」中文标签（不只靠颜色）；行文本以 React 纯文本渲染，不使用 `dangerouslySetInnerHTML`；`added===0 && removed===0` 显示「两个版本内容一致。」 | 用例 30/31、`test/chapter-diff-view.test.ts` |
| AT-WF-118 | 切换与竞态 | 切换任一选择器立即清空旧结果并重新请求；响应按最近一次选择校验，被后发请求顶掉的结果不落盘；交换方向后 `added` / `removed` 互换；重复执行同一组合结果一致 | 用例 31、`test/chapter-diff-view.test.ts` |
| AT-WF-119 | 对比错误 | `CHAPTER_DIFF_TOO_LARGE` 显示「章节正文规模超出对比上限」且不渲染结果；404 / 会话错误走既有统一处理；形状不合法的响应按 `INTERNAL_ERROR` 拒绝（缺字段 / 类型错 / 行号与 kind 不自洽 / stats 与行数矛盾） | 用例 32、`test/chapter-diff-view.test.ts` |
| AT-WF-120 | 对比只读 | 对比前后选中版本不变、编辑器状态不变；不写 URL / localStorage / sessionStorage；不触发任何写接口 | 用例 30、`test/chapter-diff-view.test.ts` |
| AT-WF-121 | 对比移动端 | 390×844 下选择器竖排、可完成对比；长行换行、diff 区纵向滚动；`scrollWidth <= viewport + 1` | 用例 36 |
| AT-WF-122 | 恢复语义 | `POST /versions/:versionId/restore`：新版本 `versionNo=latest+1`、`source=human`、`parentVersionId=baseVersionId`、`restoredFromVersionId=来源版本`；正文与字数**原样复制**来源版本；旧版本（来源与中间版本）内容 / 字数完全不变；章节状态进入 `in_review`（`finalized` 也被拉回） | `test/chapter-restore-api.test.ts` |
| AT-WF-123 | 已是最新 | 恢复当前最新版本 → 409 `CHAPTER_VERSION_ALREADY_LATEST`（「该版本已是最新版本，无需恢复」），不新增版本 | 同上 |
| AT-WF-124 | 冲突与并发 | `baseVersionId` 过期 / 章节尚无版本 → 409 `CHAPTER_VERSION_CONFLICT`，不新增版本；同 base 并发恢复恰好 201 + 409，只新增一个版本且版本号连续 | 同上 |
| AT-WF-125 | 归属与权限 | 跨章节 / 跨作品 / 随机版本 id → 404「版本不存在」（HTTP 与服务层直调一致）；未登录 401；管理员 403；他人作品 404 | 同上 |
| AT-WF-126 | 请求校验 | 缺 `baseVersionId` / `null` / 空串 / 非字符串 / 未知字段 / 非法 UUID → 400 `VALIDATION_FAILED`；缺 Origin → 403；响应不含正文与作者 id | 同上 |
| AT-WF-127 | 审计与回滚 | 审计 `chapter.version_restored` 的 detail 只有 `workId / chapterId / versionId / versionNo / sourceVersionId / parentVersionId / wordCount` 7 个字段、不含正文；审计写入失败 → 版本与章节状态整体回滚 | 同上 |
| AT-WF-128 | 恢复 UI | 选中历史版本时出现「恢复此版本为新版本」；点击弹二次确认，明确「创建新版本、不删除历史」；取消不产生版本且保持选中；确认后提示「已从版本 N 恢复为版本 M」、关闭对比、刷新列表并自动选中最新；恢复中按钮禁用；冲突保留页面状态并提供「载入最新版本」；已是最新直接刷新；不提供覆盖 / 删除历史版本的操作 | 用例 33/34/35/36 |
| AT-WF-129 | 测试数 | 全量单测 **789**（756 + 恢复服务/API 18 + diff 视图纯逻辑 15）；浏览器 E2E **103**（96 + 7） | 全量 `pnpm test`、`playwright test` |

### A1-4B-C-B-REV-01 追加：diff 请求身份隔离

> **根因**：原实现只用"选择器组合"判断响应是否过期。但收起后重新展开会产生
> **完全相同**的 `fromVersionId` / `toVersionId`，选择器无法区分"相同组合的旧请求"
> 与"当前请求"：旧请求可能覆盖新结果 / 新错误，并在 `finally` 中无条件关闭
> loading，导致新请求仍在进行时加载态提前消失。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-130 | 请求身份 | 单调递增的请求序号是唯一身份：`openCompare` / `changeCompareFrom` / `changeCompareTo` / `closeCompare` 每次都使之前请求失效；只有当前序号可以写 `compareDiff` / `compareError` / 关闭 `compareLoading`；旧请求（成功或失败）完全静默——不显示旧 diff、不显示旧错误、不提前关闭 loading、不改选择器；旧请求的会话错误也不触发跳转 | `e2e/chapter-workbench.spec.ts` 用例 37–40 |
| AT-WF-131 | 相同选择器旧请求失败 | 请求 A 挂起 → 收起 → 同选择器再展开（请求 B）→ A 返回 `CHAPTER_DIFF_TOO_LARGE`：不显示错误、B 的 loading 不消失 → B 成功后才显示结果 | 用例 37 |
| AT-WF-132 | 旧请求成功 | 请求 A 挂起 → 切换选择器（请求 B）→ A 成功返回：不显示旧 diff、loading 保持 → B 失败后只显示当前错误，旧 diff 不出现 | 用例 38 |
| AT-WF-133 | 收起使请求失效 | 请求挂起时收起再展开：迟到响应不恢复 loading / result / error | 用例 39 |
| AT-WF-134 | loading 生命周期 | 当前请求完成前 loading 持续存在（观察窗内不消失），完成后才关闭并显示结果 | 用例 40 |
| AT-WF-135 | 测试数 | 全量单测仍 **789**（本轮无服务 / 纯逻辑改动）；浏览器 E2E **107**（103 + 4） | 全量 `pnpm test`、`playwright test` |

### A1-4B-C-B-REV-02 追加：E2E 夹具稳定性与全量验收

> **问题**：`installDiffGate` 用 `void target.route(...)` 注册拦截，未等待注册完成；
> 首个 diff 请求可能先打到真实接口，gate 永远收不到请求（`entries` 为空），
> 测试会以超时形式偶发失败。另外测试种入的"已请求取消"任务留在库里，
> 使"测试后无 queued / processing"的门禁失真。

| 编号 | 用例 | 预期 | 自动化位置 |
| --- | --- | --- | --- |
| AT-WF-136 | 夹具注册 | `installDiffGate` 为 async 并 `await target.route(...)`：注册完成后才返回，首个请求必定被拦截；`respond` / `abort` 返回 Promise 并在 handler 内 `await route.fulfill` / `route.abort`；`releaseAll` 等待所有在途 handler 结束后，`finally` 才 `unroute` | `e2e/chapter-workbench.spec.ts` |
| AT-WF-137 | 无残留任务 | `afterAll` 删除本 spec 用 `lockedBy='e2e-seed'` 种入的 `queued` / `processing` 任务；测试结束后 `generation_tasks` 只剩终态 | 同上；验收时直连数据库断言 |
| AT-WF-138 | 全量 E2E | 从**全新数据库**（重建 → 10 迁移 → 初始管理员）一次运行全部 spec：**107 passed / 0 failed / 0 skipped / 0 did not run** | `npx playwright test` |
| AT-WF-139 | 夹具灵敏度 | 临时改为"延迟注册"（`setTimeout` 500ms 后再 `route`）：用例 37 在 `waitFor(1)` 的 poll 断言处失败（`entries` 为空），证明"未等待注册"的竞态真实存在；恢复后 107 全通过 | 同上（临时改动后已还原） |
