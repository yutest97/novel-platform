'use client';

/**
 * 作品设定中心（M2-B2-B / M2-B3-B2）。
 *
 * 分区（顺序来自 `entityGroups.order`，**不硬编码**）：
 * - 作品方向（field_schema.workDirection）；
 * - 境界体系 / 势力 / 人物 / 物品 / 功法（field_schema.entityTypes）。
 *
 * 约束：
 * - 只允许作品所有者访问（服务端与客户端双重校验）；
 * - 字段标签、顺序、类型、枚举选项、引用目标**全部来自规则包**；
 * - 引用候选只来自"当前作品 + 未删除 + 类型匹配"（服务端过滤，见 GET /entities）；
 * - 编辑中的实体会从候选里排除（禁止自引用）；
 * - 秘密等设定值只存在于组件内存：不写 URL、localStorage、sessionStorage 或日志；
 * - 不提供地点、关系图或 AI 生成入口；
 * - 物品**没有持有人字段**：持有人以 item_events 流水为唯一真相，
 *   item 卡片上的「持有人 / 事件」入口打开时间线面板（B3-B2）。
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { EntitySection } from '@/components/settings/entity-section';
import { ItemEventsPanel } from '@/components/settings/item-events-panel';
import { ItemHolderEntry } from '@/components/settings/item-holder-entry';
import {
  fetchEntities,
  fetchSettingsCenter,
  getItemState,
  messageOf,
  updateDirection,
  type EntityItem,
  type FieldDefinition,
  type ItemStateView,
  type SettingsCenter,
} from '@/lib/api';
import { attributeToText } from '@/lib/entity-form';
import { handleSessionError } from '@/lib/session-errors';
import { useRequireSession } from '@/lib/use-session';

export default function WorkSettingsPage(): React.ReactElement {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { state, refreshSession } = useRequireSession({ role: 'author' });

  const workId = params.id;

  const [center, setCenter] = useState<SettingsCenter | null>(null);
  const [candidates, setCandidates] = useState<ReadonlyMap<string, readonly EntityItem[]>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  /** itemId → 派生状态（卡片入口摘要 + 面板刷新）。 */
  const [itemStates, setItemStates] = useState<ReadonlyMap<string, ItemStateView>>(new Map());
  /** 当前打开事件面板的物品；null 表示未打开。 */
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  /** `?item=<id>` 只处理一次，避免每次 reload 都把面板重新弹出来。 */
  const deepLinkHandled = useRef(false);

  // 作品方向表单
  const [direction, setDirection] = useState<Record<string, string>>({});
  const [directionBusy, setDirectionBusy] = useState(false);
  const [directionError, setDirectionError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchSettingsCenter(workId);
      setCenter(data);
      setDirection(
        Object.fromEntries(
          Object.entries(data.direction).map(([key, value]) => [key, attributeToText(value)]),
        ),
      );
      setLoadError('');
      void refreshSession();

      // 引用候选：按 schema 里声明过的 refType 逐个取（只含本作品、未删除、类型匹配）。
      // 单个类型取失败（例如规则包声明了本轮未开放的类型）不应影响整页可用性。
      const refTypes = new Set<string>();
      for (const entry of data.schema.entityTypes) {
        for (const field of entry.group.fields) {
          if (field.refType !== undefined) {
            refTypes.add(field.refType);
          }
        }
      }
      // 物品事件表单需要人物候选，即使某版规则包里没有任何字段引用 character。
      refTypes.add('character');
      const loaded = await Promise.all(
        [...refTypes].map(async (entityType): Promise<readonly [string, EntityItem[]]> => {
          try {
            return [entityType, await fetchEntities(workId, entityType)];
          } catch {
            return [entityType, []];
          }
        }),
      );
      setCandidates(new Map(loaded));

      // 物品卡片上的持有人摘要：逐个读派生状态（只读接口，失败不影响页面其它分区）。
      const itemGroup = data.entityGroups.find((group) => group.entityType === 'item');
      const entries = await Promise.all(
        (itemGroup?.entities ?? []).map(
          async (item): Promise<readonly [string, ItemStateView] | null> => {
            try {
              return [item.id, await getItemState(workId, item.id)] as const;
            } catch {
              return null;
            }
          },
        ),
      );
      const states = new Map<string, ItemStateView>();
      for (const entry of entries) {
        if (entry !== null) {
          states.set(entry[0], entry[1]);
        }
      }
      setItemStates(states);
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setLoadError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, [workId, refreshSession, router]);

  useEffect(() => {
    if (state.status === 'ready') {
      void load();
    }
  }, [state.status, load]);

  // 深链：`/works/:id/settings?item=<itemId>` 直接打开事件面板。
  // 只处理一次（关闭后不会因为重新加载而再次弹出）；URL 里只允许出现物品 id，
  // 备注草稿永远不进地址栏。
  useEffect(() => {
    if (center === null || deepLinkHandled.current) {
      return;
    }
    const requested = new URLSearchParams(window.location.search).get('item');
    if (requested === null || requested === '') {
      return;
    }
    deepLinkHandled.current = true;
    setOpenItemId(requested);
  }, [center]);

  /** 面板里的状态变化即时回写到卡片入口摘要。 */
  const handleItemStateChange = useCallback((next: ItemStateView): void => {
    setItemStates((previous) => {
      const map = new Map(previous);
      map.set(next.itemId, next);
      return map;
    });
  }, []);

  const stableSessionError = useCallback(
    (error: unknown) => handleSessionError(error, router),
    [router],
  );

  function closeItemPanel(): void {
    setOpenItemId(null);
    if (typeof window === 'undefined') {
      return;
    }
    const url = new URL(window.location.href);
    if (url.searchParams.has('item')) {
      url.searchParams.delete('item');
      window.history.replaceState(null, '', url.toString());
    }
  }

  const directionFields: readonly FieldDefinition[] = center?.schema.workDirection?.fields ?? [];
  const schemaGroups = center?.schema.entityTypes ?? [];
  const sections = center?.entityGroups ?? [];
  /** entityType → 中文标题（分区与引用摘要共用）。 */
  const refTitles = new Map(schemaGroups.map((entry) => [entry.key, entry.group.title]));

  function fieldsOf(entityType: string): readonly FieldDefinition[] {
    return schemaGroups.find((entry) => entry.key === entityType)?.group.fields ?? [];
  }

  /** 面板打开的物品；不在存活列表里（已软删 / 深链失效）时为 null。 */
  const openItemEntity =
    openItemId === null
      ? null
      : (sections
          .find((group) => group.entityType === 'item')
          ?.entities.find((entity) => entity.id === openItemId) ?? null);

  async function handleSaveDirection(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (directionBusy) {
      return;
    }
    setDirectionBusy(true);
    setDirectionError('');
    setNotice('');

    try {
      // 整组同步：请求体给出的是这组方向的**完整期望状态**。
      // - 有值的字段 → 服务端 upsert；
      // - 可选字段被清空（提交 null）→ 服务端删除对应的 work_settings 行。
      const payload: Record<string, unknown> = {};
      for (const field of directionFields) {
        const text = direction[field.key] ?? '';
        if (text.trim() === '') {
          if (field.required) {
            throw new Error(`请填写「${field.label}」`);
          }
          payload[field.key] = null;
          continue;
        }
        payload[field.key] = field.type === 'integer' ? Number.parseInt(text, 10) : text.trim();
      }
      await updateDirection(workId, payload);
      setNotice('作品方向已保存。');
      await load();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setDirectionError(caught instanceof Error ? caught.message : messageOf(caught));
    } finally {
      setDirectionBusy(false);
    }
  }

  if (state.status === 'loading') {
    return (
      <main className="page">
        <p className="hint" role="status">
          正在加载…
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="toolbar">
        <div>
          <Link href={`/works/${workId}`} className="back-link" data-testid="back-to-work">
            ← 返回作品
          </Link>
          <h1>设定中心</h1>
          <p className="subtitle">{center?.workTitle ?? ''}</p>
        </div>
      </div>

      {loading ? (
        <p className="hint" role="status">
          正在加载设定…
        </p>
      ) : null}

      {loadError === '' ? null : (
        <div className="card">
          <p className="alert alert--error" role="alert" data-testid="settings-load-error">
            {loadError}
          </p>
          <p className="hint">作品不存在，或不属于当前账号。</p>
        </div>
      )}

      {notice === '' ? null : (
        <p className="alert alert--ok" role="status" data-testid="settings-notice">
          {notice}
        </p>
      )}

      <div className="card">
        <h2>作品方向</h2>
        {directionFields.length === 0 ? (
          <p className="hint">当前题材没有定义作品方向字段。</p>
        ) : (
          <form onSubmit={(event) => void handleSaveDirection(event)} noValidate>
            {directionFields.map((field) => (
              <div className="field" key={field.key}>
                <label htmlFor={`direction-${field.key}`}>
                  {field.label}
                  {field.required ? '（必填）' : ''}
                </label>
                {field.type === 'text' ? (
                  <textarea
                    id={`direction-${field.key}`}
                    rows={3}
                    maxLength={field.maxLength}
                    value={direction[field.key] ?? ''}
                    onChange={(event) =>
                      setDirection((previous) => ({
                        ...previous,
                        [field.key]: event.target.value,
                      }))
                    }
                    data-testid={`direction-${field.key}`}
                  />
                ) : (
                  <input
                    id={`direction-${field.key}`}
                    type={field.type === 'integer' ? 'number' : 'text'}
                    maxLength={field.maxLength}
                    min={field.min}
                    max={field.max}
                    value={direction[field.key] ?? ''}
                    onChange={(event) =>
                      setDirection((previous) => ({
                        ...previous,
                        [field.key]: event.target.value,
                      }))
                    }
                    data-testid={`direction-${field.key}`}
                  />
                )}
                {field.help === undefined ? null : <span className="hint">{field.help}</span>}
              </div>
            ))}

            {directionError === '' ? null : (
              <p className="alert alert--error" role="alert" data-testid="direction-error">
                {directionError}
              </p>
            )}

            <button
              type="submit"
              className="btn-primary"
              disabled={directionBusy}
              aria-busy={directionBusy}
              data-testid="direction-save"
            >
              {directionBusy ? '保存中…' : '保存作品方向'}
            </button>
          </form>
        )}
      </div>

      {sections.map((group) => {
        // 只有物品分区有「持有人 / 事件」入口：EntitySection 本身不感知实体类型。
        const extra =
          group.entityType === 'item'
            ? (entity: EntityItem): React.ReactNode => (
                <ItemHolderEntry
                  state={itemStates.get(entity.id) ?? null}
                  loading={loading}
                  onOpen={() => setOpenItemId(entity.id)}
                />
              )
            : undefined;

        return (
          <EntitySection
            key={group.entityType}
            workId={workId}
            group={group}
            fields={fieldsOf(group.entityType)}
            refTitles={refTitles}
            candidatesByType={candidates}
            onReload={load}
            onNotice={setNotice}
            onSessionError={stableSessionError}
            {...(extra === undefined ? {} : { renderExtraActions: extra })}
          />
        );
      })}

      {openItemId === null ? null : (
        <ItemEventsPanel
          key={openItemId}
          workId={workId}
          itemId={openItemId}
          fallbackName={openItemEntity?.name ?? '物品'}
          characters={candidates.get('character') ?? []}
          // 深链打开的物品若已不在存活列表里（已软删除），历史只读。
          closed={openItemEntity === null}
          onClose={closeItemPanel}
          onStateChange={handleItemStateChange}
          onSessionError={stableSessionError}
        />
      )}

      <div className="card">
        <h2>本阶段范围</h2>
        <p>
          设定中心当前包含作品方向、境界体系、势力、人物、物品与功法； 物品卡片上的「持有人 /
          事件」可查看事件时间线，并登记获得、转手、消耗、丢失或冲正。
        </p>
        <p className="hint">
          资源流水、地点、关系图与章节创作留待后续阶段；本阶段不提供 AI 生成入口。
        </p>
      </div>
    </main>
  );
}
