# 03 数据模型（Data Model）

- 版本：v1.1（方案稿，退回修订中，待技术负责人复审）
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
  └─ audit_logs

works (所属 author_id)  [不含题材专有列]
  ├─ work_settings (规则包驱动的题材参数)
  ├─ volumes (卷)
  │    └─ chapters (章)
  │         ├─ chapter_outlines (细纲)
  │         ├─ chapter_beats (场景节拍)
  │         ├─ chapter_candidates (候选/草稿区)  ★v1.1
  │         ├─ chapter_versions (仅正式版本)     ★v1.1
  │         ├─ review_reports (一致性检查)
  │         └─ chapter_facts (候选/已接受事实)   ★v1.1
  ├─ story_arcs (情节弧：主线/支线)
  ├─ plot_threads (伏笔主表)                     ★v1.1 引用稳定 chapter_id
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

**账号上限口径**：`count(*)`（含 disabled）≤ 10；新建时用事务锁（`SELECT ... FOR UPDATE` 或 advisory lock）保证并发不突破（见 §5.2）。

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
| source_candidate_id | uuid nullable | 若由候选采纳而来 |
| created_at | timestamptz | 不可变，不更新 |

**采纳候选的事务流程（明确分配版本号）**：
1. 开启事务。
2. `SELECT ... FOR UPDATE` 锁定该 chapter 行（防并发采纳）。
3. 计算 `next_version_no = max(version_no) + 1`。
4. 插入 `chapter_versions`（version_no = next_version_no，content 取自候选）。
5. 更新候选 `status='adopted', adopted_version_id=<新版本 id>`。
6. 提交事务。
- 重复采纳同一候选：候选已 `adopted`，直接返回已有 `adopted_version_id`（幂等），不再插入新版本。
- 采纳 `discarded` 候选：返回 `409`。

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
- `id, work_id, description, status(unresolved/resolved/abandoned)`。
- **不存 `planted_chapter` 章号**（章号会因插入调整而变化）。

**plot_thread_events（伏笔事件，v1.1 新增）**：
- `id, plot_thread_id, chapter_id(稳定 UUID), event_type(planted/reinforced/resolved/abandoned), note, created_at`。
- 通过多条事件支持**多次埋设、强化、回收**；回收状态由事件回放得出。

**timeline_events（v1.1 区分两种时间）**：
- `id, work_id, event, involved_character_ids, chapter_id(叙事位置), story_time(故事世界时间，如"第一卷·第3日"或绝对纪年), story_order(故事世界顺序号)`。
- **叙事顺序** = `chapter_id`（出现在哪一章）；**故事世界时间** = `story_time` / `story_order`（故事内何时发生）。两者可不同（倒叙、插叙）。

**causal_links**：`from_event_id, to_event_id, note`（因果边，用于检测"果早于因"）。

### 3.8 generation_tasks（v1.1 强化幂等与队列）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| request_id | uuid **NOT NULL UNIQUE** | 客户端生成，**始终非空**；同一次逻辑操作复用 |
| idempotency_key | text **NOT NULL UNIQUE** | 服务端计算，作用域相关（见下） |
| scope | enum('work','chapter','rewrite') | 作品级/章节级/重写级任务 |
| work_id | uuid FK | |
| chapter_id | uuid nullable | 作品级任务为 null |
| task_type | enum(volume_outline/stage_goal/chapter_outline/beats/draft/rewrite/review/fact_extract) | |
| status | enum(pending/running/succeeded/failed/cancelled) | |
| input_hash | text | 入参指纹，用于区分"再次生成" |
| locked_by | text nullable | 当前持有该任务的 Worker 实例 ID |
| lease_until | timestamptz nullable | 租约到期时间 |
| heartbeat_at | timestamptz nullable | 最后心跳 |
| attempt_count | int default 0 | 重试次数 |
| cancel_requested_at | timestamptz nullable | 用户请求取消时间 |
| request_payload | jsonb | 原始入参 |
| error_code / error_message | text | |
| progress | jsonb | 阶段步进 |
| created_at / updated_at | timestamptz | |

**幂等键设计（v1.1）**：
- `request_id`：客户端为每次"逻辑操作"生成 UUID，**重复点击复用同一 request_id** → 命中唯一约束，返回已有任务，不产生新记录。
- `idempotency_key`：由服务端计算，`scope + task_type + scope_target + input_hash` 哈希。**作用域**：
  - `work` 级（卷纲、阶段目标）：`scope_target = work_id`。
  - `chapter` 级（细纲、节拍、正文草稿、检查）：`scope_target = chapter_id`。
  - `rewrite` 级（局部重写）：`scope_target = chapter_id + 选中范围指纹`。
- **区分"重复点击"与"用户再次生成"**：重复点击 = 同 request_id，幂等返回；用户明确再次生成 = 新 request_id + 新 input_hash，产生新任务（若 input_hash 未变但用户点"重新生成"，前端生成新 request_id 即可）。

**队列与租约（v1.1）**：
- Worker 用 `SELECT ... FOR UPDATE SKIP LOCKED` 抢 `pending` 任务，抢到后写 `locked_by + lease_until + heartbeat_at`。
- Worker 定期心跳；`lease_until` 过期且无心跳 → 视为崩溃，任务可被重新抢占，`attempt_count + 1`。
- 超过最大 attempt（默认 3）→ 标 `failed`。
- `cancel_requested_at` 非空 → Worker 在处理前检查并停止后续动作。

**task_contexts**：`task_id, context_type(setting/history/fact/outline), ref_id, snippet, rank`。

**llm_call_logs**：`task_id, model, provider, prompt_tokens, completion_tokens, total_tokens, latency_ms, error, created_at`。

### 3.9 rule_packages / rule_definitions（规则包，系统级）

| 对象 | 关键字段 | 说明 |
| --- | --- | --- |
| rule_packages | id, code(如 xuanhuan), name, version, field_schema(jsonb), active | 题材字段 schema + 检查规则元数据 |
| rule_definitions | package_id, category(realm/power/resource/item/knowledge/timeline/foreshadow), rule_key, rule_impl_ref, severity_default, active, params(jsonb) | 7 类检查规则定义 |

`rule_impl_ref` 指向检查器实现（代码内注册），规则包 JSON 描述"哪些检查启用、参数如何"。**题材逻辑进规则包 + 检查器插件，不进核心表**。

### 3.10 chapter_facts（v1.1 事实闭环）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| work_id | uuid FK | |
| chapter_id | uuid FK | 来源章节 |
| source_version_id | uuid FK→chapter_versions | **来源版本**（哪个正式版本提取的） |
| fact_type | enum(realm_change/resource_change/item_transfer/character_state/knowledge_change/plot_event) | |
| fact_text | text | 事实描述 |
| source_quote | text | 原文证据 |
| entity_ids | jsonb | 涉及实体 |
| status | enum('candidate','accepted','rejected') | 候选/已接受/已拒绝 |
| reviewer_id | uuid nullable | **审核人**（作者本人） |
| reviewed_at | timestamptz nullable | |
| created_at | timestamptz | |

### 3.11 knowledge_marks（v1.1 认知指向 fact 版本）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| work_id | uuid FK | |
| character_id | uuid FK→entities | 认知主体 |
| fact_id | uuid FK→chapter_facts | **明确指向 fact_id**（非模糊引用） |
| fact_version | int | **指向该事实的版本**（事实可修订） |
| known | boolean | 知道/不知道 |
| source | text | 认知来源（章节/设定/事件） |
| created_at | timestamptz | |

> v1.0 的 `fact_ref` 模糊引用已修正为 `fact_id + fact_version` 的明确指向。

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
| 伏笔（foreshadow） | 若 `plot_thread_events` 中伏笔被 `planted` 但到当前进度仍无 `resolved/reinforced`，且 `planned_resolve` 章节已过 → 报"伏笔未回收" |

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

### 6.1 账号上限的事务锁（v1.1 新增）

新建账号时，在同一事务内：
1. `SELECT count(*) FROM users FOR UPDATE`（或对账号计数表加 advisory lock）；
2. 校验 `count < 10`；
3. 插入新账号。
确保两个管理员**并发创建**时不会双双通过校验而突破 10 上限。

---

## 7. 版本化方案

- 正文：`chapter_candidates`（候选）→ 采纳 → `chapter_versions`（正式版本，追加）。恢复 = 复制历史内容为新版本，历史永不删除。
- 设定：`entity_versions` 快照；章节生成时记录当时 `entity_versions` 的版本号。
- diff：正式版本间全文 diff（服务端计算，前端渲染高亮）。

## 8. 事实闭环与状态回写一致性（v1.1 新增）

1. 章节定稿（有正式版本）→ 触发 `fact_extract` 任务 → 产出**候选事实**（status=candidate，附 source_version_id 与原文证据）。
2. 作者**接受/拒绝**（写 reviewer_id、reviewed_at）。
3. 接受的事实触发**一致性回写**，以下内容在**同一数据库事务**提交：
   - `chapter_facts` 状态 → accepted；
   - 人物状态变更 → 写 `entity_attributes` 新快照 + `entity_versions`；
   - 资源状态变更 → 追加 `resource_ledgers`（含 seq_no）；
   - 物品状态变更 → 追加 `item_events`（含 seq_no）。
4. **回写失败**：事务整体回滚，事实保持 candidate 或回退，无半写。
5. **重复回写**：以 `(fact_id, fact_version)` 幂等，不重复追加流水。
6. **待确认事实是否阻塞下一章**：默认**不阻塞**（策略可配），生成前提示"有 N 条事实待确认"。

---

## 9. 待实现阶段落地项（非本轮产出）

- Prisma schema / SQL 迁移脚本（阶段二）。
- RLS 策略定义（若确认启用）。
- 规则包 xuanhuan 的 field_schema 与 rule_definitions JSON（阶段二）。
- 一致性检查器的可执行实现（按 §5 判定标准）。
