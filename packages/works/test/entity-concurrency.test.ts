/**
 * 实体并发边界测试（M2-B1-REV-01）。
 *
 * 本文件要证明三件**不同**的事，因此用三类测试分别覆盖：
 *
 * 1. **作品级 advisory lock 确实是写路径的一部分**
 *    （`外部持锁 → 写操作必须阻塞` 系列）。
 *    这一组是**灵敏度核心**：把 `lockWork` 去掉，这些用例会立刻失败。
 *    它证明"写操作会去取那把锁"，而不是碰巧被行锁挡住。
 *
 * 2. **数据库条件更新（compare-and-set）是兜底**
 *    （`实体已被并发软删除时，条件更新拦下写入`）。
 *    这一组在**应用层先查后写**的前提下依然成立：
 *    外部事务先软删除再提交，应用层的"先查"仍会看到存活，
 *    只有数据库层的 `deleted_at IS NULL` 条件才能拦下写入。
 *
 * 3. **同一作品内的写操作不会交错出坏状态**
 *    （并发编辑 / 更新与删除 / 新增与排序 / 两次排序）。
 *
 * 保护层次（重要，不要混淆）：
 * - **行锁**（同一条 entities 行的 UPDATE 锁）保护的是"同一实体"的并发写：
 *   同一实体的并发编辑天然被串行化，因此版本号不会重复。
 * - **作品级 advisory lock** 保护的是**跨实体**的不变量：
 *   排序集合的完整性、order_index 的唯一连续性、重排不产生混合顺序。
 *   这些是行锁**管不到**的 —— 排序会同时改多行。
 * - **数据库条件更新**是第三道防线：即使前两道都被绕过，
 *   写入也不会落到已软删除的行上。
 *
 * 所有用例都跑在**真实 PostgreSQL** 上。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_ENTITY_TYPE,
  ENTITY_LOCK_NAMESPACE,
  createEntity,
  deleteEntity,
  listEntities,
  reorderEntities,
  updateEntity,
} from '../src/entities.js';
import { closeTestDb, testDb, uniqueEmail } from './helpers/db.js';
import { createRawClient, holdWorkEntityLock, sleep } from './helpers/raw.js';

const META = { ip: '203.0.113.31', userAgent: 'vitest' };

/** 创建作者账号。 */
async function createAuthor(): Promise<{ id: string }> {
  const db = testDb();
  const user = await db.user.create({
    data: {
      email: uniqueEmail('m2b1-conc'),
      passwordHash: '$argon2id$stub',
      role: 'author',
      status: 'active',
      mustChangePassword: false,
    },
  });
  return { id: user.id };
}

/** 创建作品。 */
async function createWork(authorId: string): Promise<string> {
  const db = testDb();
  const work = await db.work.create({
    data: {
      authorId,
      title: `并发作品-${uniqueEmail('t')}`,
      genreRulePackage: 'xuanhuan',
    },
  });
  return work.id;
}

/** 合法的境界属性。 */
function realmAttributes(lifespan = '一百年'): Record<string, unknown> {
  return {
    minorLevelCount: 9,
    breakthroughCondition: '引气入体',
    lifespan,
    powerBaseline: '凡境',
  };
}

/** 读出作品内所有存活实体的 order_index（升序）。 */
async function readOrderIndexes(workId: string): Promise<number[]> {
  const db = testDb();
  const rows = await db.entity.findMany({
    where: { workId, entityType: DEFAULT_ENTITY_TYPE, deletedAt: null },
    select: { orderIndex: true },
  });
  return rows.map((row) => row.orderIndex ?? -1).sort((a, b) => a - b);
}

/**
 * 观察一个并发操作在窗口期内是否**未完成**。
 *
 * 返回 true 表示在 `windowMs` 内既没有 fulfilled 也没有 rejected
 * —— 也就是它确实被某个锁挡住了。
 */
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
  // 避免 unhandled rejection：结果由调用方自己 await
  void tracked.catch(() => undefined);
  return pending;
}

describe('实体并发边界（M2-B1-REV-01）', () => {
  beforeAll(() => {
    testDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  /* ------------------------------------------------------------------ *
   * 1. 灵敏度核心：写路径确实取用作品级 advisory lock
   * ------------------------------------------------------------------ */

  it('外部持有同一把作品级锁时，create / update / delete / reorder 全部被阻塞', async () => {
    const db = testDb();
    const author = await createAuthor();

    /**
     * 每一类写操作都在**独立作品**上验证：
     * 外部事务持有**完全相同**的 advisory lock 键时，应用侧必须等待。
     *
     * 锁键 = `hashtextextended('entity:' || workId::text, 0)`，
     * 与 `packages/works/src/entities.ts` 的 `lockWork` 一致。
     */
    const cases: {
      readonly label: string;
      /** 准备该用例所需的初始数据，返回执行写操作所需的上下文。 */
      readonly prepare: () => Promise<{
        readonly workId: string;
        readonly entityIds: string[];
        readonly run: () => Promise<unknown>;
      }>;
    }[] = [
      {
        label: 'createEntity',
        prepare: async () => {
          const workId = await createWork(author.id);
          return {
            workId,
            entityIds: [],
            run: () =>
              createEntity(db, {
                workId,
                authorId: author.id,
                entityType: DEFAULT_ENTITY_TYPE,
                name: '金丹',
                attributes: realmAttributes(),
                meta: META,
              }),
          };
        },
      },
      {
        label: 'updateEntity',
        prepare: async () => {
          const workId = await createWork(author.id);
          const realm = await createEntity(db, {
            workId,
            authorId: author.id,
            entityType: DEFAULT_ENTITY_TYPE,
            name: '炼气',
            attributes: realmAttributes(),
            meta: META,
          });
          return {
            workId,
            entityIds: [realm.id],
            run: () =>
              updateEntity(db, {
                workId,
                authorId: author.id,
                entityId: realm.id,
                attributes: realmAttributes('两千年'),
                meta: META,
              }),
          };
        },
      },
      {
        label: 'deleteEntity',
        prepare: async () => {
          const workId = await createWork(author.id);
          const realm = await createEntity(db, {
            workId,
            authorId: author.id,
            entityType: DEFAULT_ENTITY_TYPE,
            name: '筑基',
            attributes: realmAttributes(),
            meta: META,
          });
          return {
            workId,
            entityIds: [realm.id],
            run: () =>
              deleteEntity(db, {
                workId,
                authorId: author.id,
                entityId: realm.id,
                meta: META,
              }),
          };
        },
      },
      {
        label: 'reorderEntities',
        prepare: async () => {
          const workId = await createWork(author.id);
          const a = await createEntity(db, {
            workId,
            authorId: author.id,
            entityType: DEFAULT_ENTITY_TYPE,
            name: '甲',
            attributes: realmAttributes(),
            meta: META,
          });
          const b = await createEntity(db, {
            workId,
            authorId: author.id,
            entityType: DEFAULT_ENTITY_TYPE,
            name: '乙',
            attributes: realmAttributes(),
            meta: META,
          });
          return {
            workId,
            entityIds: [a.id, b.id],
            run: () =>
              reorderEntities(db, {
                workId,
                authorId: author.id,
                entityType: DEFAULT_ENTITY_TYPE,
                entityIds: [b.id, a.id],
                meta: META,
              }),
          };
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = await testCase.prepare();
      const raw = await createRawClient();
      try {
        // 外部事务持有同一把锁
        await holdWorkEntityLock(raw, ENTITY_LOCK_NAMESPACE, fixture.workId);

        // 启动写操作：它必须在锁上等待
        const operation = fixture.run();
        const blocked = await stayedPending(operation, 300);
        expect(blocked, `${testCase.label} 应当被作品级锁阻塞`).toBe(true);

        // 释放外部锁 → 写操作必须立刻完成
        await raw.query('COMMIT');
        // 用 fulfilled 标记而不是 toBeDefined()：
        // deleteEntity 返回 void，用 toBeDefined() 会误判。
        let settled = false;
        await operation.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        expect(settled, `${testCase.label} 应当在锁释放后完成`).toBe(true);
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined);
        await raw.end();
      }
    }
  });

  it('作品级锁按作品隔离：锁住 A 作品不影响 B 作品的写操作', async () => {
    const db = testDb();
    const author = await createAuthor();
    const lockedWorkId = await createWork(author.id);
    const freeWorkId = await createWork(author.id);

    const raw = await createRawClient();
    try {
      await holdWorkEntityLock(raw, ENTITY_LOCK_NAMESPACE, lockedWorkId);

      // 另一个作品的写操作不应被阻塞
      const operation = createEntity(db, {
        workId: freeWorkId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        name: '元婴',
        attributes: realmAttributes(),
        meta: META,
      });
      const blocked = await stayedPending(operation, 300);
      expect(blocked, '不同作品的写操作不应被其它作品的锁阻塞').toBe(false);
      await expect(operation).resolves.toBeDefined();
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined);
      await raw.end();
    }
  });

  /* ------------------------------------------------------------------ *
   * 2. 数据库条件更新兜底
   * ------------------------------------------------------------------ */

  it('两个并发软删除：只有一方成功，只有一条删除审计', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '筑基',
      attributes: realmAttributes(),
      meta: META,
    });

    // 两个删除同时发起。
    // 数据库层的 `deleted_at IS NULL` 条件保证：
    // 只有一方能把这一行改成已删除，另一方拿到 0 行 → 404。
    const results = await Promise.allSettled([
      deleteEntity(db, {
        workId,
        authorId: author.id,
        entityId: realm.id,
        meta: META,
      }),
      deleteEntity(db, {
        workId,
        authorId: author.id,
        entityId: realm.id,
        meta: META,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled, '只能有一方软删除成功').toHaveLength(1);
    expect(rejected, '另一方必须失败').toHaveLength(1);

    const error = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    expect(error.code).toBe('NOT_FOUND');
    expect(error.code).not.toBe('INTERNAL_ERROR');

    // 只有一条 entity.deleted 审计
    const audits = await db.auditLog.findMany({
      where: { action: 'entity.deleted', targetId: realm.id },
      select: { id: true },
    });
    expect(audits).toHaveLength(1);
  });

  it('实体已被并发软删除时，条件更新拦下写入：不产生新版本与新审计', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '筑基',
      attributes: realmAttributes(),
      meta: META,
    });

    const versionsBefore = await db.entityVersion.count({ where: { entityId: realm.id } });
    const auditsBefore = await db.auditLog.count({
      where: { action: 'entity.updated', targetId: realm.id },
    });

    const raw = await createRawClient();
    try {
      // 外部事务持有该行的锁，并**未提交**地软删除该实体
      await raw.query('BEGIN');
      await raw.query('SELECT id FROM entities WHERE id = $1 FOR UPDATE', [realm.id]);
      await raw.query('UPDATE entities SET deleted_at = now() WHERE id = $1', [realm.id]);

      // 应用侧的写操作：先查（仍看到存活，因为外部事务未提交）
      // → 再写（此时被行锁挡住）
      const operation = updateEntity(db, {
        workId,
        authorId: author.id,
        entityId: realm.id,
        attributes: realmAttributes('删除之后'),
        meta: META,
      });
      const blocked = await stayedPending(operation, 300);
      expect(blocked, '写入应当被行锁挡住').toBe(true);

      // 外部事务提交 → 软删除正式生效
      await raw.query('COMMIT');

      // 数据库层的 `deleted_at IS NULL` 条件必须把这次写入拦下来
      await expect(operation).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // 没有新版本，没有新审计
      expect(await db.entityVersion.count({ where: { entityId: realm.id } })).toBe(versionsBefore);
      expect(
        await db.auditLog.count({ where: { action: 'entity.updated', targetId: realm.id } }),
      ).toBe(auditsBefore);
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined);
      await raw.end();
    }
  });

  it('排序期间实体被并发软删除：排序必须失败回滚，不得改动已删除实体的排序值', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const a = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '甲',
      attributes: realmAttributes(),
      meta: META,
    });
    const b = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '乙',
      attributes: realmAttributes(),
      meta: META,
    });

    // 外部事务软删除其中一个实体并提交
    const raw = await createRawClient();
    try {
      await raw.query('BEGIN');
      await raw.query('UPDATE entities SET deleted_at = clock_timestamp() WHERE id = $1', [a.id]);
      await raw.query('COMMIT');
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined);
      await raw.end();
    }

    // 软删除**之后**的排序集合（此时只剩一个存活实体）
    const before = await readOrderIndexes(workId);
    expect(before).toHaveLength(1);

    // 现在排序集合里已经没有 a —— 提交只含 a 的列表必须失败
    await expect(
      reorderEntities(db, {
        workId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        entityIds: [a.id, b.id],
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 排序失败必须整体回滚：存活实体的 order_index 不变
    expect(await readOrderIndexes(workId)).toEqual(before);

    // 只含存活实体的正确集合 → 成功
    const reordered = await reorderEntities(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      entityIds: [b.id],
      meta: META,
    });
    expect(reordered).toHaveLength(1);
  });

  /* ------------------------------------------------------------------ *
   * 3. 同一作品内的并发写不会交错出坏状态
   * ------------------------------------------------------------------ */

  it('10 个并发编辑同一实体：版本号连续且唯一，无 500，无旧版本覆盖', async () => {
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

    // 10 个并发编辑：每个都改不同的属性值
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        updateEntity(db, {
          workId,
          authorId: author.id,
          entityId: realm.id,
          attributes: realmAttributes(`第${index + 1}次`),
          meta: META,
        }),
      ),
    );

    // 无一个失败（尤其不能出现 500 / INTERNAL_ERROR）
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(0);
    for (const failure of failures) {
      const error = failure.reason as { code?: string };
      expect(error.code).not.toBe('INTERNAL_ERROR');
    }

    // 版本号连续且唯一：1（创建）+ 10（编辑）= 11，且是 1..11
    const versions = await db.entityVersion.findMany({
      where: { entityId: realm.id },
      orderBy: { versionNo: 'asc' },
      select: { versionNo: true },
    });
    expect(versions.map((item) => item.versionNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(new Set(versions.map((item) => item.versionNo)).size).toBe(11);

    // 旧版本没有被覆盖：第 1 版仍是最初的属性
    const snapshot = await db.entityVersion.findFirst({
      where: { entityId: realm.id, versionNo: 1 },
      select: { snapshot: true },
    });
    const firstAttributes = (snapshot?.snapshot as { attributes: Record<string, unknown> })
      .attributes;
    expect(firstAttributes['lifespan']).toBe('一百年');

    // 审计：10 条 entity.updated
    const audits = await db.auditLog.findMany({
      where: { action: 'entity.updated', targetId: realm.id },
      select: { id: true },
    });
    expect(audits).toHaveLength(10);
  });

  it('更新与删除并发：软删除后不再产生新版本或更新审计', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const realm = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '筑基',
      attributes: realmAttributes(),
      meta: META,
    });

    // 更新与删除**同时**发起：谁先拿到作品级锁谁先执行。
    // 无论顺序如何，最终都不允许出现"删除之后又写出版本或更新审计"。
    const results = await Promise.allSettled([
      updateEntity(db, {
        workId,
        authorId: author.id,
        entityId: realm.id,
        attributes: realmAttributes('并发编辑'),
        meta: META,
      }),
      deleteEntity(db, {
        workId,
        authorId: author.id,
        entityId: realm.id,
        meta: META,
      }),
    ]);

    // 删除必须成功（它要么先执行，要么在编辑之后执行）
    const deleteResult = results[1];
    expect(deleteResult?.status).toBe('fulfilled');

    // 编辑要么成功（在删除之前），要么以 NOT_FOUND 失败（删除之后）
    const updateResult = results[0];
    if (updateResult?.status === 'rejected') {
      const error = updateResult.reason as { code?: string };
      expect(error.code).toBe('NOT_FOUND');
      expect(error.code).not.toBe('INTERNAL_ERROR');
    }

    const row = await db.entity.findUniqueOrThrow({ where: { id: realm.id } });
    expect(row.deletedAt).not.toBeNull();

    const versions = await db.entityVersion.findMany({
      where: { entityId: realm.id },
      select: { versionNo: true, createdAt: true },
    });
    const audits = await db.auditLog.findMany({
      where: { action: 'entity.updated', targetId: realm.id },
      select: { id: true },
    });

    // 版本数与"entity.updated"审计数严格对应 ——
    // 每多一个版本就恰好多一条更新审计。
    expect(versions.length - 1).toBe(audits.length);

    // 关键不变量：**软删除之后不得再出现新版本**
    // （这一条正是数据库条件更新兜底的直接体现）
    const deletedAt = row.deletedAt as Date;
    const versionsAfterDelete = versions.filter((item) => item.createdAt > deletedAt);
    expect(versionsAfterDelete, '软删除之后不得产生新版本').toHaveLength(0);

    // 删除之后再编辑：必须 404，且**不产生**新版本与新审计
    const versionsBefore = versions.length;
    const auditsBefore = audits.length;
    await expect(
      updateEntity(db, {
        workId,
        authorId: author.id,
        entityId: realm.id,
        attributes: realmAttributes('删除之后'),
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await db.entityVersion.count({ where: { entityId: realm.id } })).toBe(versionsBefore);
    expect(
      await db.auditLog.count({ where: { action: 'entity.updated', targetId: realm.id } }),
    ).toBe(auditsBefore);
  });

  it('新增与排序并发：要么整体失败回滚，要么排序集合完整', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const first = await createEntity(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
      name: '金丹',
      attributes: realmAttributes(),
      meta: META,
    });

    // 用外部事务持有作品级锁，让"新增"与"排序"排队，
    // 释放后由作品级锁把两者**串行化** —— 这正是要验证的效果。
    const raw = await createRawClient();
    let createOutcome: PromiseSettledResult<unknown>;
    let reorderOutcome: PromiseSettledResult<unknown>;
    try {
      await holdWorkEntityLock(raw, ENTITY_LOCK_NAMESPACE, workId);

      const createPromise = createEntity(db, {
        workId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        name: '元婴',
        attributes: realmAttributes(),
        meta: META,
      });
      const reorderPromise = reorderEntities(db, {
        workId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        entityIds: [first.id],
        meta: META,
      });

      // 两个操作都必须被作品级锁挡住
      expect(await stayedPending(createPromise, 300), '新增应当被作品级锁阻塞').toBe(true);
      expect(await stayedPending(reorderPromise, 300), '排序应当被作品级锁阻塞').toBe(true);

      await raw.query('COMMIT');

      [createOutcome, reorderOutcome] = await Promise.allSettled([createPromise, reorderPromise]);
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined);
      await raw.end();
    }

    // 新增必须成功
    expect(createOutcome?.status, '新增应当成功').toBe('fulfilled');

    // 排序要么成功（集合完整），要么明确失败（VALIDATION_FAILED），不能是 500
    if (reorderOutcome?.status === 'rejected') {
      const error = reorderOutcome.reason as { code?: string };
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.code).not.toBe('INTERNAL_ERROR');
    }

    // 无论哪种结局，最终的排序集合都必须完整：
    // 恰好两个存活实体，order_index 是 1..2 的完整排列（无重复、无空洞）。
    const list = await listEntities(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
    });
    expect(list).toHaveLength(2);
    expect(list.map((item) => item.orderIndex).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2]);
  });

  it('两次不同顺序排序并发：两者都成功，最终顺序完整等于其中一个请求', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const names = ['甲', '乙', '丙', '丁'];
    const created: { id: string; name: string }[] = [];
    for (const name of names) {
      const entity = await createEntity(db, {
        workId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        name,
        attributes: realmAttributes(),
        meta: META,
      });
      created.push({ id: entity.id, name: entity.name });
    }

    const forward = created.map((item) => item.id);
    const backward = [...forward].reverse();

    // 两次**完全相反**的排序并发执行。
    // 没有作品级锁时，两边会交叉写同一批行 → 死锁或 order_index 重复；
    // 有作品级锁时，两次排序被串行化，**两次都必须成功**。
    const results = await Promise.allSettled([
      reorderEntities(db, {
        workId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        entityIds: forward,
        meta: META,
      }),
      reorderEntities(db, {
        workId,
        authorId: author.id,
        entityType: DEFAULT_ENTITY_TYPE,
        entityIds: backward,
        meta: META,
      }),
    ]);

    for (const result of results) {
      expect(result.status, '两次排序都必须成功').toBe('fulfilled');
    }

    // 最终顺序必须**完整地**等于其中一个请求的顺序（不能是混合）
    const list = await listEntities(db, {
      workId,
      authorId: author.id,
      entityType: DEFAULT_ENTITY_TYPE,
    });
    const finalNames = list.map((item) => item.name);
    expect(finalNames.length).toBe(4);
    const isForward = forward.every((id, index) => list[index]?.id === id);
    const isBackward = backward.every((id, index) => list[index]?.id === id);
    expect(
      isForward || isBackward,
      `最终顺序必须是某个请求的完整顺序，实际：${finalNames.join('、')}`,
    ).toBe(true);

    // order_index 也必须是 1..4 的完整排列（无重复、无空洞）
    expect(await readOrderIndexes(workId)).toEqual([1, 2, 3, 4]);
  });

  it('引用目标在并发中被软删除：创建引用必须在锁内失败', async () => {
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

    const raw = await createRawClient();
    try {
      // 外部事务先占住作品级锁，并**未提交**地软删除该境界
      await holdWorkEntityLock(raw, ENTITY_LOCK_NAMESPACE, workId);
      await raw.query('UPDATE entities SET deleted_at = clock_timestamp() WHERE id = $1', [
        realm.id,
      ]);

      // 引用它的写入会先卡在作品级锁上
      const operation = createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'character',
        name: '林青',
        attributes: { initialRealm: realm.id },
        meta: META,
      });
      expect(await stayedPending(operation, 300), '写入应被作品级锁阻塞').toBe(true);

      await raw.query('COMMIT');

      // 拿到锁之后重新校验引用 → 目标已删除 → 失败。
      // 若引用校验发生在锁外（先查后写），这里会错误地创建成功。
      await expect(operation).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined);
      await raw.end();
    }

    const characters = await listEntities(db, {
      workId,
      authorId: author.id,
      entityType: 'character',
    });
    expect(characters).toEqual([]);
  });

  it('不同实体类型的并发新增互不干扰：各自从 order_index 1 开始', async () => {
    const db = testDb();
    const author = await createAuthor();
    const workId = await createWork(author.id);

    const [realm, faction, character] = await Promise.all([
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'realm_level',
        name: '炼气',
        attributes: realmAttributes(),
        meta: META,
      }),
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'faction',
        name: '青云宗',
        attributes: { type: 'sect' },
        meta: META,
      }),
      createEntity(db, {
        workId,
        authorId: author.id,
        entityType: 'character',
        name: '林青',
        attributes: { identity: '弟子' },
        meta: META,
      }),
    ]);

    expect([realm.orderIndex, faction.orderIndex, character.orderIndex]).toEqual([1, 1, 1]);
  });
});
