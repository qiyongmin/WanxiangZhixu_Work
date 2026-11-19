// 刻意保持很小的查询缓存（设计 6.4）：Map + 订阅；同一 key 的并发请求去重；
// invalidate(prefix) 使缓存过期并重取当前挂载的 key；窗口聚焦时重取过期的挂载 key。
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error';

export interface Entry<T = unknown> {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly status: QueryStatus;
  readonly updatedAt: number;
  readonly stale: boolean;
}

export type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

const EMPTY: Entry = { data: undefined, error: undefined, status: 'idle', updatedAt: 0, stale: true };

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const fetchers = new Map<string, Fetcher<unknown>>();
const observers = new Map<string, number>();
const listeners = new Set<() => void>();

export const DEFAULT_STALE_MS = 30_000;

function emit(): void {
  for (const listener of Array.from(listeners)) listener();
}

function put(key: string, entry: Entry): void {
  entries.set(key, entry);
  emit();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getEntry<T>(key: string): Entry<T> {
  return (entries.get(key) ?? EMPTY) as Entry<T>;
}

/** 立即请求（或复用进行中的请求）。失败时保留旧数据并记录错误，不抛出。 */
export function fetchQuery<T>(key: string, fetcher: Fetcher<T>): Promise<void> {
  fetchers.set(key, fetcher as Fetcher<unknown>);
  const running = inflight.get(key);
  if (running) return running;
  const previous = getEntry<T>(key);
  put(key, { ...previous, status: 'loading', error: undefined });
  const controller = new AbortController();
  const job = (async () => {
    try {
      const data = await fetcher(controller.signal);
      put(key, { data, error: undefined, status: 'success', updatedAt: Date.now(), stale: false });
    } catch (error) {
      const latest = getEntry<T>(key);
      put(key, { data: latest.data, error, status: 'error', updatedAt: latest.updatedAt, stale: true });
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

/** 乐观更新 / 以写入响应直接更新缓存。 */
export function setData<T>(key: string, updater: T | ((current: T | undefined) => T)): void {
  const previous = getEntry<T>(key);
  const data = typeof updater === 'function' ? (updater as (current: T | undefined) => T)(previous.data) : updater;
  put(key, { data, error: undefined, status: 'success', updatedAt: Date.now(), stale: false });
}

/** 使所有以 prefix 开头的缓存过期，并立即重取其中当前挂载的 key。 */
export function invalidate(prefix: string): void {
  for (const [key, entry] of Array.from(entries)) {
    if (!key.startsWith(prefix)) continue;
    entries.set(key, { ...entry, stale: true });
    if ((observers.get(key) ?? 0) > 0) {
      const fetcher = fetchers.get(key);
      if (fetcher) void fetchQuery(key, fetcher);
    }
  }
  emit();
}

export function resetCache(): void {
  entries.clear();
  inflight.clear();
  fetchers.clear();
  observers.clear();
  emit();
}

function isFresh(entry: Entry, staleMs: number): boolean {
  return entry.status === 'success' && !entry.stale && Date.now() - entry.updatedAt < staleMs;
}

function refetchStaleMounted(): void {
  for (const [key, count] of observers) {
    if (count <= 0) continue;
    const fetcher = fetchers.get(key);
    const entry = getEntry(key);
    if (fetcher && entry.status !== 'loading' && !isFresh(entry, DEFAULT_STALE_MS)) void fetchQuery(key, fetcher);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', refetchStaleMounted);
}

export interface QueryOptions {
  staleMs?: number;
  enabled?: boolean;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: unknown;
  status: QueryStatus;
  isFetching: boolean;
  refetch: () => Promise<void>;
}

export function useQuery<T>(key: string, fetcher: Fetcher<T>, options: QueryOptions = {}): QueryResult<T> {
  const { staleMs = DEFAULT_STALE_MS, enabled = true } = options;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const entry = useSyncExternalStore(
    subscribe,
    () => getEntry<T>(key),
    () => getEntry<T>(key),
  );
  const run: Fetcher<T> = useCallback((signal) => fetcherRef.current(signal), []);

  useEffect(() => {
    if (!enabled) return undefined;
    observers.set(key, (observers.get(key) ?? 0) + 1);
    fetchers.set(key, run as Fetcher<unknown>);
    if (!isFresh(getEntry(key), staleMs)) void fetchQuery(key, run);
    return () => {
      observers.set(key, Math.max(0, (observers.get(key) ?? 1) - 1));
    };
  }, [key, enabled, staleMs, run]);

  return {
    data: entry.data,
    error: entry.error,
    status: entry.status,
    isFetching: entry.status === 'loading',
    refetch: () => fetchQuery(key, run),
  };
}
