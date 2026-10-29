# 03 数据模型（Data Model）

- 版本：v1.0（方案稿，待技术负责人审查）
- 状态：**未获批准。**

本文定义核心数据对象、字段、关系；重点说明**通用小说核心与玄幻规则包的边界**，以及数据隔离、版本化、任务持久化方案。

---

## 1. 设计原则

1. **题材解耦**：核心表不含任何题材专有列（境界、灵力、宗门、灵石等一律禁止出现在核心表列名中）。题材专有数据进入通用 `entity` / `entity_attribute`，字段元数据由规则包 JSON 定义。
2. **服务端隔离**：作品所有子对象都挂在 `work` 下，查询一律带 `work_id` 过滤；不依赖前端传参隐藏。
3. **不可变 + 版本化**：正文与关键设定采用"追加版本 + 不可变历史"模型，永不原地覆盖。
4. **事件溯源（关键资源）**：资源余额、物品持有人等以事件流水回放得出，不允许直接改当前值。
5. **任务持久化**：所有生成任务、上下文来源、Token 用量、错误记录落库，服务重启不丢。

---

## 2. 实体总览（ER 关系）

```
users (admin/author)
  └─ sessions
  └─ audit_logs

works (所属 author_id)
  ├─ volumes (卷)
  │    └─ chapters (章)
  │         ├─ chapter_outlines (细纲)
  │         ├─ chapter_beats (场景节拍)
  │         ├─ chapter_versions (正文版本，追加)
  │         └─ review_reports (一致性检查)
  ├─ story_arcs (情节弧：主线/支线)
  ├─ plot_threads (伏笔)
  ├─ timeline_events (时间线事件)
  │    └─ causal_links (因果边)
  ├─ entities (通用实体：人物/势力/地点/物品/功法/资源/境界层级…)
  │    ├─ entity_attributes (规则包驱动的字段值)
  │    ├─ entity_relations (关系，含"谁知道"认知)
  │    └─ entity_versions (实体版本快照)
  ├─ item_events (物品获得/消耗/丢失/转手流水)
  ├─ resource_ledgers (资源余额流水)
  ├─ chapter_facts (提取的事实)
  ├─ knowledge_marks (认知标记：人物知道/不知道什么)
  ├─ generation_tasks (生成任务)
  │    ├─ task_contexts (上下文来源)
  │    └─ llm_call_logs (Token 用量与错误)
  └─ rule_package_bindings (作品绑定的规则包)

rule_packages (题材规则包，系统级)
  └─ rule_definitions (检查规则/字段 schema)
```

---

## 3. 核心对象与字段

> 字段为方案级定义；实现阶段落地为 Prisma schema / SQL 迁移。类型约定：`uuid`、`text`、`int`、`timestamptz`、`jsonb`、`boolean`。

### 3.1 users

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| email | text UNIQUE | 登录标识 |
| password_hash | text | argon2id |
| role | enum('admin','author') | 仅两类 |
| status | enum('active','disabled','must_change_password') | 首登改密态 |
| must_change_password | boolean | 首登强改 |
| created_at / updated_at | timestamptz | |

### 3.2 works

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| author_id | uuid FK→users | **隔离根**：所有查询带 author_id 校验 |
| title | text | 作者内唯一 |
| genre_rule_package | text | 第一版恒 `xuanhuan` |
| sub_genre | text | 仙侠/修真/异世/洪荒 |
| summary | text | 简介 |
| target_chapters | int | |
| target_words_per_chapter | int | 2500—4000 |
| golden_finger | text | 金手指 |
| tone_style | text | 语气风格 |
| created_at / updated_at | timestamptz | |

### 3.3 volumes / chapters

| 对象 | 关键字段 |
| --- | --- |
| volumes | id, work_id, title, order_index, arc_id(可选) |
| chapters | id, work_id, volume_id, order_index, title, status(enum: planned/outlined/drafting/in_review/finalized/abandoned), target_words, summary(章节摘要) |
| chapter_outlines | chapter_id, content(jsonb: 目标/冲突/伏笔动作/结尾钩子), edited_flag, version |
| chapter_beats | chapter_id, beats(jsonb: 每节拍视角/在场人物/地点/动作/情绪/字数预算) |

### 3.4 chapter_versions（正文版本，核心：永不覆盖）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| chapter_id | uuid FK | |
| version_no | int | 章节内递增，`(chapter_id, version_no)` 唯一 |
| author | enum('ai','human') | 版本来源 |
| content | text | 全文 |
| char_count | int | 按 `00` §6.2 口径 |
| parent_version_id | uuid nullable | 版本链（重写/恢复的父版本） |
| source_task_id | uuid nullable | 来自哪个生成任务 |
| draft | boolean | true=草稿区，false=正式版本 |
| created_at | timestamptz | 不可变，不更新 |

### 3.5 entities + entity_attributes（题材解耦核心）

**entities**：`id, work_id, entity_type, name, created_at, updated_at, deleted_at(软删)`。
`entity_type` 枚举来自**规则包**（第一版 xuanhuan 提供：`character, faction, location, item, technique, resource_type, realm_level`）。

**entity_attributes**：`entity_id, attr_key, attr_value(jsonb/text), schema_ref`。
字段 schema（哪些 attr_key 合法、类型、可选值）由 `rule_packages` 中的 `field_schema` 定义，**不写死在核心表**。

> 例：`realm_level` 实体的 `突破条件`、`寿命`、`战力基准`；`character` 实体的 `秘密`、`初始境界`、`伤势` —— 这些"玄幻"字段都是 entity_attributes 的行，不是 works 表里的列。

**entity_relations**：`id, work_id, from_entity_id, to_entity_id, relation_type, note, knowledge_scope`。
- `relation_type` 来自规则包（如"师徒""敌对""持有""属于某势力"）。
- `knowledge_scope` 支持认知建模：`public` / `private_to(character_id)` —— 用于"谁知道秘密"。

**entity_versions**：设定条目每次修改存版本快照，供已生成章节引用回放（`entity_id, version_no, snapshot(jsonb), created_at`）。

### 3.6 item_events / resource_ledgers（事件溯源）

| 对象 | 字段 | 说明 |
| --- | --- | --- |
| item_events | item_entity_id, event_type(obtained/consumed/lost/transferred), from_holder, to_holder, chapter_id, note, created_at | 物品当前持有人 = 最后一条事件推导 |
| resource_ledgers | resource_type_id, delta, balance_after, chapter_id, reason, created_at | 余额 = 最新 balance_after；禁止直接改余额 |

### 3.7 叙事结构对象

| 对象 | 关键字段 | 说明 |
| --- | --- | --- |
| story_arcs | work_id, title, kind(main/sub), description | 情节弧 |
| plot_threads | work_id, description, planted_chapter, planned_resolve_chapter, status(unresolved/resolved/abandoned) | 伏笔 |
| timeline_events | work_id, time_label, event, involved_character_ids | 时间线 |
| causal_links | from_event_id, to_event_id, note | 事件因果边 |
| chapter_facts | chapter_id, fact_type, fact_text, source_quote, entity_ids | 提取事实，附原文证据 |
| knowledge_marks | work_id, character_id, fact_ref, known(boolean) | 人物知道/不知道某事实 |

### 3.8 generation_tasks / task_contexts / llm_call_logs（任务持久化）

| 对象 | 关键字段 | 说明 |
| --- | --- | --- |
| generation_tasks | id, work_id, chapter_id, task_type(volume_outline/stage_goal/chapter_outline/beats/draft/rewrite/review), status(pending/running/succeeded/failed/cancelled), input_hash(幂等键), request_payload(jsonb), error_code, error_message, progress, created_at/updated_at | **幂等键 = (chapter_id, task_type, input_hash)** |
| task_contexts | task_id, context_type(setting/history/fact/outline), ref_id, snippet, rank | 生成时用的上下文来源清单 |
| llm_call_logs | task_id, model, provider, prompt_tokens, completion_tokens, total_tokens, latency_ms, error, created_at | Token 用量与错误，供成本核算 |

### 3.9 rule_packages / rule_definitions（规则包，系统级）

| 对象 | 关键字段 | 说明 |
| --- | --- | --- |
| rule_packages | id, code(如 xuanhuan), name, version, field_schema(jsonb), active | 题材字段 schema + 检查规则元数据 |
| rule_definitions | package_id, category(realm/power/resource/item/knowledge/timeline/foreshadow), rule_key, rule_impl_ref, severity_default, active | 7 类检查规则定义 |

`rule_impl_ref` 指向检查器实现（代码内注册的检查器），规则包的 JSON 只描述"哪些检查启用、参数如何"，**题材逻辑进规则包 + 检查器插件，不进核心表**。

---

## 4. 通用核心 vs 玄幻规则包（边界）

| 维度 | 通用小说核心（不随题材变） | 玄幻规则包（xuanhuan，可替换） |
| --- | --- | --- |
| 表结构 | users/works/volumes/chapters/chapter_versions/entities/entity_attributes/entity_relations/timeline/plot_threads/generation_tasks… | **无专属表**，仅通过 entity_attributes + rule_definitions 表达 |
| 字段 schema | 固定列 | `field_schema` JSON（如 character 的"秘密/伤势/境界"字段定义） |
| 检查规则 | 检查框架 + 7 类类别 | 每类下的具体规则实现（如"境界只能升不能降，除非规则允许"） |
| 页面字段 | 通用表单渲染引擎 | 由 field_schema 驱动的表单 |
| 枚举值 | entity_type 的通用集合由核心定义基础集 | 题材专属 entity_type（realm_level 等）与 relation_type 由规则包扩展 |

**硬校验（写入 code review checklist）**：
1. 核心表 DDL 中出现 `realm/cultivation/sect/spiritual_stone` 等列 → 打回。
2. 新增题材需要 ALTER 核心表 → 打回。
3. 检查器实现硬编码在核心检查框架而非规则包注册 → 打回。

---

## 5. 数据隔离方案

- **根隔离**：`works.author_id`，所有子对象经 `work_id` 归属，服务端在每个 query 强制注入 `author_id = current_user` 或 `work_id ∈ (当前用户作品)`。
- **Row-Level Security（RLS）**：推荐启用 PostgreSQL RLS 作为第二道防线（策略：`author_id = current_user_id`），即使应用层漏写过滤，DB 兜底。实现阶段需确认是否引入（见 `06` 待定项）。
- **管理员运维视图**：单独只读 service + 独立审计，普通作者接口不含该能力。
- **无跨作品检索**：检索仅限单作品内，管理员也无全局搜索入口（`00` §6.1）。

## 6. 版本化方案

- 正文：`chapter_versions` 追加 + `parent_version_id` 版本链；恢复 = 复制历史内容为新版本，历史永不删除。
- 设定：`entity_versions` 快照；章节生成时记录当时 `entity_versions` 的版本号，支持"当时用了哪版设定"的可追溯。
- diff：版本间全文 diff（服务端计算，前端渲染高亮）。

## 7. 任务持久化与一致性方案

- **持久化**：`generation_tasks` 全量落库；Worker 崩溃后按 status 恢复（`running` 超时转 `failed` 或可重试）。
- **幂等**：`(chapter_id, task_type, input_hash)` 唯一约束；重复点击返回同一 task，不产生多份正式记录。
- **原子性（正文 + 状态一致性）**：正文版本写入与章节 `status` 更新在同一 DB 事务；`llm_call_logs` 与任务状态在另一事务，但"正式版本"与"状态"必须同事务，杜绝半写。
- **生成失败不覆盖**：生成结果先落 `draft=true` 草稿，作者"采纳"才转正式版本；失败直接不产生正式版本。

## 8. 待实现阶段落地项（非本轮产出）

- Prisma schema / SQL 迁移脚本（阶段二）。
- RLS 策略定义（若确认启用）。
- 规则包 xuanhuan 的 field_schema 与 rule_definitions JSON（阶段二）。
