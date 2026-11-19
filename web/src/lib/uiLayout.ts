/**
 * KB_Work V4.0 optional UI Layout. Pure presentation: no route or editor remount.
 * Missing, malformed or unsupported preferences always retain the current Classic UI.
 * Independent of Visual Style, light/dark Theme, pane and domain state.
 */
import { useSyncExternalStore } from 'react';
import { KEYS, PREFIX, readJson, writeJson } from './storage';

export const UI_LAYOUTS = ['classic', 'precision'] as const;
export type UiLayout = (typeof UI_LAYOUTS)[number];

export const UI_LAYOUT_INFO: Record<UiLayout, { name: string; description: string }> = {
  classic: { name: '当前默认 (Classic)', description: '完整保留原有 KB_Work 界面与操作方式' },
  precision: { name: 'Precision Workspace', description: '统一对齐、紧凑任务和舒适阅读空间' },
};

export function validateUiLayout(value: unknown): UiLayout | undefined {
  return typeof value === 'string' && (UI_LAYOUTS as readonly string[]).includes(value)
    ? value as UiLayout : undefined;
}

let current: UiLayout | null = null;
const listeners = new Set<() => void>();

export function readUiLayout(): UiLayout {
  return readJson(KEYS.uiLayout, validateUiLayout, 'classic');
}

function apply(layout: UiLayout): void {
  // Missing attribute is the Classic CSS baseline. No new CSS selector matches it.
  if (layout === 'precision') document.documentElement.setAttribute('data-ui-layout', 'precision');
  else document.documentElement.removeAttribute('data-ui-layout');
}

export function getUiLayout(): UiLayout {
  if (current === null) current = readUiLayout();
  return current;
}

export function setUiLayout(value: UiLayout): void {
  current = validateUiLayout(value) ?? 'classic';
  writeJson(KEYS.uiLayout, current);
  apply(current);
  for (const listener of Array.from(listeners)) listener();
}

export function initUiLayout(): () => void {
  current = readUiLayout();
  apply(current);
  const sync = (event: StorageEvent) => {
    if (event.key !== PREFIX + KEYS.uiLayout) return;
    current = readUiLayout();
    apply(current);
    for (const listener of Array.from(listeners)) listener();
  };
  window.addEventListener('storage', sync);
  return () => window.removeEventListener('storage', sync);
}

export function resetUiLayoutState(): void {
  current = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useUiLayout(): [UiLayout, (layout: UiLayout) => void] {
  const value = useSyncExternalStore(subscribe, getUiLayout, () => 'classic' as UiLayout);
  return [value, setUiLayout];
}
