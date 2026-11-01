/**
 * M2-B3-A 升级路径测试：规则包 xuanhuan@3.0.0 → 4.0.0。
 *
 * 要证明的四件事：
 * 1. 迁移只改 `3.0.0`；`1.0.0`（M2-A）与 `2.0.0`（M2-B1）的历史行**内容与行数都不变**，
 *    也不被重新暴露；
 * 2. 三代同键重复（同一 work_id+setting_key / entity_id+attr_key 同时存在
 *    1.0.0 / 2.0.0 / 3.0.0 三行）时迁移**不会因唯一索引失败**；
 * 3. 作者升级前能看到的数据，升级后**逐字段相同**（不是数行数，是语义相等）；
 * 4. 升级后规则包版本、field_schema.version、五个字段组 schemaRef 三者恒等，
 *    且新增的 item / technique 立即可用（含 realmRequirement 引用与删除保护）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEntity, deleteEntity, getSettingsCenter, updateDirection } from '../src/entities.js';
import { uniqueEmail } from './helpers/db.js';
import { createDbBeforeMigration, readMigration, type UpgradeDb } from './helpers/upgrade-db.js';

const V4_MIGRATION = '20261103000000_m2b3a_item_technique';
const META = { ip: '203.0.113.63', userAgent: 'vitest' };

/** 某个 schema_ref 下所有行的"键 → 值"快照（用于逐字节比对历史契约行）。 */
async function legacySnapshot(
  handle: UpgradeDb,
  schemaRef: string,
): Promise<Record<string, string | null>> {
  const result = await handle.raw.query<{ table_name: string; payload: string | null }>(
    `SELECT 'work_settings' AS table_name,
            jsonb_agg(jsonb_build_object('k', setting_key, 'v', setting_value) ORDER BY setting_key)::text AS payload
       FROM work_settings WHERE schema_ref = $1
     UNION ALL
     SELECT 'entity_attributes',
            jsonb_agg(jsonb_build_object('k', attr_key, 'v', attr_value) ORDER BY attr_key)::text
       FROM entity_attributes WHERE schema_ref = $1`,
    [schemaRef],
  );
  return Object.fromEntries(result.rows.map((row) => [row.table_name, row.payload]));
}

describe('M2-B3-A 迁移：xuanhuan@3.0.0 → 4.0.0 升级路径', () => {
  let handle: UpgradeDb;

  beforeAll(async () => {
    handle = await createDbBeforeMigration('m2b3a', V4_MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await handle?.dispose();
  }, 60_000);

  it('升级只动 3.0.0：1.0.0/2.0.0 行原样保留，作者可见数据逐字段一致', async () => {
    const { db, raw } = handle;

    // ---------- 1. 构造"升级前"的真实数据（走服务层，契约是 3.0.0） ----------
    const before3 = await raw.query<{ version: string; fs: string }>(
      `SELECT version, field_schema->>'version' AS fs FROM rule_packages WHERE code='xuanhuan'`,
    );
    expect(before3.rows[0]?.version).toBe('3.0.0');
    expect(before3.rows[0]?.fs).toBe('3');

    const user = await db.user.create({
      data: {
        email: uniqueEmail('m2b3a-upgrade'),
        passwordHash: '$argon2id$stub',
        role: 'author',
        status: 'active',
        mustChangePassword: false,
      },
    });
    const work = await db.work.create({
      data: {
        authorId: user.id,
        title: `B3A升级-${uniqueEmail('t')}`,
        genreRulePackage: 'xuanhuan',
      },
    });

    await updateDirection(db, {
      workId: work.id,
      authorId: user.id,
      values: { subGenre: '仙侠修真', goldenFinger: '残破玉佩', toneStyle: '冷峻克制' },
      meta: META,
    });

    const realm = await createEntity(db, {
      workId: work.id,
      authorId: user.id,
      entityType: 'realm_level',
      name: '炼气',
      attributes: { minorLevelCount: 9, breakthroughCondition: '引气入体', lifespan: '一百年' },
      meta: META,
    });
    const faction = await createEntity(db, {
      workId: work.id,
      authorId: user.id,
      entityType: 'faction',
      name: '青云宗',
      attributes: { type: 'sect', tier: '一流' },
      meta: META,
    });
    await createEntity(db, {
      workId: work.id,
      authorId: user.id,
      entityType: 'character',
      name: '林青',
      attributes: { identity: '外门弟子', initialRealm: realm.id, faction: faction.id },
      meta: META,
    });

    // ---------- 2. 手工补历史契约行（模拟 M2-A / M2-B1 遗留） ----------
    // 2a. 与 3.0.0 **同键**：三代同键，用来证明升级不会撞唯一索引
    await raw.query(
      `INSERT INTO work_settings (id, work_id, setting_key, setting_value, schema_ref, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'toneStyle', '"旧语气"'::jsonb, 'xuanhuan@1.0.0', now(), now()),
              (gen_random_uuid(), $1, 'toneStyle', '"二代语气"'::jsonb, 'xuanhuan@2.0.0', now(), now())`,
      [work.id],
    );
    await raw.query(
      `INSERT INTO entity_attributes (id, entity_id, attr_key, attr_value, schema_ref, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'lifespan', '"一千年"'::jsonb, 'xuanhuan@1.0.0', now(), now()),
              (gen_random_uuid(), $1, 'lifespan', '"两千年"'::jsonb, 'xuanhuan@2.0.0', now(), now()),
              (gen_random_uuid(), $1, 'legacyOnly', '"旧契约专属"'::jsonb, 'xuanhuan@2.0.0', now(), now())`,
      [realm.id],
    );

    // ---------- 3. 记录升级前状态 ----------
    const legacy1Before = await legacySnapshot(handle, 'xuanhuan@1.0.0');
    const legacy2Before = await legacySnapshot(handle, 'xuanhuan@2.0.0');
    expect(legacy1Before['work_settings']).not.toBeNull();
    expect(legacy1Before['entity_attributes']).not.toBeNull();
    expect(legacy2Before['work_settings']).not.toBeNull();
    expect(legacy2Before['entity_attributes']).not.toBeNull();

    const beforeCenter = await getSettingsCenter(db, { workId: work.id, authorId: user.id });
    expect(beforeCenter.direction['subGenre']).toBe('仙侠修真');
    const beforeRealm = beforeCenter.entityGroups.find((g) => g.entityType === 'realm_level');
    expect(beforeRealm?.entities[0]?.attributes['lifespan']).toBe('一百年');
    // 升级前只有三个分组
    expect(beforeCenter.entityGroups.map((g) => g.entityType)).toEqual([
      'realm_level',
      'faction',
      'character',
    ]);

    // ---------- 4. 执行真实迁移（读文件原文，避免与迁移漂移） ----------
    await raw.query(readMigration(V4_MIGRATION));

    // ---------- 5. 断言 ----------
    const after = await raw.query<{
      version: string;
      fs: string;
      wd: string;
      rl: string;
      fa: string;
      ch: string;
      it: string;
      te: string;
    }>(
      `SELECT version,
              field_schema->>'version' AS fs,
              field_schema->'workDirection'->>'schemaRef' AS wd,
              field_schema->'entityTypes'->'realm_level'->>'schemaRef' AS rl,
              field_schema->'entityTypes'->'faction'->>'schemaRef' AS fa,
              field_schema->'entityTypes'->'character'->>'schemaRef' AS ch,
              field_schema->'entityTypes'->'item'->>'schemaRef' AS it,
              field_schema->'entityTypes'->'technique'->>'schemaRef' AS te
         FROM rule_packages WHERE code='xuanhuan'`,
    );
    const row = after.rows[0];
    expect(row?.version).toBe('4.0.0');
    expect(row?.fs).toBe('4');
    for (const ref of [row?.wd, row?.rl, row?.fa, row?.ch, row?.it, row?.te]) {
      expect(ref).toBe('xuanhuan@4.0.0');
    }

    // 3.0.0 应全部消失（本次迁移的唯一变更对象）
    const remaining3 = await raw.query<{ n: string }>(
      `SELECT
         (SELECT count(*) FROM work_settings WHERE schema_ref='xuanhuan@3.0.0')
       + (SELECT count(*) FROM entity_attributes WHERE schema_ref='xuanhuan@3.0.0') AS n`,
    );
    expect(remaining3.rows[0]?.n).toBe('0');

    // 1.0.0 / 2.0.0 必须**原样不动**：行数与内容都相同
    expect(await legacySnapshot(handle, 'xuanhuan@1.0.0')).toEqual(legacy1Before);
    expect(await legacySnapshot(handle, 'xuanhuan@2.0.0')).toEqual(legacy2Before);

    // 作者可见数据逐字段一致（升级后按 4.0.0 读取）
    const afterCenter = await getSettingsCenter(db, { workId: work.id, authorId: user.id });
    expect(afterCenter.direction).toEqual(beforeCenter.direction);
    for (const entityType of ['realm_level', 'faction', 'character']) {
      const beforeGroup = beforeCenter.entityGroups.find((g) => g.entityType === entityType);
      const afterGroup = afterCenter.entityGroups.find((g) => g.entityType === entityType);
      expect(afterGroup?.entities).toEqual(beforeGroup?.entities);
    }
    // 历史契约行不得被重新暴露
    const afterRealm = afterCenter.entityGroups.find((g) => g.entityType === 'realm_level');
    expect(afterRealm?.entities[0]?.attributes['lifespan']).toBe('一百年');
    expect(afterRealm?.entities[0]?.attributes['legacyOnly']).toBeUndefined();

    // 升级后设定中心出现五个分组，顺序按组级 order
    expect(afterCenter.entityGroups.map((g) => g.entityType)).toEqual([
      'realm_level',
      'faction',
      'character',
      'item',
      'technique',
    ]);
    expect(afterCenter.entityGroups.map((g) => g.order)).toEqual([1, 2, 3, 4, 5]);
    expect(afterCenter.entityGroups.map((g) => g.title)).toEqual([
      '境界体系',
      '势力',
      '人物',
      '物品',
      '功法',
    ]);

    // ---------- 6. 新类型立即可用：item 创建 + technique 引用境界 ----------
    const item = await createEntity(db, {
      workId: work.id,
      authorId: user.id,
      entityType: 'item',
      name: '青锋剑',
      attributes: { category: 'weapon', quality: 'mystic', acquisition: '秘境所得' },
      meta: META,
    });
    expect(item.entityType).toBe('item');

    const technique = await createEntity(db, {
      workId: work.id,
      authorId: user.id,
      entityType: 'technique',
      name: '青元剑诀',
      attributes: { type: 'cultivation', realmRequirement: realm.id, effect: '剑气纵横' },
      meta: META,
    });
    expect(technique.attributes['realmRequirement']).toBe(realm.id);

    // 删除被功法引用的境界 → 409 语义（ENTITY_IN_USE）
    await expect(
      deleteEntity(db, { workId: work.id, authorId: user.id, entityId: realm.id, meta: META }),
    ).rejects.toMatchObject({ code: 'ENTITY_IN_USE' });

    // 迁移幂等：再执行一次不应报错、也不改变任何行
    const beforeSecond = await raw.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM work_settings) + (SELECT count(*) FROM entity_attributes) AS n`,
    );
    await raw.query(readMigration(V4_MIGRATION));
    const afterSecond = await raw.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM work_settings) + (SELECT count(*) FROM entity_attributes) AS n`,
    );
    expect(afterSecond.rows[0]?.n).toBe(beforeSecond.rows[0]?.n);
  }, 120_000);
});
