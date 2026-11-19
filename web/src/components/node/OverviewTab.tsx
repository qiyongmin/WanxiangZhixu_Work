import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { notifyDraftChange, registerEditor } from '../../lib/draftGuard';
import { ApiError, get, post } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { L, L2 } from '../../lib/labels';
import { afterWrite, isConflict, usePaged } from '../../lib/nodeData';
import { charCount, fieldReasons, openCounts, SUMMARY_MAX, summaryTooLong } from '../../lib/nodeForm';
import { nodePath } from '../../lib/router';
import { sanitizeHtml } from '../../lib/sanitize';
import type { ChildrenView, NodeDTO, NodeResult, UnconfirmedWrite } from '../../lib/types';
import { useAnnounce } from '../announce';
import { UnconfirmedControls } from '../agent/UnconfirmedMark';
import { AppLink } from '../AppLink';
import { StatusBadge } from '../StatusBadge';
import { isTaskKind } from '../inspector/Inspector';
import { TaskDetail } from '../tasks/TaskDetail';
import { Progress } from '../tasks/TaskMeta';

const PAGE = 100;

export function SummaryBlock({ node }: { node: NodeDTO }) {
  const announce = useAnnounce();
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [base, setBase] = useState(node.revision);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summaryWrite = (node.unconfirmed as unknown as UnconfirmedWrite[]).find((item) => item.op === 'update_summary');
  const rendered = useMemo(() => (node.summary.html ? sanitizeHtml(node.summary.html) : null), [node.summary.html]);
  const tooLong = summaryTooLong(text);
  const dirtyRef = useRef(false);
  dirtyRef.current = editing && text !== node.summary.text;
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  useEffect(() => registerEditor(`summary:${node.id}`, {
    dirty: () => dirtyRef.current,
    save: () => saveRef.current(),
    discard: () => { dirtyRef.current = false; setEditing(false); setText(node.summary.text); },
  }), [node.id, node.summary.text]);
  useEffect(() => notifyDraftChange(), [text, editing]);

  const start = () => {
    setText(node.summary.text);
    setBase(node.revision);
    setError(null);
    setEditing(true);
  };

  const save = async (event?: FormEvent): Promise<boolean> => {
    event?.preventDefault();
    if (saving) return false;
    if (tooLong) {
      setError(L.summaryTooLong);
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await post<NodeResult>('summary-set', { id: node.id, baseRevision: base, text });
      afterWrite(result.node);
      announce(L.saved);
      dirtyRef.current = false;
      setEditing(false);
      notifyDraftChange();
      return true;
    } catch (failure) {
      if (isConflict(failure)) {
        // 保留草稿；以服务端当前 Revision 为新的基线，再次保存即以最新版本为基础。
        setBase(failure.currentRevision ?? failure.current?.revision ?? base);
        setError(`${L.summaryConflict} (${L.conflictRevision} ${failure.currentRevision ?? ''})`);
        announce(`${L.conflictTitle}, ${L.draftKept}`);
      } else if (failure instanceof ApiError && failure.status === 400) {
        setError(fieldReasons(failure).text ?? failure.message);
        announce(`${L.saveFailed}: ${failure.message}`);
      } else {
        setError(`${L.saveFailed}: ${describeError(failure)}. ${L.draftKept}`);
        announce(`${L.saveFailed}: ${describeError(failure)}`);
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  saveRef.current = () => save();
  return (
    <section className="summary-block" aria-labelledby={`${uid}-h`}>
      <div className="section-head">
        <h2 id={`${uid}-h`}>{L.summaryHeading}</h2>
        {summaryWrite ? <UnconfirmedControls writeId={summaryWrite.writeId} subject={L.summaryHeading} /> : null}
        {!editing ? (
          <button type="button" className="btn" onClick={start}>
            {L.summaryEdit}
          </button>
        ) : null}
      </div>
      {editing ? (
        <form className="form" onSubmit={(event) => void save(event)} noValidate>
          <label htmlFor={`${uid}-t`} className="visually-hidden">
            {L.summaryHeading}
          </label>
          <textarea
            id={`${uid}-t`}
            rows={6}
            value={text}
            aria-invalid={tooLong ? true : undefined}
            aria-describedby={`${uid}-c`}
            onChange={(event) => setText(event.target.value)}
            autoFocus
          />
          <p id={`${uid}-c`} className={tooLong ? 'error-text' : 'muted'}>
            {charCount(text)} / {SUMMARY_MAX} {L.summaryCount}
            {tooLong ? `: ${L.summaryTooLong}` : ''}
          </p>
          {error ? (
            <p role="alert" className="error-text">
              {error}
            </p>
          ) : null}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving || tooLong}>
              {saving ? L.saving : L.save}
            </button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              {L.cancel}
            </button>
          </div>
        </form>
      ) : rendered === null ? (
        <p className="muted">{L.summaryEmpty}</p>
      ) : rendered.ok ? (
        <div className="summary-html" dangerouslySetInnerHTML={{ __html: rendered.html }} />
      ) : (
        <p className="muted">{L.summaryUnsafe}</p>
      )}
    </section>
  );
}

function Children({ node }: { node: NodeDTO }) {
  const paged = usePaged<ChildrenView['items'][number], number>(
    async (cursor, signal) => {
      const offset = cursor ?? 0;
      const view = await get<ChildrenView>('children', { id: node.id, limit: PAGE, offset }, { signal });
      const end = offset + view.items.length;
      return { items: view.items, next: end < view.total && view.items.length > 0 ? end : null };
    },
    [node.id, node.revision, node.childCount],
  );
  const uid = useId();
  return (
    <section aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>{L.childrenHeading}</h2>
      {paged.status === 'error' ? (
        <p role="alert" className="error-text">
          {describeError(paged.error)}
        </p>
      ) : paged.items.length === 0 ? (
        paged.status === 'loading' ? (
          <p className="muted" role="status">
            {L.loading}
          </p>
        ) : (
          <p className="muted">{L.childrenEmpty}</p>
        )
      ) : (
        <ul className="child-cards" aria-label={L2.childCardsLabel}>
          {paged.items.map((child) => {
            const total = child.taskTotal ?? 0;
            const done = child.taskDone ?? 0;
            return (
              <li key={child.id} className="child-card" data-child-id={child.id} data-kind={child.kind}>
                <div className="child-card-head">
                  <div>
                    <AppLink to={nodePath(child.id)} className="child-card-title">
                      {child.title}
                    </AppLink>
                    <div className="child-card-kind">{child.displayKind}</div>
                  </div>
                  <StatusBadge status={child.status} />
                </div>
                {total > 0 ? <Progress done={done} total={total} label={L2.childTasksDone(done, total)} /> : null}
                <div className="child-card-stats">
                  <span>{L2.childTasksDone(done, total)}</span>
                  {child.open > 0 ? <span>{L2.childOpen(child.open)}</span> : null}
                  {child.childCount > 0 ? <span>{L2.childItems(child.childCount)}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {paged.hasMore ? (
        <button type="button" className="btn" onClick={paged.loadMore} disabled={paged.loadingMore}>
          {L.childrenLoadMore}
        </button>
      ) : null}
    </section>
  );
}

function OpenTasks({ node }: { node: NodeDTO }) {
  const uid = useId();
  const counts = openCounts(node.stats);
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  return (
    <section aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>{L.openTasksHeading}</h2>
      <ul className="stat-list">
        {counts.map((item) => (
          <li key={item.status} data-status-count={item.status}>
            <span>{item.status}</span> <strong>{item.count}</strong>
          </li>
        ))}
        <li data-status-count="total">
          <span>{L.openTasksTotal}</span> <strong>{total}</strong>
        </li>
      </ul>
    </section>
  );
}

/** Overview: Summary_Block above the direct children. New child Tasks come from the "+" in the node header. */
export function OverviewTab({ node }: { node: NodeDTO }) {
  return (
    <div className="tab-stack">
      <SummaryBlock node={node} />
      <Children node={node} />
      {isTaskKind(node.kind) ? <TaskDetail node={node} /> : null}
      <OpenTasks node={node} />
    </div>
  );
}
