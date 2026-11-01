/**
 * M2-B2-A-REV-01：引用类型校验必须**逐字段、逐 id**。
 *
 * 此前的实现把所有引用收敛成 `Map<entityId, refType>`：
 * 同一个 UUID 出现在两个 `refType` 不同的引用字段里时，
 * 后一个字段会覆盖前一个字段的期望类型，
 * 于是只有"最后一个字段"真的被校验，另一个字段的类型约束被静默跳过。
 *
 * 这里用两个方向证明修复有效（两个方向都能击穿 Map 版本）：
 * 1. 势力 id 同时出现在 `secretKnownBy`（要求 character）与 `faction`（要求 faction）；
 * 2. 境界 id 同时出现在 `secretKnownBy`（要求 character）与 `initialRealm`（要求 realm_level）。
 *
 * 两个用例都必须 400，并且**不留下任何**实体 / 属性 / 版本 / 审计。
 */

import { afterAll, describe, expect, it } from 'vitest';

import { createEntity } from '../src/index.js';
import { closeTestDb, testDb, uniqueEmail } from './helpers/db.js';

const META = { ip: '203.0.113.81', userAgent: 'vitest' };

async function createAuthor(): Promise<{ id: string }> {
  const db = testDb();
  const user = await db.user.create({
    data: {
      email: uniqueEmail('ref-typing'),
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
    data: { authorId, title: `引用类型-${uniqueEmail('t')}`, genreRulePackage: 'xuanhuan' },
  });
  return work.id;
}

function realmAttributes(): Record<string, unknown> {
  return { minorLevelCount: 9, breakthroughCondition: '引气入体' };
}

/** 某作品当前的"实体 / 属性 / 版本 / 创建审计"计数。 */
async function snapshot(
  workId: string,
  authorId: string,
): Promise<{
  entities: number;
  attributes: number;
  versions: number;
  createAudits: number;
}> {
  const db = testDb();
  const [entities, attributes, versions, createAudits] = await Promise.all([
    db.entity.count({ where: { workId } }),
    db.entityAttribute.count({ where: { entity: { workId } } }),
    db.entityVersion.count({ where: { entity: { workId } } }),
    db.auditLog.count({ where: { action: 'entity.created', actorId: authorId } }),
  ]);
  return { entities, attributes, versions, createAudits };
}

describe('M2-B2-A-REV-01 引用类型逐字段校验', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it('势力 id 同时作为 secretKnownBy 与 faction 的引用：整体 400，且不落任何数据', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const faction = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
      name: '青云宗',
      attributes: { type: 'sect' },
      meta: META,
    });

    const before = await snapshot(workId, author.id);
    expect(before.entities).toBe(1);

    // secretKnownBy 要求 character，faction 字段要求 faction —— 同一个 id 无法同时满足。
    // Map 版本会让 faction（声明在后）覆盖 secretKnownBy，从而错误地创建成功。
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'character',
        name: '林青',
        attributes: { secretKnownBy: [faction.id], faction: faction.id },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const after = await snapshot(workId, author.id);
    // 实体、属性、版本、审计全部没有任何新增
    expect(after).toEqual(before);

    const characters = await db.entity.count({ where: { workId, entityType: 'character' } });
    expect(characters).toBe(0);
  });

  it('对照：境界 id 同时作为 secretKnownBy 与 initialRealm 的引用：同样 400', async () => {
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

    const before = await snapshot(workId, author.id);

    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'character',
        name: '林青',
        attributes: { secretKnownBy: [realm.id], initialRealm: realm.id },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(await snapshot(workId, author.id)).toEqual(before);
  });

  it('两个字段各自都合法时正常创建（不误伤）', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const faction = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'faction',
      name: '青云宗',
      attributes: { type: 'sect' },
      meta: META,
    });
    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'realm_level',
      name: '炼气',
      attributes: realmAttributes(),
      meta: META,
    });
    const other = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'character',
      name: '苏沐',
      attributes: { identity: '师姐' },
      meta: META,
    });

    // 同一个 id 出现在**相同** refType 的两个字段里是允许的
    // （这里 secretKnownBy 与另一个 character 字段不存在，故用两个角色各自合法校验）
    const character = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'character',
      name: '林青',
      attributes: {
        secretKnownBy: [other.id],
        initialRealm: realm.id,
        faction: faction.id,
      },
      meta: META,
    });

    expect(character.attributes['initialRealm']).toBe(realm.id);
    expect(character.attributes['faction']).toBe(faction.id);
    expect(character.attributes['secretKnownBy']).toEqual([other.id]);
  });
});
