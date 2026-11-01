'use client';

/**
 * 一个实体分区（境界体系 / 势力 / 人物）—— M2-B2-B。
 *
 * 同一份组件服务所有实体类型：标题、字段、候选类型、顺序**全部来自规则包**，
 * 分区之间只有 entityType 不同，没有任何类型专属分支。
 *
 * 交互：
 * - 新增 / 编辑 / 软删除 / 上移下移；
 * - 删除被拒（ENTITY_IN_USE）时展示服务端返回的**安全引用摘要**
 *   （总引用数 + 最多 20 个引用者的类型与名称，不含属性值 / 秘密 / 正文）；
 * - 编辑时把自身从引用候选里排除（禁止自引用）。
 */

import { Fragment, useState } from 'react';

import {
  ApiError,
  createEntity,
  deleteEntity,
  messageOf,
  reorderEntities,
  updateEntity,
  type EntityGroupItem,
  type EntityItem,
  type EntityReferenceSummary,
  type FieldDefinition,
} from '@/lib/api';
import {
  buildAttributes,
  formatAttributeValue,
  formStateOf,
  nameMapOf,
  sectionKey,
  type FormState,
} from '@/lib/entity-form';

import { FieldControl } from './field-control';

/** 分区内的错误：既可展示文案，也可携带删除保护的引用摘要。 */
interface SectionError {
  readonly message: string;
  readonly references?: EntityReferenceSummary;
}

export interface EntitySectionProps {
  readonly workId: string;
  readonly group: EntityGroupItem;
  readonly fields: readonly FieldDefinition[];
  /** entityType → 中文标题（引用空态与引用摘要展示用）。 */
  readonly refTitles: ReadonlyMap<string, string>;
  /** entityType → 该类型的候选实体（服务端已按作品 + 未删除过滤）。 */
  readonly candidatesByType: ReadonlyMap<string, readonly EntityItem[]>;
  readonly onReload: () => Promise<void>;
  readonly onNotice: (message: string) => void;
  /** 会话类错误统一处理；返回 true 表示已处理（通常已跳转）。 */
  readonly onSessionError: (error: unknown) => boolean;
}

/** 从异常里取出可展示文案与引用摘要。 */
function describeError(error: unknown): SectionError {
  const references = error instanceof ApiError ? error.references : undefined;
  const message =
    error instanceof ApiError
      ? messageOf(error)
      : error instanceof Error
        ? error.message
        : messageOf(error);
  return references === undefined ? { message } : { message, references };
}

export function EntitySection({
  workId,
  group,
  fields,
  refTitles,
  candidatesByType,
  onReload,
  onNotice,
  onSessionError,
}: EntitySectionProps): React.ReactElement {
  const key = sectionKey(group.entityType);
  const entities = group.entities;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SectionError | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [form, setForm] = useState<FormState>({});

  /** 统一串行化：同一次交互里的 busy / 错误处理只写一遍。 */
  async function run(task: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (caught) {
      if (onSessionError(caught)) {
        return;
      }
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  function openCreate(): void {
    setCreating(true);
    setEditingId(null);
    setDraftName('');
    setForm(formStateOf(fields));
    setError(null);
  }

  function openEdit(entity: EntityItem): void {
    setCreating(false);
    setEditingId(entity.id);
    setDraftName(entity.name);
    setForm(formStateOf(fields, entity.attributes));
    setError(null);
  }

  function closeForms(): void {
    setCreating(false);
    setEditingId(null);
    setDraftName('');
    setForm({});
  }

  async function submitCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await run(async () => {
      const name = draftName.trim();
      if (name === '') {
        throw new Error('请填写名称');
      }
      const attributes = buildAttributes(fields, form);
      await createEntity(workId, { entityType: group.entityType, name, attributes });
      closeForms();
      onNotice(`已新增${group.title}。`);
      await onReload();
    });
  }

  async function submitEdit(entity: EntityItem): Promise<void> {
    await run(async () => {
      const name = draftName.trim();
      if (name === '') {
        throw new Error('请填写名称');
      }
      const attributes = buildAttributes(fields, form);
      await updateEntity(workId, entity.id, { name, attributes });
      closeForms();
      onNotice(`${group.title}已更新。`);
      await onReload();
    });
  }

  async function remove(entity: EntityItem): Promise<void> {
    await run(async () => {
      await deleteEntity(workId, entity.id);
      onNotice(`已删除「${entity.name}」。`);
      await onReload();
    });
  }

  async function move(entity: EntityItem, offset: number): Promise<void> {
    await run(async () => {
      const ordered = [...entities];
      const index = ordered.findIndex((item) => item.id === entity.id);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= ordered.length) {
        return;
      }
      ordered.splice(target, 0, ordered.splice(index, 1)[0] as EntityItem);
      await reorderEntities(
        workId,
        group.entityType,
        ordered.map((item) => item.id),
      );
      await onReload();
    });
  }

  /** 该字段的候选（编辑时排除自身，禁止自引用）。 */
  function candidatesFor(field: FieldDefinition, selfId: string | null): readonly EntityItem[] {
    const pool = field.refType === undefined ? [] : (candidatesByType.get(field.refType) ?? []);
    return selfId === null ? pool : pool.filter((item) => item.id !== selfId);
  }

  function refTitleOf(field: FieldDefinition): string {
    if (field.refType === undefined) {
      return '实体';
    }
    return refTitles.get(field.refType) ?? field.refType;
  }

  function updateField(fieldKey: string, next: string | string[]): void {
    setForm((previous) => ({ ...previous, [fieldKey]: next }));
  }

  /** 展示某条实体的字段值（enum 显示 label、引用显示名称）。 */
  function valueText(field: FieldDefinition, entity: EntityItem): string {
    const names =
      field.refType === undefined
        ? new Map<string, string>()
        : nameMapOf(candidatesByType.get(field.refType) ?? []);
    return formatAttributeValue(field, entity.attributes[field.key], names);
  }

  function renderFields(
    selfId: string | null,
    idPrefix: string,
    testIdPrefix: string,
  ): React.ReactElement {
    return (
      <>
        {fields.map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            idPrefix={`${idPrefix}-${field.key}`}
            testId={`${testIdPrefix}-${field.key}`}
            value={form[field.key] ?? (field.type === 'entityRefs' ? [] : '')}
            candidates={candidatesFor(field, selfId)}
            refTitle={refTitleOf(field)}
            disabled={busy}
            onChange={(next) => updateField(field.key, next)}
          />
        ))}
      </>
    );
  }

  return (
    <section className="card" data-testid={`${key}-section`} data-entity-type={group.entityType}>
      <h2>{group.title}</h2>
      <p className="hint" data-testid={`${key}-count`}>
        {group.title}：当前共 {entities.length} 个。
      </p>

      {error === null ? null : (
        <div className="alert alert--error" role="alert" data-testid={`${key}-error`}>
          <p>{error.message}</p>
          {error.references === undefined ? null : (
            <div data-testid={`${key}-references`}>
              <p>共 {error.references.total} 个实体引用了它，请先在这些实体中解除引用：</p>
              <ul className="reference-list">
                {error.references.items.slice(0, 20).map((item) => (
                  <li key={item.id} data-testid={`${key}-reference-item`}>
                    {refTitles.get(item.entityType) ?? item.entityType} · {item.name}
                  </li>
                ))}
              </ul>
              {error.references.total > error.references.items.slice(0, 20).length ? (
                <p className="hint">
                  另有 {error.references.total - error.references.items.slice(0, 20).length}{' '}
                  个引用者未显示。
                </p>
              ) : null}
            </div>
          )}
        </div>
      )}

      {entities.length === 0 ? (
        <p className="hint" data-testid={`${key}-empty`}>
          这个分区还没有内容，点下面的「新增{group.title}」开始添加。
        </p>
      ) : (
        <ul className="entity-list" data-testid={`${key}-list`}>
          {entities.map((entity, index) => (
            <li key={entity.id} className="entity-item" data-testid={`${key}-item`}>
              {editingId === entity.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitEdit(entity);
                  }}
                  noValidate
                >
                  <div className="field">
                    <label htmlFor={`${key}-edit-name-${entity.id}`}>名称</label>
                    <input
                      id={`${key}-edit-name-${entity.id}`}
                      type="text"
                      required
                      maxLength={60}
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      data-testid={`${key}-edit-name`}
                    />
                  </div>
                  {renderFields(entity.id, `${key}-edit-${entity.id}`, `${key}-edit`)}
                  <div className="row-actions">
                    <button
                      type="submit"
                      className="btn-primary"
                      disabled={busy}
                      data-testid={`${key}-edit-save`}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={closeForms}
                      data-testid={`${key}-edit-cancel`}
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <h3 data-testid={`${key}-name`}>{entity.name}</h3>
                  <dl className="kv">
                    {fields.map((field) => (
                      <Fragment key={field.key}>
                        <dt>{field.label}</dt>
                        <dd data-testid={`${key}-attr-${field.key}`}>{valueText(field, entity)}</dd>
                      </Fragment>
                    ))}
                  </dl>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      onClick={() => openEdit(entity)}
                      disabled={busy}
                      data-testid={`${key}-edit`}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      onClick={() => void remove(entity)}
                      disabled={busy}
                      data-testid={`${key}-delete`}
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      onClick={() => void move(entity, -1)}
                      disabled={busy || index === 0}
                      data-testid={`${key}-move-up`}
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      onClick={() => void move(entity, 1)}
                      disabled={busy || index === entities.length - 1}
                      data-testid={`${key}-move-down`}
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
          onSubmit={(event) => void submitCreate(event)}
          noValidate
          data-testid={`${key}-create-form`}
        >
          <div className="field">
            <label htmlFor={`${key}-new-name`}>名称</label>
            <input
              id={`${key}-new-name`}
              type="text"
              required
              maxLength={60}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              data-testid={`${key}-new-name`}
            />
          </div>
          {renderFields(null, `${key}-new`, `${key}-new`)}
          <div className="row-actions">
            <button
              type="submit"
              className="btn-primary"
              disabled={busy}
              data-testid={`${key}-create-submit`}
            >
              新增{group.title}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={closeForms}
              data-testid={`${key}-create-cancel`}
            >
              取消
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="btn-secondary"
          onClick={openCreate}
          data-testid={`${key}-create-open`}
        >
          新增{group.title}
        </button>
      )}
    </section>
  );
}
