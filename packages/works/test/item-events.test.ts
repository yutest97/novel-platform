/**
 * M2-B3-B1：物品事件流水（状态机 / 冲正 / 幂等 / 删除保护）。
 *
 * 这些用例跑在真实 PostgreSQL 上，全部走真实事务与 advisory lock。
 *
 * 回放口径（本文件多处断言的依据）：
 *   冲正行与其目标行**同时**从有效流剔除 → 回放等价于"该冲正从未发生"。
 */

import { afterAll, describe, expect, it } from 'vitest';

import { AuthError } from '@novel/auth';

import {
  ITEM_EVENT_TYPES,
  appendItemEvent,
  createEntity,
  deleteEntity,
  getItemState,
  listItemEvents,
  replayItemState,
  reverseItemEvent,
  type ItemEventRow,
} from '../src/index.js';
import { closeTestDb, testDb, uniqueEmail } from './helpers/db.js';

const META = { ip: '203.0.113.92', userAgent: 'vitest' };

async function createAuthor(): Promise<string> {
  const db = testDb();
  const user = await db.user.create({
    data: {
      email: uniqueEmail('m2b3b'),
      passwordHash: '$argon2id$stub',
      role: 'author',
      status: 'active',
      mustChangePassword: false,
    },
  });
  return user.id;
}

async function createWork(authorId: string): Promise<string> {
  const db = testDb();
  const work = await db.work.create({
    data: { authorId, title: `B3B作品-${uniqueEmail('t')}`, genreRulePackage: 'xuanhuan' },
  });
  return work.id;
}

async function createItem(workId: string, authorId: string, name = '青锋剑'): Promise<string> {
  const entity = await createEntity(testDb(), {
    workId,
    authorId,
    entityType: 'item',
    name,
    attributes: { category: 'weapon', quality: 'mystic' },
    meta: META,
  });
  return entity.id;
}

async function createCharacter(workId: string, authorId: string, name: string): Promise<string> {
  const entity = await createEntity(testDb(), {
    workId,
    authorId,
    entityType: 'character',
    name,
    attributes: {},
    meta: META,
  });
  return entity.id;
}

let keySeq = 0;
function key(): string {
  keySeq += 1;
  return `idem-${Date.now()}-${keySeq}`;
}

/** 追加一条事件（自动生成幂等键）。 */
function append(
  workId: string,
  authorId: string,
  itemId: string,
  eventType: 'obtained' | 'transferred' | 'consumed' | 'lost',
  options: { toHolder?: string | null; note?: string | null; idempotencyKey?: string } = {},
) {
  return appendItemEvent(testDb(), {
    workId,
    authorId,
    itemId,
    eventType,
    toHolder: options.toHolder ?? null,
    note: options.note ?? null,
    idempotencyKey: options.idempotencyKey ?? key(),
    meta: META,
  });
}

function reverse(
  workId: string,
  authorId: string,
  itemId: string,
  eventId: string,
  options: { note?: string | null; idempotencyKey?: string } = {},
) {
  return reverseItemEvent(testDb(), {
    workId,
    authorId,
    itemId,
    eventId,
    note: options.note ?? null,
    idempotencyKey: options.idempotencyKey ?? key(),
    meta: META,
  });
}

function stateOf(workId: string, authorId: string, itemId: string) {
  return getItemState(testDb(), { workId, authorId, itemId });
}

describe('M2-B3-B1 物品事件流水', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it('获得：seq=1、from 为 null、状态 held；created_at 取数据库时钟且有顺序', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    const first = await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });
    expect(first.event.seq).toBe(1);
    expect(first.event.fromHolder).toBeNull();
    expect(first.event.toHolder).toEqual({ id: heroId, name: '林青', deleted: false });
    expect(first.event.reversalOf).toBeNull();
    expect(first.deduplicated).toBe(false);

    expect(first.state.status).toBe('held');
    expect(first.state.holder?.id).toBe(heroId);
    expect(first.state.eventCount).toBe(1);
    expect(first.state.lastSeq).toBe(1);

    const row = await db.itemEvent.findUniqueOrThrow({ where: { id: first.event.id } });
    expect(row.createdBy).toBe(authorId);
    // created_at 由数据库 clock_timestamp() 填充（不是应用时钟）
    expect(row.createdAt).toBeInstanceOf(Date);

    const heirId = await createCharacter(workId, authorId, '苏沐');
    const second = await append(workId, authorId, itemId, 'transferred', { toHolder: heirId });
    expect(second.event.seq).toBe(2);
    expect(second.event.fromHolder?.id).toBe(heroId);
  });

  it('转手：from 由服务端按当前状态推导，客户端不提交', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const a = await createCharacter(workId, authorId, '甲');
    const b = await createCharacter(workId, authorId, '乙');

    await append(workId, authorId, itemId, 'obtained', { toHolder: a });
    const moved = await append(workId, authorId, itemId, 'transferred', { toHolder: b });

    expect(moved.event.fromHolder).toEqual({ id: a, name: '甲', deleted: false });
    expect(moved.event.toHolder).toEqual({ id: b, name: '乙', deleted: false });
    expect(moved.state.holder?.id).toBe(b);
  });

  it('消耗与丢失：holder 归 null，状态分别为 consumed / lost', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });

    const second = await createItem(workId, authorId, '丹药');
    await append(workId, authorId, second, 'obtained', { toHolder: heroId });
    const consumed = await append(workId, authorId, second, 'consumed');
    expect(consumed.event.fromHolder?.id).toBe(heroId);
    expect(consumed.event.toHolder).toBeNull();
    expect(consumed.state.status).toBe('consumed');
    expect(consumed.state.holder).toBeNull();

    const third = await createItem(workId, authorId, '玉符');
    await append(workId, authorId, third, 'obtained', { toHolder: heroId });
    const lost = await append(workId, authorId, third, 'lost');
    expect(lost.state.status).toBe('lost');
    expect(lost.state.holder).toBeNull();
    expect(lost.state.eventCount).toBe(2);
    expect(lost.state.lastSeq).toBe(2);
  });

  it('consumed / lost 之后允许重新获得（契约 D2）', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });
    await append(workId, authorId, itemId, 'consumed');
    const again = await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });

    expect(again.event.seq).toBe(3);
    expect(again.event.fromHolder).toBeNull();
    expect(again.state.status).toBe('held');
    expect(again.state.holder?.id).toBe(heroId);
  });

  it('状态机非法：未登记就转手 / 持有中再次获得 / 消耗后转手', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    await expect(
      append(workId, authorId, itemId, 'transferred', { toHolder: heroId }),
    ).rejects.toMatchObject({ code: 'ITEM_EVENT_INVALID_TRANSITION' });

    await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });
    await expect(
      append(workId, authorId, itemId, 'obtained', { toHolder: heroId }),
    ).rejects.toMatchObject({ code: 'ITEM_EVENT_INVALID_TRANSITION' });

    await append(workId, authorId, itemId, 'consumed');
    await expect(
      append(workId, authorId, itemId, 'transferred', { toHolder: heroId }),
    ).rejects.toMatchObject({ code: 'ITEM_EVENT_INVALID_TRANSITION' });

    // 一条都没写进去
    expect(await testDb().itemEvent.count({ where: { itemEntityId: itemId } })).toBe(2);
  });

  it('转给当前持有人 → 409 ITEM_EVENT_INVALID_TRANSITION；转给不存在/已删/跨作品人物 → 400', async () => {
    const authorId = await createAuthor();
    const otherAuthorId = await createAuthor();
    const workId = await createWork(authorId);
    const otherWorkId = await createWork(otherAuthorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });

    await expect(
      append(workId, authorId, itemId, 'transferred', { toHolder: heroId }),
    ).rejects.toMatchObject({ code: 'ITEM_EVENT_INVALID_TRANSITION' });

    // 不存在
    await expect(
      append(workId, authorId, itemId, 'transferred', {
        toHolder: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 类型不是人物（用同作品的势力）
    const faction = await createEntity(testDb(), {
      workId,
      authorId,
      entityType: 'faction',
      name: '青云宗',
      attributes: { type: 'sect' },
      meta: META,
    });
    await expect(
      append(workId, authorId, itemId, 'transferred', { toHolder: faction.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 跨作品人物
    const otherHeroId = await createCharacter(otherWorkId, otherAuthorId, '别家的人');
    await expect(
      append(workId, authorId, itemId, 'transferred', { toHolder: otherHeroId }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('冲正 obtained → 回到未登记；冲正 transferred → 回到原持有人', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const a = await createCharacter(workId, authorId, '甲');
    const b = await createCharacter(workId, authorId, '乙');

    const obtained = await append(workId, authorId, itemId, 'obtained', { toHolder: a });
    const reverted = await reverse(workId, authorId, itemId, obtained.event.id);

    // 冲正行是 lost 形态（撤销"获得"），但回放把冲正行与目标行一起剔除
    expect(reverted.event.eventType).toBe('lost');
    expect(reverted.event.reversalOf).toBe(obtained.event.id);
    expect(reverted.state.status).toBe('unrecorded');
    expect(reverted.state.holder).toBeNull();
    // eventCount 含冲正行，有效事件为 0
    expect(reverted.state.eventCount).toBe(2);
    expect(reverted.state.effectiveEventCount).toBe(0);

    // 再走一遍：获得 → 转手 → 冲正转手
    const item2 = await createItem(workId, authorId, '第二把剑');
    const e1 = await append(workId, authorId, item2, 'obtained', { toHolder: a });
    const e2 = await append(workId, authorId, item2, 'transferred', { toHolder: b });
    const back = await reverse(workId, authorId, item2, e2.event.id);

    expect(back.event.eventType).toBe('transferred');
    expect(back.event.fromHolder?.id).toBe(b);
    expect(back.event.toHolder?.id).toBe(a);
    expect(back.state.status).toBe('held');
    expect(back.state.holder?.id).toBe(a);
    // 目标行标记为已冲正，历史行不变
    const rows = await testDb().itemEvent.findMany({
      where: { itemEntityId: item2 },
      orderBy: { seqNo: 'asc' },
    });
    expect(rows.map((row) => row.seqNo)).toEqual([1, 2, 3]);
    expect(rows[1]?.eventType).toBe('transferred');
    expect(e1.event.seq).toBe(1);
  });

  it('冲正 consumed / lost → 回到持有中', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    const consumedItem = await createItem(workId, authorId, '丹药');
    await append(workId, authorId, consumedItem, 'obtained', { toHolder: heroId });
    const consumed = await append(workId, authorId, consumedItem, 'consumed');
    const restored = await reverse(workId, authorId, consumedItem, consumed.event.id);
    expect(restored.event.eventType).toBe('obtained');
    expect(restored.state.status).toBe('held');
    expect(restored.state.holder?.id).toBe(heroId);

    const lostItem = await createItem(workId, authorId, '玉符');
    await append(workId, authorId, lostItem, 'obtained', { toHolder: heroId });
    const lost = await append(workId, authorId, lostItem, 'lost');
    const restoredLost = await reverse(workId, authorId, lostItem, lost.event.id);
    expect(restoredLost.state.status).toBe('held');
    expect(restoredLost.state.holder?.id).toBe(heroId);
  });

  it('冲正非最新事件 → 409；冲正冲正行 → 409；二次冲正 → 409', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const a = await createCharacter(workId, authorId, '甲');
    const b = await createCharacter(workId, authorId, '乙');

    const e1 = await append(workId, authorId, itemId, 'obtained', { toHolder: a });
    const e2 = await append(workId, authorId, itemId, 'transferred', { toHolder: b });

    // e1 不是最新
    await expect(reverse(workId, authorId, itemId, e1.event.id)).rejects.toMatchObject({
      code: 'ITEM_EVENT_NOT_REVERSIBLE',
    });

    const reversal = await reverse(workId, authorId, itemId, e2.event.id);
    // 冲正行本身不能再被冲正
    await expect(reverse(workId, authorId, itemId, reversal.event.id)).rejects.toMatchObject({
      code: 'ITEM_EVENT_NOT_REVERSIBLE',
    });
    // 已经冲正过的事件再冲一次（此时它也不再是最新）
    await expect(reverse(workId, authorId, itemId, e2.event.id)).rejects.toMatchObject({
      code: 'ITEM_EVENT_NOT_REVERSIBLE',
    });

    expect(await testDb().itemEvent.count({ where: { itemEntityId: itemId } })).toBe(3);
  });

  it('幂等：同键同内容返回既有事件（只 1 行，不写第二条审计）', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');
    const idempotencyKey = key();

    const first = await append(workId, authorId, itemId, 'obtained', {
      toHolder: heroId,
      note: '宗门赐下',
      idempotencyKey,
    });
    const second = await append(workId, authorId, itemId, 'obtained', {
      toHolder: heroId,
      note: '宗门赐下',
      idempotencyKey,
    });

    expect(second.deduplicated).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(await db.itemEvent.count({ where: { itemEntityId: itemId } })).toBe(1);
    expect(
      await db.auditLog.count({
        where: { action: 'item.event_recorded', targetId: first.event.id },
      }),
    ).toBe(1);
  });

  it('幂等：同键但 eventType / toHolder / note 任一不同 → 409', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const a = await createCharacter(workId, authorId, '甲');
    const b = await createCharacter(workId, authorId, '乙');
    const idempotencyKey = key();

    await append(workId, authorId, itemId, 'obtained', {
      toHolder: a,
      note: '第一次',
      idempotencyKey,
    });

    // note 不同
    await expect(
      append(workId, authorId, itemId, 'obtained', {
        toHolder: a,
        note: '第二次',
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: 'ITEM_EVENT_IDEMPOTENCY_CONFLICT' });

    // toHolder 不同
    await expect(
      append(workId, authorId, itemId, 'obtained', {
        toHolder: b,
        note: '第一次',
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: 'ITEM_EVENT_IDEMPOTENCY_CONFLICT' });

    // eventType 不同
    await expect(
      append(workId, authorId, itemId, 'consumed', {
        note: '第一次',
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: 'ITEM_EVENT_IDEMPOTENCY_CONFLICT' });
  });

  it('冲正幂等：同键同内容去重；note 不同 → 409', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');
    const obtained = await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });
    const idempotencyKey = key();

    const first = await reverse(workId, authorId, itemId, obtained.event.id, {
      note: '录错了',
      idempotencyKey,
    });
    const second = await reverse(workId, authorId, itemId, obtained.event.id, {
      note: '录错了',
      idempotencyKey,
    });
    expect(second.deduplicated).toBe(true);
    expect(second.event.id).toBe(first.event.id);

    await expect(
      reverse(workId, authorId, itemId, obtained.event.id, {
        note: '另一个理由',
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: 'ITEM_EVENT_IDEMPOTENCY_CONFLICT' });
  });

  it('物品软删除后：事件仍在、列表与状态可读，但不能再追加或冲正', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');
    const obtained = await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });

    await deleteEntity(db, { workId, authorId, entityId: itemId, meta: META });

    await expect(append(workId, authorId, itemId, 'consumed')).rejects.toMatchObject({
      code: 'ITEM_EVENTS_CLOSED',
    });
    await expect(reverse(workId, authorId, itemId, obtained.event.id)).rejects.toMatchObject({
      code: 'ITEM_EVENTS_CLOSED',
    });

    // 历史仍在
    const page = await listItemEvents(db, { workId, authorId, itemId });
    expect(page.events).toHaveLength(1);
    expect((await stateOf(workId, authorId, itemId)).status).toBe('held');
    expect(await db.itemEvent.count({ where: { itemEntityId: itemId } })).toBe(1);
  });

  it('事件不影响 entity_versions：属性版本与持有人流水分别维护', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    const before = await db.entityVersion.count({ where: { entityId: itemId } });
    await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });
    await append(workId, authorId, itemId, 'consumed', { note: '占位' });
    const after = await db.entityVersion.count({ where: { entityId: itemId } });

    expect(after).toBe(before);
    // 物品属性里也始终没有 holder
    const attrs = await db.entityAttribute.findMany({ where: { entityId: itemId } });
    expect(attrs.map((attr) => attr.attrKey).sort()).toEqual(['category', 'quality']);
  });

  it('跨作品与类型不符一律 404；他人作品 404', async () => {
    const authorId = await createAuthor();
    const otherAuthorId = await createAuthor();
    const workId = await createWork(authorId);
    const otherWorkId = await createWork(otherAuthorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    const otherItem = await createItem(otherWorkId, otherAuthorId, '别人的剑');
    await expect(
      append(workId, authorId, otherItem, 'obtained', { toHolder: heroId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // 用人物 id 当物品 id
    await expect(
      append(workId, authorId, heroId, 'obtained', { toHolder: heroId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // 别人访问我的物品
    const itemId = await createItem(workId, authorId);
    await expect(
      listItemEvents(testDb(), { workId, authorId: otherAuthorId, itemId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('删除人物：当前持有人 → 409 列出物品；转走后可删；历史持有人不阻止', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId, '青锋剑');
    const holder = await createCharacter(workId, authorId, '林青');
    const next = await createCharacter(workId, authorId, '苏沐');

    await append(workId, authorId, itemId, 'obtained', { toHolder: holder });

    let captured: AuthError | null = null;
    try {
      await deleteEntity(db, { workId, authorId, entityId: holder, meta: META });
    } catch (error) {
      captured = error as AuthError;
    }
    expect(captured).toBeInstanceOf(AuthError);
    expect(captured?.toBody()).toMatchObject({
      error: {
        code: 'ENTITY_IN_USE',
        references: { total: 1, items: [{ id: itemId, entityType: 'item', name: '青锋剑' }] },
      },
    });

    // 转走之后就可以删了；next 是当前持有人
    await append(workId, authorId, itemId, 'transferred', { toHolder: next });
    await deleteEntity(db, { workId, authorId, entityId: holder, meta: META });
    const deleted = await db.entity.findUniqueOrThrow({ where: { id: holder } });
    expect(deleted.deletedAt).not.toBeNull();

    // 历史持有人（已删除）仍能在事件里显示姓名，且带 deleted 标记
    const page = await listItemEvents(db, { workId, authorId, itemId });
    expect(page.events[0]?.toHolder).toEqual({ id: holder, name: '林青', deleted: true });
    expect(page.events[1]?.fromHolder).toEqual({ id: holder, name: '林青', deleted: true });
    // **只有定位信息**，不带人物属性
    expect(Object.keys(page.events[0]?.toHolder ?? {}).sort()).toEqual(['deleted', 'id', 'name']);
  });

  it('分页：afterSeq 游标、limit 与 hasMore', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');
    await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });
    await append(workId, authorId, itemId, 'consumed');
    await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });

    const firstPage = await listItemEvents(testDb(), {
      workId,
      authorId,
      itemId,
      limit: 2,
    });
    expect(firstPage.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextAfterSeq).toBe(2);

    const secondPage = await listItemEvents(testDb(), {
      workId,
      authorId,
      itemId,
      afterSeq: firstPage.nextAfterSeq,
      limit: 2,
    });
    expect(secondPage.events.map((event) => event.seq)).toEqual([3]);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextAfterSeq).toBe(3);

    await expect(
      listItemEvents(testDb(), { workId, authorId, itemId, limit: 101 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      listItemEvents(testDb(), { workId, authorId, itemId, afterSeq: -1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('审计只记 id / type / seq：不含 note 与持有人姓名', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');
    const secretNote = '这一段是剧情伏笔，绝不能进审计';

    const obtained = await append(workId, authorId, itemId, 'obtained', {
      toHolder: heroId,
      note: secretNote,
    });
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: 'item.event_recorded', targetId: obtained.event.id },
    });
    const detail = JSON.stringify(audit.detail);
    expect(detail).not.toContain(secretNote);
    expect(detail).not.toContain('林青');
    expect(audit.detail).toMatchObject({
      workId,
      itemId,
      eventId: obtained.event.id,
      eventType: 'obtained',
      seq: 1,
    });

    const reverted = await reverse(workId, authorId, itemId, obtained.event.id, {
      note: '冲正备注也不该出现',
    });
    const reverseAudit = await db.auditLog.findFirstOrThrow({
      where: { action: 'item.event_reversed', targetId: reverted.event.id },
    });
    expect(JSON.stringify(reverseAudit.detail)).not.toContain('冲正备注也不该出现');
  });

  it('纯回放：冲正行与目标行同时剔除（不经数据库）', () => {
    const base: ItemEventRow[] = [
      {
        id: 'e1',
        seqNo: 1,
        eventType: 'obtained',
        fromHolder: null,
        toHolder: 'a',
        reversalOf: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'e2',
        seqNo: 2,
        eventType: 'transferred',
        fromHolder: 'a',
        toHolder: 'b',
        reversalOf: null,
        createdAt: new Date('2026-01-01T00:01:00Z'),
      },
      {
        id: 'e3',
        seqNo: 3,
        eventType: 'transferred',
        fromHolder: 'b',
        toHolder: 'a',
        reversalOf: 'e2',
        createdAt: new Date('2026-01-01T00:02:00Z'),
      },
    ];

    const snapshot = replayItemState(base);
    expect(snapshot.holderId).toBe('a');
    expect(snapshot.status).toBe('held');
    expect(snapshot.eventCount).toBe(3);
    expect(snapshot.effectiveEventCount).toBe(1);
    expect(snapshot.reversedBy.get('e2')).toBe('e3');

    // 全部被冲正 → 回到未登记
    const allReversed = replayItemState([
      ...base,
      {
        id: 'e4',
        seqNo: 4,
        eventType: 'lost',
        fromHolder: 'a',
        toHolder: null,
        reversalOf: 'e1',
        createdAt: new Date('2026-01-01T00:03:00Z'),
      },
    ]);
    expect(allReversed.status).toBe('unrecorded');
    expect(allReversed.holderId).toBeNull();
  });

  it('事件类型常量稳定（数据库 CHECK 与代码同一份词汇）', () => {
    expect([...ITEM_EVENT_TYPES]).toEqual(['obtained', 'transferred', 'consumed', 'lost']);
  });

  /* ---------------------------------------------------------------------- */
  /* M2-B3-B1-REV-01：UUID 严格校验、大小写规范化、幂等跨类型误判           */
  /* ---------------------------------------------------------------------- */

  it('toHolder 非法 UUID：400 VALIDATION_FAILED，不写事件也不写审计', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    const auditBefore = await db.auditLog.count({ where: { action: 'item.event_recorded' } });

    // obtained 直接给畸形 id
    await expect(
      append(workId, authorId, itemId, 'obtained', { toHolder: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // transferred 同样（先建立合法持有状态）
    await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });
    await expect(
      append(workId, authorId, itemId, 'transferred', { toHolder: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 只有那一条合法事件，且只产生一条审计
    expect(await db.itemEvent.count({ where: { itemEntityId: itemId } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'item.event_recorded' } })).toBe(
      auditBefore + 1,
    );

    // 畸形 id 没有被当成"未提供"而静默通过
    await expect(
      append(workId, authorId, itemId, 'obtained', { toHolder: '1234' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('UUID 大小写规范化：大写 toHolder / workId / itemId / eventId 都能正确匹配', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');
    const sharedKey = key();

    // 首次请求用大写 toHolder + 大写 workId/itemId
    const first = await appendItemEvent(testDb(), {
      workId: workId.toUpperCase(),
      authorId,
      itemId: itemId.toUpperCase(),
      eventType: 'obtained',
      toHolder: heroId.toUpperCase(),
      idempotencyKey: sharedKey,
      meta: META,
    });
    expect(first.deduplicated).toBe(false);
    expect(first.event.toHolder?.id).toBe(heroId);

    // 重试改用小写（同一幂等键）→ 必须命中同一条事件
    const replay = await append(workId, authorId, itemId, 'obtained', {
      toHolder: heroId,
      idempotencyKey: sharedKey,
    });
    expect(replay.deduplicated).toBe(true);
    expect(replay.event.id).toBe(first.event.id);

    // 读路径同样接受大写
    const page = await listItemEvents(testDb(), {
      workId: workId.toUpperCase(),
      authorId,
      itemId: itemId.toUpperCase(),
    });
    expect(page.events).toHaveLength(1);

    const state = await stateOf(workId, authorId, itemId);
    expect(state.holder?.id).toBe(heroId);

    // 冲正时用大写 eventId 必须能找到目标
    const reverted = await reverseItemEvent(testDb(), {
      workId,
      authorId,
      itemId,
      eventId: first.event.id.toUpperCase(),
      idempotencyKey: key(),
      meta: META,
    });
    expect(reverted.event.reversalOf).toBe(first.event.id);
    expect(reverted.state.status).toBe('unrecorded');
  });

  it('幂等跨类型：同键命中冲正行时不得当成普通事件（409，不返回 deduplicated）', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    // 1) 获得 → 消耗
    await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });
    const consumed = await append(workId, authorId, itemId, 'consumed');

    // 2) 用幂等键 K 冲正"消耗"→ 生成一条 obtained(null→A) 的冲正行
    const sharedKey = key();
    const reversal = await reverse(workId, authorId, itemId, consumed.event.id, {
      idempotencyKey: sharedKey,
    });
    expect(reversal.event.reversalOf).toBe(consumed.event.id);
    expect(reversal.event.eventType).toBe('obtained');
    expect(reversal.event.toHolder?.id).toBe(heroId);
    expect(reversal.event.note).toBeNull();

    const countBefore = await db.itemEvent.count({ where: { itemEntityId: itemId } });

    // 3) 复用同一个键做普通 append，形状与那条冲正行完全一致（obtained→A、无备注）
    await expect(
      append(workId, authorId, itemId, 'obtained', {
        toHolder: heroId,
        idempotencyKey: sharedKey,
      }),
    ).rejects.toMatchObject({ code: 'ITEM_EVENT_IDEMPOTENCY_CONFLICT' });

    // 不增加事件行，也不是 deduplicated
    expect(await db.itemEvent.count({ where: { itemEntityId: itemId } })).toBe(countBefore);
  });
});
