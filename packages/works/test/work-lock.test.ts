/**
 * 作品级写锁的 UUID 规范化（M2-B3-B1-REV-02）。
 *
 * 锁键 = `hashtextextended('entity:' || workId::text, 0)`。
 * PostgreSQL 的 uuid 类型比较不区分大小写，但**哈希键是字符串** ——
 * 若调用方传大写、别处传小写，同一作品会落到两个不同的键上，锁形同虚设。
 *
 * 因此 `lockWork` 必须在入口自行 `normalizeUuid`，不依赖调用方。
 * 这组用例用**外部连接持锁**来证明这一点：只有键完全一致才会阻塞。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WORK_LOCK_NAMESPACE, createEntity, deleteEntity, runWorkWrite } from '../src/index.js';
import { closeTestDb, testDb, uniqueEmail } from './helpers/db.js';
import { createRawClient, holdWorkEntityLock, sleep } from './helpers/raw.js';

const META = { ip: '203.0.113.94', userAgent: 'vitest' };

async function createAuthor(): Promise<string> {
  const user = await testDb().user.create({
    data: {
      email: uniqueEmail('m2b3b-lock'),
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
    data: { authorId, title: `锁大小写-${uniqueEmail('t')}`, genreRulePackage: 'xuanhuan' },
  });
  return work.id;
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

describe('M2-B3-B1-REV-02 作品锁的 UUID 规范化', () => {
  beforeAll(() => {
    testDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('外部持小写锁时，runWorkWrite 传大写必须阻塞（反之亦然）', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const lower = workId.toLowerCase();
    const upper = workId.toUpperCase();
    expect(lower).not.toBe(upper);

    const combinations: { held: string; attempted: string; label: string }[] = [
      { held: lower, attempted: upper, label: '持小写 → 传大写' },
      { held: upper, attempted: lower, label: '持大写 → 传小写' },
    ];

    for (const combination of combinations) {
      const raw = await createRawClient();
      try {
        await holdWorkEntityLock(raw, WORK_LOCK_NAMESPACE, combination.held);

        const write = runWorkWrite(testDb(), combination.attempted, () => Promise.resolve(1));
        expect(await stayedPending(write, 300), `${combination.label}：必须被同一把锁阻塞`).toBe(
          true,
        );

        await raw.query('COMMIT');
        await expect(write).resolves.toBe(1);
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined);
        await raw.end();
      }
    }
  });

  it('大写与小写写并发：不会同时进入临界区', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);
    const lower = workId.toLowerCase();
    const upper = workId.toUpperCase();

    let inside = 0;
    let maxInside = 0;

    const enter = (id: string): Promise<void> =>
      runWorkWrite(testDb(), id, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await sleep(150);
        inside -= 1;
      });

    await Promise.all([enter(lower), enter(upper), enter(lower), enter(upper)]);

    expect(maxInside, '同一作品的写操作必须串行，大小写不得绕过').toBe(1);
  });

  it('实体写路径同样受大小写一致的锁保护', async () => {
    const authorId = await createAuthor();
    const workId = await createWork(authorId);

    const raw = await createRawClient();
    try {
      // 外部持小写锁
      await holdWorkEntityLock(raw, WORK_LOCK_NAMESPACE, workId.toLowerCase());

      // 用大写 workId 创建实体
      const write = createEntity(testDb(), {
        workId: workId.toUpperCase(),
        authorId,
        entityType: 'character',
        name: '林青',
        attributes: {},
        meta: META,
      });
      expect(await stayedPending(write, 300), '大写 workId 的实体写必须等锁').toBe(true);

      await raw.query('COMMIT');
      const created = await write;
      expect(created.name).toBe('林青');
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined);
      await raw.end();
    }

    // 反向：持大写锁，用小写 workId 删除
    const raw2 = await createRawClient();
    try {
      const entity = await testDb().entity.findFirstOrThrow({
        where: { workId, name: '林青' },
      });
      await holdWorkEntityLock(raw2, WORK_LOCK_NAMESPACE, workId.toUpperCase());

      const remove = deleteEntity(testDb(), {
        workId: workId.toLowerCase(),
        authorId,
        entityId: entity.id,
        meta: META,
      });
      expect(await stayedPending(remove, 300), '小写 workId 的删除必须等锁').toBe(true);

      await raw2.query('COMMIT');
      await expect(remove).resolves.toBeUndefined();
    } finally {
      await raw2.query('ROLLBACK').catch(() => undefined);
      await raw2.end();
    }
  });

  it('畸形 workId 仍然是 400（不因为规范化而放宽形态校验）', async () => {
    const authorId = await createAuthor();
    await expect(
      runWorkWrite(testDb(), 'not-a-uuid', () => Promise.resolve(1)),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    await expect(
      createEntity(testDb(), {
        workId: 'not-a-uuid',
        authorId,
        entityType: 'character',
        name: '林青',
        attributes: {},
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
