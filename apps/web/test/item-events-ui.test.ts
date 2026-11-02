/**
 * 物品持有人 / 时间线 UI 的纯逻辑单测（M2-B3-B2）。
 *
 * 覆盖**规则**而非样式：
 * - 中文 label（不把英文 eventType 展示给作者）；
 * - 当前状态 → 合法操作集合；
 * - 冲正按钮只出现在"最新、未冲正、非冲正行"；
 * - 冲正行显示「冲正 #N」、目标行置灰；
 * - 空状态区分"从未登记"与"不应发生"的安全错误；
 * - 备注长度、幂等键的复用/更换/成功清空；
 * - 五个事件错误码的中文映射与 CONCURRENT_MODIFICATION 不跳登录。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  type ItemEventType,
  type ItemEventView,
  type ItemHolderRef,
  type ItemStateView,
} from '../src/lib/api';
import {
  ITEM_EVENT_TYPE_LABELS,
  ITEM_STATUS_LABELS,
  allowedEventActions,
  buildTimeline,
  emptyTimelineNotice,
  eventTypeLabel,
  fingerprintOfEvent,
  fingerprintOfReversal,
  holderSummary,
  holderText,
  idempotencyKeyFor,
  mergeEventPages,
  newIdempotencyKey,
  noteError,
  routeText,
  type IdempotencyDraft,
} from '../src/lib/item-events';
import { sessionRedirectTarget } from '../src/lib/session-errors';

function holder(id: string, name: string, deleted = false): ItemHolderRef {
  return { id, name, deleted };
}

function makeEvent(input: {
  id: string;
  seq: number;
  eventType: ItemEventType;
  from?: ItemHolderRef | null;
  to?: ItemHolderRef | null;
  reversalOf?: string | null;
  reversedBy?: string | null;
  note?: string | null;
}): ItemEventView {
  const reversalOf = input.reversalOf ?? null;
  const reversedBy = input.reversedBy ?? null;
  return {
    id: input.id,
    itemId: 'item-1',
    seq: input.seq,
    eventType: input.eventType,
    fromHolder: input.from ?? null,
    toHolder: input.to ?? null,
    reversalOf,
    reversedBy,
    reversed: reversedBy !== null,
    note: input.note ?? null,
    createdAt: `2026-11-02T10:0${input.seq}:00.000Z`,
  };
}

function makeState(overrides: Partial<ItemStateView> = {}): ItemStateView {
  return {
    itemId: 'item-1',
    itemName: '青锋剑',
    status: 'unrecorded',
    holder: null,
    eventCount: 0,
    effectiveEventCount: 0,
    lastSeq: 0,
    lastEventAt: null,
    ...overrides,
  };
}

describe('中文 label', () => {
  it('四种状态与四种事件都有中文文案，且不含英文原值', () => {
    expect(Object.values(ITEM_STATUS_LABELS)).toEqual(['未登记', '持有中', '已消耗', '已丢失']);
    expect(Object.values(ITEM_EVENT_TYPE_LABELS)).toEqual(['获得', '转手', '消耗', '丢失']);
    for (const label of [
      ...Object.values(ITEM_STATUS_LABELS),
      ...Object.values(ITEM_EVENT_TYPE_LABELS),
    ]) {
      expect(label).not.toMatch(/[a-z]/i);
    }
    expect(eventTypeLabel('transferred')).toBe('转手');
  });

  it('未知事件类型给安全兜底，不回显英文原值', () => {
    expect(eventTypeLabel('unknown' as ItemEventType)).toBe('未知事件');
  });
});

describe('当前状态 → 合法操作', () => {
  it.each(['unrecorded', 'consumed', 'lost'] as const)('%s 只能登记获得', (status) => {
    const actions = allowedEventActions(status);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      eventType: 'obtained',
      label: '登记获得',
      requiresHolder: true,
    });
  });

  it('持有中：转手（需持有人）/ 消耗 / 丢失（不需持有人）', () => {
    expect(allowedEventActions('held')).toEqual([
      { eventType: 'transferred', label: '转手', requiresHolder: true },
      { eventType: 'consumed', label: '消耗', requiresHolder: false },
      { eventType: 'lost', label: '丢失', requiresHolder: false },
    ]);
  });

  it('持有中不出现「获得」，未持有时不出现「转手/消耗/丢失」', () => {
    expect(allowedEventActions('held').map((action) => action.eventType)).not.toContain('obtained');
    for (const status of ['unrecorded', 'consumed', 'lost'] as const) {
      const types = allowedEventActions(status).map((action) => action.eventType);
      expect(types).not.toContain('transferred');
      expect(types).not.toContain('consumed');
      expect(types).not.toContain('lost');
    }
  });
});

describe('持有人与 from → to', () => {
  it('无持有人显示明确文案，已删除显示「已删除角色」', () => {
    expect(holderText(null)).toBe('暂无持有人');
    expect(holderText(holder('c1', '林青'))).toBe('林青');
    expect(holderText(holder('c1', '林青', true))).toBe('已删除角色');
  });

  it('from → to 不出现 null，缺失一侧用 —', () => {
    const obtained = makeEvent({
      id: 'e1',
      seq: 1,
      eventType: 'obtained',
      to: holder('c1', '林青'),
    });
    const transfer = makeEvent({
      id: 'e2',
      seq: 2,
      eventType: 'transferred',
      from: holder('c1', '林青'),
      to: holder('c2', '苏沐'),
    });
    const consumed = makeEvent({
      id: 'e3',
      seq: 3,
      eventType: 'consumed',
      from: holder('c2', '苏沐'),
    });

    expect(routeText(obtained)).toBe('— → 林青');
    expect(routeText(transfer)).toBe('林青 → 苏沐');
    expect(routeText(consumed)).toBe('苏沐 → —');
  });

  it('历史持有人被删除后只显示「已删除角色」，不显示姓名', () => {
    const transfer = makeEvent({
      id: 'e2',
      seq: 2,
      eventType: 'transferred',
      from: holder('c1', '林青', true),
      to: holder('c2', '苏沐'),
    });
    expect(routeText(transfer)).toBe('已删除角色 → 苏沐');
  });
});

describe('时间线', () => {
  const state = makeState({
    status: 'held',
    holder: holder('c2', '苏沐'),
    eventCount: 3,
    effectiveEventCount: 1,
    lastSeq: 3,
  });

  const events: readonly ItemEventView[] = [
    // 故意乱序，验证按 seq 升序
    makeEvent({
      id: 'e3',
      seq: 3,
      eventType: 'obtained',
      to: holder('c2', '苏沐'),
      reversalOf: 'e2',
    }),
    makeEvent({ id: 'e1', seq: 1, eventType: 'obtained', to: holder('c1', '林青') }),
    makeEvent({
      id: 'e2',
      seq: 2,
      eventType: 'transferred',
      from: holder('c1', '林青'),
      to: holder('c2', '苏沐'),
      reversedBy: 'e3',
      note: '借出',
    }),
  ];

  it('按 seq 升序，冲正行显示「冲正 #N」而不是镜像出来的类型', () => {
    const rows = buildTimeline(events, state, { closed: false });
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows[2]?.typeLabel).toBe('冲正 #2');
    expect(rows[2]?.isReversal).toBe(true);
    expect(rows[2]?.tone).toBe('reversal');
    // 不能把冲正行显示成一次普通的「获得」
    expect(rows[2]?.typeLabel).not.toBe(ITEM_EVENT_TYPE_LABELS.obtained);
  });

  it('被冲正的目标行标记 reversed 并置灰', () => {
    const rows = buildTimeline(events, state, { closed: false });
    expect(rows[1]?.reversed).toBe(true);
    expect(rows[1]?.tone).toBe('reversed');
    expect(rows[0]?.reversed).toBe(false);
  });

  it('只有最新、未冲正、非冲正行可以冲正', () => {
    const rows = buildTimeline(events, state, { closed: false });
    // 最新一行是冲正行 → 不可再冲正
    expect(rows.map((row) => row.canReverse)).toEqual([false, false, false]);
  });

  it('最新普通事件可冲正；更早的普通事件不可', () => {
    const live: ItemStateView = makeState({
      status: 'consumed',
      holder: null,
      eventCount: 3,
      effectiveEventCount: 3,
      lastSeq: 3,
    });
    const rows = buildTimeline(
      [
        makeEvent({ id: 'e1', seq: 1, eventType: 'obtained', to: holder('c1', '林青') }),
        makeEvent({
          id: 'e2',
          seq: 2,
          eventType: 'transferred',
          from: holder('c1', '林青'),
          to: holder('c2', '苏沐'),
        }),
        makeEvent({ id: 'e3', seq: 3, eventType: 'consumed', from: holder('c2', '苏沐') }),
      ],
      live,
      { closed: false },
    );
    expect(rows.map((row) => row.canReverse)).toEqual([false, false, true]);
  });

  it('物品已软删除时任何行都不可冲正', () => {
    const rows = buildTimeline(events, state, { closed: true });
    expect(rows.every((row) => !row.canReverse)).toBe(true);
  });

  it('目标行不在已加载区间时，冲正行仍标为冲正（不伪装成普通事件）', () => {
    const page = [
      makeEvent({
        id: 'e9',
        seq: 9,
        eventType: 'lost',
        from: holder('c2', '苏沐'),
        reversalOf: 'e8',
      }),
    ];
    const rows = buildTimeline(page, makeState({ status: 'held', lastSeq: 9 }), {
      closed: false,
    });
    expect(rows[0]?.typeLabel).toBe('冲正');
    expect(rows[0]?.isReversal).toBe(true);
    expect(rows[0]?.reversalTargetSeq).toBeNull();
  });

  it('分页合并按 id 去重并按 seq 排序', () => {
    const first = [
      makeEvent({ id: 'e1', seq: 1, eventType: 'obtained', to: holder('c1', '林青') }),
      makeEvent({ id: 'e2', seq: 2, eventType: 'lost', from: holder('c1', '林青') }),
    ];
    const second = [
      makeEvent({
        id: 'e2',
        seq: 2,
        eventType: 'lost',
        from: holder('c1', '林青'),
        note: '重复页',
      }),
      makeEvent({ id: 'e3', seq: 3, eventType: 'obtained', to: holder('c2', '苏沐') }),
    ];
    const merged = mergeEventPages(first, second);
    expect(merged.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(merged).toHaveLength(3);
    // 同 id 以后到的版本为准
    expect(merged[1]?.note).toBe('重复页');
  });
});

describe('空状态', () => {
  it('从未登记：给引导文案而不是错误', () => {
    const notice = emptyTimelineNotice(makeState(), 0);
    expect(notice.kind).toBe('never-recorded');
    expect(notice.message).toContain('还没有任何事件');
  });

  it('没有事件但状态不是未登记：给安全错误提示', () => {
    const notice = emptyTimelineNotice(makeState({ status: 'held' }), 0);
    expect(notice.kind).toBe('inconsistent');
    expect(notice.message).toContain('状态数据异常');
  });

  it('状态说有事件但时间线为空：同样视为异常', () => {
    const notice = emptyTimelineNotice(makeState({ eventCount: 3, lastSeq: 3 }), 0);
    expect(notice.kind).toBe('inconsistent');
    expect(notice.message).toContain('3');
  });

  it('有事件且已加载：不显示任何空态', () => {
    const notice = emptyTimelineNotice(makeState({ eventCount: 1, lastSeq: 1 }), 1);
    expect(notice.kind).toBe('none');
    expect(notice.message).toBe('');
  });
});

describe('卡片入口摘要', () => {
  it('加载中 / 未登记 / 持有中 / 已消耗 / 已丢失', () => {
    expect(holderSummary(null)).toBe('持有人：加载中…');
    expect(holderSummary(makeState())).toBe('未登记');
    expect(holderSummary(makeState({ status: 'held', holder: holder('c1', '林青') }))).toBe(
      '持有中 · 林青',
    );
    expect(holderSummary(makeState({ status: 'consumed' }))).toBe('已消耗');
    expect(holderSummary(makeState({ status: 'lost' }))).toBe('已丢失');
  });

  it('持有中但没有持有人数据时给出显式提示', () => {
    expect(holderSummary(makeState({ status: 'held', holder: null }))).toBe('持有中 · 暂无持有人');
  });
});

describe('备注与幂等键', () => {
  it('备注上限 500，空串合法', () => {
    expect(noteError('')).toBeNull();
    expect(noteError('a'.repeat(500))).toBeNull();
    expect(noteError('a'.repeat(501))).toContain('500');
  });

  it('内容不变复用同一个键，内容变化换新键', () => {
    const generate = vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2');
    const first = idempotencyKeyFor(null, 'fp-a', generate);
    expect(first.key).toBe('key-1');
    expect(generate).toHaveBeenCalledTimes(1);

    // 失败重试：同一指纹 → 同一个键，不再生成
    const retry = idempotencyKeyFor(first.draft, 'fp-a', generate);
    expect(retry.key).toBe('key-1');
    expect(generate).toHaveBeenCalledTimes(1);

    // 内容变化 → 新键
    const changed = idempotencyKeyFor(retry.draft, 'fp-b', generate);
    expect(changed.key).not.toBe('key-1');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('成功后清空草稿 → 下一次提交重新生成', () => {
    const generate = vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2');
    const first = idempotencyKeyFor(null, 'fp-a', generate);
    const cleared: IdempotencyDraft | null = null;
    const next = idempotencyKeyFor(cleared, 'fp-a', generate);
    expect(first.key).toBe('key-1');
    expect(next.key).toBe('key-2');
  });

  it('指纹区分事件类型 / 持有人 / 备注，冲正指纹区分目标事件', () => {
    const base = { eventType: 'transferred' as const, toHolder: 'c2', note: '借出' };
    expect(fingerprintOfEvent(base)).toBe(fingerprintOfEvent({ ...base }));
    expect(fingerprintOfEvent(base)).not.toBe(
      fingerprintOfEvent({ ...base, eventType: 'obtained' }),
    );
    expect(fingerprintOfEvent(base)).not.toBe(fingerprintOfEvent({ ...base, toHolder: 'c3' }));
    expect(fingerprintOfEvent(base)).not.toBe(fingerprintOfEvent({ ...base, note: '归还' }));

    expect(fingerprintOfReversal({ eventId: 'e1', note: null })).not.toBe(
      fingerprintOfReversal({ eventId: 'e2', note: null }),
    );
    expect(fingerprintOfReversal({ eventId: 'e1', note: null })).toBe(
      fingerprintOfReversal({ eventId: 'e1', note: '' }),
    );
  });

  it('生成的键是 UUID v4 形状', () => {
    expect(newIdempotencyKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('错误码映射', () => {
  it('五类事件错误都有中文文案', () => {
    expect(new ApiError('ITEM_EVENT_INVALID_TRANSITION', 409).message).toBe(
      '当前物品状态不允许该操作',
    );
    expect(new ApiError('ITEM_EVENT_NOT_REVERSIBLE', 409).message).toBe(
      '只能冲正当前最新且未被冲正的事件',
    );
    expect(new ApiError('ITEM_EVENT_IDEMPOTENCY_CONFLICT', 409).message).toContain('幂等键');
    expect(new ApiError('ITEM_EVENTS_CLOSED', 409).message).toContain('物品已删除');
    expect(new ApiError('CONCURRENT_MODIFICATION', 409).message).toContain('请重试');
  });

  it('CONCURRENT_MODIFICATION 不触发登录跳转', () => {
    expect(sessionRedirectTarget('CONCURRENT_MODIFICATION')).toBeNull();
    expect(sessionRedirectTarget('ITEM_EVENT_INVALID_TRANSITION')).toBeNull();
    expect(sessionRedirectTarget('ITEM_EVENTS_CLOSED')).toBeNull();
  });
});
