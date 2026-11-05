-- A2-D-B：定稿章节摘要（chapter_summaries）。
--
-- 设计要点（改动前请先读）：
--
-- 1. **派生数据**：摘要只由正式定稿版本产生，不修改章节状态、正式版本、候选、
--    合同或采纳权；也不回写正文。表里没有正文、prompt、模型原始响应或密钥列。
--
-- 2. `UNIQUE(source_version_id)`：每个正式版本最多一条摘要。幂等与并发唯一性
--    都靠它兜底；任务重试命中既有行时直接跳过，不重复调用模型。
--
-- 3. 归属用**复合外键**在数据库层钉死：
--    - (chapter_id, work_id) → chapters(id, work_id)；
--    - (source_version_id, chapter_id, work_id) → chapter_versions(id, chapter_id, work_id)。
--    只用单列外键时，摘要可以挂在版本 A 上却把 chapter / work 指向另一个合法组合，
--    数据库无法拒绝。
--
-- 4. `summary` 长度 1..1000，且 **btrim 后非空**：应用层已 trim，数据库再兜一层，
--    防止绕过服务层写入纯空白摘要。
--
-- 5. **append-only**：UPDATE / DELETE 一律由触发器拒绝。修订摘要必须由新的
--    正式版本重新生成（新 source_version_id → 新行），符合"派生数据可追溯"。
--
-- 6. 不新增 final_version_id：章节"当前定稿版本"仍由"定稿时的最新版本"隐含。

-- ---------------------------------------------------------------------------
-- chapter_summaries：一个正式定稿版本的章节摘要
-- ---------------------------------------------------------------------------
CREATE TABLE "chapter_summaries" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "source_version_id" UUID NOT NULL,
    "agent_name" TEXT NOT NULL,
    "agent_version" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    -- 纯文本摘要（不含 Markdown 标题 / 代码块，由服务层保证）
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "chapter_summaries_pkey" PRIMARY KEY ("id")
);

-- 每个正式版本最多一条摘要：幂等 / 并发的数据库兜底
CREATE UNIQUE INDEX "chapter_summaries_source_version_id_key"
    ON "chapter_summaries"("source_version_id");

CREATE INDEX "chapter_summaries_chapter_id_created_at_idx"
    ON "chapter_summaries"("chapter_id", "created_at");

ALTER TABLE "chapter_summaries" ADD CONSTRAINT "chapter_summaries_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_summaries" ADD CONSTRAINT "chapter_summaries_chapter_work_fkey"
    FOREIGN KEY ("chapter_id", "work_id")
    REFERENCES "chapters"("id", "work_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 摘要必须引用"同一章节、同一作品"的正式版本
ALTER TABLE "chapter_summaries" ADD CONSTRAINT "chapter_summaries_version_fkey"
    FOREIGN KEY ("source_version_id", "chapter_id", "work_id")
    REFERENCES "chapter_versions"("id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 长度与"非空白"兜底（纯空白由服务层拒绝，这里至少挡住空串 / 超长 / 空白串）
ALTER TABLE "chapter_summaries" ADD CONSTRAINT "chapter_summaries_summary_check"
    CHECK (char_length("summary") BETWEEN 1 AND 1000 AND btrim("summary") <> '');

-- ---------------------------------------------------------------------------
-- append-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "chapter_summaries_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'chapter_summaries 不可修改或删除（摘要 append-only）'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chapter_summaries_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "chapter_summaries"
  FOR EACH ROW EXECUTE FUNCTION "chapter_summaries_immutable"();
