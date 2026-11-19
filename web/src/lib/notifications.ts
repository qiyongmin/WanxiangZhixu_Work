// 浏览器通知（设计 6.12）：先说明、再请求权限；每次提醒至多一条；拒绝/不支持时降级为应用内提醒。
import { useSyncExternalStore } from 'react';
import { ApiError, get } from './api';
import { showNotice } from './notice';
import { navigate, nodePath } from './router';
import { KEYS, readJson, validateNotified, validateNotify, writeJson } from './storage';
import type { NodeDTO, TaskRow } from './types';

export type NotifyPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export const MAX_NOTIFIED = 200;
export const MAX_TITLE_CHARS = 100;
export const GONE_MESSAGE = 'That Task no longer exists';

const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version += 1;
  for (const listener of Array.from(listeners)) listener();
}

export function permission(): NotifyPermission {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported';
  const value = window.Notification.permission;
  return value === 'granted' || value === 'denied' ? value : 'default';
}

export function introAccepted(): boolean {
  return readJson(KEYS.notify, validateNotify, { introAccepted: false }).introAccepted;
}

/** 订阅权限与「已了解说明」状态；权限在别处变化后可调用 `refreshPermission`。 */
export function useNotifyState(): { permission: NotifyPermission; introAccepted: boolean } {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => version,
    () => version,
  );
  return { permission: permission(), introAccepted: introAccepted() };
}

export function refreshPermission(): void {
  bump();
}

/**
 * 用户在设置页读完说明并确认后才调用；这是唯一调用 `Notification.requestPermission()` 的地方。
 * 返回最终权限；不支持或抛错时返回当前状态。
 */
export async function enableNotifications(): Promise<NotifyPermission> {
  writeJson(KEYS.notify, { introAccepted: true });
  if (permission() === 'unsupported') {
    bump();
    return 'unsupported';
  }
  try {
    await window.Notification.requestPermission();
  } catch {
    /* 视为未授权 */
  }
  bump();
  return permission();
}

export function truncateTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length <= MAX_TITLE_CHARS ? title : chars.slice(0, MAX_TITLE_CHARS).join('');
}

/** 正文：`Initiatives / Sample Project / …`（Section 标题 + 祖先标题）。 */
export function notificationBody(row: Pick<TaskRow, 'path'>, sectionTitle: string | null): string {
  const parts = [...(sectionTitle ? [sectionTitle] : []), ...row.path.map((item) => item.title)];
  return parts.length > 0 ? parts.join(' / ') : '';
}

/** 保留最近 `max` 条（按插入顺序，后写入的更新）。 */
export function trimNotified(map: Record<string, string>, max: number = MAX_NOTIFIED): Record<string, string> {
  const entries = Object.entries(map);
  return entries.length <= max ? map : Object.fromEntries(entries.slice(entries.length - max));
}

export interface NotifyOptions {
  sectionTitle: (sectionId: string | null) => string | null;
  onClick?: (taskId: string) => void;
}

/** 对到期提醒弹出浏览器通知；返回本次实际弹出的 Task id。 */
export function notifyDue(rows: readonly TaskRow[], options: NotifyOptions): string[] {
  if (permission() !== 'granted') return [];
  const notified = { ...readJson(KEYS.notified, validateNotified, {}) };
  const shown: string[] = [];
  for (const row of rows) {
    if (!row.remindAt || notified[row.id] === row.remindAt) continue;
    try {
      const note = new window.Notification(truncateTitle(row.title), {
        body: notificationBody(row, options.sectionTitle(row.sectionId)),
        tag: `${row.id}@${row.remindAt}`,
      });
      note.onclick = () => (options.onClick ?? openReminderTask)(row.id);
    } catch {
      continue; // construction failed (for example blocked by the browser): keep the in-app reminder and retry later
    }
    delete notified[row.id];
    notified[row.id] = row.remindAt;
    shown.push(row.id);
  }
  if (shown.length > 0) writeJson(KEYS.notified, trimNotified(notified));
  return shown;
}

/** 点击通知或提醒条目：聚焦窗口；Task 存在则 2 秒内定位到其父节点的任务 Tab，否则提示已不存在。 */
export async function openReminderTask(taskId: string): Promise<void> {
  try {
    window.focus();
  } catch {
    /* 忽略 */
  }
  try {
    const node = await get<NodeDTO>('node', { id: taskId }, { timeoutMs: 2000 });
    if (node.deletedAt || node.archivedAt) {
      showNotice(GONE_MESSAGE);
      return;
    }
    navigate(node.parentId ? nodePath(node.parentId, 'tasks', node.id) : nodePath(node.id));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      showNotice(GONE_MESSAGE);
      return;
    }
    showNotice('Could not open that Task. Try again later.');
  }
}
