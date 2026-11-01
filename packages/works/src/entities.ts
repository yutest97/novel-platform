/**
 * 设定中心与通用实体（M2-B1）。
 *
 * 权限与隔离（硬约束）：
 * - 所有读写都以 `workId + authorId` 为边界：只允许作品所有者访问；
 *   他人的作品一律按"不存在"处理（404），不泄露是否存在；
 * - 管理员不能通过本模块的任何接口读取或修改作者作品；
 * - 写操作与审计写入在**同一事务**内完成：审计失败则业务修改回滚；
 * - 审计 detail 只记录 workId / entityId / entityType / 操作字段名，
 *   **不记录完整设定值**。
 *
 * 本轮只开放 `realm_level`（境界体系）一种实体类型；
 * 人物、势力、功法、物品等留给后续阶段。
 */

import { AUDIT_ACTIONS, AuthError, writeAuditLog, type RequestMeta } from '@novel/auth';
import type { PrismaClient } from '@novel/db';

import {
  buildSchemaSummary,
  entityTypeGroup,
  validateFields,
  type SchemaSummary,
} from './schema.js';

/** 第一版唯一开放的实体类型。 */
export const ALLOWED_ENTITY_TYPE = 'realm_level';

/** 实体名称长度上限。 */
export const MAX_ENTITY_NAME_LENGTH = 60;

/** 实体对外视图。 */
export interface EntityView {
  readonly id: string;
  readonly entityType: string;
  readonly name: string;
  readonly orderIndex: number | null;
  readonly attributes: Record<string, unknown>;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 设定中心视图。 */
export interface SettingsCenterView {
  readonly workId: string;
  readonly workTitle: string;
  readonly direction: Record<string, unknown>;
  readonly schema: SchemaSummary;
  readonly realms: readonly EntityView[];
}

/** 内部：作品 + 规则包。 */
interface WorkContext {
  readonly id: string;
  readonly title: string;
  readonly genreRulePackage: string;
}

/**
 * 读取作品上下文（并确认属于当前作者）。
 *
 * 非所有者一律 404。
 */
async function requireOwnedWork(
  db: PrismaClient,
  workId: string,
  authorId: string,
): Promise<WorkContext> {
  const work = await db.work.findFirst({
    where: { id: workId, authorId },
    select: { id: true, title: true, genreRulePackage: true },
  });
  if (work === null) {
    throw new AuthError('NOT_FOUND', '作品不存在');
  }
  return work;
}

/** 读取作品对应的规则包（必须是启用中的）。 */
async function requireRulePackage(
  db: PrismaClient,
  code: string,
): Promise<{ code: string; name: string; version: string; fieldSchema: unknown }> {
  const rulePackage = await db.rulePackage.findUnique({ where: { code } });
  if (rulePackage === null || !rulePackage.active) {
    throw new AuthError('INVALID_RULE_PACKAGE');
  }
  return rulePackage;
}

/** 数据库行 → 实体视图。 */
function toEntityView(
  entity: {
    id: string;
    entityType: string;
    name: string;
    orderIndex: number | null;
    createdAt: Date;
    updatedAt: Date;
  },
  attributes: readonly { attrKey: string; attrValue: unknown }[],
  version: number,
): EntityView {
  const values: Record<string, unknown> = {};
  for (const attribute of attributes) {
    values[attribute.attrKey] = attribute.attrValue;
  }
  return {
    id: entity.id,
    entityType: entity.entityType,
    name: entity.name,
    orderIndex: entity.orderIndex,
    attributes: values,
    version,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

/** 读取实体的属性与最新版本号。 */
async function loadEntityDetails(
  db: PrismaClient,
  entityId: string,
): Promise<{ attributes: { attrKey: string; attrValue: unknown }[]; version: number }> {
  const [attributes, latest] = await Promise.all([
    db.entityAttribute.findMany({
      where: { entityId },
      orderBy: [{ attrKey: 'asc' }],
      select: { attrKey: true, attrValue: true },
    }),
    db.entityVersion.findFirst({
      where: { entityId },
      orderBy: { versionNo: 'desc' },
      select: { versionNo: true },
    }),
  ]);
  return { attributes, version: latest?.versionNo ?? 0 };
}

/** 读取作品方向设定（work_settings 中 schema_ref 指向规则包版本的那一组）。 */
async function loadDirection(db: PrismaClient, workId: string): Promise<Record<string, unknown>> {
  const rows = await db.workSetting.findMany({
    where: { workId },
    orderBy: [{ settingKey: 'asc' }],
    select: { settingKey: true, settingValue: true },
  });
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    values[row.settingKey] = row.settingValue;
  }
  return values;
}

/** 列出作品内指定类型的实体（未删除），按 order_index 升序。 */
export async function listEntities(
  db: PrismaClient,
  input: { workId: string; authorId: string; entityType: string },
): Promise<EntityView[]> {
  await requireOwnedWork(db, input.workId, input.authorId);

  const entities = await db.entity.findMany({
    where: { workId: input.workId, entityType: input.entityType, deletedAt: null },
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      entityType: true,
      name: true,
      orderIndex: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const result: EntityView[] = [];
  for (const entity of entities) {
    const details = await loadEntityDetails(db, entity.id);
    result.push(toEntityView(entity, details.attributes, details.version));
  }
  return result;
}

/** 读取设定中心（作品方向 + schema 摘要 + 境界体系）。 */
export async function getSettingsCenter(
  db: PrismaClient,
  input: { workId: string; authorId: string },
): Promise<SettingsCenterView> {
  const work = await requireOwnedWork(db, input.workId, input.authorId);
  const rulePackage = await requireRulePackage(db, work.genreRulePackage);

  const [direction, realms] = await Promise.all([
    loadDirection(db, work.id),
    listEntities(db, {
      workId: work.id,
      authorId: input.authorId,
      entityType: ALLOWED_ENTITY_TYPE,
    }),
  ]);

  return {
    workId: work.id,
    workTitle: work.title,
    direction,
    schema: buildSchemaSummary(rulePackage),
    realms,
  };
}

/** 更新作品方向的输入。 */
export interface UpdateDirectionInput {
  readonly workId: string;
  readonly authorId: string;
  readonly values: Record<string, unknown>;
  readonly meta: RequestMeta;
}

/**
 * 更新作品方向。
 *
 * - 字段必须符合规则包的 field_schema（类型、必填、范围、未知字段一律拒绝）；
 * - 与 `settings.updated` 审计同事务；
 * - 客户端不能修改规则包 code（方向设定由服务端按作品的规则包决定）。
 */
export async function updateDirection(
  db: PrismaClient,
  input: UpdateDirectionInput,
): Promise<Record<string, unknown>> {
  const work = await requireOwnedWork(db, input.workId, input.authorId);
  const rulePackage = await requireRulePackage(db, work.genreRulePackage);

  const group = entityTypeGroup(rulePackage, 'workDirection');
  const directionGroup = group ?? buildSchemaSummary(rulePackage).workDirection ?? null;
  if (directionGroup === null) {
    throw new AuthError('VALIDATION_FAILED', '当前题材没有定义作品方向字段');
  }

  const validated = validateFields(directionGroup, input.values);
  const schemaRef = directionGroup.schemaRef;

  await db.$transaction(async (tx) => {
    for (const [key, value] of Object.entries(validated)) {
      await tx.workSetting.upsert({
        where: {
          workId_settingKey_schemaRef: {
            workId: work.id,
            settingKey: key,
            schemaRef,
          },
        },
        create: {
          workId: work.id,
          settingKey: key,
          settingValue: value as never,
          schemaRef,
        },
        update: { settingValue: value as never },
      });
    }

    await writeAuditLog(tx, {
      action: AUDIT_ACTIONS.SETTINGS_UPDATED,
      actorId: input.authorId,
      targetType: 'work',
      targetId: work.id,
      // 只记录改动的字段名，不记录具体设定值
      detail: {
        workId: work.id,
        fields: Object.keys(validated),
        schemaRef,
      },
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });
  });

  return loadDirection(db, work.id);
}

/** 创建实体的输入。 */
export interface CreateEntityInput {
  readonly workId: string;
  readonly authorId: string;
  readonly entityType: string;
  readonly name: string;
  readonly orderIndex?: number | null;
  readonly attributes: Record<string, unknown>;
  readonly meta: RequestMeta;
}

/** 校验实体名称。 */
export function normalizeEntityName(input: string): string {
  const name = input.trim();
  if (name === '') {
    throw new AuthError('VALIDATION_FAILED', '名称不能为空');
  }
  if (name.length > MAX_ENTITY_NAME_LENGTH) {
    throw new AuthError('VALIDATION_FAILED', `名称最长 ${MAX_ENTITY_NAME_LENGTH} 个字符`);
  }
  return name;
}

/** 构造实体的版本快照。 */
function buildSnapshot(
  entity: { id: string; entityType: string; name: string; orderIndex: number | null },
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: entity.id,
    entityType: entity.entityType,
    name: entity.name,
    orderIndex: entity.orderIndex,
    attributes,
  };
}

/**
 * 创建实体。
 *
 * - 第一版只开放 `realm_level`；
 * - 属性按规则包的字段定义校验；
 * - 创建 + 第一版快照 + `entity.created` 审计同事务；
 * - 同作品同类型重名 → 稳定错误码 `ENTITY_NAME_TAKEN`。
 */
export async function createEntity(
  db: PrismaClient,
  input: CreateEntityInput,
): Promise<EntityView> {
  const work = await requireOwnedWork(db, input.workId, input.authorId);
  const rulePackage = await requireRulePackage(db, work.genreRulePackage);

  if (input.entityType !== ALLOWED_ENTITY_TYPE) {
    throw new AuthError('ENTITY_TYPE_NOT_ALLOWED');
  }

  const group = entityTypeGroup(rulePackage, input.entityType);
  if (group === null) {
    throw new AuthError('VALIDATION_FAILED', '当前题材没有定义该实体类型');
  }

  const name = normalizeEntityName(input.name);
  const attributes = validateFields(group, input.attributes);
  const schemaRef = group.schemaRef;

  try {
    const created = await db.$transaction(async (tx) => {
      const entity = await tx.entity.create({
        data: {
          workId: work.id,
          entityType: input.entityType,
          name,
          orderIndex: input.orderIndex ?? null,
        },
        select: {
          id: true,
          entityType: true,
          name: true,
          orderIndex: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      for (const [key, value] of Object.entries(attributes)) {
        await tx.entityAttribute.create({
          data: {
            entityId: entity.id,
            attrKey: key,
            attrValue: value as never,
            schemaRef,
          },
        });
      }

      // 第一版快照
      await tx.entityVersion.create({
        data: {
          entityId: entity.id,
          versionNo: 1,
          snapshot: buildSnapshot(entity, attributes) as never,
        },
      });

      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.ENTITY_CREATED,
        actorId: input.authorId,
        targetType: 'entity',
        targetId: entity.id,
        detail: {
          workId: work.id,
          entityId: entity.id,
          entityType: entity.entityType,
          fields: Object.keys(attributes),
        },
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
      });

      return entity;
    });

    return toEntityView(
      created,
      Object.entries(attributes).map(([attrKey, attrValue]) => ({ attrKey, attrValue })),
      1,
    );
  } catch (error) {
    throw translateEntityErrors(error);
  }
}

/** 更新实体的输入。 */
export interface UpdateEntityInput {
  readonly workId: string;
  readonly authorId: string;
  readonly entityId: string;
  readonly name?: string;
  readonly orderIndex?: number | null;
  readonly attributes?: Record<string, unknown>;
  readonly meta: RequestMeta;
}

/**
 * 更新实体（追加新版本快照）。
 *
 * - 只允许修改当前作品内的实体；他人作品 → 404；
 * - 归属、类型、id 不可修改（接口层已拒绝这些字段）；
 * - 更新属性后**追加**新版本，旧版本保留；
 * - 与 `entity.updated` 审计同事务。
 */
export async function updateEntity(
  db: PrismaClient,
  input: UpdateEntityInput,
): Promise<EntityView> {
  const work = await requireOwnedWork(db, input.workId, input.authorId);
  const rulePackage = await requireRulePackage(db, work.genreRulePackage);

  const entity = await db.entity.findFirst({
    where: { id: input.entityId, workId: work.id, deletedAt: null },
    select: { id: true, entityType: true, name: true, orderIndex: true },
  });
  if (entity === null) {
    throw new AuthError('NOT_FOUND', '实体不存在');
  }

  const group = entityTypeGroup(rulePackage, entity.entityType);
  if (group === null) {
    throw new AuthError('VALIDATION_FAILED', '当前题材没有定义该实体类型');
  }

  const name = input.name === undefined ? entity.name : normalizeEntityName(input.name);
  const validated = input.attributes === undefined ? null : validateFields(group, input.attributes);
  const schemaRef = group.schemaRef;

  try {
    const updated = await db.$transaction(async (tx) => {
      const row = await tx.entity.update({
        where: { id: entity.id },
        data: {
          name,
          ...(input.orderIndex === undefined ? {} : { orderIndex: input.orderIndex }),
        },
        select: {
          id: true,
          entityType: true,
          name: true,
          orderIndex: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      let attributes = validated;
      if (attributes !== null) {
        // 全量替换该实体的属性：先清掉旧值再写入新值
        await tx.entityAttribute.deleteMany({ where: { entityId: entity.id } });
        for (const [key, value] of Object.entries(attributes)) {
          await tx.entityAttribute.create({
            data: {
              entityId: entity.id,
              attrKey: key,
              attrValue: value as never,
              schemaRef,
            },
          });
        }
      } else {
        const existing = await tx.entityAttribute.findMany({
          where: { entityId: entity.id },
          select: { attrKey: true, attrValue: true },
        });
        attributes = Object.fromEntries(
          existing.map((item) => [item.attrKey, item.attrValue as string | number]),
        );
      }

      const latest = await tx.entityVersion.findFirst({
        where: { entityId: entity.id },
        orderBy: { versionNo: 'desc' },
        select: { versionNo: true },
      });
      const versionNo = (latest?.versionNo ?? 0) + 1;

      // 追加新版本快照（旧版本保留）
      await tx.entityVersion.create({
        data: {
          entityId: entity.id,
          versionNo,
          snapshot: buildSnapshot(row, attributes) as never,
        },
      });

      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.ENTITY_UPDATED,
        actorId: input.authorId,
        targetType: 'entity',
        targetId: entity.id,
        detail: {
          workId: work.id,
          entityId: entity.id,
          entityType: entity.entityType,
          versionNo,
          fields: validated === null ? [] : Object.keys(validated),
        },
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
      });

      return { row, attributes, versionNo };
    });

    return toEntityView(
      updated.row,
      Object.entries(updated.attributes).map(([attrKey, attrValue]) => ({ attrKey, attrValue })),
      updated.versionNo,
    );
  } catch (error) {
    throw translateEntityErrors(error);
  }
}

/** 删除实体的输入。 */
export interface DeleteEntityInput {
  readonly workId: string;
  readonly authorId: string;
  readonly entityId: string;
  readonly meta: RequestMeta;
}

/**
 * 软删除实体。
 *
 * - 被同作品内其它实体引用时返回 `ENTITY_IN_USE`，不删除；
 * - 软删除与 `entity.deleted` 审计同事务。
 */
export async function deleteEntity(db: PrismaClient, input: DeleteEntityInput): Promise<void> {
  const work = await requireOwnedWork(db, input.workId, input.authorId);

  const entity = await db.entity.findFirst({
    where: { id: input.entityId, workId: work.id, deletedAt: null },
    select: { id: true, entityType: true },
  });
  if (entity === null) {
    throw new AuthError('NOT_FOUND', '实体不存在');
  }

  const referencing = await findReferencingEntities(db, work.id, entity.id);
  if (referencing.length > 0) {
    throw new AuthError('ENTITY_IN_USE');
  }

  await db.$transaction(async (tx) => {
    await tx.entity.update({
      where: { id: entity.id },
      data: { deletedAt: new Date() },
    });

    await writeAuditLog(tx, {
      action: AUDIT_ACTIONS.ENTITY_DELETED,
      actorId: input.authorId,
      targetType: 'entity',
      targetId: entity.id,
      detail: {
        workId: work.id,
        entityId: entity.id,
        entityType: entity.entityType,
      },
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });
  });
}

/**
 * 查找引用了目标实体的其它实体。
 *
 * 引用表现为：同作品内某个实体的属性值里出现了目标实体的 id
 * （例如将来人物实体的 `realmLevelRef` 属性）。
 */
async function findReferencingEntities(
  db: PrismaClient,
  workId: string,
  entityId: string,
): Promise<string[]> {
  const candidates = await db.entity.findMany({
    where: { workId, deletedAt: null, id: { not: entityId } },
    select: { id: true },
  });
  if (candidates.length === 0) {
    return [];
  }

  const attributes = await db.entityAttribute.findMany({
    where: { entityId: { in: candidates.map((item) => item.id) } },
    select: { entityId: true, attrValue: true },
  });

  return attributes
    .filter((item) => containsId(item.attrValue, entityId))
    .map((item) => item.entityId);
}

/** 递归判断 JSON 值里是否出现指定 id 字符串。 */
function containsId(value: unknown, entityId: string): boolean {
  if (typeof value === 'string') {
    return value === entityId;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsId(item, entityId));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).some((item) =>
      containsId(item, entityId),
    );
  }
  return false;
}

/** 排序实体的输入。 */
export interface ReorderEntitiesInput {
  readonly workId: string;
  readonly authorId: string;
  readonly entityType: string;
  readonly entityIds: readonly string[];
  readonly meta: RequestMeta;
}

/**
 * 重排实体顺序。
 *
 * - 只允许**完整、无重复、且全部属于当前作品**的实体集合；
 * - 更新 order_index 与 `entity.reordered` 审计同事务。
 */
export async function reorderEntities(
  db: PrismaClient,
  input: ReorderEntitiesInput,
): Promise<EntityView[]> {
  const work = await requireOwnedWork(db, input.workId, input.authorId);

  // 第一版只允许排序 realm_level
  if (input.entityType !== ALLOWED_ENTITY_TYPE) {
    throw new AuthError('ENTITY_TYPE_NOT_ALLOWED');
  }

  const existing = await db.entity.findMany({
    where: { workId: work.id, entityType: input.entityType, deletedAt: null },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((item) => item.id));

  if (input.entityIds.length !== existingIds.size) {
    throw new AuthError('VALIDATION_FAILED', '排序必须包含该类型的全部实体');
  }
  if (new Set(input.entityIds).size !== input.entityIds.length) {
    throw new AuthError('VALIDATION_FAILED', '排序列表存在重复');
  }
  for (const id of input.entityIds) {
    if (!existingIds.has(id)) {
      throw new AuthError('VALIDATION_FAILED', '排序列表包含不属于当前作品的实体');
    }
  }

  await db.$transaction(async (tx) => {
    let index = 0;
    for (const id of input.entityIds) {
      index += 1;
      await tx.entity.update({ where: { id }, data: { orderIndex: index } });
    }

    await writeAuditLog(tx, {
      action: AUDIT_ACTIONS.ENTITY_REORDERED,
      actorId: input.authorId,
      targetType: 'work',
      targetId: work.id,
      detail: {
        workId: work.id,
        entityType: input.entityType,
        entityCount: input.entityIds.length,
      },
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });
  });

  return listEntities(db, {
    workId: work.id,
    authorId: input.authorId,
    entityType: input.entityType,
  });
}

/** 把实体相关的底层错误翻译成稳定错误码。 */
function translateEntityErrors(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return error;
  }
  const candidate = error as { code?: unknown; meta?: Record<string, unknown> };
  if (candidate.code !== 'P2002') {
    return error;
  }
  const meta = candidate.meta ?? {};
  const adapter = meta['driverAdapterError'] as
    { cause?: { constraint?: { index?: unknown } } } | undefined;
  const index = adapter?.cause?.constraint?.index;
  const marker = typeof index === 'string' ? index : '';
  if (marker.includes('entity_type') && marker.includes('name')) {
    return new AuthError('ENTITY_NAME_TAKEN');
  }
  return error;
}
