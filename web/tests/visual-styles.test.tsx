import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { AppShell } from '../src/components/AppShell';
import { SettingsPage } from '../src/components/node/SettingsPage';
import { PREFIX } from '../src/lib/storage';
import { getTheme, setTheme } from '../src/lib/theme';
import {
  getVisualStyle, readVisualStyle, setVisualStyle, validateVisualStyle,
  VISUAL_STYLES,
} from '../src/lib/visualStyle';
import { click, render } from './helpers';

function shell() {
  return render(<AppShell left={<div data-testid="left">Navigation</div>} inspector={<div data-testid="right">Inspector</div>}><div data-testid="work-content">Current task and Note</div></AppShell>);
}

describe('work visual skins (independent from domain and existing theme)', () => {
  it('no saved preference, invalid preference and unsupported values use original UI', () => {
    expect(readVisualStyle()).toBe('default');
    expect(getVisualStyle()).toBe('default');
    expect(validateVisualStyle('legacy')).toBeUndefined();
    expect(VISUAL_STYLES).toEqual(['default','mountains','starship','aurora']);
    window.localStorage.setItem(`${PREFIX}visual-style`, '"ink"');
    expect(readVisualStyle()).toBe('default');
    window.localStorage.setItem(`${PREFIX}visual-style`, '{bad json');
    expect(readVisualStyle()).toBe('default');
  });

  it('top bar switches skin without remounting panes, losing content, or touching dark mode', () => {
    const root = shell();
    const main = root.querySelector('main');
    const sidebar = root.querySelector('.pane-left');
    const inspector = root.querySelector('.pane-right');
    const content = root.querySelector('[data-testid="work-content"]');
    const oldTheme = getTheme();
    expect(document.documentElement.getAttribute('data-visual-style')).toBeNull();

    click(root.querySelector('button[aria-label^="视觉风格"]')!);
    expect(root.querySelector('[role="menu"]')).not.toBeNull();
    const starship = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((element) => element.textContent?.includes('星舰探索'))!;
    click(starship);
    expect(document.documentElement.dataset.visualStyle).toBe('starship');
    expect(window.localStorage.getItem(`${PREFIX}visual-style`)).toBe('"starship"');
    expect(getTheme()).toBe(oldTheme);
    expect(root.querySelector('main')).toBe(main);
    expect(root.querySelector('.pane-left')).toBe(sidebar);
    expect(root.querySelector('.pane-right')).toBe(inspector);
    expect(root.querySelector('[data-testid="work-content"]')).toBe(content);

    click(root.querySelector('button[aria-label^="视觉风格"]')!);
    const defaultButton = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((element) => element.textContent?.includes('当前默认'))!;
    click(defaultButton);
    expect(document.documentElement.dataset.visualStyle).toBe('default');
    expect(root.querySelector('[data-testid="work-content"]')).toBe(content);
  });

  it('settings exposes four radios; visual skin and light/dark controls are independent', () => {
    const root = render(<SettingsPage />);
    const styleInputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[name="settings-visual-style"]'));
    expect(styleInputs.map(input => input.value)).toEqual([...VISUAL_STYLES]);
    expect(styleInputs.find(input => input.value === 'default')?.checked).toBe(true);
    click(styleInputs.find(input => input.value === 'mountains')!);
    expect(getVisualStyle()).toBe('mountains');
    expect(document.documentElement.dataset.visualStyle).toBe('mountains');

    act(() => setTheme('dark'));
    expect(getTheme()).toBe('dark');
    expect(getVisualStyle()).toBe('mountains');

    click(styleInputs.find(input => input.value === 'aurora')!);
    expect(getVisualStyle()).toBe('aurora');
    expect(getTheme()).toBe('dark');
    expect(styleInputs.find(input => input.value === 'aurora')?.checked).toBe(true);
  });

  it('does not rewrite any saved Work/Notes/layout data when changing skins', () => {
    window.localStorage.setItem(`${PREFIX}layout`, JSON.stringify({leftOpen:false, inspectorOpen:true}));
    window.localStorage.setItem(`${PREFIX}tree-expanded`, JSON.stringify(['sec','n1']));
    window.localStorage.setItem(`${PREFIX}theme`, JSON.stringify('light'));
    act(() => setVisualStyle('starship'));
    act(() => setVisualStyle('aurora'));
    act(() => setVisualStyle('default'));
    expect(JSON.parse(window.localStorage.getItem(`${PREFIX}layout`)!)).toEqual({leftOpen:false, inspectorOpen:true});
    expect(JSON.parse(window.localStorage.getItem(`${PREFIX}tree-expanded`)!)).toEqual(['sec','n1']);
    expect(JSON.parse(window.localStorage.getItem(`${PREFIX}theme`)!)).toBe('light');
  });
});
