/**
 * M2-B2 升级路径测试：规则包 xuanhuan@2.0.0 → 3.0.0。
 *
 * 要证明的四件事：
 * 1. 迁移只改 `2.0.0`，`1.0.0` 的历史行**行数与内容都不变**；
 * 2. 存在"跨版本同键重复"（同一 work_id+setting_key / entity_id+attr_key
 *    同时有 1.0.0 与 2.0.0 两行）时，迁移**不会因唯一索引失败**；
 *    —— 这也是"不写 DELETE 合并"能成立的前提；
 * 3. 作者升级前能看到的数据，升级后**逐字段相同**（不是数行数，是语义相等）；
 * 4. 升级后规则包版本、field_schema.version、各字段组 schemaRef 三者恒等。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEntity, getSettingsCenter, updateDirection } from '../src/entities.js';
import { uniqueEmail } from './helpers/db.js';
import { createDbBeforeMigration, readMigration, type UpgradeDb } from './helpers/upgrade-db.js';

const V3_MIGRATION = '20261102000000_m2b2_character_faction';
const META = { ip: '203.0.113.61', userAgent: 'vitest' };

describe('M2-B2 迁移：xuanhuan@2.0.0 → 3.0.0 升级路径', () => {
  let handle: UpgradeDb;

  beforeAll(async () => {
    handle = await createDbBeforeMigration('m2b2', V3_MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await handle?.dispose();
  }, 60_000);

  it('升级只动 2.0.0：1.0.0 行数内容不变、作者可见数据逐字段一致', async () => {
    const { db, raw } = handle;

    // ---------- 1. 构造"升级前"的真实数据（走服务层，契约是 2.0.0） ----------
    const before2 = await raw.query<{ version: string; fs: string }>(
      `SELECT version, field_schema->>'version' AS fs FROM rule_packages WHERE code='xuanhuan'`,
    );
    expect(before2.rows[0]?.version).toBe('2.0.0');
    expect(before2.rows[0]?.fs).toBe('2');

    const user = await db.user.create({
      data: {
        email: uniqueEmail('m2b2-upgrade'),
        passwordHash: '$argon2id$stub',
        role: 'author',
        status: 'active',
        mustChangePassword: false,
      },
    });
    const work = await db.work.create({
      data: {
        authorId: user.id,
        title: `升级测试-${uniqueEmail('t')}`,
        genreRulePackage: 'xuanhuan',
      },
    });

    // 作品方向（写入 work_settings，schema_ref = xuanhuan@2.0.0）
    await updateDirection(db, {
      workId: work.id,
      authorId: user.id,
      values: { subGenre: '仙侠修真', goldenFinger: '残破玉佩', toneStyle: '冷峻克制' },
      meta: META,
    });

    // 境界实体（写入 entity_attributes，schema_ref = xuanhuan@2.0.0）
    const realm = await createEntity(db, {
      workId: work.id,
      authorId: user.id,
      entityType: 'realm_level',
      name: '炼气',
      attributes: {
        minorLevelCount: 9,
        breakthroughCondition: '引气入体',
        lifespan: '一百年',
      },
      meta: META,
    });

    // ---------- 2. 手工补 1.0.0 历史行（模拟 M2-A 遗留） ----------
    // 2a. 与 2.0.0 **同键**：用来证明升级不会撞唯一索引
    await raw.query(
      `INSERT INTO work_settings (id, work_id, setting_key, setting_value, schema_ref, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'toneStyle', '"热血激昂"'::jsonb, 'xuanhuan@1.0.0', now(), now())`,
      [work.id],
    );
    await raw.query(
      `INSERT INTO entity_attributes (id, entity_id, attr_key, attr_value, schema_ref, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'lifespan', '"一千年"'::jsonb, 'xuanhuan@1.0.0', now(), now())`,
      [realm.id],
    );
    // 2b. 只在 1.0.0 存在的键：升级前后都应"看不见但仍在库里"
    await raw.query(
      `INSERT INTO entity_attributes (id, entity_id, attr_key, attr_value, schema_ref, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'legacyOnly', '"旧契约专属"'::jsonb, 'xuanhuan@1.0.0', now(), now())`,
      [realm.id],
    );

    // ---------- 3. 记录升级前状态 ----------
    const legacyBefore = await raw.query<{ table_name: string; payload: string }>(
      `SELECT 'work_settings' AS table_name, jsonb_agg(jsonb_build_object('k', setting_key, 'v', setting_value) ORDER BY setting_key)::text AS payload
         FROM work_settings WHERE schema_ref = 'xuanhuan@1.0.0'
       UNION ALL
       SELECT 'entity_attributes', jsonb_agg(jsonb_build_object('k', attr_key, 'v', attr_value) ORDER BY attr_key)::text
         FROM entity_attributes WHERE schema_ref = 'xuanhuan@1.0.0'`,
    );
    const legacySnapshot = Object.fromEntries(
      legacyBefore.rows.map((row) => [row.table_name, row.payload]),
    );
    expect(legacySnapshot['work_settings'], '1.0.0 的 work_settings 夹具应存在').not.toBeNull();
    expect(legacySnapshot['entity_attributes']).not.toBeNull();

    const beforeCenter = await getSettingsCenter(db, { workId: work.id, authorId: user.id });
    expect(beforeCenter.direction['subGenre']).toBe('仙侠修真');
    expect(beforeCenter.direction['toneStyle']).toBe('冷峻克制');
    const beforeRealm = beforeCenter.entityGroups.find((g) => g.entityType === 'realm_level');
    expect(beforeRealm?.entities[0]?.attributes['lifespan']).toBe('一百年');
    // 升级前只有 realm_level 一组
    expect(beforeCenter.entityGroups.map((g) => g.entityType)).toEqual(['realm_level']);

    // ---------- 4. 执行真实迁移（读文件原文，避免与迁移漂移） ----------
    await raw.query(readMigration(V3_MIGRATION));

    // ---------- 5. 断言 ----------
    const after = await raw.query<{
      version: string;
      fs: string;
      wd: string;
      rl: string;
      fa: string;
      ch: string;
    }>(
      `SELECT version,
              field_schema->>'version' AS fs,
              field_schema->'workDirection'->>'schemaRef' AS wd,
              field_schema->'entityTypes'->'realm_level'->>'schemaRef' AS rl,
              field_schema->'entityTypes'->'faction'->>'schemaRef' AS fa,
              field_schema->'entityTypes'->'character'->>'schemaRef' AS ch
         FROM rule_packages WHERE code='xuanhuan'`,
    );
    const row = after.rows[0];
    expect(row?.version).toBe('3.0.0');
    expect(row?.fs).toBe('3');
    expect(row?.wd).toBe('xuanhuan@3.0.0');
    expect(row?.rl).toBe('xuanhuan@3.0.0');
    expect(row?.fa).toBe('xuanhuan@3.0.0');
    expect(row?.ch).toBe('xuanhuan@3.0.0');

    // 2.0.0 应全部消失（本次迁移的唯一变更对象）
    const remaining2 = await raw.query<{ n: string }>(
      `SELECT
         (SELECT count(*) FROM work_settings WHERE schema_ref='xuanhuan@2.0.0')
       + (SELECT count(*) FROM entity_attributes WHERE schema_ref='xuanhuan@2.0.0') AS n`,
    );
    expect(remaining2.rows[0]?.n).toBe('0');

    // 1.0.0 必须**原样不动**：行数与内容都相同
    const legacyAfter = await raw.query<{ table_name: string; payload: string }>(
      `SELECT 'work_settings' AS table_name, jsonb_agg(jsonb_build_object('k', setting_key, 'v', setting_value) ORDER BY setting_key)::text AS payload
         FROM work_settings WHERE schema_ref = 'xuanhuan@1.0.0'
       UNION ALL
       SELECT 'entity_attributes', jsonb_agg(jsonb_build_object('k', attr_key, 'v', attr_value) ORDER BY attr_key)::text
         FROM entity_attributes WHERE schema_ref = 'xuanhuan@1.0.0'`,
    );
    const legacyAfterMap = Object.fromEntries(
      legacyAfter.rows.map((r) => [r.table_name, r.payload]),
    );
    expect(legacyAfterMap['work_settings']).toBe(legacySnapshot['work_settings']);
    expect(legacyAfterMap['entity_attributes']).toBe(legacySnapshot['entity_attributes']);

    // 作者可见数据逐字段一致（升级后按 3.0.0 读取）
    const afterCenter = await getSettingsCenter(db, { workId: work.id, authorId: user.id });
    expect(afterCenter.direction).toEqual(beforeCenter.direction);
    const afterRealm = afterCenter.entityGroups.find((g) => g.entityType === 'realm_level');
    expect(afterRealm?.entities[0]?.attributes).toEqual(beforeRealm?.entities[0]?.attributes);
    expect(afterRealm?.entities[0]?.name).toBe('炼气');

    // 升级后设定中心出现三个分组，顺序按组级 order
    expect(afterCenter.entityGroups.map((g) => g.entityType)).toEqual([
      'realm_level',
      'faction',
      'character',
    ]);
    expect(afterCenter.entityGroups.map((g) => g.order)).toEqual([1, 2, 3]);
    // 新类型初始为空
    expect(afterCenter.entityGroups[1]?.entities).toEqual([]);
    expect(afterCenter.entityGroups[2]?.entities).toEqual([]);

    // 迁移幂等：再执行一次不应报错、也不改变任何行
    const beforeSecond = await raw.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM work_settings) + (SELECT count(*) FROM entity_attributes) AS n`,
    );
    await raw.query(readMigration(V3_MIGRATION));
    const afterSecond = await raw.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM work_settings) + (SELECT count(*) FROM entity_attributes) AS n`,
    );
    expect(afterSecond.rows[0]?.n).toBe(beforeSecond.rows[0]?.n);
  }, 120_000);
});
