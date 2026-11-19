// 主题：kbw:v1:theme ∈ {light, dark, system}；非法值/读写失败回退 system（Req 7.4 / 7.12）。
// public/theme-boot.js 在首屏前做同样的事；这里负责运行时切换与「跟随系统」监听。
import { useSyncExternalStore } from 'react';
import { KEYS, readJson, validateTheme, writeJson } from './storage';
import type { Theme } from './types';

type Resolved = 'light' | 'dark';

let current: Theme | null = null;
const listeners = new Set<() => void>();

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function resolveTheme(theme: Theme, prefersDark: boolean = systemPrefersDark()): Resolved {
  if (theme === 'light' || theme === 'dark') return theme;
  return prefersDark ? 'dark' : 'light';
}

export function readTheme(): Theme {
  return readJson<Theme>(KEYS.theme, validateTheme, 'system');
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme-choice', theme);
  root.setAttribute('data-theme', resolveTheme(theme));
}

export function getTheme(): Theme {
  if (current === null) current = readTheme();
  return current;
}

export function setTheme(theme: Theme): void {
  current = validateTheme(theme) ?? 'system';
  writeJson(KEYS.theme, current);
  apply(current);
  for (const listener of Array.from(listeners)) listener();
}

/** 应用启动时调用：应用主题并监听系统设置变化（仅在选择为 system 时生效）。 */
export function initTheme(): () => void {
  current = readTheme();
  apply(current);
  let query: MediaQueryList | null = null;
  try {
    query = window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    query = null;
  }
  const onChange = () => {
    if (getTheme() === 'system') apply('system');
  };
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

/** Theme button cycle: Light → Dark → System → Light. */
export function nextTheme(theme: Theme): Theme {
  return theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
}

export function resetThemeState(): void {
  current = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, getTheme, () => 'system' as Theme);
  return [theme, setTheme];
}
