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
 * 本轮开放 `realm_level`（境界体系）、`faction`（势力）、`character`（人物）
 * 三种实体类型；功法、物品、地点等留给后续阶段。
 */

import { AUDIT_ACTIONS, AuthError, writeAuditLog, type RequestMeta } from '@novel/auth';
import type { Prisma, PrismaClient } from '@novel/db';

import { assertUuid } from './ids.js';
import {
  assertFieldSchemaContract,
  buildSchemaSummary,
  entityTypeGroup,
  isReferenceFieldType,
  parseRuleFieldSchema,
  validateFields,
  workDirectionGroup,
  type FieldGroup,
  type SchemaSummary,
} from './schema.js';

/**
 * 实体类型：**由规则包声明**，不再硬编码单值。
 *
 * 这里只保留"本轮已实现 CRUD 的类型"集合，作用是**收窄**：
 * 规则包将来若声明 item / technique，也不会因为声明了就被开放写入。
 * 实际可用的类型 = 规则包 `entityTypes` 声明 ∩ 本集合。
 */
export const SUPPORTED_ENTITY_TYPES = ['realm_level', 'faction', 'character'] as const;

/** 本轮支持的实体类型。 */
export type SupportedEntityType = (typeof SUPPORTED_ENTITY_TYPES)[number];

/**
 * 列表 / 排序接口在**未指定类型**时的默认值。
 *
 * 仅为兼容既有调用方；新调用方应显式传 type。
 */
export const DEFAULT_ENTITY_TYPE: SupportedEntityType = 'realm_level';

/** 删除保护摘要里最多返回多少条引用者。 */
export const MAX_REFERENCE_SUMMARY_ITEMS = 20;

/** 判断是否为本轮支持的实体类型。 */
export function isSupportedEntityType(value: string): value is SupportedEntityType {
  return (SUPPORTED_ENTITY_TYPES as readonly string[]).includes(value);
}

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

/** 设定中心里的一个实体分组（按 entityType 分区）。 */
export interface EntityGroupView {
  readonly entityType: string;
  readonly title: string;
  readonly schemaRef: string;
  readonly order: number;
  readonly entities: readonly EntityView[];
}

/**
 * 设定中心视图。
 *
 * `entityGroups` 取代历史上的 `realms` 单列表：
 * 只包含"规则包已声明 ∩ 本轮支持 CRUD"的类型，按组级 `order` 升序。
 */
export interface SettingsCenterView {
  readonly workId: string;
  readonly workTitle: string;
  readonly direction: Record<string, unknown>;
  readonly schema: SchemaSummary;
  readonly entityGroups: readonly EntityGroupView[];
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

/**
 * 读取作品对应的规则包（必须是启用中的）。
 *
 * 读取后立刻做**字段契约校验**：坏规则包（enum 选项为空、引用缺少 refType、
 * refType 未声明、maxItems 非正整数……）在这里就失败，
 * 绝不允许"解析成功但内容残缺"的 schema 流到接口与页面。
 */
async function requireRulePackage(
  db: RulePackageReader,
  code: string,
): Promise<{ code: string; name: string; version: string; fieldSchema: unknown }> {
  const rulePackage = await db.rulePackage.findUnique({ where: { code } });
  if (rulePackage === null || !rulePackage.active) {
    throw new AuthError('INVALID_RULE_PACKAGE');
  }
  assertFieldSchemaContract(rulePackage.fieldSchema);
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
 * 解析并校验某个实体类型的字段组。
 *
 * 判定顺序（顺序本身是语义的一部分）：
 * 1. 不在本轮支持集合 → `ENTITY_TYPE_NOT_ALLOWED`；
 * 2. 规则包没有声明该类型 → 同样 `ENTITY_TYPE_NOT_ALLOWED`
 *    （对调用方而言"不支持"就够了，不泄露规则包内部结构）；
 * 3. 字段组 schemaRef 必须等于 `code@version`。
 */
function resolveEntityGroup(
  rulePackage: { code: string; version: string; fieldSchema: unknown },
  entityType: string,
): FieldGroup {
  if (!isSupportedEntityType(entityType)) {
    throw new AuthError('ENTITY_TYPE_NOT_ALLOWED');
  }
  const group = entityTypeGroup(rulePackage, entityType);
  if (group === null) {
    throw new AuthError('ENTITY_TYPE_NOT_ALLOWED');
  }
  assertGroupSchemaRef(rulePackage, group);
  return group;
}

/**
 * 列出设定中心里"规则包已声明 ∩ 本轮支持"的实体类型分组。
 *
 * 顺序：组级 `order` 升序，缺省排最后；同 order 按 key 字典序（稳定、可测）。
 */
function listEntityGroups(rulePackage: {
  code: string;
  version: string;
  fieldSchema: unknown;
}): { entityType: SupportedEntityType; group: FieldGroup }[] {
  const schema = parseRuleFieldSchema(rulePackage.fieldSchema);
  const groups: { entityType: SupportedEntityType; group: FieldGroup }[] = [];
  for (const entityType of SUPPORTED_ENTITY_TYPES) {
    const group = schema.entityTypes?.[entityType];
    if (group === undefined) {
      continue;
    }
    assertGroupSchemaRef(rulePackage, group);
    groups.push({ entityType, group });
  }
  groups.sort((a, b) => {
    const orderA = a.group.order ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.group.order ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.entityType < b.entityType ? -1 : a.entityType > b.entityType ? 1 : 0;
  });
  return groups;
}

/**
 * 一次引用出现。
 *
 * 必须按"出现"记录，而不是按 id 去重成 `Map<id, refType>`：
 * 同一个 UUID 完全可以出现在两个 `refType` 不同的引用字段里
 * （例如把某个势力 id 同时塞进 `secretKnownBy` 与 `faction`）。
 * 用 Map 保存会让后一个字段**覆盖**前一个字段的期望类型，
 * 于是只有一个字段被真正校验，另一个字段的类型约束被静默跳过。
 */
interface ReferenceOccurrence {
  readonly id: string;
  readonly refType: string;
  readonly fieldKey: string;
}

/**
 * 在**事务内**校验引用类字段的目标。
 *
 * 必须在作品级 advisory lock 持有期间调用：
 * "目标存在且未删除"这个判断只有在锁内才有意义，
 * 否则校验通过后目标可能立刻被并发软删除。
 *
 * 规则（M2-B2）：
 * - `refType` 必须在规则包 `entityTypes` 中声明，否则视为规则包坏数据；
 * - 目标必须存在、未软删除、属于**同一作品**、类型等于**该字段**的 `refType`；
 * - 三者的失败文案统一为「引用目标不存在」，不泄露其它作品是否存在；
 * - 禁止引用自身（`selfId` 仅在编辑时存在；新建时 id 由服务端生成，不可能自引用）；
 * - 校验是**逐字段、逐 id** 的：同一个 id 出现在两个 refType 不同的字段里，
 *   两个字段都必须各自满足自己的 refType，否则整体 400。
 */
async function assertReferences(
  tx: Prisma.TransactionClient,
  workId: string,
  rulePackage: { fieldSchema: unknown },
  group: FieldGroup,
  values: Record<string, unknown>,
  selfId?: string,
): Promise<void> {
  const declaredTypes = parseRuleFieldSchema(rulePackage.fieldSchema).entityTypes ?? {};

  const occurrences: ReferenceOccurrence[] = [];
  for (const field of group.fields) {
    if (!isReferenceFieldType(field.type)) {
      continue;
    }
    const refType = field.refType;
    if (refType === undefined || declaredTypes[refType] === undefined) {
      throw new AuthError('INVALID_RULE_PACKAGE', `字段 ${field.key} 的引用类型未声明`);
    }
    const value = values[field.key];
    if (value === undefined) {
      continue;
    }
    const ids = Array.isArray(value) ? value : [value];
    for (const id of ids) {
      if (typeof id !== 'string') {
        continue;
      }
      if (selfId !== undefined && id === selfId) {
        throw new AuthError('VALIDATION_FAILED', `字段 ${field.label} 不能引用自身`, {
          message: `字段 ${field.label} 不能引用自身`,
        });
      }
      occurrences.push({ id, refType, fieldKey: field.key });
    }
  }

  if (occurrences.length === 0) {
    return;
  }

  // 查询可以按 id 去重（只影响 SQL 规模），校验绝不去重。
  const targetIds = [...new Set(occurrences.map((occurrence) => occurrence.id))];
  const rows = await tx.entity.findMany({
    where: { id: { in: targetIds }, workId, deletedAt: null },
    select: { id: true, entityType: true },
  });
  const actualTypeById = new Map(rows.map((row) => [row.id, row.entityType]));

  for (const occurrence of occurrences) {
    const actualType = actualTypeById.get(occurrence.id);
    if (actualType === undefined) {
      // 不存在 / 已软删除 / 属于其它作品：**完全相同的对外文案**，不泄露存在性。
      // 这里显式覆盖 publicDetails.message，让作者看到可操作的具体原因，
      // 同时保证三种情况无法被区分。
      throw new AuthError('VALIDATION_FAILED', '引用目标不存在', {
        message: '引用目标不存在',
      });
    }
    if (actualType !== occurrence.refType) {
      throw new AuthError('VALIDATION_FAILED', `字段 ${occurrence.fieldKey} 的引用目标类型不匹配`, {
        message: '引用目标类型不匹配',
      });
    }
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

/** 读取某类型实体列表的内部实现（调用方已完成归属与规则包校验）。 */
async function loadEntitiesForWork(
  db: Pick<PrismaClient, 'entity' | 'entityAttribute' | 'entityVersion'>,
  workId: string,
  entityType: string,
  schemaRef: string,
): Promise<EntityView[]> {
  const entities = await db.entity.findMany({
    where: { workId, entityType, deletedAt: null },
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
    const details = await loadEntityDetails(db, entity.id, schemaRef);
    result.push(toEntityView(entity, details.attributes, details.version));
  }
  return result;
}

/** 列出作品内指定类型的实体（未删除），按 order_index 升序。 */
export async function listEntities(
  db: PrismaClient,
  input: { workId: string; authorId: string; entityType: string },
): Promise<EntityView[]> {
  assertUuid(input.workId, '作品 id');
  const work = await requireOwnedWork(db, input.workId, input.authorId);
  const rulePackage = await requireRulePackage(db, work.genreRulePackage);
  const group = resolveEntityGroup(rulePackage, input.entityType);
  return loadEntitiesForWork(db, work.id, input.entityType, group.schemaRef);
}

/**
 * 读取设定中心（作品方向 + schema 摘要 + 各实体类型分组）。
 *
 * `entityGroups` 只包含"规则包已声明 ∩ 本轮支持 CRUD"的类型，
 * 且每个类型内部按 order_index 升序；分组之间按规则包 `order` 升序。
 */
export async function getSettingsCenter(
  db: PrismaClient,
  input: { workId: string; authorId: string },
): Promise<SettingsCenterView> {
  assertUuid(input.workId, '作品 id');
  const work = await requireOwnedWork(db, input.workId, input.authorId);
  const rulePackage = await requireRulePackage(db, work.genreRulePackage);
  const direction = workDirectionGroup(rulePackage);

  const [directionValues, groups] = await Promise.all([
    direction === null
      ? Promise.resolve<Record<string, unknown>>({})
      : loadDirection(db, work.id, direction.schemaRef),
    Promise.resolve(listEntityGroups(rulePackage)),
  ]);

  const entityGroups: EntityGroupView[] = [];
  for (const { entityType, group } of groups) {
    entityGroups.push({
      entityType,
      title: group.title,
      schemaRef: group.schemaRef,
      order: group.order ?? Number.MAX_SAFE_INTEGER,
      entities: await loadEntitiesForWork(db, work.id, entityType, group.schemaRef),
    });
  }

  return {
    workId: work.id,
    workTitle: work.title,
    direction: directionValues,
    schema: buildSchemaSummary(rulePackage),
    entityGroups,
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
 * - 只允许规则包声明且本轮支持的实体类型（realm_level / faction / character）；
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
  const name = normalizeEntityName(input.name);

  try {
    const created = await runWorkWrite(db, input.workId, async (tx) => {
      // 归属校验在锁内、事务内重新执行
      const work = await requireOwnedWork(tx, input.workId, input.authorId);
      const rulePackage = await requireRulePackage(tx, work.genreRulePackage);

      // 实体类型来自规则包声明（∩ 本轮支持集），不在这里硬编码
      const group = resolveEntityGroup(rulePackage, input.entityType);
      const attributes = validateFields(group, input.attributes);
      const schemaRef = group.schemaRef;

      // 引用必须在本事务、持有作品级锁期间校验
      await assertReferences(tx, work.id, rulePackage, group, attributes);

      const siblings = await tx.entity.findMany({
        where: { workId: work.id, entityType: input.entityType, deletedAt: null },
        select: { orderIndex: true },
      });
      const maxOrderIndex = siblings.reduce(
        (max, item) => (item.orderIndex !== null && item.orderIndex > max ? item.orderIndex : max),
        0,
      );
      // 排序值由**服务端独占**：客户端不能指定。
      // 新建一律追加到"当前最大未删除 order_index + 1"，
      // 保证同类型实体的排序集合始终是 1..N 的完整排列。
      // 任何调整顺序的需求都必须走 PUT /entities/reorder（完整集合重排）。
      const orderIndex = maxOrderIndex + 1;

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

      // 实体类型取自数据库行，再回规则包取字段定义
      const group = resolveEntityGroup(rulePackage, entity.entityType);

      const name = input.name === undefined ? entity.name : normalizeEntityName(input.name);
      const validated =
        input.attributes === undefined ? null : validateFields(group, input.attributes);
      const schemaRef = group.schemaRef;

      // 引用校验：锁内、事务内；编辑时禁止引用自身
      if (validated !== null) {
        await assertReferences(tx, work.id, rulePackage, group, validated, entity.id);
      }

      // 条件更新（compare-and-set）：只有"仍未被软删除"的行才会被改到。
      // 这样"删除与编辑并发"时，先提交的那一方赢，后提交的一方拿到 count=0
      // → 直接 404，不会写出新版本或新审计。
      //
      // 排序值**不在这里改**：orderIndex 由服务端独占，
      // 编辑只允许 name / attributes，顺序变更一律走 reorder。
      const affected = await tx.entity.updateMany({
        where: { id: entity.id, workId: work.id, deletedAt: null },
        data: { name },
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
        // 全量替换该实体的属性 —— **只替换当前 schemaRef 下的属性**。
        // 旧契约（其它 schemaRef）写入的属性既不属于当前字段定义，
        // 也不该被这次编辑连带删除：它们要留给按旧契约读取的场景，
        // 更不能混进当前响应。
        await tx.entityAttribute.deleteMany({ where: { entityId: entity.id, schemaRef } });
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
        // 只改名称（未提交 attributes）时，构造版本快照所读的属性
        // 同样**只取当前 schemaRef**：旧契约的属性不得进入新版本快照。
        const existing = await tx.entityAttribute.findMany({
          where: { entityId: entity.id, schemaRef },
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
      const rulePackage = await requireRulePackage(tx, work.genreRulePackage);

      const entity = await tx.entity.findFirst({
        where: { id: input.entityId, workId: work.id, deletedAt: null },
        select: { id: true, entityType: true },
      });
      if (entity === null) {
        throw new AuthError('NOT_FOUND', '实体不存在');
      }

      // 只扫描"当前契约下、规则包声明为引用类型"的属性，
      // 不扫自由文本、也不扫旧契约属性（旧契约本来就不参与当前语义）。
      const referencing = await findReferencingEntities(
        tx,
        work.id,
        entity.id,
        referenceKeysOf(rulePackage),
        // 所有字段组的 schemaRef 都恒等于 `code@version`（assertGroupSchemaRef 保证）
        `${rulePackage.code}@${rulePackage.version}`,
      );
      if (referencing.length > 0) {
        throw new AuthError('ENTITY_IN_USE', undefined, {
          references: {
            total: referencing.length,
            // 只返回定位所需的最小信息：id / 类型 / 名称。
            // 绝不含属性值、秘密或正文。
            items: referencing.slice(0, MAX_REFERENCE_SUMMARY_ITEMS),
          },
        });
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
 * 收集规则包里"所有引用类字段"的 attr_key。
 *
 * 删除保护只扫这些 key —— 不扫自由文本，避免
 * "描述里恰好出现一个 uuid"被误判成引用。
 */
function referenceKeysOf(rulePackage: { fieldSchema: unknown }): string[] {
  const schema = parseRuleFieldSchema(rulePackage.fieldSchema);
  const keys = new Set<string>();
  for (const group of Object.values(schema.entityTypes ?? {})) {
    for (const field of group.fields) {
      if (isReferenceFieldType(field.type)) {
        keys.add(field.key);
      }
    }
  }
  return [...keys];
}

/** 删除保护摘要里的一条引用者。 */
export interface EntityReferenceSummaryItem {
  readonly id: string;
  readonly entityType: string;
  readonly name: string;
}

/**
 * 查找引用了目标实体的其它实体。
 *
 * 判定范围（M2-B2 收窄）：
 * - 只查 `attr_key` 属于规则包声明的引用字段；
 * - 只看**存活**（`deleted_at IS NULL`）、**同一作品**的实体；
 * - 已软删除的引用者不计入，不阻止删除。
 *
 * 返回去重后的引用者列表（按 id 稳定排序），供删除保护与摘要使用。
 */
async function findReferencingEntities(
  db: Pick<PrismaClient, 'entity' | 'entityAttribute'>,
  workId: string,
  entityId: string,
  referenceKeys: readonly string[],
  schemaRef: string,
): Promise<EntityReferenceSummaryItem[]> {
  if (referenceKeys.length === 0) {
    return [];
  }

  const attributes = await db.entityAttribute.findMany({
    // 只扫当前契约：旧契约属性不参与当前语义，也不该阻止删除
    where: { attrKey: { in: [...referenceKeys] }, schemaRef },
    select: { entityId: true, attrValue: true },
  });

  const referencingIds = new Set<string>();
  for (const attribute of attributes) {
    if (attribute.entityId === entityId) {
      continue;
    }
    if (containsId(attribute.attrValue, entityId)) {
      referencingIds.add(attribute.entityId);
    }
  }
  if (referencingIds.size === 0) {
    return [];
  }

  // 二次过滤：必须仍是同作品的存活实体（属性可能属于已删除/别处实体）
  const rows = await db.entity.findMany({
    where: { id: { in: [...referencingIds] }, workId, deletedAt: null },
    select: { id: true, entityType: true, name: true },
    orderBy: [{ entityType: 'asc' }, { name: 'asc' }, { id: 'asc' }],
  });

  return rows.map((row) => ({ id: row.id, entityType: row.entityType, name: row.name }));
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

  try {
    await runWorkWrite(db, input.workId, async (tx) => {
      const work = await requireOwnedWork(tx, input.workId, input.authorId);
      const rulePackage = await requireRulePackage(tx, work.genreRulePackage);

      // 类型必须来自规则包声明（∩ 本轮支持集）；每个类型各自独立 1..N
      resolveEntityGroup(rulePackage, input.entityType);

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
