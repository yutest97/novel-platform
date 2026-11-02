/**
 * M2-B3-B1：物品事件的并发边界。
 *
 * 与实体并发测试同一套方法论：
 * - 用**原生连接**从事务外部持锁，构造确定性的阻塞；
 * - 用 Promise.allSettled 构造真实并发，断言"结果集合"而不是执行顺序。
 *
 * 核心命题：
 * 1. 物品事件写与实体写落在**同一把**作品级 advisory lock 上
 *    （锁模块抽取之后仍然如此）；
 * 2. seq_no 在锁内 max+1，并发下连续唯一；
 * 3. 幂等键并发只产生一行；
 * 4. 事件写与物品软删 / 人物删除不会互相穿透。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  WORK_LOCK_NAMESPACE,
  appendItemEvent,
  createEntity,
  deleteEntity,
  listItemEvents,
  reverseItemEvent,
} from '../src/index.js';
import { closeTestDb, testDb, uniqueEmail } from './helpers/db.js';
import { createRawClient, holdWorkEntityLock, sleep } from './helpers/raw.js';

const META = { ip: '203.0.113.93', userAgent: 'vitest' };

async function createAuthor(): Promise<string> {
  const db = testDb();
  const user = await db.user.create({
    data: {
      email: uniqueEmail('m2b3b-conc'),
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
    data: { authorId, title: `B3B并发-${uniqueEmail('t')}`, genreRulePackage: 'xuanhuan' },
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
  return `conc-${Date.now()}-${keySeq}`;
}

function append(
  workId: string,
  authorId: string,
  itemId: string,
  eventType: 'obtained' | 'transferred' | 'consumed' | 'lost',
  options: { toHolder?: string | null; idempotencyKey?: string } = {},
) {
  return appendItemEvent(testDb(), {
    workId,
    authorId,
    itemId,
    eventType,
    toHolder: options.toHolder ?? null,
    idempotencyKey: options.idempotencyKey ?? key(),
    meta: META,
  });
}

function reverse(workId: string, authorId: string, itemId: string, eventId: string) {
  return reverseItemEvent(testDb(), {
    workId,
    authorId,
    itemId,
    eventId,
    idempotencyKey: key(),
    meta: META,
  });
}

/** 观察 promise 在窗口期内是否仍未完成。 */
async function stayedPending(promise: Promise<unknown>, windowMs: number): Promise<boolean> {
  let settled = false;
  const tracked = promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await sleep(windowMs);
  const pending = !settled;
  void tracked.catch(() => undefined);
  return pending;
}

describe('M2-B3-B1 物品事件并发边界', () => {
  beforeAll(() => {
    testDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('10 个并发转手：seq 连续唯一、无 500、最终持有人是其中之一', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);

    const initial = await createCharacter(workId, authorId, '甲');
    await append(workId, authorId, itemId, 'obtained', { toHolder: initial });

    // 10 个互不相同的目标人物：任何串行顺序下每一笔转手都合法
    const targets: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      targets.push(await createCharacter(workId, authorId, `目标${index}`));
    }

    const results = await Promise.allSettled(
      targets.map((target) =>
        append(workId, authorId, itemId, 'transferred', { toHolder: target }),
      ),
    );

    const rejected = results.filter((result) => result.status === 'rejected');
    expect(
      rejected,
      `不应有失败：${JSON.stringify(rejected.map((r) => String(r.reason)))}`,
    ).toHaveLength(0);

    const rows = await db.itemEvent.findMany({
      where: { itemEntityId: itemId },
      orderBy: { seqNo: 'asc' },
      select: { seqNo: true },
    });
    // 1 条获得 + 10 条转手，seq 必须是 1..11 的完整排列（无重复、无空洞）
    expect(rows.map((row) => row.seqNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    const state = await testDb().itemEvent.findMany({
      where: { itemEntityId: itemId },
      orderBy: { seqNo: 'desc' },
      take: 1,
      select: { toHolder: true },
    });
    expect(targets).toContain(state[0]?.toHolder);
  });

  it('外部持有 WORK_LOCK_NAMESPACE 时，物品事件写与实体写**同时**被阻塞（同一把锁）', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    const raw = await createRawClient();
    try {
      await holdWorkEntityLock(raw, WORK_LOCK_NAMESPACE, workId);

      // 事件写：必须等锁
      const eventWrite = append(workId, authorId, itemId, 'obtained', { toHolder: heroId });
      // 实体写：必须等同一把锁
      const entityWrite = createEntity(testDb(), {
        workId,
        authorId,
        entityType: 'character',
        name: '苏沐',
        attributes: {},
        meta: META,
      });

      expect(await stayedPending(eventWrite, 300), '物品事件写应被作品级锁阻塞').toBe(true);
      expect(await stayedPending(entityWrite, 300), '实体写应被同一把作品级锁阻塞').toBe(true);

      await raw.query('COMMIT');

      const [eventResult, entityResult] = await Promise.all([eventWrite, entityWrite]);
      expect(eventResult.event.seq).toBe(1);
      expect(entityResult.name).toBe('苏沐');
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined);
      await raw.end();
    }
  });

  it('同一幂等键并发：只产生一行，其余全部命中 deduplicated', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');
    const sharedKey = key();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        append(workId, authorId, itemId, 'obtained', {
          toHolder: heroId,
          idempotencyKey: sharedKey,
        }),
      ),
    );

    expect(await db.itemEvent.count({ where: { itemEntityId: itemId } })).toBe(1);
    expect(results.filter((result) => result.deduplicated === false)).toHaveLength(1);
    expect(new Set(results.map((result) => result.event.id)).size).toBe(1);
  });

  it('并发冲正同一个事件：一次成功，其余 409（不产生两条冲正行）', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const itemId = await createItem(workId, authorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    const obtained = await append(workId, authorId, itemId, 'obtained', { toHolder: heroId });

    const results = await Promise.allSettled([
      reverse(workId, authorId, itemId, obtained.event.id),
      reverse(workId, authorId, itemId, obtained.event.id),
      reverse(workId, authorId, itemId, obtained.event.id),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({ code: 'ITEM_EVENT_NOT_REVERSIBLE' });
    }

    // 1 条获得 + 1 条冲正
    expect(await db.itemEvent.count({ where: { itemEntityId: itemId } })).toBe(2);
    expect(
      await db.itemEvent.count({ where: { itemEntityId: itemId, reversalOf: { not: null } } }),
    ).toBe(1);
  });

  it('追加事件与物品软删并发：已软删的物品上不会出现事件', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const heroId = await createCharacter(workId, authorId, '林青');

    // 多轮竞速：由调度决定先后，两种顺序都必须满足不变量
    for (let round = 0; round < 6; round += 1) {
      const itemId = await createItem(workId, authorId, `竞速物品${round}`);

      const [appendResult, deleteResult] = await Promise.allSettled([
        append(workId, authorId, itemId, 'obtained', { toHolder: heroId }),
        deleteEntity(db, { workId, authorId, entityId: itemId, meta: META }),
      ]);

      // 删除永远应当成功（物品不被任何东西引用）
      expect(deleteResult.status, `第 ${round} 轮删除应成功`).toBe('fulfilled');

      const item = await db.entity.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.deletedAt).not.toBeNull();

      if (appendResult.status === 'fulfilled') {
        // 事件先落库：它的数据库时钟必须早于软删时刻
        expect(appendResult.value.event.seq).toBe(1);
        const row = await db.itemEvent.findUniqueOrThrow({
          where: { id: appendResult.value.event.id },
        });
        expect(
          (item.deletedAt as Date).getTime() - row.createdAt.getTime(),
          `第 ${round} 轮：成功的事件必须早于软删时刻`,
        ).toBeGreaterThan(0);
      } else {
        // 删除先落库：写入必须被流水封闭拦下，而不是写出脏数据
        expect(appendResult.reason, `第 ${round} 轮应返回 ITEM_EVENTS_CLOSED`).toMatchObject({
          code: 'ITEM_EVENTS_CLOSED',
        });
        expect(await db.itemEvent.count({ where: { itemEntityId: itemId } })).toBe(0);
      }
    }
  });

  it('转手给某人 与 删除该人并发：二者只能成功一个', async () => {
    const db = testDb();
    const authorId = await createAuthor();
    const workId = await createWork(authorId);

    for (let round = 0; round < 6; round += 1) {
      const itemId = await createItem(workId, authorId, `归属竞速${round}`);
      const holder = await createCharacter(workId, authorId, `原持有人${round}`);
      const target = await createCharacter(workId, authorId, `新持有人${round}`);
      await append(workId, authorId, itemId, 'obtained', { toHolder: holder });

      const [transferResult, deleteResult] = await Promise.allSettled([
        append(workId, authorId, itemId, 'transferred', { toHolder: target }),
        deleteEntity(db, { workId, authorId, entityId: target, meta: META }),
      ]);

      const succeeded = [transferResult, deleteResult].filter(
        (result) => result.status === 'fulfilled',
      );
      expect(succeeded, `第 ${round} 轮只能有一个成功`).toHaveLength(1);

      if (transferResult.status === 'fulfilled') {
        // 先转手 → 目标成为当前持有人 → 删除必须被引用保护拦下
        expect(deleteResult.status).toBe('rejected');
        expect((deleteResult as PromiseRejectedResult).reason).toMatchObject({
          code: 'ENTITY_IN_USE',
        });
        const state = await listItemEvents(db, { workId, authorId, itemId });
        expect(state.events[state.events.length - 1]?.toHolder?.id).toBe(target);
      } else {
        // 先删除 → 目标已软删 → 转手必须被引用校验拦下
        expect(transferResult.reason).toMatchObject({
          code: 'VALIDATION_FAILED',
        });
        const holderRow = await db.entity.findUniqueOrThrow({ where: { id: target } });
        expect(holderRow.deletedAt).not.toBeNull();
        // 物品仍由原持有人持有，不会出现"持有人已被删除"
        const page = await listItemEvents(db, { workId, authorId, itemId });
        expect(page.events).toHaveLength(1);
        expect(page.events[0]?.toHolder?.id).toBe(holder);
      }
    }
  });
});
