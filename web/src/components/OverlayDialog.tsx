import { useRef, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/** KBW accessible modal: Radix handles focus trap, Escape and background inertness.
 * Keep the original .work-modal-* DOM/CSS contract so Quick Access and Inspector
 * overlays remain visually identical across themes and responsive layouts.
 */
export function OverlayDialog({ title, onClose, children, className = '' }: Props) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialFocus = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement : null,
  );
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onCloseRef.current(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="work-modal-backdrop">
          <Dialog.Content
            className={'work-modal-panel ' + className}
            aria-describedby={undefined}
            aria-modal="true"
            onCloseAutoFocus={event => {
              event.preventDefault();
              initialFocus.current?.focus();
            }}
          >
            <header className="work-modal-header">
              <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
              <button type="button" className="btn" aria-label={'Close ' + title}
                onClick={() => onCloseRef.current()}>Close</button>
            </header>
            <div className="work-modal-body">{children}</div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
