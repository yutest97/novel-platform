'use client';

/**
 * 一次性口令弹窗。
 *
 * 设计约束（M1-B3 / REV-01）：
 * - **不可关闭**：没有关闭按钮，Esc 与遮罩点击都不关闭，
 *   只有「我已保存」才会关闭（防止口令没记下就丢失）；
 * - 键盘焦点被限制在弹窗内（ModalShell 负责 inert + Tab 循环），
 *   关闭后焦点回到触发按钮；
 * - 口令只存在于 props 中，父组件在 onConfirm 后必须清空状态；
 * - 提供复制按钮（Clipboard API 不可用时提示手动复制）。
 */

import { useRef, useState } from 'react';

import { ModalShell } from './modal-shell';

export interface OneTimeSecretProps {
  readonly title: string;
  readonly secret: string;
  readonly notice: string;
  readonly onConfirm: () => void;
}

export function OneTimeSecret({
  title,
  secret,
  notice,
  onConfirm,
}: OneTimeSecretProps): React.ReactElement {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const confirmRef = useRef<HTMLButtonElement>(null);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }

  return (
    <ModalShell labelledBy="one-time-secret-title" initialFocusRef={confirmRef}>
      <h2 id="one-time-secret-title">{title}</h2>
      <p id="one-time-secret-notice" className="hint">
        {notice}
      </p>

      <div className="secret">
        <code data-testid="one-time-secret">{secret}</code>
        <button type="button" className="btn-secondary btn-small" onClick={() => void handleCopy()}>
          复制
        </button>
      </div>
      <p className="hint" role="status" aria-live="polite">
        {copied === 'ok' ? '已复制到剪贴板' : ''}
        {copied === 'fail' ? '复制失败，请手动选中上方口令复制' : ''}
      </p>

      <button ref={confirmRef} type="button" className="btn-primary" onClick={onConfirm}>
        我已保存
      </button>
    </ModalShell>
  );
}
