// 提醒调度（设计 6.12）：每 15 秒（≤30 秒）轮询 view=reminders，visibilitychange / online 立即检查；
// 集合变化时使 tree / cockpit 缓存过期，使徽标与 Cockpit 高亮在下一次渲染中更新。
import { get } from './api';
import { localNow } from './dates';
import { notifyDue } from './notifications';
import { invalidate, getEntry, setData } from './queryCache';
import type { RemindersView, TaskRow, TreeView } from './types';

export const REMINDERS_KEY = 'reminders';
export const TICK_MS = 15_000;

/** 页面加载时刻：早于它到期的待处理提醒记为「已错过」（Req 13.7）。 */
export const sessionStart: string = localNow();

export function isMissed(row: Pick<TaskRow, 'remindAt'>, start: string = sessionStart): boolean {
  return row.remindAt !== null && row.remindAt < start;
}

/** 提醒集合的签名（id@remindAt，到期与即将到期分开），用于检测变化。 */
export function signature(view: RemindersView): string {
  const part = (rows: TaskRow[]) => rows.map((row) => `${row.id}@${row.remindAt}`).join(',');
  return `${part(view.due)}|${part(view.upcoming)}`;
}

let lastSignature: string | null = null;
let inflight: Promise<void> | null = null;

function sectionTitleOf(sectionId: string | null): string | null {
  if (!sectionId) return null;
  const tree = getEntry<TreeView>('tree').data;
  return tree?.sections.find((section) => section.id === sectionId)?.title ?? null;
}

/** 立即检查一次提醒。失败时保留上次结果，不抛出。 */
export function refreshReminders(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const view = await get<RemindersView>('reminders', { now: localNow() });
      setData<RemindersView>(REMINDERS_KEY, view);
      const next = signature(view);
      if (lastSignature !== null && next !== lastSignature) {
        invalidate('tree');
        invalidate('cockpit');
      }
      lastSignature = next;
      notifyDue(view.due, { sectionTitle: sectionTitleOf });
    } catch {
      /* 网络或迁移问题：下一次 tick 再试 */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function resetReminders(): void {
  lastSignature = null;
  inflight = null;
}

/** 启动调度器；返回停止函数。 */
export function startReminderScheduler(): () => void {
  void refreshReminders();
  const timer = setInterval(() => void refreshReminders(), TICK_MS);
  const onVisible = () => {
    if (document.visibilityState === 'visible') void refreshReminders();
  };
  const onOnline = () => void refreshReminders();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
  };
}
