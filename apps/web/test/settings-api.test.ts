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

  it('列出实体只接受 realm_level；其它类型一律 400', async () => {
    const author = await createUser('author');
    const workId = await createWork(author.id);

    const response = await entitiesGet(
      request(`/api/works/${workId}/entities?type=character`, { token: author.token }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ENTITY_TYPE_NOT_ALLOWED');

    // 允许的类型正常返回
    const ok = await entitiesGet(
      request(`/api/works/${workId}/entities?type=realm_level`, { token: author.token }),
      { params: Promise.resolve({ id: workId }) },
    );
    expect(ok.status).toBe(200);
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
