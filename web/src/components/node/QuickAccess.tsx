import { useEffect, useRef, useState, type DragEvent, type FormEvent, type TouchEvent } from 'react';
import { post } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { registerEditor, notifyDraftChange } from '../../lib/draftGuard';
import { afterWrite } from '../../lib/nodeData';
import type { NodeDTO, NodeResult, ResourceLink, ResourceLinkKind } from '../../lib/types';
import { useAnnounce } from '../announce';
import { Icon } from '../icons';
import { AppLink } from '../AppLink';
import { nodePath } from '../../lib/router';
import { OverlayDialog } from '../OverlayDialog';
import { ShortcutIcon, visualShortcutKind } from './ShortcutIcon';

const KINDS: Array<{ id: ResourceLinkKind; title: string; short: string }> = [
  { id: 'folder', title: 'Windows / WSL folder', short: 'Folder' },
  { id: 'sharepoint', title: 'SharePoint', short: 'SharePoint' },
  { id: 'eridoc', title: 'EriDoc', short: 'EriDoc' },
  { id: 'teams', title: 'Microsoft Teams Group / Channel', short: 'Teams' },
  { id: 'link', title: 'Other useful link', short: 'Web' },
];

const titleOf = (kind: ResourceLinkKind) => KINDS.find((entry) => entry.id === kind)?.short ?? 'Link';
const shortcutTypeLabel = (item: ResourceLink) => {
  const visual = visualShortcutKind(item.kind, item.target);
  return visual === 'wsl' ? 'WSL folder' : visual === 'windows' ? 'Windows Explorer' : titleOf(item.kind);
};
function localPath(value: string): boolean {
  if (!value || value.length > 1200 || value.trim() !== value) return false;
  if (/[\u0000-\u001f\u007f]/.test(value) || /(^|[\\/])\.{1,2}([\\/]|$)/.test(value)) return false;
  return /^\/(?!\/)/.test(value) ||
    /^[a-z]:\\/i.test(value) ||
    /^\\\\wsl(?:\$|\.localhost)\\[^\\]+\\/i.test(value);
}
function validTarget(kind: ResourceLinkKind, value: string) {
  if (kind === 'folder') return localPath(value);
  try {
    if (/[\\<>\u0000-\u001f\u007f]/.test(value) || value !== value.trim()) return false;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
function newId() {
  return 'shortcut-' + crypto.randomUUID().replace(/-/g, '');
}
interface Draft {
  kind: ResourceLinkKind;
  title: string;
  target: string;
  editing: string | null;
}
const BLANK: Draft = { kind: 'folder', title: '', target: '', editing: null };

export function moveShortcut(items: ResourceLink[], sourceId: string, targetId: string): ResourceLink[] {
  const from = items.findIndex((entry) => entry.id === sourceId);
  const to = items.findIndex((entry) => entry.id === targetId);
  if (from < 0 || to < 0 || from === to) return items;
  const result = [...items];
  const [moved] = result.splice(from, 1);
  if (!moved) return items;
  result.splice(to, 0, moved);
  return result;
}

/** L1-only metadata; never imports a local folder or connects to Microsoft APIs.
 * Every save uses node-update + baseRevision, preserving standard Work audit.
 */
export function QuickAccess({ node, inherited = false }: { node: NodeDTO; inherited?: boolean }) {
  const announce = useAnnounce();
  const dragId = useRef<string | null>(null);
  const touchStart = useRef<{ id: string; x: number; y: number } | null>(null);
  const suppressClickUntil = useRef(0);
  const [editing, setEditing] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({ ...BLANK });
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const items = node.resourceLinks ?? [];
  const originalShortcut=items.find(item=>item.id===draft.editing);
  const dirty=!inherited&&editing&&(draft.editing
    ? !originalShortcut||originalShortcut.title!==draft.title||originalShortcut.kind!==draft.kind||originalShortcut.target!==draft.target
    : draft.title.trim()!==''||draft.target.trim()!==''||draft.kind!==BLANK.kind);
  const changes = async (next: ResourceLink[]): Promise<boolean> => {
    setBusy(true);setError(null);
    try {
      const result = await post<NodeResult>('node-update', {
        id: node.id, baseRevision: node.revision, changes: { resourceLinks: next },
      });
      afterWrite(result.node);
      announce('Quick Access saved');
      return true;
    } catch (err) {
      setError(`Could not save Quick Access. ${describeError(err)}. Any unsaved entry stays in the form.`);
      return false;
    } finally { setBusy(false); }
  };
  const reorder = async (sourceId: string, targetId: string) => {
    if (inherited || busy || editing) return;
    const next = moveShortcut(items, sourceId, targetId);
    if (next !== items) await changes(next);
  };
  const dragStart = (event: DragEvent<HTMLElement>, id: string) => {
    if (inherited || editing || busy) { event.preventDefault(); return; }
    dragId.current = id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  };
  const drop = (event: DragEvent<HTMLElement>, id: string) => {
    if (!dragId.current) return;
    event.preventDefault();
    const source = dragId.current;
    dragId.current = null;
    void reorder(source, id);
  };
  const touchBegin = (event: TouchEvent<HTMLElement>, id: string) => {
    if (inherited || busy || editing) return;
    const point = event.touches[0];
    if (point) touchStart.current = { id, x: point.clientX, y: point.clientY };
  };
  const touchEnd = (event: TouchEvent<HTMLElement>) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || inherited || busy || editing) return;
    const point = event.changedTouches[0];
    if (!point || Math.abs(point.clientX - start.x) < 22 ||
        Math.abs(point.clientX - start.x) < Math.abs(point.clientY - start.y)) return;
    const endElement = document.elementFromPoint(point.clientX, point.clientY);
    const target = endElement?.closest<HTMLElement>('[data-shortcut-id]')?.dataset.shortcutId;
    if (!target || target === start.id) return;
    event.preventDefault();
    suppressClickUntil.current = Date.now() + 750;
    void reorder(start.id, target);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.title.trim();
    const target = draft.target.trim();
    if (!title || title.length > 120 || !validTarget(draft.kind, target)) {
      setError(draft.kind === 'folder'
        ? 'Enter a name and an absolute Windows drive or local WSL folder path.'
        : 'Enter a name and a valid HTTPS / HTTP URL without embedded credentials.');
      return;
    }
    const entry: ResourceLink = { id: draft.editing ?? newId(), title, target, kind: draft.kind };
    const next = draft.editing ? items.map((item) => item.id === draft.editing ? entry : item) : [...items, entry];
    if (await changes(next)) {
      setEditing(false);setManagerOpen(false);setDraft({ ...BLANK });setInfo(null);
    }
  };
  const remove = async (id: string) => {
    if (await changes(items.filter((item) => item.id !== id))) {
      setPendingRemove(null);
    }
  };
  const open = async (id: string) => {
    setOpening(id);setError(null);setInfo(null);
    try {
      const response = await fetch('/api/work-hub/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: node.id, shortcutId: id }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as {error?: string};
        throw Error(payload.error ?? `HTTP ${response.status}`);
      }
      setInfo('Requested Windows File Explorer on the computer running KB_Work. If the window is not visible, use Copy path.');
    } catch (err) {
      setError(`Could not open this folder on the Windows host. ${err instanceof Error ? err.message : 'Please copy the path instead.'}`);
    } finally { setOpening(null); }
  };
  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setInfo('Path copied. Paste it into Windows File Explorer’s address bar.');
      setError(null);
    } catch {
      setInfo(null);
      setError('Clipboard access is unavailable. Select and copy the path shown in the shortcut instead.');
    }
  };
  const startEdit = (entry?: ResourceLink) => {
    setDraft(entry ? { kind: entry.kind, title: entry.title, target: entry.target, editing: entry.id } : { ...BLANK });
    setEditing(true);setManagerOpen(true);setError(null);setInfo(null);
  };
  const cancel = () => {setEditing(false);setDraft({ ...BLANK });setError(null);};
  const closeManager = () => {
    if (busy) return;
    if (dirty && !window.confirm('Discard unsaved Quick Access changes?')) return;
    cancel();setManagerOpen(false);setPendingRemove(null);
  };
  // Switching a full Node with an unsaved Quick Access form is explicitly guarded.
  // Existing NodeUpdate / Notes editors still own their own save lifecycle.
  useEffect(() => {
    if (!editing) return;
    return registerEditor(`quick-access:${node.id}`, {
      dirty: () => dirty,
      save: async () => false, // never auto-save a partial form
      discard: cancel,
    });
    // Register when field dirtiness changes; do not persist sensitive path text.
  }, [node.id, editing, dirty]);
  useEffect(() => { notifyDraftChange(); }, [dirty]);

  return (
    <section className={inherited ? "l1-quick-access is-inherited" : "l1-quick-access"}
      aria-label={inherited ? "Inherited Quick Access" : "Quick Access"}>
      <div className="l1-shortcut-dock">
        <h2 className="l1-shortcut-caption">Quick Access
          {inherited ? <AppLink to={nodePath(node.id)} title="Manage at the parent item"> <Icon name="open" size={13}/></AppLink> : null}
        </h2>
        <div className="l1-icon-strip" role="group" aria-label="Quick Access shortcuts">
          {items.map((item) => {
            const label = item.kind === 'folder' ? `Open Explorer: ${item.title}` : `Open ${item.title} in new tab`;
            const icon = <ShortcutIcon kind={item.kind} target={item.target}/>;
            return item.kind === 'folder'
              ? <button type="button" key={item.id} data-shortcut-id={item.id} data-shortcut-kind={item.kind}
                  className="l1-shortcut-icon" aria-label={label} title={`${item.title} · ${shortcutTypeLabel(item)} · ${item.target}`}
                  disabled={busy || Boolean(opening)} draggable={!inherited && !busy}
                  onDragStart={(event) => dragStart(event, item.id)}
                  onDragOver={(event) => { if (dragId.current) event.preventDefault(); }}
                  onDrop={(event) => drop(event, item.id)}
                  onDragEnd={() => {dragId.current = null;}}
                  onTouchStart={(event) => touchBegin(event, item.id)}
                  onTouchEnd={touchEnd}
                  onClickCapture={(event) => { if (Date.now() < suppressClickUntil.current) {event.preventDefault();event.stopPropagation();} suppressClickUntil.current=0; }}
                  onClick={() => void open(item.id)}>{icon}</button>
              : <a key={item.id} data-shortcut-id={item.id} data-shortcut-kind={item.kind}
                  className="l1-shortcut-icon" aria-label={label} title={`${item.title} · ${shortcutTypeLabel(item)}`}
                  href={item.target} target="_blank" rel="noopener noreferrer"
                  draggable={!inherited && !busy}
                  onDragStart={(event) => dragStart(event, item.id)}
                  onDragOver={(event) => { if (dragId.current) event.preventDefault(); }}
                  onDrop={(event) => drop(event, item.id)}
                  onDragEnd={() => {dragId.current = null;}}
                  onTouchStart={(event) => touchBegin(event, item.id)}
                  onTouchEnd={touchEnd}
                  onClickCapture={(event) => { if (Date.now() < suppressClickUntil.current) {event.preventDefault();event.stopPropagation();} suppressClickUntil.current=0; }}
                  >{icon}</a>;
          })}
          {items.length === 0 ? <span className="l1-shortcuts-empty">Add a project shortcut</span> : null}
        </div>
        {!inherited ? <div className="l1-dock-tools">
          {items.length < 24 ? <button type="button" className="l1-dock-tool" aria-label="Add shortcut"
            title="Add a Quick Access shortcut" disabled={busy || editing} onClick={() => startEdit()}>
            <Icon name="plus" size={17}/></button> : null}
          <button type="button" className="l1-dock-tool" aria-label="Manage shortcuts" title="Manage Quick Access"
            aria-expanded={managerOpen} aria-controls="l1-shortcut-manager"
            disabled={busy || editing} onClick={() => setManagerOpen((previous) => !previous)}>
            <Icon name="more" size={19}/></button>
        </div> : null}
      </div>

      {!inherited && managerOpen ? <OverlayDialog title="Manage Quick Access" onClose={closeManager} className="quick-access-dialog">
        <div className="l1-shortcut-manager" id="l1-shortcut-manager">
        <header className="l1-manager-head">
          <h3>Manage Quick Access <span className="muted">({items.length}/24)</span></h3>
          {!editing ? <button type="button" className="btn" aria-label="Close shortcut manager"
            onClick={() => {setManagerOpen(false);setPendingRemove(null);}}>Close</button> : null}
        </header>
        {!editing && items.length ? <div className="l1-manager-items">
          {items.map((item) => <div key={item.id} className="l1-manager-row" data-managed-id={item.id}>
            <span className="l1-manager-icon"><ShortcutIcon kind={item.kind} target={item.target}/></span>
            <div className="l1-manager-meta">
              <strong>{item.title}</strong>
              <span>{shortcutTypeLabel(item)} · {item.target}</span>
            </div>
            <div className="l1-manager-actions">
              <button type="button" className="btn" disabled={busy || items[0]?.id === item.id}
                aria-label={`Move ${item.title} left`}
                onClick={() => void reorder(item.id, items[items.findIndex((e) => e.id === item.id) - 1]?.id ?? item.id)}>←</button>
              <button type="button" className="btn" disabled={busy || items[items.length - 1]?.id === item.id}
                aria-label={`Move ${item.title} right`}
                onClick={() => void reorder(item.id, items[items.findIndex((e) => e.id === item.id) + 1]?.id ?? item.id)}>→</button>
              {item.kind === 'folder' ? <button type="button" className="btn"
                onClick={() => void copyPath(item.target)}>Copy path</button> : null}
              <button type="button" className="btn" disabled={busy}
                aria-label={`Edit ${item.title}`} onClick={() => startEdit(item)}>Edit</button>
              <button type="button" className="btn" disabled={busy}
                aria-label={`Remove ${item.title}`} onClick={() => setPendingRemove(item.id)}>Remove</button>
            </div>
            {pendingRemove === item.id ? <div className="l1-shortcut-confirm">
              <p>Remove shortcut only? Source files and folders stay unchanged.</p>
              <button type="button" className="btn btn-danger" disabled={busy}
                onClick={() => void remove(item.id)}>Confirm removal</button>
              <button type="button" className="btn" onClick={() => setPendingRemove(null)}>Cancel</button>
            </div> : null}
          </div>)}
        </div> : null}
        {editing ? (
          <form className="l1-shortcut-form" aria-label={draft.editing ? 'Edit shortcut' : 'Add shortcut'} onSubmit={(event) => void save(event)}>
            <label>Shortcut type
              <select value={draft.kind} onChange={(event) => setDraft((item) =>
                ({ ...item, kind: event.target.value as ResourceLinkKind, target: '' }))}>
                {KINDS.map((kind) => <option value={kind.id} key={kind.id}>{kind.title}</option>)}
              </select></label>
            <label>Name <input value={draft.title} maxLength={120} required
              placeholder={draft.kind === 'folder' ? 'Project documents' : 'Useful reference'}
              onChange={(event) => setDraft((item) => ({ ...item, title: event.target.value }))}/></label>
            <label>{draft.kind === 'folder' ? 'Absolute folder path' : 'Full URL'}
              <input value={draft.target} required spellCheck={false}
                placeholder={draft.kind === 'folder' ? 'C:\\Work\\Sample-Project or /home/user/project' : 'https://...'}
                onChange={(event) => setDraft((item) => ({ ...item, target: event.target.value }))}/></label>
            {draft.kind === 'folder' ?
              <p className="muted l1-shortcut-hint">Opens Explorer on the Windows computer running KB_Work, not on a remote device. Folder contents are not imported.</p> :
              <p className="muted l1-shortcut-hint">Bookmark only; this does not connect Teams, SharePoint or EriDoc APIs.</p>}
            <div className="l1-shortcut-form-actions">
              <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save shortcut'}</button>
              <button className="btn" type="button" onClick={cancel} disabled={busy}>Cancel</button>
            </div>
          </form>
        ) : null}
        </div>
      </OverlayDialog> : null}
      {info ? <p className="l1-shortcut-feedback" role="status">{info}</p> : null}
      {error ? <p className="error-text l1-shortcut-feedback" role="alert">{error}</p> : null}
    </section>
  );
}
