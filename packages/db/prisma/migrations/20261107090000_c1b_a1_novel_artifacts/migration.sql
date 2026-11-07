-- C1-B-A1：故事候选域（artifact / revision / decision）与 Concept Agent 落库约束。
--
-- 本迁移不修改已验收的历史迁移，只做增量：
-- 1. novel_runs 增加 (id, author_id) 唯一索引，供 artifact 的复合外键引用；
-- 2. 新增 novel_artifacts / novel_artifact_revisions / novel_artifact_decisions；
-- 3. novel_agent_calls 允许 call_kind = 'tool'（Concept Agent 实际调用遥测）；
-- 4. 扩展 novel_runs 状态机，允许 queued / waiting_user 进入 waiting_approval
--    （C1-B-A1 内部服务在未接 Runtime 时也要能完成作者确认闭环）。

-- ---------------------------------------------------------------------------
-- 1. novel_runs：(id, author_id) 复合唯一
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "novel_runs_id_author_id_key"
    ON "novel_runs"("id", "author_id");

-- ---------------------------------------------------------------------------
-- 2. novel_artifacts
-- ---------------------------------------------------------------------------

CREATE TABLE "novel_artifacts" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    -- C1-B-A1 固定为 NULL；C1-B-D 才允许绑定作品
    "work_id" UUID,
    "artifact_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "current_revision" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "novel_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "novel_artifacts_run_id_artifact_type_key"
    ON "novel_artifacts"("run_id", "artifact_type");

CREATE UNIQUE INDEX "novel_artifacts_id_run_id_author_id_key"
    ON "novel_artifacts"("id", "run_id", "author_id");

CREATE UNIQUE INDEX "novel_artifacts_id_author_id_key"
    ON "novel_artifacts"("id", "author_id");

CREATE INDEX "novel_artifacts_author_id_created_at_idx"
    ON "novel_artifacts"("author_id", "created_at");

ALTER TABLE "novel_artifacts" ADD CONSTRAINT "novel_artifacts_type_check"
    CHECK ("artifact_type" IN ('concept'));

ALTER TABLE "novel_artifacts" ADD CONSTRAINT "novel_artifacts_status_check"
    CHECK ("status" IN ('draft', 'pending_approval', 'approved', 'rejected'));

ALTER TABLE "novel_artifacts" ADD CONSTRAINT "novel_artifacts_current_revision_check"
    CHECK ("current_revision" >= 1);

-- C1-B-A1 尚未引入 Work 绑定
ALTER TABLE "novel_artifacts" ADD CONSTRAINT "novel_artifacts_work_null_check"
    CHECK ("work_id" IS NULL);

-- artifact 的 author 必须等于 run 的 author（复合外键）
ALTER TABLE "novel_artifacts" ADD CONSTRAINT "novel_artifacts_run_author_fkey"
    FOREIGN KEY ("run_id", "author_id") REFERENCES "novel_runs"("id", "author_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "novel_artifacts" ADD CONSTRAINT "novel_artifacts_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- work 必须属于同一 author（本卡 work_id 恒为 NULL，保留约束供后续阶段）
ALTER TABLE "novel_artifacts" ADD CONSTRAINT "novel_artifacts_work_author_fkey"
    FOREIGN KEY ("work_id", "author_id") REFERENCES "works"("id", "author_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. novel_artifact_revisions（append-only）
-- ---------------------------------------------------------------------------

CREATE TABLE "novel_artifact_revisions" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    -- 冗余列仅用于复合外键：revision 必须钉在同一 run / author 的 artifact 上
    "run_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "schema_version" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "source_agent" TEXT NOT NULL,
    "source_agent_version" TEXT NOT NULL,
    "source_step_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "novel_artifact_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "novel_artifact_revisions_artifact_id_revision_no_key"
    ON "novel_artifact_revisions"("artifact_id", "revision_no");

CREATE INDEX "novel_artifact_revisions_artifact_id_created_at_idx"
    ON "novel_artifact_revisions"("artifact_id", "created_at");

ALTER TABLE "novel_artifact_revisions" ADD CONSTRAINT "novel_artifact_revisions_revision_no_check"
    CHECK ("revision_no" >= 1);

ALTER TABLE "novel_artifact_revisions" ADD CONSTRAINT "novel_artifact_revisions_schema_version_check"
    CHECK ("schema_version" = 'concept@1.0.0');

ALTER TABLE "novel_artifact_revisions" ADD CONSTRAINT "novel_artifact_revisions_content_check"
    CHECK (
        jsonb_typeof("content") = 'object'
        AND octet_length("content"::text) BETWEEN 1 AND 131072
    );

ALTER TABLE "novel_artifact_revisions" ADD CONSTRAINT "novel_artifact_revisions_source_check"
    CHECK (
        char_length("source_agent") BETWEEN 1 AND 120
        AND char_length("source_agent_version") BETWEEN 1 AND 120
    );

-- revision 必须属于同一 run / author 的 artifact
ALTER TABLE "novel_artifact_revisions" ADD CONSTRAINT "novel_artifact_revisions_artifact_fkey"
    FOREIGN KEY ("artifact_id", "run_id", "author_id")
    REFERENCES "novel_artifacts"("id", "run_id", "author_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- source step 若存在必须属于同一 run
ALTER TABLE "novel_artifact_revisions" ADD CONSTRAINT "novel_artifact_revisions_source_step_fkey"
    FOREIGN KEY ("source_step_id", "run_id") REFERENCES "novel_run_steps"("id", "run_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. novel_artifact_decisions（append-only）
-- ---------------------------------------------------------------------------

CREATE TABLE "novel_artifact_decisions" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "author_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "novel_artifact_decisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "novel_artifact_decisions_artifact_id_revision_no_key"
    ON "novel_artifact_decisions"("artifact_id", "revision_no");

CREATE INDEX "novel_artifact_decisions_artifact_id_decided_at_idx"
    ON "novel_artifact_decisions"("artifact_id", "decided_at");

ALTER TABLE "novel_artifact_decisions" ADD CONSTRAINT "novel_artifact_decisions_value_check"
    CHECK ("decision" IN ('approved', 'rejected'));

ALTER TABLE "novel_artifact_decisions" ADD CONSTRAINT "novel_artifact_decisions_revision_no_check"
    CHECK ("revision_no" >= 1);

-- 决策必须引用同一 artifact 的 revision
ALTER TABLE "novel_artifact_decisions" ADD CONSTRAINT "novel_artifact_decisions_revision_fkey"
    FOREIGN KEY ("artifact_id", "revision_no")
    REFERENCES "novel_artifact_revisions"("artifact_id", "revision_no")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 决策 author 必须等于 artifact / run 的 author
ALTER TABLE "novel_artifact_decisions" ADD CONSTRAINT "novel_artifact_decisions_artifact_author_fkey"
    FOREIGN KEY ("artifact_id", "author_id") REFERENCES "novel_artifacts"("id", "author_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. novel_agent_calls：允许 tool（Concept Agent 实际调用遥测）
-- ---------------------------------------------------------------------------

ALTER TABLE "novel_agent_calls" DROP CONSTRAINT "novel_agent_calls_kind_check";

ALTER TABLE "novel_agent_calls" ADD CONSTRAINT "novel_agent_calls_kind_check"
    CHECK ("call_kind" IN ('coordinator', 'tool'));

-- ---------------------------------------------------------------------------
-- 6. novel_runs 状态机：允许 queued / waiting_user 进入 waiting_approval
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
      (OLD."status" = 'queued' AND NEW."status" IN ('running', 'cancelled', 'waiting_approval'))
      OR (
        OLD."status" = 'running'
        AND NEW."status" IN (
          'queued', 'waiting_user', 'waiting_approval',
          'completed', 'failed', 'cancelled'
        )
      )
      OR (
        OLD."status" = 'waiting_user'
        AND NEW."status" IN ('queued', 'cancelled', 'waiting_approval')
      )
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

-- ---------------------------------------------------------------------------
-- 7. novel_artifacts 触发器
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "novel_artifacts_insert_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'draft' OR NEW."current_revision" <> 1 THEN
    RAISE EXCEPTION 'novel_artifact 只能以 draft / current_revision=1 创建'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "novel_artifacts_insert_guard_trigger"
  BEFORE INSERT ON "novel_artifacts"
  FOR EACH ROW EXECUTE FUNCTION "novel_artifacts_insert_guard"();

CREATE OR REPLACE FUNCTION "novel_artifacts_guard"() RETURNS trigger AS $$
DECLARE
  has_decision boolean;
  has_revision boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'novel_artifacts 不可删除'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
     OR NEW."author_id" IS DISTINCT FROM OLD."author_id"
     OR NEW."work_id" IS DISTINCT FROM OLD."work_id"
     OR NEW."artifact_type" IS DISTINCT FROM OLD."artifact_type"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'novel_artifact 的归属、类型与创建时间不可修改'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- approved 为终态
  IF OLD."status" = 'approved' THEN
    RAISE EXCEPTION 'approved novel_artifact 不可再修改'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."current_revision" < OLD."current_revision" THEN
    RAISE EXCEPTION 'current_revision 只能单调递增'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'draft' AND NEW."status" = 'pending_approval')
      OR (OLD."status" = 'pending_approval' AND NEW."status" IN ('approved', 'rejected'))
      OR (OLD."status" = 'rejected' AND NEW."status" = 'draft')
    ) THEN
      RAISE EXCEPTION '非法的 novel_artifact 状态迁移：% → %', OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW."current_revision" > OLD."current_revision" THEN
    -- 只有 draft / rejected 可以生成新 revision；rejected → draft 必须同时 +1
    IF OLD."status" NOT IN ('draft', 'rejected')
       OR NEW."status" <> 'draft'
       OR NEW."current_revision" <> OLD."current_revision" + 1
    THEN
      RAISE EXCEPTION '只有 draft / rejected novel_artifact 可生成下一个 revision'
        USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM "novel_artifact_revisions" r
      WHERE r."artifact_id" = NEW."id"
        AND r."revision_no" = NEW."current_revision"
    ) INTO has_revision;
    IF NOT has_revision THEN
      RAISE EXCEPTION 'current_revision 必须对应已存在的 revision'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW."status" IS DISTINCT FROM OLD."status" AND OLD."status" = 'rejected' THEN
    -- rejected → draft 必须生成新 revision
    RAISE EXCEPTION 'rejected → draft 必须生成新 revision'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- status 与 decision 必须自洽
  SELECT EXISTS (
    SELECT 1 FROM "novel_artifact_decisions" d
    WHERE d."artifact_id" = NEW."id"
      AND d."revision_no" = NEW."current_revision"
  ) INTO has_decision;

  IF NEW."status" IN ('approved', 'rejected') THEN
    IF NOT has_decision THEN
      RAISE EXCEPTION '% novel_artifact 必须有当前 revision 的 decision', NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF has_decision THEN
    RAISE EXCEPTION 'draft / pending_approval novel_artifact 不允许已有 decision'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "novel_artifacts_guard_trigger"
  BEFORE UPDATE OR DELETE ON "novel_artifacts"
  FOR EACH ROW EXECUTE FUNCTION "novel_artifacts_guard"();

-- ---------------------------------------------------------------------------
-- 8. novel_artifact_revisions 触发器（append-only + 归属 / 状态门禁）
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "novel_artifact_revisions_guard"() RETURNS trigger AS $$
DECLARE
  artifact_status text;
  artifact_current integer;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'novel_artifact_revisions 不可修改或删除（revision append-only）'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT a."status", a."current_revision"
    INTO artifact_status, artifact_current
    FROM "novel_artifacts" a
    WHERE a."id" = NEW."artifact_id";

  IF NOT FOUND THEN
    -- 交给复合外键报错
    RETURN NEW;
  END IF;

  IF artifact_status = 'approved' THEN
    RAISE EXCEPTION 'approved novel_artifact 不允许新增 revision'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."revision_no" > artifact_current + 1 THEN
    RAISE EXCEPTION 'revision_no 不能超过 current_revision + 1'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "novel_artifact_revisions_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "novel_artifact_revisions"
  FOR EACH ROW EXECUTE FUNCTION "novel_artifact_revisions_guard"();

-- 事务提交时校验：current_revision 必须与最大 revision 编号一致。
-- 服务层在同一事务里先插 revision、再推进 current_revision，因此使用延迟约束触发器。
CREATE OR REPLACE FUNCTION "novel_artifact_revision_consistency"() RETURNS trigger AS $$
DECLARE
  target_artifact uuid;
  artifact_current integer;
  max_revision integer;
BEGIN
  IF TG_TABLE_NAME = 'novel_artifact_revisions' THEN
    target_artifact := NEW."artifact_id";
  ELSE
    target_artifact := NEW."id";
  END IF;

  SELECT a."current_revision" INTO artifact_current
    FROM "novel_artifacts" a
    WHERE a."id" = target_artifact;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(MAX(r."revision_no"), 0) INTO max_revision
    FROM "novel_artifact_revisions" r
    WHERE r."artifact_id" = target_artifact;

  IF artifact_current <> max_revision THEN
    RAISE EXCEPTION 'current_revision (%) 必须等于 revision 最大编号 (%)', artifact_current, max_revision
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "novel_artifact_revisions_consistency_trigger"
  AFTER INSERT OR UPDATE ON "novel_artifact_revisions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "novel_artifact_revision_consistency"();

CREATE CONSTRAINT TRIGGER "novel_artifacts_consistency_trigger"
  AFTER INSERT OR UPDATE ON "novel_artifacts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "novel_artifact_revision_consistency"();

-- ---------------------------------------------------------------------------
-- 9. novel_artifact_decisions 触发器（append-only + 状态门禁）
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "novel_artifact_decisions_guard"() RETURNS trigger AS $$
DECLARE
  artifact_status text;
  artifact_current integer;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'novel_artifact_decisions 不可修改或删除（decision append-only）'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT a."status", a."current_revision"
    INTO artifact_status, artifact_current
    FROM "novel_artifacts" a
    WHERE a."id" = NEW."artifact_id";

  IF NOT FOUND THEN
    -- 交给复合外键报错
    RETURN NEW;
  END IF;

  IF artifact_status <> 'pending_approval' THEN
    RAISE EXCEPTION '只有 pending_approval novel_artifact 可以写入 decision'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."revision_no" <> artifact_current THEN
    RAISE EXCEPTION 'decision 只能针对 artifact 的当前 revision'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "novel_artifact_decisions_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "novel_artifact_decisions"
  FOR EACH ROW EXECUTE FUNCTION "novel_artifact_decisions_guard"();
