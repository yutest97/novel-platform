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
        body: { entityType: 'location', name: '断剑', attributes: {} },
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

    // 排序值由服务端独占：POST 不再接受 orderIndex，
    // 先按创建顺序得到 1、2，再用 reorder 调整成 ['乙', '甲']。
    const createdIds: string[] = [];
    for (const name of ['甲', '乙']) {
      const response = await entitiesPost(
        request(`/api/works/${workId}/entities`, {
          method: 'POST',
          body: { entityType: 'realm_level', name, attributes: REALM_ATTRIBUTES },
          token: author.token,
          origin: ORIGIN,
        }),
        { params: Promise.resolve({ id: workId }) },
      );
      expect(response.status).toBe(201);
      const { entity } = (await response.json()) as { entity: { id: string } };
      createdIds.push(entity.id);
    }

    const reorder = await reorderPut(
      request(`/api/works/${workId}/entities/reorder`, {
        method: 'PUT',
        body: { entityType: 'realm_level', entityIds: [...createdIds].reverse() },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(reorder.status).toBe(200);

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

  it('实体 PATCH 是严格允许列表：只接受 name / attributes', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    const created = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '元婴', attributes: REALM_ATTRIBUTES },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    const { entity } = (await created.json()) as { entity: { id: string } };

    // 逐个字段：服务端字段、排序值（服务端独占）与完全陌生的字段都必须 400
    const forbiddenFields = [
      'id',
      'workId',
      'work_id',
      'authorId',
      'author_id',
      'entityType',
      'entity_type',
      'orderIndex',
      'order_index',
      'createdAt',
      'created_at',
      'updatedAt',
      'updated_at',
      'deletedAt',
      'deleted_at',
      'unknownField',
    ];

    for (const field of forbiddenFields) {
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
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code, `字段 ${field} 的错误码`).toBe('VALIDATION_FAILED');
    }

    // 允许的两个字段都能通过
    const allowed = await entityPatch(
      request(`/api/works/${workId}/entities/${entity.id}`, {
        method: 'PATCH',
        body: {
          name: '元婴期',
          attributes: { ...REALM_ATTRIBUTES, lifespan: '五千年' },
        },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: entity.id }) },
    );
    expect(allowed.status).toBe(200);
  });

  it('排序值服务端独占：PATCH orderIndex 一律 400，顺序只能靠完整 reorder 改变', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    // 1) 顺序创建两个实体 → 服务端自动得到 order_index 1、2
    const ids: string[] = [];
    for (const name of ['甲', '乙']) {
      const response = await entitiesPost(
        request(`/api/works/${workId}/entities`, {
          method: 'POST',
          body: { entityType: 'realm_level', name, attributes: REALM_ATTRIBUTES },
          token: author.token,
          origin: ORIGIN,
        }),
        { params: Promise.resolve({ id: workId }) },
      );
      expect(response.status).toBe(201);
      const { entity } = (await response.json()) as { entity: { id: string; orderIndex: number } };
      ids.push(entity.id);
      expect(entity.orderIndex, '新建时由服务端追加排序值').toBe(ids.length);
    }

    const readOrderIndexes = async (): Promise<number[]> => {
      const rows = await db.entity.findMany({
        where: { workId, entityType: 'realm_level', deletedAt: null },
        select: { id: true, orderIndex: true },
      });
      return ids.map((id) => rows.find((row) => row.id === id)?.orderIndex ?? -1);
    };

    expect(await readOrderIndexes(), '两个实体顺序应为 1、2').toEqual([1, 2]);

    // 2) PATCH 第二个实体提交 orderIndex=1 必须 400
    for (const field of ['orderIndex', 'order_index']) {
      const response = await entityPatch(
        request(`/api/works/${workId}/entities/${ids[1]}`, {
          method: 'PATCH',
          body: { [field]: 1 },
          token: author.token,
          origin: ORIGIN,
        }),
        { params: Promise.resolve({ id: workId, entityId: ids[1] as string }) },
      );
      expect(response.status, `PATCH ${field} 必须 400`).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_FAILED');
    }

    // 3) 数据库中的 order_index 仍然是 1、2（没有被越权改写）
    expect(await readOrderIndexes(), 'order_index 必须保持不变').toEqual([1, 2]);

    // 混在合法字段里也不允许：不能让 orderIndex 借道 attributes/name 蒙混过关
    const mixed = await entityPatch(
      request(`/api/works/${workId}/entities/${ids[1]}`, {
        method: 'PATCH',
        body: { name: '乙改', orderIndex: 1 },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: ids[1] as string }) },
    );
    expect(mixed.status, '混入 orderIndex 也必须整体拒绝').toBe(400);
    expect(await readOrderIndexes()).toEqual([1, 2]);

    // 4) 合法顺序只能通过完整 reorder 请求改变
    const reorder = await reorderPut(
      request(`/api/works/${workId}/entities/reorder`, {
        method: 'PUT',
        body: { entityType: 'realm_level', entityIds: [ids[1], ids[0]] },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(reorder.status).toBe(200);
    expect(await readOrderIndexes(), 'reorder 后顺序应为 2、1').toEqual([2, 1]);

    // 不完整的 reorder 仍然被拒绝
    const partial = await reorderPut(
      request(`/api/works/${workId}/entities/reorder`, {
        method: 'PUT',
        body: { entityType: 'realm_level', entityIds: [ids[0]] },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(partial.status).toBe(400);
    expect(await readOrderIndexes(), '失败的 reorder 不得改变顺序').toEqual([2, 1]);
  });

  it('更新 attributes 只替换当前 schemaRef：旧契约属性不删除也不混入响应', async () => {
    const author = await createUser('author');
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

    // 手工插入一条**旧契约**（xuanhuan@1.0.0）的属性。
    // 其中 legacyOnly 只在旧契约里存在；lifespan 与当前契约同名但取值不同，
    // 用来验证"同名不同契约"不会串味。
    const legacySchemaRef = 'xuanhuan@1.0.0';
    await db.entityAttribute.create({
      data: {
        entityId: entity.id,
        attrKey: 'legacyOnly',
        attrValue: '旧契约专属字段',
        schemaRef: legacySchemaRef,
      },
    });
    await db.entityAttribute.create({
      data: {
        entityId: entity.id,
        attrKey: 'lifespan',
        attrValue: '旧契约寿命值',
        schemaRef: legacySchemaRef,
      },
    });

    const patched = await entityPatch(
      request(`/api/works/${workId}/entities/${entity.id}`, {
        method: 'PATCH',
        body: { attributes: { ...REALM_ATTRIBUTES, lifespan: '新契约寿命值' } },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: entity.id }) },
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as {
      entity: { attributes: Record<string, unknown>; version: number };
    };

    // 旧契约属性不得出现在响应里
    expect(patchedBody.entity.attributes).not.toHaveProperty('legacyOnly');
    // 同名 key 取当前契约的值，不能被旧契约覆盖
    expect(patchedBody.entity.attributes['lifespan']).toBe('新契约寿命值');

    // 旧契约的属性行必须**仍然存在**（不能被当前契约的编辑连带删除）
    const legacyRows = await db.entityAttribute.findMany({
      where: { entityId: entity.id, schemaRef: legacySchemaRef },
      select: { attrKey: true, attrValue: true },
    });
    expect(legacyRows.map((row) => row.attrKey).sort()).toEqual(['legacyOnly', 'lifespan']);

    // 新版本快照里同样不得出现旧契约属性
    const latest = await db.entityVersion.findFirst({
      where: { entityId: entity.id },
      orderBy: { versionNo: 'desc' },
      select: { snapshot: true },
    });
    const snapshotAttributes = (latest?.snapshot as { attributes: Record<string, unknown> })
      .attributes;
    expect(snapshotAttributes).not.toHaveProperty('legacyOnly');
    expect(snapshotAttributes['lifespan']).toBe('新契约寿命值');
  });

  it('只改名称时版本快照只读取当前 schemaRef 的属性', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    const created = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '筑基', attributes: REALM_ATTRIBUTES },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    const { entity } = (await created.json()) as { entity: { id: string } };

    await db.entityAttribute.create({
      data: {
        entityId: entity.id,
        attrKey: 'legacyOnly',
        attrValue: '旧契约专属字段',
        schemaRef: 'xuanhuan@1.0.0',
      },
    });

    // 只提交 name，不提交 attributes
    const patched = await entityPatch(
      request(`/api/works/${workId}/entities/${entity.id}`, {
        method: 'PATCH',
        body: { name: '筑基期' },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: entity.id }) },
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as {
      entity: { attributes: Record<string, unknown>; version: number };
    };
    expect(patchedBody.entity.attributes).not.toHaveProperty('legacyOnly');

    // 新版本快照也必须只含当前契约的属性
    const snapshotRow = await db.entityVersion.findFirst({
      where: { entityId: entity.id },
      orderBy: { versionNo: 'desc' },
      select: { snapshot: true },
    });
    const snapshotAttributes = (snapshotRow?.snapshot as { attributes: Record<string, unknown> })
      .attributes;
    expect(snapshotAttributes).not.toHaveProperty('legacyOnly');
    expect(snapshotAttributes['minorLevelCount']).toBe(REALM_ATTRIBUTES.minorLevelCount);
  });

  it('实体 POST 拒绝服务端字段（id / workId / authorId / orderIndex / 时间戳等）', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    const forbiddenFields = [
      'id',
      'workId',
      'work_id',
      'authorId',
      'author_id',
      // 排序值由服务端独占：POST 也不能指定
      'orderIndex',
      'order_index',
      'createdAt',
      'created_at',
      'updatedAt',
      'updated_at',
      'deletedAt',
      'deleted_at',
      'unknownField',
    ];

    for (const field of forbiddenFields) {
      const response = await entitiesPost(
        request(`/api/works/${workId}/entities`, {
          method: 'POST',
          body: {
            entityType: 'realm_level',
            name: `实体-${field}`,
            attributes: REALM_ATTRIBUTES,
            [field]: 'x',
          },
          token: author.token,
          origin: ORIGIN,
        }),
        { params: Promise.resolve({ id: workId }) },
      );
      expect(response.status, `字段 ${field} 应当被拒绝`).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code, `字段 ${field} 的错误码`).toBe('VALIDATION_FAILED');
    }
  });

  it('列出实体只接受规则包声明且本轮支持的类型；其余 400', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    for (const entityType of ['location', 'unknown']) {
      const response = await entitiesGet(
        request(`/api/works/${workId}/entities?type=${entityType}`, { token: author.token }),
        { params: Promise.resolve({ id: workId }) },
      );
      expect(response.status, `类型 ${entityType} 应 400`).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('ENTITY_TYPE_NOT_ALLOWED');
    }

    // 本轮支持的五类都正常返回（初始为空）
    for (const entityType of ['realm_level', 'faction', 'character', 'item', 'technique']) {
      const ok = await entitiesGet(
        request(`/api/works/${workId}/entities?type=${entityType}`, { token: author.token }),
        { params: Promise.resolve({ id: workId }) },
      );
      expect(ok.status, `类型 ${entityType} 应 200`).toBe(200);
      const okBody = (await ok.json()) as { entities: unknown[] };
      expect(okBody.entities).toEqual([]);
    }
  });

  it('畸形 workId / entityId 返回稳定的 400 或 404，不产生 500', async () => {
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
    expect(created.status).toBe(201);

    // 畸形 workId
    const badWorkId = 'not-a-uuid';
    const listBadWork = await entitiesGet(
      request(`/api/works/${badWorkId}/entities?type=realm_level`, { token: author.token }),
      { params: Promise.resolve({ id: badWorkId }) },
    );
    expect([400, 404]).toContain(listBadWork.status);
    expect(listBadWork.status).not.toBe(500);

    const settingsBadWork = await settingsGet(
      request(`/api/works/${badWorkId}/settings`, { token: author.token }),
      { params: Promise.resolve({ id: badWorkId }) },
    );
    expect([400, 404]).toContain(settingsBadWork.status);
    expect(settingsBadWork.status).not.toBe(500);

    const postBadWork = await entitiesPost(
      request(`/api/works/${badWorkId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '畸形', attributes: REALM_ATTRIBUTES },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: badWorkId }) },
    );
    expect([400, 404]).toContain(postBadWork.status);
    expect(postBadWork.status).not.toBe(500);

    // 畸形 entityId
    const badEntityId = '12345';
    const patchBadEntity = await entityPatch(
      request(`/api/works/${workId}/entities/${badEntityId}`, {
        method: 'PATCH',
        body: { name: '改名' },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: badEntityId }) },
    );
    expect([400, 404]).toContain(patchBadEntity.status);
    expect(patchBadEntity.status).not.toBe(500);

    const deleteBadEntity = await entityDelete(
      request(`/api/works/${workId}/entities/${badEntityId}`, {
        method: 'DELETE',
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: badEntityId }) },
    );
    expect([400, 404]).toContain(deleteBadEntity.status);
    expect(deleteBadEntity.status).not.toBe(500);
  });

  it('作品方向清空后刷新仍为空（接口层）', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    const saved = await settingsPatch(
      request(`/api/works/${workId}/settings`, {
        method: 'PATCH',
        body: {
          direction: {
            subGenre: '东方玄幻',
            goldenFinger: '残破玉佩',
            toneStyle: '热血激昂',
            protagonistPosition: '废柴逆袭',
          },
        },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as { direction: Record<string, unknown> };
    expect(savedBody.direction['toneStyle']).toBe('热血激昂');

    // 清空两个可选字段
    const cleared = await settingsPatch(
      request(`/api/works/${workId}/settings`, {
        method: 'PATCH',
        body: {
          direction: {
            subGenre: '东方玄幻',
            goldenFinger: '残破玉佩',
          },
        },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as { direction: Record<string, unknown> };
    expect(clearedBody.direction['toneStyle']).toBeUndefined();
    expect(clearedBody.direction['protagonistPosition']).toBeUndefined();

    // 刷新
    const reloaded = await settingsGet(
      request(`/api/works/${workId}/settings`, { token: author.token }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(reloaded.status).toBe(200);
    const reloadedBody = (await reloaded.json()) as {
      settings: { direction: Record<string, unknown> };
    };
    expect(reloadedBody.settings.direction['toneStyle']).toBeUndefined();
    expect(reloadedBody.settings.direction['protagonistPosition']).toBeUndefined();
    expect(reloadedBody.settings.direction['subGenre']).toBe('东方玄幻');
  });

  it('删除实体：被引用时 409 ENTITY_IN_USE 并返回安全引用摘要；解引用后可删', async () => {
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

    // 真实引用：人物 initialRealm → 该境界（含敏感字段"秘密"，不得出现在摘要里）
    const referrerResponse = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: {
          entityType: 'character',
          name: '林青',
          attributes: { identity: '外门弟子', secret: '其实是魔宗卧底', initialRealm: entity.id },
        },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(referrerResponse.status).toBe(201);
    const referrer = (await referrerResponse.json()) as { entity: { id: string } };

    const inUse = await entityDelete(
      request(`/api/works/${workId}/entities/${entity.id}`, {
        method: 'DELETE',
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: entity.id }) },
    );
    expect(inUse.status).toBe(409);
    const inUseBody = (await inUse.json()) as {
      error: {
        code: string;
        references: {
          total: number;
          items: { id: string; entityType: string; name: string }[];
        };
      };
    };
    expect(inUseBody.error.code).toBe('ENTITY_IN_USE');
    expect(inUseBody.error.references.total).toBe(1);
    expect(inUseBody.error.references.items).toEqual([
      { id: referrer.entity.id, entityType: 'character', name: '林青' },
    ]);
    // 摘要绝不能带属性值（秘密）
    expect(JSON.stringify(inUseBody)).not.toContain('魔宗卧底');
    expect(JSON.stringify(inUseBody)).not.toContain('外门弟子');

    // 解除引用后可以删除
    const patched = await entityPatch(
      request(`/api/works/${workId}/entities/${referrer.entity.id}`, {
        method: 'PATCH',
        body: { attributes: { identity: '外门弟子' } },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: referrer.entity.id }) },
    );
    expect(patched.status).toBe(200);

    const deleted = await entityDelete(
      request(`/api/works/${workId}/entities/${entity.id}`, {
        method: 'DELETE',
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: entity.id }) },
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

  it('设定中心返回规范化 entityGroups：五个分组、按 order 排序、无 realms 字段', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    const response = await settingsGet(
      request(`/api/works/${workId}/settings`, { token: author.token }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      settings: {
        realms?: unknown;
        entityGroups: {
          entityType: string;
          title: string;
          schemaRef: string;
          order: number;
          entities: { name: string }[];
        }[];
      };
    };

    expect(body.settings.realms, 'realms 字段必须被移除，不留别名').toBeUndefined();
    expect(body.settings.entityGroups.map((group) => group.entityType)).toEqual([
      'realm_level',
      'faction',
      'character',
      'item',
      'technique',
    ]);
    expect(body.settings.entityGroups.map((group) => group.order)).toEqual([1, 2, 3, 4, 5]);
    expect(body.settings.entityGroups.map((group) => group.title)).toEqual([
      '境界体系',
      '势力',
      '人物',
      '物品',
      '功法',
    ]);
    for (const group of body.settings.entityGroups) {
      expect(group.schemaRef).toBe('xuanhuan@4.0.0');
      expect(group.entities).toEqual([]);
    }
  });

  it('势力与人物：enum 取值、引用校验、跨作品引用与排序互相独立', async () => {
    const author = await createUser('author');
    const other = await createUser('author');
    const workId = await createWork(author.id);
    const otherWorkId = await createWork(other.id);

    // 非法 enum 取值 → 400
    const badEnum = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'faction', name: '非法势力', attributes: { type: 'not-an-option' } },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(badEnum.status).toBe(400);
    expect(((await badEnum.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );

    // 缺少必填 enum → 400
    const missingEnum = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'faction', name: '无类型势力', attributes: {} },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(missingEnum.status).toBe(400);

    // 合法：境界 + 势力 + 人物引用
    const realmResponse = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '炼气', attributes: REALM_ATTRIBUTES },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    const realmId = ((await realmResponse.json()) as { entity: { id: string } }).entity.id;

    const factionResponse = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'faction', name: '青云宗', attributes: { type: 'sect' } },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(factionResponse.status).toBe(201);
    const factionId = ((await factionResponse.json()) as { entity: { id: string } }).entity.id;

    const characterResponse = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: {
          entityType: 'character',
          name: '林青',
          attributes: { identity: '弟子', initialRealm: realmId, faction: factionId },
        },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(characterResponse.status).toBe(201);
    const characterBody = (await characterResponse.json()) as {
      entity: { orderIndex: number; attributes: Record<string, unknown> };
    };
    // 每类型独立 1..N：人物是第一个人物
    expect(characterBody.entity.orderIndex).toBe(1);
    expect(characterBody.entity.attributes['initialRealm']).toBe(realmId);

    // 跨作品引用 → 400（文案与"不存在"一致）
    const otherRealmResponse = await entitiesPost(
      request(`/api/works/${otherWorkId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '别人的境界', attributes: REALM_ATTRIBUTES },
        token: other.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: otherWorkId }) },
    );
    const otherRealmId = ((await otherRealmResponse.json()) as { entity: { id: string } }).entity
      .id;

    const crossWork = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: {
          entityType: 'character',
          name: '丙',
          attributes: { initialRealm: otherRealmId },
        },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(crossWork.status).toBe(400);
    const crossWorkBody = (await crossWork.json()) as { error: { code: string; message: string } };
    expect(crossWorkBody.error.code).toBe('VALIDATION_FAILED');
    expect(crossWorkBody.error.message).toContain('引用目标不存在');

    // 排序按类型独立：只排 realm_level 不影响 faction/character
    const reorder = await reorderPut(
      request(`/api/works/${workId}/entities/reorder`, {
        method: 'PUT',
        body: { entityType: 'realm_level', entityIds: [realmId] },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(reorder.status).toBe(200);

    const settings = await settingsGet(
      request(`/api/works/${workId}/settings`, { token: author.token }),
      { params: Promise.resolve({ id: workId }) },
    );
    const settingsBody = (await settings.json()) as {
      settings: { entityGroups: { entityType: string; entities: { name: string }[] }[] };
    };
    const groupOf = (key: string): { name: string }[] =>
      settingsBody.settings.entityGroups.find((group) => group.entityType === key)?.entities ?? [];
    expect(groupOf('realm_level').map((item) => item.name)).toEqual(['炼气']);
    expect(groupOf('faction').map((item) => item.name)).toEqual(['青云宗']);
    expect(groupOf('character').map((item) => item.name)).toEqual(['林青']);
  });

  it('reorder 的 entityType 出现时必须是字符串：数字 / null / 数组 / 对象都 400 且不改顺序', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    /** 当前 realm_level 的 order_index 顺序（按 id 表示）。 */
    const readOrder = async (): Promise<string[]> => {
      const rows = await db.entity.findMany({
        where: { workId, entityType: 'realm_level', deletedAt: null },
        orderBy: { orderIndex: 'asc' },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    };

    const ids: string[] = [];
    for (const name of ['炼气', '筑基']) {
      const created = await entitiesPost(
        request(`/api/works/${workId}/entities`, {
          method: 'POST',
          body: { entityType: 'realm_level', name, attributes: REALM_ATTRIBUTES },
          token: author.token,
          origin: ORIGIN,
        }),
        { params: Promise.resolve({ id: workId }) },
      );
      expect(created.status).toBe(201);
      ids.push(((await created.json()) as { entity: { id: string } }).entity.id);
    }

    const before = await readOrder();
    expect(before).toEqual(ids);

    // 数字 / null / 数组 / 对象 / 布尔都不是字符串：一律 400，且不得被当成默认类型
    for (const entityType of [123, null, [], {}, true]) {
      const response = await reorderPut(
        request(`/api/works/${workId}/entities/reorder`, {
          method: 'PUT',
          body: { entityType, entityIds: [ids[1], ids[0]] },
          token: author.token,
          origin: ORIGIN,
        }),
        { params: Promise.resolve({ id: workId }) },
      );
      expect(response.status, `entityType=${JSON.stringify(entityType)} 应当 400`).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code, `entityType=${JSON.stringify(entityType)} 的错误码`).toBe(
        'VALIDATION_FAILED',
      );
    }

    // 一次都没有改动 order_index
    expect(await readOrder()).toEqual(before);

    // 合法请求仍然生效（顺序确实能被重排）
    const reordered = await reorderPut(
      request(`/api/works/${workId}/entities/reorder`, {
        method: 'PUT',
        body: { entityType: 'realm_level', entityIds: [ids[1], ids[0]] },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(reordered.status).toBe(200);
    expect(await readOrder()).toEqual([ids[1], ids[0]]);

    // 未提供 entityType：仍默认 realm_level（兼容旧调用方）
    const withoutType = await reorderPut(
      request(`/api/works/${workId}/entities/reorder`, {
        method: 'PUT',
        body: { entityIds: [ids[0], ids[1]] },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(withoutType.status).toBe(200);
    expect(await readOrder()).toEqual([ids[0], ids[1]]);
  });

  it('物品与功法：enum 取值、item 无 holder、功法引用境界与删除保护', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    // 1) 创建境界（功法的门槛）
    const realmResponse = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'realm_level', name: '炼气', attributes: REALM_ATTRIBUTES },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(realmResponse.status).toBe(201);
    const realmId = ((await realmResponse.json()) as { entity: { id: string } }).entity.id;

    // 2) 物品：enum 提交 value，响应回显 value；holder 不是规则包字段
    const itemResponse = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: {
          entityType: 'item',
          name: '青锋剑',
          attributes: { category: 'weapon', quality: 'mystic', acquisition: '秘境所得' },
        },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(itemResponse.status).toBe(201);
    const itemBody = (await itemResponse.json()) as {
      entity: { id: string; attributes: Record<string, unknown> };
    };
    expect(itemBody.entity.attributes).toEqual({
      category: 'weapon',
      quality: 'mystic',
      acquisition: '秘境所得',
    });

    const withHolder = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: {
          entityType: 'item',
          name: '带持有人的剑',
          attributes: { category: 'weapon', quality: 'spirit', holder: author.id },
        },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(withHolder.status).toBe(400);
    expect(((await withHolder.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );

    const badCategory = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: {
          entityType: 'item',
          name: '非法类别',
          attributes: { category: 'not-an-option', quality: 'spirit' },
        },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(badCategory.status).toBe(400);

    // 3) 功法：境界门槛引用境界；指向势力则 400
    const techniqueResponse = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: {
          entityType: 'technique',
          name: '青元剑诀',
          attributes: { type: 'cultivation', realmRequirement: realmId, effect: '剑气纵横' },
        },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(techniqueResponse.status).toBe(201);
    const technique = (
      (await techniqueResponse.json()) as {
        entity: { id: string; attributes: Record<string, unknown> };
      }
    ).entity;
    expect(technique.attributes['realmRequirement']).toBe(realmId);

    const factionResponse = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: { entityType: 'faction', name: '青云宗', attributes: { type: 'sect' } },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    const factionId = ((await factionResponse.json()) as { entity: { id: string } }).entity.id;

    const wrongType = await entitiesPost(
      request(`/api/works/${workId}/entities`, {
        method: 'POST',
        body: {
          entityType: 'technique',
          name: '错误门槛',
          attributes: { type: 'martial', realmRequirement: factionId },
        },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(wrongType.status).toBe(400);

    // 4) 删除被功法引用的境界 → 409 + 摘要里是功法
    const blocked = await entityDelete(
      request(`/api/works/${workId}/entities/${realmId}`, {
        method: 'DELETE',
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: realmId }) },
    );
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as {
      error: {
        code: string;
        references: { total: number; items: { id: string; entityType: string; name: string }[] };
      };
    };
    expect(blockedBody.error.code).toBe('ENTITY_IN_USE');
    expect(blockedBody.error.references).toEqual({
      total: 1,
      items: [{ id: technique.id, entityType: 'technique', name: '青元剑诀' }],
    });

    // 5) 解除引用后可删
    const cleared = await entityPatch(
      request(`/api/works/${workId}/entities/${technique.id}`, {
        method: 'PATCH',
        body: { attributes: { type: 'cultivation', effect: '剑气纵横' } },
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: technique.id }) },
    );
    expect(cleared.status).toBe(200);

    const deleted = await entityDelete(
      request(`/api/works/${workId}/entities/${realmId}`, {
        method: 'DELETE',
        token: author.token,
        origin: ORIGIN,
      }),
      { params: Promise.resolve({ id: workId, entityId: realmId }) },
    );
    expect(deleted.status).toBe(200);

    // 6) 设定中心里五类分区都在，且 item / technique 各有一条
    const settings = await settingsGet(
      request(`/api/works/${workId}/settings`, { token: author.token }),
      { params: Promise.resolve({ id: workId }) },
    );
    const settingsBody = (await settings.json()) as {
      settings: { entityGroups: { entityType: string; entities: { name: string }[] }[] };
    };
    const namesOf = (type: string): string[] =>
      settingsBody.settings.entityGroups
        .find((group) => group.entityType === type)
        ?.entities.map((entity) => entity.name) ?? [];
    expect(namesOf('item')).toEqual(['青锋剑']);
    expect(namesOf('technique')).toEqual(['青元剑诀']);
  });
});
