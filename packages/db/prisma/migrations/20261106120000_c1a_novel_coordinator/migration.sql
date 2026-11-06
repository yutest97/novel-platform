-- C1-A：Coordinator Agent 运行、已提交步骤与实际模型调用。
--
-- 设计要点（改动前请先读）：
--
-- 1. **三张表只持久化调度事实**：
--    - novel_runs：一轮作者问答的状态、预算、乐观版本、租约与调度摘要；
--    - novel_run_steps：Coordinator 已提交的结构化 action（append-only）；
--    - novel_agent_calls：每次实际模型调用一行（append-only）。
--    三张表都不保存 prompt、模型原始响应、密钥、大纲 / 人物 / 正文全文。
--
-- 2. **run 状态机由数据库兜底**：
--    - 合法迁移：queued → running/cancelled；running → queued/waiting_user/
--      waiting_approval/completed/failed/cancelled；waiting_user → queued/cancelled；
--      waiting_approval → queued/completed/failed/cancelled；
--    - 终态不可再改、不可删除；
--    - C1-A Runtime 不会产生 waiting_approval，但状态值保留给后续阶段。
--
-- 3. **租约与完成时间自洽**：
--    - running 必须有 locked_by + lease_until；非 running 必须清空两者；
--    - 终态必须 completed_at 非空；非终态必须为空。
--
-- 4. **结构约束**：
--    - steps 的 (run_id, step_no) 唯一；succeeded 不允许 error_code，failed 必须有时；
--    - calls 的 call_kind 在 C1-A 只允许 coordinator；
--    - succeeds=false 必须带稳定 error_code；succeeded=true 必须为空；
--    - step / call 均通过复合外键钉死归属（call 的 step 必须属于同一 run）。
--
-- 5. **append-only**：
--    - novel_run_steps / novel_agent_calls 的 UPDATE / DELETE 由触发器拒绝；
--    - novel_runs 的归属、请求文本、max_steps、created_at 不可变。
--
-- 6. 测试清理沿用受控 `ALTER TABLE ... DISABLE TRIGGER USER` 策略。

-- ---------------------------------------------------------------------------
-- 供 novel_runs 的复合外键引用：work 必须属于同一 author
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "works_id_author_id_key" ON "works"("id", "author_id");

-- ---------------------------------------------------------------------------
-- novel_runs：一轮作者问答
-- ---------------------------------------------------------------------------
CREATE TABLE "novel_runs" (
    "id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    -- C1-A 固定为 NULL；后续阶段才允许关联作品
    "work_id" UUID,
    -- queued | running | waiting_user | waiting_approval | completed | failed | cancelled
    "status" TEXT NOT NULL DEFAULT 'queued',
    "request_text" TEXT NOT NULL,
    "state_summary" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "state_version" INTEGER NOT NULL DEFAULT 0,
    "current_goal" TEXT NOT NULL DEFAULT '',
    "last_decision_summary" TEXT NOT NULL DEFAULT '',
    "step_count" INTEGER NOT NULL DEFAULT 0,
    "max_steps" INTEGER NOT NULL DEFAULT 20,
    "locked_by" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "heartbeat_at" TIMESTAMPTZ(3),
    "cancel_requested_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "novel_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "novel_runs_author_id_updated_at_idx"
    ON "novel_runs"("author_id", "updated_at");

CREATE INDEX "novel_runs_status_created_at_idx"
    ON "novel_runs"("status", "created_at");

CREATE INDEX "novel_runs_status_lease_until_idx"
    ON "novel_runs"("status", "lease_until");

ALTER TABLE "novel_runs" ADD CONSTRAINT "novel_runs_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 归属由复合外键钉死：work_id 属于该 author_id
ALTER TABLE "novel_runs" ADD CONSTRAINT "novel_runs_work_author_fkey"
    FOREIGN KEY ("work_id", "author_id") REFERENCES "works"("id", "author_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "novel_runs" ADD CONSTRAINT "novel_runs_status_check"
    CHECK ("status" IN (
        'queued',
        'running',
        'waiting_user',
        'waiting_approval',
        'completed',
        'failed',
        'cancelled'
    ));

ALTER TABLE "novel_runs" ADD CONSTRAINT "novel_runs_request_text_check"
    CHECK (char_length("request_text") BETWEEN 1 AND 2000
           AND char_length(btrim("request_text")) BETWEEN 1 AND 2000);

ALTER TABLE "novel_runs" ADD CONSTRAINT "novel_runs_goal_check"
    CHECK (char_length("current_goal") <= 500
           AND char_length("last_decision_summary") <= 500);

ALTER TABLE "novel_runs" ADD CONSTRAINT "novel_runs_budget_check"
    CHECK ("max_steps" BETWEEN 1 AND 100
           AND "step_count" BETWEEN 0 AND "max_steps"
           AND "state_version" >= 0);

ALTER TABLE "novel_runs" ADD CONSTRAINT "novel_runs_lease_check"
    CHECK (
        (
            "status" = 'running'
            AND "locked_by" IS NOT NULL
            AND char_length("locked_by") BETWEEN 1 AND 120
            AND "lease_until" IS NOT NULL
        )
        OR (
            "status" <> 'running'
            AND "locked_by" IS NULL
            AND "lease_until" IS NULL
        )
    );

ALTER TABLE "novel_runs" ADD CONSTRAINT "novel_runs_completed_check"
    CHECK (
        (
            "status" IN ('completed', 'failed', 'cancelled')
            AND "completed_at" IS NOT NULL
        )
        OR (
            "status" NOT IN ('completed', 'failed', 'cancelled')
            AND "completed_at" IS NULL
        )
    );

-- ---------------------------------------------------------------------------
-- novel_run_steps：Coordinator 已提交步骤（append-only）
-- ---------------------------------------------------------------------------
CREATE TABLE "novel_run_steps" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "step_no" INTEGER NOT NULL,
    "decision" JSONB NOT NULL,
    "tool_name" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "output_summary" JSONB NOT NULL,
    -- succeeded | failed
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "finished_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "novel_run_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "novel_run_steps_run_id_step_no_key"
    ON "novel_run_steps"("run_id", "step_no");

-- 供 novel_agent_calls 的复合外键引用：call 的 step 必须属于同一 run
CREATE UNIQUE INDEX "novel_run_steps_id_run_id_key"
    ON "novel_run_steps"("id", "run_id");

ALTER TABLE "novel_run_steps" ADD CONSTRAINT "novel_run_steps_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "novel_runs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "novel_run_steps" ADD CONSTRAINT "novel_run_steps_step_no_check"
    CHECK ("step_no" BETWEEN 1 AND 100);

ALTER TABLE "novel_run_steps" ADD CONSTRAINT "novel_run_steps_status_check"
    CHECK ("status" IN ('succeeded', 'failed'));

ALTER TABLE "novel_run_steps" ADD CONSTRAINT "novel_run_steps_error_check"
    CHECK (
        ("status" = 'succeeded' AND "error_code" IS NULL)
        OR (
            "status" = 'failed'
            AND "error_code" IS NOT NULL
            AND char_length("error_code") BETWEEN 1 AND 80
        )
    );

ALTER TABLE "novel_run_steps" ADD CONSTRAINT "novel_run_steps_tool_check"
    CHECK (char_length("tool_name") BETWEEN 1 AND 64);

ALTER TABLE "novel_run_steps" ADD CONSTRAINT "novel_run_steps_hash_check"
    CHECK ("input_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "novel_run_steps" ADD CONSTRAINT "novel_run_steps_json_check"
    CHECK (
        jsonb_typeof("decision") = 'object'
        AND jsonb_typeof("output_summary") = 'object'
    );

-- ---------------------------------------------------------------------------
-- novel_agent_calls：实际模型调用（append-only）
-- ---------------------------------------------------------------------------
CREATE TABLE "novel_agent_calls" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "step_id" UUID,
    -- C1-A 只允许 coordinator
    "call_kind" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "agent_version" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "novel_agent_calls_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "novel_agent_calls_run_id_created_at_idx"
    ON "novel_agent_calls"("run_id", "created_at");

CREATE INDEX "novel_agent_calls_step_id_idx"
    ON "novel_agent_calls"("step_id");

ALTER TABLE "novel_agent_calls" ADD CONSTRAINT "novel_agent_calls_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "novel_runs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- step 必须属于同一 run；step_id 为空表示该次尝试没有形成可提交步骤
ALTER TABLE "novel_agent_calls" ADD CONSTRAINT "novel_agent_calls_step_fkey"
    FOREIGN KEY ("step_id", "run_id") REFERENCES "novel_run_steps"("id", "run_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "novel_agent_calls" ADD CONSTRAINT "novel_agent_calls_kind_check"
    CHECK ("call_kind" = 'coordinator');

ALTER TABLE "novel_agent_calls" ADD CONSTRAINT "novel_agent_calls_identity_check"
    CHECK (
        char_length("agent_name") BETWEEN 1 AND 120
        AND char_length("agent_version") BETWEEN 1 AND 120
        AND char_length("provider") BETWEEN 1 AND 120
        AND char_length("model") BETWEEN 1 AND 120
    );

ALTER TABLE "novel_agent_calls" ADD CONSTRAINT "novel_agent_calls_usage_check"
    CHECK (
        "prompt_tokens" >= 0
        AND "completion_tokens" >= 0
        AND "latency_ms" >= 0
    );

ALTER TABLE "novel_agent_calls" ADD CONSTRAINT "novel_agent_calls_error_check"
    CHECK (
        ("success" AND "error_code" IS NULL)
        OR (
            NOT "success"
            AND "error_code" IS NOT NULL
            AND char_length("error_code") BETWEEN 1 AND 80
        )
    );

-- ---------------------------------------------------------------------------
-- novel_runs：受控状态更新
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "novel_runs_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'novel_runs 不可删除'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."author_id" IS DISTINCT FROM OLD."author_id"
     OR NEW."work_id" IS DISTINCT FROM OLD."work_id"
     OR NEW."request_text" IS DISTINCT FROM OLD."request_text"
     OR NEW."max_steps" IS DISTINCT FROM OLD."max_steps"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'novel_runs 的归属、请求文本、预算与创建时间不可修改'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."status" IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION '终态 novel_run 不可再修改'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'queued' AND NEW."status" IN ('running', 'cancelled'))
      OR (
        OLD."status" = 'running'
        AND NEW."status" IN (
          'queued', 'waiting_user', 'waiting_approval',
          'completed', 'failed', 'cancelled'
        )
      )
      OR (OLD."status" = 'waiting_user' AND NEW."status" IN ('queued', 'cancelled'))
      OR (
        OLD."status" = 'waiting_approval'
        AND NEW."status" IN ('queued', 'completed', 'failed', 'cancelled')
      )
    ) THEN
      RAISE EXCEPTION '非法的 novel run 状态迁移：% → %', OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW."state_version" < OLD."state_version"
     OR NEW."step_count" < OLD."step_count"
  THEN
    RAISE EXCEPTION 'state_version / step_count 只能单调递增'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "novel_runs_guard_trigger"
  BEFORE UPDATE OR DELETE ON "novel_runs"
  FOR EACH ROW EXECUTE FUNCTION "novel_runs_guard"();

-- ---------------------------------------------------------------------------
-- steps / calls：append-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "novel_run_steps_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'novel_run_steps 不可修改或删除（步骤 append-only）'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "novel_run_steps_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "novel_run_steps"
  FOR EACH ROW EXECUTE FUNCTION "novel_run_steps_immutable"();

CREATE OR REPLACE FUNCTION "novel_agent_calls_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'novel_agent_calls 不可修改或删除（调用日志 append-only）'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "novel_agent_calls_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "novel_agent_calls"
  FOR EACH ROW EXECUTE FUNCTION "novel_agent_calls_immutable"();
