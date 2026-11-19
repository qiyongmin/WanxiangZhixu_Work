import { useId, useState, type FormEvent } from 'react';
import { ApiError, get } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { validateRelation } from '../../lib/inspector';
import { L, L2 } from '../../lib/labels';
import { nodePath } from '../../lib/router';
import { addLink, removeLink } from '../../lib/taskWrite';
import type { NodeDTO, SearchHit } from '../../lib/types';
import { useAnnounce } from '../announce';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';
import { ModalDialog } from '../ModalDialog';

function reason(error: unknown): string {
  return error instanceof ApiError && error.fields.length > 0 ? (error.fields[0]?.reason ?? error.message) : describeError(error);
}

function AddLinkDialog({ node, onClose }: { node: NodeDTO; onClose: () => void }) {
  const announce = useAnnounce();
  const uid = useId();
  const [relation, setRelation] = useState('related');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [picked, setPicked] = useState<SearchHit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    const text = query.trim();
    if (text === '') return;
    setError(null);
    try {
      const hits = await get<SearchHit[]>('search', { q: text, limit: 10 });
      setResults(hits.filter((hit) => hit.id !== node.id));
    } catch (failure) {
      setError(reason(failure));
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const relationProblem = validateRelation(relation);
    if (relationProblem) return setError(relationProblem);
    if (!picked) return setError(L2.linkTargetRequired);
    setBusy(true);
    setError(null);
    try {
      await addLink({ sourceId: node.id, targetId: picked.id, relation: relation.trim() });
      announce(L2.linkAdded);
      onClose();
    } catch (failure) {
      setError(reason(failure));
      setBusy(false);
    }
  };

  return (
    <ModalDialog label={L2.linkNew} onClose={onClose} className="modal-small" portal>
      <form className="form" onSubmit={(event) => void add(event)} noValidate>
        <h2>{L2.linkNew}</h2>
        <div className="field">
          <label htmlFor={`${uid}-rel`}>{L2.linkRelation}</label>
          <input id={`${uid}-rel`} type="text" value={relation} onChange={(event) => setRelation(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-q`}>{L2.linkSearch}</label>
          <div className="inline-add">
            <input
              id={`${uid}-q`}
              type="text"
              data-autofocus
              value={query}
              placeholder={L2.linkSearchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void search();
                }
              }}
            />
            <button type="button" className="btn" onClick={() => void search()}>
              {L2.linkSearch}
            </button>
          </div>
        </div>
        {results.length > 0 ? (
          <ul className="link-results" aria-label={L2.linkTarget}>
            {results.map((hit) => (
              <li key={hit.id}>
                <span>{hit.title}</span>
                <button type="button" className="btn" aria-pressed={picked?.id === hit.id} onClick={() => setPicked(hit)}>
                  {picked?.id === hit.id ? L2.linkPicked : L2.linkPick}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {picked ? (
          <p className="muted">
            {L2.linkTarget}: {picked.title}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="field-error error-text">
            {error}
          </p>
        ) : null}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {L2.linkAdd}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {L.cancel}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

/** Typed_Link add/remove (link-add / link-remove, no Revision) and Back_Reference. "+" opens the add dialog. */
export function LinksEditor({ node }: { node: NodeDTO }) {
  const announce = useAnnounce();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const remove = async (link: NodeDTO['links'][number]) => {
    setBusy(true);
    setError(null);
    try {
      const outgoing = link.direction === 'out';
      await removeLink({
        sourceId: outgoing ? node.id : link.otherId,
        targetId: outgoing ? link.otherId : node.id,
        relation: link.relation,
      });
      announce(L2.linkRemoved);
    } catch (failure) {
      setError(reason(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="links-editor">
      {node.links.length === 0 ? (
        <p className="muted">{L2.linkNone}</p>
      ) : (
        <ul className="link-list" aria-label={L2.fieldLinks}>
          {node.links.map((link) => (
            <li key={`${link.direction}:${link.relation}:${link.otherId}`}>
              <span className="chip">{link.relation}</span>
              <span aria-hidden="true">{link.direction === 'out' ? '→' : '←'}</span>
              <AppLink to={nodePath(link.otherId)}>{link.otherTitle}</AppLink>
              <button
                type="button"
                className="btn btn-icon btn-ghost"
                disabled={busy}
                aria-label={`${L2.linkRemove}: ${link.otherTitle}`}
                title={`${L2.linkRemove}: ${link.otherTitle}`}
                onClick={() => void remove(link)}
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {node.backRefs.length > 0 ? (
        <div className="back-refs">
          <h4>{L2.backRefs}</h4>
          <ul className="link-list" aria-label={L2.backRefs}>
            {node.backRefs.map((ref) => (
              <li key={`${ref.relation}:${ref.sourceId}`}>
                <AppLink to={nodePath(ref.sourceId)}>{ref.sourceTitle}</AppLink>
                <span className="chip">{ref.relation}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="field-error error-text">
          {error}
        </p>
      ) : null}
      <button type="button" className="btn btn-icon btn-ghost" aria-label={L2.linkNew} title={L2.linkNew} onClick={() => setOpen(true)}>
        <Icon name="plus" />
      </button>
      {open ? <AddLinkDialog node={node} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
