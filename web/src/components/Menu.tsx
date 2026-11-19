import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { pushOverlay } from '../lib/keyboard';
import { Icon, type IconName } from './icons';

export interface MenuEntry {
  key: string;
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** If set, expose selected state for radio-style choice menus. */
  checked?: boolean;
}

interface Props {
  /** Accessible name and tooltip of the trigger button. */
  label: string;
  icon: IconName;
  items: readonly MenuEntry[];
  /** Menu edge aligned with the trigger: `end` opens towards the left. */
  align?: 'start' | 'end';
  className?: string;
  /** Extra content rendered next to the icon (for example a visible text label). */
  children?: ReactNode;
  /** Name for the menu itself; defaults to the trigger label. */
  menuLabel?: string;
  /** Optional DOM id for the trigger button (lets callers restore focus to it). */
  triggerId?: string;
  disabled?: boolean;
}

/** Icon-only button that opens a small menu (WAI-ARIA menu button: arrows, Home/End, Esc restores focus). */
export function IconMenu({ label, icon, items, align = 'start', className, children, menuLabel, triggerId, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const uid = useId();

  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)')?.focus();
    const release = pushOverlay(() => {
      setOpen(false);
      trigger.current?.focus();
    });
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => {
      release();
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)'));
    if (nodes.length === 0) return;
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % nodes.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + nodes.length) % nodes.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = nodes.length - 1;
    else if (event.key === 'Escape') {
      // Close this menu without falling through to unrelated global overlays.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    } else if (event.key === 'Tab') setOpen(false);
    if (next >= 0) {
      event.preventDefault();
      nodes[next]?.focus();
    }
  };

  return (
    <span className={className ? `menu-wrap ${className}` : 'menu-wrap'}>
      <button
        type="button"
        ref={trigger}
        id={triggerId}
        disabled={disabled}
        className="btn btn-icon"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${uid}-menu` : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={icon} />
        {children}
      </button>
      {open ? (
        <ul
          id={`${uid}-menu`}
          role="menu"
          className={align === 'end' ? 'menu menu-end' : 'menu'}
          aria-label={menuLabel ?? label}
          ref={menu}
          onKeyDown={onKeyDown}
        >
          {items.map((item) => (
            <li role="none" key={item.key}>
              <button
                type="button"
                role={typeof item.checked === 'boolean' ? 'menuitemradio' : 'menuitem'}
                aria-checked={typeof item.checked === 'boolean' ? item.checked : undefined}
                className={item.danger ? 'menu-item is-danger' : 'menu-item'}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  item.onSelect();
                }}
              >
                {item.icon ? <Icon name={item.icon} /> : null}
                <span>{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
