-- A2-F-A：事实候选决策记录（chapter_fact_decisions）。
--
-- 设计要点（改动前请先读）：
--
-- 1. 只记录作者对**成功 run 的候选**的终态决定（accepted / rejected），
--    **不写回任何实体或物品事件**：本迁移不修改 entities / entity_attributes /
--    entity_relations / item_events / chapters / chapter_versions 的任何列。
--
-- 2. 归属用**复合外键**在数据库层钉死：
--    - (chapter_id, work_id) → chapters(id, work_id)；
--    - (source_version_id, chapter_id, work_id) → chapter_versions(id, chapter_id, work_id)；
--    - `(candidate_id, source_version_id, chapter_id, work_id)` →
--      `chapter_fact_candidates(id, source_version_id, chapter_id, work_id)`。
--    最后一条让"决定指向候选 A、却把版本/章节/作品写成另一个合法组合"直接被拒绝。
--    为了让这条外键可建立，需要先给 candidates 增加身份唯一键
--    （id 已是主键，因此是冗余但必需的约束，与 runs / review_runs 的做法一致）。
--
-- 3. `UNIQUE(candidate_id)`：每个候选最多一条决定。
--    - 同决定重复提交 → 服务层返回 deduplicated=true（不写审计）；
--    - 不同决定 → 409 `CONTINUITY_FACT_ALREADY_DECIDED`，**不翻转**（不提供改判）。
--
-- 4. **append-only**：UPDATE / DELETE 一律由触发器拒绝。
--    撤销 / 改判是独立的产品能力，不在本阶段。
--
-- 5. 不保存正文、payload 副本、prompt、模型原始响应或密钥：表里没有这些列。
--
-- 6. 测试清理沿用受控 `ALTER TABLE ... DISABLE TRIGGER USER` 策略。

-- ---------------------------------------------------------------------------
-- 候选身份键：供 decisions 的复合外键引用
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "chapter_fact_candidates_identity_key"
    ON "chapter_fact_candidates"("id", "source_version_id", "chapter_id", "work_id");

-- ---------------------------------------------------------------------------
-- chapter_fact_decisions：作者对候选的终态决定
-- ---------------------------------------------------------------------------
CREATE TABLE "chapter_fact_decisions" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "source_version_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    -- accepted | rejected
    "decision" TEXT NOT NULL,
    "decided_by" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "chapter_fact_decisions_pkey" PRIMARY KEY ("id")
);

-- 一个候选最多一条决定：幂等 / 并发唯一性的数据库兜底
CREATE UNIQUE INDEX "chapter_fact_decisions_candidate_id_key"
    ON "chapter_fact_decisions"("candidate_id");

CREATE INDEX "chapter_fact_decisions_chapter_id_decided_at_idx"
    ON "chapter_fact_decisions"("chapter_id", "decided_at");

ALTER TABLE "chapter_fact_decisions" ADD CONSTRAINT "chapter_fact_decisions_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_fact_decisions" ADD CONSTRAINT "chapter_fact_decisions_chapter_work_fkey"
    FOREIGN KEY ("chapter_id", "work_id")
    REFERENCES "chapters"("id", "work_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_fact_decisions" ADD CONSTRAINT "chapter_fact_decisions_version_fkey"
    FOREIGN KEY ("source_version_id", "chapter_id", "work_id")
    REFERENCES "chapter_versions"("id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 复合候选外键：决定必须与候选属于同一作品 / 章节 / 版本
ALTER TABLE "chapter_fact_decisions" ADD CONSTRAINT "chapter_fact_decisions_candidate_fkey"
    FOREIGN KEY ("candidate_id", "source_version_id", "chapter_id", "work_id")
    REFERENCES "chapter_fact_candidates"("id", "source_version_id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_fact_decisions" ADD CONSTRAINT "chapter_fact_decisions_decided_by_fkey"
    FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_fact_decisions" ADD CONSTRAINT "chapter_fact_decisions_decision_check"
    CHECK ("decision" IN ('accepted', 'rejected'));

-- ---------------------------------------------------------------------------
-- decisions：append-only（不接受改判 / 撤销）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "chapter_fact_decisions_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'chapter_fact_decisions 不可修改或删除（决策 append-only）'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chapter_fact_decisions_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "chapter_fact_decisions"
  FOR EACH ROW EXECUTE FUNCTION "chapter_fact_decisions_immutable"();
