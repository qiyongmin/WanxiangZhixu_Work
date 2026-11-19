/**
 * Visual-only skin; intentionally independent from light/dark/system mode,
 * layout, route state, Draft Guard and all server/domain data.
 * No saved choice means the previously deployed Work UI, pixel-for-pixel.
 */
import { useSyncExternalStore } from 'react';
import { KEYS, readJson, writeJson } from './storage';

export const VISUAL_STYLES = ['default', 'mountains', 'starship', 'aurora'] as const;
export type VisualStyle = (typeof VISUAL_STYLES)[number];

export const STYLE_INFO: Record<VisualStyle, { name: string; description: string }> = {
  default: { name: '当前默认', description: '保留现有万象知序 Work 界面' },
  mountains: { name: '山海自然', description: '青绿远山 · 温润留白' },
  starship: { name: '星舰探索', description: '深空远航 · 星际光影' },
  aurora: { name: '极光柔彩', description: '紫蓝极光 · 轻盈柔和' },
};

export function validateVisualStyle(value: unknown): VisualStyle | undefined {
  return typeof value === 'string' && (VISUAL_STYLES as readonly string[]).includes(value)
    ? value as VisualStyle : undefined;
}

let current: VisualStyle | null = null;
const listeners = new Set<() => void>();

export function readVisualStyle(): VisualStyle {
  return readJson(KEYS.visualStyle, validateVisualStyle, 'default');
}

function apply(style: VisualStyle): void {
  document.documentElement.setAttribute('data-visual-style', style);
}

export function getVisualStyle(): VisualStyle {
  if (current === null) current = readVisualStyle();
  return current;
}

export function setVisualStyle(value: VisualStyle): void {
  current = validateVisualStyle(value) ?? 'default';
  writeJson(KEYS.visualStyle, current);
  apply(current);
  listeners.forEach((listener) => listener());
}

/** Called once at app boot. Works even if localStorage is denied. */
export function initVisualStyle(): () => void {
  current = readVisualStyle();
  apply(current);
  const syncTabs = (event: StorageEvent) => {
    if (event.key !== 'kbw:v1:visual-style') return;
    current = readVisualStyle();
    apply(current);
    listeners.forEach((listener) => listener());
  };
  window.addEventListener('storage', syncTabs);
  return () => window.removeEventListener('storage', syncTabs);
}

export function resetVisualStyleState(): void {
  current = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Hook exposes just the visual choice, not a new UI/content component tree. */
export function useVisualStyle(): [VisualStyle, (style: VisualStyle) => void] {
  const style = useSyncExternalStore(subscribe, getVisualStyle, () => 'default' as VisualStyle);
  return [style, setVisualStyle];
}
