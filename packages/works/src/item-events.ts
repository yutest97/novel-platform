/**
 * 物品事件流水服务（M2-B3-B1）。
 *
 * 一条铁律：**物品持有人只有一个真相 —— 本文件的回放结果**。
 * `item` 规则包里没有 holder 字段，属性表也不存持有人，
 * 因此不存在"属性与流水双写不一致"的可能，也不需要任何回写。
 *
 * 写路径全部走 `runWorkWrite`（作品级 advisory lock + 单事务），
 * 与实体写共用同一把锁 —— 这是"转移给某人"与"删除该人物"不会互相穿透的前提。
 *
 * 事务内固定顺序（顺序本身是语义的一部分）：
 *   归属校验 → 物品校验 → **幂等查重** → 回放当前状态 → 状态机/冲正校验
 *   → 解析并校验持有人 → seq = max+1 → 插入 → 审计
 *
 * 幂等查重必须排在状态机校验**之前**：重试同一个请求时，
 * 状态早已被第一次请求改掉，若先跑状态机就会把重试误判成"非法转移"。
 */

import { AUDIT_ACTIONS, AuthError, writeAuditLog, type RequestMeta } from '@novel/auth';
import type { Prisma, PrismaClient } from '@novel/db';

import { assertUuid } from './ids.js';
import {
  ITEM_EVENT_ROW_SELECT,
  isItemEventType,
  loadItemEventRows,
  replayItemState,
  type ItemEventRow,
  type ItemEventType,
  type ItemStateSnapshot,
  type ItemStatus,
} from './item-state.js';
import { requireOwnedWork } from './work-access.js';
import { runWorkWrite } from './work-lock.js';
import { isConcurrencyError, uniqueConstraintMarker } from './write-errors.js';

/** 物品实体类型。与规则包里的 key 一致。 */
const ITEM_ENTITY_TYPE = 'item';
/** 持有人只能是人物。 */
const HOLDER_ENTITY_TYPE = 'character';

/** 事件备注长度上限（与数据库 CHECK 一致）。 */
export const MAX_ITEM_EVENT_NOTE_LENGTH = 500;

/** 幂等键长度与字符集（与数据库 CHECK 一致）。 */
export const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 事件列表分页。 */
export const DEFAULT_ITEM_EVENT_PAGE_SIZE = 50;
export const MAX_ITEM_EVENT_PAGE_SIZE = 100;

/**
 * 持有人引用（DTO 统一形状）。
 *
 * **只含定位信息**：id / name / deleted。
 * 绝不携带人物属性、秘密或其它字段（历史事件里的人物也不例外）。
 */
export interface ItemHolderRef {
  readonly id: string;
  readonly name: string;
  /** 该人物是否已被软删除（历史持有人可能已删除）。 */
  readonly deleted: boolean;
}

/** 事件对外视图。 */
export interface ItemEventView {
  readonly id: string;
  readonly itemId: string;
  readonly seq: number;
  readonly eventType: ItemEventType;
  /** 服务端推导的转出方；`obtained` 为 null。 */
  readonly fromHolder: ItemHolderRef | null;
  /** 转入方；`consumed` / `lost` 为 null。 */
  readonly toHolder: ItemHolderRef | null;
  /** 本行是冲正行时，指向被冲正的目标事件。 */
  readonly reversalOf: string | null;
  /** 本行是目标事件时，指向冲正它的那条事件。 */
  readonly reversedBy: string | null;
  readonly reversed: boolean;
  readonly note: string | null;
  readonly createdAt: string;
}

/** 事件分页结果。 */
export interface ItemEventPage {
  readonly events: readonly ItemEventView[];
  readonly hasMore: boolean;
  readonly nextAfterSeq: number;
}

/** 物品状态（回放结果）。 */
export interface ItemStateView {
  readonly itemId: string;
  readonly itemName: string;
  readonly status: ItemStatus;
  readonly holder: ItemHolderRef | null;
  /** 全部事件行数（含冲正行）。 */
  readonly eventCount: number;
  readonly effectiveEventCount: number;
  /** 最后一条事件的 seq；0 表示还没有任何事件。 */
  readonly lastSeq: number;
  readonly lastEventAt: string | null;
}

/** 追加事件的输入。 */
export interface AppendItemEventInput {
  readonly workId: string;
  readonly authorId: string;
  readonly itemId: string;
  /** 事件类型；非法值在服务层转成 400 `VALIDATION_FAILED`。 */
  readonly eventType: string;
  /** `obtained` / `transferred` 必填；`consumed` / `lost` 必须为空。 */
  readonly toHolder?: string | null;
  readonly note?: string | null;
  readonly idempotencyKey: string;
  readonly meta: RequestMeta;
}

/** 冲正事件的输入。 */
export interface ReverseItemEventInput {
  readonly workId: string;
  readonly authorId: string;
  readonly itemId: string;
  readonly eventId: string;
  readonly note?: string | null;
  readonly idempotencyKey: string;
  readonly meta: RequestMeta;
}

/** 写操作结果。 */
export interface ItemEventMutationResult {
  readonly event: ItemEventView;
  readonly state: ItemStateView;
  /** 同一幂等键命中既有事件时为 true。 */
  readonly deduplicated: boolean;
}

/** 列表查询输入。 */
export interface ListItemEventsInput {
  readonly workId: string;
  readonly authorId: string;
  readonly itemId: string;
  readonly afterSeq?: number;
  readonly limit?: number;
}

/** 状态查询输入。 */
export interface GetItemStateInput {
  readonly workId: string;
  readonly authorId: string;
  readonly itemId: string;
}

/* -------------------------------------------------------------------------- */
/* 读路径                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 列出物品事件（seq 升序，afterSeq 游标）。
 *
 * 一次性取全部事件再切片：`reversedBy` 必须知道"某行在**后面**是否被冲正过"，
 * 而冲正行一定在目标行之后 —— 只按页取会让第一页的 `reversed` 永远为 false。
 * 单项物品的事件量很小（契约 D4：全量回放，不做快照表）。
 */
export async function listItemEvents(
  db: PrismaClient,
  input: ListItemEventsInput,
): Promise<ItemEventPage> {
  assertUuid(input.workId, '作品 id');
  assertUuid(input.itemId, '物品 id');

  const afterSeq = normalizeAfterSeq(input.afterSeq);
  const limit = normalizePageSize(input.limit);

  const work = await requireOwnedWork(db, input.workId, input.authorId);
  const item = await requireItem(db, work.id, input.itemId, false);

  const rows = await db.itemEvent.findMany({
    where: { itemEntityId: item.id },
    orderBy: { seqNo: 'asc' },
    select: { ...ITEM_EVENT_ROW_SELECT, note: true },
  });

  const snapshot = replayItemState(rows);
  const refs = await loadHolderRefs(db, rows);
  const rest = rows.filter((row) => row.seqNo > afterSeq);
  const page = rest.slice(0, limit);
  const hasMore = rest.length > page.length;

  return {
    events: page.map((row) => toEventView(item.id, row, refs, snapshot.reversedBy)),
    hasMore,
    nextAfterSeq: page.length === 0 ? afterSeq : (page[page.length - 1] as ItemEventRow).seqNo,
  };
}

/** 读取物品派生状态。 */
export async function getItemState(
  db: PrismaClient,
  input: GetItemStateInput,
): Promise<ItemStateView> {
  assertUuid(input.workId, '作品 id');
  assertUuid(input.itemId, '物品 id');

  const work = await requireOwnedWork(db, input.workId, input.authorId);
  const item = await requireItem(db, work.id, input.itemId, false);

  const rows = await db.itemEvent.findMany({
    where: { itemEntityId: item.id },
    orderBy: { seqNo: 'asc' },
    select: { ...ITEM_EVENT_ROW_SELECT, note: true },
  });
  const snapshot = replayItemState(rows);
  const refs = await loadHolderRefs(db, rows);
  return toStateView(item, snapshot, refs);
}

/* -------------------------------------------------------------------------- */
/* 写路径                                                                      */
/* -------------------------------------------------------------------------- */

/** 追加一条事件。 */
export async function appendItemEvent(
  db: PrismaClient,
  input: AppendItemEventInput,
): Promise<ItemEventMutationResult> {
  assertUuid(input.workId, '作品 id');
  assertUuid(input.itemId, '物品 id');
  if (!isItemEventType(input.eventType)) {
    throw new AuthError('VALIDATION_FAILED', '未知的事件类型');
  }
  const eventType = input.eventType;
  const note = normalizeNote(input.note);
  const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  const requestedHolder = normalizeOptionalId(input.toHolder);

  try {
    return await runWorkWrite(db, input.workId, async (tx) => {
      const work = await requireOwnedWork(tx, input.workId, input.authorId);
      const item = await requireItem(tx, work.id, input.itemId, true);

      // 1) 幂等查重（锁内、状态机校验之前）
      const existing = await tx.itemEvent.findFirst({
        where: { itemEntityId: item.id, idempotencyKey },
        select: { ...ITEM_EVENT_ROW_SELECT, note: true },
      });
      if (existing !== null) {
        const same =
          existing.eventType === eventType &&
          (existing.toHolder ?? null) === requestedHolder &&
          (existing.note ?? null) === note;
        if (!same) {
          throw new AuthError('ITEM_EVENT_IDEMPOTENCY_CONFLICT');
        }
        return deduplicatedResult(tx, item, existing.id);
      }

      // 2) 回放当前状态
      const rows = await loadItemEventRows(tx, item.id);
      const snapshot = replayItemState(rows);
      assertTransitionAllowed(snapshot, eventType);

      // 3) 持有人：由服务端按事件类型与当前状态推导，客户端只能给 to
      const toHolder = await resolveToHolder(tx, {
        workId: work.id,
        eventType,
        requestedHolder,
        currentHolderId: snapshot.holderId,
      });
      const fromHolder = eventType === 'obtained' ? null : snapshot.holderId;

      // 4) seq 在锁内取 max+1；(item, seq) 唯一索引兜底
      const created = await tx.itemEvent.create({
        data: {
          workId: work.id,
          itemEntityId: item.id,
          eventType,
          fromHolder,
          toHolder,
          seqNo: snapshot.lastSeq + 1,
          reversalOf: null,
          idempotencyKey,
          note,
          createdBy: input.authorId,
        },
        select: { ...ITEM_EVENT_ROW_SELECT, note: true },
      });

      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.ITEM_EVENT_RECORDED,
        actorId: input.authorId,
        targetType: 'item_event',
        targetId: created.id,
        // 只记定位信息：**不含 note、不含持有人姓名**
        detail: {
          workId: work.id,
          itemId: item.id,
          eventId: created.id,
          eventType: created.eventType,
          seq: created.seqNo,
        },
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
      });

      const nextRows = [...rows, created];
      return buildResult(tx, item, created, nextRows);
    });
  } catch (error) {
    throw translateItemEventError(error);
  }
}

/**
 * 冲正一条事件。
 *
 * 只允许冲正**当前最新**、且未被冲正过的普通事件；
 * 冲正本身通过追加一条反向事件完成，历史行一个字都不改。
 */
export async function reverseItemEvent(
  db: PrismaClient,
  input: ReverseItemEventInput,
): Promise<ItemEventMutationResult> {
  assertUuid(input.workId, '作品 id');
  assertUuid(input.itemId, '物品 id');
  assertUuid(input.eventId, '事件 id');
  const note = normalizeNote(input.note);
  const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);

  try {
    return await runWorkWrite(db, input.workId, async (tx) => {
      const work = await requireOwnedWork(tx, input.workId, input.authorId);
      const item = await requireItem(tx, work.id, input.itemId, true);

      // 1) 幂等查重（锁内、一切状态校验之前）。
      //    冲正的可控内容 = reversalOf + note。
      const existing = await tx.itemEvent.findFirst({
        where: { itemEntityId: item.id, idempotencyKey },
        select: { ...ITEM_EVENT_ROW_SELECT, note: true },
      });
      if (existing !== null) {
        const same = existing.reversalOf === input.eventId && (existing.note ?? null) === note;
        if (!same) {
          throw new AuthError('ITEM_EVENT_IDEMPOTENCY_CONFLICT');
        }
        return deduplicatedResult(tx, item, existing.id);
      }

      const rows = await loadItemEventRows(tx, item.id);
      const snapshot = replayItemState(rows);

      const target = rows.find((row) => row.id === input.eventId);
      if (target === undefined) {
        throw new AuthError('NOT_FOUND', '事件不存在');
      }
      // 2) 三条冲正约束：不能冲正冲正行、只能冲正最新、只能冲正一次
      if (target.reversalOf !== null) {
        throw new AuthError('ITEM_EVENT_NOT_REVERSIBLE', '冲正事件本身不能再被冲正');
      }
      if (target.seqNo !== snapshot.lastSeq) {
        throw new AuthError('ITEM_EVENT_NOT_REVERSIBLE', '只能冲正当前最新事件');
      }
      if (snapshot.reversedBy.has(target.id)) {
        throw new AuthError('ITEM_EVENT_NOT_REVERSIBLE', '该事件已被冲正');
      }

      const mirror = mirrorOf(target);
      const created = await tx.itemEvent.create({
        data: {
          workId: work.id,
          itemEntityId: item.id,
          eventType: mirror.eventType,
          fromHolder: mirror.fromHolder,
          toHolder: mirror.toHolder,
          seqNo: snapshot.lastSeq + 1,
          reversalOf: target.id,
          idempotencyKey,
          note,
          createdBy: input.authorId,
        },
        select: { ...ITEM_EVENT_ROW_SELECT, note: true },
      });

      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.ITEM_EVENT_REVERSED,
        actorId: input.authorId,
        targetType: 'item_event',
        targetId: created.id,
        detail: {
          workId: work.id,
          itemId: item.id,
          eventId: created.id,
          // 被冲正的目标也记下来（只是 id），便于审计对账
          reversalOf: target.id,
          eventType: created.eventType,
          seq: created.seqNo,
        },
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
      });

      const nextRows = [...rows, created];
      return buildResult(tx, item, created, nextRows);
    });
  } catch (error) {
    throw translateItemEventError(error);
  }
}

/* -------------------------------------------------------------------------- */
/* 内部实现                                                                    */
/* -------------------------------------------------------------------------- */

/** 物品定位结果。 */
interface ItemRecord {
  readonly id: string;
  readonly name: string;
  readonly deletedAt: Date | null;
}

/**
 * 定位物品（必须是本人作品下的 `item` 实体）。
 *
 * - 不存在 / 不属于该作品 / 类型不是 item → 404（不泄露他人作品是否存在）；
 * - 写路径额外要求未软删除，否则 `ITEM_EVENTS_CLOSED`。
 */
async function requireItem(
  db: Pick<PrismaClient, 'entity'>,
  workId: string,
  itemId: string,
  forWrite: boolean,
): Promise<ItemRecord> {
  const item = await db.entity.findFirst({
    where: { id: itemId, workId, entityType: ITEM_ENTITY_TYPE },
    select: { id: true, name: true, deletedAt: true },
  });
  if (item === null) {
    throw new AuthError('NOT_FOUND', '物品不存在');
  }
  if (forWrite && item.deletedAt !== null) {
    throw new AuthError('ITEM_EVENTS_CLOSED');
  }
  return item;
}

/** 状态机：哪些事件可以在当前状态下发生。 */
function assertTransitionAllowed(snapshot: ItemStateSnapshot, eventType: ItemEventType): void {
  // 获得：从未登记 / 已消耗 / 已丢失 都可以重新获得（契约 D2）
  // 其余三类：必须当前处于"持有中"
  const allowed =
    eventType === 'obtained' ? snapshot.status !== 'held' : snapshot.status === 'held';
  if (!allowed) {
    throw new AuthError(
      'ITEM_EVENT_INVALID_TRANSITION',
      `物品当前状态为 ${snapshot.status}，不能记录 ${eventType}`,
    );
  }
}

/** 解析并校验转入方。 */
async function resolveToHolder(
  tx: Prisma.TransactionClient,
  input: {
    workId: string;
    eventType: ItemEventType;
    requestedHolder: string | null;
    currentHolderId: string | null;
  },
): Promise<string | null> {
  const needsHolder = input.eventType === 'obtained' || input.eventType === 'transferred';
  if (!needsHolder) {
    if (input.requestedHolder !== null) {
      throw new AuthError('VALIDATION_FAILED', '该事件类型不能指定持有人');
    }
    return null;
  }
  if (input.requestedHolder === null) {
    throw new AuthError('VALIDATION_FAILED', '该事件类型必须指定持有人');
  }

  const holder = await tx.entity.findFirst({
    where: {
      id: input.requestedHolder,
      workId: input.workId,
      entityType: HOLDER_ENTITY_TYPE,
      deletedAt: null,
    },
    select: { id: true },
  });
  // 不存在 / 已删除 / 跨作品 / 类型不符：统一文案，不泄露存在性
  if (holder === null) {
    throw new AuthError('VALIDATION_FAILED', '引用目标不存在', { message: '引用目标不存在' });
  }
  if (input.eventType === 'transferred' && holder.id === input.currentHolderId) {
    throw new AuthError('ITEM_EVENT_INVALID_TRANSITION', '新持有人与当前持有人相同');
  }
  return holder.id;
}

/** 冲正事件的反向形态（只用于写入；回放不依赖它）。 */
function mirrorOf(target: ItemEventRow): {
  eventType: ItemEventType;
  fromHolder: string | null;
  toHolder: string | null;
} {
  switch (target.eventType) {
    case 'obtained':
      // 撤销"获得"：从持有人手里退回"未持有"，四值词汇里用 lost 表达
      return { eventType: 'lost', fromHolder: target.toHolder, toHolder: null };
    case 'transferred':
      return {
        eventType: 'transferred',
        fromHolder: target.toHolder,
        toHolder: target.fromHolder,
      };
    case 'consumed':
    case 'lost':
      // 撤销"消耗/丢失"：重新回到该持有人手里
      return { eventType: 'obtained', fromHolder: null, toHolder: target.fromHolder };
    default:
      throw new AuthError('ITEM_EVENT_NOT_REVERSIBLE', '未知的事件类型');
  }
}

/** 幂等命中时的返回（不改任何数据，也不写审计）。 */
async function deduplicatedResult(
  tx: Prisma.TransactionClient,
  item: ItemRecord,
  eventId: string,
): Promise<ItemEventMutationResult> {
  const rows = await tx.itemEvent.findMany({
    where: { itemEntityId: item.id },
    orderBy: { seqNo: 'asc' },
    select: { ...ITEM_EVENT_ROW_SELECT, note: true },
  });
  const event = rows.find((row) => row.id === eventId);
  if (event === undefined) {
    // 理论上不可能：按幂等键查到了、又按同一物品查不到
    throw new AuthError('CONCURRENT_MODIFICATION');
  }
  const result = await buildResult(tx, item, event, rows);
  return { ...result, deduplicated: true };
}

/** 组装"写入后"的事件视图与状态视图。 */
async function buildResult(
  tx: Prisma.TransactionClient,
  item: ItemRecord,
  event: ItemEventRow,
  rows: readonly ItemEventRow[],
): Promise<ItemEventMutationResult> {
  const snapshot = replayItemState(rows);
  const refs = await loadHolderRefs(tx, rows);
  return {
    event: toEventView(item.id, event, refs, snapshot.reversedBy),
    state: toStateView(item, snapshot, refs),
    deduplicated: false,
  };
}

/** 批量取持有人名称与删除状态（**只取定位信息**）。 */
async function loadHolderRefs(
  db: Pick<PrismaClient, 'entity'>,
  rows: readonly ItemEventRow[],
): Promise<Map<string, ItemHolderRef>> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.fromHolder !== null) {
      ids.add(row.fromHolder);
    }
    if (row.toHolder !== null) {
      ids.add(row.toHolder);
    }
  }
  if (ids.size === 0) {
    return new Map();
  }

  const holders = await db.entity.findMany({
    where: { id: { in: [...ids] } },
    // 只选三列：绝不把人物属性/秘密带进事件 DTO
    select: { id: true, name: true, deletedAt: true },
  });
  return new Map(
    holders.map((holder) => [
      holder.id,
      { id: holder.id, name: holder.name, deleted: holder.deletedAt !== null },
    ]),
  );
}

/** 行 → 事件视图。 */
function toEventView(
  itemId: string,
  row: ItemEventRow & { note?: string | null },
  refs: ReadonlyMap<string, ItemHolderRef>,
  reversedBy: ReadonlyMap<string, string>,
): ItemEventView {
  const fromHolder = row.fromHolder === null ? null : (refs.get(row.fromHolder) ?? null);
  const toHolder = row.toHolder === null ? null : (refs.get(row.toHolder) ?? null);
  const reversalEventId = reversedBy.get(row.id) ?? null;
  return {
    id: row.id,
    itemId,
    seq: row.seqNo,
    eventType: row.eventType as ItemEventType,
    fromHolder,
    toHolder,
    reversalOf: row.reversalOf,
    reversedBy: reversalEventId,
    reversed: reversalEventId !== null,
    note: row.note ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 回放结果 → 状态视图。 */
function toStateView(
  item: ItemRecord,
  snapshot: ItemStateSnapshot,
  refs: ReadonlyMap<string, ItemHolderRef>,
): ItemStateView {
  return {
    itemId: item.id,
    itemName: item.name,
    status: snapshot.status,
    holder: snapshot.holderId === null ? null : (refs.get(snapshot.holderId) ?? null),
    eventCount: snapshot.eventCount,
    effectiveEventCount: snapshot.effectiveEventCount,
    lastSeq: snapshot.lastSeq,
    lastEventAt: snapshot.lastEventAt?.toISOString() ?? null,
  };
}

/** 备注规范化：空串视同未填。 */
function normalizeNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) {
    return null;
  }
  const text = note.trim();
  if (text === '') {
    return null;
  }
  if (text.length > MAX_ITEM_EVENT_NOTE_LENGTH) {
    throw new AuthError('VALIDATION_FAILED', `备注最长 ${MAX_ITEM_EVENT_NOTE_LENGTH} 个字符`);
  }
  return text;
}

/** 幂等键形态校验（数据库 CHECK 兜底，这里给出稳定的 400）。 */
function assertIdempotencyKey(key: string): string {
  if (
    typeof key !== 'string' ||
    key.length < MIN_IDEMPOTENCY_KEY_LENGTH ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(key)
  ) {
    throw new AuthError(
      'VALIDATION_FAILED',
      `幂等键必须是 ${MIN_IDEMPOTENCY_KEY_LENGTH}–${MAX_IDEMPOTENCY_KEY_LENGTH} 位的字母、数字、下划线或短横线`,
    );
  }
  return key;
}

/** 可选 id 规范化：空串/undefined 一律视为未提供。 */
function normalizeOptionalId(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return value;
}

/** afterSeq：非负整数。 */
function normalizeAfterSeq(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new AuthError('VALIDATION_FAILED', 'afterSeq 必须是非负整数');
  }
  return value;
}

/** limit：1..MAX，缺省 50。 */
function normalizePageSize(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_ITEM_EVENT_PAGE_SIZE;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_ITEM_EVENT_PAGE_SIZE) {
    throw new AuthError('VALIDATION_FAILED', `limit 必须是 1–${MAX_ITEM_EVENT_PAGE_SIZE} 的整数`);
  }
  return value;
}

/**
 * 把数据库层错误翻译成稳定错误码。
 *
 * - 死锁 / 写冲突 → 409 `CONCURRENT_MODIFICATION`（可重试，不暴露 500）；
 * - `(item, seq)` 唯一冲突 → 同上（锁被绕过时的兜底）；
 * - `(item, idempotency_key)` 冲突 → 409 `ITEM_EVENT_IDEMPOTENCY_CONFLICT`
 *   （同一把锁内本不该发生，属于跨进程兜底）；
 * - `reversal_of` 唯一冲突 → 409 `ITEM_EVENT_NOT_REVERSIBLE`。
 */
function translateItemEventError(error: unknown): unknown {
  if (isConcurrencyError(error)) {
    return new AuthError('CONCURRENT_MODIFICATION');
  }
  const marker = uniqueConstraintMarker(error);
  if (marker === null) {
    return error;
  }
  if (marker.includes('reversal_of')) {
    return new AuthError('ITEM_EVENT_NOT_REVERSIBLE', '该事件已被冲正');
  }
  if (marker.includes('idempotency_key')) {
    return new AuthError('ITEM_EVENT_IDEMPOTENCY_CONFLICT');
  }
  return new AuthError('CONCURRENT_MODIFICATION');
}
