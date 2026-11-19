// Node_Detail 的数据层：查询 key、写入后的缓存更新、通用分页 hook。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbort } from './api';
import { invalidate, setData } from './queryCache';
import { refreshReminders } from './reminders';
import type { NodeDTO } from './types';

export const keys = {
  node: (id: string) => `node:${id}`,
};

/** 写入成功后：以响应直接更新节点缓存，并使树、子节点、动态与其它节点视图过期。 */
export function afterWrite(node: NodeDTO): void {
  setData<NodeDTO>(keys.node(node.id), node);
  invalidateTaskData();
}

/** 失效矩阵（设计 6.4）：树徽标、节点、Task 列表、Cockpit、标签、提醒。 */
export function invalidateTaskData(): void {
  invalidate('tree');
  invalidate('node:');
  invalidate('tasks:');
  invalidate('cockpit');
  invalidate('tags');
  invalidate('tag-nodes:');
  invalidate('children:');
  invalidate('activity:');
  void refreshReminders();
}

/** 响应是否是 revision 冲突。 */
export function isConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.code === 'revision_conflict';
}

export interface Page<T, C> {
  items: T[];
  next: C | null;
}

export interface Paged<T> {
  items: T[];
  status: 'loading' | 'ready' | 'error';
  error: unknown;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/**
 * 简单游标分页：deps 变化时从头重新加载；loadMore 追加下一页。
 * load(cursor, signal) 返回本页 items 与下一游标（null 表示结束）。
 */
export function usePaged<T, C>(
  load: (cursor: C | null, signal: AbortSignal) => Promise<Page<T, C>>,
  deps: readonly unknown[],
): Paged<T> {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<C | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const busy = useRef(false);
  const nextRef = useRef<C | null>(null);
  nextRef.current = next;

  useEffect(() => {
    const controller = new AbortController();
    busy.current = false;
    setStatus('loading');
    loadRef
      .current(null, controller.signal)
      .then((page) => {
        setItems(page.items);
        setNext(page.next);
        setError(undefined);
        setStatus('ready');
      })
      .catch((failure: unknown) => {
        if (isAbort(failure)) return;
        setError(failure);
        setStatus('error');
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const loadMore = useCallback(() => {
    const cursor = nextRef.current;
    if (cursor === null || busy.current) return;
    busy.current = true;
    setLoadingMore(true);
    loadRef
      .current(cursor, new AbortController().signal)
      .then((page) => {
        setItems((current) => [...current, ...page.items]);
        setNext(page.next);
        setError(undefined);
        setStatus('ready');
      })
      .catch((failure: unknown) => {
        setError(failure);
        setStatus('error');
      })
      .finally(() => {
        busy.current = false;
        setLoadingMore(false);
      });
  }, []);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { items, status, error, loadingMore, hasMore: next !== null, loadMore, reload };
}
