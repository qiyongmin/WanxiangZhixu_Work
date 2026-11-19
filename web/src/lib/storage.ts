// localStorage 统一校验回退（设计 6.11）：任何读取失败都不抛出、不弹阻断错误；
// 写入遇到 QuotaExceededError / SecurityError 静默降级为内存状态。
import type { Theme } from './types';

export const PREFIX = 'kbw:v1:';

export const KEYS = {
  theme: 'theme',
  visualStyle: 'visual-style',
  uiLayout: 'ui-layout',
  layout: 'layout',
  treeExpanded: 'tree-expanded',
  tasksView: 'tasks-view',
  mytasksFilters: 'mytasks-filters',
  cockpitView: 'cockpit-view',
  notify: 'notify',
  notified: 'notified',
} as const;

/** 校验器：返回清洗后的值；返回 `undefined` 表示非法（读取方使用 fallback）。 */
export type Validator<T> = (value: unknown) => T | undefined;

const memory = new Map<string, unknown>();

export function resetMemoryStorage(): void {
  memory.clear();
}

function fullKey(key: string): string {
  return PREFIX + key;
}

export function readJson<T>(key: string, validate: Validator<T>, fallback: T): T {
  const name = fullKey(key);
  try {
    let raw: string | null = null;
    let readable = true;
    try {
      raw = window.localStorage.getItem(name);
    } catch {
      readable = false;
    }
    if (raw === null || !readable) {
      if (memory.has(name)) {
        const cleaned = validate(memory.get(name));
        return cleaned === undefined ? fallback : cleaned;
      }
      return fallback;
    }
    const cleaned = validate(JSON.parse(raw));
    return cleaned === undefined ? fallback : cleaned;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): boolean {
  const name = fullKey(key);
  try {
    window.localStorage.setItem(name, JSON.stringify(value));
    memory.delete(name);
    return true;
  } catch {
    // QuotaExceededError / SecurityError / 序列化失败：仅在本次会话内存中保留。
    memory.set(name, value);
    return false;
  }
}

export function removeKey(key: string): void {
  memory.delete(fullKey(key));
  try {
    window.localStorage.removeItem(fullKey(key));
  } catch {
    /* 忽略 */
  }
}

// ---- 具体键的校验器 ----
export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

export const validateTheme: Validator<Theme> = (value) =>
  typeof value === 'string' && (THEMES as readonly string[]).includes(value) ? (value as Theme) : undefined;

export interface LayoutState {
  leftOpen: boolean;
  inspectorOpen: boolean;
}

export const validateLayout: Validator<LayoutState> = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.leftOpen !== 'boolean' || typeof record.inspectorOpen !== 'boolean') return undefined;
  return { leftOpen: record.leftOpen, inspectorOpen: record.inspectorOpen };
};

export const validateStringArray: Validator<string[]> = (value) => {
  if (!Array.isArray(value)) return undefined;
  // 清洗：丢弃非字符串元素，去重。
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item !== '')));
};

// ---- Phase 2 的键 ----
export interface TasksViewState {
  view: 'list' | 'kanban';
  directOnly: boolean;
}
export const DEFAULT_TASKS_VIEW: TasksViewState = { view: 'list', directOnly: false };
export const validateTasksView: Validator<TasksViewState> = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if ((record.view !== 'list' && record.view !== 'kanban') || typeof record.directOnly !== 'boolean') return undefined;
  return { view: record.view, directOnly: record.directOnly };
};

export const COCKPIT_VIEWS = ['overview', 'board', 'week'] as const;
export type CockpitViewId = (typeof COCKPIT_VIEWS)[number];
export const validateCockpitView: Validator<CockpitViewId> = (value) =>
  typeof value === 'string' && (COCKPIT_VIEWS as readonly string[]).includes(value) ? (value as CockpitViewId) : undefined;

export interface NotifyState {
  introAccepted: boolean;
}
export const validateNotify: Validator<NotifyState> = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.introAccepted === 'boolean' ? { introAccepted: record.introAccepted } : undefined;
};

/** `{[taskId]: remindAt}`：只保留字符串值。 */
export const validateNotified: Validator<Record<string, string>> = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof at === 'string') out[id] = at;
  }
  return out;
};
