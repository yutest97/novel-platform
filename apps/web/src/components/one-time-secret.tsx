'use client';

/**
 * 一次性口令弹窗。
 *
 * 设计约束：
 * - **不可关闭**：没有右上角关闭按钮，点击遮罩与 Esc 都不关闭，
 *   只有点击「我已保存」才会关闭（防止口令没记下就丢失）；
 * - 口令只存在于本组件的 props 中，父组件在 onConfirm 后必须清空状态；
 * - 提供复制按钮（Clipboard API 不可用时提示手动复制）。
 */

import { useEffect, useRef, useState } from 'react';

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

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="one-time-secret-title"
        aria-describedby="one-time-secret-notice"
      >
        <h2 id="one-time-secret-title">{title}</h2>
        <p id="one-time-secret-notice" className="hint">
          {notice}
        </p>

        <div className="secret">
          <code data-testid="one-time-secret">{secret}</code>
          <button
            type="button"
            className="btn-secondary btn-small"
            onClick={() => void handleCopy()}
          >
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
      </div>
    </div>
  );
}
