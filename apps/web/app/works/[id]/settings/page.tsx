'use client';

/**
 * 作品设定中心（M2-B1）。
 *
 * 两块内容：
 * - 作品方向：字段的标签、帮助文本、顺序**全部来自 xuanhuan 规则包的 schema**；
 * - 境界体系（realm_level）：支持新增、编辑、软删除、上下移动。
 *
 * 约束：
 * - 只允许作品所有者访问（服务端与客户端双重校验）；
 * - 不提供人物、势力、功法、物品、章节或 AI 生成入口；
 * - 一次性输入只存在于组件内存，不写 URL / 存储 / 日志。
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  createEntity,
  deleteEntity,
  fetchSettingsCenter,
  messageOf,
  reorderEntities,
  updateDirection,
  updateEntity,
  type EntityItem,
  type FieldDefinition,
  type SettingsCenter,
} from '@/lib/api';
import { handleSessionError } from '@/lib/session-errors';
import { useRequireSession } from '@/lib/use-session';

const REALM_TYPE = 'realm_level';

/** 把属性值转成表单可用的字符串。 */
function attributeToText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

export default function WorkSettingsPage(): React.ReactElement {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { state, refreshSession } = useRequireSession({ role: 'author' });

  const workId = params.id;

  const [center, setCenter] = useState<SettingsCenter | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // 作品方向表单
  const [direction, setDirection] = useState<Record<string, string>>({});
  const [directionBusy, setDirectionBusy] = useState(false);
  const [directionError, setDirectionError] = useState('');
  const [notice, setNotice] = useState('');

  // 境界体系
  const [realmError, setRealmError] = useState('');
  const [realmBusy, setRealmBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftAttrs, setDraftAttrs] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAttrs, setNewAttrs] = useState<Record<string, string>>({});

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

  const directionFields: readonly FieldDefinition[] = center?.schema.workDirection?.fields ?? [];
  const realmFields: readonly FieldDefinition[] =
    center?.schema.entityTypes.find((item) => item.key === REALM_TYPE)?.group.fields ?? [];

  async function handleSaveDirection(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (directionBusy) {
      return;
    }
    setDirectionBusy(true);
    setDirectionError('');
    setNotice('');

    try {
      const payload: Record<string, unknown> = {};
      for (const field of directionFields) {
        const text = direction[field.key] ?? '';
        if (text.trim() === '') {
          if (field.required) {
            throw new Error(`请填写「${field.label}」`);
          }
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

  async function handleCreateRealm(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (realmBusy) {
      return;
    }
    setRealmBusy(true);
    setRealmError('');
    setNotice('');

    try {
      const attributes: Record<string, unknown> = {};
      for (const field of realmFields) {
        const text = newAttrs[field.key] ?? '';
        if (text.trim() === '') {
          if (field.required) {
            throw new Error(`请填写「${field.label}」`);
          }
          continue;
        }
        attributes[field.key] = field.type === 'integer' ? Number.parseInt(text, 10) : text.trim();
      }

      await createEntity(workId, {
        entityType: REALM_TYPE,
        name: newName.trim(),
        attributes,
      });
      setNewName('');
      setNewAttrs({});
      setCreating(false);
      setNotice('境界已新增。');
      await load();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setRealmError(caught instanceof Error ? caught.message : messageOf(caught));
    } finally {
      setRealmBusy(false);
    }
  }

  function startEdit(realm: EntityItem): void {
    setEditingId(realm.id);
    setDraftName(realm.name);
    setDraftAttrs(
      Object.fromEntries(
        realmFields.map((field) => [field.key, attributeToText(realm.attributes[field.key])]),
      ),
    );
    setRealmError('');
  }

  async function handleSaveRealm(entityId: string): Promise<void> {
    if (realmBusy) {
      return;
    }
    setRealmBusy(true);
    setRealmError('');

    try {
      const attributes: Record<string, unknown> = {};
      for (const field of realmFields) {
        const text = draftAttrs[field.key] ?? '';
        if (text.trim() === '') {
          if (field.required) {
            throw new Error(`请填写「${field.label}」`);
          }
          continue;
        }
        attributes[field.key] = field.type === 'integer' ? Number.parseInt(text, 10) : text.trim();
      }

      await updateEntity(workId, entityId, { name: draftName.trim(), attributes });
      setEditingId(null);
      setNotice('境界已更新。');
      await load();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setRealmError(caught instanceof Error ? caught.message : messageOf(caught));
    } finally {
      setRealmBusy(false);
    }
  }

  async function handleDeleteRealm(realm: EntityItem): Promise<void> {
    if (realmBusy) {
      return;
    }
    setRealmBusy(true);
    setRealmError('');
    setNotice('');

    try {
      await deleteEntity(workId, realm.id);
      setNotice(`已删除「${realm.name}」。`);
      await load();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setRealmError(messageOf(caught));
    } finally {
      setRealmBusy(false);
    }
  }

  async function handleMove(realm: EntityItem, offset: number): Promise<void> {
    if (realmBusy || center === null) {
      return;
    }
    const realms = [...center.realms];
    const index = realms.findIndex((item) => item.id === realm.id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= realms.length) {
      return;
    }
    realms.splice(target, 0, realms.splice(index, 1)[0] as EntityItem);

    setRealmBusy(true);
    setRealmError('');
    try {
      await reorderEntities(
        workId,
        REALM_TYPE,
        realms.map((item) => item.id),
      );
      await load();
    } catch (caught) {
      if (handleSessionError(caught, router)) {
        return;
      }
      setRealmError(messageOf(caught));
    } finally {
      setRealmBusy(false);
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

      <div className="card">
        <h2>境界体系</h2>
        <p className="hint" data-testid="realm-count">
          当前共 {center?.realms.length ?? 0} 个境界。
        </p>

        {realmError === '' ? null : (
          <p className="alert alert--error" role="alert" data-testid="realm-error">
            {realmError}
          </p>
        )}

        {center === null || center.realms.length === 0 ? (
          <p className="hint" data-testid="realm-empty">
            还没有设置任何境界。
          </p>
        ) : (
          <ul className="realm-list" data-testid="realm-list">
            {center.realms.map((realm, index) => (
              <li key={realm.id} className="realm-item" data-testid="realm-item">
                {editingId === realm.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleSaveRealm(realm.id);
                    }}
                    noValidate
                  >
                    <div className="field">
                      <label htmlFor={`realm-name-${realm.id}`}>境界名称</label>
                      <input
                        id={`realm-name-${realm.id}`}
                        type="text"
                        required
                        maxLength={60}
                        value={draftName}
                        onChange={(event) => setDraftName(event.target.value)}
                        data-testid="realm-edit-name"
                      />
                    </div>
                    {realmFields.map((field) => (
                      <div className="field" key={field.key}>
                        <label htmlFor={`realm-${realm.id}-${field.key}`}>{field.label}</label>
                        <input
                          id={`realm-${realm.id}-${field.key}`}
                          type={field.type === 'integer' ? 'number' : 'text'}
                          maxLength={field.maxLength}
                          min={field.min}
                          max={field.max}
                          value={draftAttrs[field.key] ?? ''}
                          onChange={(event) =>
                            setDraftAttrs((previous) => ({
                              ...previous,
                              [field.key]: event.target.value,
                            }))
                          }
                          data-testid={`realm-edit-${field.key}`}
                        />
                      </div>
                    ))}
                    <div className="row-actions">
                      <button
                        type="submit"
                        className="btn-primary"
                        disabled={realmBusy}
                        data-testid="realm-edit-save"
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setEditingId(null)}
                        data-testid="realm-edit-cancel"
                      >
                        取消
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <h3 data-testid="realm-name">{realm.name}</h3>
                    <dl className="kv">
                      <dt>小境界数</dt>
                      <dd data-testid="realm-minor-levels">
                        {attributeToText(realm.attributes['minorLevelCount'])}
                      </dd>
                      <dt>突破条件</dt>
                      <dd data-testid="realm-breakthrough">
                        {attributeToText(realm.attributes['breakthroughCondition'])}
                      </dd>
                      <dt>寿命</dt>
                      <dd data-testid="realm-lifespan">
                        {attributeToText(realm.attributes['lifespan'])}
                      </dd>
                      <dt>战力基准</dt>
                      <dd data-testid="realm-power">
                        {attributeToText(realm.attributes['powerBaseline'])}
                      </dd>
                    </dl>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        onClick={() => startEdit(realm)}
                        data-testid="realm-edit"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        onClick={() => void handleDeleteRealm(realm)}
                        disabled={realmBusy}
                        data-testid="realm-delete"
                      >
                        删除
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        onClick={() => void handleMove(realm, -1)}
                        disabled={realmBusy || index === 0}
                        data-testid="realm-move-up"
                      >
                        上移
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        onClick={() => void handleMove(realm, 1)}
                        disabled={realmBusy || index === center.realms.length - 1}
                        data-testid="realm-move-down"
                      >
                        下移
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {creating ? (
          <form
            onSubmit={(event) => void handleCreateRealm(event)}
            noValidate
            data-testid="realm-create-form"
          >
            <div className="field">
              <label htmlFor="new-realm-name">境界名称</label>
              <input
                id="new-realm-name"
                type="text"
                required
                maxLength={60}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                data-testid="realm-new-name"
              />
            </div>
            {realmFields.map((field) => (
              <div className="field" key={field.key}>
                <label htmlFor={`new-realm-${field.key}`}>
                  {field.label}
                  {field.required ? '（必填）' : ''}
                </label>
                <input
                  id={`new-realm-${field.key}`}
                  type={field.type === 'integer' ? 'number' : 'text'}
                  maxLength={field.maxLength}
                  min={field.min}
                  max={field.max}
                  value={newAttrs[field.key] ?? ''}
                  onChange={(event) =>
                    setNewAttrs((previous) => ({ ...previous, [field.key]: event.target.value }))
                  }
                  data-testid={`realm-new-${field.key}`}
                />
                {field.help === undefined ? null : <span className="hint">{field.help}</span>}
              </div>
            ))}
            <div className="row-actions">
              <button
                type="submit"
                className="btn-primary"
                disabled={realmBusy}
                data-testid="realm-create-submit"
              >
                新增境界
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setCreating(false)}
                data-testid="realm-create-cancel"
              >
                取消
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setCreating(true);
              setRealmError('');
            }}
            data-testid="realm-create-open"
          >
            新增境界
          </button>
        )}
      </div>

      <div className="card">
        <h2>后续阶段</h2>
        <p>人物、势力、功法、物品与章节创作将在后续阶段开放。</p>
        <p className="hint">本阶段不提供 AI 生成入口。</p>
      </div>
    </main>
  );
}
