/**
 * 物品持有人 / 事件时间线的**纯展示与表单逻辑**（M2-B3-B2）。
 *
 * 为什么把规则放在这里：时间线要展示的"合法操作""冲正按钮出现在哪一行"
 * "空状态该说什么"都是可枚举的规则，放在组件里只能靠 E2E 猜；
 * 抽成纯函数后可以用单测逐条钉住，组件只负责渲染。
 *
 * 约定：
 * - 展示只使用**中文 label**，不把英文 `eventType` 写进可见文本；
 * - 持有人只认 DTO 的 `{ id, name, deleted }`，不请求、不展示人物属性或秘密；
 * - 冲正行不当作普通获得/转手：它的类型文案固定为「冲正 #N」（N = 被冲正行的 seq）；
 * - 备注只存在于组件内存，不写 URL / localStorage / sessionStorage / 日志。
 */

import type { ItemEventType, ItemEventView, ItemHolderRef, ItemStateView, ItemStatus } from './api';

/** 备注长度上限（与服务端 CHECK `note <= 500` 一致）。 */
export const NOTE_MAX_LENGTH = 500;

/** 首屏事件条数（与服务端缺省 limit 一致）。 */
export const FIRST_PAGE_SIZE = 50;

/** 单次加载上限（与服务端 `limit <= 100` 一致）。 */
export const MAX_PAGE_SIZE = 100;

/** 生命周期状态 → 中文。 */
export const ITEM_STATUS_LABELS: Readonly<Record<ItemStatus, string>> = {
  unrecorded: '未登记',
  held: '持有中',
  consumed: '已消耗',
  lost: '已丢失',
};

/** 事件类型 → 中文。界面上**只**用这份文案。 */
export const ITEM_EVENT_TYPE_LABELS: Readonly<Record<ItemEventType, string>> = {
  obtained: '获得',
  transferred: '转手',
  consumed: '消耗',
  lost: '丢失',
};

/** 没有持有人时的明确文案（不显示空白或 `null`）。 */
export const NO_HOLDER_TEXT = '暂无持有人';

/** 持有人已被软删除时只显示这个，不再显示姓名。 */
export const DELETED_HOLDER_TEXT = '已删除角色';

/** 持有人 DTO → 展示文案。 */
export function holderText(holder: ItemHolderRef | null): string {
  if (holder === null) {
    return NO_HOLDER_TEXT;
  }
  return holder.deleted ? DELETED_HOLDER_TEXT : holder.name;
}

/** 时间线里的 from → to（缺失的一侧用 `—`，避免出现 `null`）。 */
export function routeText(event: ItemEventView): string {
  const side = (holder: ItemHolderRef | null): string =>
    holder === null ? '—' : holder.deleted ? DELETED_HOLDER_TEXT : holder.name;
  return `${side(event.fromHolder)} → ${side(event.toHolder)}`;
}

/** 表单里的一个合法操作。 */
export interface EventAction {
  readonly eventType: ItemEventType;
  readonly label: string;
  /** 是否必须选择持有人（获得 / 转手为 true）。 */
  readonly requiresHolder: boolean;
}

/**
 * 当前状态下允许追加的事件类型。
 *
 * 与后端状态机一一对应（非法组合不渲染，避免"点了必然 409"的按钮）：
 * - 未登记 / 已消耗 / 已丢失 → 只能「登记获得」；
 * - 持有中 → 转手 / 消耗 / 丢失。
 */
export function allowedEventActions(status: ItemStatus): readonly EventAction[] {
  if (status === 'held') {
    return [
      { eventType: 'transferred', label: '转手', requiresHolder: true },
      { eventType: 'consumed', label: '消耗', requiresHolder: false },
      { eventType: 'lost', label: '丢失', requiresHolder: false },
    ];
  }
  return [{ eventType: 'obtained', label: '登记获得', requiresHolder: true }];
}

/** 事件类型的中文 label（未知类型不显示英文原值）。 */
export function eventTypeLabel(eventType: ItemEventType): string {
  return ITEM_EVENT_TYPE_LABELS[eventType] ?? '未知事件';
}

/**
 * 某条事件是否可冲正。
 *
 * 与服务端三条约束一致：必须是当前最新、未被冲正过、自身不是冲正行。
 * 物品已软删除时一律不可操作（服务端仍会以 `ITEM_EVENTS_CLOSED` 兜底）。
 */
export function canReverseEvent(
  event: ItemEventView,
  state: ItemStateView,
  options: { closed: boolean },
): boolean {
  if (options.closed) {
    return false;
  }
  if (event.reversalOf !== null || event.reversed) {
    return false;
  }
  return event.seq === state.lastSeq;
}

/** 时间线的一行（已把事件翻译成展示文案）。 */
export interface TimelineRow {
  readonly id: string;
  readonly seq: number;
  /** 「获得 / 转手 / 消耗 / 丢失」或「冲正 #N」。 */
  readonly typeLabel: string;
  readonly route: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly isReversal: boolean;
  /** 被冲正行的 seq；目标不在已加载区间时为 null。 */
  readonly reversalTargetSeq: number | null;
  /** 该行是**被冲正的目标**（置灰 + 「已冲正」）。 */
  readonly reversed: boolean;
  readonly canReverse: boolean;
  /** 样式钩子：普通 / 目标行 / 冲正行。 */
  readonly tone: 'normal' | 'reversed' | 'reversal';
}

/**
 * 事件列表 → 时间线行。
 *
 * - 按 seq 升序（服务端已升序，这里再排一次，防分页拼接乱序）；
 * - 冲正行的类型文案是「冲正 #N」，**不**沿用它镜像出来的获得/转手/丢失类型，
 *   否则会被误读成一次真实事件；
 * - 只有"最新、未冲正、非冲正行"才有 `canReverse`。
 */
export function buildTimeline(
  events: readonly ItemEventView[],
  state: ItemStateView,
  options: { closed: boolean },
): readonly TimelineRow[] {
  const seqById = new Map(events.map((event) => [event.id, event.seq]));
  return [...events]
    .sort((left, right) => left.seq - right.seq)
    .map((event): TimelineRow => {
      const isReversal = event.reversalOf !== null;
      const reversalTargetSeq =
        event.reversalOf === null ? null : (seqById.get(event.reversalOf) ?? null);
      const reversed = event.reversed;
      return {
        id: event.id,
        seq: event.seq,
        typeLabel: isReversal
          ? reversalTargetSeq === null
            ? '冲正'
            : `冲正 #${reversalTargetSeq}`
          : eventTypeLabel(event.eventType),
        route: routeText(event),
        note: event.note,
        createdAt: event.createdAt,
        isReversal,
        reversalTargetSeq,
        reversed,
        canReverse: canReverseEvent(event, state, options),
        tone: isReversal ? 'reversal' : reversed ? 'reversed' : 'normal',
      };
    });
}

/**
 * 同一批事件的合并（分页追加）。
 *
 * 以 id 去重（重新加载与"加载更多"可能重叠），结果按 seq 升序。
 */
export function mergeEventPages(
  existing: readonly ItemEventView[],
  incoming: readonly ItemEventView[],
): readonly ItemEventView[] {
  const byId = new Map<string, ItemEventView>();
  for (const event of [...existing, ...incoming]) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((left, right) => left.seq - right.seq);
}

/** 时间线空状态的判定结果。 */
export interface TimelineNotice {
  readonly kind: 'none' | 'never-recorded' | 'inconsistent';
  readonly message: string;
}

/**
 * 空时间线该说什么。
 *
 * - 从未登记（`unrecorded` + 0 条事件）→ 正常空态，引导去「登记获得」；
 * - 其它"没有事件但状态不是未登记"或"状态说有事件但一条也读不到" →
 *   属于不应发生的情况，给**安全**错误提示（不含内部细节），不假装正常。
 */
export function emptyTimelineNotice(state: ItemStateView, loadedCount: number): TimelineNotice {
  if (state.eventCount === 0) {
    if (state.status === 'unrecorded') {
      return {
        kind: 'never-recorded',
        message: '这件物品还没有任何事件记录。选择「登记获得」即可记下第一位持有人。',
      };
    }
    return {
      kind: 'inconsistent',
      message:
        '状态数据异常：没有任何事件，但物品状态不是「未登记」。请刷新页面；若仍异常，请联系管理员。',
    };
  }
  if (loadedCount === 0) {
    return {
      kind: 'inconsistent',
      message: `状态数据异常：状态显示有 ${state.eventCount} 条事件，但时间线为空。请刷新页面；若仍异常，请联系管理员。`,
    };
  }
  return { kind: 'none', message: '' };
}

/** 备注校验：空串合法（表示不填）。 */
export function noteError(note: string): string | null {
  if (note.length > NOTE_MAX_LENGTH) {
    return `备注不能超过 ${NOTE_MAX_LENGTH} 个字符`;
  }
  return null;
}

/** 卡片上的入口摘要（不打开面板也能看出当前归属）。 */
export function holderSummary(state: ItemStateView | null): string {
  if (state === null) {
    return '持有人：加载中…';
  }
  if (state.status === 'held') {
    return `持有中 · ${holderText(state.holder)}`;
  }
  return ITEM_STATUS_LABELS[state.status];
}

/* -------------------------------------------------------------------------- */
/* 幂等键                                                                      */
/* -------------------------------------------------------------------------- */

/** 一次尚未成功的提交所保留的幂等键。 */
export interface IdempotencyDraft {
  /** 提交内容的指纹；内容不变 → 复用 key。 */
  readonly fingerprint: string;
  readonly key: string;
}

/** 获取一个新的幂等键（每次新表单提交一个）。 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * 取本次提交应使用的幂等键。
 *
 * - 草稿存在且**内容指纹相同** → 复用（失败重试不会产生第二条事件）；
 * - 内容变了 → 换新键（这是另一次提交）；
 * - 成功后调用方必须把草稿清空（下次提交重新生成）。
 */
export function idempotencyKeyFor(
  draft: IdempotencyDraft | null,
  fingerprint: string,
  generate: () => string = newIdempotencyKey,
): { readonly draft: IdempotencyDraft; readonly key: string } {
  if (draft !== null && draft.fingerprint === fingerprint) {
    return { draft, key: draft.key };
  }
  const key = generate();
  return { draft: { fingerprint, key }, key };
}

/** 追加事件的内容指纹（只含客户端能决定的三项）。 */
export function fingerprintOfEvent(input: {
  eventType: ItemEventType;
  toHolder: string | null;
  note: string | null;
}): string {
  return ['append', input.eventType, input.toHolder ?? '', input.note ?? ''].join('\u0000');
}

/** 冲正的内容指纹（目标事件 + 备注）。 */
export function fingerprintOfReversal(input: { eventId: string; note: string | null }): string {
  return ['reversal', input.eventId, input.note ?? ''].join('\u0000');
}
