import { useEffect, useRef, useState, type FormEvent } from 'react';
import { get } from '../../lib/api';
import { notifyDraftChange, registerEditor } from '../../lib/draftGuard';
import { requestNewNote } from '../../lib/focusActions';
import { keys } from '../../lib/nodeData';
import { nodePath, navigate, useRoute } from '../../lib/router';
import { useQuery } from '../../lib/queryCache';
import type { MaterialItem, MaterialsView, NodeDTO, NoteEntry, NotesView, TreeView } from '../../lib/types';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';
import { Inspector } from '../inspector/Inspector';
import { UnconfirmedBadge } from '../agent/UnconfirmedMark';
import { entriesOf } from '../notes/NotesTab';
import { previewTargetOf } from '../materials/MaterialsTab';
import { MaterialFormatIcon } from '../materials/MaterialFormatIcon';

export function nearestWorkstream(node: NodeDTO, tree: TreeView | undefined): string | null {
  if (node.kind !== 'task' && node.kind !== 'action') return null;
  const all = new Map(tree?.nodes.map((row) => [row.id, row]) ?? []);
  const visited = new Set<string>();
  let parent = node.parentId;
  while (parent && !visited.has(parent)) {
    visited.add(parent);
    const found = all.get(parent);
    if (!found) return null;
    if (found.kind === 'workstream') return found.id;
    parent = found.parentId;
  }
  return null;
}
const titleOf = (item: NoteEntry) => item.title || 'Untitled note';

function QuickNoteComposer({ nodeId }: { nodeId: string }) {
  const [opened, setOpened] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const busy = useRef(false);
  const state = useRef({ title, text });
  state.current = { title, text };
  const dirty = () => Boolean(state.current.title.trim() || state.current.text.trim());
  useEffect(() => registerEditor(`quick-note:${nodeId}`, {
    dirty,
    // Incomplete Quick Note cannot silently save: the user must insert it into the single Note editor first.
    save: async () => false,
    discard: () => { state.current = { title: '', text: '' }; setTitle(''); setText(''); },
  }), [nodeId]);
  useEffect(() => notifyDraftChange(), [title, text]);
  const insert = (event: FormEvent) => {
    event.preventDefault();
    if (busy.current || !title.trim()) return;
    busy.current = true;
    requestNewNote(nodeId, { title: title.trim(), text });
    state.current = { title: '', text: '' };
    setTitle('');
    setText('');
    setOpened(false);
    // This is a draft, NOT yet saved to the backend. The central editor remains authoritative.
    navigate(nodePath(nodeId, 'notes'));
    busy.current = false;
  };
  return (
    <div className="context-quick-note">
      <button className="btn" type="button" onClick={() => setOpened((value) => !value)}>
        <Icon name="plus" size={14} /> Quick note
      </button>
      {opened ? (
        <form onSubmit={insert} aria-label="Quick note draft">
          <input aria-label="Quick note title" placeholder="Note name (required)" required value={title}
            maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          <textarea aria-label="Quick note content" placeholder="Record a thought..." rows={3} value={text}
            onChange={(e) => setText(e.target.value)} />
          <button className="btn btn-primary" type="submit" disabled={!title.trim()}>Insert into Notes draft</button>
          <p className="muted">Save the Notes workspace to publish this draft.</p>
        </form>
      ) : null}
    </div>
  );
}

function MaterialSection({ title, nodeId, items, shared }: {
  title: string; nodeId: string; items: MaterialItem[]; shared?: boolean;
}) {
  return (
    <section className="context-material-group" aria-label={title}>
      <h4>{title} <span className="context-count">{items.length}</span></h4>
      {items.length === 0 ? <p className="muted context-empty">None yet.</p> : (
        <ul className="context-items">
          {items.map((item) => {
            const target = previewTargetOf(item);
            const to = nodePath(nodeId, 'materials') + '?preview=' + encodeURIComponent(item.id);
            return (
              <li key={item.id} className="context-material file-compact-row" data-scope={shared ? 'shared' : 'direct'}>
                <MaterialFormatIcon name={item.name ?? item.title} materialType={item.materialType} format={item.format}/>
                <div className="file-compact-info">
                  {target ? (
                    target.kind === 'link' ? <a className="file-compact-name" href={target.url} target="_blank" rel="noopener noreferrer" title={item.title}>{item.title}</a> :
                    <AppLink to={to}>{item.title}</AppLink>
                  ) : <span className="file-compact-name" title={item.title}>{item.title}</span>}
                  <span className="muted context-meta">{item.purpose ?? item.materialType}
                    {shared && item.sourceTitle ? ` · ${item.sourceTitle}` : ''}
                    {item.publishedVersion ? ` · ${item.publishedVersion}` : ''}
                  </span>
                  {!target && item.materialType !== 'link' ? <span className="muted context-meta">File not linked yet</span> : null}
                </div>
                {item.missing ? <span className="flag flag-overdue">Missing</span> : null}
                {item.unconfirmed ? <UnconfirmedBadge /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Shared Context is read-only except the existing Inspector and deliberate Quick Note capture.
 * It never writes copies of inherited Notes or Materials. */
export function WorkContextBody({ node, mobile = false }: { node: NodeDTO; mobile?: boolean }) {
  const route = useRoute();
  const tree = useQuery<TreeView>('tree', (signal) => get<TreeView>('tree', {}, { signal }));
  const workstreamId = nearestWorkstream(node, tree.data);
  const own = useQuery<NotesView>(`notes:${node.id}:${node.revision}`,
    (signal) => get<NotesView>('notes', { id: node.id }, { signal }));
  const shared = useQuery<NotesView>(`notes:${workstreamId}:shared`,
    (signal) => get<NotesView>('notes', { id: workstreamId }, { signal }), { enabled: Boolean(workstreamId) });
  const materials = useQuery<MaterialsView>(`materials:${node.id}:${node.revision}`,
    (signal) => get<MaterialsView>('materials', { id: node.id }, { signal }));
  const [advanced, setAdvanced] = useState(false);
  const [panel, setPanel] = useState<'notes' | 'materials' | null>(null);
  const ownNotes = own.data ? entriesOf(own.data) : [];
  const sharedNotes = shared.data ? entriesOf(shared.data) : [];
  const direct = materials.data?.items ?? [];
  const inherited = materials.data?.inherited ?? [];

  useEffect(() => {
    if (route.name !== 'node' || route.id !== node.id) return;
    if (route.tab === 'materials') setPanel('materials');
    if (route.tab === 'notes') setPanel('notes');
  }, [route, node.id]);

  if (mobile) {
    return (
      <div className="focus-mobile-context" aria-label="Task context shortcuts">
        <button className="focus-mobile-pill" type="button" onClick={() => setPanel(panel === 'notes' ? null : 'notes')}>
          <Icon name="note" size={15} /> Notes {ownNotes.length}
        </button>
        <button className="focus-mobile-pill" type="button" onClick={() => setPanel(panel === 'materials' ? null : 'materials')}>
          <Icon name="paperclip" size={15} /> Materials {direct.length + inherited.length}
        </button>
        <button className="focus-mobile-pill" type="button" onClick={() => { requestNewNote(node.id); navigate(nodePath(node.id, 'notes')); }}>
          <Icon name="plus" size={15} /> New Note
        </button>
        {panel === 'notes' ? <div className="focus-mobile-expanded"><NoteLinks nodeId={node.id} notes={ownNotes} title="Current notes" /></div> : null}
        {panel === 'materials' ? (
          <div className="focus-mobile-expanded">
            <MaterialSection title="Direct Materials" nodeId={node.id} items={direct}/>
            <MaterialSection title="Workstream shared" nodeId={node.id} items={inherited} shared/>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="focus-context" data-node-id={node.id} aria-label="Work Context">
      <header className="focus-context-title">
        <span>Work Context</span>
        <span className="muted">{node.displayKind}</span>
      </header>
      <section className="context-properties" aria-label="Quick properties">
        <h3>Properties</h3>
        <div className="context-properties-grid">
          <span>Status <b>{node.status}</b></span>
          {node.assignee ? <span>Assignee <b>{node.assignee}</b></span> : null}
          {node.priority ? <span>Priority <b>{node.priority}</b></span> : null}
          {node.dueDate ? <span>Due <b>{node.dueDate}</b></span> : null}
        </div>
        <button type="button" className="btn context-property-toggle"
          onClick={() => setAdvanced((was) => !was)} aria-expanded={advanced}>Edit properties <Icon name="chevron-down" size={13}/></button>
        <div className="context-inspector-content" hidden={!advanced}><Inspector key={node.id} node={node} /></div>
      </section>
      <section id="focus-context-notes" className={panel === 'notes' ? 'context-group is-focused' : 'context-group'}>
        <div className="context-section-heading">
          <h3>Notes <span className="context-count">{ownNotes.length}</span></h3>
          <AppLink to={nodePath(node.id, 'notes')}>Open editor</AppLink>
        </div>
        <NoteLinks nodeId={node.id} notes={ownNotes} title="Current notes" />
        {workstreamId ? (
          <details className="context-shared-notes">
            <summary>Workstream shared Notes ({sharedNotes.length})</summary>
            <p className="muted">Read-only here. Edit at the owning Workstream.</p>
            <NoteLinks nodeId={workstreamId} notes={sharedNotes} title="Shared notes" />
          </details>
        ) : null}
        <QuickNoteComposer nodeId={node.id} />
      </section>
      <section id="focus-context-materials" className={panel === 'materials' ? 'context-group is-focused' : 'context-group'}>
        <div className="context-section-heading">
          <h3>Materials <span className="context-count">{direct.length + inherited.length}</span></h3>
          <AppLink to={nodePath(node.id, 'materials')}>View files</AppLink>
        </div>
        <MaterialSection title="Direct" nodeId={node.id} items={direct}/>
        {node.kind === 'task' || node.kind === 'action' ? (
          <MaterialSection title="Workstream shared" nodeId={node.id} items={inherited} shared/>
        ) : null}
        {(materials.data?.fileHubRefs ?? []).length ? (
          <div className="context-filehub">
            <h4>File Hub references</h4>
            {(materials.data?.fileHubRefs ?? []).map((ref) => (
              <div className="file-compact-row" key={ref.fileId}>
                <MaterialFormatIcon name={ref.name}/>
                <div className="file-compact-info">
                  <AppLink to={nodePath(node.id, 'materials') + '?preview=' + encodeURIComponent(ref.fileId)}>{ref.name}</AppLink>
                  <span className="muted context-meta">File Hub</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      <details className="context-audit">
        <summary>History &amp; audit · Revision {node.revision}</summary>
        <AppLink to={nodePath(node.id, 'activity')}>View activity &amp; agent history</AppLink>
        {node.unconfirmed.length > 0 ? <UnconfirmedBadge /> : null}
      </details>
    </div>
  );
}

function NoteLinks({ nodeId, notes, title }: { nodeId: string; notes: NoteEntry[]; title: string }) {
  return notes.length ? (
    <ul className="context-items" aria-label={title}>
      {notes.slice(0, 10).map((item) => (
        <li key={item.id}>
          <AppLink to={nodePath(nodeId, 'notes') + '?note=' + encodeURIComponent(item.id)}>{titleOf(item)}</AppLink>
        </li>
      ))}
    </ul>
  ) : <p className="muted context-empty">No notes yet.</p>;
}

/** Replaces NodeInspector for Workstream, Campaign and Task; legacy other nodes remain unchanged. */
export function WorkContextPanel({ id }: { id: string }) {
  const query = useQuery<NodeDTO>(keys.node(id), (signal) => get<NodeDTO>('node', { id }, { signal }));
  if (!query.data) return <p className="muted">Loading context…</p>;
  if (!['initiative', 'knowledge_collection', 'topic', 'workstream', 'campaign', 'task', 'action'].includes(query.data.kind)) {
    // Defensive: leave the original inspector mounted for non-Focus kinds.
    return <Inspector node={query.data}/>;
  }
  return <WorkContextBody key={id} node={query.data}/>;
}
