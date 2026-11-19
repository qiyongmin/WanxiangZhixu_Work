import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, get, post } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { formatTimestamp } from '../../lib/dates';
import { L, L3 } from '../../lib/labels';
import { afterWrite, isConflict, usePaged } from '../../lib/nodeData';
import { useQuery } from '../../lib/queryCache';
import type { ActivityView, NodeDTO, NodeResult, SummaryHistoryItem, UnconfirmedWrite } from '../../lib/types';
import { useAnnounce } from '../announce';
import { UnconfirmedBadge, UnconfirmedControls } from '../agent/UnconfirmedMark';
import { ModalDialog } from '../ModalDialog';

const ACTIVITY_PAGE = 50;

function Loading() {
  return (
    <p className="muted" role="status">
      {L.loading}
    </p>
  );
}

export function opLabel(op: string): string {
  return L3.agentOps[op] ?? op;
}

function excerpt(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 当前节点上尚未确认的 Agent 写入（从新到旧）。 */
export function UnconfirmedList({ node }: { node: NodeDTO }) {
  const uid = useId();
  const items = [...(node.unconfirmed as unknown as UnconfirmedWrite[])].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
  return (
    <section aria-labelledby={`${uid}-h`} className="unconfirmed-list">
      <h2 id={`${uid}-h`}>{L3.unconfirmedHeading}</h2>
      {items.length === 0 ? (
        <p className="muted">{L3.unconfirmedNone}</p>
      ) : (
        <ul className="item-list">
          {items.map((item) => (
            <li key={item.writeId} data-write-id={item.writeId}>
              <span>{opLabel(item.op)}</span>
              <span className="muted">
                {item.actor} · {formatTimestamp(item.createdAt)}
              </span>
              <UnconfirmedControls writeId={item.writeId} subject={opLabel(item.op)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SummaryHistory({ node }: { node: NodeDTO }) {
  const announce = useAnnounce();
  const uid = useId();
  const query = useQuery<SummaryHistoryItem[]>(`summary-history:${node.id}:${node.revision}`, (signal) =>
    get<SummaryHistoryItem[]>('summary-history', { id: node.id }, { signal }),
  );
  const [target, setTarget] = useState<SummaryHistoryItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rollback = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await post<NodeResult>('summary-rollback', {
        id: node.id,
        baseRevision: node.revision,
        targetRevision: target.revision,
      });
      afterWrite(result.node);
      announce(L3.historyRolledBack);
      setTarget(null);
    } catch (failure) {
      const message =
        failure instanceof ApiError && failure.code === 'rollback_target_invalid'
          ? L3.historyRollbackInvalid
          : isConflict(failure)
            ? L3.historyConflict
            : `${L.opFailed}: ${describeError(failure)}`;
      setError(message);
      announce(message);
      setTarget(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`${uid}-h`} className="summary-history">
      <h2 id={`${uid}-h`}>{L3.historyHeading}</h2>
      {error ? (
        <p role="alert" className="error-text">
          {error}
        </p>
      ) : null}
      {!query.data ? (
        query.status === 'error' ? (
          <p role="alert" className="error-text">
            {describeError(query.error)}
          </p>
        ) : (
          <Loading />
        )
      ) : query.data.length === 0 ? (
        <p className="muted">{L3.historyEmpty}</p>
      ) : (
        <ol className="activity-list">
          {query.data.map((item) => (
            <li key={item.revision} data-history-revision={item.revision} data-current={item.isCurrent ? 'true' : undefined}>
              <div>
                <strong>Revision {item.revision}</strong>
                {item.isCurrent ? <span className="chip">{L3.historyCurrent}</span> : null}
              </div>
              <div className="muted">
                {L.activityActor}: {item.actor} · {L.activitySource}: {item.source} · {formatTimestamp(item.occurredAt)}
              </div>
              <div className="summary-excerpt">{item.text === '' ? L.summaryEmpty : excerpt(item.text)}</div>
              {item.rollbackable ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setTarget(item)}
                  aria-label={`${L3.historyRollback} Revision ${item.revision}`}>
                  {L3.historyRollback}
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {target ? (
        <ModalDialog label={L3.historyRollback} onClose={() => setTarget(null)}>
          <div className="confirm-dialog">
            <h2>{L3.historyRollback}</h2>
            <p>{L3.historyRollbackAsk(target.revision)}</p>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void rollback()}>
                {L3.historyRollbackOk}
              </button>
              <button type="button" className="btn" data-autofocus onClick={() => setTarget(null)}>
                {L.cancel}
              </button>
            </div>
          </div>
        </ModalDialog>
      ) : null}
    </section>
  );
}

/** 动态 Tab：未确认 Agent 写入、Summary 历史与回滚、Revision 列表（首批 50 条，滚动到底继续）。 */
export function ActivityTab({ node }: { node: NodeDTO }) {
  const paged = usePaged<ActivityView['items'][number], number>(
    async (cursor, signal) => {
      const view = await get<ActivityView>(
        'activity',
        { id: node.id, limit: ACTIVITY_PAGE, before: cursor ?? undefined },
        { signal },
      );
      return { items: view.items, next: view.nextBefore };
    },
    [node.id, node.revision],
  );
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasMore, loadMore } = paged;

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasMore || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore, paged.items.length]);

  let list;
  if (paged.status === 'error') {
    list = (
      <p role="alert" className="error-text">
        {describeError(paged.error)}
      </p>
    );
  } else if (paged.status === 'loading' && paged.items.length === 0) {
    list = <Loading />;
  } else if (paged.items.length === 0) {
    list = <p className="muted">{L.activityEmpty}</p>;
  } else {
    list = (
      <div>
        <ol className="activity-list" aria-label={L.activityTime}>
          {paged.items.map((item) => (
            <li key={item.revision} data-revision={item.revision}>
              <div>
                <strong>Revision {item.revision}</strong> · {item.changeLabel}
                {item.agentWrite && item.agentWrite.state === 'unconfirmed' ? <UnconfirmedBadge /> : null}
              </div>
              <div className="muted">
                {L.activityActor}: {item.actor} · {L.activitySource}: {item.source} · {formatTimestamp(item.occurredAt)}
              </div>
            </li>
          ))}
        </ol>
        {hasMore ? (
          <>
            <div ref={sentinel} aria-hidden="true" />
            <button type="button" className="btn" onClick={loadMore} disabled={paged.loadingMore}>
              {L.activityMore}
            </button>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="tab-stack">
      <UnconfirmedList node={node} />
      <SummaryHistory node={node} />
      {list}
    </div>
  );
}
