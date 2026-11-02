/**
 * 物品状态回放（M2-B3-B1）。
 *
 * 这一层只做**纯函数式的回放**与只读查询，不含写路径，
 * 因此可以被 `item-events.ts`（写服务）和 `entities.ts`（删除保护）同时引用，
 * 不会产生循环依赖。
 *
 * 回放口径（与迁移文件头、README 保持一致）：
 *
 *   被冲正 = { e.reversal_of | e.reversal_of ≠ null }
 *   有效流 = 事件.filter(e => e.reversal_of == null && e.id ∉ 被冲正)
 *
 * 也就是**冲正行与其目标行同时剔除**，回放结果等价于"该冲正从未发生过"。
 * 冲正行自身携带的 from/to 只用于展示"撤销了什么"，绝不参与状态计算 ——
 * 否则"冲正 obtained"会把状态污染成 lost，而不是干净地回到获得之前。
 */

import type { PrismaClient } from '@novel/db';

/** 事件类型（与数据库 CHECK 约束一一对应）。 */
export type ItemEventType = 'obtained' | 'transferred' | 'consumed' | 'lost';

/** 全部事件类型（顺序稳定，供校验与 UI 使用）。 */
export const ITEM_EVENT_TYPES = ['obtained', 'transferred', 'consumed', 'lost'] as const;

/** 判断任意字符串是否为合法事件类型。 */
export function isItemEventType(value: unknown): value is ItemEventType {
  return typeof value === 'string' && (ITEM_EVENT_TYPES as readonly string[]).includes(value);
}

/** 物品生命周期状态。`unrecorded` = 从未登记过事件。 */
export type ItemStatus = 'unrecorded' | 'held' | 'consumed' | 'lost';

/** 回放所需的最小事件字段（刻意不含 note：回放与展示解耦）。 */
export interface ItemEventRow {
  readonly id: string;
  readonly seqNo: number;
  readonly eventType: string;
  readonly fromHolder: string | null;
  readonly toHolder: string | null;
  readonly reversalOf: string | null;
  readonly createdAt: Date;
}

/** 回放结果。 */
export interface ItemStateSnapshot {
  readonly status: ItemStatus;
  /** 当前持有人实体 id；`unrecorded` / `consumed` / `lost` 时为 null。 */
  readonly holderId: string | null;
  /** 全部事件行数（**含**冲正行）。 */
  readonly eventCount: number;
  /** 有效事件数（冲正行与其目标行都不计）。 */
  readonly effectiveEventCount: number;
  /** 最后一条事件的 seq；无事件时为 0。 */
  readonly lastSeq: number;
  readonly lastEventAt: Date | null;
  /** 目标事件 id → 冲正它的那条事件 id。 */
  readonly reversedBy: ReadonlyMap<string, string>;
}

/**
 * 从完整事件集回放物品状态。
 *
 * 要求 `rows` 是**该物品的全部事件**（未分页、未过滤），
 * 否则"某条事件是否已被冲正"判断不出来。
 */
export function replayItemState(rows: readonly ItemEventRow[]): ItemStateSnapshot {
  const ordered = [...rows].sort((a, b) => a.seqNo - b.seqNo);

  const reversedBy = new Map<string, string>();
  for (const row of ordered) {
    if (row.reversalOf !== null) {
      reversedBy.set(row.reversalOf, row.id);
    }
  }

  const effective = ordered.filter((row) => row.reversalOf === null && !reversedBy.has(row.id));

  let status: ItemStatus = 'unrecorded';
  let holderId: string | null = null;
  for (const row of effective) {
    switch (row.eventType) {
      case 'obtained':
      case 'transferred':
        holderId = row.toHolder;
        status = 'held';
        break;
      case 'consumed':
        holderId = null;
        status = 'consumed';
        break;
      case 'lost':
        holderId = null;
        status = 'lost';
        break;
      default:
        // 数据库 CHECK 已保证不会出现；真出现说明数据被绕过写入，
        // 这里宁可抛错也不静默跳过（否则状态会静默错位）。
        throw new Error(`未知的物品事件类型：${row.eventType}`);
    }
  }

  const last = ordered.length === 0 ? null : (ordered[ordered.length - 1] as ItemEventRow);

  return {
    status,
    holderId,
    eventCount: ordered.length,
    effectiveEventCount: effective.length,
    lastSeq: last?.seqNo ?? 0,
    lastEventAt: last?.createdAt ?? null,
    reversedBy,
  };
}

/** 回放所需的事件字段投影（Prisma select 复用同一份）。 */
export const ITEM_EVENT_ROW_SELECT = {
  id: true,
  seqNo: true,
  eventType: true,
  fromHolder: true,
  toHolder: true,
  reversalOf: true,
  createdAt: true,
} as const;

/** 读取某物品的全部事件（回放用，按 seq 升序）。 */
export async function loadItemEventRows(
  db: Pick<PrismaClient, 'itemEvent'>,
  itemId: string,
): Promise<ItemEventRow[]> {
  return db.itemEvent.findMany({
    where: { itemEntityId: itemId },
    orderBy: { seqNo: 'asc' },
    select: ITEM_EVENT_ROW_SELECT,
  });
}

/**
 * 找出"当前仍持有某人物"的存活物品。
 *
 * 删除人物时的保护依据：**只算当前持有人**，历史持有人不阻止删除。
 * 因此必须走完整回放，不能只看最后一行事件
 * （最后一行可能是冲正行，或该人物早已被转走）。
 *
 * 返回按名称排序的 `{ id, name }`，供 409 摘要复用既有 `references` 结构。
 */
export async function findItemsHeldBy(
  db: Pick<PrismaClient, 'entity' | 'itemEvent'>,
  workId: string,
  holderId: string,
): Promise<{ id: string; name: string }[]> {
  const items = await db.entity.findMany({
    where: { workId, entityType: 'item', deletedAt: null },
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  if (items.length === 0) {
    return [];
  }

  const events = await db.itemEvent.findMany({
    where: { workId, itemEntityId: { in: items.map((item) => item.id) } },
    orderBy: [{ itemEntityId: 'asc' }, { seqNo: 'asc' }],
    select: { itemEntityId: true, ...ITEM_EVENT_ROW_SELECT },
  });

  const byItem = new Map<string, ItemEventRow[]>();
  for (const event of events) {
    const bucket = byItem.get(event.itemEntityId);
    if (bucket === undefined) {
      byItem.set(event.itemEntityId, [event]);
    } else {
      bucket.push(event);
    }
  }

  const held: { id: string; name: string }[] = [];
  for (const item of items) {
    const rows = byItem.get(item.id);
    if (rows === undefined) {
      continue;
    }
    if (replayItemState(rows).holderId === holderId) {
      held.push({ id: item.id, name: item.name });
    }
  }
  return held;
}
