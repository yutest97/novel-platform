-- A1-3A：正式章节版本（chapter_versions）+ 候选状态受控迁移。
--
-- 设计要点（改动前请先读）：
--
-- 1. `chapter_versions` 是**正式正文**，append-only：
--    `BEFORE UPDATE / DELETE` 一律 `restrict_violation`。修订只能追加新版本，
--    历史版本不可回填 —— 否则"候选采纳"与审计链都失去意义。
--
-- 2. 归属关系用**复合外键**在数据库层钉死（与 A1-2 合同/候选同口径）：
--    - (chapter_id, work_id) → chapters(id, work_id)；
--    - (source_candidate_id, chapter_id, work_id) → chapter_candidates(id, chapter_id, work_id)：
--      来源候选必须属于**同一章节、同一作品**；
--    - (parent_version_id, chapter_id, work_id) → chapter_versions(id, chapter_id, work_id)：
--      父版本必须属于**同一章节、同一作品**。
--    外键列可空（PostgreSQL 默认 MATCH SIMPLE：任一列为 NULL 就不校验），
--    因此人工版本可以没有来源候选、首版可以没有父版本。
--
-- 3. `UNIQUE(chapter_id, version_no)`：版本号在章节内单调唯一。
--    `source_candidate_id` **部分唯一**（WHERE 非空）：一个候选最多生成一个正式版本，
--    这是"重复采纳"幂等的数据库兜底；人工版本（NULL）不受影响。
--
-- 4. 正文长度两层：`word_count` 由服务端按"非空白字符数"统计，
--    数据库校验 `word_count BETWEEN 1200 AND char_length(content)`，
--    并限制 `content` 在 1200..200000 之间。
--
-- 5. 候选状态从 A1-3A 起允许**唯一**一条迁移 `candidate → adopted`：
--    - 除 status 外任何列变化仍旧拒绝；
--    - `adopted → 其它状态` 拒绝；删除始终拒绝；
--    - "adopted 必须有对应正式版本"数据库无法单独保证（先改状态后插版本在
--      同一事务内是合法中间态），这一条由 `adoptChapterCandidate` 的事务边界负责。

-- ---------------------------------------------------------------------------
-- 复合唯一键：为 chapter_versions 的归属外键提供引用目标
-- ---------------------------------------------------------------------------

-- 来源候选必须属于同一章节与作品；需要 (id, chapter_id, work_id) 唯一
ALTER TABLE "chapter_candidates" ADD CONSTRAINT "chapter_candidates_identity_key"
    UNIQUE ("id", "chapter_id", "work_id");

-- ---------------------------------------------------------------------------
-- chapter_versions：正式章节版本
-- ---------------------------------------------------------------------------
CREATE TABLE "chapter_versions" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "word_count" INTEGER NOT NULL,
    -- ai（来自候选采纳）| human（人工撰写，A1-B 才开放写入）
    "source" TEXT NOT NULL,
    "source_candidate_id" UUID,
    "parent_version_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "chapter_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chapter_versions_chapter_id_version_no_key"
    ON "chapter_versions"("chapter_id", "version_no");

-- 一个候选最多生成一个正式版本；NULL（人工版本）不参与唯一性
CREATE UNIQUE INDEX "chapter_versions_source_candidate_id_key"
    ON "chapter_versions"("source_candidate_id")
    WHERE "source_candidate_id" IS NOT NULL;

CREATE INDEX "chapter_versions_chapter_id_version_no_idx"
    ON "chapter_versions"("chapter_id", "version_no");

-- 供自引用复合外键（parent_version_id）引用
ALTER TABLE "chapter_versions" ADD CONSTRAINT "chapter_versions_identity_key"
    UNIQUE ("id", "chapter_id", "work_id");

ALTER TABLE "chapter_versions" ADD CONSTRAINT "chapter_versions_version_no_check"
    CHECK ("version_no" >= 1);

ALTER TABLE "chapter_versions" ADD CONSTRAINT "chapter_versions_source_check"
    CHECK ("source" IN ('ai', 'human'));

-- AI 版本必须有来源候选：正式正文只能来自"候选采纳"或"人工撰写"
ALTER TABLE "chapter_versions" ADD CONSTRAINT "chapter_versions_source_candidate_check"
    CHECK ("source" = 'human' OR "source_candidate_id" IS NOT NULL);

ALTER TABLE "chapter_versions" ADD CONSTRAINT "chapter_versions_content_length_check"
    CHECK (char_length("content") BETWEEN 1200 AND 200000);

-- 服务端字数下限；同时不允许字数超过正文长度（防止绕过服务层写脏数据）
ALTER TABLE "chapter_versions" ADD CONSTRAINT "chapter_versions_word_count_check"
    CHECK ("word_count" >= 1200 AND "word_count" <= char_length("content"));

-- 父版本不能是自己
ALTER TABLE "chapter_versions" ADD CONSTRAINT "chapter_versions_parent_not_self_check"
    CHECK ("parent_version_id" IS DISTINCT FROM "id");

ALTER TABLE "chapter_versions" ADD CONSTRAINT "chapter_versions_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_versions" ADD CONSTRAINT "chapter_versions_chapter_work_fkey"
    FOREIGN KEY ("chapter_id", "work_id")
    REFERENCES "chapters"("id", "work_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_versions" ADD CONSTRAINT "chapter_versions_source_candidate_fkey"
    FOREIGN KEY ("source_candidate_id", "chapter_id", "work_id")
    REFERENCES "chapter_candidates"("id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_versions" ADD CONSTRAINT "chapter_versions_parent_version_fkey"
    FOREIGN KEY ("parent_version_id", "chapter_id", "work_id")
    REFERENCES "chapter_versions"("id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_versions" ADD CONSTRAINT "chapter_versions_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 正式版本 append-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "chapter_versions_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'chapter_versions 不可修改或删除（正式版本 append-only）'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chapter_versions_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "chapter_versions"
  FOR EACH ROW EXECUTE FUNCTION "chapter_versions_immutable"();

-- ---------------------------------------------------------------------------
-- 候选：允许唯一一条状态迁移 candidate -> adopted
-- ---------------------------------------------------------------------------
ALTER TABLE "chapter_candidates" DROP CONSTRAINT "chapter_candidates_status_check";

ALTER TABLE "chapter_candidates" ADD CONSTRAINT "chapter_candidates_status_check"
    CHECK ("status" IN ('candidate', 'adopted'));

CREATE OR REPLACE FUNCTION "chapter_candidates_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chapter_candidates 不可删除'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- 除 status 外任何列变化都拒绝（IS DISTINCT FROM 对 NULL / jsonb 安全）
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."work_id" IS DISTINCT FROM OLD."work_id"
     OR NEW."chapter_id" IS DISTINCT FROM OLD."chapter_id"
     OR NEW."generation_task_id" IS DISTINCT FROM OLD."generation_task_id"
     OR NEW."contract_id" IS DISTINCT FROM OLD."contract_id"
     OR NEW."content" IS DISTINCT FROM OLD."content"
     OR NEW."word_count" IS DISTINCT FROM OLD."word_count"
     OR NEW."structured_plan" IS DISTINCT FROM OLD."structured_plan"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'chapter_candidates 只允许 candidate → adopted 的状态迁移'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- 状态没变（等价于一次纯 UPDATE）也拒绝
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'chapter_candidates 不可修改'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT (OLD."status" = 'candidate' AND NEW."status" = 'adopted') THEN
    RAISE EXCEPTION 'chapter_candidates 只允许 candidate → adopted 的状态迁移'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 触发器本身不变（BEFORE UPDATE OR DELETE，FOR EACH ROW）；
-- CREATE OR REPLACE FUNCTION 已替换实现，这里无需重建触发器。
