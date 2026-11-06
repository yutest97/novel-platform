# Trae 任务卡：N1-A 新建小说向导与蓝图落库

## 开始前

读取 `AGENTS.md`、`docs/09-project-memory.md`、`docs/07-master-roadmap.md`、
`docs/plans/N1-novel-creation-wizard.md`、本卡，并只按需读取当前作品创建 / 设定 / 章节代码。

基线：`07cb346`，工作区干净。执行方是 Trae，不交给 WorkBuddy。

## 目标

把“创建作品后直接进章节”改为：

```text
写新小说 → 分步问答 → 蓝图草稿 → 总览确认 → 创建正式作品和章节计划
```

本卡只实现 N1-A：

- 向导 UI；
- 蓝图草稿持久化；
- 手动填写；
- 确认落库；
- **不调用 LLM、不实现 AI 一键生成**。

## 向导步骤

1. 基础信息
2. 核心创意
3. 世界观
4. 人物
5. 全书主线
6. 分卷
7. 章节大纲
8. 总览确认

每步支持上一步 / 下一步、保存草稿、刷新恢复、字段校验。

基础选项至少覆盖：

- 题材：玄幻升级、都市、悬疑、科幻、历史、言情；
- 受众：男频、女频、通用；
- 视角：第一人称、第三人称限知、第三人称全知；
- 基调：轻松、克制、热血、黑暗、治愈；
- 节奏：慢热、中速、快节奏；
- 长度：短篇、中篇、长篇、连载。

## 数据模型

新增 `novel_blueprints`：

```text
id
author_id
title
status                draft | confirmed
current_step          1..8
schema_version
answers               jsonb
version               乐观并发版本
confirmed_work_id     nullable，确认后唯一引用 work
created_at / updated_at / confirmed_at
```

约束：

- 作者只能访问自己的蓝图；
- title trim 非空；
- answers 只接受服务端白名单结构，未知字段拒绝；
- confirmed 蓝图不可继续修改；
- 删除只允许 draft；
- confirmed_work_id 唯一，确认事务幂等；
- answers 每次更新必须带 `version`，冲突 409；
- 不在蓝图表保存登录 Cookie、Key、prompt 或模型原始响应。

## API

```text
POST   /api/novel-blueprints
GET    /api/novel-blueprints/:id
PATCH  /api/novel-blueprints/:id
DELETE /api/novel-blueprints/:id
POST   /api/novel-blueprints/:id/confirm
```

要求：

- 作者 id 只来自会话；
- 写接口校验 Origin；
- PATCH 严格白名单，带乐观版本；
- confirm 在作品级 advisory lock / 单事务内完成；
- 跨作者 / 随机 id 统一 404；
- 响应不泄露其它作者蓝图。

## 确认落库

确认时在同一事务创建：

- `works`；
- 规则包允许的世界观 `work_settings`；
- 人物 / 势力 / 境界 / 物品 `entities`；
- 分卷与章节计划；
- 初始 chapters：按已编辑章节大纲创建，状态 `planned`；
- 蓝图 status=confirmed、confirmed_work_id、confirmed_at。

现有数据模型若不足以表达分卷/章节大纲：

- 新增明确 migration；
- 不要把所有正式结构塞进一个无校验 JSON；
- 优先新增 `novel_outlines` 或等价受约束表；
- 不修改历史 migration。

确认失败必须整体回滚，不产生半个作品。

## UI

新增“写新小说”主入口和一个分步向导页：

- 桌面端左侧步骤导航，移动端顶部进度；
- 当前步骤可编辑；
- 显示草稿保存状态和最后更新时间；
- 总览页按章节分组展示全部内容；
- 缺失项 / 明显冲突集中提示；
- 确认按钮二次确认；
- 完成后跳转到新作品页；
- 纯文本输入，不使用 `dangerouslySetInnerHTML`；
- 不把草稿或 Key 写入 URL / Web Storage。

## 测试

至少覆盖：

1. 新建蓝图、刷新恢复、步骤修改；
2. 非作者 / 跨作者 404；
3. 未知字段、空书名、非法步骤拒绝；
4. `version` 冲突；
5. draft 删除，confirmed 不可删除/修改；
6. confirm 幂等；
7. confirm 事务失败整体回滚；
8. 正式作品、设定、实体、大纲和章节全部正确关联；
9. 确认后章节列表出现 `planned` 章节；
10. 确认前不产生正式作品；
11. E2E 完整走 8 步并创建作品；
12. 中途刷新恢复；
13. 移动端布局；
14. 现有作品 / 章节 / 设定流程不回归。

## 文档与验证

更新 `docs/03`、`docs/08`、`docs/09`、`docs/07`。

```bash
pnpm --filter @novel/db generate
pnpm db:deploy
pnpm --filter @novel/db test
pnpm --filter @novel/workflow build
pnpm --filter @novel/workflow typecheck
pnpm --filter @novel/workflow test
pnpm --filter @novel/web test
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm --filter @novel/web test:e2e
git diff --check
```

灵敏度：

1. 去掉作者归属条件 → 跨作者用例失败；
2. 确认事务中故意让实体写入后失败 → 正式作品仍为 0，恢复后整体成功。

## 不做

- LLM / Agent 调用；
- 一键生成世界观 / 人物 / 大纲；
- 大纲驱动正文改写；
- 多作者协作；
- 资源流水；
- 推送远端。

## 交付

本地提交，不推送。汇报提交号、数据模型 / API / UI、确认事务证据、测试与 E2E、
灵敏度结果、未做项和工作区状态，等待复审。
