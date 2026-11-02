'use client';

/**
 * 物品持有人 / 事件面板（M2-B3-B2）。
 *
 * 进入方式：设定中心里 **item 卡片**上的「持有人 / 事件」按钮（或 `?item=<id>`）。
 * 面板只做三件事：
 * 1. 打开时同时读 `GET /state` 与 `GET /events`（首屏 50 条，`afterSeq` 继续加载）；
 * 2. 按当前状态只渲染合法操作（获得 / 转手 / 消耗 / 丢失）；
 * 3. 只对"最新、未冲正、非冲正行"提供冲正入口，且冲正必须二次确认。
 *
 * 安全与隐私：
 * - 事件行只展示 `{ id, name, deleted }`：`deleted=true` 显示「已删除角色」；
 * - 不请求任何人物属性 / 秘密；
 * - 备注草稿只存在于组件内存：不写 URL、localStorage、sessionStorage 或日志，
 *   关闭面板即销毁；
 * - 幂等键同样只在内存里（`useRef`），刷新/重开面板不会复用。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ApiError,
  appendItemEvent,
  formatDateTime,
  getItemState,
  listItemEvents,
  messageOf,
  reverseItemEvent,
  type EntityItem,
  type ItemEventType,
  type ItemEventView,
  type ItemStateView,
} from '@/lib/api';
import {
  FIRST_PAGE_SIZE,
  ITEM_STATUS_LABELS,
  MAX_PAGE_SIZE,
  NOTE_MAX_LENGTH,
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
  noteError,
  type EventAction,
  type IdempotencyDraft,
} from '@/lib/item-events';

import { ModalShell } from '../modal-shell';

export interface ItemEventsPanelProps {
  readonly workId: string;
  readonly itemId: string;
  /** 物品名（状态接口返回前先用它占位）。 */
  readonly fallbackName: string;
  /** 当前作品里**未删除**的人物（表单候选，父级已按作品过滤）。 */
  readonly characters: readonly EntityItem[];
  /** 物品已软删除：历史可读，但不再提供追加 / 冲正。 */
  readonly closed: boolean;
  readonly onClose: () => void;
  /** 状态变化回传（更新卡片上的入口摘要）。必须是稳定引用。 */
  readonly onStateChange: (state: ItemStateView) => void;
  /** 会话类错误（401/403）统一处理；返回 true 表示已跳转。 */
  readonly onSessionError: (error: unknown) => boolean;
}

/** 可重试的错误码：状态可能已过期，给一个「刷新状态」按钮。 */
function isRetryable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'CONCURRENT_MODIFICATION' ||
      error.code === 'ITEM_EVENT_INVALID_TRANSITION' ||
      error.code === 'ITEM_EVENT_NOT_REVERSIBLE')
  );
}

export function ItemEventsPanel({
  workId,
  itemId,
  fallbackName,
  characters,
  closed,
  onClose,
  onStateChange,
  onSessionError,
}: ItemEventsPanelProps): React.ReactElement {
  const closeRef = useRef<HTMLButtonElement>(null);

  const [state, setState] = useState<ItemStateView | null>(null);
  const [events, setEvents] = useState<readonly ItemEventView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextAfterSeq, setNextAfterSeq] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [formError, setFormError] = useState('');
  const [formRetryable, setFormRetryable] = useState(false);
  const [busy, setBusy] = useState(false);

  // 追加表单
  const [pickedType, setPickedType] = useState<ItemEventType | null>(null);
  const [toHolder, setToHolder] = useState('');
  const [note, setNote] = useState('');

  // 冲正（二次确认 + 可选备注）
  const [reversalTargetId, setReversalTargetId] = useState<string | null>(null);
  const [reversalNote, setReversalNote] = useState('');
  const [reversalError, setReversalError] = useState('');
  const [reversalBusy, setReversalBusy] = useState(false);

  /** 失败重试时复用同一个幂等键；成功后清空。 */
  const appendDraft = useRef<IdempotencyDraft | null>(null);
  const reversalDraft = useRef<IdempotencyDraft | null>(null);

  const actions = useMemo(() => (state === null ? [] : allowedEventActions(state.status)), [state]);
  const selected: EventAction | null =
    actions.find((action) => action.eventType === pickedType) ?? actions[0] ?? null;

  const itemName = state?.itemName ?? fallbackName;

  /** 追加 / 冲正成功后重新读状态与时间线（保留已加载的条数，最多 100）。 */
  const refresh = useCallback(async (): Promise<void> => {
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(FIRST_PAGE_SIZE, events.length));
    const [nextState, page] = await Promise.all([
      getItemState(workId, itemId),
      listItemEvents(workId, itemId, { limit }),
    ]);
    setState(nextState);
    onStateChange(nextState);
    setEvents(page.events);
    setHasMore(page.hasMore);
    setNextAfterSeq(page.nextAfterSeq);
  }, [workId, itemId, events.length, onStateChange]);

  // 首次打开：state 与 events **同时**请求
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextState, page] = await Promise.all([
          getItemState(workId, itemId),
          listItemEvents(workId, itemId, { limit: FIRST_PAGE_SIZE }),
        ]);
        if (cancelled) {
          return;
        }
        setState(nextState);
        onStateChange(nextState);
        setEvents(page.events);
        setHasMore(page.hasMore);
        setNextAfterSeq(page.nextAfterSeq);
        setLoadError('');
      } catch (caught) {
        if (cancelled) {
          return;
        }
        if (onSessionError(caught)) {
          return;
        }
        setLoadError(messageOf(caught));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workId, itemId, onStateChange, onSessionError]);

  /** 关闭：备注草稿随组件卸载销毁，这里再显式清一次，杜绝任何残留。 */
  function handleClose(): void {
    appendDraft.current = null;
    reversalDraft.current = null;
    setNote('');
    setReversalNote('');
    setPickedType(null);
    setToHolder('');
    onClose();
  }

  async function loadMore(): Promise<void> {
    if (busy || loading) {
      return;
    }
    setBusy(true);
    setLoadError('');
    try {
      const page = await listItemEvents(workId, itemId, {
        afterSeq: nextAfterSeq,
        limit: FIRST_PAGE_SIZE,
      });
      setEvents((previous) => mergeEventPages(previous, page.events));
      setHasMore(page.hasMore);
      setNextAfterSeq(page.nextAfterSeq);
    } catch (caught) {
      if (onSessionError(caught)) {
        return;
      }
      setLoadError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  function pickAction(action: EventAction): void {
    setPickedType(action.eventType);
    setToHolder('');
    setFormError('');
    setFormRetryable(false);
  }

  /** 转手候选：只来自当前作品、未删除的人物，且排除当前持有人。 */
  const holderCandidates = useMemo(() => {
    if (selected === null || !selected.requiresHolder) {
      return [];
    }
    const currentHolderId = state?.holder?.id ?? null;
    return characters.filter(
      (character) => !(selected.eventType === 'transferred' && character.id === currentHolderId),
    );
  }, [characters, selected, state]);

  async function submitAppend(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || selected === null) {
      return;
    }
    const trimmed = note.trim();
    const trimmedIssue = noteError(trimmed);
    if (trimmedIssue !== null) {
      setFormError(trimmedIssue);
      setFormRetryable(false);
      return;
    }
    if (selected.requiresHolder && toHolder === '') {
      setFormError(`请选择${selected.eventType === 'transferred' ? '转入' : '持有'}的人物`);
      setFormRetryable(false);
      return;
    }

    const payload = {
      eventType: selected.eventType,
      toHolder: selected.requiresHolder ? toHolder : null,
      note: trimmed === '' ? null : trimmed,
    };
    const fingerprint = fingerprintOfEvent(payload);
    const keeper = idempotencyKeyFor(appendDraft.current, fingerprint);
    appendDraft.current = keeper.draft;

    setBusy(true);
    setFormError('');
    setNotice('');
    try {
      const result = await appendItemEvent(workId, itemId, {
        ...payload,
        idempotencyKey: keeper.key,
      });
      // 成功 → 清空幂等键，下一次提交重新生成
      appendDraft.current = null;
      setNotice(
        result.deduplicated
          ? '这次提交此前已生效，已显示原记录（未重复写入）。'
          : `已记录「${eventTypeLabel(selected.eventType)}」。`,
      );
      setPickedType(null);
      setToHolder('');
      setNote('');
      // 顺带收起冲正确认框并清掉冲正备注草稿
      cancelReversal();
      await refresh();
    } catch (caught) {
      if (onSessionError(caught)) {
        return;
      }
      setFormError(messageOf(caught));
      setFormRetryable(isRetryable(caught));
    } finally {
      setBusy(false);
    }
  }

  const reversalTarget =
    reversalTargetId === null
      ? null
      : (events.find((item) => item.id === reversalTargetId) ?? null);

  function startReversal(event: ItemEventView): void {
    setReversalTargetId(event.id);
    setReversalNote('');
    setReversalError('');
    setFormError('');
    reversalDraft.current = null;
  }

  function cancelReversal(): void {
    setReversalTargetId(null);
    setReversalNote('');
    setReversalError('');
    reversalDraft.current = null;
  }

  async function submitReversal(): Promise<void> {
    if (reversalBusy || reversalTarget === null) {
      return;
    }
    const trimmed = reversalNote.trim();
    const trimmedIssue = noteError(trimmed);
    if (trimmedIssue !== null) {
      setReversalError(trimmedIssue);
      return;
    }
    const fingerprint = fingerprintOfReversal({
      eventId: reversalTarget.id,
      note: trimmed === '' ? null : trimmed,
    });
    const keeper = idempotencyKeyFor(reversalDraft.current, fingerprint);
    reversalDraft.current = keeper.draft;

    setReversalBusy(true);
    setReversalError('');
    setNotice('');
    try {
      const result = await reverseItemEvent(workId, itemId, reversalTarget.id, {
        note: trimmed === '' ? null : trimmed,
        idempotencyKey: keeper.key,
      });
      reversalDraft.current = null;
      setNotice(
        result.deduplicated
          ? '这次冲正此前已生效，已显示原记录（未重复写入）。'
          : `已冲正第 ${reversalTarget.seq} 条事件。历史行不变，追加了反向事件。`,
      );
      cancelReversal();
      await refresh();
    } catch (caught) {
      if (onSessionError(caught)) {
        return;
      }
      setReversalError(messageOf(caught));
      setFormRetryable(isRetryable(caught));
    } finally {
      setReversalBusy(false);
    }
  }

  async function refreshAfterError(): Promise<void> {
    setBusy(true);
    setFormError('');
    setReversalError('');
    setLoadError('');
    try {
      await refresh();
      cancelReversal();
    } catch (caught) {
      if (onSessionError(caught)) {
        return;
      }
      setLoadError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  const rows = state === null ? [] : buildTimeline(events, state, { closed });
  const emptyNotice = state === null ? null : emptyTimelineNotice(state, events.length);

  return (
    <ModalShell
      labelledBy="item-events-title"
      panelClassName="modal--wide"
      initialFocusRef={closeRef}
    >
      <div data-testid="item-events-panel" data-item-id={itemId}>
        {/* 关闭入口吸顶：面板很长时，滚到底部也能直接关闭 */}
        <div className="item-panel-header">
          <div className="toolbar">
            <div>
              <h2 id="item-events-title">持有人 / 事件</h2>
              <p className="subtitle" data-testid="item-events-item-name">
                {itemName}
              </p>
            </div>
            <button
              ref={closeRef}
              type="button"
              className="btn-secondary"
              onClick={handleClose}
              data-testid="item-events-close"
            >
              关闭
            </button>
          </div>
        </div>

        {loading ? (
          <p className="hint" role="status" data-testid="item-events-loading">
            正在加载状态与事件…
          </p>
        ) : null}

        {loadError === '' ? null : (
          <div className="alert alert--error" role="alert" data-testid="item-events-load-error">
            <p>{loadError}</p>
            <button
              type="button"
              className="btn-secondary btn-small"
              onClick={() => void refreshAfterError()}
              data-testid="item-events-reload"
            >
              重新加载
            </button>
          </div>
        )}

        {state === null ? null : (
          <>
            <div className="item-panel-summary" data-testid="item-events-summary">
              <dl className="kv">
                <dt>当前状态</dt>
                <dd data-testid="item-state-status">{ITEM_STATUS_LABELS[state.status]}</dd>
                <dt>当前持有人</dt>
                <dd data-testid="item-state-holder">{holderText(state.holder)}</dd>
                <dt>事件总数</dt>
                <dd data-testid="item-state-event-count">{state.eventCount}</dd>
                <dt>有效事件数</dt>
                <dd data-testid="item-state-effective-count">{state.effectiveEventCount}</dd>
                <dt>最后 seq</dt>
                <dd data-testid="item-state-last-seq">{state.lastSeq}</dd>
              </dl>
              <p className="hint" data-testid="item-state-card-summary">
                卡片摘要：{holderSummary(state)}
              </p>
            </div>

            {closed ? (
              <p className="alert alert--warn" role="status" data-testid="item-events-closed">
                物品已删除，不能再追加或冲正事件；历史事件仍可查看。
              </p>
            ) : null}

            {notice === '' ? null : (
              <p className="alert alert--ok" role="status" data-testid="item-events-notice">
                {notice}
              </p>
            )}

            {formError === '' ? null : (
              <div className="alert alert--error" role="alert" data-testid="item-events-error">
                <p>{formError}</p>
                {formRetryable ? (
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={() => void refreshAfterError()}
                    disabled={busy}
                    data-testid="item-events-refresh"
                  >
                    刷新状态后重试
                  </button>
                ) : null}
              </div>
            )}

            <h3>事件时间线</h3>

            {emptyNotice !== null && emptyNotice.kind === 'inconsistent' ? (
              <p className="alert alert--error" role="alert" data-testid="item-events-inconsistent">
                {emptyNotice.message}
              </p>
            ) : null}

            {emptyNotice !== null && emptyNotice.kind === 'never-recorded' ? (
              <p className="hint" data-testid="item-events-empty">
                {emptyNotice.message}
              </p>
            ) : null}

            {rows.length === 0 ? null : (
              <ol className="timeline" data-testid="item-events-list">
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className={`timeline-row timeline-row--${row.tone}`}
                    data-testid="item-event-row"
                    data-reversed={row.reversed ? 'true' : 'false'}
                  >
                    <div className="timeline-head">
                      <span className="timeline-seq" data-testid="item-event-seq">
                        #{row.seq}
                      </span>
                      <span className="badge" data-testid="item-event-type">
                        {row.typeLabel}
                      </span>
                      {row.reversed ? (
                        <span className="badge badge--warn" data-testid="item-event-reversed">
                          已冲正
                        </span>
                      ) : null}
                      <span className="timeline-meta" data-testid="item-event-time">
                        {formatDateTime(row.createdAt)}
                      </span>
                    </div>
                    <p className="timeline-route" data-testid="item-event-route">
                      {row.route}
                    </p>
                    {row.note === null ? null : (
                      <p className="timeline-note" data-testid="item-event-note">
                        备注：{row.note}
                      </p>
                    )}
                    {row.canReverse ? (
                      <div className="row-actions">
                        <button
                          type="button"
                          className="btn-secondary btn-small"
                          onClick={() => {
                            const target = events.find((item) => item.id === row.id);
                            if (target !== undefined) {
                              startReversal(target);
                            }
                          }}
                          disabled={busy || reversalBusy}
                          data-testid="item-event-reverse"
                        >
                          冲正…
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}

            {hasMore ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void loadMore()}
                disabled={busy}
                data-testid="item-events-load-more"
              >
                加载更多事件
              </button>
            ) : null}

            {reversalTarget === null ? null : (
              <div className="card card--inner" data-testid="item-event-reversal-form">
                <h3>确认冲正第 {reversalTarget.seq} 条事件？</h3>
                <p className="hint">
                  冲正不会删除或修改历史行，只会追加一条反向事件。该操作不可再撤销。
                </p>
                <div className="field">
                  <label htmlFor="item-reversal-note">冲正备注（可选）</label>
                  <textarea
                    id="item-reversal-note"
                    rows={2}
                    maxLength={NOTE_MAX_LENGTH}
                    value={reversalNote}
                    onChange={(event) => setReversalNote(event.target.value)}
                    data-testid="item-event-reversal-note"
                  />
                  <span className="hint" data-testid="item-event-reversal-note-count">
                    {reversalNote.length}/{NOTE_MAX_LENGTH}
                  </span>
                </div>
                {reversalError === '' ? null : (
                  <div
                    className="alert alert--error"
                    role="alert"
                    data-testid="item-event-reversal-error"
                  >
                    <p>{reversalError}</p>
                    {formRetryable ? (
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        onClick={() => void refreshAfterError()}
                        disabled={reversalBusy || busy}
                        data-testid="item-event-reversal-refresh"
                      >
                        刷新状态后重试
                      </button>
                    ) : null}
                  </div>
                )}
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => void submitReversal()}
                    disabled={reversalBusy || busy}
                    aria-busy={reversalBusy}
                    data-testid="item-event-reversal-confirm"
                  >
                    {reversalBusy ? '冲正中…' : '确认冲正'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={cancelReversal}
                    disabled={reversalBusy}
                    data-testid="item-event-reversal-cancel"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {closed ? null : (
              <form
                className="card card--inner"
                onSubmit={(event) => void submitAppend(event)}
                noValidate
                data-testid="item-event-form"
              >
                <h3>追加事件</h3>
                <fieldset className="field">
                  <legend>事件类型</legend>
                  <div className="radio-list">
                    {actions.map((action) => (
                      <label key={action.eventType} className="radio-row">
                        <input
                          type="radio"
                          name="item-event-type"
                          value={action.eventType}
                          checked={selected?.eventType === action.eventType}
                          onChange={() => pickAction(action)}
                          disabled={busy}
                          data-testid={`item-event-action-${action.eventType}`}
                        />
                        <span>{action.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                {selected !== null && selected.requiresHolder ? (
                  <div className="field">
                    <label htmlFor="item-event-holder">
                      {selected.eventType === 'transferred' ? '转给（人物）' : '持有人（人物）'}
                    </label>
                    {holderCandidates.length === 0 ? (
                      <p className="hint" data-testid="item-event-holder-empty">
                        {selected.eventType === 'transferred'
                          ? '没有可转手的人物：当前作品的其它人物不存在或已删除。'
                          : '当前作品还没有可选的人物，请先在「人物」分区创建。'}
                      </p>
                    ) : (
                      <select
                        id="item-event-holder"
                        value={toHolder}
                        onChange={(event) => setToHolder(event.target.value)}
                        disabled={busy}
                        data-testid="item-event-holder"
                      >
                        <option value="">请选择人物</option>
                        {holderCandidates.map((character) => (
                          <option key={character.id} value={character.id}>
                            {character.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ) : null}

                <div className="field">
                  <label htmlFor="item-event-note">备注（可选）</label>
                  <textarea
                    id="item-event-note"
                    rows={2}
                    maxLength={NOTE_MAX_LENGTH}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    disabled={busy}
                    data-testid="item-event-note-input"
                  />
                  <span className="hint" data-testid="item-event-note-count">
                    {note.length}/{NOTE_MAX_LENGTH}
                  </span>
                </div>

                <div className="row-actions">
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={
                      busy ||
                      selected === null ||
                      (selected.requiresHolder && holderCandidates.length === 0)
                    }
                    aria-busy={busy}
                    data-testid="item-event-submit"
                  >
                    {busy ? '提交中…' : `记录${selected?.label ?? '事件'}`}
                  </button>
                </div>
                <p className="hint">备注只保存在当前页面内存，不会写入地址栏或浏览器存储。</p>
              </form>
            )}
          </>
        )}
      </div>
    </ModalShell>
  );
}
