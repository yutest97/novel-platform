-- A1-2：单章候选流水线（chapter_contracts / chapter_candidates）。
--
-- 设计要点（改动前请先读）：
--
-- 1. 两张表都**只追加**：合同冻结后不再修改，候选写入后不再修改；
--    采纳为正式版本属于 A1-3（chapter_versions），本轮不建。
--
-- 2. 归属关系用**复合外键**在数据库层钉死：
--    - contract.(chapter_id, work_id) → chapters.(id, work_id)；
--    - contract.(generation_task_id, chapter_id, work_id)
--        → generation_tasks.(id, chapter_id, work_id)；
--    - candidate.(contract_id, generation_task_id, chapter_id, work_id)
--        → contracts.(id, generation_task_id, chapter_id, work_id)。
--    这样"章节属于作品 / 合同属于同一章节与作品 / 候选引用同任务合同"
--    不依赖应用层自觉。
--
-- 3. 每个 generation_task 最多一份合同、一份候选：
--    `UNIQUE(generation_task_id)` 既是幂等键，也是重试复用的入口。
--    同一章节的合同版本号 `UNIQUE(chapter_id, version_no)`，由工作流在
--    作品级 advisory lock 内取 max+1。
--
-- 4. 正文长度有**服务端字数**与**数据库下限**两层：
--    word_count 由服务端按"非空白字符数"统计；数据库只做粗粒度兜底，
--    防止绕过服务层写入明显不合格的正文。

-- ---------------------------------------------------------------------------
-- 复合唯一键：为归属外键提供引用目标
-- ---------------------------------------------------------------------------
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_id_work_id_key"
    UNIQUE ("id", "work_id");

ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_id_chapter_id_work_id_key"
    UNIQUE ("id", "chapter_id", "work_id");

-- ---------------------------------------------------------------------------
-- chapter_contracts：冻结的章节合同
-- ---------------------------------------------------------------------------
CREATE TABLE "chapter_contracts" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "generation_task_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "goal" TEXT NOT NULL,
    "must_include" JSONB NOT NULL,
    "must_not_include" JSONB NOT NULL,
    -- { version: 1, characters: string[], scenes: [...] }
    -- 人物名单与场景节拍同属"计划"，共用这一列，避免为计划再加一张表。
    "scene_beats" JSONB NOT NULL,
    "target_words" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'frozen',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "chapter_contracts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chapter_contracts_chapter_id_version_no_key"
    ON "chapter_contracts"("chapter_id", "version_no");

CREATE UNIQUE INDEX "chapter_contracts_generation_task_id_key"
    ON "chapter_contracts"("generation_task_id");

CREATE INDEX "chapter_contracts_chapter_id_version_no_idx"
    ON "chapter_contracts"("chapter_id", "version_no");

-- 供 candidate 的四列复合外键引用
ALTER TABLE "chapter_contracts" ADD CONSTRAINT "chapter_contracts_identity_key"
    UNIQUE ("id", "generation_task_id", "chapter_id", "work_id");

ALTER TABLE "chapter_contracts" ADD CONSTRAINT "chapter_contracts_status_check"
    CHECK ("status" = 'frozen');

ALTER TABLE "chapter_contracts" ADD CONSTRAINT "chapter_contracts_version_check"
    CHECK ("version_no" >= 1);

ALTER TABLE "chapter_contracts" ADD CONSTRAINT "chapter_contracts_target_words_check"
    CHECK ("target_words" BETWEEN 2500 AND 4000);

ALTER TABLE "chapter_contracts" ADD CONSTRAINT "chapter_contracts_goal_length_check"
    CHECK (char_length("goal") BETWEEN 1 AND 500);

-- 计划是结构化 JSON：数组列必须是数组，scene_beats 必须是对象
ALTER TABLE "chapter_contracts" ADD CONSTRAINT "chapter_contracts_json_shape_check"
    CHECK (
        jsonb_typeof("must_include") = 'array'
        AND jsonb_typeof("must_not_include") = 'array'
        AND jsonb_typeof("scene_beats") = 'object'
    );

ALTER TABLE "chapter_contracts" ADD CONSTRAINT "chapter_contracts_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_contracts" ADD CONSTRAINT "chapter_contracts_chapter_work_fkey"
    FOREIGN KEY ("chapter_id", "work_id")
    REFERENCES "chapters"("id", "work_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_contracts" ADD CONSTRAINT "chapter_contracts_task_chapter_work_fkey"
    FOREIGN KEY ("generation_task_id", "chapter_id", "work_id")
    REFERENCES "generation_tasks"("id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- chapter_candidates：正文候选（不是正式版本）
-- ---------------------------------------------------------------------------
CREATE TABLE "chapter_candidates" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "chapter_id" UUID NOT NULL,
    "generation_task_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "word_count" INTEGER NOT NULL,
    "structured_plan" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "chapter_candidates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chapter_candidates_generation_task_id_key"
    ON "chapter_candidates"("generation_task_id");

CREATE INDEX "chapter_candidates_chapter_id_created_at_idx"
    ON "chapter_candidates"("chapter_id", "created_at");

ALTER TABLE "chapter_candidates" ADD CONSTRAINT "chapter_candidates_status_check"
    CHECK ("status" = 'candidate');

-- 服务端字数下限；数据库再兜一层，防止绕过服务层写入
ALTER TABLE "chapter_candidates" ADD CONSTRAINT "chapter_candidates_word_count_check"
    CHECK ("word_count" >= 1200 AND "word_count" <= char_length("content"));

ALTER TABLE "chapter_candidates" ADD CONSTRAINT "chapter_candidates_content_length_check"
    CHECK (char_length("content") BETWEEN 1200 AND 200000);

ALTER TABLE "chapter_candidates" ADD CONSTRAINT "chapter_candidates_plan_shape_check"
    CHECK (jsonb_typeof("structured_plan") = 'object');

ALTER TABLE "chapter_candidates" ADD CONSTRAINT "chapter_candidates_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_candidates" ADD CONSTRAINT "chapter_candidates_chapter_work_fkey"
    FOREIGN KEY ("chapter_id", "work_id")
    REFERENCES "chapters"("id", "work_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapter_candidates" ADD CONSTRAINT "chapter_candidates_task_fkey"
    FOREIGN KEY ("generation_task_id", "chapter_id", "work_id")
    REFERENCES "generation_tasks"("id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 候选必须引用"同一任务、同一章节、同一作品"的合同
ALTER TABLE "chapter_candidates" ADD CONSTRAINT "chapter_candidates_contract_task_fkey"
    FOREIGN KEY ("contract_id", "generation_task_id", "chapter_id", "work_id")
    REFERENCES "chapter_contracts"("id", "generation_task_id", "chapter_id", "work_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
