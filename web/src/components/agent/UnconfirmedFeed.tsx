import { useEffect, useRef } from 'react';
import { get } from '../../lib/api';
import { formatTimestamp } from '../../lib/dates';
import { describeError } from '../../lib/errors';
import { L, L3 } from '../../lib/labels';
import { invalidate, fetchQuery, useQuery } from '../../lib/queryCache';
import { nodePath } from '../../lib/router';
import type { AgentWritesView } from '../../lib/types';
import { AppLink } from '../AppLink';
import { opLabel } from '../node/ActivityTab';
import { UnconfirmedControls } from './UnconfirmedMark';

export const FEED_KEY = 'agent-writes:unconfirmed';
const POLL_MS = 2000;

/** Cockpit 中的「未确认的 Agent 写入」：从新到旧，约 2 秒轮询一次本机接口，变化时刷新树与 Cockpit 分组。 */
export function UnconfirmedFeed() {
  const fetcher = (signal: AbortSignal) =>
    get<AgentWritesView>('agent-writes', { state: 'unconfirmed', limit: 50 }, { signal });
  const query = useQuery<AgentWritesView>(FEED_KEY, fetcher, { staleMs: 0 });
  const lastIds = useRef<string | null>(null);
  const disclosureRef = useRef<HTMLDetailsElement>(null);
  const noticed = useRef<string>('');

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchQuery(FEED_KEY, fetcher);
    }, POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signature = query.data ? query.data.items.map((item) => item.writeId).join(',') : null;
  useEffect(() => {
    // The empty state remains a single closed line. Newly pending Agent writes
    // expand once as an actionable review alert, but never force-reopen a
    // disclosure which the user has deliberately closed.
    if (signature && signature !== noticed.current) {
      if (disclosureRef.current) disclosureRef.current.open = true;
      noticed.current = signature;
    }
    if (!signature) noticed.current = '';
  }, [signature]);
  useEffect(() => {
    if (signature === null) return;
    if (lastIds.current !== null && lastIds.current !== signature) {
      invalidate('cockpit');
      invalidate('tree');
      invalidate('node:');
    }
    lastIds.current = signature;
  }, [signature]);

  return (
    <details ref={disclosureRef} className="unconfirmed-feed" data-feed="unconfirmed">
      <summary id="cockpit-unconfirmed">
        <span className="unconfirmed-feed-title">{L3.unconfirmedHeading}</span>
        {query.data ? <span className="count-badge" data-pending-count={query.data.items.length}>{query.data.items.length}</span> : null}
        <span className="muted unconfirmed-feed-hint">{query.data?.items.length ? 'Review pending changes' : 'No action needed · Open review'}</span>
      </summary>
      {query.status === 'error' && !query.data ? (
        <p className="muted">
          {describeError(query.error)}{' '}
          <button type="button" className="btn" onClick={() => void query.refetch()}>
            {L.retry}
          </button>
        </p>
      ) : null}
      {!query.data && query.status !== 'error' ? <p className="muted">{L.loading}</p> : null}
      {query.data && query.data.items.length === 0 ? <p className="muted">{L3.unconfirmedNone}</p> : null}
      {query.data && query.data.items.length > 0 ? (
        <ul className="feed-list" aria-label={L3.unconfirmedHeading}>
          {query.data.items.map((item) => (
            <li key={item.writeId} className="feed-item" data-write-id={item.writeId}>
              <div className="task-main">
                <span>{opLabel(item.op)}</span>
                {item.nodePath ? (
                  <AppLink to={nodePath(item.nodeId, 'activity')} className="task-title">
                    {item.nodePath}
                  </AppLink>
                ) : (
                  <span className="muted">{L3.agentNodeGone}</span>
                )}
              </div>
              <div className="task-meta">
                <span>
                  {item.actor} · {formatTimestamp(item.createdAt)}
                </span>
                <UnconfirmedControls writeId={item.writeId} subject={opLabel(item.op)} />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
