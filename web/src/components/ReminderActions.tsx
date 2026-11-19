import { useState } from 'react';
import { ApiError } from '../lib/api';
import { describeError } from '../lib/errors';
import { L2 } from '../lib/labels';
import { showNotice } from '../lib/notice';
import { handleReminder, type ReminderAction } from '../lib/taskWrite';
import { useAnnounce } from './announce';

interface Props {
  taskId: string;
  remindAt: string;
  revision: number;
  /** 处理成功后回调（例如从本地列表移除该行）。 */
  onDone?: () => void;
}

const SNOOZES = [
  { minutes: 10 as const, label: L2.snooze10 },
  { minutes: 60 as const, label: L2.snooze60 },
  { minutes: 1440 as const, label: L2.snooze1440 },
];

/** 「已处理 / 延后 10 分钟·1 小时·24 小时」：结果持久在服务端（Req 13.8）。 */
export function ReminderActions({ taskId, remindAt, revision, onDone }: Props) {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);

  const run = async (action: ReminderAction) => {
    if (busy) return;
    setBusy(true);
    try {
      await handleReminder(taskId, remindAt, revision, action);
      const text = action.kind === 'handled' ? L2.reminderDone : L2.reminderSnoozed;
      announce(text);
      onDone?.();
    } catch (error) {
      const text = error instanceof ApiError && error.code === 'reminder_changed' ? L2.reminderChanged : describeError(error);
      showNotice(text);
      announce(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reminder-actions" role="group" aria-label={L2.reminderBadge}>
      <button type="button" className="btn" disabled={busy} onClick={() => void run({ kind: 'handled' })}>
        {L2.reminderHandled}
      </button>
      {SNOOZES.map((item) => (
        <button
          key={item.minutes}
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void run({ kind: 'snooze', minutes: item.minutes })}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
