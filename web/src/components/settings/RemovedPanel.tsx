import { useState } from 'react';
import { get } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { L, L2 } from '../../lib/labels';
import { isConflict } from '../../lib/nodeData';
import { showNotice } from '../../lib/notice';
import { invalidate, useQuery } from '../../lib/queryCache';
import { restoreNode } from '../../lib/taskWrite';
import type { RemovedItem, RemovedView } from '../../lib/types';
import { useAnnounce } from '../announce';
import { Icon } from '../icons';

function RemovedList() {
  const announce = useAnnounce();
  const query = useQuery<RemovedView>('removed', (signal) => get<RemovedView>('removed', {}, { signal }), { staleMs: 0 });
  const [busy, setBusy] = useState<string | null>(null);

  const restore = async (item: RemovedItem) => {
    if (busy) return;
    setBusy(item.id);
    try {
      await restoreNode(item.id, item.revision, item.state);
      const message = L2.removedRestored(item.title);
      showNotice(message);
      announce(message);
      invalidate('removed');
    } catch (error) {
      const detail = isConflict(error) ? L2.moveConflict : describeError(error);
      showNotice(`${L2.removedRestoreFailed}: ${detail}`);
      invalidate('removed');
    } finally {
      setBusy(null);
    }
  };

  if (!query.data) {
    return query.status === 'error' ? (
      <div className="error-bar" role="alert">
        <span>
          {L2.removedLoadFailed}: {describeError(query.error)}
        </span>
        <button type="button" className="btn" onClick={() => void query.refetch()}>
          {L.retry}
        </button>
      </div>
    ) : (
      <p className="muted" role="status">
        {L.loading}
      </p>
    );
  }
  if (query.data.items.length === 0) return <p className="muted">{L2.removedEmpty}</p>;
  return (
    <>
      <p className="muted" aria-live="polite">
        {L2.removedTotalShown(query.data.items.length, query.data.total)}
      </p>
      <ul className="removed-list" aria-label={L2.removedHeading}>
        {query.data.items.map((item) => (
          <li key={item.id} className="removed-item" data-removed-id={item.id}>
            <span className="removed-title">{item.title}</span>
            <span className="removed-state" data-state={item.state}>
              {item.state === 'deleted' ? L2.removedDeleted : L2.removedArchived}
            </span>
            <span className="muted">{item.displayKind}</span>
            {item.parentTitle ? <span className="muted">{item.parentTitle}</span> : null}
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              aria-label={L2.removedRestoreNamed(item.title)}
              onClick={() => void restore(item)}
            >
              <Icon name="restore" size={14} />
              <span>{L2.removedRestore}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Settings: a toggle that lists archived and deleted nodes (loaded only when shown) with a Restore button. */
export function RemovedPanel() {
  const [shown, setShown] = useState(false);
  return (
    <section aria-labelledby="settings-removed" className="settings-group">
      <h2 id="settings-removed">{L2.removedHeading}</h2>
      <p className="muted">{L2.removedHint}</p>
      <label className="check-row">
        <input type="checkbox" checked={shown} onChange={(event) => setShown(event.target.checked)} />
        <span>{L2.removedToggle}</span>
      </label>
      {shown ? <RemovedList /> : null}
    </section>
  );
}
