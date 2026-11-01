/**
 * M2-B2-A-REV-01：规则包字段契约校验。
 *
 * 解析器是宽松的（不认识就丢掉），所以坏规则包会表现为
 * "schema 看起来正常、但缺了 enum 选项 / 引用类型"，
 * 作者既看不到正确选项，写入也会被静默忽略。
 * 因此必须在**读取规则包之后、任何业务判断之前**直接失败（INVALID_RULE_PACKAGE）。
 *
 * 本文件分两部分：
 * 1. 纯函数单元测试（`assertFieldSchemaContract` 的每一条规则）；
 * 2. 隔离库集成测试：真的把 xuanhuan 规则包改坏，
 *    验证 GET 设定中心与写入实体都被拒绝，恢复后又能正常工作。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertFieldSchemaContract, createEntity, getSettingsCenter } from '../src/index.js';
import { createDbBeforeMigration, type UpgradeDb } from './helpers/upgrade-db.js';

const META = { ip: '203.0.113.82', userAgent: 'vitest' };

/** 可变的最小 schema 结构（方便在用例里改坏某一处）。 */
interface MutableField {
  [key: string]: unknown;
}

interface MutableGroup {
  title: string;
  schemaRef: string;
  order: number;
  fields: MutableField[];
}

interface MutableSchema {
  version: number;
  entityTypes: Record<string, MutableGroup>;
}

/** 一份形状正确的最小 v3 schema。 */
function validSchema(): MutableSchema {
  return {
    version: 3,
    entityTypes: {
      realm_level: {
        title: '境界体系',
        schemaRef: 'xuanhuan@3.0.0',
        order: 1,
        fields: [{ key: 'lifespan', label: '寿命', type: 'string', required: false, order: 1 }],
      },
      faction: {
        title: '势力',
        schemaRef: 'xuanhuan@3.0.0',
        order: 2,
        fields: [
          {
            key: 'type',
            label: '势力类型',
            type: 'enum',
            required: true,
            order: 1,
            options: [
              { value: 'sect', label: '宗门' },
              { value: 'family', label: '家族' },
            ],
          },
          {
            key: 'allies',
            label: '盟友',
            type: 'entityRefs',
            required: false,
            order: 2,
            refType: 'faction',
            maxItems: 10,
          },
        ],
      },
      character: {
        title: '人物',
        schemaRef: 'xuanhuan@3.0.0',
        order: 3,
        fields: [
          {
            key: 'initialRealm',
            label: '初始境界',
            type: 'entityRef',
            required: false,
            order: 1,
            refType: 'realm_level',
          },
        ],
      },
    },
  };
}

/** 断言校验抛出 INVALID_RULE_PACKAGE。 */
function expectContractError(schema: unknown): void {
  try {
    assertFieldSchemaContract(schema);
  } catch (error) {
    expect(error).toMatchObject({ code: 'INVALID_RULE_PACKAGE' });
    return;
  }
  throw new Error('坏规则包必须抛出 INVALID_RULE_PACKAGE');
}

describe('M2-B2-A-REV-01 规则包字段契约（纯校验）', () => {
  it('形状正确的 v3 schema 通过', () => {
    expect(() => assertFieldSchemaContract(validSchema())).not.toThrow();
  });

  it('enum 的 options 缺失或为空都按坏规则包处理', () => {
    const missing = validSchema();
    missing.entityTypes['faction']!.fields[0] = {
      key: 'type',
      label: '势力类型',
      type: 'enum',
      required: true,
      order: 1,
    };
    expectContractError(missing);

    const empty = validSchema();
    empty.entityTypes['faction']!.fields[0] = {
      key: 'type',
      label: '势力类型',
      type: 'enum',
      required: true,
      order: 1,
      options: [],
    };
    expectContractError(empty);
  });

  it('enum 的 value 重复按坏规则包处理', () => {
    const schema = validSchema();
    schema.entityTypes['faction']!.fields[0] = {
      key: 'type',
      label: '势力类型',
      type: 'enum',
      required: true,
      order: 1,
      options: [
        { value: 'sect', label: '宗门' },
        { value: 'sect', label: '家族' },
      ],
    };
    expectContractError(schema);
  });

  it('entityRef / entityRefs 缺少 refType 按坏规则包处理', () => {
    const ref = validSchema();
    ref.entityTypes['character']!.fields[0] = {
      key: 'initialRealm',
      label: '初始境界',
      type: 'entityRef',
      order: 1,
    };
    expectContractError(ref);

    const refs = validSchema();
    refs.entityTypes['faction']!.fields[1] = {
      key: 'allies',
      label: '盟友',
      type: 'entityRefs',
      order: 2,
    };
    expectContractError(refs);
  });

  it('refType 未在 entityTypes 中声明按坏规则包处理', () => {
    const schema = validSchema();
    schema.entityTypes['character']!.fields[0] = {
      key: 'initialRealm',
      label: '初始境界',
      type: 'entityRef',
      order: 1,
      refType: 'item',
    };
    expectContractError(schema);
  });

  it('entityRefs 的 maxItems 必须是正整数', () => {
    for (const maxItems of [0, -1, 1.5, '10']) {
      const schema = validSchema();
      schema.entityTypes['faction']!.fields[1] = {
        key: 'allies',
        label: '盟友',
        type: 'entityRefs',
        order: 2,
        refType: 'faction',
        maxItems,
      };
      expectContractError(schema);
    }
  });

  it('未知字段类型按坏规则包处理（不能被静默丢弃）', () => {
    const schema = validSchema();
    schema.entityTypes['character']!.fields[0] = {
      key: 'initialRealm',
      label: '初始境界',
      type: 'unknown',
      order: 1,
    };
    expectContractError(schema);
  });
});

/**
 * 集成测试：直接改库里的规则包。
 * 用隔离库，避免污染共享测试库；每个用例结束都会恢复原 schema。
 */
describe('M2-B2-A-REV-01 规则包坏数据：GET 设定中心与写入实体都失败', () => {
  let handle: UpgradeDb;
  let original: string;
  let authorId: string;
  let workId: string;

  beforeAll(async () => {
    // '9999' 大于所有迁移目录名 → 全部应用
    handle = await createDbBeforeMigration('m2b2-contract', '9999');

    const snapshot = await handle.raw.query<{ schema: string }>(
      `SELECT field_schema::text AS schema FROM rule_packages WHERE code = 'xuanhuan'`,
    );
    original = snapshot.rows[0]!.schema;

    const user = await handle.db.user.create({
      data: {
        email: `contract-${Date.now().toString(36)}@example.test`,
        passwordHash: '$argon2id$stub',
        role: 'author',
        status: 'active',
        mustChangePassword: false,
      },
    });
    authorId = user.id;
    const work = await handle.db.work.create({
      data: { authorId, title: '坏规则包作品', genreRulePackage: 'xuanhuan' },
    });
    workId = work.id;
  }, 60_000);

  afterAll(async () => {
    await handle?.dispose();
  }, 60_000);

  /** 恢复规则包原文（每个用例结束必须调用）。 */
  async function restore(): Promise<void> {
    await handle.raw.query(
      `UPDATE rule_packages SET field_schema = $1::jsonb WHERE code = 'xuanhuan'`,
      [original],
    );
  }

  /**
   * 把某个字段组里指定字段替换成 `expression` 的结果。
   *
   * `expression` 是对 `f`（该字段的 jsonb）的 SQL 表达式，
   * 路径与字段名通过参数传入，避免拼接。
   */
  async function patchField(groupKey: string, fieldKey: string, expression: string): Promise<void> {
    await handle.raw.query(
      `UPDATE rule_packages
          SET field_schema = jsonb_set(
                field_schema,
                $1::text[],
                (
                  SELECT jsonb_agg(CASE WHEN f->>'key' = $2 THEN ${expression} ELSE f END ORDER BY ord)
                    FROM jsonb_array_elements(field_schema #> $1::text[])
                         WITH ORDINALITY AS t(f, ord)
                )
              )
        WHERE code = 'xuanhuan'`,
      [`{entityTypes,${groupKey},fields}`, fieldKey],
    );
  }

  it('faction.type 的 options 清空：GET settings 与写入实体都 INVALID_RULE_PACKAGE', async () => {
    try {
      await patchField('faction', 'type', `jsonb_set(f, '{options}', '[]'::jsonb)`);

      await expect(getSettingsCenter(handle.db, { workId, authorId })).rejects.toMatchObject({
        code: 'INVALID_RULE_PACKAGE',
      });

      await expect(
        createEntity(handle.db, {
          workId,
          authorId,
          entityType: 'faction',
          name: '青云宗',
          attributes: { type: 'sect' },
          meta: META,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_RULE_PACKAGE' });

      // 没有落任何数据
      expect(await handle.db.entity.count({ where: { workId } })).toBe(0);
    } finally {
      await restore();
    }

    // 恢复后立刻可用（证明失败来自规则包坏数据，而不是环境问题）
    const center = await getSettingsCenter(handle.db, { workId, authorId });
    expect(center.entityGroups.map((group) => group.entityType)).toEqual([
      'realm_level',
      'faction',
      'character',
      'item',
      'technique',
    ]);
    await expect(
      createEntity(handle.db, {
        workId,
        authorId,
        entityType: 'faction',
        name: '青云宗',
        attributes: { type: 'sect' },
        meta: META,
      }),
    ).resolves.toMatchObject({ entityType: 'faction' });
  });

  it('character.initialRealm 的 refType 被删除：GET settings 与写入实体都 INVALID_RULE_PACKAGE', async () => {
    try {
      await patchField('character', 'initialRealm', `f - 'refType'`);

      await expect(getSettingsCenter(handle.db, { workId, authorId })).rejects.toMatchObject({
        code: 'INVALID_RULE_PACKAGE',
      });

      await expect(
        createEntity(handle.db, {
          workId,
          authorId,
          entityType: 'character',
          name: '林青',
          attributes: { identity: '弟子' },
          meta: META,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_RULE_PACKAGE' });
    } finally {
      await restore();
    }

    const center = await getSettingsCenter(handle.db, { workId, authorId });
    // schema 摘要是"定义清单"，顺序来自 jsonb 对象键序；
    // 这里只关心三类都在（分组顺序由 entityGroups 保证，见上一个用例）
    expect(center.schema.entityTypes.map((item) => item.key).sort()).toEqual([
      'character',
      'faction',
      'item',
      'realm_level',
      'technique',
    ]);
  });

  it('faction.allies 的 maxItems 退化为 0：GET settings 与写入实体都 INVALID_RULE_PACKAGE', async () => {
    try {
      await patchField('faction', 'allies', `jsonb_set(f, '{maxItems}', '0'::jsonb)`);

      await expect(getSettingsCenter(handle.db, { workId, authorId })).rejects.toMatchObject({
        code: 'INVALID_RULE_PACKAGE',
      });

      await expect(
        createEntity(handle.db, {
          workId,
          authorId,
          entityType: 'faction',
          name: '天音寺',
          attributes: { type: 'sect' },
          meta: META,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_RULE_PACKAGE' });
    } finally {
      await restore();
    }

    await expect(getSettingsCenter(handle.db, { workId, authorId })).resolves.toBeDefined();
  });
});
