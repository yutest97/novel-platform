/**
 * 设定中心与通用实体测试（M2-B1）。
 *
 * 覆盖：作品归属隔离、schema 校验、版本快照、软删除、排序、审计原子性。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_ENTITY_TYPE,
  createEntity,
  deleteEntity,
  getSettingsCenter,
  listEntities,
  reorderEntities,
  updateDirection,
  updateEntity,
} from '../src/entities.js';
import { closeTestDb, testDb, uniqueEmail } from './helpers/db.js';

const META = { ip: '203.0.113.20', userAgent: 'vitest' };

/** 创建作者账号。 */
async function createAuthor(): Promise<{ id: string; email: string }> {
  const db = testDb();
  const email = uniqueEmail('m2b1');
  const user = await db.user.create({
    data: {
      email,
      passwordHash: '$argon2id$stub',
      role: 'author',
      status: 'active',
      mustChangePassword: false,
    },
  });
  return { id: user.id, email };
}

/** 创建作品。 */
async function createWork(authorId: string, title?: string): Promise<string> {
  const db = testDb();
  const work = await db.work.create({
    data: {
      authorId,
      title: title ?? `作品-${uniqueEmail('t')}`,
      genreRulePackage: 'xuanhuan',
    },
  });
  return work.id;
}

/** 合法的境界属性。 */
function realmAttributes(): Record<string, unknown> {
  return {
    minorLevelCount: 9,
    breakthroughCondition: '引气入体',
    lifespan: '一百年',
    powerBaseline: '凡境',
  };
}

describe('设定中心与实体（M2-B1）', () => {
  beforeAll(() => {
    testDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('xuanhuan 规则包包含作品方向与 realm_level 的字段定义', async () => {
    const db = testDb();
    const rulePackage = await db.rulePackage.findUniqueOrThrow({ where: { code: 'xuanhuan' } });
    const schema = rulePackage.fieldSchema as {
      workDirection?: { fields?: { key: string }[] };
      entityTypes?: Record<string, { fields?: { key: string }[] }>;
    };

    expect(schema.workDirection?.fields?.map((field) => field.key)).toEqual([
      'subGenre',
      'goldenFinger',
      'toneStyle',
      'protagonistPosition',
    ]);
    expect(schema.entityTypes?.['realm_level']?.fields?.map((field) => field.key)).toEqual([
      'minorLevelCount',
      'breakthroughCondition',
      'lifespan',
      'powerBaseline',
      'description',
    ]);
  });

  it('作者只能看到自己作品的设定；他人作品一律 404', async () => {
    const db = testDb();
    const authorA = await createAuthor();
    const authorB = await createAuthor();
    const workId = await createWork(authorA.id);

    const center = await getSettingsCenter(db, { workId, authorId: authorA.id });
    expect(center.workId).toBe(workId);
    expect(center.schema.code).toBe('xuanhuan');

    await expect(getSettingsCenter(db, { workId, authorId: authorB.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('作品方向按 xuanhuan schema 校验：未知字段、缺必填、类型错都 400', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    // 未知字段
    await expect(
      updateDirection(db, {
        workId,
        authorId: author.id,
        values: { unknownField: 'x' },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 缺必填
    await expect(
      updateDirection(db, {
        workId,
        authorId: author.id,
        values: { subGenre: '东方玄幻' },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 类型错
    await expect(
      updateDirection(db, {
        workId,
        authorId: author.id,
        values: { subGenre: '东方玄幻', goldenFinger: 123 },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('更新作品方向成功并写 settings.updated 审计（不含具体值）', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const direction = await updateDirection(db, {
      workId,
      authorId: author.id,
      values: {
        subGenre: '东方玄幻',
        goldenFinger: '残破玉佩',
        toneStyle: '热血激昂',
        protagonistPosition: '废柴逆袭',
      },
      meta: META,
    });

    expect(direction['subGenre']).toBe('东方玄幻');
    expect(direction['goldenFinger']).toBe('残破玉佩');

    const audit = await db.auditLog.findFirst({
      where: { action: 'settings.updated', targetId: workId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    const detail = JSON.stringify(audit?.detail ?? {});
    expect(detail).toContain('subGenre');
    // detail 不得包含设定值
    expect(detail).not.toContain('残破玉佩');
    expect(detail).not.toContain('东方玄幻');
  });

  it('可选作品方向字段被清空后不再返回（旧行被删除）', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    // 先保存含两个可选字段的方向
    await updateDirection(db, {
      workId,
      authorId: author.id,
      values: {
        subGenre: '东方玄幻',
        goldenFinger: '残破玉佩',
        toneStyle: '热血激昂',
        protagonistPosition: '废柴逆袭',
      },
      meta: META,
    });

    let center = await getSettingsCenter(db, { workId, authorId: author.id });
    expect(center.direction['toneStyle']).toBe('热血激昂');
    expect(center.direction['protagonistPosition']).toBe('废柴逆袭');

    // 再保存：两个可选字段被清空（不提交）
    const cleared = await updateDirection(db, {
      workId,
      authorId: author.id,
      values: {
        subGenre: '东方玄幻',
        goldenFinger: '残破玉佩',
      },
      meta: META,
    });

    expect(cleared['toneStyle']).toBeUndefined();
    expect(cleared['protagonistPosition']).toBeUndefined();
    expect(cleared['subGenre']).toBe('东方玄幻');

    // 刷新（重新读取）后仍为空
    center = await getSettingsCenter(db, { workId, authorId: author.id });
    expect(center.direction['toneStyle']).toBeUndefined();
    expect(center.direction['protagonistPosition']).toBeUndefined();

    // 数据库里对应的行确实被删掉了（只删当前 schemaRef 的行）
    const rows = await db.workSetting.findMany({
      where: { workId },
      select: { settingKey: true, schemaRef: true },
    });
    expect(rows.filter((row) => row.settingKey === 'toneStyle')).toHaveLength(0);
    expect(rows.filter((row) => row.settingKey === 'protagonistPosition')).toHaveLength(0);
    expect(rows.filter((row) => row.settingKey === 'subGenre')).toHaveLength(1);
  });

  it('旧 schemaRef 的方向设定不会混入当前响应，也不会被当前同步删除', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    // 造一条旧契约版本下的设定
    await db.workSetting.create({
      data: {
        workId,
        settingKey: 'toneStyle',
        settingValue: '旧契约的语气风格',
        schemaRef: 'xuanhuan@1.0.0',
      },
    });

    // 当前契约下同步一组方向
    const direction = await updateDirection(db, {
      workId,
      authorId: author.id,
      values: {
        subGenre: '东方玄幻',
        goldenFinger: '残破玉佩',
        toneStyle: '热血激昂',
      },
      meta: META,
    });

    // 响应里只有当前 schemaRef 的值
    expect(direction['toneStyle']).toBe('热血激昂');

    const center = await getSettingsCenter(db, { workId, authorId: author.id });
    expect(center.direction['toneStyle']).toBe('热血激昂');

    // 旧契约的行没有被删除（不属于当前契约的处理范围）
    const legacy = await db.workSetting.findMany({
      where: { workId, schemaRef: 'xuanhuan@1.0.0' },
      select: { settingKey: true },
    });
    expect(legacy.map((row) => row.settingKey)).toEqual(['toneStyle']);
  });

  it('规则包的字段契约版本必须与规则包版本一致（schemaRef = code@version）', async () => {
    const db = testDb();
    const rulePackage = await db.rulePackage.findUniqueOrThrow({ where: { code: 'xuanhuan' } });
    const expected = `${rulePackage.code}@${rulePackage.version}`;

    const schema = rulePackage.fieldSchema as {
      version?: number;
      workDirection?: { schemaRef?: string };
      entityTypes?: Record<string, { schemaRef?: string }>;
    };

    expect(schema.version).toBe(4);
    expect(schema.workDirection?.schemaRef).toBe(expected);
    for (const group of Object.values(schema.entityTypes ?? {})) {
      expect(group.schemaRef).toBe(expected);
    }
  });

  it('创建 realm_level：实体 + 属性 + 第一版快照 + 审计同事务', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '炼气',
      attributes: realmAttributes(),
      meta: META,
    });

    expect(realm.name).toBe('炼气');
    expect(realm.attributes['minorLevelCount']).toBe(9);
    expect(realm.version).toBe(1);

    const versions = await db.entityVersion.findMany({ where: { entityId: realm.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.versionNo).toBe(1);

    const audit = await db.auditLog.findFirst({
      where: { action: 'entity.created', targetId: realm.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    const detail = JSON.stringify(audit?.detail ?? '');
    expect(detail).toContain(workId);
    expect(detail).toContain('realm_level');
    expect(detail).not.toContain('引气入体');
  });

  it('同作品同类型重名被拒绝；不同作品允许同名', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workA = await createWork(author.id);
    const workB = await createWork(author.id);

    await createEntity(db, {
      workId: workA,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '筑基',
      attributes: realmAttributes(),
      meta: META,
    });

    await expect(
      createEntity(db, {
        workId: workA,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        name: '筑基',
        attributes: realmAttributes(),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'ENTITY_NAME_TAKEN' });

    // 不同作品同名可以
    const other = await createEntity(db, {
      workId: workB,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '筑基',
      attributes: realmAttributes(),
      meta: META,
    });
    expect(other.name).toBe('筑基');
  });

  it('编辑实体追加新版本，旧版本保留', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '金丹',
      attributes: realmAttributes(),
      meta: META,
    });

    const updated = await updateEntity(db, {
      workId,
      authorId: author.id,
      entityId: realm.id,
      attributes: { ...realmAttributes(), breakthroughCondition: '破而后立' },
      meta: META,
    });

    expect(updated.version).toBe(2);
    expect(updated.attributes['breakthroughCondition']).toBe('破而后立');

    const versions = await db.entityVersion.findMany({
      where: { entityId: realm.id },
      orderBy: { versionNo: 'asc' },
    });
    expect(versions).toHaveLength(2);
    expect(versions[0]?.versionNo).toBe(1);
    expect(versions[1]?.versionNo).toBe(2);
    // 旧版本快照保留最初的值
    const snapshot = versions[0]?.snapshot as { attributes: Record<string, unknown> };
    expect(snapshot.attributes['breakthroughCondition']).toBe('引气入体');
  });

  it('其他作者更新实体一律 404', async () => {
    const db = testDb();
    const authorA = await createAuthor();
    const authorB = await createAuthor();
    const workId = await createWork(authorA.id);

    const realm = await createEntity(db, {
      workId,
      authorId: authorA.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '元婴',
      attributes: realmAttributes(),
      meta: META,
    });

    await expect(
      updateEntity(db, {
        workId,
        authorId: authorB.id,
        entityId: realm.id,
        name: '被篡改',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const row = await db.entity.findUniqueOrThrow({ where: { id: realm.id } });
    expect(row.name).toBe('元婴');
  });

  it('排序拒绝重复、缺失与跨作品 ID；合法排序完整生效', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workA = await createWork(author.id);
    const workB = await createWork(author.id);

    const a1 = await createEntity(db, {
      workId: workA,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '一',
      attributes: realmAttributes(),
      meta: META,
    });
    const a2 = await createEntity(db, {
      workId: workA,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '二',
      attributes: realmAttributes(),
      meta: META,
    });
    const b1 = await createEntity(db, {
      workId: workB,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '别作',
      attributes: realmAttributes(),
      meta: META,
    });

    // 重复
    await expect(
      reorderEntities(db, {
        workId: workA,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        entityIds: [a1.id, a1.id],
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 缺失
    await expect(
      reorderEntities(db, {
        workId: workA,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        entityIds: [a1.id],
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 跨作品
    await expect(
      reorderEntities(db, {
        workId: workA,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        entityIds: [a1.id, b1.id],
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 合法排序
    const ordered = await reorderEntities(db, {
      workId: workA,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      entityIds: [a2.id, a1.id],
      meta: META,
    });
    expect(ordered.map((item) => item.name)).toEqual(['二', '一']);

    const audit = await db.auditLog.findFirst({
      where: { action: 'entity.reordered', targetId: workA },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
  });

  it('被引用的境界删除返回 ENTITY_IN_USE（含安全引用摘要）；解引用后可删', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '化神',
      attributes: realmAttributes(),
      meta: META,
    });

    // 真实引用：人物通过 initialRealm（entityRef → realm_level）指向该境界
    const character = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: 'character',
      name: '林青',
      attributes: { identity: '外门弟子', initialRealm: realm.id },
      meta: META,
    });

    const failure = await deleteEntity(db, {
      workId,
      authorId: author.id,
      entityId: realm.id,
      meta: META,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'ENTITY_IN_USE' });

    // 摘要只含定位信息（id / 类型 / 名称），不含任何属性值
    const body = (failure as { toBody: () => { error: Record<string, unknown> } }).toBody();
    const references = body.error['references'] as {
      total: number;
      items: { id: string; entityType: string; name: string }[];
    };
    expect(references.total).toBe(1);
    expect(references.items).toEqual([{ id: character.id, entityType: 'character', name: '林青' }]);
    expect(JSON.stringify(references)).not.toContain('外门弟子');

    // 解除引用后可以删除
    await updateEntity(db, {
      workId,
      authorId: author.id,
      entityId: character.id,
      attributes: { identity: '外门弟子' },
      meta: META,
    });
    await deleteEntity(db, {
      workId,
      authorId: author.id,
      entityId: realm.id,
      meta: META,
    });

    const list = await listEntities(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
    });
    expect(list.map((item) => item.name)).not.toContain('化神');

    // 人物仍在（只解除了引用，没有被删）
    const characters = await listEntities(db, {
      workId,
      authorId: author.id,
      entityType: 'character',
    });
    expect(characters.map((item) => item.name)).toContain('林青');

    const deletedAudit = await db.auditLog.findFirst({
      where: { action: 'entity.deleted', targetId: realm.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(deletedAudit).not.toBeNull();
  });

  it('软删除后同名可以重新创建', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '渡劫',
      attributes: realmAttributes(),
      meta: META,
    });
    await deleteEntity(db, { workId, authorId: author.id, entityId: realm.id, meta: META });

    const again = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '渡劫',
      attributes: realmAttributes(),
      meta: META,
    });
    expect(again.name).toBe('渡劫');
  });

  it('审计写入失败时创建实体回滚（实体、属性、版本都不落库）', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION works_block_audit() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit blocked';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER works_block_audit_trigger
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION works_block_audit();
    `);

    try {
      await expect(
        createEntity(db, {
          workId,
          authorId: author.id,
          entityType: DEFAULT_ENTITY_TYPE,
          name: '会被回滚',
          attributes: realmAttributes(),
          meta: META,
        }),
      ).rejects.toBeTruthy();

      const entities = await db.entity.findMany({ where: { workId, name: '会被回滚' } });
      expect(entities).toHaveLength(0);
      const versions = await db.entityVersion.findMany({ where: { entity: { workId } } });
      expect(versions).toHaveLength(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS works_block_audit_trigger ON audit_logs`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS works_block_audit()`);
    }
  });

  it('审计写入失败时删除实体回滚（实体仍在）', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '删除回滚',
      attributes: realmAttributes(),
      meta: META,
    });

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION works_block_audit() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit blocked';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER works_block_audit_trigger
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION works_block_audit();
    `);

    try {
      await expect(
        deleteEntity(db, { workId, authorId: author.id, entityId: realm.id, meta: META }),
      ).rejects.toBeTruthy();

      const row = await db.entity.findUniqueOrThrow({ where: { id: realm.id } });
      expect(row.deletedAt).toBeNull();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS works_block_audit_trigger ON audit_logs`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS works_block_audit()`);
    }
  });

  it('只开放规则包声明且本轮支持的类型：人物 / 势力 / 物品 / 功法可用，其余拒绝', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    // 本轮支持的两类都能创建
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'character',
        name: '主角',
        attributes: {},
        meta: META,
      }),
    ).resolves.toMatchObject({ entityType: 'character' });

    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'faction',
        name: '青云宗',
        attributes: { type: 'sect' },
        meta: META,
      }),
    ).resolves.toMatchObject({ entityType: 'faction' });

    // 本轮新开放的两类
    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'item',
        name: '青锋剑',
        attributes: { category: 'weapon', quality: 'mystic' },
        meta: META,
      }),
    ).resolves.toMatchObject({ entityType: 'item' });

    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'technique',
        name: '青元剑诀',
        attributes: { type: 'cultivation' },
        meta: META,
      }),
    ).resolves.toMatchObject({ entityType: 'technique' });

    // 规则包没声明 / 本轮没实现的类型一律拒绝
    for (const entityType of ['location', 'resource_type', 'unknown']) {
      await expect(
        createEntity(db, {
          workId,
          authorId: author.id,
          entityType,
          name: `x-${entityType}`,
          attributes: {},
          meta: META,
        }),
        `类型 ${entityType} 应当被拒绝`,
      ).rejects.toMatchObject({ code: 'ENTITY_TYPE_NOT_ALLOWED' });
    }
  });

  it('列表接口同样只接受规则包声明且本轮支持的类型', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    for (const entityType of ['location', 'unknown']) {
      await expect(
        listEntities(db, {
          workId,
          authorId: author.id,
          entityType,
        }),
        `类型 ${entityType} 应当被拒绝`,
      ).rejects.toMatchObject({ code: 'ENTITY_TYPE_NOT_ALLOWED' });
    }

    for (const entityType of ['realm_level', 'faction', 'character', 'item', 'technique']) {
      await expect(
        listEntities(db, { workId, authorId: author.id, entityType }),
        `类型 ${entityType} 应当可列出`,
      ).resolves.toEqual([]);
    }
  });

  it('畸形 workId / entityId 在进入 Prisma 之前就被拒绝（400，不是 500）', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '元婴',
      attributes: realmAttributes(),
      meta: META,
    });

    const badWorkId = 'not-a-uuid';
    const badEntityId = '12345';

    // 读取
    await expect(
      getSettingsCenter(db, { workId: badWorkId, authorId: author.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      listEntities(db, {
        workId: badWorkId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 写入
    await expect(
      updateDirection(db, {
        workId: badWorkId,
        authorId: author.id,
        values: { subGenre: 'x', goldenFinger: 'y' },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      createEntity(db, {
        workId: badWorkId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        name: '畸形作品',
        attributes: realmAttributes(),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      updateEntity(db, {
        workId,
        authorId: author.id,
        entityId: badEntityId,
        attributes: realmAttributes(),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      deleteEntity(db, {
        workId,
        authorId: author.id,
        entityId: badEntityId,
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      reorderEntities(db, {
        workId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        entityIds: [badEntityId],
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 合法 entityId 但不存在的作品 → 仍然是 404（权限语义不变）
    await expect(
      updateEntity(db, {
        workId: '00000000-0000-4000-8000-00000000ffff',
        authorId: author.id,
        entityId: realm.id,
        attributes: realmAttributes(),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('实体属性校验：缺必填、类型错、越界都 400', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        name: '缺字段',
        attributes: { minorLevelCount: 9 },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        name: '类型错',
        attributes: { ...realmAttributes(), minorLevelCount: '九个' },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        name: '越界',
        attributes: { ...realmAttributes(), minorLevelCount: 999 },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        name: '未知字段',
        attributes: { ...realmAttributes(), unknown: 1 },
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('设定中心返回作品方向、schema 摘要与境界列表', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    await updateDirection(db, {
      workId,
      authorId: author.id,
      values: { subGenre: '仙侠修真', goldenFinger: '老爷爷' },
      meta: META,
    });
    await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '炼气',
      attributes: realmAttributes(),
      meta: META,
    });

    const center = await getSettingsCenter(db, { workId, authorId: author.id });
    expect(center.direction['subGenre']).toBe('仙侠修真');
    expect(center.schema.workDirection?.fields.length).toBe(4);
    const realmGroup = center.entityGroups.find((group) => group.entityType === 'realm_level');
    expect(realmGroup?.entities).toHaveLength(1);
    expect(realmGroup?.entities[0]?.name).toBe('炼气');
  });
});
