-- M2-B1：通用实体骨架 + 玄幻设定中心。
--
-- 新增三张通用表：entities（实体）、entity_attributes（实体属性）、
-- entity_versions（实体版本快照）。
--
-- 明确**不创建**人物、势力、功法、物品、章节或生成任务表 ——
-- 本轮只建立"通用实体"骨架，实体类型由 entity_type 区分。
--
-- 玄幻专属字段定义放在 rule_packages 的 xuanhuan.field_schema 里，
-- **不**写进通用核心表。

-- CreateTable
CREATE TABLE "entities" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order_index" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    -- deleted_at 没有列默认值：软删除只可能由应用层的软删除路径写入，
    -- 而那条路径显式使用数据库时钟 clock_timestamp()，
    -- 保证与 entity_versions.created_at 同口径。
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_attributes" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "attr_key" TEXT NOT NULL,
    "attr_value" JSONB NOT NULL,
    "schema_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "entity_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_versions" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    -- created_at 用 clock_timestamp() 而不是 CURRENT_TIMESTAMP：
    -- 前者是**该行真正落库那一刻**的数据库时钟，后者是事务开始时刻。
    -- 实体写入会在事务里等锁（作品级 advisory lock + 行锁），
    -- 事务开始时刻可能远早于实际写入时刻。
    -- 版本时间戳必须与 deleted_at（同样用数据库时钟）口径一致，
    -- 否则"软删除之后不得再产生新版本"这条不变量无法被可靠观测。
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "entity_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entities_work_id_entity_type_idx" ON "entities"("work_id", "entity_type");

-- 同一作品、同一 entity_type 下，**未删除**实体的名称唯一。
-- 软删除后同名可以重新使用 —— 因此用部分唯一索引，而不是普通唯一约束。
CREATE UNIQUE INDEX "entities_work_id_entity_type_name_key"
    ON "entities"("work_id", "entity_type", "name")
    WHERE "deleted_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "entity_attributes_entity_id_attr_key_schema_ref_key"
    ON "entity_attributes"("entity_id", "attr_key", "schema_ref");

-- CreateIndex
CREATE INDEX "entity_attributes_entity_id_idx" ON "entity_attributes"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_versions_entity_id_version_no_key"
    ON "entity_versions"("entity_id", "version_no");

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_attributes" ADD CONSTRAINT "entity_attributes_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 扩展 xuanhuan 规则包：定义作品方向字段与 realm_level 实体字段。
--
-- 字段的类型、是否必填、标签、顺序与帮助文本都在这里；
-- 玄幻专属内容**只**存在规则包，不进通用核心表。
--
-- 版本口径（M2-B1-REV-01 统一）：
-- - `rule_packages.version` = 规则包（= 字段契约）的版本；
-- - field_schema 里的 `schemaRef` = `${code}@${version}`，与上一条**恒等**；
-- - field_schema.version = 字段契约的整数版本号。
-- 三者必须同时指向同一个契约版本，不得出现 "v2 schema + v1 contract"。
UPDATE "rule_packages"
SET "version" = '2.0.0',
    "field_schema" = '{
  "version": 2,
  "workDirection": {
    "title": "作品方向",
    "schemaRef": "xuanhuan@2.0.0",
    "fields": [
      {
        "key": "subGenre",
        "label": "子类型",
        "type": "string",
        "required": true,
        "maxLength": 60,
        "help": "细分方向，如：东方玄幻、仙侠修真。",
        "order": 1
      },
      {
        "key": "goldenFinger",
        "label": "核心金手指",
        "type": "string",
        "required": true,
        "maxLength": 200,
        "help": "主角的关键机缘或特殊能力。",
        "order": 2
      },
      {
        "key": "toneStyle",
        "label": "语气风格",
        "type": "string",
        "required": false,
        "maxLength": 100,
        "help": "整体叙事语气，如：热血激昂、冷峻克制。",
        "order": 3
      },
      {
        "key": "protagonistPosition",
        "label": "主角定位",
        "type": "string",
        "required": false,
        "maxLength": 100,
        "help": "主角的初始处境与定位，如：废柴逆袭、天才归来。",
        "order": 4
      }
    ]
  },
  "entityTypes": {
    "realm_level": {
      "title": "境界体系",
      "schemaRef": "xuanhuan@2.0.0",
      "fields": [
        {
          "key": "minorLevelCount",
          "label": "小境界数",
          "type": "integer",
          "required": true,
          "min": 1,
          "max": 99,
          "help": "该境界内划分几个小境界。",
          "order": 1
        },
        {
          "key": "breakthroughCondition",
          "label": "突破条件",
          "type": "string",
          "required": true,
          "maxLength": 200,
          "help": "晋阶到下一境界所需的条件。",
          "order": 2
        },
        {
          "key": "lifespan",
          "label": "寿命",
          "type": "string",
          "required": false,
          "maxLength": 60,
          "help": "该境界修士的寿数，如：一千年。",
          "order": 3
        },
        {
          "key": "powerBaseline",
          "label": "战力基准",
          "type": "string",
          "required": false,
          "maxLength": 100,
          "help": "衡量该境界战力的标尺。",
          "order": 4
        },
        {
          "key": "description",
          "label": "说明",
          "type": "text",
          "required": false,
          "maxLength": 500,
          "help": "境界的补充描述。",
          "order": 5
        }
      ]
    }
  }
}'::jsonb,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "code" = 'xuanhuan';
