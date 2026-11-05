/**
 * 安全实体摘要（A2-C-B 起共用）。
 *
 * 定位：把「同作品未删除实体」变成可以进入模型输入的最小摘要。
 * 硬约束（与 docs/08 §21.7 / §23 一致）：
 * - 只读同作品、`deleted_at IS NULL` 的实体；
 * - 每类最多 `limit` 条，顺序固定 `orderIndex asc → createdAt asc → id asc`；
 * - 属性按白名单格式化，`secret` / `secretKnownBy` 等秘密字段**永不进入**；
 * - 摘要长度由调用方决定（事实提取 300 字，Reviewer 500 字）。
 *
 * 为什么按类型分别查询：一次全局 take 再按类型切会让大量人物把物品 / 势力
 * 整类挤掉；按类型查询后每类都有独立预算，且同一份数据每次得到相同结果。
 */

import type { Prisma } from '@novel/db';

/** 进入模型输入的实体摘要。 */
export interface SafeEntityRef {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

/** 带排序字段的实体行（`orderIndex` 只在需要时透出给调用方）。 */
export interface SafeEntityRow extends SafeEntityRef {
  readonly orderIndex: number | null;
}

/** 参与摘要装配的实体类型（与规则包 entityType 一致）。 */
export type SafeEntityType = 'character' | 'item' | 'realm_level' | 'faction';

/** 四类实体摘要（每类独立上限）。 */
export interface SafeEntityGroups {
  readonly characters: readonly SafeEntityRow[];
  readonly items: readonly SafeEntityRow[];
  readonly realms: readonly SafeEntityRow[];
  readonly factions: readonly SafeEntityRow[];
}

export interface LoadSafeEntitiesOptions {
  /** 每类最多返回多少条。 */
  readonly limit: number;
  /** 单个实体摘要的最大字符数。 */
  readonly summaryMax: number;
}

interface EntityRow {
  readonly id: string;
  readonly name: string;
  readonly orderIndex: number | null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 单一类型的实体：每类独立上限，顺序固定。 */
async function loadEntitiesOfType(
  db: Prisma.TransactionClient,
  workId: string,
  entityType: SafeEntityType,
  limit: number,
): Promise<EntityRow[]> {
  return db.entity.findMany({
    where: { workId, deletedAt: null, entityType },
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, name: true, orderIndex: true },
  });
}

/** 属性值转成稳定的一句话摘要（数组用「、」连接，对象只取标量键）。 */
export function formatAttributeValue(value: unknown): string {
  if (typeof value === 'string') {
    return truncate(value.trim(), 120);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return truncate(
      value
        .map((item) =>
          typeof item === 'string' ? item : typeof item === 'number' ? String(item) : '',
        )
        .filter((item) => item !== '')
        .join('、'),
      120,
    );
  }
  if (value !== null && typeof value === 'object') {
    const parts: string[] = [];
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      // 对象内部的秘密键同样不得进入摘要
      if (key.startsWith('secret')) {
        continue;
      }
      if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean') {
        parts.push(`${key}=${String(inner)}`);
      }
    }
    return truncate(parts.join('，'), 120);
  }
  return '';
}

/**
 * 读取四类实体摘要（人物 / 物品 / 境界 / 势力）。
 *
 * 一次查询拿到四类实体，再一次查询批量取属性；秘密字段在这里统一过滤。
 */
export async function loadSafeEntityGroups(
  db: Prisma.TransactionClient,
  workId: string,
  options: LoadSafeEntitiesOptions,
): Promise<SafeEntityGroups> {
  const [characters, items, realms, factions] = await Promise.all([
    loadEntitiesOfType(db, workId, 'character', options.limit),
    loadEntitiesOfType(db, workId, 'item', options.limit),
    loadEntitiesOfType(db, workId, 'realm_level', options.limit),
    loadEntitiesOfType(db, workId, 'faction', options.limit),
  ]);
  const entities = [...characters, ...items, ...realms, ...factions];

  const attributes =
    entities.length === 0
      ? []
      : await db.entityAttribute.findMany({
          where: { entityId: { in: entities.map((entity) => entity.id) } },
          orderBy: { createdAt: 'asc' },
          select: { entityId: true, attrKey: true, attrValue: true },
        });

  const attributesByEntity = new Map<string, string[]>();
  for (const row of attributes) {
    // 秘密类字段永不进入模型输入（docs/08 的硬约束）
    if (row.attrKey.startsWith('secret')) {
      continue;
    }
    const bucket = attributesByEntity.get(row.entityId) ?? [];
    const text = formatAttributeValue(row.attrValue);
    if (text !== '') {
      bucket.push(`${row.attrKey}：${text}`);
    }
    attributesByEntity.set(row.entityId, bucket);
  }

  const toRow = (entity: EntityRow): SafeEntityRow => ({
    id: entity.id,
    name: entity.name,
    summary: truncate((attributesByEntity.get(entity.id) ?? []).join('；'), options.summaryMax),
    orderIndex: entity.orderIndex,
  });

  return {
    characters: characters.map(toRow),
    items: items.map(toRow),
    realms: realms.map(toRow),
    factions: factions.map(toRow),
  };
}

/** 只保留 `{id,name,summary}`（Reviewer Schema 不接受 `orderIndex`）。 */
export function toSafeEntityRefs(rows: readonly SafeEntityRow[]): SafeEntityRef[] {
  return rows.map((row) => ({ id: row.id, name: row.name, summary: row.summary }));
}
