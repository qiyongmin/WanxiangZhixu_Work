// 轻量提示（toast）：模块级状态 + useSyncExternalStore；由 <NoticeHost/> 显示。
import { useSyncExternalStore } from 'react';

export interface Notice {
  id: number;
  text: string;
}

let current: readonly Notice[] = [];
let counter = 0;
const listeners = new Set<() => void>();
const NOTICE_MS = 6000;

function emit(): void {
  for (const listener of Array.from(listeners)) listener();
}

export function showNotice(text: string): void {
  counter += 1;
  const id = counter;
  current = [...current, { id, text }].slice(-3);
  emit();
  setTimeout(() => dismissNotice(id), NOTICE_MS);
}

export function dismissNotice(id: number): void {
  const next = current.filter((item) => item.id !== id);
  if (next.length === current.length) return;
  current = next;
  emit();
}

export function resetNotices(): void {
  current = [];
  emit();
}

export function useNotices(): readonly Notice[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current,
    () => current,
  );
}
