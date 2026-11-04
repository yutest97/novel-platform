-- A1-1：工作流内核（chapters / generation_tasks / task_contexts / llm_call_logs）。
--
-- 设计要点（改动前请先读）：
--
-- 1. 本迁移只**新增**四张表，不修改任何既有表：M2-B4 资源流水暂停，
--    既有功能（作品、设定、物品事件）保持原样。
--
-- 2. `generation_tasks.status` 是**受控状态机**：
--      queued      → processing | cancelled
--      processing  → succeeded | failed | cancelled | queued（重试）
--      succeeded / failed / cancelled 为终态，**不可再改**
--    数据库触发器 `generation_tasks_status_transition` 兜底；
--    应用层的 update 也必须带 `locked_by` 与 `status='processing'`（fencing）。
--
-- 3. 租约：processing 必须同时有 locked_by 与 lease_until（CHECK 约束）。
--    Worker 崩溃后租约过期，由 sweep 重新排队或判定失败；
--    因此不会留下"永久 processing"的行。
--
-- 4. `(work_id, request_id)` 唯一：同一逻辑请求只创建一个任务。
--    任务创建是幂等的（冲突时返回既有行）。
--
-- 5. `task_contexts` 只存"引用 + 摘要"，snippet ≤ 500；
--    `llm_call_logs` 只存 token / 延迟 / 成功标志 / 稳定 error_code，
--    **不存 prompt、不存模型响应、不存 API Key**。
--
-- 6. 外键一律 ON DELETE RESTRICT（works / chapters）：项目没有硬删除入口，
--    RESTRICT 保证任务与章节不会因父行消失而变成孤儿；
--    task_contexts / llm_call_logs 随任务级联删除（仅测试清理会用到）。

-- ---------------------------------------------------------------------------
-- chapters：最小章节骨架
-- ---------------------------------------------------------------------------
CREATE TABLE "chapters" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "chapter_no" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chapters_work_id_chapter_no_key"
    ON "chapters"("work_id", "chapter_no");

CREATE INDEX "chapters_work_id_chapter_no_idx"
    ON "chapters"("work_id", "chapter_no");

-- 章号从 1 开始
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_chapter_no_check"
    CHECK ("chapter_no" >= 1);

-- 标题长度；正文不在这张表里
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_title_length_check"
    CHECK (char_length("title") BETWEEN 1 AND 200);

-- 六态章节状态（与 docs/03 §3.7 一致）
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_status_check"
    CHECK ("status" IN ('planned', 'outlined', 'drafting', 'in_review', 'finalized', 'abandoned'));

ALTER TABLE "chapters" ADD CONSTRAINT "chapters_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- generation_tasks：任务队列 + 租约
-- ---------------------------------------------------------------------------
CREATE TABLE "generation_tasks" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    -- 章节可为空：A1-1 允许非章节型任务（例如测试工作流），A1-2 起正文任务必填
    "chapter_id" UUID,
    "request_id" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "current_step" TEXT,
    "input_snapshot" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "locked_by" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "heartbeat_at" TIMESTAMPTZ(3),
    "cancel_requested_at" TIMESTAMPTZ(3),
    "error_code" TEXT,
    "error_message_sanitized" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "generation_tasks_pkey" PRIMARY KEY ("id")
);

-- 同一逻辑请求只创建一个任务（幂等入口）
CREATE UNIQUE INDEX "generation_tasks_work_id_request_id_key"
    ON "generation_tasks"("work_id", "request_id");

-- 队列扫描 / 作品维度查询
CREATE INDEX "generation_tasks_work_id_status_created_at_idx"
    ON "generation_tasks"("work_id", "status", "created_at");

-- 领取候选（status='queued' 按创建时间）
CREATE INDEX "generation_tasks_status_created_at_idx"
    ON "generation_tasks"("status", "created_at");

-- 过期租约扫描
CREATE INDEX "generation_tasks_status_lease_until_idx"
    ON "generation_tasks"("status", "lease_until");

-- 状态白名单
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_status_check"
    CHECK ("status" IN ('queued', 'processing', 'succeeded', 'failed', 'cancelled'));

-- 重试次数
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_attempt_check"
    CHECK ("attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 10 AND "attempt_count" <= "max_attempts");

-- 租约一致性：processing 必须有锁与租约；其它状态必须没有锁与租约
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_lease_check"
    CHECK (
        ("status" = 'processing' AND "locked_by" IS NOT NULL AND "lease_until" IS NOT NULL)
        OR ("status" <> 'processing' AND "locked_by" IS NULL AND "lease_until" IS NULL)
    );

-- 标识符长度（接口层同样校验，这里是兜底）
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_request_id_length_check"
    CHECK (char_length("request_id") BETWEEN 1 AND 128);

ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_task_type_length_check"
    CHECK (char_length("task_type") BETWEEN 1 AND 64);

ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_provider_length_check"
    CHECK (char_length("provider") BETWEEN 1 AND 64);

ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_model_length_check"
    CHECK (char_length("model") BETWEEN 1 AND 128);

ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_current_step_length_check"
    CHECK ("current_step" IS NULL OR char_length("current_step") <= 64);

-- 只存映射后的安全文案，长度封顶
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_error_message_check"
    CHECK ("error_message_sanitized" IS NULL OR char_length("error_message_sanitized") <= 500);

ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_error_code_length_check"
    CHECK ("error_code" IS NULL OR char_length("error_code") <= 64);

ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_chapter_id_fkey"
    FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 状态迁移守卫（含"终态不可变"）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "generation_tasks_status_transition"() RETURNS trigger AS $$
BEGIN
  -- 终态行不允许任何更新：保证 succeeded / failed / cancelled 是稳定结果
  IF OLD."status" IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'generation_tasks 终态不可修改（当前 %）', OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'queued' AND NEW."status" IN ('processing', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'processing' AND NEW."status" IN ('succeeded', 'failed', 'cancelled', 'queued') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'generation_tasks 非法状态迁移：% -> %', OLD."status", NEW."status"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "generation_tasks_status_transition_trigger"
  BEFORE UPDATE ON "generation_tasks"
  FOR EACH ROW EXECUTE FUNCTION "generation_tasks_status_transition"();

-- ---------------------------------------------------------------------------
-- task_contexts：上下文引用（只存摘要）
-- ---------------------------------------------------------------------------
CREATE TABLE "task_contexts" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "context_type" TEXT NOT NULL,
    "ref_id" UUID,
    "snippet" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "task_contexts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_contexts_task_id_context_type_ref_id_key"
    ON "task_contexts"("task_id", "context_type", "ref_id");

CREATE INDEX "task_contexts_task_id_rank_idx"
    ON "task_contexts"("task_id", "rank");

ALTER TABLE "task_contexts" ADD CONSTRAINT "task_contexts_context_type_length_check"
    CHECK (char_length("context_type") BETWEEN 1 AND 64);

-- 摘要片段，不是正文
ALTER TABLE "task_contexts" ADD CONSTRAINT "task_contexts_snippet_length_check"
    CHECK ("snippet" IS NULL OR char_length("snippet") <= 500);

ALTER TABLE "task_contexts" ADD CONSTRAINT "task_contexts_rank_check"
    CHECK ("rank" >= 0);

ALTER TABLE "task_contexts" ADD CONSTRAINT "task_contexts_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "generation_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- llm_call_logs：只记计量与结果，不记 prompt / 正文 / 原始错误
-- ---------------------------------------------------------------------------
CREATE TABLE "llm_call_logs" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "llm_call_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "llm_call_logs_task_id_created_at_idx"
    ON "llm_call_logs"("task_id", "created_at");

CREATE INDEX "llm_call_logs_created_at_idx"
    ON "llm_call_logs"("created_at");

ALTER TABLE "llm_call_logs" ADD CONSTRAINT "llm_call_logs_stage_length_check"
    CHECK (char_length("stage") BETWEEN 1 AND 64);

ALTER TABLE "llm_call_logs" ADD CONSTRAINT "llm_call_logs_provider_length_check"
    CHECK (char_length("provider") BETWEEN 1 AND 64);

ALTER TABLE "llm_call_logs" ADD CONSTRAINT "llm_call_logs_model_length_check"
    CHECK (char_length("model") BETWEEN 1 AND 128);

ALTER TABLE "llm_call_logs" ADD CONSTRAINT "llm_call_logs_tokens_check"
    CHECK ("prompt_tokens" >= 0 AND "completion_tokens" >= 0 AND "latency_ms" >= 0);

ALTER TABLE "llm_call_logs" ADD CONSTRAINT "llm_call_logs_error_code_length_check"
    CHECK ("error_code" IS NULL OR char_length("error_code") <= 64);

ALTER TABLE "llm_call_logs" ADD CONSTRAINT "llm_call_logs_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "generation_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
