/**
 * 实体写路径的 UUID 大小写一致性（M2-B3-B1-REV-02）。
 *
 * 覆盖点：
 * - workId / entityId 传大写时，list / update / delete / reorder / 设定中心 /
 *   作品方向都必须正常工作（服务层统一 normalizeUuid）；
 * - reorder 的 entityIds 每一项也规范化，大写 id 能与数据库里的小写 id 正确匹配；
 * - 归属检查不受影响：**跨作品仍然 404**，大小写不能用来绕过隔离；
 * - 畸形 id 仍然是 400。
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  createEntity,
  deleteEntity,
  getSettingsCenter,
  listEntities,
  reorderEntities,
  updateDirection,
  updateEntity,
} from '../src/index.js';
import { closeTestDb, testDb, uniqueEmail } from './helpers/db.js';

const META = { ip: '203.0.113.95', userAgent: 'vitest' };

async function createAuthor(): Promise<string> {
  const user = await testDb().user.create({
    data: {
      email: uniqueEmail('m2b3b-case'),
      passwordHash: '$argon2id$stub',
      role: 'author',
      status: 'active',
      mustChangePassword: false,
    },
  });
  return user.id;
}

async function createWork(authorId: string): Promise<string> {
  const work = await testDb().work.create({
    data: { authorId, title: `大小写作品-${uniqueEmail('t')}`, genreRulePackage: 'xuanhuan' },
  });
  return work.id;
}

async function createCharacter(workId: string, authorId: string, name: string) {
  return createEntity(testDb(), {
    workId,
    authorId,
    entityType: 'character',
    name,
    attributes: {},
    meta: META,
  });
}

describe('M2-B3-B1-REV-02 实体路径的 UUID 大小写', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it('大写 workId：list / 设定中心 / 作品方向 都正常', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    await createCharacter(workId, authorId, '林青');
    const upper = workId.toUpperCase();

    const list = await listEntities(testDb(), {
      workId: upper,
      authorId,
      entityType: 'character',
    });
    expect(list.map((item) => item.name)).toEqual(['林青']);

    const center = await getSettingsCenter(testDb(), { workId: upper, authorId });
    expect(center.workId).toBe(workId);
    const characterGroup = center.entityGroups.find((group) => group.entityType === 'character');
    expect(characterGroup?.entities.map((item) => item.name)).toEqual(['林青']);

    const direction = await updateDirection(testDb(), {
      workId: upper,
      authorId,
      values: { subGenre: '东方玄幻', goldenFinger: '残破玉佩' },
      meta: META,
    });
    expect(direction['subGenre']).toBe('东方玄幻');

    // 写入用的是规范化后的小写 key，因此小写读取也能看到
    const reread = await getSettingsCenter(testDb(), { workId, authorId });
    expect(reread.direction['goldenFinger']).toBe('残破玉佩');
  });

  it('大写 workId + entityId：update 与 delete 正常', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const created = await createCharacter(workId, authorId, '苏沐');

    const updated = await updateEntity(db, {
      workId: workId.toUpperCase(),
      authorId,
      entityId: created.id.toUpperCase(),
      name: '苏沐（改）',
      meta: META,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('苏沐（改）');
    expect(updated.version).toBe(2);

    await deleteEntity(db, {
      workId: workId.toUpperCase(),
      authorId,
      entityId: created.id.toUpperCase(),
      meta: META,
    });

    const row = await db.entity.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('reorder：大写 entityIds 能与数据库小写 id 匹配，顺序正确落库', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const first = await createCharacter(workId, authorId, '甲');
    const second = await createCharacter(workId, authorId, '乙');
    const third = await createCharacter(workId, authorId, '丙');

    // 全部用大写反序提交
    const reordered = await reorderEntities(testDb(), {
      workId: workId.toUpperCase(),
      authorId,
      entityType: 'character',
      entityIds: [third.id.toUpperCase(), second.id.toUpperCase(), first.id.toUpperCase()],
      meta: META,
    });
    expect(reordered.map((item) => item.name)).toEqual(['丙', '乙', '甲']);
    expect(reordered.map((item) => item.orderIndex)).toEqual([1, 2, 3]);

    // 数据库里存的仍是小写 uuid
    const rows = await testDb().entity.findMany({
      where: { workId, entityType: 'character', deletedAt: null },
      orderBy: { orderIndex: 'asc' },
      select: { id: true, name: true },
    });
    expect(rows.map((row) => row.name)).toEqual(['丙', '乙', '甲']);
    for (const row of rows) {
      expect(row.id).toBe(row.id.toLowerCase());
    }
  });

  it('跨作品：大写 id 也仍然是 404（不能靠大小写绕过归属）', async () => {
    const authorA = await createAuthor();
    const authorB = await createAuthor();
    const workA = await createWork(authorA);
    const workB = await createWork(authorB);
    const entityInB = await createCharacter(workB, authorB, '别人的角色');
    const upperB = workB.toUpperCase();

    await expect(
      listEntities(testDb(), { workId: upperB, authorId: authorA, entityType: 'character' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      getSettingsCenter(testDb(), { workId: upperB, authorId: authorA }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      updateEntity(testDb(), {
        workId: upperB,
        authorId: authorA,
        entityId: entityInB.id.toUpperCase(),
        name: '篡改',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      deleteEntity(testDb(), {
        workId: upperB,
        authorId: authorA,
        entityId: entityInB.id.toUpperCase(),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // 跨作品的 id 混进 reorder：仍然 400（不是 500，也不是静默成功）
    const ownEntity = await createCharacter(workA, authorA, '自己的角色');
    await expect(
      reorderEntities(testDb(), {
        workId: workA,
        authorId: authorA,
        entityType: 'character',
        entityIds: [ownEntity.id.toUpperCase(), entityInB.id.toUpperCase()],
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('畸形 id 仍是 400（规范化不放宽形态校验）', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);

    await expect(
      listEntities(testDb(), { workId: 'not-a-uuid', authorId, entityType: 'character' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      updateEntity(testDb(), {
        workId,
        authorId,
        entityId: 'not-a-uuid',
        name: 'x',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      reorderEntities(testDb(), {
        workId,
        authorId,
        entityType: 'character',
        entityIds: ['not-a-uuid'],
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
