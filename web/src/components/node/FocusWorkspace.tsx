import { useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { get } from '../../lib/api';
import { addDays, isOverdue, localNow, localToday } from '../../lib/dates';
import { nodePath, navigate, useAppPath } from '../../lib/router';
import { useQuery } from '../../lib/queryCache';
import { sanitizeHtml } from '../../lib/sanitize';
import { type NotesView, type MaterialsView, type NodeDTO, type TabId, type TaskRow, type TasksView } from '../../lib/types';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';
import { previewTargetOf } from '../materials/MaterialsTab';
import { MaterialsExplorerV3 as MaterialsTab } from '../materials/MaterialsExplorerV3';
import { NotesTab } from '../notes/NotesTab';
import { PreviewContent, type PreviewTarget } from '../preview/PreviewDrawer';
import { TasksTab } from '../tasks/TasksTab';
import { ActivityTab } from './ActivityTab';
import { SummaryBlock } from './OverviewTab';
import { Inspector } from '../inspector/Inspector';
import { nearestWorkstream } from './WorkContextPanel';

export function isFocusKind(kind: NodeDTO['kind']) {
  return kind === 'workstream' || kind === 'campaign' || kind === 'task' || kind === 'action';
}
const isTask = (node: NodeDTO) => node.kind === 'task' || node.kind === 'action';
/** L3 is the last level for new work; historical L4 records stay accessible. */
export const isTerminalL3 = (node: NodeDTO): boolean => isTask(node) && node.depth === 3;

/** L2/L3 URL-backed tab strip. Existing canonical paths and keyboard navigation remain intact. */
function FocusTabs({ node, tab }: { node: NodeDTO; tab: TabId }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const terminal = isTerminalL3(node);
  const choices: TabId[] = terminal ? ['notes', 'materials'] : ['overview', 'notes', 'materials'];
  const selectedTab = terminal && (tab === 'overview' || tab === 'tasks') ? 'notes' :
    tab === 'tasks' ? 'overview' : tab;
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = Math.max(0, choices.indexOf(selectedTab));
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % choices.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + choices.length) % choices.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = choices.length - 1;
    if (next < 0) return;
    event.preventDefault();
    navigate(nodePath(node.id, choices[next]!));
    window.setTimeout(() => refs.current[next]?.focus(), 0);
  };
  return <div className="tabs focus-tabs" role="tablist" aria-label="Workstream and Task workspace tabs" onKeyDown={onKey}>
    {choices.map((item, index) =>
      <button type="button" role="tab" key={item} ref={(el) => { refs.current[index] = el; }}
        id={`focus-tab-${item}`} className={selectedTab === item ? 'tab is-active' : 'tab'}
        aria-selected={selectedTab === item} aria-controls="focus-tabpanel" tabIndex={selectedTab === item ? 0 : -1}
        onClick={() => navigate(nodePath(node.id, item))}>{item === 'overview' ? 'Task Overview' : item === 'notes'?'Notes':'Materials'}</button>)}
  </div>;
}

function AdditionalDetails({ node }: { node: NodeDTO }) {
  return <details className="focus-additional-details" key={node.id}>
    <summary><Icon name="settings" size={15}/> Additional Details
      <span className="muted">Assignee · Reminders · Repeat · Tags · Links</span></summary>
    <Inspector key={node.id} node={node} hideCore/>
  </details>;
}

function SharedNotes({ node }: { node: NodeDTO }) {
  const tree = useQuery<import('../../lib/types').TreeView>('tree',
    (signal) => get('tree', {}, { signal }));
  const owner = nearestWorkstream(node, tree.data);
  const notes = useQuery<import('../../lib/types').NotesView>(`focus:shared-notes:${owner ?? 'none'}`,
    (signal) => get('notes', { id: owner }, { signal }), { enabled: Boolean(owner) });
  const items = notes.data?.items ?? [];
  if (!owner || !items.length) return null;
  return <details className="focus-shared-notes">
    <summary>Workstream shared Notes ({items.length}) · read-only here</summary>
    <nav aria-label="Shared Workstream Notes">
      {items.map((entry) => <AppLink key={entry.id} to={nodePath(owner, 'notes')+'?note='+encodeURIComponent(entry.id)}>
        {entry.title || 'Untitled Note'}
      </AppLink>)}
    </nav>
  </details>;
}


function WorkstreamBrief({ node }: { node: NodeDTO }) {
  const sanitized = node.summary.html ? sanitizeHtml(node.summary.html) : null;
  return (
    <details className="focus-brief">
      <summary><Icon name="overview" size={17} /> Workstream brief
        <span className="muted">{node.summary.text || node.description ? 'View details & edit' : 'Not written yet · add a brief'}</span>
      </summary>
      {node.description ? <p>{node.description}</p> : null}
      {sanitized?.ok ? <div className="summary-html" dangerouslySetInnerHTML={{ __html: sanitized.html }} /> : null}
      <SummaryBlock node={node}/>
    </details>
  );
}

function Attention({ node }: { node: NodeDTO }) {
  const query = useQuery<TasksView>(`focus:tasks:${node.id}`, (signal) => get<TasksView>(
    'tasks', { scope: 'node', id: node.id, direct: 0, now: localNow() }, { signal }));
  const today = localToday();
  const shortly = addDays(today, 7);
  const tasks = query.data?.items ?? [];
  const priorities = useMemo(() => tasks.filter((task) =>
    task.status === 'Blocked' || task.status === 'Waiting' || isOverdue(task.dueDate, task.status, today) || (task.dueDate && task.dueDate >= today && task.dueDate <= shortly && task.status !== 'Done'),
  ).sort((a, b) => {
    const rank = (t: TaskRow) => t.status === 'Blocked' ? 0 : isOverdue(t.dueDate, t.status, today) ? 1 :
      t.status === 'Waiting' ? 2 : 3;
    return rank(a) - rank(b) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.title.localeCompare(b.title);
  }).slice(0, 8), [tasks, today, shortly]);
  const summary = [
    { label: 'Open', count: tasks.filter((t) => t.status !== 'Done').length },
    { label: 'Blocked', count: tasks.filter((t) => t.status === 'Blocked').length },
    { label: 'In progress', count: tasks.filter((t) => t.status === 'In Progress').length },
    { label: 'Due soon', count: tasks.filter((t) => t.status !== 'Done' && t.dueDate && t.dueDate <= shortly).length },
  ];
  return (
    <>
      <section className="focus-metrics" aria-label="Workstream task status">
        {summary.map((s) => (
          <div key={s.label} className="focus-metric"><strong>{s.count}</strong><span>{s.label}</span></div>
        ))}
      </section>
      <section className={priorities.length?'focus-attention has-attention':'focus-attention is-empty'} aria-label="Needs attention">
        {query.status === 'error' ? <p className="error-text" role="alert">Could not load tasks. Try reloading.</p> :
         priorities.length === 0 ? <details><summary>Needs attention · 0</summary><p className="muted">Nothing urgent.</p></details> :
         <><div className="focus-section-head"><h2>Needs attention · {priorities.length}</h2>
           <span className="muted">Blocked, Waiting, overdue and upcoming</span></div><ul className="focus-attention-list">
           {priorities.map((task) => (
             <li key={task.id} data-focus-task={task.id}>
               <AppLink to={nodePath(task.id)} className="focus-attention-title">{task.title}</AppLink>
               <span className="chip" data-status={task.status}>{task.status}</span>
               {task.assignee ? <span className="muted">{task.assignee}</span> : null}
               {task.dueDate ? <span className={isOverdue(task.dueDate, task.status, today) ? 'flag flag-overdue' : 'muted'}>{task.dueDate}</span> : null}
             </li>
           ))}
         </ul></>}
      </section>
    </>
  );
}
function SectionTitle({title,desc}:{title:string;desc?:string}) {
  return <div className="focus-section-head"><h2>{title}</h2>{desc ? <span className="muted">{desc}</span> : null}</div>;
}
function CentralMaterialPreview({ node, refId }: { node: NodeDTO; refId: string }) {
  const query = useQuery<MaterialsView>(`materials:${node.id}:${node.revision}`,
    (signal) => get<MaterialsView>('materials', { id: node.id }, { signal }));
  const target = useMemo<PreviewTarget | null>(() => {
    const data = query.data;
    if (!data) return null;
    const item = [...data.items, ...(data.inherited ?? [])].find((entry) => entry.id === refId || entry.fileId === refId);
    if (item) return previewTargetOf(item);
    const linked = (data.fileHubRefs ?? []).find((item) => item.fileId === refId);
    return linked ? { kind: 'file', fileId: linked.fileId, name: linked.name, size: linked.size, missing: linked.missing } : null;
  }, [query.data, refId]);
  // Return to the Materials tab rather than reopening a closed document.
  const back = () => navigate(nodePath(node.id, 'materials'), { replace: true });
  return (
    <section className="focus-document-preview" aria-label="Material preview">
      <div className="focus-preview-head">
        <button className="btn" type="button" onClick={back}><Icon name="chevron-right" size={15} /> Back to Materials</button>
        <div><h2>{target?.kind === 'file' ? target.name : target?.title ?? 'Material preview'}</h2>
          <span className="muted">Preview from the current Work context</span></div>
      </div>
      {!query.data ? <p className="muted">Loading file reference…</p> : target ? (
        <div className="focus-preview-content"><PreviewContent target={target}/></div>
      ) : <p role="alert">This file is not linked to the current Task or Workstream.</p>}
    </section>
  );
}
function FocusTask({ node, tab, preview }: { node: NodeDTO; tab: TabId; preview: string | null }) {
  const terminal = isTerminalL3(node);
  const other = terminal && (tab === 'overview' || tab === 'tasks') ? 'notes' :
    tab === 'tasks' ? 'overview' : tab;
  const notes = useQuery<NotesView>(`notes:${node.id}:${node.revision}`,
    (signal)=>get<NotesView>('notes',{id:node.id},{signal}), {enabled:other==='overview'});
  const notebookStatus=useQuery<{ready:boolean}>('notebook-status',
    signal=>get('notebook-status',{}, {signal}), {enabled:other==='overview'});
  const pageSummary=useQuery<{total:number}>('notebook-pages:summary:'+node.id,
    signal=>get('notebook-pages',{id:node.id,limit:0},{signal}),
    {enabled:other==='overview'&&Boolean(notebookStatus.data?.ready)});
  const noteCount=notebookStatus.data?.ready ? (pageSummary.data?.total??0) :
    notes.data ? (notes.data.items.length || (notes.data.legacyNote ? 1 : 0)) : 0;
  return (
    <div className="focus-task" data-focus-role="task">
      {preview ? <CentralMaterialPreview node={node} refId={preview} /> : null}
      {!preview && other === 'activity' ? <ActivityTab node={node}/> : null}
      {!preview && other === 'materials' ? <MaterialsTab node={node}/> : null}
      {!preview && other === 'overview' ? <>
        {node.description ? <details className="focus-task-brief" open>
          <summary>Task Brief</summary><p>{node.description}</p>
        </details> : <p className="focus-inline-empty">No Task Brief · use title More to add a description.</p>}
        <section aria-label="Sub-Tasks">
          <SectionTitle title="Sub-Tasks" desc="Tasks nested under this work item"/>
          {node.childCount ? <TasksTab node={node}/> :
            <p className="focus-inline-empty">No Sub-Tasks · use + in the title to create one.</p>}
        </section>
        <section className="focus-notes-summary" aria-label="Notes summary">
          <span><Icon name="list" size={16}/> Notes <strong>{noteCount}</strong></span>
          <AppLink className="btn" to={nodePath(node.id,'notes')}>Open Notes</AppLink>
        </section>
        <AdditionalDetails node={node}/>
      </> : null}
      {/* One writable Notes editor, mounted only on its Notes tab.
          Draft Guard blocks navigation away while the editor is dirty. */}
      {!preview && other === 'notes' ? <div className="focus-notes-workspace" aria-label="Task Notes Workspace">
        {!terminal ? <SectionTitle title="Working Notes" desc="Your primary workspace · explicitly save changes"/> : null}
        <NotesTab node={node} focused/>
        <SharedNotes node={node}/>
      </div> : null}
    </div>
  );
}
function FocusWorkstream({ node, tab, preview }: { node: NodeDTO; tab: TabId; preview: string | null }) {
  const other = tab === 'activity' ? 'activity' : tab === 'notes' ? 'notes' : tab === 'materials' ? 'materials' : 'overview';
  return (
    <div className="focus-workstream" data-focus-role="workstream">
      {preview ? <CentralMaterialPreview node={node} refId={preview}/> : null}
      {!preview && other === 'activity' ? <ActivityTab node={node}/> : null}
      {!preview && other === 'materials' ? <MaterialsTab node={node}/> : null}
      <div hidden={Boolean(preview) || other !== 'overview'}>
          <Attention node={node}/>
          <section id="focus-workstream-tasks" aria-label="All Tasks">
            <SectionTitle title="All Tasks"/>
            <TasksTab node={node}/>
          </section>
          <WorkstreamBrief node={node}/>
          <AdditionalDetails node={node}/>
      </div>
      <div className="focus-notes-workspace" hidden={Boolean(preview) || other !== 'notes'} aria-label="Workstream Notes Workspace">
        <SectionTitle title="Workstream Notes" desc="Notes belonging to this Workstream"/>
        <NotesTab node={node} focused/>
      </div>
    </div>
  );
}

/** Role-aware main area. AppShell still owns the real 3 columns, no nested grid. */
export function FocusWorkspace({ node, tab, quickAccess }: { node: NodeDTO; tab: TabId; quickAccess?: ReactNode }) {
  const path = useAppPath();
  const params = new URLSearchParams(path.split('?')[1] ?? '');
  const preview = params.get('preview');
  const task = isTask(node);
  return (
    <section className="focus-workspace" data-focus-kind={task ? 'task' : 'workstream'}
      data-terminal-l3={isTerminalL3(node) ? "true" : undefined}>

      <FocusTabs node={node} tab={tab}/>
      {quickAccess ? <div className="focus-shortcuts-row" aria-label="Inherited Quick Access shortcuts">{quickAccess}</div> : null}
      <div id="focus-tabpanel" role="tabpanel"
        aria-labelledby={tab==='activity'?undefined:`focus-tab-${isTerminalL3(node)&&(tab==='tasks'||tab==='overview')?'notes':tab==='tasks'?'overview':tab}`}
        aria-label={tab==='activity'?'Activity / Revision history':undefined} className="focus-tab-content">
        {task ? <FocusTask node={node} tab={tab} preview={preview}/> :
          <FocusWorkstream node={node} tab={tab} preview={preview}/>}
      </div>
    </section>
  );
}
