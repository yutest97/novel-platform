/**
 * M2-B3-B1 迁移测试：`item_events`。
 *
 * 要证明的四件事：
 * 1. 第 7 个迁移能干净应用到"已经有 v4 数据"的库上，**不改动任何既有数据**
 *    （规则包仍是 4.0.0，不产生 v5 —— 本轮不碰 field_schema）；
 * 2. 表级 CHECK 真的挡得住坏行（事件类型、持有人形态、序号、幂等键、备注长度）；
 * 3. 三个唯一索引各自生效（seq、幂等键、reversal_of）；
 * 4. append-only 触发器让 UPDATE / DELETE **直接 SQL 也失败**。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uniqueEmail } from './helpers/db.js';
import { createDbBeforeMigration, readMigration, type UpgradeDb } from './helpers/upgrade-db.js';

const MIGRATION = '20261104000000_m2b3b_item_events';

/** 需要逐字比对的表（升级前后必须完全一致）。 */
const FROZEN_TABLES: { table: string; orderBy: string }[] = [
  { table: 'rule_packages', orderBy: 'code' },
  { table: 'works', orderBy: 'id' },
  { table: 'work_settings', orderBy: 'id' },
  { table: 'entities', orderBy: 'id' },
  { table: 'entity_attributes', orderBy: 'id' },
  { table: 'entity_versions', orderBy: 'id' },
  { table: 'audit_logs', orderBy: 'id' },
];

async function snapshotTables(handle: UpgradeDb): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const { table, orderBy } of FROZEN_TABLES) {
    const result = await handle.raw.query<{ payload: string | null }>(
      `SELECT jsonb_agg(t ORDER BY ${orderBy})::text AS payload FROM "${table}" t`,
    );
    snapshot[table] = result.rows[0]?.payload ?? 'null';
  }
  return snapshot;
}

describe('M2-B3-B1 迁移：item_events', () => {
  let handle: UpgradeDb;
  let workId: string;
  let itemId: string;
  let characterId: string;
  let otherCharacterId: string;

  beforeAll(async () => {
    handle = await createDbBeforeMigration('m2b3b', MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await handle?.dispose();
  }, 60_000);

  it('应用到已有 v4 数据的库：既有数据逐字节不变，规则包仍是 4.0.0', async () => {
    const { db, raw } = handle;

    // ---------- 1. 造"升级前"的真实数据 ----------
    const user = await db.user.create({
      data: {
        email: uniqueEmail('m2b3b-upgrade'),
        passwordHash: '$argon2id$stub',
        role: 'author',
        status: 'active',
        mustChangePassword: false,
      },
    });
    const work = await db.work.create({
      data: {
        authorId: user.id,
        title: `B3B升级-${uniqueEmail('t')}`,
        genreRulePackage: 'xuanhuan',
      },
    });
    workId = work.id;

    const character = await db.entity.create({
      data: { workId, entityType: 'character', name: '林青', orderIndex: 1 },
    });
    characterId = character.id;
    const other = await db.entity.create({
      data: { workId, entityType: 'character', name: '苏沐', orderIndex: 2 },
    });
    otherCharacterId = other.id;

    const item = await db.entity.create({
      data: { workId, entityType: 'item', name: '青锋剑', orderIndex: 1 },
    });
    itemId = item.id;

    await db.entityAttribute.createMany({
      data: [
        { entityId: itemId, attrKey: 'category', attrValue: 'weapon', schemaRef: 'xuanhuan@4.0.0' },
        { entityId: itemId, attrKey: 'quality', attrValue: 'mystic', schemaRef: 'xuanhuan@4.0.0' },
      ],
    });
    await db.entityVersion.create({
      data: { entityId: itemId, versionNo: 1, snapshot: { name: '青锋剑' } },
    });
    await db.workSetting.create({
      data: {
        workId,
        settingKey: 'subGenre',
        settingValue: '东方玄幻',
        schemaRef: 'xuanhuan@4.0.0',
      },
    });

    const before = await snapshotTables(handle);
    const ruleBefore = await raw.query<{ version: string; schema: string }>(
      `SELECT version, field_schema::text AS schema FROM rule_packages WHERE code='xuanhuan'`,
    );
    expect(ruleBefore.rows[0]?.version).toBe('4.0.0');

    // ---------- 2. 执行真实迁移原文 ----------
    await raw.query(readMigration(MIGRATION));

    // ---------- 3. 既有数据一个字节都没变 ----------
    const after = await snapshotTables(handle);
    expect(after).toEqual(before);

    const ruleAfter = await raw.query<{ version: string; schema: string }>(
      `SELECT version, field_schema::text AS schema FROM rule_packages WHERE code='xuanhuan'`,
    );
    expect(ruleAfter.rows[0]?.version).toBe('4.0.0');
    expect(ruleAfter.rows[0]?.schema).toBe(ruleBefore.rows[0]?.schema);

    // ---------- 4. 新表存在且为空 ----------
    const count = await raw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM item_events`,
    );
    expect(count.rows[0]?.count).toBe('0');
  });

  it('CHECK 约束拒绝坏行：事件类型 / 持有人形态 / 序号 / 幂等键 / 备注', async () => {
    const { raw } = handle;
    const insert = (values: {
      eventType: string;
      from?: string | null;
      to?: string | null;
      seqNo?: number;
      key?: string;
      note?: string | null;
    }): Promise<unknown> =>
      raw.query(
        `INSERT INTO item_events
           (id, work_id, item_entity_id, event_type, from_holder, to_holder, seq_no, idempotency_key, note)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          workId,
          itemId,
          values.eventType,
          values.from ?? null,
          values.to ?? null,
          values.seqNo ?? 1,
          values.key ?? `bad-${Math.random().toString(36).slice(2, 12)}`,
          values.note ?? null,
        ],
      );

    // 未知事件类型
    await expect(insert({ eventType: 'melted', to: characterId })).rejects.toThrow(
      /item_events_holder_shape_check|item_events_event_type_check/,
    );

    // obtained 不允许带 from
    await expect(
      insert({ eventType: 'obtained', from: characterId, to: otherCharacterId }),
    ).rejects.toThrow(/item_events_holder_shape_check/);

    // obtained 必须有 to
    await expect(insert({ eventType: 'obtained', to: null })).rejects.toThrow(
      /item_events_holder_shape_check/,
    );

    // transferred 的 from / to 必须不同
    await expect(
      insert({ eventType: 'transferred', from: characterId, to: characterId }),
    ).rejects.toThrow(/item_events_holder_shape_check/);

    // consumed 不允许带 to
    await expect(
      insert({ eventType: 'consumed', from: characterId, to: otherCharacterId }),
    ).rejects.toThrow(/item_events_holder_shape_check/);

    // 序号必须 >= 1
    await expect(insert({ eventType: 'obtained', to: characterId, seqNo: 0 })).rejects.toThrow(
      /item_events_seq_no_check/,
    );

    // 幂等键太短
    await expect(insert({ eventType: 'obtained', to: characterId, key: 'short' })).rejects.toThrow(
      /item_events_idempotency_key_length_check/,
    );

    // 备注超长
    await expect(
      insert({ eventType: 'obtained', to: characterId, note: 'x'.repeat(501) }),
    ).rejects.toThrow(/item_events_note_length_check/);

    // 一条都没写进去
    const count = await raw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM item_events`,
    );
    expect(count.rows[0]?.count).toBe('0');
  });

  it('三个唯一索引：seq、幂等键、reversal_of', async () => {
    const { raw } = handle;
    const base = (overrides: {
      seqNo: number;
      key: string;
      reversalOf?: string | null;
    }): Promise<unknown> =>
      raw.query(
        `INSERT INTO item_events
           (id, work_id, item_entity_id, event_type, from_holder, to_holder, seq_no, idempotency_key, reversal_of)
         VALUES (gen_random_uuid(), $1, $2, 'obtained', NULL, $3, $4, $5, $6)`,
        [workId, itemId, characterId, overrides.seqNo, overrides.key, overrides.reversalOf ?? null],
      );

    const first = await raw.query<{ id: string }>(
      `INSERT INTO item_events
         (id, work_id, item_entity_id, event_type, from_holder, to_holder, seq_no, idempotency_key)
       VALUES (gen_random_uuid(), $1, $2, 'obtained', NULL, $3, 1, 'unique-base-key')
       RETURNING id`,
      [workId, itemId, characterId],
    );
    const baseId = first.rows[0]?.id as string;

    // 同一物品 seq 重复
    await expect(base({ seqNo: 1, key: 'another-key-1' })).rejects.toThrow(
      /item_events_item_entity_id_seq_no_key/,
    );
    // 同一物品幂等键重复
    await expect(base({ seqNo: 2, key: 'unique-base-key' })).rejects.toThrow(
      /item_events_item_entity_id_idempotency_key_key/,
    );

    // reversal_of 唯一：两条冲正指向同一个目标
    await raw.query(
      `INSERT INTO item_events
         (id, work_id, item_entity_id, event_type, from_holder, to_holder, seq_no, idempotency_key, reversal_of)
       VALUES (gen_random_uuid(), $1, $2, 'lost', $3, NULL, 2, 'reversal-key-1', $4)`,
      [workId, itemId, characterId, baseId],
    );
    await expect(
      raw.query(
        `INSERT INTO item_events
           (id, work_id, item_entity_id, event_type, from_holder, to_holder, seq_no, idempotency_key, reversal_of)
         VALUES (gen_random_uuid(), $1, $2, 'lost', $3, NULL, 3, 'reversal-key-2', $4)`,
        [workId, itemId, characterId, baseId],
      ),
    ).rejects.toThrow(/item_events_reversal_of_key/);
  });

  it('append-only：直接 SQL 的 UPDATE / DELETE 也失败', async () => {
    const { raw } = handle;
    const row = await raw.query<{ id: string }>(
      `SELECT id FROM item_events ORDER BY seq_no LIMIT 1`,
    );
    const id = row.rows[0]?.id as string;

    await expect(
      raw.query(`UPDATE item_events SET note = 'tampered' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23001' });

    await expect(raw.query(`DELETE FROM item_events WHERE id = $1`, [id])).rejects.toMatchObject({
      code: '23001',
    });

    // 行仍然在，内容没变
    const after = await raw.query<{ note: string | null }>(
      `SELECT note FROM item_events WHERE id = $1`,
      [id],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.note).toBeNull();
  });
});
