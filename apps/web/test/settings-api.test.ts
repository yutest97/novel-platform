/**
 * 设定中心与实体接口的路由层测试（M2-B1）。
 *
 * 覆盖权限矩阵（未登录 / 非作者 / 停用 / 未改密）、作者隔离、
 * Origin 校验、不可变字段拒绝与稳定错误码。
 */

import { randomUUID } from 'node:crypto';

import { SESSION_COOKIE_NAME } from '@novel/auth';
import { getPrismaClient, type PrismaClient } from '@novel/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GET as settingsGet,
  PATCH as settingsPatch,
} from '../app/api/works/[id]/settings/route.js';
import { GET as entitiesGet, POST as entitiesPost } from '../app/api/works/[id]/entities/route.js';
import {
  DELETE as entityDelete,
  PATCH as entityPatch,
} from '../app/api/works/[id]/entities/[entityId]/route.js';
import { PUT as reorderPut } from '../app/api/works/[id]/entities/reorder/route.js';

const ORIGIN = 'http://127.0.0.1:3000';

let db: PrismaClient;

interface TestUser {
  id: string;
  token: string;
}

async function createUser(
  role: 'author' | 'admin',
  overrides: { status?: 'active' | 'disabled'; mustChangePassword?: boolean } = {},
): Promise<TestUser> {
  const email = `settings-api-${role}-${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: {
      email,
      passwordHash: '$argon2id$stub',
      role,
      status: overrides.status ?? 'active',
      mustChangePassword: overrides.mustChangePassword ?? false,
    },
  });

  const { createSession, readAuthConfig } = await import('@novel/auth');
  const session = await createSession(db, { userId: user.id, config: readAuthConfig() });
  return { id: user.id, token: session.token };
}

async function createWork(authorId: string): Promise<string> {
  const work = await db.work.create({
    data: {
      authorId,
      title: `设定作品-${randomUUID()}`,
      genreRulePackage: 'xuanhuan',
    },
  });
  return work.id;
}

function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    origin?: string;
  } = {},
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

const REALM_ATTRIBUTES = {
  minorLevelCount: 9,
  breakthroughCondition: '引气入体',
  lifespan: '一百年',
  powerBaseline: '凡境',
};

describe('设定中心接口（M2-B1）', () => {
  beforeAll(() => {
    db = getPrismaClient();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('未登录访问设定返回 401', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    const response = await settingsGet(request(`/api/works/${workId}/settings`), {
      params: Promise.resolve({ id: workId }),
    });
    expect(response.status).toBe(401);
  });

  it('管理员访问设定返回 403', async () => {
    const admin = await createUser('admin');
    const author = await createUser('author');
    const workId = await createWork(author.id);

    const response = await settingsGet(
      request(`/api/works/${workId}/settings`, { token: admin.token }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('已停用的作者访问设定返回 403；首登未改密的作者同样被拒', async () => {
    const disabled = await createUser('author', { status: 'disabled' });
    const pending = await createUser('author', { mustChangePassword: true });
    const workId = await createWork(disabled.id);

    const disabledResponse = await settingsGet(
      request(`/api/works/${workId}/settings`, { token: disabled.token }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(disabledResponse.status).toBe(403);

    const pendingResponse = await settingsGet(
      request(`/api/works/${workId}/settings`, { token: pending.token }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(pendingResponse.status).toBe(403);
    const body = (await pendingResponse.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('作者 B 访问作者 A 的作品设定返回 404', async () => {
    const authorA = await createUser('author');
    const authorB = await createUser('author');
    const workId = await createWork(authorA.id);

    const response = await settingsGet(
      request(`/api/works/${workId}/settings`, { token: authorB.token }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(response.status).toBe(404);
  });

  it('作品方向更新：缺 Origin 返回 403；合法值成功；未知字段 400', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    const noOrigin = await settingsPatch(
      request(`/api/works/${workId}/settings`, {
        method: 'PATCH',
        body: { direction: { subGenre: '东方玄幻', goldenFinger: '玉佩' } },
        token: author.token,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(noOrigin.status).toBe(403);

    const ok = await settingsPatch(
      request(`/api/works/${workId}/settings`, {
        method: 'PATCH',
        body: { direction: { subGenre: '东方玄幻', goldenFinger: '玉佩' } },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(ok.status).toBe(200);

    const bad = await settingsPatch(
      request(`/api/works/${workId}/settings`, {
        method: 'PATCH',
        body: { direction: { unknownField: 'x' } },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(bad.status).toBe(400);
  });

  it('PATCH 设定不允许修改规则包等不可变字段', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    for (const field of ['rulePackage', 'genreRulePackage', 'schemaRef', 'workId', 'authorId']) {
      const response = await settingsPatch(
        request(`/api/works/${workId}/settings`, {
          method: 'PATCH',
          body: { direction: { [field]: 'x' } },
          token: author.token,
          origin: ORIGIN,
        }),
        { params: Promise.resolve({ id: workId }) },
      );
      expect(response.status, `字段 ${field} 应当被拒绝`).toBe(400);
    }
  });

  it('创建实体：成功、重名 409、非法类型 400、非法属性 400', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    const created = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '炼气', attributes: REALM_ATTRIBUTES },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(created.status).toBe(201);

    const duplicate = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '炼气', attributes: REALM_ATTRIBUTES },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(duplicate.status).toBe(409);
    const duplicateBody = (await duplicate.json()) as { error: { code: string } };
    expect(duplicateBody.error.code).toBe('ENTITY_NAME_TAKEN');

    const badType = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'character', name: '主角', attributes: {} },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(badType.status).toBe(400);
    const typeBody = (await badType.json()) as { error: { code: string } };
    expect(typeBody.error.code).toBe('ENTITY_TYPE_NOT_ALLOWED');

    const badAttributes = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '筑基', attributes: { minorLevelCount: 9 } },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(badAttributes.status).toBe(400);
  });

  it('列出实体：只返回当前作品的 realm_level，按 order_index 升序', async () => {
    const author = await createUser('author');
    const other = await createUser('author');
    const workId = await createWork(author.id);
    const otherWorkId = await createWork(other.id);

    for (const [index, name] of ['甲', '乙'].entries()) {
      await entitiesPost(
        request(`/api/works/${workId}/entities`, {
          method: 'POST',
          body: {
            entityType: 'realm_level',
            name,
            orderIndex: 2 - index,
            attributes: REALM_ATTRIBUTES,
          },
          token: author.token,
          origin: ORIGIN,
        }),
        { params: Promise.resolve({ id: workId }) },
      );
    }
    await entitiesPost(
      request(`/api/works/${otherWorkId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '别作', attributes: REALM_ATTRIBUTES },
        token: other.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: otherWorkId }) },
    );

    const response = await entitiesGet(
      request(`/api/works/${workId}/entities?type=realm_level`, { token: author.token }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entities: { name: string }[] };
    expect(body.entities.map((item) => item.name)).toEqual(['乙', '甲']);
  });

  it('编辑实体：追加版本；不可变字段 400；他人实体 404', async () => {
    const author = await createUser('author');
    const other = await createUser('author');
    const workId = await createWork(author.id);

    const created = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '金丹', attributes: REALM_ATTRIBUTES },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    const { entity } = (await created.json()) as { entity: { id: string } };

    const patched = await entityPatch(
      request(`/api/works/${workId}/entities/${entity.id}`, {
        method: 'PATCH',
        body: { name: '金丹期', attributes: { ...REALM_ATTRIBUTES, lifespan: '两千年' } },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: entity.id }) },
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { entity: { version: number } };
    expect(patchedBody.entity.version).toBe(2);

    for (const field of ['id', 'workId', 'entityType', 'authorId', 'createdAt']) {
      const response = await entityPatch(
        request(`/api/works/${workId}/entities/${entity.id}`, {
          method: 'PATCH',
          body: { [field]: 'x' },
          token: author.token,
          origin: ORIGIN,
        }),
        { params: Promise.resolve({ id: workId, entityId: entity.id }) },
      );
      expect(response.status, `字段 ${field} 应当被拒绝`).toBe(400);
    }

    const forbidden = await entityPatch(
      request(`/api/works/${workId}/entities/${entity.id}`, {
        method: 'PATCH',
        body: { name: '被篡改' },
        token: other.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: entity.id }) },
    );
    expect(forbidden.status).toBe(404);
  });

  it('删除实体：被引用时 409 ENTITY_IN_USE；否则软删除', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    const created = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '化神', attributes: REALM_ATTRIBUTES },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    const { entity } = (await created.json()) as { entity: { id: string } };

    // 构造引用
    const referrer = await db.entity.create({
      data: { workId, entityType: 'realm_level', name: '引用者' },
    });
    await db.entityAttribute.create({
      data: {
        entityId: referrer.id,
        attrKey: 'realmLevelRef',
        attrValue: entity.id,
        schemaRef: 'xuanhuan@1.0.0',
      },
    });

    const inUse = await entityDelete(
      request(`/api/works/${workId}/entities/${entity.id}`, {
        method: 'DELETE',
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: entity.id }) },
    );
    expect(inUse.status).toBe(409);
    const inUseBody = (await inUse.json()) as { error: { code: string } };
    expect(inUseBody.error.code).toBe('ENTITY_IN_USE');

    const deleted = await entityDelete(
      request(`/api/works/${workId}/entities/${referrer.id}`, {
        method: 'DELETE',
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: referrer.id }) },
    );
    expect(deleted.status).toBe(200);
  });

  it('排序：拒绝重复 / 缺失 / 跨作品；合法排序生效', async () => {
    const author = await createUser('author');
    const other = await createUser('author');
    const workId = await createWork(author.id);
    const otherWorkId = await createWork(other.id);

    const ids: string[] = [];
    for (const name of ['一', '二']) {
      const created = await entitiesPost(
        request(`/api/works/${workId}/entities`, {
          method: 'POST',
          body: { entityType: 'realm_level', name, attributes: REALM_ATTRIBUTES },
          token: author.token,
          origin: ORIGIN,
        }),
        { params: Promise.resolve({ id: workId }) },
      );
      const { entity } = (await created.json()) as { entity: { id: string } };
      ids.push(entity.id);
    }
    const foreign = await entitiesPost(
      request(`/api/works/${otherWorkId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '别作', attributes: REALM_ATTRIBUTES },
        token: other.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: otherWorkId }) },
    );
    const foreignBody = (await foreign.json()) as { entity: { id: string } };

    for (const list of [
      [ids[0] as string, ids[0] as string],
      [ids[0] as string],
      [ids[0] as string, foreignBody.entity.id],
    ]) {
      const response = await reorderPut(
        request(`/api/works/${workId}/entities/reorder`, {
          method: 'PUT',
          body: { entityType: 'realm_level', entityIds: list },
          token: author.token,
          origin: ORIGIN,
        }),
        { params: Promise.resolve({ id: workId }) },
      );
      expect(response.status).toBe(400);
    }

    const ok = await reorderPut(
      request(`/api/works/${workId}/entities/reorder`, {
        method: 'PUT',
        body: { entityType: 'realm_level', entityIds: [ids[1] as string, ids[0] as string] },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { entities: { name: string }[] };
    expect(body.entities.map((item) => item.name)).toEqual(['二', '一']);
  });

  it('响应不包含其他作者的作品 id 与敏感字段', async () => {
    const author = await createUser('author');
    const other = await createUser('author');
    const workId = await createWork(author.id);
    const otherWorkId = await createWork(other.id);

    await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '炼气', attributes: REALM_ATTRIBUTES },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );

    const response = await settingsGet(
      request(`/api/works/${workId}/settings`, { token: author.token }),
      { params: Promise.resolve({ id: workId }) },
    );
    const text = await response.text();
    expect(text).not.toContain(otherWorkId);
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('argon2');
    expect(text).not.toContain('authorId');
  });
});
