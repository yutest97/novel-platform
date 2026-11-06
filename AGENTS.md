# Repository Working Agreement

本文件适用于整个仓库。目标是让新的 Agent 在不依赖超长聊天历史的情况下，
快速恢复到正确的项目状态，并避免把历史方案、旧验收文本或猜测当成当前事实。

## 1. 必读顺序

开始任何实现、复审或修复前，按以下顺序读取：

1. `docs/09-project-memory.md`：当前基线、已完成能力、下一步、冻结决策和风险；
2. `docs/07-master-roadmap.md`：未来阶段与阶段边界；
3. 当前任务涉及的详细文档：
   - 数据模型：`docs/03-data-model.md`
   - 验收用例：`docs/04-acceptance-tests.md`
   - 工作流与 Agent：`docs/08-workflow-and-agents.md`
   - 产品范围：`docs/00-product-brief.md`、`docs/01-mvp-scope.md`
   - 环境与许可证：`README.md`、`docs/05-architecture-and-licenses.md`

不要默认完整读取 81KB 的 `docs/08` 或 92KB 的 `docs/04`。先按任务用 `rg`
定位章节，只加载相关部分。

## 2. 事实优先级

发生冲突时，按以下优先级判断：

1. 当前代码、数据库迁移、测试结果、`git status`、`git log`；
2. GitHub Actions 最近一次实际结果；
3. `docs/09-project-memory.md`；
4. `docs/07-master-roadmap.md`；
5. 详细设计与历史验收文档；
6. 聊天记录中的历史描述。

如果代码与文档冲突，停止基于旧文档继续实现，先报告冲突。不要猜当前 HEAD、
测试数量、迁移数量或产品阶段。

## 3. 核心架构不可擅自改变

- 现有固定工作流仍由代码控制步骤顺序、状态迁移、租约、重试、取消、幂等、门禁和落库；
- C1 小说创作使用**单 Coordinator Agent** 作为唯一语义调度中心：Coordinator 输出
  结构化下一步 action，Runtime 校验工具白名单、预算、状态迁移和作者确认后执行；
- Agent 是语义节点：只把结构化输入变成严格 Schema 的结构化输出；
- 除 Coordinator 外，Agent 不决定下一步；
- Agent 不直接访问数据库、不自动采纳、不自动写回实体；
- Coordinator 不直接访问数据库，也不绕过 Runtime 或作者确认；
- 作者是最终签发者：正文候选、事实候选、检查建议都必须由作者确认；
- PostgreSQL 是任务状态和正文版本的权威来源，不使用文件式 `status.md`；
- 正式正文版本 append-only；
- 事实提取只处理定稿章节的当前最新正式版本；
- 同一写业务默认使用作品级 advisory lock 和数据库约束兜底。

## 4. 当前产品方向

- 个人可用版优先：单作者、单实例；
- 多人、运营、配额后置，但保留既有账号与权限能力；
- 不引入 Redis、独立队列服务、向量库或 Neo4j，除非路线图和用户明确批准；
- RAG 不是当前前置；
- M2-B4 资源余额流水保持暂停，不删除既有设计或代码。

## 5. Agent 路线

- A1：Planner Agent、Writer Agent；
- A2：Reviewer Agent、Summarizer Agent；
- FactExtractor 已在 A2-A/A2-B 提前完成后端能力，只产出候选；
- A3：Consistency Agent、检索与图谱（按实际需要）；
- C1：单 Coordinator Agent 调度小说创作，专用 Agent 作为其受控工具；
- Reviewer 默认应以结构化问题提示为主，不应直接替代作者做最终采纳决定；
- Summarizer 只处理正式定稿版本，输出必须幂等、可追溯；
- 不允许专用 Agent 间自由对话、自选下一步或无限自动重写；
- Coordinator 的动态调度必须有动作白名单、步骤/token 预算、重复动作熔断和作者确认门禁。

## 6. 实现要求

- 先读取现有实现模式，再写代码；
- 优先复用现有服务、事务、错误码、Schema 校验和测试夹具；
- 所有新边界都要有稳定错误码、权限测试和失败回滚证据；
- 不降低既有测试数量，不使用 `skip` / `fixme` 掩盖失败；
- 测试应覆盖并发、旧请求隔离、崩溃恢复和跨作品隔离；
- 页面输入按纯文本渲染，不使用 `dangerouslySetInnerHTML`；
- 草稿、正文、prompt、Cookie、API Key 不写入 URL、localStorage、日志或审计；
- 新 migration 必须能在全新空库运行；
- 修改未推送的阶段 migration 时，必须在同一份 migration 内修正并重新验证空库；
- 不修改已经验收并推送的历史 migration。

## 7. 完成与推送规则

默认完成流程：

1. 确认基线和干净工作区；
2. 实现并补测试；
3. 做至少一项灵敏度验证；
4. 跑相关测试、全量单测、必要的完整 E2E、format、lint、typecheck、build；
5. 检查空库迁移和 `git diff --check` / `git show --check`；
6. 本地提交；
7. 汇报提交号、验证结果、未做项和工作区状态；
8. 等待用户复审。

未得到用户明确要求或复审通过，不推送远端。

## 8. 文档维护

每个阶段完成后必须更新 `docs/09-project-memory.md`：

- 已验收基线；
- 本次完成内容；
- 当前下一步；
- 新冻结决策；
- 测试、迁移、表、触发器数量；
- 新风险和待决问题。

阶段路线变化更新 `docs/07-master-roadmap.md`。详细契约变化再更新
`docs/03` / `docs/04` / `docs/08`。不要把所有历史细节复制进项目记忆文档。

## 9. 常用验证命令

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
git show --check
```

数据库测试和 E2E 使用项目现有环境变量与测试夹具。若本机 PostgreSQL 被回收，
先恢复数据库并确认 `prisma migrate status`，不要把环境失败误判为代码失败。
