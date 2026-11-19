import { useState } from 'react';
import { resolveWrite, type WriteAction } from '../../lib/agentWrites';
import { L3 } from '../../lib/labels';
import { useAnnounce } from '../announce';

/** 「Agent 写入·未确认」标记（图标 + 文字，不只靠颜色）。 */
export function UnconfirmedBadge() {
  return (
    <span className="flag flag-unconfirmed" data-unconfirmed-mark="true">
      <span aria-hidden="true">◆</span> {L3.unconfirmedMark}
    </span>
  );
}

interface Props {
  writeId: string;
  /** 用于无障碍名称，例如 Note 标题。 */
  subject?: string;
  onDone?: (action: WriteAction) => void;
}

/** 标记 + 确认/撤销按钮；被拒时状态不变并在旁边显示原因。 */
export function UnconfirmedControls({ writeId, subject, onDone }: Props) {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const suffix = subject ? `: ${subject}` : '';

  const run = async (action: WriteAction) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const outcome = await resolveWrite(action, writeId);
    setBusy(false);
    if (outcome.ok) {
      announce(action === 'confirm' ? L3.writeConfirmed : L3.writeUndone);
      onDone?.(action);
    } else {
      setMessage(outcome.message);
      announce(outcome.message);
    }
  };

  return (
    <span className="unconfirmed-controls" data-write-id={writeId}>
      <UnconfirmedBadge />
      <button type="button" className="btn" disabled={busy} aria-label={`${L3.confirm}${suffix}`} onClick={() => void run('confirm')}>
        {L3.confirm}
      </button>
      <button type="button" className="btn" disabled={busy} aria-label={`${L3.undo}${suffix}`} onClick={() => void run('undo')}>
        {L3.undo}
      </button>
      {message ? (
        <span role="alert" className="error-text write-reason">
          {message}
        </span>
      ) : null}
    </span>
  );
}
