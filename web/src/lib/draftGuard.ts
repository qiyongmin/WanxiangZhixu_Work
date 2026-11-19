/**
 * Session-only dirty-editor registry. No note or form content is persisted to
 * localStorage/sessionStorage, and no work data is sent anywhere automatically.
 * A user must explicitly Save or Discard before leaving the current Node.
 */
import { useSyncExternalStore } from 'react';
type Editor = { dirty: () => boolean; save: () => Promise<boolean>; discard: () => void };
const editors = new Map<string, Editor>();
type Pending = { target: string; commit: () => void };
let pending: Pending | null = null;
let revision = 0;
const listeners = new Set<() => void>();
function emit() { revision++; for (const listener of listeners) listener(); }
export function registerEditor(key: string, editor: Editor): () => void {
  editors.set(key, editor);
  emit();
  return () => { if (editors.get(key) === editor) editors.delete(key); emit(); };
}
export function notifyDraftChange() { emit(); }
export function hasUnsavedDraft() { return [...editors.values()].some((editor) => editor.dirty()); }
export function useDraftRevision() {
  return useSyncExternalStore((callback) => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => revision, () => 0);
}
export function getDraftPending() { return pending; }
function nodeId(url: string) {
  const match = new URL(url, 'http://localhost').pathname.match(/^\/app\/n\/([^/]+)/);
  if (!match?.[1]) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}
export function guardNavigation(target: string, current: string, commit: () => void): boolean {
  // Switching content panels within the same Node retains its Note editor.
  // A level-one Explorer child switch changes the *actual* editor owner even
  // though the outer /n/:root URL stays the same. Treat it like cross-Node
  // navigation so unsaved child Notes/Summary cannot be unmounted silently.
  const targetId = nodeId(target);
  const currentId = nodeId(current);
  if (targetId === currentId && targetId !== null) {
    const selectedChild = (url: string) => new URL(url, 'http://localhost').searchParams.get('child') ?? '';
    const pageContext = (url: string) => {
      const parsed = new URL(url,'http://localhost');
      return parsed.pathname.endsWith('/notes') ? ['view','section','page','note','event']
        .map(field=>parsed.searchParams.get(field)??'').join('|') : 'outside-notes';
    };
    const changedChild = selectedChild(target) !== selectedChild(current);
    const notebookDraft = [...editors].some(([key, editor]) =>
      (key.startsWith('notebook-page:')||key.startsWith('notebook-event:')) && editor.dirty());
    // Legacy Notes stay mounted across sibling tabs; only the V3 independent
    // Page editor requires guarding same-Node Page/Section/Tab transitions.
    if (!changedChild && (!notebookDraft || pageContext(target) === pageContext(current))) return false;
  }
  if (!hasUnsavedDraft()) return false;
  pending = { target, commit };
  emit();
  return true;
}
export function cancelDraftNavigation() { pending = null; emit(); }
export async function acceptDraftNavigation(action: 'save' | 'discard'): Promise<boolean> {
  const requested = pending;
  if (!requested) return true;
  if (action === 'save') {
    const dirty = [...editors.values()].filter((entry) => entry.dirty());
    for (const item of dirty) {
      if (!await item.save()) return false;
    }
    if (hasUnsavedDraft()) return false;
  } else {
    for (const item of editors.values()) if (item.dirty()) item.discard();
  }
  if (pending !== requested) return false;
  pending = null;
  emit();
  requested.commit();
  return true;
}
export function installUnloadGuard(): () => void {
  const listener = (event: BeforeUnloadEvent) => {
    if (!hasUnsavedDraft()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', listener);
  return () => window.removeEventListener('beforeunload', listener);
}
