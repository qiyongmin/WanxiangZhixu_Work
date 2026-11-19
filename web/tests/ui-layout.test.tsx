import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AppShell } from '../src/components/AppShell';
import { SettingsPage } from '../src/components/node/SettingsPage';
import { hasUnsavedDraft, registerEditor } from '../src/lib/draftGuard';
import { PREFIX } from '../src/lib/storage';
import { getTheme, setTheme } from '../src/lib/theme';
import {
  UI_LAYOUTS, getUiLayout, initUiLayout, readUiLayout, setUiLayout, validateUiLayout,
} from '../src/lib/uiLayout';
import { getVisualStyle, setVisualStyle } from '../src/lib/visualStyle';
import { click, key, render } from './helpers';

const selector = (root: HTMLElement) =>
  root.querySelector<HTMLButtonElement>('button[aria-label^="界面布局"]')!;

function shell() {
  return render(<AppShell
    left={<div data-testid="tree">Existing tree</div>}
    inspector={<div data-testid="inspector">Existing inspector</div>}
  >
    <section data-testid="content">
      <textarea defaultValue="Existing unsaved note" aria-label="Draft editor" />
    </section>
  </AppShell>);
}

describe('KB_Work V4.0 dual UI layout', () => {
  it('uses Classic for missing, invalid or corrupted preferences', () => {
    expect(UI_LAYOUTS).toEqual(['classic','precision']);
    expect(readUiLayout()).toBe('classic');
    expect(getUiLayout()).toBe('classic');
    expect(document.documentElement.hasAttribute('data-ui-layout')).toBe(false);
    expect(validateUiLayout('precision')).toBe('precision');
    expect(validateUiLayout('classic')).toBe('classic');
    expect(validateUiLayout('old')).toBeUndefined();
    window.localStorage.setItem(PREFIX+'ui-layout', '"unknown"');
    expect(readUiLayout()).toBe('classic');
    window.localStorage.setItem(PREFIX+'ui-layout', '{bad');
    expect(readUiLayout()).toBe('classic');
  });

  it('only writes its own choice and keeps all other preferences', () => {
    window.localStorage.setItem(PREFIX+'tree-expanded', '["node-a"]');
    window.localStorage.setItem(PREFIX+'layout', '{"leftOpen":false,"inspectorOpen":true}');
    act(() => setVisualStyle('mountains'));
    act(() => setTheme('dark'));
    act(() => setUiLayout('precision'));
    expect(document.documentElement.dataset.uiLayout).toBe('precision');
    expect(window.localStorage.getItem(PREFIX+'ui-layout')).toBe('"precision"');
    expect(getVisualStyle()).toBe('mountains');
    expect(getTheme()).toBe('dark');
    expect(window.localStorage.getItem(PREFIX+'tree-expanded')).toBe('["node-a"]');
    expect(window.localStorage.getItem(PREFIX+'layout')).toBe('{"leftOpen":false,"inspectorOpen":true}');
    act(() => setUiLayout('classic'));
    expect(document.documentElement.hasAttribute('data-ui-layout')).toBe(false);
  });

  it('switches without remounting editors, losing draft text or changing routes', () => {
    const root = shell();
    const main = root.querySelector('main')!;
    const tree = root.querySelector('[data-testid="tree"]');
    const editor = root.querySelector<HTMLTextAreaElement>('textarea')!;
    main.scrollTop = 120;
    editor.value = 'Draft text must survive';
    const unregister = registerEditor('notebook-page:sample', {
      dirty: () => true, save: async () => true, discard: () => {},
    });
    try {
      expect(hasUnsavedDraft()).toBe(true);
      click(selector(root));
      let choices = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
      expect(choices.map((item) => item.getAttribute('aria-checked'))).toEqual(['true','false']);
      click(choices[1]!);
      expect(document.documentElement.dataset.uiLayout).toBe('precision');
      expect(root.querySelector('main')).toBe(main);
      expect(root.querySelector('[data-testid="tree"]')).toBe(tree);
      expect(root.querySelector('textarea')).toBe(editor);
      expect(editor.value).toBe('Draft text must survive');
      expect(main.scrollTop).toBe(120);
      expect(hasUnsavedDraft()).toBe(true);
      click(selector(root));
      choices = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
      expect(choices.map((item) => item.getAttribute('aria-checked'))).toEqual(['false','true']);
      click(choices[0]!);
      expect(document.documentElement.hasAttribute('data-ui-layout')).toBe(false);
      expect(root.querySelector('textarea')).toBe(editor);
      expect(window.location.pathname).toBe('/app/');
    } finally {
      unregister();
    }
  });

  it('retains keyboard navigation in the new menu', () => {
    const root = shell();
    click(selector(root));
    const choices = root.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    expect(choices.length).toBe(2);
    key(choices[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(choices[1]);
    key(root.querySelector('[role="menu"]')!, 'Escape');
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });

  it('adds layout selection to Settings independently from four styles and three themes', () => {
    const root = render(<SettingsPage />);
    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[name="settings-ui-layout"]'));
    expect(inputs.map((input) => input.value)).toEqual(['classic','precision']);
    expect(inputs[0]?.checked).toBe(true);
    expect(root.querySelectorAll('input[name="settings-visual-style"]').length).toBe(4);
    expect(root.querySelectorAll('input[name="settings-theme"]').length).toBe(3);
    click(inputs[1]!);
    expect(getUiLayout()).toBe('precision');
    expect(inputs[1]?.checked).toBe(true);
    click(inputs[0]!);
    expect(getUiLayout()).toBe('classic');
  });

  it('syncs preference updates from another tab without changing Theme or Visual Style', () => {
    const release = initUiLayout();
    try {
      act(() => setTheme('dark'));
      act(() => setVisualStyle('aurora'));
      window.localStorage.setItem(PREFIX+'ui-layout','"precision"');
      act(() => window.dispatchEvent(new StorageEvent('storage', {
        key: PREFIX+'ui-layout', newValue: '"precision"',
      })));
      expect(getUiLayout()).toBe('precision');
      expect(document.documentElement.dataset.uiLayout).toBe('precision');
      expect(getTheme()).toBe('dark');
      expect(getVisualStyle()).toBe('aurora');
      window.localStorage.removeItem(PREFIX+'ui-layout');
      act(() => window.dispatchEvent(new StorageEvent('storage', {key:PREFIX+'ui-layout'})));
      expect(getUiLayout()).toBe('classic');
      expect(document.documentElement.hasAttribute('data-ui-layout')).toBe(false);
    } finally {
      release();
    }
  });

  it('supports all 24 independent preference combinations', () => {
    const layouts = ['classic','precision'] as const;
    const styles = ['default','mountains','starship','aurora'] as const;
    const themes = ['light','dark','system'] as const;
    let n = 0;
    for (const layout of layouts) for (const style of styles) for (const theme of themes) {
      act(() => setUiLayout(layout));
      act(() => setVisualStyle(style));
      act(() => setTheme(theme));
      expect(getUiLayout()).toBe(layout);
      expect(getVisualStyle()).toBe(style);
      expect(getTheme()).toBe(theme);
      expect(document.documentElement.hasAttribute('data-ui-layout')).toBe(layout === 'precision');
      n++;
    }
    expect(n).toBe(24);
  });

  it('keeps all Precision styles opt-in and has an early boot script', () => {
    const css = readFileSync('src/styles/ui-layout-precision.css','utf8');
    expect(css).toContain(':root[data-ui-layout="precision"] .cockpit-clarity');
    expect(css).toContain(':root[data-ui-layout="precision"] .notebook-v3');
    expect(css).toContain(':root[data-ui-layout="precision"] .materials-v3-row');
    expect(css).not.toMatch(/(^|\n)\.app-shell\s*\{/);
    const boot = readFileSync('public/ui-layout-boot.js','utf8');
    expect(boot).toContain('kbw:v1:ui-layout');
    expect(boot).toContain("saved === 'precision'");
    expect(boot).not.toContain('fetch(');
  });
});
