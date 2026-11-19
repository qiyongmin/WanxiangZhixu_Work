/** One-shot, in-memory UI requests. Never persist corporate Note contents in browser storage. */
export interface QuickNote { title: string; text: string }
const requests = new Map<string, QuickNote[]>();
const EVENT = 'kbw:new-note';
export function requestNewNote(nodeId: string, note: QuickNote = { title: '', text: '' }) {
  requests.set(nodeId, [...(requests.get(nodeId) ?? []), note]);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: nodeId }));
}
export function consumeNewNotes(nodeId: string): QuickNote[] {
  const items = requests.get(nodeId) ?? [];
  requests.delete(nodeId);
  return items;
}
export function listenNewNote(nodeId: string, callback: () => void) {
  const listener = (event: Event) => {
    if ((event as CustomEvent).detail === nodeId) callback();
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
