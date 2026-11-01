-- M2-B3-A：规则包升级到 xuanhuan@4.0.0（新增 item / technique）
--
-- 版本口径（沿用 M2-B1-REV-01 的约定，不得漂移）：
-- - `rule_packages.version` = 规则包（= 字段契约）的版本；
-- - field_schema 里每个字段组的 `schemaRef` = `${code}@${version}`，与上一条**恒等**；
-- - field_schema.version = 字段契约的整数版本号。
-- 本次三者同时指向 4.0.0 / 4。
--
-- 本轮只新增 `item`（物品）与 `technique`（功法）两类实体字段：
-- - 复用 entities / entity_attributes / entity_versions 通用骨架，**没有任何 DDL 变更**；
-- - `item` **不含 holder 字段**：物品持有人以 B3-B 的 item_events 流水为唯一真相，
--   本轮不提供可编辑的持有人属性；
-- - `technique.realmRequirement` 是 entityRef → realm_level，删除被引用的境界会被拒绝。
--
-- 不建 item_events、不实现资源流水（F-WRK-08）、章节与事实回放。

UPDATE "rule_packages"
SET "version" = '4.0.0',
    "field_schema" = '{
  "version": 4,
  "workDirection": {
    "title": "作品方向",
    "schemaRef": "xuanhuan@4.0.0",
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
      "schemaRef": "xuanhuan@4.0.0",
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
      "schemaRef": "xuanhuan@4.0.0",
      "order": 2,
      "fields": [
        {
          "key": "type",
          "label": "势力类型",
          "type": "enum",
          "required": true,
          "order": 1,
          "options": [
            {
              "value": "sect",
              "label": "宗门"
            },
            {
              "value": "family",
              "label": "家族"
            },
            {
              "value": "dynasty",
              "label": "王朝"
            },
            {
              "value": "alliance",
              "label": "联盟"
            },
            {
              "value": "guild",
              "label": "商盟"
            },
            {
              "value": "other",
              "label": "其他"
            }
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
      "schemaRef": "xuanhuan@4.0.0",
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
    },
    "item": {
      "title": "物品",
      "schemaRef": "xuanhuan@4.0.0",
      "order": 4,
      "fields": [
        {
          "key": "category",
          "label": "类别",
          "type": "enum",
          "required": true,
          "order": 1,
          "options": [
            {
              "value": "weapon",
              "label": "武器"
            },
            {
              "value": "armor",
              "label": "防具"
            },
            {
              "value": "pill",
              "label": "丹药"
            },
            {
              "value": "talisman",
              "label": "符箓"
            },
            {
              "value": "artifact",
              "label": "法宝"
            },
            {
              "value": "material",
              "label": "材料"
            },
            {
              "value": "consumable",
              "label": "消耗品"
            },
            {
              "value": "other",
              "label": "其他"
            }
          ],
          "help": "物品所属门类。"
        },
        {
          "key": "quality",
          "label": "品质",
          "type": "enum",
          "required": true,
          "order": 2,
          "options": [
            {
              "value": "mortal",
              "label": "凡品"
            },
            {
              "value": "spirit",
              "label": "灵品"
            },
            {
              "value": "mystic",
              "label": "玄品"
            },
            {
              "value": "earth",
              "label": "地品"
            },
            {
              "value": "heaven",
              "label": "天品"
            },
            {
              "value": "immortal",
              "label": "仙品"
            }
          ]
        },
        {
          "key": "acquisition",
          "label": "获取方式",
          "type": "text",
          "required": false,
          "maxLength": 500,
          "order": 3,
          "help": "如何得到：宗门赐予、秘境所得、他人赠予……"
        },
        {
          "key": "description",
          "label": "说明",
          "type": "text",
          "required": false,
          "maxLength": 1000,
          "order": 4
        }
      ]
    },
    "technique": {
      "title": "功法",
      "schemaRef": "xuanhuan@4.0.0",
      "order": 5,
      "fields": [
        {
          "key": "type",
          "label": "功法类型",
          "type": "enum",
          "required": true,
          "order": 1,
          "options": [
            {
              "value": "cultivation",
              "label": "功法"
            },
            {
              "value": "martial",
              "label": "武技"
            },
            {
              "value": "secret",
              "label": "秘术"
            },
            {
              "value": "divine",
              "label": "神通"
            },
            {
              "value": "innate",
              "label": "天赋"
            },
            {
              "value": "other",
              "label": "其他"
            }
          ]
        },
        {
          "key": "realmRequirement",
          "label": "境界门槛",
          "type": "entityRef",
          "refType": "realm_level",
          "required": false,
          "order": 2,
          "help": "修习该功法所需的最低境界。"
        },
        {
          "key": "effect",
          "label": "效果",
          "type": "text",
          "required": false,
          "maxLength": 1000,
          "order": 3
        },
        {
          "key": "sideEffect",
          "label": "副作用",
          "type": "text",
          "required": false,
          "maxLength": 1000,
          "order": 4
        },
        {
          "key": "description",
          "label": "说明",
          "type": "text",
          "required": false,
          "maxLength": 1000,
          "order": 5
        }
      ]
    }
  }
}'::jsonb,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "code" = 'xuanhuan';

-- 存量设定：把**当前契约**（3.0.0）统一到 4.0.0，作者已保存的数据不会消失。
--
-- 1. **只动 3.0.0**：`xuanhuan@1.0.0`（M2-A）与 `xuanhuan@2.0.0`（M2-B1）是历史契约行，
--    升级前后都不可见，本轮保持原样 —— 不迁移、不删除、不重新暴露。
-- 2. **不需要 DELETE 合并**：唯一索引含 schema_ref，某键若同时存在 1.0.0 / 2.0.0 与 3.0.0，
--    把 3.0.0 改成 4.0.0 后组合变成 1.0.0 + 2.0.0 + 4.0.0，**不会冲突**。
UPDATE "work_settings"
   SET "schema_ref" = 'xuanhuan@4.0.0',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "schema_ref" = 'xuanhuan@3.0.0';

UPDATE "entity_attributes"
   SET "schema_ref" = 'xuanhuan@4.0.0',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "schema_ref" = 'xuanhuan@3.0.0';
