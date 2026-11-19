// Open state of New Task (Quick_Add), New Item / New Section dialogs and the Command_Palette (module-level store).
import { useSyncExternalStore } from 'react';

export type CreateKind = 'item' | 'section';

export interface UiState {
  /** Non-null when New Task (Quick_Add) is open; `title` is prefilled and `parentId` optionally preselects the parent. */
  quickAdd: { title: string; parentId?: string; mode?: "child"; parentKind?: string; rootId?: string } | null;
  /** Non-null when New Item / New Section is open; `sectionId` preselects the Section for an Item. */
  create: { kind: CreateKind; sectionId?: string } | null;
  palette: boolean;
}

let state: UiState = { quickAdd: null, create: null, palette: false };
const listeners = new Set<() => void>();

function set(next: UiState): void {
  state = next;
  for (const listener of Array.from(listeners)) listener();
}

export function openQuickAdd(title = '', parentId?: string, rootId?: string): void {
  set({ palette: false, create: null, quickAdd: parentId ? { title, parentId, ...(rootId ? {rootId} : {}) } : { title } });
}

/** The contextual "+" creates the correct structural child, not always a Task. */
export function openChildAdd(parentId: string, parentKind: string): void {
  set({ palette: false, create: null, quickAdd: { title: '', parentId, mode: 'child', parentKind } });
}

export function closeQuickAdd(): void {
  if (state.quickAdd) set({ ...state, quickAdd: null });
}

export function openCreate(kind: CreateKind, sectionId?: string): void {
  set({ palette: false, quickAdd: null, create: sectionId ? { kind, sectionId } : { kind } });
}

export function closeCreate(): void {
  if (state.create) set({ ...state, create: null });
}

export function openPalette(): void {
  if (state.quickAdd || state.create) return;
  set({ ...state, palette: true });
}

export function closePalette(): void {
  if (state.palette) set({ ...state, palette: false });
}

export function getUi(): UiState {
  return state;
}

export function resetUi(): void {
  set({ quickAdd: null, create: null, palette: false });
}

export function useUi(): UiState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
    () => state,
  );
}
