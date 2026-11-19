import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { notifyDraftChange, registerEditor } from '../../lib/draftGuard';
import { describeError } from '../../lib/errors';
import { L, L2 } from '../../lib/labels';
import { isConflict } from '../../lib/nodeData';
import { updateNode } from '../../lib/taskWrite';
import type { NodeDTO } from '../../lib/types';

function stringFields(node: NodeDTO): Record<string, string> {
  const fields = node.customFields ?? {};
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** Manual-only Task metadata; patch by individual key, never replace historical customFields. */
export function TaskExtras({ node }: { node: NodeDTO }) {
  const existing = useMemo(() => stringFields(node), [node.customFields]);
  const [base, setBase] = useState(existing);
  const [fields, setFields] = useState(existing);
  const [baseAssignee, setBaseAssignee] = useState(node.assignee ?? '');
  const [assignee, setAssignee] = useState(node.assignee ?? '');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const structured = Object.keys(node.customFields ?? {}).filter((key) => typeof node.customFields?.[key] !== 'string');
  const dirty = assignee !== baseAssignee || JSON.stringify(fields) !== JSON.stringify(base);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  useEffect(() => registerEditor(`task-extras:${node.id}`, {
    dirty: () => dirtyRef.current,
    save: () => saveRef.current(),
    discard: () => {
      dirtyRef.current = false;
      setFields(base);
      setAssignee(baseAssignee);
      setNewKey(''); setNewValue('');
    },
  }), [node.id, base, baseAssignee]);
  useEffect(() => notifyDraftChange(), [dirty]);

  useEffect(() => {
    if (dirty) return; // never discard user edits when external revisions arrive
    setBase(existing);
    setFields(existing);
    setBaseAssignee(node.assignee ?? '');
    setAssignee(node.assignee ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.revision, node.assignee, existing]);

  const add = () => {
    const key = newKey.trim();
    if (!key || key.length > 80 || key in fields || key in (node.customFields ?? {})) {
      setMessage('Choose a unique field name (1–80 characters).');
      return;
    }
    if (newValue.length > 500) {
      setMessage('The value must be at most 500 characters.');
      return;
    }
    setFields((current) => ({ ...current, [key]: newValue }));
    setNewKey('');
    setNewValue('');
    setMessage('');
  };

  const save = async (event?: FormEvent): Promise<boolean> => {
    event?.preventDefault();
    if (busy || !dirty) return !dirty;
    if (assignee.length > 120 || Object.entries(fields).some(([key, val]) => key.length > 80 || val.length > 500)) {
      setMessage('Assignee or custom field exceeds the permitted length.');
      return false;
    }
    const patch: Record<string, string | null> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(fields)])) {
      if (fields[key] !== base[key]) patch[key] = fields[key] ?? null;
    }
    setBusy(true);
    setMessage('');
    try {
      const changed = await updateNode(node.id, node.revision, {
        ...(assignee !== baseAssignee ? { assignee } : {}),
        ...(Object.keys(patch).length ? { customFields: patch } : {}),
      });
      const next = stringFields(changed.node);
      setBase(next);
      setFields(next);
      setBaseAssignee(changed.node.assignee ?? '');
      setAssignee(changed.node.assignee ?? '');
      dirtyRef.current = false;
      setMessage(L.saved);
      notifyDraftChange();
      return true;
    } catch (error) {
      setMessage(isConflict(error) ? `${L.conflictTitle}: ${L.draftKept}` : `${L.saveFailed}: ${describeError(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  saveRef.current = () => save();
  return (
    <section className="task-extras field" aria-label={L2.fieldCustomFields}>
      <h3>{L2.fieldCustomFields}</h3>
      <form onSubmit={(event) => void save(event)} className="inspector-form">
        <label htmlFor="task-extras-assignee">{L2.fieldAssignee}</label>
        <input id="task-extras-assignee" aria-label={L2.fieldAssignee} value={assignee}
          maxLength={120} onChange={(event) => setAssignee(event.target.value)} />
        {Object.entries(fields).map(([key, value]) => (
          <div key={key} className="inline-add">
            <label className="field-label" htmlFor={`task-extra-${key}`}>{key}</label>
            <input id={`task-extra-${key}`} aria-label={`${key} value`} value={value}
              maxLength={500} onChange={(event) => setFields((current) => ({ ...current, [key]: event.target.value }))} />
            <button type="button" className="btn" aria-label={`Remove ${key}`}
              onClick={() => setFields((current) => { const next = { ...current }; delete next[key]; return next; })}>
              {L2.clear}
            </button>
          </div>
        ))}
        {structured.length > 0 ? (
          <p className="muted">{L2.customFieldsPreserved} {structured.join(', ')}</p>
        ) : null}
        <div className="inline-add">
          <input aria-label={L2.customFieldKey} placeholder={L2.customFieldKey} value={newKey}
            maxLength={80} onChange={(event) => setNewKey(event.target.value)} />
          <input aria-label={L2.customFieldValue} placeholder={L2.customFieldValue} value={newValue}
            maxLength={500} onChange={(event) => setNewValue(event.target.value)} />
          <button type="button" className="btn" onClick={add}>{L2.customFieldAdd}</button>
        </div>
        <button type="submit" className="btn btn-primary" disabled={!dirty || busy}>{L2.customFieldsSave}</button>
        <p role="status" className="save-status">{message}</p>
      </form>
    </section>
  );
}
