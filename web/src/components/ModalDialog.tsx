import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isVisible, pushOverlay } from '../lib/keyboard';

/** Restores focus after closing; focuses <main> when the opener is no longer visible (Req 35.9). */
export function restoreFocus(opener: HTMLElement | null): void {
  if (opener && isVisible(opener)) {
    opener.focus();
    return;
  }
  document.getElementById('main')?.focus();
}

interface Props {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** Render into <body>: needed when the dialog is opened from inside a <form> (it contains its own <form>). */
  portal?: boolean;
}

/**
 * 原生 `<dialog>.showModal()`：自带焦点圈定、背景 inert 与 Esc；挂载即打开，卸载即关闭。
 * Esc 由弹层栈统一处理（每次只关闭最上层）；`cancel` 事件也走同一条路径。
 * 带 `data-autofocus` 的元素在打开后获得焦点。
 */
export function ModalDialog({ label, onClose, children, className, portal = false }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const release = pushOverlay(() => closeRef.current());
    return () => {
      release();
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      restoreFocus(opener);
    };
  }, []);

  const dialog = (
    <dialog
      ref={ref}
      className={className ? `modal ${className}` : 'modal'}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
    >
      {children}
    </dialog>
  );
  return portal ? createPortal(dialog, document.body) : dialog;
}
