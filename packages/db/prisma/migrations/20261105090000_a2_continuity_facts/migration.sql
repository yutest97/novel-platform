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
--    - candidate：`(run_id, source_version_id, chapter_id, work_id)` →
--           `chapter_fact_runs(id, source_version_id, chapter_id, work_id)`。
--    **candidate 的 run 外键是复合的**：候选必须与它引用的 run 属于同一
--    作品 / 章节 / 版本。只用 `run_id` 单列外键时，候选可以挂在 run A 上却
--    把 work/chapter/version 指向另一个合法组合，数据库无法拒绝。
--    另有独立的作品 / 章节 / 版本外键，保证三者本身也是有效组合。
--
-- 3. `UNIQUE(source_version_id)`：一个正式版本最多一个提取 run。
--    幂等与并发唯一性都靠它兜底；失败重试复用同一行（failed → running）。
--
-- 4. `started_at` 是**本次尝试的开始时间**，同时充当 running 租约：
--    - 新建 run 与 failed → running 都刷新为数据库时钟；
--    - 进程崩溃留下的 running 在租约（服务层常量，10 分钟）到期后可被接管：
--      先原子标为 failed，再复用同一行重新 running。
--
-- 4b. `attempt_token` 是**本次尝试的身份**（fencing token）：
--    - 新建 run 由数据库默认 `gen_random_uuid()` 生成；
--    - 每次 failed → running（含租约接管后的 restart）**必须轮换**为新值；
--    - 只允许在 failed → running 时变化，running → succeeded 与 succeeded 之后都不可改；
--    - 服务层的成功写入与失败标记都以 `attempt_token` 做 CAS：租约过期只触发接管，
--      不保证旧进程立即停止，因此旧 attempt 即使稍后返回也**不能**提交或改写新 attempt。
--
-- 5. runs 只允许**受控状态更新**：
--    - 归属 / Agent 身份 / created_at 不可变；
--    - running → succeeded / failed、failed → running；
--    - succeeded 之后不可再改；DELETE 一律拒绝；
--    - provider / model 只允许在 running 期间（记录本次实际模型）或重试开始时更新；
--    - started_at 只允许在重试开始时刷新。
--
-- 6. candidates **append-only**：UPDATE / DELETE 一律拒绝；
--    status 只允许 'candidate'；fact_type 白名单；payload 必须是非空 JSON 对象。
--    正文、prompt、模型原始响应都不得进入 payload（由服务层保证）。
--
-- 7. 测试清理沿用受控 `ALTER TABLE ... DISABLE TRIGGER USER` 策略（与 chapter_versions 一致）。

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
    -- 本次尝试开始时间（running 租约的起点）
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    -- 本次尝试的身份（fencing token）：每次重试必须轮换
    "attempt_token" UUID NOT NULL DEFAULT gen_random_uuid(),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "chapter_fact_runs_pkey" PRIMARY KEY ("id")
);

-- 一个正式版本最多一个 run：幂等 / 并发的数据库兜底
CREATE UNIQUE INDEX "chapter_fact_runs_source_version_id_key"
    ON "chapter_fact_runs"("source_version_id");

-- 复合归属键：让 candidate 的 run 外键能同时锁定 work / chapter / version
CREATE UNIQUE INDEX "chapter_fact_runs_identity_key"
    ON "chapter_fact_runs"("id", "source_version_id", "chapter_id", "work_id");

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

-- 复合 run 外键：候选的 work / chapter / version 必须与 run 完全一致
ALTER TABLE "chapter_fact_candidates" ADD CONSTRAINT "chapter_fact_candidates_run_fkey"
    FOREIGN KEY ("run_id", "source_version_id", "chapter_id", "work_id")
    REFERENCES "chapter_fact_runs"("id", "source_version_id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

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

  -- 归属、Agent 身份与创建时间不可变
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."work_id" IS DISTINCT FROM OLD."work_id"
     OR NEW."chapter_id" IS DISTINCT FROM OLD."chapter_id"
     OR NEW."source_version_id" IS DISTINCT FROM OLD."source_version_id"
     OR NEW."agent_name" IS DISTINCT FROM OLD."agent_name"
     OR NEW."agent_version" IS DISTINCT FROM OLD."agent_version"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'chapter_fact_runs 的归属、Agent 身份与创建时间不可修改'
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

  -- started_at 是「本次尝试」的时间戳：只允许在重试开始时刷新
  IF NEW."started_at" IS DISTINCT FROM OLD."started_at"
     AND NOT (OLD."status" = 'failed' AND NEW."status" = 'running')
  THEN
    RAISE EXCEPTION 'started_at 只允许在重试开始时刷新'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- attempt_token 是本次尝试的身份：只允许在重试开始时变化，且必须变成新值
  IF NEW."attempt_token" IS DISTINCT FROM OLD."attempt_token"
     AND NOT (OLD."status" = 'failed' AND NEW."status" = 'running')
  THEN
    RAISE EXCEPTION 'attempt_token 只允许在重试开始时轮换'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."status" = 'failed' AND NEW."status" = 'running'
     AND NEW."attempt_token" IS NOT DISTINCT FROM OLD."attempt_token"
  THEN
    RAISE EXCEPTION '重试必须轮换 attempt_token'
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
