'use client';

/**
 * 模态弹窗外壳（M1-B3-REV-01）。
 *
 * 职责：
 * - 通过 Portal 渲染到 `document.body`，与页面内容分属不同子树；
 * - 打开时把应用根节点 `#app-root` 设为 `inert`（背景不可聚焦/不可点击）；
 * - Tab / Shift+Tab 只在弹窗内循环；
 * - 关闭后把焦点还给触发元素（打开前的 activeElement）。
 *
 * 刻意**不做**的事：不监听 Escape、不响应遮罩点击 —— 是否可关闭由具体弹窗决定
 * （OneTimeSecret 只能通过「我已保存」关闭，ConfirmDialog 只能通过按钮关闭）。
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (root === null) {
    return [];
  }
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

export interface ModalShellProps {
  readonly labelledBy: string;
  /**
   * 打开后需要聚焦的元素。
   *
   * 焦点必须由本组件在**真正挂载之后**设置：首次渲染时本组件返回 null，
   * 子组件的按钮尚未渲染，其 ref 还是 null；子组件自己的 effect 又先于父组件
   * 执行，同样拿不到节点。因此统一在这里（mounted 之后）聚焦。
   */
  readonly initialFocusRef?: React.RefObject<HTMLElement | null>;
  readonly children: React.ReactNode;
}

export function ModalShell({
  labelledBy,
  initialFocusRef,
  children,
}: ModalShellProps): React.ReactElement | null {
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // 在首次渲染时记录触发元素：子组件的 effect 会先执行并移动焦点，
  // 若等到本组件的 effect 再记录，拿到的会是弹窗内的按钮。
  const restoreRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) {
      return;
    }
    const app = document.getElementById('app-root');
    app?.setAttribute('inert', '');

    // inert 会把焦点从背景元素上移走，因此聚焦目标必须在设置 inert 之后执行。
    initialFocusRef?.current?.focus();

    return () => {
      app?.removeAttribute('inert');
      const target = restoreRef.current;
      if (target !== null && document.contains(target)) {
        target.focus();
      }
    };
  }, [mounted, initialFocusRef]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Tab') {
      return;
    }
    const items = focusableWithin(containerRef.current);
    if (items.length === 0) {
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    const active = document.activeElement;
    const inside = containerRef.current?.contains(active) ?? false;

    if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!mounted) {
    return null;
  }

  return createPortal(
    <div className="modal-backdrop">
      <div
        ref={containerRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
