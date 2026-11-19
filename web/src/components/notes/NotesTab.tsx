import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get, post } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { L, L3 } from '../../lib/labels';
import { afterWrite, isConflict } from '../../lib/nodeData';
import { cleanNoteHtml, MAX_NOTES, newNoteId } from '../../lib/noteHtml';
import { useQuery } from '../../lib/queryCache';
import { readJson, writeJson } from '../../lib/storage';
import { useAppPath } from '../../lib/router';
import { notifyDraftChange, registerEditor } from '../../lib/draftGuard';
import { consumeNewNotes, listenNewNote } from '../../lib/focusActions';
import type { NodeDTO, NodeResult, NoteEntry, NotesView } from '../../lib/types';
import { useAnnounce } from '../announce';
import { Icon } from '../icons';
import { NoteEditor, type Draft } from './NoteEditor';
import { NotebookV3 } from './NotebookV3';

type ExpandedMap = Record<string, boolean>;

function validateExpanded(value: unknown): ExpandedMap | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: ExpandedMap = {};
  for (const [key, flag] of Object.entries(value)) if (typeof flag === 'boolean') out[key] = flag;
  return out;
}

const uiKey = (nodeId: string) => `notes-ui:${nodeId}`;

export function entriesOf(view: NotesView): NoteEntry[] {
  if (view.items.length > 0 || !view.legacyNote) return view.items;
  return [{ id: view.legacyNote.id, title: view.legacyNote.title, html: view.legacyNote.html }];
}

function toDrafts(entries: NoteEntry[], expanded: ExpandedMap, previous: Draft[] = []): Draft[] {
  return entries.map((entry) => {
    const old = previous.find((item) => item.id === entry.id);
    return {
      id: entry.id,
      title: entry.title,
      html: entry.html,
      expanded: expanded[entry.id] ?? old?.expanded ?? true,
      sync: (old?.sync ?? 0) + 1,
    };
  });
}

const asEntries = (drafts: Draft[]): NoteEntry[] => drafts.map(({ id, title, html }) => ({ id, title, html }));

function scrollContainer(): HTMLElement | null {
  return document.getElementById('main');
}

/** 笔记 Tab：每条 Note 一个稳定 key 的可折叠卡片；「保存所有 Notes」一次 notes-save。 */
export function LegacyNotesTab({ node, focused = false }: { node: NodeDTO; focused?: boolean }) {
  const announce = useAnnounce();
  const routePath = useAppPath();
  const focusedNoteId = focused ? new URLSearchParams(routePath.split('?')[1] ?? '').get('note') : null;
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [showAllNotes, setShowAllNotes] = useState(() => !focusedNoteId);
  useEffect(() => { if (focusedNoteId) setShowAllNotes(false); }, [focusedNoteId]);
  const query = useQuery<NotesView>(`notes:${node.id}:${node.revision}`, (signal) =>
    get<NotesView>('notes', { id: node.id }, { signal }),
  );
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rebase, setRebase] = useState<number | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [legacyId, setLegacyId] = useState<string | null>(null);
  const baseRef = useRef(node.revision);
  const editSeq = useRef(0);
  const savedRev = useRef(0);
  const draftsRef = useRef<Draft[] | null>(null);
  draftsRef.current = drafts;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  useEffect(() => registerEditor(`notes:${node.id}`, {
    dirty: () => dirtyRef.current,
    save: () => saveRef.current(),
    discard: () => { dirtyRef.current = false; setDirty(false); },
  }), [node.id]);
  useEffect(() => notifyDraftChange(), [dirty]);

  // 首次载入，或（无未保存修改时）服务端内容变化后同步草稿。
  useEffect(() => {
    const data = query.data;
    if (!data || node.revision < savedRev.current) return;
    const incoming = entriesOf(data);
    const current = draftsRef.current;
    if (current === null) {
      baseRef.current = node.revision;
      setLegacyId(data.items.length === 0 && data.legacyNote ? data.legacyNote.id : null);
      setDrafts(toDrafts(incoming, readJson(uiKey(node.id), validateExpanded, {})));
      return;
    }
    if (dirty || saving) return;
    baseRef.current = node.revision;
    if (JSON.stringify(incoming) === JSON.stringify(asEntries(current))) return;
    setLegacyId(data.items.length === 0 && data.legacyNote ? data.legacyNote.id : null);
    setDrafts(toDrafts(incoming, {}, current));
  }, [query.data, node.id, node.revision, dirty, saving]);

  const persistExpanded = (list: Draft[]) => {
    const map: ExpandedMap = {};
    for (const item of list) map[item.id] = item.expanded;
    writeJson(uiKey(node.id), map);
  };

  const edit = useCallback((change: (list: Draft[]) => Draft[]) => {
    editSeq.current += 1;
    setDirty(true);
    setDrafts((list) => change(list ?? []));
  }, []);

  const onTitle = useCallback(
    (id: string, title: string) => {
      setProblems((p) => (p[id] ? { ...p, [id]: '' } : p));
      edit((list) => list.map((item) => (item.id === id ? { ...item, title } : item)));
    },
    [edit],
  );
  const onHtml = useCallback(
    (id: string, html: string) => edit((list) => list.map((item) => (item.id === id ? { ...item, html } : item))),
    [edit],
  );
  const onToggle = useCallback(
    (id: string) => {
      setDrafts((list) => {
        const next = (list ?? []).map((item) => (item.id === id ? { ...item, expanded: !item.expanded } : item));
        persistExpanded(next);
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node.id],
  );
  const onDelete = useCallback(
    (id: string) => edit((list) => list.filter((item) => item.id !== id)),
    [edit],
  );

  const add = () => {
    if ((draftsRef.current?.length ?? 0) >= MAX_NOTES) return;
    const created: Draft = { id: newNoteId(), title: '', html: '', expanded: true, sync: 1 };
    setSelectedNoteId(created.id);
    edit((list) => [...list, created]);
  };
  useEffect(() => {
    if (!focused || !drafts?.length) return;
    if (focusedNoteId && drafts.some((draft) => draft.id === focusedNoteId)) {
      setSelectedNoteId(focusedNoteId);
    } else if (!selectedNoteId || !drafts.some((draft) => draft.id === selectedNoteId)) {
      setSelectedNoteId(drafts[0]?.id ?? null);
    }
  }, [focused, focusedNoteId, selectedNoteId, drafts]);
  // Context Quick Note enters the SAME editor draft collection, never an independent server write.
  useEffect(() => {
    if (drafts === null) return undefined;
    const applyPending = () => {
      const pending = consumeNewNotes(node.id);
      if (!pending.length) return;
      edit((list) => {
        const available = Math.max(0, MAX_NOTES - list.length);
        const added = pending.slice(0, available).map((item) => ({
          id: newNoteId(), title: item.title.trim(),
          html: item.text ? `<p>${item.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>` : '',
          expanded: true, sync: 1,
        }));
        if (added.length) setSelectedNoteId(added[0]?.id ?? null);
        return [...list, ...added];
      });
    };
    applyPending();
    return listenNewNote(node.id, applyPending);
    // Register only on initial load; future updates arrive from the event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, drafts === null]);

  const save = async (useRebase = false): Promise<boolean> => {
    if (saving || drafts === null) return false;
    const found: Record<string, string> = {};
    const entries: NoteEntry[] = [];
    for (const draft of drafts) {
      if (draft.title.trim() === '') found[draft.id] = L3.noteTitleRequired;
      const cleaned = cleanNoteHtml(draft.html);
      if (!cleaned.ok) {
        setError(L3.notesInvalid);
        return false;
      }
      entries.push({ id: draft.id, title: draft.title.trim(), html: cleaned.html });
    }
    setProblems(found);
    if (Object.keys(found).length > 0) {
      setError(L3.noteTitleRequired);
      return false;
    }
    const container = scrollContainer();
    const top = container?.scrollTop ?? 0;
    const pageTop = window.scrollY;
    const seq = editSeq.current;
    setSaving(true);
    setError(null);
    try {
      const result = await post<NodeResult>('notes-save', {
        id: node.id,
        baseRevision: useRebase && rebase !== null ? rebase : baseRef.current,
        entries,
      });
      baseRef.current = result.node.revision;
      savedRev.current = result.node.revision;
      setRebase(null);
      if (editSeq.current === seq) {
        setDrafts((list) => (list ?? []).map((item, i) => ({ ...item, title: entries[i]?.title ?? item.title, html: entries[i]?.html ?? item.html })));
        dirtyRef.current = false;
        setDirty(false);
        notifyDraftChange();
      }
      setLegacyId(null);
      afterWrite(result.node);
      announce(L3.notesSaved);
      return editSeq.current === seq;
    } catch (failure) {
      if (isConflict(failure)) {
        setRebase(failure.currentRevision ?? failure.current?.revision ?? null);
        setError(`${L3.notesConflict} (${L.conflictRevision} ${failure.currentRevision ?? ''})`);
        announce(L3.notesConflict);
      } else if (failure instanceof ApiError && failure.code === 'note_html_invalid') {
        setError(L3.notesInvalid);
        announce(L3.notesInvalid);
      } else {
        const text = `${L.saveFailed}: ${describeError(failure)}. ${L.draftKept}`;
        setError(text);
        announce(text);
      }
      return false;
    } finally {
      setSaving(false);
      // 保存后保持页面纵向滚动位置。
      requestAnimationFrame(() => {
        if (container) container.scrollTop = top;
        if (pageTop) window.scrollTo({ top: pageTop });
      });
    }
  };

  saveRef.current = () => save(false);

  if (drafts === null) {
    if (query.status === 'error') {
      return (
        <p role="alert" className="error-text">
          {describeError(query.error)}
        </p>
      );
    }
    return (
      <p className="muted" role="status">
        {L.loading}
      </p>
    );
  }

  const unconfirmed = query.data?.unconfirmed ?? {};
  const full = drafts.length >= MAX_NOTES;
  return (
    <div className="tab-stack notes-tab" data-notes-dirty={dirty ? 'true' : 'false'}>
      <div className="notes-toolbar">
        <button type="button" className="btn btn-primary" onClick={() => void save(false)} disabled={saving}>
          {saving ? L3.notesSaving : L3.notesSaveAll}
        </button>
        <button type="button" className="btn btn-icon" onClick={add} disabled={full} aria-label={L3.notesAdd} title={L3.notesAdd}>
          <Icon name="plus" />
        </button>
        {dirty ? <span className="muted">{L3.notesDirty}</span> : null}
        {full ? <span className="muted">{L3.notesLimit}</span> : null}
      </div>
      {error ? (
        <div role="alert" className="error-text notes-error">
          <p>{error}</p>
          {rebase !== null ? (
            <button type="button" className="btn" onClick={() => void save(true)}>
              {L3.notesRebase}
            </button>
          ) : null}
        </div>
      ) : null}
      {drafts.length === 0 ? <p className="muted">{L.notesEmpty} Use + to create your first Note.</p> : null}
      {drafts.length > 1 ? (
        <nav className="focus-note-index" aria-label="Select a Note">
          <button type="button" className={showAllNotes ? 'focus-note-choice is-active' : 'focus-note-choice'}
            aria-pressed={showAllNotes}
            onClick={() => setShowAllNotes(true)}>All Notes ({drafts.length})</button>
          {drafts.map((entry, i) => <button type="button" key={entry.id}
            className={!showAllNotes && entry.id === selectedNoteId ? 'focus-note-choice is-active' : 'focus-note-choice'}
            aria-current={!showAllNotes && entry.id === selectedNoteId ? 'true' : undefined}
            onClick={() => { setSelectedNoteId(entry.id); setShowAllNotes(false); }}>
            <span className="note-index-number">{String(i + 1).padStart(2, '0')}</span>
            {entry.title || 'Untitled Note'}
          </button>)}
        </nav>
      ) : null}
      <div className="note-list" aria-label={L3.noteListLabel} role="group">
        {drafts.map((draft, index) => (!showAllNotes && selectedNoteId && selectedNoteId !== draft.id ? null : (
          <NoteEditor
            key={draft.id}
            nodeId={node.id}
            ordinal={index + 1}
            draft={draft}
            titleProblem={problems[draft.id] || null}
            unconfirmedWriteId={unconfirmed[draft.id] ?? null}
            legacy={draft.id === legacyId}
            lastModifiedAt={query.data?.modifiedAt?.[draft.id]}
            onTitle={onTitle}
            onHtml={onHtml}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        )))}
      </div>
    </div>
  );
}

/** Controlled V3 cutover: never mount the legacy write-all editor after migration. */
export function NotesTab({node,focused=false}:{node:NodeDTO;focused?:boolean}) {
  const status=useQuery<{ready:boolean}>('notebook-status',signal=>get('notebook-status',{}, {signal}));
  if(status.status==='error'){
    // A pre-V3 Work server has no notebook-status route; retain the legacy editor
    // for compatibility. After V3 migration this endpoint is present, and any
    // ordinary transport/server error must fail closed rather than write old Notes.
    if(status.error instanceof ApiError && status.error.code==='unknown_view' && status.error.status===404)
      return <LegacyNotesTab node={node} focused={focused}/>;
    return <p role="alert" className="error-text">Notes state unavailable. Do not edit until connection recovers.</p>;
  }
  if(!status.data)return <p className="muted" role="status">Loading Notebook…</p>;
  return status.data.ready ? <NotebookV3 key={node.id} node={node}/> :
    <LegacyNotesTab node={node} focused={focused}/>;
}
