import { useEffect, useId, useRef, useState } from 'react';
import { get } from '../../lib/api';
import { formatTimestamp } from '../../lib/dates';
import { describeError } from '../../lib/errors';
import { L, L2, L3 } from '../../lib/labels';
import { usePaged } from '../../lib/nodeData';
import { nodePath } from '../../lib/router';
import type { AgentWriteRow, AgentWritesView } from '../../lib/types';
import { AppLink } from '../AppLink';
import { opLabel } from '../node/ActivityTab';
import { UnconfirmedControls } from './UnconfirmedMark';

export const AGENT_PAGE = 50;

const STATE_OPTIONS: Array<[string, string]> = [
  ['', L3.agentStateAll],
  ['unconfirmed', L3.agentStateUnconfirmed],
  ['confirmed', L3.agentStateConfirmed],
  ['undone', L3.agentStateUndone],
  ['approved', L3.agentStateApproved],
];

const STATE_TEXT: Record<string, string> = {
  unconfirmed: L3.agentStateUnconfirmed,
  confirmed: L3.agentStateConfirmed,
  undone: L3.agentStateUndone,
  approved: L3.agentStateApproved,
};

interface Filters {
  actor: string;
  state: string;
  from: string;
  to: string;
}

const NO_FILTER: Filters = { actor: '', state: '', from: '', to: '' };

/** 单行的目标路径、操作与时间；格式与 AgentAccess 的「最近写入」共用。 */
export function WriteRowCells({ row }: { row: AgentWriteRow }) {
  return (
    <>
      <td>{row.actor}</td>
      <td>
        {row.nodePath ? (
          <AppLink to={nodePath(row.nodeId, 'activity')}>{row.nodePath}</AppLink>
        ) : (
          <span className="muted">{L3.agentNodeGone}</span>
        )}
      </td>
      <td>{opLabel(row.op)}</td>
      <td>
        <time dateTime={row.createdAt}>{formatTimestamp(row.createdAt)}</time>
      </td>
    </>
  );
}

/** Ordered audit events grouped by day without altering server pagination/order. */
export function groupAgentWritesByDay(items: readonly AgentWriteRow[]): Array<{ day: string; rows: AgentWriteRow[] }> {
  const days = new Map<string, AgentWriteRow[]>();
  for (const row of items) {
    const day = row.createdAt && !Number.isNaN(Date.parse(row.createdAt))
      ? new Date(row.createdAt).toLocaleDateString('sv-SE') : 'Unknown date';
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(row);
  }
  return [...days].map(([day, rows]) => ({ day, rows }));
}

/** Agent Activity is an audit timeline (not a large, overflowing 5-column table).
 * Existing server filters, pagination, confirmations and undo remain intact. */
export function AgentActivity({ embedded=false }: { embedded?:boolean }={}) {
  const uid = useId();
  const [filters, setFilters] = useState<Filters>(NO_FILTER);
  const [applied, setApplied] = useState<Filters>(NO_FILTER);

  // actor 文本输入防抖 300ms，其余条件立即生效；均在 1 秒内发出请求。
  useEffect(() => {
    const timer = window.setTimeout(() => setApplied(filters), filters.actor === applied.actor ? 0 : 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const paged = usePaged<AgentWriteRow, string>(
    async (cursor, signal) => {
      const view = await get<AgentWritesView>(
        'agent-writes',
        {
          limit: AGENT_PAGE,
          actor: applied.actor.trim() || undefined,
          state: applied.state || undefined,
          from: applied.from || undefined,
          to: applied.to || undefined,
          cursor: cursor ?? undefined,
        },
        { signal },
      );
      return { items: view.items, next: view.nextCursor };
    },
    [applied.actor, applied.state, applied.from, applied.to],
  );
  const { hasMore, loadMore } = paged;
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasMore || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore, paged.items.length]);

  const filtered = JSON.stringify(applied) !== JSON.stringify(NO_FILTER);
  const set = (key: keyof Filters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const failed = paged.status === 'error';
  const grouped = groupAgentWritesByDay(paged.items);
  const unconfirmed = paged.items.filter((item) => item.state === 'unconfirmed').length;

  return (
    <section className={embedded?"agent-activity agent-activity-embedded":"page agent-activity"} aria-labelledby={embedded?"agent-history-title":"page-title"}>
      <div className="section-head agent-activity-header">
        <div className="agent-activity-heading">
          <span className="agent-eyebrow">WORKSPACE AUDIT</span>
          {embedded?<h2 id="agent-history-title">Work Agent write history</h2>:
            <h1 id="page-title">{L3.agentHeading}</h1>}
          <p className="muted">Review changes from desktop Agents and resolve unconfirmed writes.</p>
        </div>
        <AppLink to="/proposals" className="btn">{L3.proposalsLink}</AppLink>
      </div>
      <div className="agent-summary" role="group" aria-label="Agent activity summary">
        <div className="agent-summary-cell"><strong>{paged.items.length}</strong><span>Loaded events</span></div>
        <div className="agent-summary-cell" data-summary="unconfirmed"><strong>{unconfirmed}</strong><span>Awaiting review</span></div>
        <div className="agent-summary-cell"><strong>{grouped.length}</strong><span>Activity days</span></div>
      </div>
      <form className="form form-inline agent-filters" onSubmit={(event) => event.preventDefault()} aria-label={L2.filtersLabel}>
        <div className="field">
          <label htmlFor={`${uid}-a`}>{L3.agentFilterActor}</label>
          <input id={`${uid}-a`} type="text" value={filters.actor} placeholder="agent:" onChange={(event) => set('actor', event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-s`}>{L3.agentFilterState}</label>
          <select id={`${uid}-s`} value={filters.state} onChange={(event) => set('state', event.target.value)}>
            {STATE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <details className="agent-date-range">
          <summary>Date range{filters.from || filters.to ? ' · Active' : ''}</summary>
          <div className="agent-date-fields">
            <div className="field">
              <label htmlFor={`${uid}-f`}>{L3.agentFilterFrom}</label>
              <input id={`${uid}-f`} type="date" value={filters.from} onChange={(event) => set('from', event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={`${uid}-t`}>{L3.agentFilterTo}</label>
              <input id={`${uid}-t`} type="date" value={filters.to} onChange={(event) => set('to', event.target.value)} />
            </div>
          </div>
        </details>
        {filtered ? <button type="button" className="btn" onClick={() => {
          setFilters(NO_FILTER); setApplied(NO_FILTER);
        }}>{L3.agentClear}</button> : null}
      </form>
      {failed ? (
        <div className="error-bar" role="alert">
          <span>
            {L3.agentLoadFailed}: {describeError(paged.error)}
          </span>
          <button type="button" className="btn" onClick={() => (paged.items.length > 0 && hasMore ? loadMore() : paged.reload())}>
            {L.retry}
          </button>
        </div>
      ) : null}
      {paged.status === 'loading' && paged.items.length === 0 ? (
        <p className="muted" role="status">
          {L.loading}
        </p>
      ) : null}
      {paged.status === 'ready' && paged.items.length === 0 ? (
        <div className="empty-state">
          <p className="muted">{L3.agentNoMatch}</p>
          {filtered ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setFilters(NO_FILTER);
                setApplied(NO_FILTER);
              }}>
              {L3.agentClear}
            </button>
          ) : null}
        </div>
      ) : null}
      {paged.items.length > 0 ? (
        <div className="agent-event-timeline" aria-label="Agent events">
          {grouped.map((group) => (
            <section key={group.day} className="agent-day" data-day={group.day}>
              <h2 className="agent-day-heading">
                <time>{group.day}</time><span className="count-badge">{group.rows.length}</span>
              </h2>
              <ul className="agent-events">
                {group.rows.map((row) => (
                  <li key={row.writeId} className="agent-event"
                    data-write-id={row.writeId} data-state={row.state}>
                    <div className="agent-event-icon" aria-hidden="true">{row.state === 'undone' ? '↶' : '◆'}</div>
                    <div className="agent-event-body">
                      <div className="agent-event-title">
                        <span className="agent-op">{opLabel(row.op)}</span>
                        <span className="agent-actor" title={row.actor}>{row.actor}</span>
                      </div>
                      <div className="agent-event-target">
                        {row.nodePath
                          ? <AppLink to={nodePath(row.nodeId, 'activity')}>{row.nodePath}</AppLink>
                          : <span className="muted">{L3.agentNodeGone}</span>}
                      </div>
                      <time className="agent-event-time" dateTime={row.createdAt}>{formatTimestamp(row.createdAt)}</time>
                    </div>
                    <div className="agent-event-review">
                      {row.state === 'unconfirmed'
                        ? <UnconfirmedControls writeId={row.writeId} subject={opLabel(row.op)} onDone={paged.reload}/>
                        : <span className="agent-state" data-state={row.state}>{STATE_TEXT[row.state] ?? row.state}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
      {hasMore ? (
        <>
          <div ref={sentinel} aria-hidden="true" />
          <button type="button" className="btn" onClick={loadMore} disabled={paged.loadingMore}>
            {L3.agentLoadMore}
          </button>
        </>
      ) : null}
    </section>
  );
}
