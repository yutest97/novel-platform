-- A2-A：章节连续性事实候选（chapter_fact_runs + chapter_fact_candidates）。
--
-- 设计要点（改动前请先读）：
--
-- 1. **只产生候选**：本迁移不修改人物 / 物品 / 势力 / 关系 / 境界，
--    也不给 chapters / chapter_versions 增加任何列。
--
-- 2. 归属用**复合外键**在数据库层钉死：
--    - run：(chapter_id, work_id) → chapters(id, work_id)，
--           (source_version_id, chapter_id, work_id) → chapter_versions(id, chapter_id, work_id)；
--    - candidate：同样的两个外键 + (run_id) → chapter_fact_runs(id)。
--    这样"作品 / 章节 / 版本三者一致"由数据库保证，而不是只靠服务层。
--
-- 3. `UNIQUE(source_version_id)`：一个正式版本最多一个提取 run。
--    幂等与并发唯一性都靠它兜底；失败重试复用同一行（failed → running）。
--
-- 4. runs 只允许**受控状态更新**：
--    - 只允许改 status / error_code / finished_at；
--    - running → succeeded / failed、failed → running；
--    - succeeded 之后不可再改；DELETE 一律拒绝。
--
-- 5. candidates **append-only**：UPDATE / DELETE 一律拒绝；
--    status 只允许 'candidate'；fact_type 白名单；payload 必须是非空 JSON 对象。
--    正文、prompt、模型原始响应都不得进入 payload（由服务层保证）。
--
-- 6. 测试清理沿用受控 `ALTER TABLE ... DISABLE TRIGGER USER` 策略（与 chapter_versions 一致）。

-- ---------------------------------------------------------------------------
-- chapter_fact_runs：一次提取运行
-- ---------------------------------------------------------------------------
CREATE TABLE "chapter_fact_runs" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "source_version_id" UUID NOT NULL,
    "agent_name" TEXT NOT NULL,
    "agent_version" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    -- running | succeeded | failed
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "chapter_fact_runs_pkey" PRIMARY KEY ("id")
);

-- 一个正式版本最多一个 run：幂等 / 并发的数据库兜底
CREATE UNIQUE INDEX "chapter_fact_runs_source_version_id_key"
    ON "chapter_fact_runs"("source_version_id");

CREATE INDEX "chapter_fact_runs_chapter_id_created_at_idx"
    ON "chapter_fact_runs"("chapter_id", "created_at");

ALTER TABLE "chapter_fact_runs" ADD CONSTRAINT "chapter_fact_runs_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_fact_runs" ADD CONSTRAINT "chapter_fact_runs_chapter_work_fkey"
    FOREIGN KEY ("chapter_id", "work_id")
    REFERENCES "chapters"("id", "work_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_fact_runs" ADD CONSTRAINT "chapter_fact_runs_version_fkey"
    FOREIGN KEY ("source_version_id", "chapter_id", "work_id")
    REFERENCES "chapter_versions"("id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_fact_runs" ADD CONSTRAINT "chapter_fact_runs_status_check"
    CHECK ("status" IN ('running', 'succeeded', 'failed'));

-- 终态必须有 finished_at；running 必须没有；failed 必须有 error_code
ALTER TABLE "chapter_fact_runs" ADD CONSTRAINT "chapter_fact_runs_terminal_check"
    CHECK (
        ("status" = 'running' AND "finished_at" IS NULL AND "error_code" IS NULL)
        OR ("status" = 'succeeded' AND "finished_at" IS NOT NULL AND "error_code" IS NULL)
        OR ("status" = 'failed' AND "finished_at" IS NOT NULL AND "error_code" IS NOT NULL)
    );

-- ---------------------------------------------------------------------------
-- chapter_fact_candidates：结构化事实候选（append-only）
-- ---------------------------------------------------------------------------
CREATE TABLE "chapter_fact_candidates" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "source_version_id" UUID NOT NULL,
    -- character_state | relationship_change | item_change | realm_progress | plot_thread | location_change
    "fact_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "chapter_fact_candidates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chapter_fact_candidates_run_id_idx"
    ON "chapter_fact_candidates"("run_id");

CREATE INDEX "chapter_fact_candidates_chapter_id_fact_type_idx"
    ON "chapter_fact_candidates"("chapter_id", "fact_type");

ALTER TABLE "chapter_fact_candidates" ADD CONSTRAINT "chapter_fact_candidates_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "chapter_fact_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_fact_candidates" ADD CONSTRAINT "chapter_fact_candidates_chapter_work_fkey"
    FOREIGN KEY ("chapter_id", "work_id")
    REFERENCES "chapters"("id", "work_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_fact_candidates" ADD CONSTRAINT "chapter_fact_candidates_version_fkey"
    FOREIGN KEY ("source_version_id", "chapter_id", "work_id")
    REFERENCES "chapter_versions"("id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_fact_candidates" ADD CONSTRAINT "chapter_fact_candidates_fact_type_check"
    CHECK ("fact_type" IN (
        'character_state',
        'relationship_change',
        'item_change',
        'realm_progress',
        'plot_thread',
        'location_change'
    ));

ALTER TABLE "chapter_fact_candidates" ADD CONSTRAINT "chapter_fact_candidates_status_check"
    CHECK ("status" = 'candidate');

-- payload 必须是非空 JSON 对象（不允许数组 / 标量 / 空对象）
ALTER TABLE "chapter_fact_candidates" ADD CONSTRAINT "chapter_fact_candidates_payload_check"
    CHECK (jsonb_typeof("payload") = 'object' AND "payload" <> '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- runs：只允许受控状态更新
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "chapter_fact_runs_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chapter_fact_runs 不可删除'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- 除 status / error_code / finished_at 外任何列变化都拒绝
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."work_id" IS DISTINCT FROM OLD."work_id"
     OR NEW."chapter_id" IS DISTINCT FROM OLD."chapter_id"
     OR NEW."source_version_id" IS DISTINCT FROM OLD."source_version_id"
     OR NEW."agent_name" IS DISTINCT FROM OLD."agent_name"
     OR NEW."agent_version" IS DISTINCT FROM OLD."agent_version"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."model" IS DISTINCT FROM OLD."model"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'chapter_fact_runs 只允许状态更新（status / error_code / finished_at）'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- 成功是终态：不允许再改（重复提取走幂等读取，不写库）
  IF OLD."status" = 'succeeded' THEN
    RAISE EXCEPTION '已成功的 run 不可再修改'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'running' AND NEW."status" IN ('succeeded', 'failed'))
      OR (OLD."status" = 'failed' AND NEW."status" = 'running')
    ) THEN
      RAISE EXCEPTION '非法的 run 状态迁移：% → %', OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chapter_fact_runs_guard_trigger"
  BEFORE UPDATE OR DELETE ON "chapter_fact_runs"
  FOR EACH ROW EXECUTE FUNCTION "chapter_fact_runs_guard"();

-- ---------------------------------------------------------------------------
-- candidates：append-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "chapter_fact_candidates_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'chapter_fact_candidates 不可修改或删除（候选 append-only）'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chapter_fact_candidates_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "chapter_fact_candidates"
  FOR EACH ROW EXECUTE FUNCTION "chapter_fact_candidates_immutable"();
