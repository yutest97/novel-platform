'use client';

/**
 * 通用确认对话框（用于停用账号等破坏性操作）。
 *
 * REV-01：焦点限制在弹窗内、关闭后回到触发按钮；保留「取消」按钮。
 */

import { useRef } from 'react';

import { ModalShell } from './modal-shell';

export interface ConfirmDialogProps {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // 焦点默认落在「取消」上，避免误触破坏性操作。
  return (
    <ModalShell labelledBy="confirm-title" initialFocusRef={cancelRef}>
      <h2 id="confirm-title">{title}</h2>
      <p>{message}</p>
      <div className="row-actions" style={{ justifyContent: 'flex-end', marginTop: '1.25rem' }}>
        <button
          ref={cancelRef}
          type="button"
          className="btn-secondary"
          onClick={onCancel}
          disabled={busy}
        >
          取消
        </button>
        <button
          type="button"
          className={danger ? 'btn-danger' : 'btn-secondary'}
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? '处理中…' : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
