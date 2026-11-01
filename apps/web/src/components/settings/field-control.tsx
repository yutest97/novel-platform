'use client';

/**
 * 由规则包 schema 驱动的字段控件（M2-B2-B）。
 *
 * 映射关系（**不硬编码任何玄幻字段**）：
 * - `string`     → 单行文本
 * - `text`       → 多行文本
 * - `integer`    → number
 * - `enum`       → select（显示 label、提交 value）
 * - `entityRef`  → 单选候选（候选来自 GET /entities?type=refType）
 * - `entityRefs` → 有序多选：选择后「添加」进已选列表，可逐项移除
 *
 * `entityRefs` 没有用 `<select multiple>`：多选控件的 `selectedOptions`
 * 是 DOM 顺序而不是用户点选顺序，无法满足"提交顺序 = 选择顺序"。
 */

import { useState } from 'react';

import type { EntityItem, FieldDefinition } from '@/lib/api';
import { refsLimit } from '@/lib/entity-form';

export interface FieldControlProps {
  readonly field: FieldDefinition;
  /** 供 `<label htmlFor>` 使用。 */
  readonly idPrefix: string;
  /** 控件自身的 data-testid（引用多选时作为前缀）。 */
  readonly testId: string;
  readonly value: string | string[];
  /** 该字段 refType 对应的候选实体（已按类型过滤；自身已由调用方排除）。 */
  readonly candidates: readonly EntityItem[];
  /** refType 的中文标题，用于空态提示。 */
  readonly refTitle: string;
  readonly disabled: boolean;
  readonly onChange: (next: string | string[]) => void;
}

export function FieldControl({
  field,
  idPrefix,
  testId,
  value,
  candidates,
  refTitle,
  disabled,
  onChange,
}: FieldControlProps): React.ReactElement {
  const label = field.required ? `${field.label}（必填）` : field.label;
  const help = field.help === undefined ? null : <span className="hint">{field.help}</span>;

  if (field.type === 'text') {
    return (
      <div className="field">
        <label htmlFor={idPrefix}>{label}</label>
        <textarea
          id={idPrefix}
          rows={3}
          maxLength={field.maxLength}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          data-testid={testId}
        />
        {help}
      </div>
    );
  }

  if (field.type === 'enum') {
    const options = field.options ?? [];
    return (
      <div className="field">
        <label htmlFor={idPrefix}>{label}</label>
        <select
          id={idPrefix}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          data-testid={testId}
        >
          <option value="">{field.required ? '请选择' : '（不设置）'}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {help}
      </div>
    );
  }

  if (field.type === 'entityRef') {
    return (
      <div className="field">
        <label htmlFor={idPrefix}>{label}</label>
        {candidates.length === 0 ? (
          <>
            <p className="hint" data-testid={`${testId}-empty`}>
              还没有可选的{refTitle}，请先在「{refTitle}」分区创建。
            </p>
            <select id={idPrefix} value="" disabled data-testid={testId}>
              <option value="">（暂无可选项）</option>
            </select>
          </>
        ) : (
          <select
            id={idPrefix}
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            data-testid={testId}
          >
            <option value="">（不设置）</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        )}
        {help}
      </div>
    );
  }

  if (field.type === 'entityRefs') {
    return (
      <ChoiceList
        field={field}
        idPrefix={idPrefix}
        testId={testId}
        value={Array.isArray(value) ? value : []}
        candidates={candidates}
        refTitle={refTitle}
        disabled={disabled}
        onChange={onChange}
        label={label}
        help={help}
      />
    );
  }

  return (
    <div className="field">
      <label htmlFor={idPrefix}>{label}</label>
      <input
        id={idPrefix}
        type={field.type === 'integer' ? 'number' : 'text'}
        maxLength={field.maxLength}
        min={field.min}
        max={field.max}
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      />
      {help}
    </div>
  );
}

interface ChoiceListProps {
  readonly field: FieldDefinition;
  readonly idPrefix: string;
  readonly testId: string;
  readonly value: readonly string[];
  readonly candidates: readonly EntityItem[];
  readonly refTitle: string;
  readonly disabled: boolean;
  readonly onChange: (next: string[]) => void;
  readonly label: string;
  readonly help: React.ReactNode;
}

/** entityRefs 的有序多选：选择 → 添加 → 可逐项移除。 */
function ChoiceList({
  field,
  idPrefix,
  testId,
  value,
  candidates,
  refTitle,
  disabled,
  onChange,
  label,
  help,
}: ChoiceListProps): React.ReactElement {
  const [pending, setPending] = useState('');
  const limit = refsLimit(field);
  const nameById = new Map(candidates.map((candidate) => [candidate.id, candidate.name]));
  const available = candidates.filter((candidate) => !value.includes(candidate.id));
  const reachedLimit = value.length >= limit;

  if (candidates.length === 0) {
    return (
      <div className="field">
        <label htmlFor={idPrefix}>{label}</label>
        <p className="hint" data-testid={`${testId}-empty`}>
          还没有可选的{refTitle}，请先在「{refTitle}」分区创建。
        </p>
        {help}
      </div>
    );
  }

  return (
    <div className="field">
      <label htmlFor={idPrefix}>{label}</label>
      <div className="refs-picker">
        <select
          id={idPrefix}
          value={pending}
          disabled={disabled || reachedLimit || available.length === 0}
          onChange={(event) => setPending(event.target.value)}
          data-testid={`${testId}-select`}
        >
          <option value="">{available.length === 0 ? '（已全部选择）' : `选择${refTitle}`}</option>
          {available.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-secondary btn-small"
          disabled={disabled || pending === '' || reachedLimit}
          onClick={() => {
            if (pending === '' || value.includes(pending)) {
              return;
            }
            onChange([...value, pending]);
            setPending('');
          }}
          data-testid={`${testId}-add`}
        >
          添加
        </button>
      </div>

      {value.length === 0 ? (
        <p className="hint" data-testid={`${testId}-none`}>
          尚未选择（最多 {limit} 项）。
        </p>
      ) : (
        <ol className="refs-selected" data-testid={`${testId}-selected`}>
          {value.map((id, index) => (
            <li key={id} data-testid={`${testId}-selected-item`}>
              <span>
                {index + 1}. {nameById.get(id) ?? '（引用已失效）'}
              </span>
              <button
                type="button"
                className="btn-secondary btn-small"
                disabled={disabled}
                onClick={() => onChange(value.filter((item) => item !== id))}
                data-testid={`${testId}-remove-${index}`}
                aria-label={`移除第 ${index + 1} 项`}
              >
                移除
              </button>
            </li>
          ))}
        </ol>
      )}
      {help}
    </div>
  );
}
