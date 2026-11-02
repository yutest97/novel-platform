/**
 * 物品事件接口测试（M2-B3-B1）。
 *
 * 关注路由层的四件事：
 * - **严格白名单**：`fromHolder` 等字段必须 400，而不是被忽略；
 * - 稳定错误码与 HTTP 状态（409 / 404 / 400 / 403）；
 * - 幂等的 HTTP 语义（首次 201、重放 200 + deduplicated）；
 * - 归属隔离（他人作品一律 404）与管理员拒绝。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as entitiesPost } from '../app/api/works/[id]/entities/route.js';
import { DELETE as entityDelete } from '../app/api/works/[id]/entities/[entityId]/route.js';
import {
  GET as eventsGet,
  POST as eventPost,
} from '../app/api/works/[id]/items/[itemId]/events/route.js';
import { POST as reversalPost } from '../app/api/works/[id]/items/[itemId]/events/[eventId]/reversal/route.js';
import { GET as stateGet } from '../app/api/works/[id]/items/[itemId]/state/route.js';

const ORIGIN = 'http://127.0.0.1:3000';

let db: PrismaClient;

interface TestUser {
  id: string;
  token: string;
}

async function createUser(
  role: 'author' | 'admin',
  overrides: { status?: 'active' | 'disabled' } = {},
): Promise<TestUser> {
  const user = await db.user.create({
    data: {
      email: `item-events-${role}-${randomUUID()}@example.test`,
      passwordHash: '$argon2id$stub',
      role,
      status: overrides.status ?? 'active',
      mustChangePassword: false,
    },
  });
  const { createSession, readAuthConfig } = await import('@novel/auth');
  const session = await createSession(db, { userId: user.id, config: readAuthConfig() });
  return { id: user.id, token: session.token };
}

async function createWork(authorId: string): Promise<string> {
  const work = await db.work.create({
    data: { authorId, title: `事件作品-${randomUUID()}`, genreRulePackage: 'xuanhuan' },
  });
  return work.id;
}

function request(
  path: string,
  options: { method?: string; body?: unknown; token?: string; origin?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.token !== undefined) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${options.token}`;
  }
  if (options.origin !== undefined) {
    headers['origin'] = options.origin;
  }
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const params = (
  id: string,
  itemId: string,
): { params: Promise<{ id: string; itemId: string }> } => ({
  params: Promise.resolve({ id, itemId }),
});

const reversalParams = (
  id: string,
  itemId: string,
  eventId: string,
): { params: Promise<{ id: string; itemId: string; eventId: string }> } => ({
  params: Promise.resolve({ id, itemId, eventId }),
});

async function createEntityThroughApi(
  workId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const response = await entitiesPost(
    request(`/api/works/${workId}/entities`, {
      method: 'POST',
      body,
      token,
      origin: ORIGIN,
    }),
    { params: Promise.resolve({ id: workId }) },
  );
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  const parsed = (await response.json()) as { entity: { id: string; name: string } };
  return parsed.entity;
}

async function createItem(workId: string, token: string, name = '青锋剑'): Promise<string> {
  const entity = await createEntityThroughApi(workId, token, {
    entityType: 'item',
    name,
    attributes: { category: 'weapon', quality: 'mystic' },
  });
  return entity.id;
}

async function createCharacter(workId: string, token: string, name: string): Promise<string> {
  const entity = await createEntityThroughApi(workId, token, {
    entityType: 'character',
    name,
    attributes: {},
  });
  return entity.id;
}

function key(): string {
  return `evt-${randomUUID()}`;
}

async function appendRaw(
  workId: string,
  itemId: string,
  token: string,
  body: Record<string, unknown>,
  options: { origin?: string } = {},
): Promise<Response> {
  return eventPost(
    request(`/api/works/${workId}/items/${itemId}/events`, {
      method: 'POST',
      body,
      token,
      origin: options.origin ?? ORIGIN,
    }),
    params(workId, itemId),
  );
}

describe('物品事件接口（M2-B3-B1）', () => {
  beforeAll(() => {
    db = getPrismaClient();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('完整链路：获得 → 状态 → 转手 → 冲正，DTO 只含定位信息', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const itemId = await createItem(workId, author.token);
    const heroA = await createCharacter(workId, author.token, '林青');
    const heroB = await createCharacter(workId, author.token, '苏沐');

    const obtained = await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: heroA,
      note: '宗门赐下',
      idempotencyKey: key(),
    });
    expect(obtained.status).toBe(201);
    const obtainedBody = (await obtained.json()) as {
      event: { id: string; seq: number; fromHolder: unknown; toHolder: Record<string, unknown> };
      state: { status: string; holder: { id: string } };
      deduplicated: boolean;
    };
    expect(obtainedBody.event.seq).toBe(1);
    expect(obtainedBody.event.fromHolder).toBeNull();
    expect(obtainedBody.event.toHolder).toEqual({ id: heroA, name: '林青', deleted: false });
    // 只有 id / name / deleted，绝不带人物属性
    expect(Object.keys(obtainedBody.event.toHolder ?? {}).sort()).toEqual([
      'deleted',
      'id',
      'name',
    ]);
    expect(obtainedBody.deduplicated).toBe(false);
    expect(obtainedBody.state.status).toBe('held');

    const state = await stateGet(
      request(`/api/works/${workId}/items/${itemId}/state`, { token: author.token }),
      params(workId, itemId),
    );
    expect(state.status).toBe(200);
    const stateBody = (await state.json()) as {
      state: { status: string; holder: { id: string }; eventCount: number; lastSeq: number };
    };
    expect(stateBody.state).toMatchObject({ status: 'held', eventCount: 1, lastSeq: 1 });
    expect(stateBody.state.holder.id).toBe(heroA);

    const moved = await appendRaw(workId, itemId, author.token, {
      eventType: 'transferred',
      toHolder: heroB,
      idempotencyKey: key(),
    });
    expect(moved.status).toBe(201);
    const movedBody = (await moved.json()) as {
      event: { id: string; fromHolder: { id: string }; toHolder: { id: string } };
      state: { holder: { id: string } };
    };
    expect(movedBody.event.fromHolder.id).toBe(heroA);
    expect(movedBody.event.toHolder.id).toBe(heroB);
    expect(movedBody.state.holder.id).toBe(heroB);

    const reversal = await reversalPost(
      request(`/api/works/${workId}/items/${itemId}/events/${movedBody.event.id}/reversal`, {
        method: 'POST',
        body: { idempotencyKey: key() },
        token: author.token,
        origin: ORIGIN,
      }),
      reversalParams(workId, itemId, movedBody.event.id),
    );
    expect(reversal.status).toBe(201);
    const reversalBody = (await reversal.json()) as {
      event: { reversalOf: string; eventType: string };
      state: {
        status: string;
        holder: { id: string };
        eventCount: number;
        effectiveEventCount: number;
      };
    };
    expect(reversalBody.event.reversalOf).toBe(movedBody.event.id);
    expect(reversalBody.state.holder.id).toBe(heroA);
    expect(reversalBody.state.eventCount).toBe(3);
    expect(reversalBody.state.effectiveEventCount).toBe(1);

    const page = await eventsGet(
      request(`/api/works/${workId}/items/${itemId}/events`, { token: author.token }),
      params(workId, itemId),
    );
    expect(page.status).toBe(200);
    const pageBody = (await page.json()) as {
      events: { seq: number; reversed: boolean; reversedBy: string | null }[];
      hasMore: boolean;
      nextAfterSeq: number;
    };
    expect(pageBody.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(pageBody.events[1]?.reversed).toBe(true);
    expect(pageBody.events[2]?.reversed).toBe(false);
    expect(pageBody.hasMore).toBe(false);
  });

  it('fromHolder / from_holder 一律 400（转出方只能由服务端推导）', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const itemId = await createItem(workId, author.token);
    const heroId = await createCharacter(workId, author.token, '林青');

    for (const field of ['fromHolder', 'from_holder', 'workId', 'createdAt', 'seq']) {
      const response = await appendRaw(workId, itemId, author.token, {
        eventType: 'obtained',
        toHolder: heroId,
        idempotencyKey: key(),
        [field]: field === 'from_holder' ? heroId : 'x',
      });
      expect(response.status, `字段 ${field} 应当被拒绝`).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_FAILED');
    }

    // 一条事件都没写进去
    expect(await db.itemEvent.count({ where: { itemEntityId: itemId } })).toBe(0);
  });

  it('状态机 409：未登记就转手；consumed 带 toHolder 400；非法 eventType 400', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const itemId = await createItem(workId, author.token);
    const heroId = await createCharacter(workId, author.token, '林青');

    const tooEarly = await appendRaw(workId, itemId, author.token, {
      eventType: 'transferred',
      toHolder: heroId,
      idempotencyKey: key(),
    });
    expect(tooEarly.status).toBe(409);
    expect(((await tooEarly.json()) as { error: { code: string } }).error.code).toBe(
      'ITEM_EVENT_INVALID_TRANSITION',
    );

    const unknownType = await appendRaw(workId, itemId, author.token, {
      eventType: 'melted',
      toHolder: heroId,
      idempotencyKey: key(),
    });
    expect(unknownType.status).toBe(400);

    const missingHolder = await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      idempotencyKey: key(),
    });
    expect(missingHolder.status).toBe(400);

    // 消耗事件不能带 toHolder
    await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: heroId,
      idempotencyKey: key(),
    });
    const consumedWithHolder = await appendRaw(workId, itemId, author.token, {
      eventType: 'consumed',
      toHolder: heroId,
      idempotencyKey: key(),
    });
    expect(consumedWithHolder.status).toBe(400);
  });

  it('幂等：同键同内容第二次 200 + deduplicated；同键不同内容 409', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const itemId = await createItem(workId, author.token);
    const heroId = await createCharacter(workId, author.token, '林青');
    const idempotencyKey = key();

    const first = await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: heroId,
      note: '宗门赐下',
      idempotencyKey,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { event: { id: string }; deduplicated: boolean };
    expect(firstBody.deduplicated).toBe(false);

    const replay = await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: heroId,
      note: '宗门赐下',
      idempotencyKey,
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { event: { id: string }; deduplicated: boolean };
    expect(replayBody.deduplicated).toBe(true);
    expect(replayBody.event.id).toBe(firstBody.event.id);

    const conflicting = await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: heroId,
      note: '换了备注',
      idempotencyKey,
    });
    expect(conflicting.status).toBe(409);
    expect(((await conflicting.json()) as { error: { code: string } }).error.code).toBe(
      'ITEM_EVENT_IDEMPOTENCY_CONFLICT',
    );

    expect(await db.itemEvent.count({ where: { itemEntityId: itemId } })).toBe(1);
  });

  it('冲正：未知事件 404；非最新 409；冲正冲正行 409；冲正体不允许 eventType', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const itemId = await createItem(workId, author.token);
    const a = await createCharacter(workId, author.token, '甲');
    const b = await createCharacter(workId, author.token, '乙');

    const obtained = await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: a,
      idempotencyKey: key(),
    });
    const obtainedId = ((await obtained.json()) as { event: { id: string } }).event.id;

    const moved = await appendRaw(workId, itemId, author.token, {
      eventType: 'transferred',
      toHolder: b,
      idempotencyKey: key(),
    });
    const movedId = ((await moved.json()) as { event: { id: string } }).event.id;

    const missing = await reversalPost(
      request(`/api/works/${workId}/items/${itemId}/events/${randomUUID()}/reversal`, {
        method: 'POST',
        body: { idempotencyKey: key() },
        token: author.token,
        origin: ORIGIN,
      }),
      reversalParams(workId, itemId, randomUUID()),
    );
    expect(missing.status).toBe(404);

    const notLatest = await reversalPost(
      request(`/api/works/${workId}/items/${itemId}/events/${obtainedId}/reversal`, {
        method: 'POST',
        body: { idempotencyKey: key() },
        token: author.token,
        origin: ORIGIN,
      }),
      reversalParams(workId, itemId, obtainedId),
    );
    expect(notLatest.status).toBe(409);
    expect(((await notLatest.json()) as { error: { code: string } }).error.code).toBe(
      'ITEM_EVENT_NOT_REVERSIBLE',
    );

    // 冲正体里出现 eventType → 白名单拒绝
    const withType = await reversalPost(
      request(`/api/works/${workId}/items/${itemId}/events/${movedId}/reversal`, {
        method: 'POST',
        body: { idempotencyKey: key(), eventType: 'obtained' },
        token: author.token,
        origin: ORIGIN,
      }),
      reversalParams(workId, itemId, movedId),
    );
    expect(withType.status).toBe(400);

    const ok = await reversalPost(
      request(`/api/works/${workId}/items/${itemId}/events/${movedId}/reversal`, {
        method: 'POST',
        body: { idempotencyKey: key() },
        token: author.token,
        origin: ORIGIN,
      }),
      reversalParams(workId, itemId, movedId),
    );
    expect(ok.status).toBe(201);
    const okBody = (await ok.json()) as { event: { id: string } };

    const reverseReversal = await reversalPost(
      request(`/api/works/${workId}/items/${itemId}/events/${okBody.event.id}/reversal`, {
        method: 'POST',
        body: { idempotencyKey: key() },
        token: author.token,
        origin: ORIGIN,
      }),
      reversalParams(workId, itemId, okBody.event.id),
    );
    expect(reverseReversal.status).toBe(409);
  });

  it('分页：afterSeq 游标与非法 limit', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const itemId = await createItem(workId, author.token);
    const heroId = await createCharacter(workId, author.token, '林青');

    await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: heroId,
      idempotencyKey: key(),
    });
    await appendRaw(workId, itemId, author.token, {
      eventType: 'consumed',
      idempotencyKey: key(),
    });
    await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: heroId,
      idempotencyKey: key(),
    });

    const first = await eventsGet(
      request(`/api/works/${workId}/items/${itemId}/events?limit=2`, { token: author.token }),
      params(workId, itemId),
    );
    const firstBody = (await first.json()) as {
      events: { seq: number }[];
      hasMore: boolean;
      nextAfterSeq: number;
    };
    expect(firstBody.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(firstBody.hasMore).toBe(true);

    const second = await eventsGet(
      request(`/api/works/${workId}/items/${itemId}/events?afterSeq=2&limit=2`, {
        token: author.token,
      }),
      params(workId, itemId),
    );
    const secondBody = (await second.json()) as { events: { seq: number }[]; hasMore: boolean };
    expect(secondBody.events.map((event) => event.seq)).toEqual([3]);
    expect(secondBody.hasMore).toBe(false);

    for (const query of ['limit=101', 'limit=0', 'afterSeq=-1', 'afterSeq=abc']) {
      const response = await eventsGet(
        request(`/api/works/${workId}/items/${itemId}/events?${query}`, { token: author.token }),
        params(workId, itemId),
      );
      expect(response.status, `查询 ${query} 应当 400`).toBe(400);
    }
  });

  it('软删除物品：事件仍可读，写入返回 409 ITEM_EVENTS_CLOSED', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const itemId = await createItem(workId, author.token);
    const heroId = await createCharacter(workId, author.token, '林青');
    await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: heroId,
      idempotencyKey: key(),
    });

    const deleted = await entityDelete(
      request(`/api/works/${workId}/entities/${itemId}`, {
        method: 'DELETE',
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: itemId }) },
    );
    expect(deleted.status).toBe(200);

    const closed = await appendRaw(workId, itemId, author.token, {
      eventType: 'consumed',
      idempotencyKey: key(),
    });
    expect(closed.status).toBe(409);
    expect(((await closed.json()) as { error: { code: string } }).error.code).toBe(
      'ITEM_EVENTS_CLOSED',
    );

    const page = await eventsGet(
      request(`/api/works/${workId}/items/${itemId}/events`, { token: author.token }),
      params(workId, itemId),
    );
    expect(page.status).toBe(200);
    expect(((await page.json()) as { events: unknown[] }).events).toHaveLength(1);
  });

  it('隔离与权限：他人作品 404、管理员 403、缺 Origin 403、畸形 ID 400', async () => {
    const author = await createUser('author');
    const other = await createUser('author');
    const admin = await createUser('admin');
    const workId = await createWork(author.id);
    const itemId = await createItem(workId, author.token);
    const heroId = await createCharacter(workId, author.token, '林青');

    // 他人访问
    const foreign = await eventsGet(
      request(`/api/works/${workId}/items/${itemId}/events`, { token: other.token }),
      params(workId, itemId),
    );
    expect(foreign.status).toBe(404);

    const foreignWrite = await appendRaw(workId, itemId, other.token, {
      eventType: 'obtained',
      toHolder: heroId,
      idempotencyKey: key(),
    });
    expect(foreignWrite.status).toBe(404);

    // 管理员
    const adminRead = await eventsGet(
      request(`/api/works/${workId}/items/${itemId}/events`, { token: admin.token }),
      params(workId, itemId),
    );
    expect(adminRead.status).toBe(403);

    // Origin
    const noOrigin = await appendRaw(
      workId,
      itemId,
      author.token,
      { eventType: 'obtained', toHolder: heroId, idempotencyKey: key() },
      { origin: '' },
    );
    expect(noOrigin.status).toBe(403);

    // 畸形 UUID
    const badWork = await eventsGet(
      request(`/api/works/not-a-uuid/items/${itemId}/events`, { token: author.token }),
      params('not-a-uuid', itemId),
    );
    expect(badWork.status).toBe(400);

    const badItem = await eventsGet(
      request(`/api/works/${workId}/items/not-a-uuid/events`, { token: author.token }),
      params(workId, 'not-a-uuid'),
    );
    expect(badItem.status).toBe(400);

    // 用人物 id 当物品 id → 404
    const wrongType = await eventsGet(
      request(`/api/works/${workId}/items/${heroId}/events`, { token: author.token }),
      params(workId, heroId),
    );
    expect(wrongType.status).toBe(404);
  });

  it('删除当前持有人：409 摘要列出物品；转走后可删（接口层）', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const itemId = await createItem(workId, author.token, '青锋剑');
    const holder = await createCharacter(workId, author.token, '林青');
    const next = await createCharacter(workId, author.token, '苏沐');

    await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: holder,
      idempotencyKey: key(),
    });

    const blocked = await entityDelete(
      request(`/api/works/${workId}/entities/${holder}`, {
        method: 'DELETE',
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: holder }) },
    );
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as {
      error: {
        code: string;
        references: { total: number; items: { id: string; entityType: string; name: string }[] };
      };
    };
    expect(blockedBody.error.code).toBe('ENTITY_IN_USE');
    expect(blockedBody.error.references.items).toEqual([
      { id: itemId, entityType: 'item', name: '青锋剑' },
    ]);

    await appendRaw(workId, itemId, author.token, {
      eventType: 'transferred',
      toHolder: next,
      idempotencyKey: key(),
    });

    const ok = await entityDelete(
      request(`/api/works/${workId}/entities/${holder}`, {
        method: 'DELETE',
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: holder }) },
    );
    expect(ok.status).toBe(200);
  });

  /* ---------------------------------------------------------------------- */
  /* M2-B3-B1-REV-01                                                        */
  /* ---------------------------------------------------------------------- */

  it('toHolder 非法 UUID → 400，且不写事件、不写审计', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const itemId = await createItem(workId, author.token);
    const heroId = await createCharacter(workId, author.token, '林青');

    const auditBefore = await db.auditLog.count({ where: { action: 'item.event_recorded' } });

    for (const eventType of ['obtained', 'transferred'] as const) {
      // transferred 需要先有持有状态；obtained 直接测
      if (eventType === 'transferred') {
        await appendRaw(workId, itemId, author.token, {
          eventType: 'obtained',
          toHolder: heroId,
          idempotencyKey: key(),
        });
      }
      for (const bad of ['not-a-uuid', '1234', 'ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ']) {
        const response = await appendRaw(workId, itemId, author.token, {
          eventType,
          toHolder: bad,
          idempotencyKey: key(),
        });
        expect(response.status, `${eventType} / ${bad} 应当 400`).toBe(400);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          'VALIDATION_FAILED',
        );
      }
    }

    // 只有那一条合法事件
    expect(await db.itemEvent.count({ where: { itemEntityId: itemId } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'item.event_recorded' } })).toBe(
      auditBefore + 1,
    );
  });

  it('UUID 大小写：大写路径参数与 toHolder 可用，且与后续小写重试命中同一幂等事件', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const itemId = await createItem(workId, author.token);
    const heroId = await createCharacter(workId, author.token, '林青');
    const idempotencyKey = key();

    // 路径与 body 全部用大写
    const first = await eventPost(
      request(`/api/works/${workId.toUpperCase()}/items/${itemId.toUpperCase()}/events`, {
        method: 'POST',
        body: {
          eventType: 'obtained',
          toHolder: heroId.toUpperCase(),
          idempotencyKey,
        },
        token: author.token,
        origin: ORIGIN,
      }),
      params(workId.toUpperCase(), itemId.toUpperCase()),
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { event: { id: string }; deduplicated: boolean };

    // 重试用小写 + 同键 → 200 + deduplicated
    const replay = await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: heroId,
      idempotencyKey,
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { event: { id: string }; deduplicated: boolean };
    expect(replayBody.deduplicated).toBe(true);
    expect(replayBody.event.id).toBe(firstBody.event.id);

    // 用大写 eventId 冲正
    const reversal = await reversalPost(
      request(
        `/api/works/${workId}/items/${itemId}/events/${firstBody.event.id.toUpperCase()}/reversal`,
        { method: 'POST', body: { idempotencyKey: key() }, token: author.token, origin: ORIGIN },
      ),
      reversalParams(workId, itemId, firstBody.event.id.toUpperCase()),
    );
    expect(reversal.status).toBe(201);
    const reversalBody = (await reversal.json()) as {
      event: { reversalOf: string };
      state: { status: string };
    };
    expect(reversalBody.event.reversalOf).toBe(firstBody.event.id);
    expect(reversalBody.state.status).toBe('unrecorded');
  });

  it('幂等跨类型：同键命中冲正行 → 409，不返回 deduplicated', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);
    const itemId = await createItem(workId, author.token);
    const heroId = await createCharacter(workId, author.token, '林青');

    const obtained = await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: heroId,
      idempotencyKey: key(),
    });
    const obtainedId = ((await obtained.json()) as { event: { id: string } }).event.id;

    const consumed = await appendRaw(workId, itemId, author.token, {
      eventType: 'consumed',
      idempotencyKey: key(),
    });
    const consumedId = ((await consumed.json()) as { event: { id: string } }).event.id;

    // 用键 K 冲正 consumed → 冲正行形状为 obtained(null→A)
    const sharedKey = key();
    const reversal = await reversalPost(
      request(`/api/works/${workId}/items/${itemId}/events/${consumedId}/reversal`, {
        method: 'POST',
        body: { idempotencyKey: sharedKey },
        token: author.token,
        origin: ORIGIN,
      }),
      reversalParams(workId, itemId, consumedId),
    );
    expect(reversal.status).toBe(201);

    const countBefore = await db.itemEvent.count({ where: { itemEntityId: itemId } });

    // 复用同键做普通 append，形状与冲正行一致
    const conflict = await appendRaw(workId, itemId, author.token, {
      eventType: 'obtained',
      toHolder: heroId,
      idempotencyKey: sharedKey,
    });
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as {
      error: { code: string };
      deduplicated?: boolean;
    };
    expect(conflictBody.error.code).toBe('ITEM_EVENT_IDEMPOTENCY_CONFLICT');
    expect(conflictBody.deduplicated).toBeUndefined();
    expect(await db.itemEvent.count({ where: { itemEntityId: itemId } })).toBe(countBefore);

    // 原来那条获得的事件仍在
    expect(obtainedId).toBeTruthy();
  });
});
