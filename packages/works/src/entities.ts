/**
 * 设定中心与通用实体（M2-B1 / M2-B1-REV-01）。
 *
 * 权限与隔离（硬约束）：
 * - 所有读写都以 `workId + authorId` 为边界：只允许作品所有者访问；
 *   他人的作品一律按"不存在"处理（404），不泄露是否存在；
 * - 管理员不能通过本模块的任何接口读取或修改作者作品；
 * - 写操作与审计写入在**同一事务**内完成：审计失败则业务修改回滚；
 * - 审计 detail 只记录 workId / entityId / entityType / 操作字段名，
 *   **不记录完整设定值**。
 *
 * 并发边界（M2-B1-REV-01）：
 * - 同一作品的**所有**实体写操作（create / update / delete / reorder）
 *   都先取同一把 PostgreSQL 事务级 advisory lock（按 workId 哈希）；
 * - 拿到锁之后，在**同一事务内**重新做全部前置校验
 *   （归属、未删除、引用、完整排序集合），再写数据、版本与审计；
 * - 因此并发写不会交错出"混合顺序"，也不会产生重复版本号。
 *
 * 本轮只开放 `realm_level`（境界体系）一种实体类型；
 * 人物、势力、功法、物品等留给后续阶段。
 */

import { AUDIT_ACTIONS, AuthError, writeAuditLog, type RequestMeta } from '@novel/auth';
import type { Prisma, PrismaClient } from '@novel/db';

import { assertUuid } from './ids.js';
import {
  buildSchemaSummary,
  entityTypeGroup,
  validateFields,
  workDirectionGroup,
  type SchemaSummary,
} from './schema.js';

/** 第一版唯一开放的实体类型。 */
export const ALLOWED_ENTITY_TYPE = 'realm_level';

/**
 * 实体写操作的 advisory lock 命名空间。
 *
 * 锁键 = `hashtextextended('entity:' || workId, 0)`：
 * 同一作品的所有写操作共用这把锁，不同作品互不影响；
 * 带上 `entity:` 前缀后与其它模块的 advisory lock 不在同一个哈希空间。
 *
 * 导出这个常量，是为了让并发测试能**用同一把锁**构造"锁被占用"的场景，
 * 从而证明实体写操作确实会去取这把锁（而不是碰巧被行锁挡住）。
 */
export const ENTITY_LOCK_NAMESPACE = 'entity:';

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

/** 读取作品所需的最小数据库能力（PrismaClient 与事务客户端都满足）。 */
type WorkReader = Pick<PrismaClient, 'work'>;

/** 读取规则包所需的最小数据库能力。 */
type RulePackageReader = Pick<PrismaClient, 'rulePackage'>;

/**
 * 读取作品上下文（并确认属于当前作者）。
 *
 * 非所有者一律 404。
 */
async function requireOwnedWork(
  db: WorkReader,
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
  db: RulePackageReader,
  code: string,
): Promise<{ code: string; name: string; version: string; fieldSchema: unknown }> {
  const rulePackage = await db.rulePackage.findUnique({ where: { code } });
  if (rulePackage === null || !rulePackage.active) {
    throw new AuthError('INVALID_RULE_PACKAGE');
  }
  return rulePackage;
}

/**
 * 断言字段组的 schemaRef 与规则包版本一致。
 *
 * 口径（M2-B1-REV-01 统一）：**schemaRef 表示字段契约版本**，
 * 因此必须恒等于 `${code}@${version}`。
 * 规则包的 `version` 与 field_schema 里的字段组 `schemaRef` 一旦漂移，
 * 就会导致"按当前 schemaRef 过滤"把刚写入的设定读不回来 ——
 * 所以这里直接拒绝这种数据（INVALID_RULE_PACKAGE），而不是静默错乱。
 */
function assertGroupSchemaRef(
  rulePackage: { code: string; version: string },
  group: { schemaRef: string },
): void {
  const expected = `${rulePackage.code}@${rulePackage.version}`;
  if (group.schemaRef !== expected) {
    throw new AuthError(
      'INVALID_RULE_PACKAGE',
      `规则包 ${rulePackage.code} 的字段契约版本与规则包版本不一致`,
    );
  }
}

/**
 * 同一作品的所有写操作共用的 advisory lock。
 *
 * 锁键 = `hashtextextended('entity:' || workId, 0)`：
 * - 用 workId 派生 → 同一作品的写操作互相串行化，不同作品互不影响；
 * - 带 `entity:` 前缀 → 与其它模块的 advisory lock（例如按 userId 的会话锁）
 *   落在不同的哈希空间，不会互相干扰；
 * - 64 位哈希 → 碰撞概率可忽略。
 *
 * 取锁语句包在子查询里，是因为 `pg_advisory_xact_lock` 返回 void，
 * Prisma 无法反序列化（会抛 P2010）。
 */
async function lockWork(tx: Prisma.TransactionClient, workId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended(${ENTITY_LOCK_NAMESPACE} || ${workId}::text, 0))) AS lock_acquired`;
}

/**
 * 作品级写事务的统一入口。
 *
 * 顺序固定为：开事务 → 取作品级 advisory lock → **在事务内**做全部校验
 * → 写数据/版本/审计。任何一步抛错都会让整个事务回滚。
 *
 * 超时放宽到 30 秒：并发写会互相等待同一把锁，等待时间算在事务时限里。
 */
async function runWorkWrite<T>(
  db: PrismaClient,
  workId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await lockWork(tx, workId);
      return work(tx);
    },
    { maxWait: 15000, timeout: 30000 },
  );
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
  db: Pick<PrismaClient, 'entityAttribute' | 'entityVersion'>,
  entityId: string,
  schemaRef: string,
): Promise<{ attributes: { attrKey: string; attrValue: unknown }[]; version: number }> {
  const [attributes, latest] = await Promise.all([
    db.entityAttribute.findMany({
      // 只读当前 schemaRef 下的属性：旧契约写入的属性不得混入响应
      where: { entityId, schemaRef },
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

/**
 * 读取作品方向设定。
 *
 * 只读取**当前 schemaRef** 下的行：旧 schema 契约写入的设定不得混入响应。
 */
async function loadDirection(
  db: Pick<PrismaClient, 'workSetting'>,
  workId: string,
  schemaRef: string,
): Promise<Record<string, unknown>> {
  const rows = await db.workSetting.findMany({
    where: { workId, schemaRef },
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
  assertUuid(input.workId, '作品 id');
  if (input.entityType !== ALLOWED_ENTITY_TYPE) {
    throw new AuthError('ENTITY_TYPE_NOT_ALLOWED');
  }
  const work = await requireOwnedWork(db, input.workId, input.authorId);
  const rulePackage = await requireRulePackage(db, work.genreRulePackage);
  const group = entityTypeGroup(rulePackage, input.entityType);
  if (group === null) {
    throw new AuthError('VALIDATION_FAILED', '当前题材没有定义该实体类型');
  }
  assertGroupSchemaRef(rulePackage, group);

  const entities = await db.entity.findMany({
    where: { workId: work.id, entityType: input.entityType, deletedAt: null },
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
    const details = await loadEntityDetails(db, entity.id, group.schemaRef);
    result.push(toEntityView(entity, details.attributes, details.version));
  }
  return result;
}

/** 读取设定中心（作品方向 + schema 摘要 + 境界体系）。 */
export async function getSettingsCenter(
  db: PrismaClient,
  input: { workId: string; authorId: string },
): Promise<SettingsCenterView> {
  assertUuid(input.workId, '作品 id');
  const work = await requireOwnedWork(db, input.workId, input.authorId);
  const rulePackage = await requireRulePackage(db, work.genreRulePackage);
  const direction = workDirectionGroup(rulePackage);

  const [directionValues, realms] = await Promise.all([
    direction === null
      ? Promise.resolve<Record<string, unknown>>({})
      : loadDirection(db, work.id, direction.schemaRef),
    listEntities(db, {
      workId: work.id,
      authorId: input.authorId,
      entityType: ALLOWED_ENTITY_TYPE,
    }),
  ]);

  return {
    workId: work.id,
    workTitle: work.title,
    direction: directionValues,
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
 * 语义（M2-B1-REV-01）：**整组同步**。
 * - 请求体给出的是当前 schemaRef 下这组方向的**完整期望状态**；
 * - 已提交且有值的字段 → upsert；
 * - 可选字段被清空（提交为空或未提交）→ 删除对应 work_settings 行；
 * - 只处理当前 schemaRef，旧契约的行既不读取也不删除。
 *
 * 另外：
 * - 字段必须符合规则包的 field_schema（类型、必填、范围、未知字段一律拒绝）；
 * - 与 `settings.updated` 审计同事务；
 * - 客户端不能修改规则包 code（方向设定由服务端按作品的规则包决定）。
 */
export async function updateDirection(
  db: PrismaClient,
  input: UpdateDirectionInput,
): Promise<Record<string, unknown>> {
  assertUuid(input.workId, '作品 id');

  const result = await runWorkWrite(db, input.workId, async (tx) => {
    const work = await requireOwnedWork(tx, input.workId, input.authorId);
    const rulePackage = await requireRulePackage(tx, work.genreRulePackage);

    const group = workDirectionGroup(rulePackage);
    if (group === null) {
      throw new AuthError('VALIDATION_FAILED', '当前题材没有定义作品方向字段');
    }
    assertGroupSchemaRef(rulePackage, group);

    // validateFields：未知字段 / 必填缺失 / 类型错 / 越界一律 400；
    // 可选字段为空或未提交时不会出现在结果里（即"被清空"）。
    const validated = validateFields(group, input.values);
    const schemaRef = group.schemaRef;
    const clearedKeys = group.fields
      .filter((field) => !field.required && !(field.key in validated))
      .map((field) => field.key);

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

    // 被清空的可选字段：删除当前 schemaRef 下的对应行。
    // 旧 schemaRef 的行不在处理范围内（不属于当前契约）。
    for (const key of clearedKeys) {
      await tx.workSetting.deleteMany({
        where: { workId: work.id, settingKey: key, schemaRef },
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
        fields: [...Object.keys(validated), ...clearedKeys],
        schemaRef,
      },
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    });

    // 在事务内读回本次写入的结果（只读当前 schemaRef 下的行）
    return loadDirection(tx, work.id, schemaRef);
  });

  return result;
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
 * - 排序值缺省时自动取"同类实体当前最大排序值 + 1"，
 *   保证同类型实体的排序集合始终是 1..N 的完整排列；
 * - 创建 + 第一版快照 + `entity.created` 审计同事务；
 * - 同作品同类型重名 → 稳定错误码 `ENTITY_NAME_TAKEN`。
 */
export async function createEntity(
  db: PrismaClient,
  input: CreateEntityInput,
): Promise<EntityView> {
  assertUuid(input.workId, '作品 id');
  if (input.entityType !== ALLOWED_ENTITY_TYPE) {
    throw new AuthError('ENTITY_TYPE_NOT_ALLOWED');
  }
  const name = normalizeEntityName(input.name);

  try {
    const created = await runWorkWrite(db, input.workId, async (tx) => {
      // 归属校验在锁内、事务内重新执行
      const work = await requireOwnedWork(tx, input.workId, input.authorId);
      const rulePackage = await requireRulePackage(tx, work.genreRulePackage);

      const group = entityTypeGroup(rulePackage, input.entityType);
      if (group === null) {
        throw new AuthError('VALIDATION_FAILED', '当前题材没有定义该实体类型');
      }
      assertGroupSchemaRef(rulePackage, group);
      const attributes = validateFields(group, input.attributes);
      const schemaRef = group.schemaRef;

      const siblings = await tx.entity.findMany({
        where: { workId: work.id, entityType: input.entityType, deletedAt: null },
        select: { orderIndex: true },
      });
      const maxOrderIndex = siblings.reduce(
        (max, item) => (item.orderIndex !== null && item.orderIndex > max ? item.orderIndex : max),
        0,
      );
      let orderIndex = input.orderIndex ?? null;
      if (orderIndex !== null) {
        if (!Number.isInteger(orderIndex) || orderIndex < 1) {
          throw new AuthError('VALIDATION_FAILED', '排序值必须是正整数');
        }
        if (siblings.some((item) => item.orderIndex === orderIndex)) {
          throw new AuthError('VALIDATION_FAILED', '排序值已被占用');
        }
      } else {
        orderIndex = maxOrderIndex + 1;
      }

      const entity = await tx.entity.create({
        data: {
          workId: work.id,
          entityType: input.entityType,
          name,
          orderIndex,
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

      return { entity, attributes };
    });

    return toEntityView(
      created.entity,
      Object.entries(created.attributes).map(([attrKey, attrValue]) => ({ attrKey, attrValue })),
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
 * - 与 `entity.updated` 审计同事务；
 * - 归属、未删除状态与版本号计算全部在**作品级锁 + 同一事务内**完成，
 *   因此并发编辑不会写出重复版本号，也不会覆盖别人的新版本。
 */
export async function updateEntity(
  db: PrismaClient,
  input: UpdateEntityInput,
): Promise<EntityView> {
  assertUuid(input.workId, '作品 id');
  assertUuid(input.entityId, '实体 id');

  try {
    const updated = await runWorkWrite(db, input.workId, async (tx) => {
      // 归属校验在锁内、事务内重新执行
      const work = await requireOwnedWork(tx, input.workId, input.authorId);
      const rulePackage = await requireRulePackage(tx, work.genreRulePackage);

      const entity = await tx.entity.findFirst({
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
      assertGroupSchemaRef(rulePackage, group);

      const name = input.name === undefined ? entity.name : normalizeEntityName(input.name);
      const validated =
        input.attributes === undefined ? null : validateFields(group, input.attributes);
      const schemaRef = group.schemaRef;

      // 条件更新（compare-and-set）：只有"仍未被软删除"的行才会被改到。
      // 这样"删除与编辑并发"时，先提交的那一方赢，后提交的一方拿到 count=0
      // → 直接 404，不会写出新版本或新审计。
      const affected = await tx.entity.updateMany({
        where: { id: entity.id, workId: work.id, deletedAt: null },
        data: {
          name,
          ...(input.orderIndex === undefined ? {} : { orderIndex: input.orderIndex }),
        },
      });
      if (affected.count === 0) {
        // 并发软删除已经生效：按"实体不存在"处理，不写版本、不写审计
        throw new AuthError('NOT_FOUND', '实体不存在');
      }

      const row = await tx.entity.findUniqueOrThrow({
        where: { id: entity.id },
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

      // 追加新版本快照（旧版本保留）。
      //
      // created_at 取**数据库时钟在该行真正落库那一刻**的值
      // （列默认值 clock_timestamp()，见 m2b1 迁移），而不是事务开始时刻。
      //
      // 为什么重要：软删除的 deleted_at 同样用数据库时钟，
      // 两者都必须是"实际写入时刻"。
      // 若版本时间戳取事务开始时刻，一个"先开始、后落库"的事务
      // 会让版本时间早于期间发生的删除，破坏
      // "软删除之后不得再产生新版本"这条可观测不变量。
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
 * - 软删除与 `entity.deleted` 审计同事务；
 * - 归属、未删除状态与引用检查都在**作品级锁 + 同一事务内**重新执行，
 *   因此"删除后又被并发编辑"不会产生新的版本或审计。
 */
export async function deleteEntity(db: PrismaClient, input: DeleteEntityInput): Promise<void> {
  assertUuid(input.workId, '作品 id');
  assertUuid(input.entityId, '实体 id');

  try {
    await runWorkWrite(db, input.workId, async (tx) => {
      const work = await requireOwnedWork(tx, input.workId, input.authorId);

      const entity = await tx.entity.findFirst({
        where: { id: input.entityId, workId: work.id, deletedAt: null },
        select: { id: true, entityType: true },
      });
      if (entity === null) {
        throw new AuthError('NOT_FOUND', '实体不存在');
      }

      const referencing = await findReferencingEntities(tx, work.id, entity.id);
      if (referencing.length > 0) {
        throw new AuthError('ENTITY_IN_USE');
      }

      // 条件更新（compare-and-set）+ **数据库时钟**：
      //
      // 1. `deleted_at IS NULL`：只有仍未被软删除的行才会被改到。
      //    并发删除时只有一方能软删除成功，后到的一方拿到 0 行 → 404。
      // 2. 时间戳用 `clock_timestamp()`（数据库时钟，在**真正改到这一行时**取值），
      //    而不是应用层在等待行锁之前算好的 `new Date()`：
      //    - 等待行锁期间可能已经有别的写入落到这行上，
      //      用等待之前的时刻会让 deleted_at 早于那些写入，顺序就错了；
      //    - 应用服务器时钟与数据库时钟可能存在漂移，
      //      跨表比较时间戳（entity_versions / audit_logs 都用数据库时钟）会失真。
      const affected = await tx.$executeRaw`
        UPDATE entities
           SET deleted_at = clock_timestamp(),
               updated_at = clock_timestamp()
         WHERE id = ${entity.id}
           AND work_id = ${work.id}
           AND deleted_at IS NULL
      `;
      if (affected === 0) {
        // 已被并发删除：按"实体不存在"处理，不写删除审计
        throw new AuthError('NOT_FOUND', '实体不存在');
      }

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
  } catch (error) {
    throw translateEntityErrors(error);
  }
}

/**
 * 查找引用了目标实体的其它实体。
 *
 * 引用表现为：同作品内某个实体的属性值里出现了目标实体的 id
 * （例如将来人物实体的 `realmLevelRef` 属性）。
 */
async function findReferencingEntities(
  db: Pick<PrismaClient, 'entity' | 'entityAttribute'>,
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
 * - 集合校验在**作品级锁 + 同一事务内**重新执行，
 *   因此并发排序不会写出"混合顺序"，也不会因死锁暴露为 500；
 * - 更新 order_index 与 `entity.reordered` 审计同事务。
 */
export async function reorderEntities(
  db: PrismaClient,
  input: ReorderEntitiesInput,
): Promise<EntityView[]> {
  assertUuid(input.workId, '作品 id');
  for (const id of input.entityIds) {
    assertUuid(id, '实体 id');
  }

  // 第一版只允许排序 realm_level
  if (input.entityType !== ALLOWED_ENTITY_TYPE) {
    throw new AuthError('ENTITY_TYPE_NOT_ALLOWED');
  }

  try {
    await runWorkWrite(db, input.workId, async (tx) => {
      const work = await requireOwnedWork(tx, input.workId, input.authorId);

      const existing = await tx.entity.findMany({
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

      let index = 0;
      for (const id of input.entityIds) {
        index += 1;
        // 条件更新（compare-and-set）：只改"仍未被软删除"的行。
        // 与 update / delete 一样，数据库层面兜底，
        // 不依赖"前面查过所以现在还是活的"这种应用层假设。
        const affected = await tx.entity.updateMany({
          where: { id, workId: work.id, entityType: input.entityType, deletedAt: null },
          data: { orderIndex: index },
        });
        if (affected.count === 0) {
          // 并发软删除已经生效：排序集合不再完整 → 明确失败并回滚
          throw new AuthError('VALIDATION_FAILED', '排序集合已发生变化，请重试');
        }
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
  } catch (error) {
    throw translateEntityErrors(error);
  }

  return listEntities(db, {
    workId: input.workId,
    authorId: input.authorId,
    entityType: input.entityType,
  });
}

/**
 * 把实体相关的底层错误翻译成稳定错误码。
 *
 * - 同作品同类型重名（P2002 + 名称唯一索引）→ `ENTITY_NAME_TAKEN`；
 * - 版本号/属性唯一约束冲突、写冲突或死锁 → `CONCURRENT_MODIFICATION`，
 *   **绝不**以 500 暴露给调用方。
 */
function translateEntityErrors(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return error;
  }
  const candidate = error as { code?: unknown; meta?: Record<string, unknown> };
  const meta = candidate.meta ?? {};

  // Prisma 的写冲突 / 死锁：P2034（Transaction failed due to a write conflict
  // or a deadlock）。映射成稳定的 409，而不是 500。
  if (candidate.code === 'P2034') {
    return new AuthError('CONCURRENT_MODIFICATION');
  }

  // 底层 PostgreSQL 错误（驱动适配器把原生错误包在 P2010 里）。
  const nativeCode = meta['code'];
  if (nativeCode === '40P01' || nativeCode === '40001') {
    return new AuthError('CONCURRENT_MODIFICATION');
  }

  if (candidate.code !== 'P2002') {
    return error;
  }

  const adapter = meta['driverAdapterError'] as
    { cause?: { constraint?: { index?: unknown } } } | undefined;
  const index = adapter?.cause?.constraint?.index;
  const marker = typeof index === 'string' ? index : '';
  if (marker.includes('entity_type') && marker.includes('name')) {
    return new AuthError('ENTITY_NAME_TAKEN');
  }
  if (
    marker.includes('entity_versions') ||
    marker.includes('entity_attributes') ||
    marker.includes('version_no')
  ) {
    return new AuthError('CONCURRENT_MODIFICATION');
  }
  return error;
}
