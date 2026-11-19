// 自写极小路由（设计 6.3）：状态完全来自 URL（History API）。
// useSyncExternalStore 订阅 popstate 与自定义 kbw:navigate 事件。
import { useSyncExternalStore } from 'react';
import { TABS, type TabId } from './types';
import { guardNavigation } from './draftGuard';

export const BASE = '/app';
export const NAVIGATE_EVENT = 'kbw:navigate';

export type Route =
  | { name: 'cockpit' }
  | { name: 'search' }
  | { name: 'agent' }
  | { name: 'agent-access' }
  | { name: 'resources'; tab: 'skills' | 'prompts' | 'mcp' | 'agents' | 'discover' | 'studio' | 'deployments' | 'activity'; id?: string }
  | { name: 'proposals' }
  | { name: 'files' }
  | { name: 'settings' }
  | { name: 'settings-sections' }
  | { name: 'settings-about' }
  | { name: 'my-tasks' }
  | { name: 'tag'; tag: string }
  | { name: 'node'; id: string; tab: TabId; focus: string | null }
  | { name: 'not-found'; path: string };

/** 去掉 /app 前缀后的应用内路径（含查询串），始终以 / 开头。 */
export function stripBase(pathname: string): string {
  if (pathname === BASE) return '/';
  if (pathname.startsWith(BASE + '/')) return pathname.slice(BASE.length);
  return pathname || '/';
}

export function withBase(path: string): string {
  return BASE + (path.startsWith('/') ? path : '/' + path);
}

export function isTab(value: string | undefined): value is TabId {
  return value !== undefined && (TABS as readonly string[]).includes(value);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** 解析应用内路径（不含 /app 前缀）。非法 Tab 按概览处理，规范化由 canonicalPath 完成。 */
export function parseRoute(path: string): Route {
  const [pathname = '/', query = ''] = path.split('?', 2);
  const segments = pathname.split('/').filter(Boolean).map(safeDecode);
  const head = segments[0];
  if (head === undefined) return { name: 'cockpit' };
  if (head === 'resources') {
    const supported = ['skills','prompts','mcp','agents','discover', 'studio', 'deployments', 'activity'];
    if (['skills','prompts','mcp','agents'].includes(segments[1] || '') && segments.length === 3
        && segments[2] && /^[0-9a-f]{32}$/.test(segments[2])) {
      return { name:'resources', tab:segments[1] as 'skills'|'prompts'|'mcp'|'agents', id:segments[2] };
    }
    if (segments.length === 1 || (segments.length === 2 && segments[1] === 'reviews')) {
      return { name: 'resources', tab: 'skills' }; // Original library and Reviews bookmarks remain compatible.
    }
    if (segments.length === 2 && segments[1] && supported.includes(segments[1])) {
      return { name: 'resources', tab: segments[1] as 'skills' | 'prompts' | 'mcp' | 'agents' | 'discover' | 'studio' | 'deployments' | 'activity' };
    }
    if (segments.length === 2 && segments[1] && /^[0-9a-f]{32}$/.test(segments[1])) {
      return { name: 'resources', tab: 'skills', id: segments[1] };
    }
    return { name: 'not-found', path };
  }
  if (head === 'n' && segments[1]) {
    const tab = isTab(segments[2]) ? segments[2] : 'overview';
    const focus = new URLSearchParams(query).get('focus');
    return { name: 'node', id: segments[1], tab, focus: tab === 'tasks' || tab === 'overview' ? focus : null };
  }
  if (segments.length === 1) {
    if (head === 'search') return { name: 'search' };
    if (head === 'agent') return { name: 'agent' };
    if (head === 'files') return { name: 'files' };
    if (head === 'proposals') return { name: 'proposals' };
    if (head === 'settings') return { name: 'settings' };
    if (head === 'my-tasks') return { name: 'my-tasks' };
  }
  if (segments.length === 2 && head === 'tag' && segments[1]) return { name: 'tag', tag: segments[1] };
  if (segments.length === 2 && head === 'agent' && segments[1] === 'access') return { name: 'agent-access' };
  if (segments.length === 2 && head === 'settings' && segments[1] === 'sections') return { name: 'settings-sections' };
  if (segments.length === 2 && head === 'settings' && segments[1] === 'about') return { name: 'settings-about' };
  return { name: 'not-found', path };
}

export function nodePath(id: string, tab: TabId = 'overview', focus?: string | null): string {
  const base = `/n/${encodeURIComponent(id)}/${tab}`;
  return (tab === 'tasks' || tab === 'overview') && focus ? `${base}?focus=${encodeURIComponent(focus)}` : base;
}

/** 规范形式：/n/:id 缺省或非法 Tab → /n/:id/overview；其余路径原样返回。 */
export function canonicalPath(path: string): string {
  // Old Agent Activity and Resource Activity bookmarks now open Agent Access' log.
  if (path === '/agent' || path.startsWith('/agent?')) return '/agent/access?tab=activities';
  if (path === '/resources/activity' || path.startsWith('/resources/activity?')) return '/agent/access?tab=activities';
  // Legacy Reviews links now open the inline approval filter in Library.
  if (path === '/resources/reviews') return '/resources/skills?status=pending';
  // Former My Tasks bookmarks now open the same cross-Section Cockpit Board.
  // Keep the saved filter values, history navigation and other routes intact.
  if (path === '/my-tasks' || path.startsWith('/my-tasks?')) {
    return '/?view=board';
  }
  const route = parseRoute(path);
  if (route.name !== 'node') return path;
  // Valid deep links (including ?preview=, ?note=) retain their exact query.
  const [pathname = ''] = path.split('?', 1);
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 3 && isTab(segments[2])) return path;
  const query = path.includes('?') ? path.slice(path.indexOf('?')) : '';
  return nodePath(route.id, route.tab) + query;
}

// ---- 浏览器绑定 ----
const INDEX_KEY = '__kbwFocusIndex';
let navIndex = typeof window !== 'undefined' && typeof window.history.state?.[INDEX_KEY] === 'number'
  ? window.history.state[INDEX_KEY] as number : 0;
let lastAccepted = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/app/';
// Browser popstate is dispatched AFTER the address bar changes. While a dirty
// editor's navigation is being reverted asynchronously, hold React on the
// previously accepted location so it never unmounts the still-unsaved editor.
let heldPath: string | null = null;
function indexedState(value: number) {
  const prior = window.history.state;
  return { ...(prior && typeof prior === 'object' ? prior : {}), [INDEX_KEY]: value };
}
/** Capture popstate before subscribers so guarded Back/Forward never unmount a dirty editor. */
export function installHistoryGuard(): () => void {
  navIndex = typeof window.history.state?.[INDEX_KEY] === 'number' ? window.history.state[INDEX_KEY] : navIndex;
  lastAccepted = window.location.pathname + window.location.search;
  heldPath = null;
  window.history.replaceState(indexedState(navIndex), '', lastAccepted);
  let bypass = false;
  const pop = (event: PopStateEvent) => {
    const target = window.location.pathname + window.location.search;
    const targetIndex = typeof event.state?.[INDEX_KEY] === 'number' ? event.state[INDEX_KEY] as number : null;
    if (bypass) {
      bypass = false;
      heldPath = null;
      if (targetIndex !== null) navIndex = targetIndex;
      lastAccepted = target;
      return;
    }
    const delta = targetIndex === null ? null : targetIndex - navIndex;
    if (delta !== null && delta !== 0 && guardNavigation(target, lastAccepted, () => {
      bypass = true;
      window.history.go(delta);
    })) {
      heldPath = lastAccepted;
      bypass = true;
      window.history.go(-delta); // Restore the original history entry while the dialog is visible.
      return;
    }
    if (delta === null && guardNavigation(target, lastAccepted, () => {
      window.history.replaceState(indexedState(navIndex), '', target);
      lastAccepted = target;
      window.dispatchEvent(new Event(NAVIGATE_EVENT));
    })) {
      window.history.pushState(indexedState(navIndex), '', lastAccepted);
      window.dispatchEvent(new Event(NAVIGATE_EVENT));
      return;
    }
    heldPath = null;
    if (targetIndex !== null) navIndex = targetIndex;
    lastAccepted = target;
  };
  window.addEventListener('popstate', pop, true);
  return () => window.removeEventListener('popstate', pop, true);
}
function currentAppPath(): string {
  const accepted = heldPath;
  return accepted === null ? stripBase(window.location.pathname) + window.location.search
    : stripBase(accepted);
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = withBase(path);
  const current = window.location.pathname + window.location.search;
  const commit = () => {
    if (target === current) {
      if (options.replace) window.history.replaceState(indexedState(navIndex), '', target);
    } else if (options.replace) {
      window.history.replaceState(indexedState(navIndex), '', target);
    } else {
      navIndex++;
      window.history.pushState(indexedState(navIndex), '', target);
    }
    lastAccepted = target;
    window.dispatchEvent(new Event(NAVIGATE_EVENT));
  };
  if (target !== current && guardNavigation(target, current, commit)) return;
  commit();
}

/** 若当前地址不是规范形式，用 replaceState 更正（不新增历史）。返回是否更正过。 */
export function ensureCanonical(): boolean {
  const now = currentAppPath();
  const canonical = canonicalPath(now);
  if (canonical === now) return false;
  navigate(canonical, { replace: true });
  return true;
}

/** 当前应用内路径（含查询串）。 */
export function useAppPath(): string {
  return useSyncExternalStore(subscribe, currentAppPath, () => '/');
}

export function useRoute(): Route {
  return parseRoute(useAppPath());
}

/** 普通左键点击走 navigate；Ctrl/Meta/Shift/Alt、中键、target 等保留浏览器默认行为。 */
export function shouldIntercept(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}, target?: string): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (target === undefined || target === '' || target === '_self')
  );
}
