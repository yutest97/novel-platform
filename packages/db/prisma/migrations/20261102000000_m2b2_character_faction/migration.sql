-- M2-B2：规则包升级到 xuanhuan@3.0.0（新增 faction / character）
--
-- 版本口径（沿用 M2-B1-REV-01 的约定，不得漂移）：
-- - `rule_packages.version` = 规则包（= 字段契约）的版本；
-- - field_schema 里每个字段组的 `schemaRef` = `${code}@${version}`，与上一条**恒等**；
-- - field_schema.version = 字段契约的整数版本号。
-- 本次三者同时指向 3.0.0 / 3。
--
-- 本轮只新增 `faction`（势力）与 `character`（人物）两类实体字段，
-- **不**新增 item / technique / location / 资源流水 / 时间线 / 伏笔 / 关系图表，
-- 也不改变通用核心表的 DDL —— 玄幻专属内容只存在于规则包。

UPDATE "rule_packages"
SET "version" = '3.0.0',
    "field_schema" = '{
  "version": 3,
  "workDirection": {
    "title": "作品方向",
    "schemaRef": "xuanhuan@3.0.0",
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
      "schemaRef": "xuanhuan@3.0.0",
      "order": 1,
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
    },
    "faction": {
      "title": "势力",
      "schemaRef": "xuanhuan@3.0.0",
      "order": 2,
      "fields": [
        {
          "key": "type",
          "label": "势力类型",
          "type": "enum",
          "required": true,
          "order": 1,
          "options": [
            { "value": "sect", "label": "宗门" },
            { "value": "family", "label": "家族" },
            { "value": "dynasty", "label": "王朝" },
            { "value": "alliance", "label": "联盟" },
            { "value": "guild", "label": "商盟" },
            { "value": "other", "label": "其他" }
          ],
          "help": "势力所属的组织形态。"
        },
        {
          "key": "tier",
          "label": "层级",
          "type": "string",
          "required": false,
          "maxLength": 60,
          "help": "如：一流、二流、末流。",
          "order": 2
        },
        {
          "key": "headquarters",
          "label": "驻地",
          "type": "string",
          "required": false,
          "maxLength": 100,
          "order": 3
        },
        {
          "key": "powerRating",
          "label": "实力评级",
          "type": "string",
          "required": false,
          "maxLength": 60,
          "order": 4
        },
        {
          "key": "allies",
          "label": "盟友",
          "type": "entityRefs",
          "refType": "faction",
          "required": false,
          "maxItems": 50,
          "order": 5
        },
        {
          "key": "enemies",
          "label": "敌对",
          "type": "entityRefs",
          "refType": "faction",
          "required": false,
          "maxItems": 50,
          "order": 6
        },
        {
          "key": "description",
          "label": "说明",
          "type": "text",
          "required": false,
          "maxLength": 1000,
          "order": 7
        }
      ]
    },
    "character": {
      "title": "人物",
      "schemaRef": "xuanhuan@3.0.0",
      "order": 3,
      "fields": [
        {
          "key": "identity",
          "label": "身份",
          "type": "string",
          "required": false,
          "maxLength": 100,
          "order": 1
        },
        {
          "key": "personality",
          "label": "性格",
          "type": "text",
          "required": false,
          "maxLength": 500,
          "order": 2
        },
        {
          "key": "goal",
          "label": "目标",
          "type": "text",
          "required": false,
          "maxLength": 500,
          "order": 3
        },
        {
          "key": "secret",
          "label": "秘密",
          "type": "text",
          "required": false,
          "maxLength": 1000,
          "help": "仅作设定记录；不会写入审计日志。",
          "order": 4
        },
        {
          "key": "secretKnownBy",
          "label": "谁知道这个秘密",
          "type": "entityRefs",
          "refType": "character",
          "required": false,
          "maxItems": 50,
          "help": "仅表示设定层「谁知道」，不代表事实级认知模型。",
          "order": 5
        },
        {
          "key": "initialRealm",
          "label": "初始境界",
          "type": "entityRef",
          "refType": "realm_level",
          "required": false,
          "order": 6
        },
        {
          "key": "faction",
          "label": "所属势力",
          "type": "entityRef",
          "refType": "faction",
          "required": false,
          "order": 7
        }
      ]
    }
  }
}'::jsonb,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "code" = 'xuanhuan';

-- 存量设定：把**当前契约**（2.0.0）统一到 3.0.0，作者已保存的数据不会消失。
--
-- 两条关键约束：
-- 1. **只动 2.0.0**：`xuanhuan@1.0.0` 是 M2-A 时代的历史契约行，
--    升级前后都不可见，本轮保持原样 —— 不迁移、不删除、不重新暴露。
-- 2. **不需要 DELETE 合并**：唯一索引是 (work_id, setting_key, schema_ref) /
--    (entity_id, attr_key, schema_ref)。某键若同时存在 1.0.0 与 2.0.0 两行，
--    把 2.0.0 改成 3.0.0 后组合变成 1.0.0 + 3.0.0，**不会冲突**，
--    所以可以原地更新，无需删任何行。
UPDATE "work_settings"
   SET "schema_ref" = 'xuanhuan@3.0.0',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "schema_ref" = 'xuanhuan@2.0.0';

UPDATE "entity_attributes"
   SET "schema_ref" = 'xuanhuan@3.0.0',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "schema_ref" = 'xuanhuan@2.0.0';
