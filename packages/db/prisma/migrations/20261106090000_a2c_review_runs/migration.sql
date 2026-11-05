-- A2-C-B：章节候选审阅运行与问题（chapter_review_runs + chapter_review_issues）。
--
-- 设计要点（改动前请先读）：
--
-- 1. **一个候选最多一个 run**：`UNIQUE(candidate_id)`；同时
--    `UNIQUE(generation_task_id)` 保证一个 `chapter.review` 任务对应一个 run。
--    任务重试复用同一行（failed → running），不产生第二条。
--
-- 2. 归属用**复合外键**在数据库层钉死：
--    - run：(chapter_id, work_id) → chapters(id, work_id)，
--           (candidate_id, chapter_id, work_id) → chapter_candidates(id, chapter_id, work_id)，
--           (generation_task_id, chapter_id, work_id) → generation_tasks(id, chapter_id, work_id)；
--    - issue：`(run_id, candidate_id, chapter_id, work_id)` →
--           `chapter_review_runs(id, candidate_id, chapter_id, work_id)`。
--    只用单列外键时，issue 可以挂在 run A 上却把 work/chapter/candidate 指向
--    另一个合法组合，数据库无法拒绝；复合外键直接杜绝这种组合。
--
-- 3. run 只允许**受控状态更新**（running → succeeded / failed、failed → running）：
--    - 归属 / Agent 身份 / created_at 不可变；
--    - succeeded 是终态：不可再改、不可删除；DELETE 一律拒绝；
--    - provider / model 只允许在 running 期间（记录本次实际模型）或重试开始时更新；
--    - started_at 只允许在重试开始时刷新。
--
-- 4. 结论一致性由数据库兜底：
--    - 成功且 passed=true ⇔ issue_count = 0；
--    - 成功且 passed=false ⇔ issue_count 1..20；
--    - running / failed 时 passed IS NULL 且 issue_count = 0；
--    - running 必须没有 finished_at / error_code，终态必须都有。
--
-- 5. issues **append-only**：UPDATE / DELETE 由触发器拒绝；
--    severity / type / 长度 / ordinal 由 CHECK 兜底。
--    本表不存正文副本、prompt 或模型原始响应（evidence 是问题的一部分，
--    按原样保存，但不允许另存整段 draft）。
--
-- 6. 测试清理沿用受控 `ALTER TABLE ... DISABLE TRIGGER USER` 策略
--    （与 chapter_versions / chapter_fact_* 一致）。

-- ---------------------------------------------------------------------------
-- chapter_review_runs：一次候选审阅运行
-- ---------------------------------------------------------------------------
CREATE TABLE "chapter_review_runs" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "generation_task_id" UUID NOT NULL,
    "agent_name" TEXT NOT NULL,
    "agent_version" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    -- running | succeeded | failed
    "status" TEXT NOT NULL,
    -- 成功时的结论：true = 没有问题，false = 有 1..20 个问题；未终结时为 NULL
    "passed" BOOLEAN,
    "issue_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    -- 本次尝试开始时间（running 租约的起点，重试时刷新）
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "chapter_review_runs_pkey" PRIMARY KEY ("id")
);

-- 每个候选最多一个 run；每个 review 任务最多一个 run
CREATE UNIQUE INDEX "chapter_review_runs_candidate_id_key"
    ON "chapter_review_runs"("candidate_id");

CREATE UNIQUE INDEX "chapter_review_runs_generation_task_id_key"
    ON "chapter_review_runs"("generation_task_id");

-- 复合归属键：让 issue 的外键能同时锁定 candidate / chapter / work
CREATE UNIQUE INDEX "chapter_review_runs_identity_key"
    ON "chapter_review_runs"("id", "candidate_id", "chapter_id", "work_id");

CREATE INDEX "chapter_review_runs_chapter_id_created_at_idx"
    ON "chapter_review_runs"("chapter_id", "created_at");

ALTER TABLE "chapter_review_runs" ADD CONSTRAINT "chapter_review_runs_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_review_runs" ADD CONSTRAINT "chapter_review_runs_chapter_work_fkey"
    FOREIGN KEY ("chapter_id", "work_id")
    REFERENCES "chapters"("id", "work_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_review_runs" ADD CONSTRAINT "chapter_review_runs_candidate_fkey"
    FOREIGN KEY ("candidate_id", "chapter_id", "work_id")
    REFERENCES "chapter_candidates"("id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_review_runs" ADD CONSTRAINT "chapter_review_runs_task_fkey"
    FOREIGN KEY ("generation_task_id", "chapter_id", "work_id")
    REFERENCES "generation_tasks"("id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_review_runs" ADD CONSTRAINT "chapter_review_runs_status_check"
    CHECK ("status" IN ('running', 'succeeded', 'failed'));

ALTER TABLE "chapter_review_runs" ADD CONSTRAINT "chapter_review_runs_issue_count_check"
    CHECK ("issue_count" BETWEEN 0 AND 20);

-- 状态、结论、计数与时间戳必须自洽
ALTER TABLE "chapter_review_runs" ADD CONSTRAINT "chapter_review_runs_outcome_check"
    CHECK (
        (
            "status" = 'running'
            AND "passed" IS NULL
            AND "issue_count" = 0
            AND "finished_at" IS NULL
            AND "error_code" IS NULL
        )
        OR (
            "status" = 'succeeded'
            AND "passed" IS NOT NULL
            AND "finished_at" IS NOT NULL
            AND "error_code" IS NULL
            AND (
                ("passed" AND "issue_count" = 0)
                OR (NOT "passed" AND "issue_count" BETWEEN 1 AND 20)
            )
        )
        OR (
            "status" = 'failed'
            AND "passed" IS NULL
            AND "issue_count" = 0
            AND "finished_at" IS NOT NULL
            AND "error_code" IS NOT NULL
        )
    );

-- ---------------------------------------------------------------------------
-- chapter_review_issues：结构化审阅问题（append-only）
-- ---------------------------------------------------------------------------
CREATE TABLE "chapter_review_issues" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    -- 0 起算，按 Reviewer 输出顺序
    "ordinal" INTEGER NOT NULL,
    -- high | medium | low
    "severity" TEXT NOT NULL,
    -- contract_violation | setting_contradiction | timeline_conflict | item_state_conflict
    -- | plot_thread_conflict | character_consistency | prose_quality
    "type" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "chapter_review_issues_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chapter_review_issues_run_id_ordinal_key"
    ON "chapter_review_issues"("run_id", "ordinal");

CREATE INDEX "chapter_review_issues_candidate_id_ordinal_idx"
    ON "chapter_review_issues"("candidate_id", "ordinal");

-- 复合 run 外键：issue 的 candidate / chapter / work 必须与 run 完全一致
ALTER TABLE "chapter_review_issues" ADD CONSTRAINT "chapter_review_issues_run_fkey"
    FOREIGN KEY ("run_id", "candidate_id", "chapter_id", "work_id")
    REFERENCES "chapter_review_runs"("id", "candidate_id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_review_issues" ADD CONSTRAINT "chapter_review_issues_ordinal_check"
    CHECK ("ordinal" BETWEEN 0 AND 19);

ALTER TABLE "chapter_review_issues" ADD CONSTRAINT "chapter_review_issues_severity_check"
    CHECK ("severity" IN ('high', 'medium', 'low'));

ALTER TABLE "chapter_review_issues" ADD CONSTRAINT "chapter_review_issues_type_check"
    CHECK ("type" IN (
        'contract_violation',
        'setting_contradiction',
        'timeline_conflict',
        'item_state_conflict',
        'plot_thread_conflict',
        'character_consistency',
        'prose_quality'
    ));

-- 长度与"非空白"兜底（纯空白由服务层拒绝，这里至少挡住空串 / 超长）
ALTER TABLE "chapter_review_issues" ADD CONSTRAINT "chapter_review_issues_evidence_check"
    CHECK (char_length("evidence") BETWEEN 1 AND 300);

ALTER TABLE "chapter_review_issues" ADD CONSTRAINT "chapter_review_issues_suggestion_check"
    CHECK (char_length("suggestion") BETWEEN 1 AND 500);

-- ---------------------------------------------------------------------------
-- runs：只允许受控状态更新
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "chapter_review_runs_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chapter_review_runs 不可删除'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- 归属、Agent 身份与创建时间不可变
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."work_id" IS DISTINCT FROM OLD."work_id"
     OR NEW."chapter_id" IS DISTINCT FROM OLD."chapter_id"
     OR NEW."candidate_id" IS DISTINCT FROM OLD."candidate_id"
     OR NEW."generation_task_id" IS DISTINCT FROM OLD."generation_task_id"
     OR NEW."agent_name" IS DISTINCT FROM OLD."agent_name"
     OR NEW."agent_version" IS DISTINCT FROM OLD."agent_version"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'chapter_review_runs 的归属、Agent 身份与创建时间不可修改'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- 成功是终态：不允许再改（重复审阅走幂等读取，不写库）
  IF OLD."status" = 'succeeded' THEN
    RAISE EXCEPTION '已成功的 review run 不可再修改'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'running' AND NEW."status" IN ('succeeded', 'failed'))
      OR (OLD."status" = 'failed' AND NEW."status" = 'running')
    ) THEN
      RAISE EXCEPTION '非法的 review run 状态迁移：% → %', OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- 结论只在 running → succeeded 时写入；重新开始必须清空
  IF (
       NEW."passed" IS DISTINCT FROM OLD."passed"
       OR NEW."issue_count" IS DISTINCT FROM OLD."issue_count"
     )
     AND NOT (OLD."status" = 'running' AND NEW."status" = 'succeeded')
     AND NOT (OLD."status" = 'failed' AND NEW."status" = 'running')
  THEN
    RAISE EXCEPTION 'passed / issue_count 只允许在成功落库或重试开始时变化'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- started_at 是「本次尝试」的时间戳：只允许在重试开始时刷新
  IF NEW."started_at" IS DISTINCT FROM OLD."started_at"
     AND NOT (OLD."status" = 'failed' AND NEW."status" = 'running')
  THEN
    RAISE EXCEPTION 'started_at 只允许在重试开始时刷新'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- provider / model：running 期间记录本次实际模型，或重试开始时更新为新配置
  IF (
       NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."model" IS DISTINCT FROM OLD."model"
     )
     AND NOT (
       OLD."status" = 'running'
       OR (OLD."status" = 'failed' AND NEW."status" = 'running')
     )
  THEN
    RAISE EXCEPTION 'provider / model 只允许在 running 期间或重试开始时更新'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chapter_review_runs_guard_trigger"
  BEFORE UPDATE OR DELETE ON "chapter_review_runs"
  FOR EACH ROW EXECUTE FUNCTION "chapter_review_runs_guard"();

-- ---------------------------------------------------------------------------
-- issues：append-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "chapter_review_issues_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'chapter_review_issues 不可修改或删除（问题 append-only）'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chapter_review_issues_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "chapter_review_issues"
  FOR EACH ROW EXECUTE FUNCTION "chapter_review_issues_immutable"();

-- ---------------------------------------------------------------------------
-- 兜底：review 任务进入终态时，不留下永久 running 的 run
-- ---------------------------------------------------------------------------
-- 取消（作者意图）与重试用尽（LEASE_EXHAUSTED / 不可重试错误）都会让任务直接
-- 进入终态，此时工作流已经没有机会再写 run。若不处理，run 会永远停在 running，
-- 既不能被接管（任务不会再来），也无法表达"这次审阅没有结论"。
--
-- 只处理 processing → cancelled/failed：重试回 queued 不属于终态，run 由下一次
-- attempt 接管（failed → running，复用同一行）。
CREATE OR REPLACE FUNCTION "generation_tasks_close_review_run"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IN ('cancelled', 'failed')
     AND OLD."status" = 'processing'
  THEN
    UPDATE "chapter_review_runs"
       SET "status" = 'failed',
           "error_code" = CASE
             WHEN NEW."status" = 'cancelled' THEN 'TASK_CANCELLED'
             ELSE COALESCE(NEW."error_code", 'TASK_VALIDATION_FAILED')
           END,
           "finished_at" = clock_timestamp()
     WHERE "generation_task_id" = NEW."id"
       AND "status" = 'running';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "generation_tasks_close_review_run_trigger"
  BEFORE UPDATE ON "generation_tasks"
  FOR EACH ROW EXECUTE FUNCTION "generation_tasks_close_review_run"();
