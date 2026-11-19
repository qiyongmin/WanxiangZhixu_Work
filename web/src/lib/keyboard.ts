// 全局键盘（设计 6.7）：单一 keydown 监听 + 弹层栈 + 列表导航注册表。
import { useCallback, useEffect, useRef, useState } from 'react';

export const INPUT_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]';
/** Enter 在这些元素上交给浏览器默认行为（避免重复触发）。 */
const NATIVE_ACTIVATION = 'button, a[href], summary, [role="button"], [role="menuitem"], [role="tab"], [role="treeitem"]';

export function isInputTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INPUT_SELECTOR) !== null;
}

export function isComposing(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229;
}

export type ShortcutKey = 'n' | '/' | 'j' | 'k' | 'enter' | 'escape';

/**
 * 把 keydown 归类为快捷键；应忽略的情形返回 null（Req 17.11）：
 * IME 组合输入；N、/、J、K 带 Ctrl/Alt/Meta；N、/、J、K、Enter 位于输入控件内。
 */
export function classifyKey(
  event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode' | 'ctrlKey' | 'altKey' | 'metaKey' | 'target'>,
): ShortcutKey | null {
  if (isComposing(event)) return null;
  const key = event.key;
  if (key === 'Escape') return 'escape';
  const modified = event.ctrlKey || event.altKey || event.metaKey;
  if (key === 'Enter') {
    if (modified || isInputTarget(event.target)) return null;
    if (event.target instanceof Element && event.target.closest(NATIVE_ACTIVATION) !== null) return null;
    return 'enter';
  }
  const lower = key.length === 1 ? key.toLowerCase() : key;
  if (lower !== 'n' && lower !== '/' && lower !== 'j' && lower !== 'k') return null;
  if (modified || isInputTarget(event.target)) return null;
  return lower;
}

// ---- 弹层栈：Esc 每次只关闭最上层 ----
interface Overlay {
  close: () => void;
}
const overlays: Overlay[] = [];

/** 注册一个弹层，返回注销函数。`close` 由 Esc 触发。 */
export function pushOverlay(close: () => void): () => void {
  const entry: Overlay = { close };
  overlays.push(entry);
  return () => {
    const index = overlays.indexOf(entry);
    if (index >= 0) overlays.splice(index, 1);
  };
}

export function hasOverlay(): boolean {
  return overlays.length > 0;
}

/** 关闭最上层弹层；返回是否有弹层被关闭。 */
export function closeTopOverlay(): boolean {
  const top = overlays[overlays.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function resetOverlays(): void {
  overlays.length = 0;
}

// ---- 列表导航 ----
export type Direction = 1 | -1;

/** J/K 的目标：无选中时 J→第一项、K→最后一项；边界不循环；空列表保持 null。 */
export function nextActive(ids: readonly string[], activeId: string | null, direction: Direction): string | null {
  if (ids.length === 0) return null;
  const index = activeId === null ? -1 : ids.indexOf(activeId);
  if (index < 0) return (direction === 1 ? ids[0] : ids[ids.length - 1]) ?? null;
  const target = index + direction;
  if (target < 0 || target >= ids.length) return ids[index] ?? null;
  return ids[target] ?? null;
}

interface ListController {
  move: (direction: Direction) => void;
  open: () => boolean;
}
const lists: ListController[] = [];

function currentList(): ListController | undefined {
  return lists[lists.length - 1];
}

export interface ListNav {
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  /** 展开到列表项元素上的属性。 */
  itemProps: (id: string) => { 'data-nav-id': string; 'data-active'?: 'true'; 'aria-current'?: 'true' };
}

/** 注册一个可用 J/K/Enter 导航的列表；最后挂载的列表生效。 */
export function useListNav(ids: readonly string[], onOpen: (id: string) => void): ListNav {
  const [activeId, setActive] = useState<string | null>(null);
  const idsRef = useRef(ids);
  const activeRef = useRef(activeId);
  const openRef = useRef(onOpen);
  idsRef.current = ids;
  activeRef.current = activeId;
  openRef.current = onOpen;

  // 选中项已不在列表中时清除选中。
  useEffect(() => {
    if (activeId !== null && !ids.includes(activeId)) setActive(null);
  }, [ids, activeId]);

  useEffect(() => {
    const controller: ListController = {
      move: (direction) => {
        const next = nextActive(idsRef.current, activeRef.current, direction);
        if (next !== activeRef.current) {
          activeRef.current = next;
          setActive(next);
        }
      },
      open: () => {
        const active = activeRef.current;
        if (active === null || !idsRef.current.includes(active)) return false;
        openRef.current(active);
        return true;
      },
    };
    lists.push(controller);
    return () => {
      const index = lists.indexOf(controller);
      if (index >= 0) lists.splice(index, 1);
    };
  }, []);

  useEffect(() => {
    if (activeId === null) return;
    const target = Array.from(document.querySelectorAll<HTMLElement>('[data-nav-id]')).find(
      (element) => element.dataset.navId === activeId,
    );
    target?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const itemProps = useCallback(
    (id: string) => (id === activeId ? { 'data-nav-id': id, 'data-active': 'true' as const, 'aria-current': 'true' as const } : { 'data-nav-id': id }),
    [activeId],
  );
  return { activeId, setActiveId: setActive, itemProps };
}

// ---- 全局监听 ----
export interface KeyboardHandlers {
  quickAdd: () => void;
  openPalette: () => void;
}

export function isVisible(element: Element | null): element is HTMLElement {
  if (!element || !element.isConnected) return false;
  if (element.closest('[inert], [hidden]')) return false;
  return (element as HTMLElement).getClientRects().length > 0;
}

/** 安装唯一的 keydown 监听；返回卸载函数。 */
export function installKeyboard(handlers: KeyboardHandlers): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    // Ctrl/⌘+K：任何位置都打开 Command_Palette（IME 组合输入除外）。
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'k' &&
      !isComposing(event)
    ) {
      event.preventDefault();
      handlers.openPalette();
      return;
    }
    const key = classifyKey(event);
    if (key === null) return;
    if (key === 'escape') {
      if (closeTopOverlay()) event.preventDefault();
      return;
    }
    if (hasOverlay()) return;
    switch (key) {
      case 'n':
        event.preventDefault();
        handlers.quickAdd();
        return;
      case '/': {
        const target = Array.from(document.querySelectorAll('[data-search-input]')).find(isVisible);
        if (target) {
          event.preventDefault();
          target.focus();
        }
        return;
      }
      case 'j':
      case 'k': {
        const list = currentList();
        if (!list) return;
        event.preventDefault();
        list.move(key === 'j' ? 1 : -1);
        return;
      }
      case 'enter': {
        const list = currentList();
        if (list?.open()) event.preventDefault();
        return;
      }
    }
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
