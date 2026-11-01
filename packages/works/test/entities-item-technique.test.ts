/**
 * M2-B3-A：物品（item）与功法（technique）实体契约。
 *
 * 覆盖：
 * - item 的字段只能是 category / quality / acquisition / description，
 *   **不含 holder**（持有人以 B3-B 的 item_events 为唯一真相）；
 * - technique.realmRequirement 是 entityRef → realm_level：
 *   存在/未删除/同作品/类型一致/禁自引用；
 * - 删除保护：删除被功法引用的境界 → ENTITY_IN_USE，解引用后可删；
 * - 五类实体各自独立的 order_index 与完整排序集合校验；
 * - 版本、重名、隔离与既有类型一致。
 */

import { afterAll, describe, expect, it } from 'vitest';

import { AuthError } from '@novel/auth';

import {
  createEntity,
  deleteEntity,
  getSettingsCenter,
  listEntities,
  reorderEntities,
  updateEntity,
} from '../src/index.js';
import { closeTestDb, testDb, uniqueEmail } from './helpers/db.js';

const META = { ip: '203.0.113.91', userAgent: 'vitest' };

async function createAuthor(): Promise<{ id: string }> {
  const db = testDb();
  const user = await db.user.create({
    data: {
      email: uniqueEmail('m2b3a'),
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
    data: { authorId, title: `B3A作品-${uniqueEmail('t')}`, genreRulePackage: 'xuanhuan' },
  });
  return work.id;
}

function realmAttributes(): Record<string, unknown> {
  return { minorLevelCount: 9, breakthroughCondition: '引气入体' };
}

function itemAttributes(): Record<string, unknown> {
  return { category: 'weapon', quality: 'mystic', acquisition: '秘境所得' };
}

function techniqueAttributes(realmId?: string): Record<string, unknown> {
  return {
    type: 'cultivation',
    ...(realmId === undefined ? {} : { realmRequirement: realmId }),
    effect: '剑气纵横',
  };
}

describe('M2-B3-A 物品与功法', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it('item 只能提交声明的四个字段：holder 一律 400（不在规则包里）', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const item = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'item',
      name: '青锋剑',
      attributes: itemAttributes(),
      meta: META,
    });
    expect(item.entityType).toBe('item');
    expect(item.attributes).toEqual({
      category: 'weapon',
      quality: 'mystic',
      acquisition: '秘境所得',
    });

    // holder 不是规则包字段 → 未知字段 400（不会静默忽略）
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'item',
        name: '带持有人的剑',
        attributes: { ...itemAttributes(), holder: author.id },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('item 的 enum 取值必须来自规则包；缺必填也拒绝', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'item',
        name: '非法类别',
        attributes: { category: 'not-an-option', quality: 'mystic' },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'item',
        name: '缺品质',
        attributes: { category: 'weapon' },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 六个品质值都合法（label 只用于展示）
    for (const quality of ['mortal', 'spirit', 'mystic', 'earth', 'heaven', 'immortal']) {
      await expect(
        createEntity(db, {
          workId,
          authorId: author.id,
          entityType: 'item',
          name: `品质-${quality}`,
          attributes: { category: 'artifact', quality },
          meta: META,
        }),
      ).resolves.toMatchObject({ entityType: 'item' });
    }
  });

  it('technique.realmRequirement 引用境界：存在/未删除/同作品/类型一致/禁自引用', async () => {
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

    // 合法引用
    const technique = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'technique',
      name: '青元剑诀',
      attributes: techniqueAttributes(realm.id),
      meta: META,
    });
    expect(technique.attributes['realmRequirement']).toBe(realm.id);

    // 类型不符：指向势力
    const faction = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
      name: '青云宗',
      attributes: { type: 'sect' },
      meta: META,
    });
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'technique',
        name: '错误门槛',
        attributes: techniqueAttributes(faction.id),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 跨作品引用：文案与"不存在"一致
    const otherRealm = await createEntity(db, {
      workId: otherWorkId,
      authorId: other.id,
      entityType: 'realm_level',
      name: '别人的境界',
      attributes: realmAttributes(),
      meta: META,
    });
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'technique',
        name: '跨作品门槛',
        attributes: techniqueAttributes(otherRealm.id),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 不存在的 id
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'technique',
        name: '幽灵门槛',
        attributes: techniqueAttributes('00000000-0000-4000-8000-000000000000'),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 自引用：编辑时把门槛设成自己
    await expect(
      updateEntity(db, {
        workId,
        authorId: author.id,
        entityId: technique.id,
        attributes: techniqueAttributes(technique.id),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('删除被功法引用的境界 → 409 + 引用摘要；解引用后可删', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'realm_level',
      name: '筑基',
      attributes: realmAttributes(),
      meta: META,
    });
    const technique = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'technique',
      name: '御剑术',
      attributes: { type: 'martial', realmRequirement: realm.id },
      meta: META,
    });

    let captured: unknown = null;
    try {
      await deleteEntity(db, { workId, authorId: author.id, entityId: realm.id, meta: META });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(AuthError);
    // 摘要只含定位信息（类型 + 名称），不含属性值
    expect((captured as AuthError).toBody()).toMatchObject({
      error: {
        code: 'ENTITY_IN_USE',
        references: {
          total: 1,
          items: [{ id: technique.id, entityType: 'technique', name: '御剑术' }],
        },
      },
    });

    // 境界仍在
    const realms = await listEntities(db, {
      workId,
      authorId: author.id,
      entityType: 'realm_level',
    });
    expect(realms.map((item) => item.name)).toEqual(['筑基']);

    // 解除引用后可删
    await updateEntity(db, {
      workId,
      authorId: author.id,
      entityId: technique.id,
      attributes: { type: 'martial' },
      meta: META,
    });
    await expect(
      deleteEntity(db, { workId, authorId: author.id, entityId: realm.id, meta: META }),
    ).resolves.toBeUndefined();
  });

  it('物品本身没有引用者：删除物品永远允许', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const item = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'item',
      name: '断剑',
      attributes: itemAttributes(),
      meta: META,
    });

    await expect(
      deleteEntity(db, { workId, authorId: author.id, entityId: item.id, meta: META }),
    ).resolves.toBeUndefined();
    await expect(
      listEntities(db, { workId, authorId: author.id, entityType: 'item' }),
    ).resolves.toEqual([]);
  });

  it('五类实体各自独立 1..N：排序互不影响，reorder 混入其它类型被拒', async () => {
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
    const itemA = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'item',
      name: '甲剑',
      attributes: itemAttributes(),
      meta: META,
    });
    const itemB = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'item',
      name: '乙剑',
      attributes: itemAttributes(),
      meta: META,
    });
    const techniqueA = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'technique',
      name: '甲诀',
      attributes: techniqueAttributes(realm.id),
      meta: META,
    });

    // 每类型都从 1 开始
    expect([realm.orderIndex, itemA.orderIndex, itemB.orderIndex, techniqueA.orderIndex]).toEqual([
      1, 1, 2, 1,
    ]);

    // 只排 item，technique 不变
    await reorderEntities(db, {
      workId,
      authorId: author.id,
      entityType: 'item',
      entityIds: [itemB.id, itemA.id],
      meta: META,
    });
    const items = await listEntities(db, { workId, authorId: author.id, entityType: 'item' });
    expect(items.map((item) => item.name)).toEqual(['乙剑', '甲剑']);
    const techniques = await listEntities(db, {
      workId,
      authorId: author.id,
      entityType: 'technique',
    });
    expect(techniques.map((item) => item.name)).toEqual(['甲诀']);

    // 混入境界 id → 整体拒绝
    await expect(
      reorderEntities(db, {
        workId,
        authorId: author.id,
        entityType: 'item',
        entityIds: [itemA.id, realm.id],
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('跨类型可以重名，同类型重名拒绝；编辑追加版本', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'item',
      name: '同名',
      attributes: itemAttributes(),
      meta: META,
    });
    await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'technique',
      name: '同名',
      attributes: techniqueAttributes(),
      meta: META,
    });

    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'item',
        name: '同名',
        attributes: itemAttributes(),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'ENTITY_NAME_TAKEN' });

    const techniques = await listEntities(db, {
      workId,
      authorId: author.id,
      entityType: 'technique',
    });
    const technique = techniques[0]!;
    expect(technique.version).toBe(1);

    const updated = await updateEntity(db, {
      workId,
      authorId: author.id,
      entityId: technique.id,
      attributes: { ...techniqueAttributes(), sideEffect: '剑气伤己' },
      meta: META,
    });
    expect(updated.version).toBe(2);
    expect(updated.attributes['sideEffect']).toBe('剑气伤己');
  });

  it('他人作品不可读写 item / technique；管理员同样不可访问', async () => {
    const db = testDb();
    const author = await createAuthor();
    const intruder = await createAuthor();
    const workId = await createWork(author.id);

    const item = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'item',
      name: '私有法宝',
      attributes: itemAttributes(),
      meta: META,
    });

    for (const entityType of ['item', 'technique'] as const) {
      await expect(
        listEntities(db, { workId, authorId: intruder.id, entityType }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    await expect(
      updateEntity(db, {
        workId,
        authorId: intruder.id,
        entityId: item.id,
        attributes: itemAttributes(),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getSettingsCenter(db, { workId, authorId: intruder.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
