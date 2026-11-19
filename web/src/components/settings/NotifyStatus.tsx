import { useState } from 'react';
import { L2 } from '../../lib/labels';
import { enableNotifications, useNotifyState, type NotifyPermission } from '../../lib/notifications';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';

/** 常驻说明：浏览器通知未启用时只有应用内提醒，直到授权为止（Req 13.5）。 */
export function NotifyStatus({ inline }: { inline?: boolean }) {
  const state = useNotifyState();
  if (state.permission === 'granted') return null;
  return (
    <p className={inline ? 'notify-status notify-inline' : 'notify-status'} data-notify-state={state.permission}>
      <Icon name="bell-off" size={14} /> {L2.notifyOff} · <AppLink to="/settings">{L2.notifyStart}</AppLink>
    </p>
  );
}

function describe(permission: NotifyPermission): string {
  switch (permission) {
    case 'granted':
      return L2.notifyGranted;
    case 'denied':
      return L2.notifyDenied;
    case 'unsupported':
      return L2.notifyUnsupported;
    default:
      return L2.notifyDefault;
  }
}

/** 设置页的通知启用流程：先说明并等待确认，确认后才请求浏览器权限（Req 13.4）。 */
export function NotificationSettings() {
  const state = useNotifyState();
  const [explaining, setExplaining] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await enableNotifications();
    } finally {
      setBusy(false);
      setExplaining(false);
    }
  };

  return (
    <section aria-labelledby="settings-notify" className="settings-group">
      <h2 id="settings-notify">{L2.notifyHeading}</h2>
      <p role="status" data-notify-state={state.permission}>
        {describe(state.permission)}
      </p>
      {state.permission !== 'granted' && state.permission !== 'unsupported' && !explaining ? (
        <button type="button" className="btn" onClick={() => setExplaining(true)}>
          {L2.notifyStart}
        </button>
      ) : null}
      {explaining ? (
        <div className="notify-intro" role="group" aria-label={L2.notifyHeading}>
          <p>{L2.notifyIntro}</p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirm()}>
            {L2.notifyConfirm}
          </button>
        </div>
      ) : null}
    </section>
  );
}
