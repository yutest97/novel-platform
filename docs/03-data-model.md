# 03 数据模型（Data Model）

- 版本：v1.3（方案稿，退回修订中，待技术负责人第四次定向复审）
- 状态：**未获批准。**

本文定义核心数据对象、字段、关系；重点说明**通用小说核心与玄幻规则包的边界**，以及数据隔离、版本化、任务持久化、事实闭环方案。

---

## 1. 设计原则

1. **题材解耦**：通用核心表不含任何题材专有列（境界、灵力、宗门、灵石、子类型、金手指、语气风格等一律禁止出现在核心表列名中）。题材专有数据进入通用 `entity` / `entity_attribute` / `work_settings`，字段元数据由规则包 JSON 定义。
2. **服务端隔离**：作品所有子对象都挂在 `work` 下，查询一律带 `work_id` 过滤；不依赖前端传参隐藏。
3. **不可变 + 版本化**：正文与关键设定采用"追加版本 + 不可变历史"模型，永不原地覆盖。
4. **事件溯源（关键资源）**：资源余额、物品持有人等以事件流水回放得出，不允许直接改当前值；流水有不可重复事件序号与冲正机制。
5. **任务持久化**：所有生成任务、上下文来源、Token 用量、错误记录落库，服务重启不丢；任务有租约与心跳。
6. **事实闭环**：正文事实提取后须人工确认，接受后原子回写人物/资源/设定状态。

---

## 2. 实体总览（ER 关系）

```
users (admin/author)  [status: active/disabled + must_change_password 布尔]
  └─ sessions
  └─ audit_logs (含正文查看/密码重置/停用审计)
  └─ content_access_requests (正文查看授权请求)   ★v1.3
  └─ content_access_grants (正文查看授权)          ★v1.3

works (所属 author_id)  [不含题材专有列]
  ├─ work_settings (规则包驱动的题材参数)
  ├─ volumes (卷)
  │    └─ chapters (章)
  │         ├─ chapter_outlines (细纲)
  │         ├─ chapter_beats (场景节拍)
  │         ├─ chapter_candidates (候选/草稿区)  ★v1.1
  │         ├─ chapter_versions (仅正式版本)     ★v1.1
  │         ├─ review_reports (一致性检查)
  │         └─ chapter_facts (事实主表)          ★v1.1
  │              ├─ fact_versions (事实版本)     ★v1.2
  │              ├─ fact_effects (结构化影响)    ★v1.2
  │              └─ fact_effect_applications (应用/冲正记录) ★v1.3
  ├─ story_arcs (情节弧：主线/支线)
  ├─ plot_threads (伏笔主表，含计划回收章)        ★v1.1
  │    └─ plot_thread_events (埋设/强化/回收)     ★v1.1
  ├─ timeline_events (时间线：区分叙事顺序与故事时间)  ★v1.1
  │    └─ causal_links (因果边)
  ├─ entities (通用实体：人物/势力/地点/物品/功法/资源/境界层级…)
  │    ├─ entity_attributes (规则包驱动的字段值)
  │    ├─ entity_relations (关系，含"谁知道"认知)
  │    └─ entity_versions (实体版本快照)
  ├─ item_events (物品流水，含序号+冲正)          ★v1.1
  ├─ resource_ledgers (资源流水，含序号+冲正)      ★v1.1
  ├─ knowledge_marks (认知：指向 fact_id + fact 版本) ★v1.1
  ├─ generation_tasks (生成任务，含租约/心跳/作用域)  ★v1.1
  │    ├─ task_contexts (上下文来源)
  │    └─ llm_call_logs (Token 用量与错误)
  └─ rule_package_bindings (作品绑定的规则包)

rule_packages (题材规则包，系统级)
  └─ rule_definitions (检查规则/字段 schema)
```

---

## 3. 核心对象与字段

> 字段为方案级定义；实现阶段落地为 Prisma schema / SQL 迁移。类型约定：`uuid`、`text`、`int`、`timestamptz`、`jsonb`、`boolean`。

### 3.1 users（v1.1 修正 status 语义）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| email | text UNIQUE | 登录标识 |
| password_hash | text | argon2id |
| role | enum('admin','author') | 仅两类 |
| status | enum('active','disabled') | **仅两值**；首登改密不再混入 status |
| must_change_password | boolean | **独立布尔**，首登强改由它控制（v1.0 曾把 `must_change_password` 作为 status 枚举值，已修正） |
| created_at / updated_at | timestamptz | |

**账号上限口径**：`count(*)`（含 disabled）≤ 10；新建时用 `pg_advisory_xact_lock`（或固定单行配额表加行锁）保证并发不突破（见 §6.1，v1.3 修正）。

**sessions（会话表，v1.2 补充会话安全）**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| user_id | uuid FK→users | |
| token_hash | text | 会话 token 的哈希（不存明文 token） |
| absolute_expires_at | timestamptz | **绝对有效期**（默认 7 天） |
| idle_expires_at | timestamptz | **空闲有效期**（默认 30 分钟；每次活动顺延） |
| last_activity_at | timestamptz | 最后活动时间 |
| created_at | timestamptz | |

**会话安全策略（v1.2 新增，回应审查第 10 条）**：
- Cookie：`HttpOnly + Secure + SameSite=Lax`。
- **会话轮换**：登录成功、改密、提升权限后**轮换会话 ID**（旧会话失效，防会话固定攻击）。
- **多设备上限**：单账号同时活跃会话 ≤ 5；超出时最旧会话被踢出。
- 服务端可强制下线任一账号全部会话（`sessions` 按 user_id 批量失效）。
- 修改数据的接口必须有 **Origin 校验或 CSRF token**（防跨站请求伪造，见 `05` §5）。

### 3.1.1 隐私授权对象（v1.3 新增，回应审查第 3 条）

**content_access_requests（正文查看授权请求）**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| requester_id | uuid FK→users | 发起人（管理员） |
| work_id | uuid FK→works | 目标作品 |
| chapter_id | uuid nullable | 目标章节（null = 整部作品） |
| reason | text | 申请事由 |
| status | enum('pending','approved','rejected','expired','revoked') | |
| approver_id | uuid nullable | 批准人（默认作品作者） |
| requested_at / decided_at | timestamptz | |

**content_access_grants（正文查看授权）**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| request_id | uuid FK→content_access_requests | |
| grantee_id | uuid FK→users | 被授权人 |
| scope_work_id | uuid FK→works | 授权范围：作品 |
| scope_chapter_id | uuid nullable | 授权范围：章节（null = 全作品） |
| expires_at | timestamptz | 授权有效期（默认 1 小时） |
| created_at | timestamptz | |

**audit_logs（审计日志）**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| actor_id | uuid FK→users | 操作者 |
| action | text | 动作（如 `content_view`、`password_reset`、`account_disable`、`account_create`、`export`、`task_retry`） |
| target_type / target_id | text / uuid | 目标（work/chapter/user…） |
| detail | jsonb | 明细（who/when/what/why） |
| ip / user_agent | text | |
| created_at | timestamptz | 不可篡改（append-only） |

> 以下**三类操作必须落审计**（v1.3 明确）：管理员**密码重置**、**账号停用/启用**、**正文查看**。审计日志 append-only，不提供更新/删除接口。

**技术边界（v1.3 修正过度承诺）**：本方案不宣称"管理员绝对无法查看正文"。应用层默认禁止管理员读正文、需临时授权，但**服务端所有者（持有 DB 凭证者）在数据库层面仍可读取任何数据**。因此表述统一为"应用层默认禁止 + 授权 + 审计"，不承诺"绝对无法访问"。

### 3.2 works（v1.1 删除题材专有列）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| author_id | uuid FK→users | **隔离根**：所有查询带 author_id 校验 |
| title | text | 作者内唯一 |
| genre_rule_package | text | 第一版恒 `xuanhuan`（**规则包指针，非题材字段**） |
| summary | text | 简介 |
| target_chapters | int | |
| target_words_per_chapter | int | 2500—4000 |
| created_at / updated_at | timestamptz | |

> **v1.1 修正**：删除 `sub_genre`、`golden_finger`、`tone_style` 三个题材专有列。题材参数（子类型、金手指、语气风格、主角定位等）改由 `work_settings` 承载，字段名与取值由规则包 `field_schema` 定义。

**work_settings**：`id, work_id, setting_key, setting_value(jsonb), schema_ref, created_at, updated_at`。
- `setting_key` 由规则包 field_schema 定义（如 `sub_genre`、`golden_finger`、`tone_style`、`protagonist_position`）。
- 页面表单由 field_schema 驱动渲染，不硬编码"金手指"标签。

### 3.3 volumes / chapters

| 对象 | 关键字段 |
| --- | --- |
| volumes | id, work_id, title, order_index, arc_id(可选) |
| chapters | id, work_id, volume_id, order_index, title, status(enum: planned/outlined/drafting/in_review/finalized/abandoned), target_words, summary(章节摘要) |
| chapter_outlines | chapter_id, content(jsonb: 目标/冲突/伏笔动作/结尾钩子), edited_flag, version |
| chapter_beats | chapter_id, beats(jsonb: 每节拍视角/在场人物/地点/动作/情绪/字数预算) |

> **A1-1 实现口径（2026-11）**：本轮只落地最小 `chapters(id, work_id, chapter_no, title,
> status, created_at, updated_at)`，`UNIQUE(work_id, chapter_no)`，状态仍为六态（默认 `planned`）。
> `volumes`、`volume_id`、`order_index`、`target_words`、`summary`、`chapter_outlines`、
> `chapter_beats` 延后到章节工作台阶段（A1-2/A1-3）。

### 3.4 chapter_candidates + chapter_versions（v1.1 拆分草稿与正式版本）

**chapter_candidates（候选/草稿区）**：生成结果先落这里，**不直接成为正式版本**。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| chapter_id | uuid FK | |
| source_task_id | uuid FK→generation_tasks | 来自哪个生成任务 |
| content | text | 草稿全文 |
| char_count | int | 按 `00` §6.2 口径 |
| status | enum('pending','adopted','discarded') | pending=待采纳；adopted=已采纳；discarded=已放弃 |
| adopted_version_id | uuid nullable | 采纳后指向产生的正式版本 |
| created_at | timestamptz | |

**chapter_versions（仅正式版本，不可变）**：v1.1 起**只保存正式版本**，不再有 `draft` 标志。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| chapter_id | uuid FK | |
| version_no | int | 章节内递增，`(chapter_id, version_no)` 唯一 |
| author | enum('ai','human') | 版本来源 |
| content | text | 全文 |
| char_count | int | |
| parent_version_id | uuid nullable | 版本链（重写/恢复的父版本） |
| source_task_id | uuid nullable | 来自哪个生成任务 |
| source_candidate_id | uuid nullable **UNIQUE** | 若由候选采纳而来；**唯一约束**保证一个候选只对应一个正式版本 |
| created_at | timestamptz | 不可变，不更新 |

**采纳候选的事务流程（v1.2 修正：同时锁定候选行与章节行）**：
1. 开启事务。
2. `SELECT ... FOR UPDATE` 锁定该 **候选行**（chapter_candidates）与**章节行**（chapters）——两把锁，防并发采纳同一候选、也防并发采纳不同候选时版本号冲突。
3. 校验候选 `status = 'pending'`；若已 `adopted` 或 `discarded` → 返回 `409`（`adopted` 也可幂等返回已有版本号，见下）。
4. 计算 `next_version_no = max(version_no) + 1`。
5. 插入 `chapter_versions`（version_no = next_version_no，content 取自候选，source_candidate_id = 候选 id）。
6. 更新候选 `status='adopted', adopted_version_id=<新版本 id>`。
7. 提交事务。
- **并发采纳同一候选**：两个请求同时采纳同一候选，因候选行被 `FOR UPDATE` 锁定，后者在前者提交后重读，发现 `status='adopted'`，幂等返回已有版本号，**只产生一个正式版本**（source_candidate_id 唯一约束兜底）。
- **并发采纳不同候选**：章节行被锁定，`next_version_no` 计算串行化，版本号不冲突。
- 采纳 `discarded` 候选：返回 `409`。

### 3.4.1 A1-2 实现口径：chapter_contracts / chapter_candidates

> 本节以迁移 `20261104020000_a1_chapter_draft` 为准。§3.4 的采纳流程与
> `chapter_versions` 仍属 A1-3；A1-2 只交付"合同冻结 + 正文候选"。

**chapter_contracts（新增）**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| work_id / chapter_id / generation_task_id | uuid | 复合外键绑定同章同任务 |
| version_no | int | 章节内递增，`UNIQUE(chapter_id, version_no)` |
| goal | text | 1–500 字 |
| must_include / must_not_include | jsonb | string[] |
| scene_beats | jsonb | `{ version, characters: string[], scenes: [...] }` |
| target_words | int | 2500–4000 |
| status | text | 只有 `frozen` |
| created_at | timestamptz | |

**chapter_candidates（A1-2 口径）**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| work_id / chapter_id / generation_task_id | uuid | 每任务最多一条（UNIQUE） |
| contract_id | uuid | 必须引用**同一任务、同一章节、同一作品**的合同 |
| content | text | 正文全文（≥1200 字符，≤200000） |
| word_count | int | 服务端按"非空白字符数"统计（替代旧的 char_count） |
| structured_plan | jsonb | 计划快照（goal / scenes / characters / targetWords / 合同版本） |
| status | text | `candidate` / `adopted`（A1-3A 起：采纳事务把 candidate 迁到 adopted） |
| created_at | timestamptz | |

- `source_task_id` 在本实现中命名为 `generation_task_id`；
- 章节状态由工作流推进：合同 → `outlined`，Writer 开始 → `drafting`，候选写入 → `in_review`；
  采纳候选时若仍是 `planned / outlined / drafting` 也会推进到 `in_review`；
- 合同 / 候选 / 章节状态 / 审计在同一事务提交；失败或取消不会留下候选；
- 两张表都有 `BEFORE UPDATE / BEFORE DELETE` 触发器（`restrict_violation`）：
  合同完全不可改、不可删；候选只允许 `candidate → adopted` 这一条迁移，
  其余修改与删除全部拒绝。

### 3.4.2 A1-3A 实现口径：chapter_versions（正式章节版本）

> 本节以迁移 `20261104030000_a1_chapter_versions` 为准。A1-3A 只交付
> 数据库 + 服务层（`adoptChapterCandidate`），**没有 HTTP API / UI / 版本恢复 / diff**。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| work_id / chapter_id | uuid | 复合外键 `(chapter_id, work_id) → chapters(id, work_id)` |
| version_no | int | 章节内递增，`UNIQUE(chapter_id, version_no)` |
| content | text | 正式正文全文（1200..200000 字符），与来源候选逐字节一致 |
| word_count | int | 服务端统计；`CHECK word_count BETWEEN 1200 AND char_length(content)` |
| source | text | `ai` / `human`（本轮只写 `ai`，`human` 留给 A1-B） |
| source_candidate_id | uuid nullable | `source='ai'` 时必填；**部分唯一**：一个候选最多生成一个正式版本 |
| parent_version_id | uuid nullable | 同章节同作品的上一个正式版本；首版为 NULL |
| created_by | uuid | 当前作者（只来自会话） |
| created_at | timestamptz | `clock_timestamp()` |

- **append-only**：`BEFORE UPDATE / BEFORE DELETE` 一律 `restrict_violation`，
  修订只能追加新版本；
- 复合外键在数据库层钉死归属：
  `(source_candidate_id, chapter_id, work_id) → chapter_candidates(id, chapter_id, work_id)`、
  `(parent_version_id, chapter_id, work_id) → chapter_versions(id, chapter_id, work_id)`；
  外键列可空（MATCH SIMPLE），人工版本可以没有来源候选、首版没有父版本；
- 采纳事务同时完成：插入版本 → 候选 `adopted` → 章节 `in_review` → 两条审计；
  任何一步失败整体回滚，不会出现"候选 adopted 但无版本"。

### 3.5 entities + entity_attributes（题材解耦核心）

**entities**：`id, work_id, entity_type, name, created_at, updated_at, deleted_at(软删)`。
`entity_type` 枚举来自**规则包**（第一版 xuanhuan 提供：`character, faction, location, item, technique, resource_type, realm_level`）。

**entity_attributes**：`entity_id, attr_key, attr_value(jsonb/text), schema_ref`。
字段 schema 由 `rule_packages.field_schema` 定义，**不写死在核心表**。

> 例：`realm_level` 的"突破条件/寿命/战力基准"；`character` 的"秘密/初始境界/伤势"——都是 entity_attributes 的行。

**entity_relations**：`id, work_id, from_entity_id, to_entity_id, relation_type, note, knowledge_scope`。
- `relation_type` 来自规则包（"师徒""敌对""持有""属于某势力"）。
- `knowledge_scope` 用于认知建模，但**人物认知以 §3.11 knowledge_marks 为准**（指向 fact_id），relation 的 knowledge_scope 仅作设定层辅助。

**entity_versions**：设定条目每次修改存版本快照（`entity_id, version_no, snapshot(jsonb), created_at`），供章节生成时"当时用了哪版设定"的回放。

### 3.6 item_events / resource_ledgers（v1.1 增加序号与冲正）

| 对象 | 字段 | 说明 |
| --- | --- | --- |
| item_events | id, item_entity_id, event_type(obtained/consumed/lost/transferred), from_holder, to_holder, chapter_id, note, **seq_no**, **reversal_of**, created_at | 持有人 = 最后一条有效事件推导 |
| resource_ledgers | id, resource_type_id, delta, balance_after, chapter_id, reason, **seq_no**, **reversal_of**, created_at | 余额 = 最新 balance_after |

**不可重复事件序号**：`seq_no` 在 `(item_entity_id)` 或 `(resource_type_id)` 范围内单调递增且唯一（唯一约束），保证流水可严格按序回放。

**冲正机制**：发现录入错误时不删改历史行，而是追加一条 `reversal_of = <被冲正事件 id>` 的反向事件（delta 取反）。冲正事件自身也有新的 `seq_no`，不回填、不改历史。

### 3.7 叙事结构对象（v1.1 修正时间线/伏笔）

| 对象 | 关键字段 | 说明 |
| --- | --- | --- |
| story_arcs | work_id, title, kind(main/sub), description | 情节弧 |

**plot_threads（伏笔主表）**：
- `id, work_id, description, status(unresolved/resolved/abandoned), planned_resolve_chapter_id(uuid FK→chapters, nullable)`。
- `planned_resolve_chapter_id` 引用**稳定章节 ID**（非章号），章节插入/重排后计划回收位置仍正确。
- **不存 `planted_chapter` 章号**（章号会因插入调整而变化）。

**plot_thread_events（伏笔事件，v1.1 新增）**：
- `id, plot_thread_id, chapter_id(稳定 UUID), event_type(planted/reinforced/resolved/abandoned), note, created_at`。
- 通过多条事件支持**多次埋设、强化、回收**。

**伏笔状态判定规则（v1.2 明确）**：
- `reinforced`（强化）**不等于已回收**，仅表示伏笔被再次提及/加强，`status` 仍为 `unresolved`。
- 只有 `resolved`（回收）或**带理由的** `abandoned`（废弃，须填 note 说明原因）才视为**结束**。
- `status` 由事件回放得出：出现过 `resolved` → `resolved`；出现过带理由 `abandoned` → `abandoned`；否则 `unresolved`。
- 一致性检查（`03` §5.1 伏笔类）据此判定"未回收"。

**timeline_events（v1.1 区分两种时间）**：
- `id, work_id, event, involved_character_ids, chapter_id(叙事位置), story_time(故事世界时间，如"第一卷·第3日"或绝对纪年), story_order(故事世界顺序号)`。
- **叙事顺序** = `chapter_id`（出现在哪一章）；**故事世界时间** = `story_time` / `story_order`（故事内何时发生）。两者可不同（倒叙、插叙）。

**causal_links**：`from_event_id, to_event_id, note`（因果边，用于检测"果早于因"）。

### 3.8 chapters / generation_tasks / task_contexts / llm_call_logs（A1-1 实现口径）

> 本节以迁移 `20261104010000_a1_workflow_kernel` 为准。早期方案中的
> `pending/running`、`UNIQUE(user_id, request_id)`、`request_payload/input_hash`、
> `scope`、`total_tokens` 等字段在 A1-1 按实际实现收敛，差异见本节末尾。

**chapters**：`id, work_id, chapter_no, title, status, created_at, updated_at`。
`UNIQUE(work_id, chapter_no)`；`chapter_no >= 1`；状态六态；
FK `work_id → works` **ON DELETE RESTRICT**。本轮不建卷/大纲表。

**generation_tasks**：任务队列 + 租约。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| work_id | uuid FK→works | 作品隔离；RESTRICT |
| chapter_id | uuid nullable FK→chapters | A1-1 允许为空；A1-2 正文任务必填 |
| request_id | text | 客户端逻辑请求 id；与 work_id 组成幂等键 |
| input_hash | text | 请求内容的 SHA-256（64 位小写 hex）；覆盖 6 个语义字段，**不含正文/prompt** |
| task_type | text | 工作流类型（A1-1 为自由字符串，A1-2 收敛枚举） |
| status | text | `queued / processing / succeeded / failed / cancelled` |
| current_step | text nullable | 最近完成的步骤名（检查点） |
| input_snapshot | jsonb | 结构化输入，≤ 64 KiB；**不放 prompt/正文/密钥** |
| provider / model | text | 任务使用的 Provider 与模型（仅名称） |
| attempt_count / max_attempts | int | 领取即 +1；用尽转 failed |
| locked_by / lease_until / heartbeat_at | text/timestamptz | 租约三件套；processing 必须非空 |
| cancel_requested_at | timestamptz | 作者请求取消的时间 |
| error_code / error_message_sanitized | text | 稳定错误码 + 安全文案 |
| created_at / updated_at | timestamptz | |

`UNIQUE(work_id, request_id)`；`status` 白名单；`attempt_count <= max_attempts`；
`processing` 必须有锁与租约、其它状态必须没有；`char_length(input_hash) = 64`
且必须是 `^[0-9a-f]{64}$`；状态迁移由触发器校验，终态不可修改。

**状态机**：

```
queued ──claim──▶ processing ──complete──▶ succeeded
  │                   ├──retryable（未用尽）──▶ queued
  │                   ├──non-retryable / 用尽──▶ failed
  │                   └──cancel────────────────▶ cancelled
  └──cancel（未领取）──────────────────────────▶ cancelled
```

**幂等与租约**：

- 同 `work_id + request_id` 只创建一条任务，且**只有 `input_hash` 相同才复用**：
  同指纹返回既有任务（`created=false`）；异指纹稳定报 `TASK_REQUEST_CONFLICT`（409），
  不覆盖、不新建；并发同键异内容由唯一索引兜底为一胜一冲突；
- `input_hash` 覆盖 `chapterId / taskType / inputSnapshot / provider / model / maxAttempts`；
  `inputSnapshot` 先转 canonical JSON（对象 key 递归排序、数组保持顺序），
  拒绝 undefined / 函数 / BigInt / 循环引用等不可稳定序列化的值；
- Worker 用 `FOR UPDATE SKIP LOCKED` 领取 `queued`，写锁与租约、`attempt_count + 1`；
- 心跳失败（0 行）立即停止后续步骤；旧 Worker 的任何写入都带
  `locked_by` fencing，不会覆盖新 Worker；
- 租约过期由 sweep 回收：取消优先 → 次数用尽判 failed → 其余回 queued。

**task_contexts**：`id, task_id, context_type, ref_id, snippet, rank`。
`(task_id, context_type, ref_id)` 唯一；snippet ≤ 500（只存摘要，不存正文）；rank ≥ 0。

**llm_call_logs**：`id, task_id, stage, provider, model, prompt_tokens,
completion_tokens, latency_ms, success, error_code, created_at`。
**没有 prompt / 正文 / 响应列**；失败只记稳定 `error_code`。

**与早期方案的差异（A1-1 有意收敛）**：

| 早期方案 | A1-1 实现 | 原因 |
| --- | --- | --- |
| `status = pending/running` | `queued/processing` | 与"领取 queued"的队列语义一致 |
| `UNIQUE(user_id, request_id)` | `UNIQUE(work_id, request_id)` | 任务天然属于作品；同作者不同作品可复用 request_id |
| `request_payload` + `input_hash` | `input_snapshot` + `input_hash`（canonical JSON 的 SHA-256） | 只覆盖 6 个语义字段；同键异指纹 409 `TASK_REQUEST_CONFLICT` |
| `scope` / `task_type` 枚举 / `progress` | 暂未落地 | A1-2 接入 Planner/Writer 时按实际任务类型收敛 |
| `total_tokens` | 由两列相加得出 | 少一列冗余，避免不一致 |

### 3.9 rule_packages / rule_definitions（规则包，系统级）

| 对象 | 关键字段 | 说明 |
| --- | --- | --- |
| rule_packages | id, code(如 xuanhuan), name, version, field_schema(jsonb), active | 题材字段 schema + 检查规则元数据 |
| rule_definitions | package_id, category(realm/power/resource/item/knowledge/timeline/foreshadow), rule_key, rule_impl_ref, severity_default, active, params(jsonb) | 7 类检查规则定义 |

`rule_impl_ref` 指向检查器实现（代码内注册），规则包 JSON 描述"哪些检查启用、参数如何"。**题材逻辑进规则包 + 检查器插件，不进核心表**。

### 3.10 chapter_facts + fact_versions + fact_effects（v1.2 补全可执行事实回写模型）

**chapter_facts（事实主表，一条事实一个概念）**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| work_id | uuid FK | |
| chapter_id | uuid FK | 来源章节 |
| fact_type | enum(realm_change/resource_change/item_transfer/character_state/knowledge_change/plot_event) | |
| fact_text | text | 事实的自然语言描述（供展示） |
| status | enum('candidate','accepted','rejected','stale') | 候选/已接受/已拒绝/**已失效** |
| reviewer_id | uuid nullable | **审核人**（作者本人） |
| reviewed_at | timestamptz nullable | |
| created_at | timestamptz | |

**fact_versions（事实版本，v1.2 新增）**：事实内容与证据不可变，每次修订追加新版本。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| fact_id | uuid FK→chapter_facts | 所属事实 |
| version_no | int | 事实内递增，`(fact_id, version_no)` 唯一 |
| fact_text | text | 该版本的事实正文 |
| source_quote | text | 原文证据 |
| source_version_id | uuid FK→chapter_versions | 来自哪个正式章节版本 |
| entity_ids | jsonb | 涉及实体 |
| status | enum('candidate','accepted','rejected','stale','superseded') | 该版本的状态 |
| reviewer_id | uuid nullable | 该版本审核人 |
| reviewed_at | timestamptz nullable | |
| created_at | timestamptz | 不可变 |

> `chapter_facts.status` 由**最新版本**的状态决定；历史版本保留各自状态（`superseded` 表示被更新版本取代）。`knowledge_marks.fact_version` 必须指向**实际存在的 fact_versions 行**（外键约束）。

**fact_effects（事实的结构化影响，v1.2 新增）**：作者确认的是"事实 + 结构化影响"，不只是自然语言。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| fact_version_id | uuid FK→fact_versions | 由哪个事实版本产生 |
| effect_type | enum(entity_attr_change/resource_change/item_transfer/knowledge_change/timeline_add/plot_event) | 影响类型 |
| target_entity_id | uuid FK→entities | 目标实体（人物/物品/资源/势力…） |
| target_path | text | 目标字段路径（如 `realm_level`、`item.holder`、`resource.balance`） |
| old_value | jsonb nullable | 变更前值 |
| new_value | jsonb nullable | 变更后值 |
| delta | jsonb nullable | 增量（资源/物品类使用，如 `{"amount": -500}`） |
| created_at | timestamptz | |

**fact_effect_applications（影响应用记录，v1.3 新增）**：记录每个结构化影响是否已应用、对应流水、冲正流水与应用时间。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| fact_effect_id | uuid FK→fact_effects | 对应的结构化影响 |
| status | enum('applied','reversed','pending') | 已应用 / 已冲正 / 待应用 |
| applied_at | timestamptz nullable | 应用时间 |
| resource_ledger_id | uuid nullable | 若影响资源，指向 `resource_ledgers` 流水行 |
| item_event_id | uuid nullable | 若影响物品，指向 `item_events` 流水行 |
| reversal_ledger_id | uuid nullable | 冲正时写入的反向 `resource_ledgers` 行 |
| reversal_item_event_id | uuid nullable | 冲正时写入的反向 `item_events` 行 |
| reversed_at | timestamptz nullable | 冲正时间 |
| created_at | timestamptz | |

> 每个 fact_effect 至多一条 `applied` 记录；`resource_ledger_id` / `item_event_id` 唯一（一个流水行只能由一个 effect 应用产生）。

**作者确认流程（v1.2 明确）**：系统提取时同时产出 `fact_versions`（候选）+ 对应的 `fact_effects`（候选影响）。作者逐条确认时，看到的是**自然语言事实 + 结构化影响**（如"灵石 −500，当前余额 0"），确认后 `fact_effects` 生效并触发状态回写。作者可**修正影响**（改 old/new/delta）后再确认，确认的是最终结构化影响，而非仅有自然语言。

### 3.11 knowledge_marks（认知指向事实版本）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| work_id | uuid FK | |
| character_id | uuid FK→entities | 认知主体 |
| fact_id | uuid FK→chapter_facts | 指向事实 |
| fact_version | uuid FK→fact_versions | **指向实际存在的事实版本**（外键，非模糊 int） |
| known | boolean | 知道/不知道 |
| source | text | 认知来源（章节/设定/事件） |
| created_at | timestamptz | |

> v1.1 的 `fact_version int` 已修正为 `fact_version uuid FK→fact_versions`，保证指向真实存在的事实版本行。

### 3.12 chapter_review_runs / chapter_review_issues（A2-C-B 实现口径）

> 以迁移 `20261106090000_a2c_review_runs` 与 `packages/workflow/src/chapter/review.ts` 为准。
> 只记录**结构化审阅结论**：不存正文副本、prompt、模型原始响应或密钥。

**chapter_review_runs**：一次候选审阅运行。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| work_id / chapter_id / candidate_id | uuid | 归属三件套 |
| generation_task_id | uuid | 产生它的 `chapter.review` 任务 |
| agent_name / agent_version | text | `reviewer.chapter` / `1.0.0`，不可变 |
| provider / model | text | 本次实际调用的 Provider / 模型（成功后以 Provider 返回值为准） |
| status | text | `running / succeeded / failed` |
| passed | boolean nullable | 成功结论：true = 无问题；未终结时为 NULL |
| issue_count | int | 0..20；成功时与 passed 自洽 |
| error_code | text nullable | 失败时的稳定错误码 |
| created_at / started_at / finished_at | timestamptz | `started_at` 是本次尝试起点，重试时刷新 |

约束：

- `UNIQUE(candidate_id)`：每个候选最多一个 run；`UNIQUE(generation_task_id)`：一个 review 任务一个 run；
- `UNIQUE(id, candidate_id, chapter_id, work_id)`：让 issue 的 run 外键可以是复合外键；
- 复合外键：`(chapter_id, work_id) → chapters`、`(candidate_id, chapter_id, work_id) → chapter_candidates`、
  `(generation_task_id, chapter_id, work_id) → generation_tasks`；
- `CHECK` 结论自洽：`succeeded AND passed` ⇔ `issue_count = 0`；`succeeded AND NOT passed` ⇔ `1..20`；
  `running / failed` ⇒ `passed IS NULL AND issue_count = 0`；`running` 必须没有 `finished_at / error_code`；
- 只允许受控更新（`running → succeeded / failed`、`failed → running`），
  归属 / Agent 身份 / `created_at` 不可变，成功后不可改、不可删；
- 触发器 `generation_tasks_close_review_run`：review 任务进入 `cancelled / failed` 终态时，
  把仍在 `running` 的 run 标为 `failed`（`TASK_CANCELLED` 或任务错误码），不留下永久 running。

**chapter_review_issues**：一条结构化审阅问题（append-only）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| run_id / work_id / chapter_id / candidate_id | uuid | 复合外键绑定到 run，四者必须一致 |
| ordinal | int | 0..19，按 Reviewer 输出顺序 |
| severity | text | `high / medium / low` |
| type | text | 七类白名单（见 docs/08 §23.2） |
| evidence | text | 正文原句，1..300 |
| suggestion | text | 修改方向，1..500 |
| created_at | timestamptz | |

约束：`UNIQUE(run_id, ordinal)`；`CHECK` 兜底 severity / type / 长度；
只有 `running` 的 run 允许 INSERT；`UPDATE / DELETE` 一律由触发器拒绝。
run 进入 `succeeded / failed` 终态后不能再追加问题，避免 `issue_count` 与真实问题数失配。

> 归属组合（例如把 issue 挂在 run A 上却把 work / chapter / candidate 指向另一个合法组合）
> 由 `chapter_review_issues_run_fkey` 直接拒绝，不只靠服务层校验。

### 3.13 chapter_summaries（A2-D-B 实现口径）

> 以迁移 `20261106094000_a2d_chapter_summaries` 与
> `packages/workflow/src/chapter/summary.ts` 为准。摘要是**派生数据**：
> 不修改章节 / 版本 / 候选 / 采纳权，也不回写正文。

**chapter_summaries**：一个正式定稿版本的章节摘要。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| work_id / chapter_id / source_version_id | uuid | 归属三件套 |
| agent_name / agent_version | text | `summarizer.chapter` / `1.0.0` |
| provider / model | text | 本次实际调用的 Provider / 模型（以 Provider 返回值为准） |
| summary | text | 纯文本摘要，1..1000 字符，`btrim` 后非空 |
| created_at | timestamptz | 数据库时钟 |

约束：

- `UNIQUE(source_version_id)`：每个正式版本最多一条摘要（幂等 / 并发兜底）；
- 复合外键：`(chapter_id, work_id) → chapters(id, work_id)`、
  `(source_version_id, chapter_id, work_id) → chapter_versions(id, chapter_id, work_id)`；
  跨作品的版本组合由数据库直接拒绝；
- `CHECK (char_length(summary) BETWEEN 1 AND 1000 AND btrim(summary) <> '')`；
- **append-only**：UPDATE / DELETE 一律由触发器拒绝；修订摘要必须由新的正式版本
  重新生成（新 `source_version_id` → 新行）；
- 不保存正文、prompt、模型原始响应或密钥；不新增 `final_version_id`。

> 任务侧沿用 `generation_tasks`（`chapter.summarize`）+ `llm_call_logs`，
> 不另造运行状态机；摘要成功 / 失败都不写 `audit_logs`。

### 3.14 chapter_fact_decisions（A2-F-A 实现口径）

> 以迁移 `20261106110000_a2f_fact_decisions` 与
> `packages/workflow/src/chapter/fact-decision.ts` 为准。决策是**记录**：
> 接受只表示"可作为后续写回输入"，**不修改任何实体或物品事件**。

**chapter_fact_decisions**：作者对一条成功事实候选的终态决定。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| work_id / chapter_id / source_version_id | uuid | 归属三件套 |
| candidate_id | uuid | 被决定的候选 |
| decision | text | `accepted` / `rejected`（CHECK 白名单） |
| decided_by | uuid FK→users(id) | 只能来自会话的作者 |
| decided_at | timestamptz | 数据库时钟 |

约束：

- `UNIQUE(candidate_id)`：每个候选最多一条决定；
- 复合外键：`(chapter_id, work_id) → chapters(id, work_id)`、
  `(source_version_id, chapter_id, work_id) → chapter_versions(id, chapter_id, work_id)`、
  `(candidate_id, source_version_id, chapter_id, work_id) →
  chapter_fact_candidates(id, source_version_id, chapter_id, work_id)`。
  最后一条让"决定指向候选 A、却把版本 / 章节 / 作品写成另一个合法组合"直接被拒绝；
  为此给 `chapter_fact_candidates` 增加了身份唯一键
  `(id, source_version_id, chapter_id, work_id)`（id 已是主键，属冗余但必需的约束）；
- **append-only**：UPDATE / DELETE 一律由触发器拒绝；撤销 / 改判是独立产品能力，
  当前不提供；
- 表里没有正文、payload 副本、prompt、模型原始响应或密钥列。

> 服务层规则（不在数据库层表达）：只允许**成功 run** 的候选、只允许
> **当前定稿且该版本仍是最新正式版本**的候选；同决定重复提交幂等（不写审计），
> 不同决定 409 `CONTINUITY_FACT_ALREADY_DECIDED`；首次决定写一条审计
> `continuity.fact_decided`（detail 只有 ids 与 decision）。

### 3.15 novel_runs / novel_run_steps / novel_agent_calls（C1-A 实现口径）

C1-A 只跑单 Coordinator Agent 的问答与结束，不创建 Work、章节或正文；
三张表迁移为 `20261106120000_c1a_novel_coordinator`。

| 表 | 关键列 | 约束 |
| --- | --- | --- |
| `novel_runs` | `author_id`、`work_id`（C1-A 恒为 NULL）、`status`、`request_text`、`state_summary`、`state_version`、`current_goal`、`last_decision_summary`、`step_count`、`max_steps`、`locked_by`、`lease_until`、`heartbeat_at`、`cancel_requested_at`、`completed_at` | `status` 只允许 `queued/running/waiting_user/waiting_approval/completed/failed/cancelled`；`request_text` 1–2000、`max_steps` 1–100、`state_version >= 0`、`step_count <= max_steps`；`(status, locked_by, lease_until)` 与 `cancel/completed` 组合自洽；`(work_id, author_id)` 复合外键且作品必须属于同一作者 |
| `novel_run_steps` | `run_id`、`step_no`、`decision`、`tool_name`、`input_hash`（SHA-256 hex）、`output_summary`、`status`、`error_code` | `(run_id, step_no)` 唯一；`(id, run_id)` 唯一供 calls 复合外键；`status` 只允许 `succeeded/failed`，succeeded 的 `error_code` 必须为 NULL、failed 必须非 NULL；UPDATE / DELETE 一律拒绝 |
| `novel_agent_calls` | `run_id`、`step_id`（可为 NULL）、`call_kind`（`coordinator` / `tool`）、`agent_name`、`agent_version`、`provider`、`model`、token 数与延迟、`success`、`error_code` | 每次实际模型调用恰好一行；`step_id` 为空表示失败且未形成可提交步骤，或 C1-B-A1 的 Concept 工具调用尚未关联 step；`(step_id, run_id)` 复合外键保证 step 属于同一 run；UPDATE / DELETE 一律拒绝 |

**触发器与不可变边界**：

- `novel_runs_guard`：禁止 DELETE；禁止修改 `id`、`author_id`、`work_id`、
  `request_text`、`max_steps`、`created_at`；只允许白名单状态迁移，
  `queued → running/cancelled/waiting_approval`、
  `running → queued/waiting_user/waiting_approval/completed/failed/cancelled`、
  `waiting_user → queued/cancelled/waiting_approval`、
  `waiting_approval → queued/completed/failed/cancelled`；终态不可离开；
  `state_version` 与 `step_count` 只能单调递增；
- step / call 的 UPDATE/DELETE 由触发器直接拒绝，保证 append-only；
- 状态迁移由服务层事务 + 条件 UPDATE（`status='running' AND locked_by AND
  state_version`）共同把关，旧 Worker 的迟到提交整事务回滚。

**服务层规则（不在数据库层表达）**：

- 只允许 `ask_user` / `finish` 两个工具；`waiting_approval` 在 C1-A 不产生；
- `ask_user` 成功迁移到 `waiting_user`，`finish` 成功迁移到 `completed`；
- 回答按 `expectedVersion` 乐观并发：同版本同答案幂等，同版本不同答案 409
  `NOVEL_RUN_ANSWER_CONFLICT`，版本落后 409 `NOVEL_RUN_VERSION_CONFLICT`；
- 非 `waiting_user` 回答 409 `NOVEL_RUN_INVALID_STATE`；
- 预算：步数用尽直接失败且不写 step；token 用尽写一条 failed step 并记录
  `NOVEL_RUN_BUDGET_EXCEEDED`；
- 连续 3 次相同 action 签名触发 `COORDINATOR_LOOP_DETECTED`。

### 3.16 novel_artifacts / novel_artifact_revisions / novel_artifact_decisions（C1-B-A1 实现口径）

> 以迁移 `20261107090000_c1b_a1_novel_artifacts` 与
> `packages/workflow/src/novel/concept-service.ts` 为准。
> C1-B-A1 只建立「故事候选」数据域与内部服务：不接 Coordinator、不做 HTTP API / UI、
> 不创建 Work、不生成其它 Agent。`work_id` 本卡恒为 NULL。

**状态机**

```text
draft → pending_approval → approved（终态）
                         → rejected → （生成新 revision）→ draft
```

**novel_artifacts**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| run_id / author_id | uuid | 归属；author 必须等于 run 的 author |
| work_id | uuid NULL | C1-B-A1 固定 NULL（CHECK `work_id IS NULL`） |
| artifact_type | text | 本卡只允许 `concept` |
| status | text | `draft` / `pending_approval` / `approved` / `rejected` |
| current_revision | integer | `>= 1`，必须等于 revision 最大编号 |
| created_at / updated_at | timestamptz | |

约束与触发器：

- `UNIQUE(run_id, artifact_type)`：一个 run 同一类型最多一个 artifact；
- `(run_id, author_id) → novel_runs(id, author_id)` 复合外键：
  artifact 的 author 必须等于 run 的 author（`novel_runs` 为此新增
  `(id, author_id)` 唯一索引）；
- `(work_id, author_id) → works(id, author_id)` 复合外键保留给后续阶段；
- `novel_artifacts_insert_guard`：只能以 `draft` / `current_revision = 1` 创建；
- `novel_artifacts_guard`：禁止 DELETE；禁止修改 `id`、`run_id`、`author_id`、
  `work_id`、`artifact_type`、`created_at`；approved 为终态；
  只允许 `draft → pending_approval`、`pending_approval → approved|rejected`、
  `rejected → draft`；只有 draft / rejected 才能推进 `current_revision + 1`，
  且 rejected → draft 必须同时生成新 revision；
- 状态与 decision 自洽：`approved` / `rejected` 必须有当前 revision 的 decision，
  `draft` / `pending_approval` 不允许有；
- 延迟约束触发器 `novel_artifact_revision_consistency`：事务提交时校验
  `current_revision = MAX(revision_no)`，允许服务层在同一事务里先插 revision、
  再推进 current_revision。

**novel_artifact_revisions**（append-only）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| artifact_id / run_id / author_id | uuid | 归属三件套，冗余存列用于复合外键 |
| revision_no | integer | `>= 1`，`UNIQUE(artifact_id, revision_no)` |
| schema_version | text | 本卡只允许 `concept@1.0.0` |
| content | jsonb | 必须是 object，序列化长度 1–131072 |
| source_agent / source_agent_version | text | 1–120 字符 |
| source_step_id | uuid NULL | 若存在必须属于同一 run |
| created_at | timestamptz | |

约束与触发器：

- `(artifact_id, run_id, author_id) → novel_artifacts(id, run_id, author_id)`
  复合外键：revision 必须钉在同一 run / author 的 artifact 上；
- `(source_step_id, run_id) → novel_run_steps(id, run_id)` 复合外键；
- UPDATE / DELETE 一律拒绝（append-only）；
- INSERT 时拒绝已 approved 的 artifact，且 `revision_no <= current_revision + 1`。

**novel_artifact_decisions**（append-only）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| artifact_id / revision_no | uuid / integer | `UNIQUE(artifact_id, revision_no)` |
| author_id | uuid | 必须等于 artifact / run 的 author |
| decision | text | 只允许 `approved` / `rejected` |
| decided_at | timestamptz | 数据库时钟 |

约束与触发器：

- `(artifact_id, revision_no) → novel_artifact_revisions(artifact_id, revision_no)`
  复合外键：决定必须指向同一 artifact 的 revision；
- `(artifact_id, author_id) → novel_artifacts(id, author_id)` 复合外键：
  不允许他人替作者决定；
- 只能在该 revision 是 artifact 当前 revision 且 artifact 为 `pending_approval` 时插入；
- UPDATE / DELETE 一律拒绝；同一 revision 最多一条决定。

**服务层规则（不在数据库层表达）**

- Concept Agent 输出必须通过 `concept@1.0.0` Schema + 语义校验；
  trim 后非空、数组去重、数量限制、拒绝 HTML / Markdown / SQL / Prisma / 路径 /
  shell / 工具或正式写入指令，失败统一 `AGENT_OUTPUT_INVALID` 且不回显原文；
- 同内容（规范 JSON 哈希）不新增 revision，返回 `deduplicated`；
- 模型调用前后各校验一次 run `state_version` + artifact `current_revision`；
  旧 Worker 晚返回不覆盖新 artifact state；
- 每次实际 Concept Agent 调用写一条 `call_kind = 'tool'` 脱敏遥测
  （provider / model / usage / latency / success / error_code），失败调用也保留 usage；
- 稳定错误码：`NOVEL_ARTIFACT_NOT_FOUND`（404，跨作者统一）、
  `NOVEL_ARTIFACT_VERSION_CONFLICT`、`NOVEL_ARTIFACT_DECISION_STALE`、
  `NOVEL_ARTIFACT_ALREADY_DECIDED`、`NOVEL_ARTIFACT_ALREADY_APPROVED`。

---

## 4. 通用核心 vs 玄幻规则包（边界）

| 维度 | 通用小说核心（不随题材变） | 玄幻规则包（xuanhuan，可替换） |
| --- | --- | --- |
| 表结构 | users/works/volumes/chapters/chapter_candidates/chapter_versions/entities/entity_attributes/entity_relations/timeline/plot_threads/generation_tasks… | **默认无专属表**；确需时允许**独立扩展表**或**增量迁移**（不改已有核心表语义） |
| 字段 schema | 固定列 | `field_schema` JSON（含 work_settings 的 setting_key、character 的字段等） |
| 检查规则 | 检查框架 + 7 类类别 | 每类下的具体规则实现与参数 |
| 页面字段 | 通用表单渲染引擎 | 由 field_schema 驱动的表单 |
| 枚举值 | entity_type 基础集由核心定义 | 题材专属 entity_type（realm_level 等）与 relation_type 由规则包扩展 |

**硬校验（写入 code review checklist）**：
1. 通用核心表 DDL 中出现 `realm/cultivation/sect/spiritual_stone/sub_genre/golden_finger/tone_style` 等列 → 打回。
2. 新增题材需要修改**通用核心实体**（works/chapters/chapter_versions/chapter_candidates/entities 等）的 DDL → 打回（**新增扩展表、新增可空列除外**，属允许的增量迁移）。
3. 检查器实现硬编码在核心检查框架而非规则包注册 → 打回。

---

## 5. 一致性检查的可执行判定标准（v1.1 新增，回应审查第 5 条）

### 5.1 七类规则的判定标准

| 类别 | 可执行判定标准（伪规则） |
| --- | --- |
| 境界（realm） | 人物的境界事件序列 `realm_change` 按 story_order 排序后，若出现**降级**或**跨级跳跃**（跳过中间层级）且无 `突破事件` 支撑 → 报"境界跳跃/降级" |
| 战力（power） | 若两个人物在**同一冲突场景**中，A 的境界 `战力基准` 明显低于 B，但正文陈述 A 获胜且无外力/法宝/伤势等解释 → 报"战力倒挂"；判定阈值 = 规则包 `power_gap_threshold`（默认跨 1 大境界即告警） |
| 资源（resource） | 回放 `resource_ledgers`，若某时刻 `balance_after < 0` 或正文陈述的消耗与流水不符 → 报"资源透支/账目不符" |
| 物品（item） | 回放 `item_events`，若某物品同时被两人持有、或正文使用但流水无 `obtained` 前置事件 → 报"物品归属矛盾" |
| 认知（knowledge） | 若某人物在正文中"知道"了某 fact，但 `knowledge_marks` 中该人物对该 `fact_id` 的 `known=false` 且无更新 → 报"认知越界" |
| 时间线（timeline） | 若 `causal_links` 存在"果早于因"（`story_order(果) < story_order(因)`）→ 报"时序矛盾"；叙事顺序与故事时间不一致时分别标注 |
| 伏笔（foreshadow） | 若 `plot_threads.status = unresolved` 且 `planned_resolve_chapter_id` 对应的章节在当前进度之后仍未出现 `resolved`/带理由 `abandoned` 事件 → 报"伏笔未回收"；`reinforced` 不视为回收 |

### 5.2 判定依据

- 以上判定**优先使用结构化数据（事件流水、fact、knowledge_marks）比对**，可给出确定性证据。
- 战力、认知等语义型判定在结构化数据不足时，允许**LLM 辅助复核**，但 LLM 结论必须落到结构化记录（`review_reports`）而非仅返回自然语言。

### 5.3 问题证据统一格式（review_reports 的 issue 条目）

```json
{
  "issue_id": "uuid",
  "rule_key": "realm_jump",
  "category": "realm",
  "severity": "error|warning",
  "chapter_id": "uuid",
  "version_id": "uuid",
  "evidence_quote": "原文引用片段（精确到段落）",
  "evidence_locator": "段落序号/字符偏移",
  "related_entity_ids": ["uuid"],
  "suggestion": "建议修改位置与方向"
}
```

`review_reports`：`id, work_id, chapter_id, version_id, issues(jsonb[]), status, created_at`。

---

## 6. 数据隔离方案

- **根隔离**：`works.author_id`，所有子对象经 `work_id` 归属，服务端在每个 query 强制注入 `author_id = current_user` 或 `work_id ∈ (当前用户作品)`。
- **Row-Level Security（RLS）**：推荐启用 PostgreSQL RLS 作为第二道防线（策略：`author_id = current_user_id`）。是否启用见 `06` Q4。
- **管理员与正文隔离（v1.1）**：管理员默认仅可读任务/用量/错误等元数据；正文读取走**临时授权 + 审计**（见 `00` §7.1）。技术实现上，管理员正文接口独立且默认 `403`，需有效授权才放行。
- **无跨作品检索**：检索仅限单作品内。

### 6.1 账号上限的并发锁（v1.3 修正，回应审查第 4 条）

> v1.1 曾写 `SELECT count(*) FROM users FOR UPDATE`，此写法在空表/无行可锁时**不能可靠串行化**并发创建，已废弃。

**采用方案（二选一，实现阶段确定）**：
1. **`pg_advisory_xact_lock(key)`**：新建账号事务开始时获取一个固定 key 的事务级咨询锁（如 `pg_advisory_xact_lock(42)`），再 `count(*)` 校验 + 插入，事务结束自动释放。所有新建账号并发串行化。
2. **固定单行账号配额表**：`account_quota(id, count)` 只保留一行，事务内 `SELECT ... FOR UPDATE` 锁该行，读 count、校验、`count+1` 更新、插入账号，同一事务提交。

**流程（以方案 1 为例）**：
1. `BEGIN`；
2. `SELECT pg_advisory_xact_lock(<固定key>)`；
3. `SELECT count(*) FROM users WHERE ...`；
4. 校验 `count < 10`，否则 `ROLLBACK` 并返回 `ACCOUNT_LIMIT_REACHED`；
5. `INSERT INTO users ...`；
6. `COMMIT`（锁自动释放）。

确保两个管理员**并发创建**时串行执行，不会双双通过校验而突破 10 上限（对应 `04` AT-AUTH-1 真实 PostgreSQL 并发测试）。

---

## 7. 版本化方案

- 正文：`chapter_candidates`（候选）→ 采纳 → `chapter_versions`（正式版本，追加）。恢复 = 复制历史内容为新版本，历史永不删除。
- 设定：`entity_versions` 快照；章节生成时记录当时 `entity_versions` 的版本号。
- diff：正式版本间全文 diff（服务端计算，前端渲染高亮）。

## 8. 事实闭环与状态回写一致性（v1.2 修正顺序与失效规则）

### 8.1 提取时机（v1.2 修正，回应审查第 3 条）

- **最终正文版本确定后再提取事实**：事实提取（`fact_extract`）只在章节存在**正式版本**且作者点击"定稿/提取事实"后触发；生成草稿或候选阶段**不提取事实**。
- 提取基于**当前正式版本**（`source_version_id` 指向该版本），产出候选 `fact_versions` + 候选 `fact_effects`。

### 8.2 接受与回写（含应用记录）

1. 作者**接受/拒绝**每个候选事实版本（写 `reviewer_id`、`reviewed_at`）。作者可先**修正结构化影响**（fact_effects 的 old/new/delta）再确认。
2. 接受的事实触发**一致性回写**，以下内容在**同一数据库事务**提交：
   - `fact_versions` 状态 → accepted（`chapter_facts.status` 同步为最新版本状态）；
   - 按 `fact_effects` 写目标实体：人物状态 → `entity_attributes` 新快照 + `entity_versions`；资源 → 追加 `resource_ledgers`（含 seq_no）；物品 → 追加 `item_events`（含 seq_no）；认知 → 写/更新 `knowledge_marks`（指向 fact_version）；
   - **写 `fact_effect_applications`**：每个 effect 记一条 `applied` 记录，`resource_ledger_id` / `item_event_id` 指向刚写入的流水行，`applied_at` 记录时间。
3. **回写失败**：事务整体回滚，事实版本保持 candidate，无半写。
4. **重复回写**：以 `fact_version_id` 幂等，不重复追加流水。

### 8.2.1 事实并发应用（v1.3 新增，回应审查第 2 条）

- **行锁顺序（固定，防死锁）**：先锁 `entities`（目标实体行）→ 再锁资源/物品流水对应的目标行。人物状态与资源/物品分属不同实体，需按固定顺序加锁。
- **应用前校验 old_value**：写 `fact_effects` 前，读取目标实体当前值，与 `fact_effects.old_value` 比对：
  - 一致 → 应用；
  - 不一致 → 返回 `409 FACT_STATE_CONFLICT`，该 effect 不应用，整笔事务回滚（不写 application、不写流水）。
- **seq_no 安全分配**：资源/物品流水的 `seq_no` 在加锁事务内计算 `max(seq_no) + 1`（锁住目标实体行后串行化，避免并发抢同一 seq_no）。
- 两个事实同时修改同一资源 → 先到者应用，后到者 `old_value` 校验失败 → `409 FACT_STATE_CONFLICT`（对应 `04` AT-FACT-14）。

### 8.3 正式版本变更后的事实失效、重提、冲正与重应用（v1.3 补全）

- **正文修改导致事实失效**：当某章节的**正式版本被新版本取代**（人工编辑保存、局部重写应用、采纳新候选），系统**自动**将该章节旧版本派生的、已 accepted 的 `fact_versions` 标记为 `stale`，其 `chapter_facts.status` 同步为 `stale`。
- **已应用影响的冲正（v1.3 明确）**：事实 stale 时，逐条读取其 `fact_effect_applications` 中 `status='applied'` 的记录：
  - 资源类：追加一条**反向 `resource_ledgers`**（delta 取反，`reversal_of` 指向原流水，新 seq_no），并把 application 标记 `status='reversed'`、`reversal_ledger_id` 指向冲正流水、`reversed_at` 记时间；
  - 物品类：追加反向 `item_events`（`reversal_of` 指向原事件），application 标记 `reversed`；
  - 人物属性类：写 `entity_attributes` 新快照恢复到应用前值（`old_value`）+ `entity_versions`。
- **重提**：作者对章节再次"提取事实"，基于新正式版本产出**新的候选事实版本**（version_no 递增），旧版本保留为 `stale`。
- **重新确认后重应用**：新候选被接受 → 事实恢复有效（`accepted`），按其 `fact_effects` **重新应用**（新增 application 记录、新流水），而非复用已冲正的历史流水。
- **回滚**：若作者发现错误，可将某事实版本标记 `rejected` 或冲正其已回写流水（走 §3.6 冲正机制），不改历史。

### 8.4 下一章上下文使用规则（v1.3 修正默认策略）

- **生成下一章时，只使用 `accepted` 且未 `stale` 的事实**作为上下文；`candidate` / `rejected` / `stale` / `superseded` 的事实**不得进入后续章节上下文**。
- 上下文检索按 `fact_versions.status = 'accepted'` 过滤，并取每个 `fact_id` 的**最新有效版本**。
- **阻塞策略（v1.3 修正为推荐默认）**：**存在 `stale` 事实或待校正影响（有 `applied` 但未冲正的 application）时，禁止生成下一章**（返回 `FACT_PENDING_CORRECTION`），作者须先处理（重提确认或冲正）后才能继续。候选事实待确认仍默认不阻塞（策略可配），仅提示。

---

## 9. 待实现阶段落地项（非本轮产出）

- Prisma schema / SQL 迁移脚本（阶段二）。
- RLS 策略定义（若确认启用）。
- 规则包 xuanhuan 的 field_schema 与 rule_definitions JSON（阶段二）。
- 一致性检查器的可执行实现（按 §5 判定标准）。
