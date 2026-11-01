/**
 * M2-B2：多实体类型（realm_level / faction / character）与引用体系。
 *
 * 覆盖：
 * - schema 解析与校验（enum / entityRef / entityRefs）；
 * - 引用的写校验：存在、未删除、同作品、类型一致、禁自引用、去重、上限；
 * - 三类 CRUD 与**每类型独立**的排序集合；
 * - 删除保护的范围：只看当前契约的引用字段，不看自由文本/旧契约/已删引用者；
 * - 设定中心 entityGroups DTO；
 * - 作品隔离。
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createEntity,
  deleteEntity,
  getSettingsCenter,
  listEntities,
  parseRuleFieldSchema,
  reorderEntities,
  updateEntity,
  validateFields,
} from '../src/index.js';
import { closeTestDb, testDb, uniqueEmail } from './helpers/db.js';
import { createDbBeforeMigration, type UpgradeDb } from './helpers/upgrade-db.js';

const META = { ip: '203.0.113.71', userAgent: 'vitest' };

async function createAuthor(): Promise<{ id: string }> {
  const db = testDb();
  const user = await db.user.create({
    data: {
      email: uniqueEmail('m2b2'),
      passwordHash: '$argon2id$stub',
      role: 'author',
      status: 'active',
      mustChangePassword: false,
    },
  });
  return { id: user.id };
}

async function createWork(authorId: string): Promise<string> {
  const db = testDb();
  const work = await db.work.create({
    data: { authorId, title: `B2作品-${uniqueEmail('t')}`, genreRulePackage: 'xuanhuan' },
  });
  return work.id;
}

function realmAttributes(): Record<string, unknown> {
  return { minorLevelCount: 9, breakthroughCondition: '引气入体', lifespan: '一百年' };
}

function factionAttributes(type = 'sect'): Record<string, unknown> {
  return { type, tier: '一流', headquarters: '青云山' };
}

describe('M2-B2 多实体类型与引用', () => {
  beforeAll(() => {
    testDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  /* ---------------------------------------------------------------- *
   * schema：解析与纯校验
   * ---------------------------------------------------------------- */

  it('规则包 v3 声明了 realm_level / faction / character，且三类 schemaRef 恒等', async () => {
    const db = testDb();
    const rulePackage = await db.rulePackage.findUniqueOrThrow({ where: { code: 'xuanhuan' } });
    const schema = parseRuleFieldSchema(rulePackage.fieldSchema);

    expect(rulePackage.version).toBe('3.0.0');
    expect(schema.version).toBe(3);
    expect(Object.keys(schema.entityTypes ?? {}).sort()).toEqual([
      'character',
      'faction',
      'realm_level',
    ]);
    for (const group of Object.values(schema.entityTypes ?? {})) {
      expect(group.schemaRef).toBe('xuanhuan@3.0.0');
    }
    expect(schema.entityTypes?.['faction']?.order).toBe(2);
    expect(schema.entityTypes?.['character']?.order).toBe(3);
  });

  it('enum 选项来自规则包：入库值是 value，非法值一律 400', async () => {
    const db = testDb();
    const rulePackage = await db.rulePackage.findUniqueOrThrow({ where: { code: 'xuanhuan' } });
    const faction = parseRuleFieldSchema(rulePackage.fieldSchema).entityTypes?.['faction'];
    expect(faction).toBeDefined();

    const typeField = faction?.fields.find((field) => field.key === 'type');
    expect(typeField?.type).toBe('enum');
    expect(typeField?.options?.map((option) => option.value)).toEqual([
      'sect',
      'family',
      'dynasty',
      'alliance',
      'guild',
      'other',
    ]);
    // 展示用 label 是中文
    expect(typeField?.options?.[0]).toEqual({ value: 'sect', label: '宗门' });

    expect(validateFields(faction!, { type: 'sect' })).toEqual({ type: 'sect' });
    expect(() => validateFields(faction!, { type: '宗门' })).toThrowError(/取值不在允许范围内/);
    expect(() => validateFields(faction!, {})).toThrowError(/缺少必填字段/);
  });

  it('entityRef 必须是 UUID；entityRefs 重复/超限/非 UUID 都 400，空数组表示清空', async () => {
    const db = testDb();
    const rulePackage = await db.rulePackage.findUniqueOrThrow({ where: { code: 'xuanhuan' } });
    const character = parseRuleFieldSchema(rulePackage.fieldSchema).entityTypes?.['character'];
    expect(character).toBeDefined();

    const uuid = randomUUID();
    expect(validateFields(character!, { initialRealm: uuid })).toEqual({ initialRealm: uuid });
    expect(() => validateFields(character!, { initialRealm: 'not-a-uuid' })).toThrowError(
      /必须是实体 id/,
    );

    // 重复不静默去重
    expect(() => validateFields(character!, { secretKnownBy: [uuid, uuid] })).toThrowError(
      /存在重复项/,
    );
    // 超过统一硬上限 50
    const tooMany = Array.from({ length: 51 }, () => randomUUID());
    expect(() => validateFields(character!, { secretKnownBy: tooMany })).toThrowError(/最多 50 项/);
    // 空数组 = 清空
    expect(validateFields(character!, { secretKnownBy: [] })).toEqual({});
    // 数组元素必须是 UUID
    expect(() => validateFields(character!, { secretKnownBy: ['x'] })).toThrowError(
      /必须是实体 id 数组/,
    );
  });

  /* ---------------------------------------------------------------- *
   * 引用写校验
   * ---------------------------------------------------------------- */

  it('引用校验：存在、未删除、同作品、类型一致；跨作品与不存在文案一致', async () => {
    const db = testDb();
    const author = await createAuthor();
    const other = await createAuthor();
    const workId = await createWork(author.id);
    const otherWorkId = await createWork(other.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'realm_level',
      name: '炼气',
      attributes: realmAttributes(),
      meta: META,
    });
    const otherRealm = await createEntity(db, {
      workId: otherWorkId,
      authorId: other.id,
      entityType: 'realm_level',
      name: '别人的境界',
      attributes: realmAttributes(),
      meta: META,
    });

    // 1) 正常引用
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'character',
        name: '林青',
        attributes: { initialRealm: realm.id },
        meta: META,
      }),
    ).resolves.toMatchObject({ entityType: 'character' });

    // 2) 不存在
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'character',
        name: '甲',
        attributes: { initialRealm: randomUUID() },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 3) 跨作品：文案必须与"不存在"一致，不能泄露存在性
    const crossWork = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'character',
      name: '乙',
      attributes: { initialRealm: otherRealm.id },
      meta: META,
    }).then(
      () => null,
      (error: unknown) => error as { message: string; code: string },
    );
    expect(crossWork?.code).toBe('VALIDATION_FAILED');
    expect(crossWork?.message).toContain('引用目标不存在');

    // 4) 类型不匹配：initialRealm 只能指向 realm_level
    const faction = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
      name: '青云宗',
      attributes: factionAttributes(),
      meta: META,
    });
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'character',
        name: '丙',
        attributes: { initialRealm: faction.id },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 5) 已软删除的目标（用另一个无人引用的境界，避免触发删除保护）
    const doomed = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'realm_level',
      name: '即将删除的境界',
      attributes: realmAttributes(),
      meta: META,
    });
    await deleteEntity(db, {
      workId,
      authorId: author.id,
      entityId: doomed.id,
      meta: META,
    });
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'character',
        name: '丁',
        attributes: { initialRealm: doomed.id },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('禁止引用自身；entityRefs 可以引用同类型的其它实体', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const a = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
      name: '甲宗',
      attributes: factionAttributes(),
      meta: META,
    });
    const b = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
      name: '乙宗',
      attributes: factionAttributes('family'),
      meta: META,
    });

    // 同类型 entityRefs 正常
    const updated = await updateEntity(db, {
      workId,
      authorId: author.id,
      entityId: a.id,
      attributes: { ...factionAttributes(), allies: [b.id] },
      meta: META,
    });
    expect(updated.attributes['allies']).toEqual([b.id]);

    // 自引用被拒
    await expect(
      updateEntity(db, {
        workId,
        authorId: author.id,
        entityId: a.id,
        attributes: { ...factionAttributes(), allies: [a.id] },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 人物也不能把自己列进"谁知道秘密"
    const character = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'character',
      name: '林青',
      attributes: { identity: '弟子' },
      meta: META,
    });
    await expect(
      updateEntity(db, {
        workId,
        authorId: author.id,
        entityId: character.id,
        attributes: { identity: '弟子', secretKnownBy: [character.id] },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  /* ---------------------------------------------------------------- *
   * 多类型 CRUD 与排序
   * ---------------------------------------------------------------- */

  it('三类各自独立排序：每类型 1..N，重排互不影响', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realms = [];
    for (const name of ['炼气', '筑基']) {
      realms.push(
        await createEntity(db, {
          workId,
          authorId: author.id,
          entityType: 'realm_level',
          name,
          attributes: realmAttributes(),
          meta: META,
        }),
      );
    }
    const faction = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
      name: '青云宗',
      attributes: factionAttributes(),
      meta: META,
    });
    const character = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'character',
      name: '林青',
      attributes: { identity: '弟子' },
      meta: META,
    });

    // 每个类型都从 1 开始
    expect(realms.map((item) => item.orderIndex)).toEqual([1, 2]);
    expect(faction.orderIndex).toBe(1);
    expect(character.orderIndex).toBe(1);

    // 只重排 realm_level，其它类型不受影响
    await reorderEntities(db, {
      workId,
      authorId: author.id,
      entityType: 'realm_level',
      entityIds: [realms[1]!.id, realms[0]!.id],
      meta: META,
    });

    const realmList = await listEntities(db, {
      workId,
      authorId: author.id,
      entityType: 'realm_level',
    });
    expect(realmList.map((item) => item.name)).toEqual(['筑基', '炼气']);

    const factionList = await listEntities(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
    });
    expect(factionList).toHaveLength(1);
    expect(factionList[0]?.orderIndex).toBe(1);
  });

  it('排序集合按类型校验：混入其它类型的 id 或缺少本类型实体会失败', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'realm_level',
      name: '炼气',
      attributes: realmAttributes(),
      meta: META,
    });
    const faction = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
      name: '青云宗',
      attributes: factionAttributes(),
      meta: META,
    });

    // 混入 faction 的 id 去排 realm_level
    await expect(
      reorderEntities(db, {
        workId,
        authorId: author.id,
        entityType: 'realm_level',
        entityIds: [realm.id, faction.id],
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 缺少本类型实体
    await expect(
      reorderEntities(db, {
        workId,
        authorId: author.id,
        entityType: 'realm_level',
        entityIds: [],
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 未实现的类型
    await expect(
      reorderEntities(db, {
        workId,
        authorId: author.id,
        entityType: 'item',
        entityIds: [],
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'ENTITY_TYPE_NOT_ALLOWED' });
  });

  it('同名只在同类型内冲突：不同类型可以重名', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
      name: '同名',
      attributes: factionAttributes(),
      meta: META,
    });
    // 不同类型同名允许
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'character',
        name: '同名',
        attributes: { identity: '弟子' },
        meta: META,
      }),
    ).resolves.toBeDefined();
    // 同类型同名拒绝
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'faction',
        name: '同名',
        attributes: factionAttributes('family'),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'ENTITY_NAME_TAKEN' });
  });

  /* ---------------------------------------------------------------- *
   * 删除保护范围
   * ---------------------------------------------------------------- */

  it('删除保护只看当前契约的引用字段：自由文本与旧契约属性不阻止删除', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'realm_level',
      name: '炼气',
      attributes: realmAttributes(),
      meta: META,
    });

    // 自由文本里恰好出现该 id —— 不是引用，不该阻止删除
    const character = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'character',
      name: '林青',
      attributes: { identity: `弟子（备注 ${realm.id}）` },
      meta: META,
    });

    // 旧契约下的"引用字段"（xuanhuan@1.0.0）也不该阻止删除
    await db.entityAttribute.create({
      data: {
        entityId: character.id,
        attrKey: 'initialRealm',
        attrValue: realm.id,
        schemaRef: 'xuanhuan@1.0.0',
      },
    });

    await expect(
      deleteEntity(db, { workId, authorId: author.id, entityId: realm.id, meta: META }),
    ).resolves.toBeUndefined();
  });

  it('已软删除的引用者不阻止删除；entityRefs 引用会阻止删除', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const ally = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
      name: '甲宗',
      attributes: factionAttributes(),
      meta: META,
    });
    const holder = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
      name: '乙宗',
      attributes: { ...factionAttributes('family'), allies: [ally.id] },
      meta: META,
    });

    // entityRefs 引用 → 阻止
    await expect(
      deleteEntity(db, { workId, authorId: author.id, entityId: ally.id, meta: META }),
    ).rejects.toMatchObject({ code: 'ENTITY_IN_USE' });

    // 删掉引用者后即可删除
    await deleteEntity(db, { workId, authorId: author.id, entityId: holder.id, meta: META });
    await expect(
      deleteEntity(db, { workId, authorId: author.id, entityId: ally.id, meta: META }),
    ).resolves.toBeUndefined();
  });

  /* ---------------------------------------------------------------- *
   * entityGroups DTO
   * ---------------------------------------------------------------- */

  it('设定中心返回 entityGroups（三个分组、按 order 排序、无 realms 字段）', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'realm_level',
      name: '炼气',
      attributes: realmAttributes(),
      meta: META,
    });
    await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
      name: '青云宗',
      attributes: factionAttributes(),
      meta: META,
    });

    const center = await getSettingsCenter(db, { workId, authorId: author.id });

    expect(center).not.toHaveProperty('realms');
    expect(center.entityGroups.map((group) => group.entityType)).toEqual([
      'realm_level',
      'faction',
      'character',
    ]);
    expect(center.entityGroups.map((group) => group.title)).toEqual(['境界体系', '势力', '人物']);
    expect(center.entityGroups.map((group) => group.order)).toEqual([1, 2, 3]);
    for (const group of center.entityGroups) {
      expect(group.schemaRef).toBe('xuanhuan@3.0.0');
    }
    expect(center.entityGroups[0]?.entities.map((item) => item.name)).toEqual(['炼气']);
    expect(center.entityGroups[1]?.entities.map((item) => item.name)).toEqual(['青云宗']);
    expect(center.entityGroups[2]?.entities).toEqual([]);

    // schema 仍下发字段定义（含 enum 选项与 refType），供 UI 渲染表单
    const factionDef = center.schema.entityTypes.find((item) => item.key === 'faction');
    expect(factionDef?.group.fields.find((field) => field.key === 'type')?.options).toHaveLength(6);
    const characterDef = center.schema.entityTypes.find((item) => item.key === 'character');
    expect(characterDef?.group.fields.find((field) => field.key === 'initialRealm')?.refType).toBe(
      'realm_level',
    );
  });

  it('作品隔离：他人作品的任何类型都不可读写，管理员同样不可访问', async () => {
    const db = testDb();
    const owner = await createAuthor();
    const intruder = await createAuthor();
    const workId = await createWork(owner.id);

    const realm = await createEntity(db, {
      workId,
      authorId: owner.id,
      entityType: 'realm_level',
      name: '炼气',
      attributes: realmAttributes(),
      meta: META,
    });
    await createEntity(db, {
      workId,
      authorId: owner.id,
      entityType: 'faction',
      name: '青云宗',
      attributes: factionAttributes(),
      meta: META,
    });

    for (const entityType of ['realm_level', 'faction', 'character']) {
      await expect(
        listEntities(db, { workId, authorId: intruder.id, entityType }),
        `${entityType} 列表应 404`,
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }

    await expect(getSettingsCenter(db, { workId, authorId: intruder.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    await expect(
      createEntity(db, {
        workId,
        authorId: intruder.id,
        entityType: 'character',
        name: '闯入者',
        attributes: {},
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      updateEntity(db, {
        workId,
        authorId: intruder.id,
        entityId: realm.id,
        name: '被改名',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      deleteEntity(db, { workId, authorId: intruder.id, entityId: realm.id, meta: META }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/**
 * 规则包坏数据的场景需要改全局规则包 —— 放到隔离库里做，避免污染共享测试库。
 */
describe('M2-B2 规则包坏数据：refType 未声明', () => {
  let handle: UpgradeDb;

  beforeAll(async () => {
    // '9999' 大于所有迁移目录名 → 全部应用
    handle = await createDbBeforeMigration('m2b2-bad', '9999');
  }, 60_000);

  afterAll(async () => {
    await handle?.dispose();
  }, 60_000);

  it('refType 未在 entityTypes 中声明时按 INVALID_RULE_PACKAGE 处理', async () => {
    const { db, raw } = handle;

    // 把 character.initialRealm 的 refType 改成未声明的 'item'
    await raw.query(
      `UPDATE rule_packages
          SET field_schema = jsonb_set(
                field_schema,
                '{entityTypes,character,fields}',
                (
                  SELECT jsonb_agg(
                           CASE WHEN f->>'key' = 'initialRealm'
                                THEN jsonb_set(f, '{refType}', '"item"')
                                ELSE f END
                           ORDER BY ord)
                    FROM jsonb_array_elements(field_schema->'entityTypes'->'character'->'fields')
                         WITH ORDINALITY AS t(f, ord)
                )
              )
        WHERE code = 'xuanhuan'`,
    );

    const user = await db.user.create({
      data: {
        email: uniqueEmail('m2b2-bad'),
        passwordHash: '$argon2id$stub',
        role: 'author',
        status: 'active',
        mustChangePassword: false,
      },
    });
    const work = await db.work.create({
      data: {
        authorId: user.id,
        title: `坏规则包-${uniqueEmail('t')}`,
        genreRulePackage: 'xuanhuan',
      },
    });

    await expect(
      createEntity(db, {
        workId: work.id,
        authorId: user.id,
        entityType: 'character',
        name: '林青',
        attributes: { initialRealm: randomUUID() },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RULE_PACKAGE' });
  }, 60_000);
});
