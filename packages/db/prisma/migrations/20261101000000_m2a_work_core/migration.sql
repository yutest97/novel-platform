-- M2-A：作品核心。
--
-- 新增三张表：rule_packages（题材规则包）、works（小说作品）、
-- work_settings（作品设定）。
--
-- 明确**不创建**章节、场景、人物、境界、势力、时间线、事实等业务表，
-- 也不创建任何模型调用相关表。
--
-- 数据隔离：works.author_id 指向 users.id，且 (author_id, title) 唯一；
-- 所有查询都带 author_id 条件，数据库层面无法跨作者读取。

-- CreateTable
CREATE TABLE "rule_packages" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "field_schema" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rule_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "works" (
    "id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "genre_rule_package" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "target_chapters" INTEGER NOT NULL DEFAULT 10,
    "target_words_per_chapter" INTEGER NOT NULL DEFAULT 3000,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "works_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_settings" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "setting_key" TEXT NOT NULL,
    "setting_value" JSONB NOT NULL,
    "schema_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "work_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rule_packages_code_key" ON "rule_packages"("code");

-- CreateIndex
CREATE UNIQUE INDEX "works_author_id_title_key" ON "works"("author_id", "title");

-- CreateIndex
CREATE INDEX "works_author_id_updated_at_idx" ON "works"("author_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "work_settings_work_id_setting_key_schema_ref_key" ON "work_settings"("work_id", "setting_key", "schema_ref");

-- CreateIndex
CREATE INDEX "work_settings_work_id_idx" ON "work_settings"("work_id");

-- AddForeignKey
ALTER TABLE "works" ADD CONSTRAINT "works_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "works" ADD CONSTRAINT "works_genre_rule_package_fkey" FOREIGN KEY ("genre_rule_package") REFERENCES "rule_packages"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_settings" ADD CONSTRAINT "work_settings_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 最小 xuanhuan 规则包（幂等）。
--
-- field_schema 故意保持最小：玄幻专属字段属于后续阶段，且一律放在
-- work_settings 里，**不**进入 works 的固定列。
INSERT INTO "rule_packages" ("id", "code", "name", "version", "active", "field_schema", "created_at", "updated_at")
VALUES (
    '00000000-0000-4000-8000-000000000001',
    'xuanhuan',
    '玄幻升级',
    '1.0.0',
    true,
    '{"version":1,"sections":[],"note":"最小版本：玄幻字段将在后续阶段加入 work_settings，不进入 works 固定列"}'::jsonb,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO NOTHING;
