import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Icon } from '../src/components/icons';
import { OverlayDialog } from '../src/components/OverlayDialog';
import { click, key, render } from './helpers';

const source = (path: string) =>
  readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');

describe('KBW UI independent design system', () => {
  it('uses the self-contained primitives layer and no legacy UI stylesheet import', () => {
    const main = source('main.tsx');
    expect(main).toContain("import './styles/kbw-primitives.css'");
    expect(main).not.toContain("import './styles/" + 'eds' + ".css'");
    const css = source('styles/kbw-primitives.css');
    expect(css).toContain('KB_Work independent primitive styles');
    expect(css).toContain('.status-badge');
    expect(css).toContain('.tree-section');
  });

  it('prefers open font families and never requires a runtime font CDN', () => {
    const tokens = source('styles/tokens.css');
    expect(tokens).toContain('"Inter Variable"');
    expect(tokens).toContain('"Noto Sans SC Variable"');
    expect(tokens).toContain('"JetBrains Mono Variable"');
    for (const font of ["inter", "noto-sans-sc", "jetbrains-mono"])
      expect(source("main.tsx")).toContain(`@fontsource-variable/${font}/wght.css`);
    expect(tokens).not.toContain('Hilda');
    expect(source('main.tsx')).not.toContain('fonts.googleapis');
    expect(tokens).toContain("--font-body");
    expect(tokens).toContain("--font-mono");
  });

  it('uses the same open font preference for isolated Markdown previews', () => {
    const preview = source('lib/preview.ts');
    expect(preview).toContain('"Inter Variable","Noto Sans SC Variable"');
    expect(preview).toContain('"JetBrains Mono Variable"');
    expect(preview).toContain("default-src 'none'");
  });

  it('uses the Radix focus-managed dialog while preserving its existing DOM contract', () => {
    const close = vi.fn();
    render(<OverlayDialog title="Manage Quick Access" onClose={close}>
      <button type="button">Manage item</button>
    </OverlayDialog>);
    const panel = document.querySelector<HTMLElement>('.work-modal-backdrop [role="dialog"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('aria-modal')).toBe('true');
    expect(panel?.querySelector('h2')?.textContent).toBe('Manage Quick Access');
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Close Manage Quick Access"]');
    expect(button).not.toBeNull();
    click(button!);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes Radix overlay on Escape without changing Work data', () => {
    const close = vi.fn();
    render(<OverlayDialog title="Additional Details" onClose={close}>
      <button type="button">Details</button>
    </OverlayDialog>);
    const panel = document.querySelector<HTMLElement>('.work-modal-backdrop [role="dialog"]');
    expect(panel).not.toBeNull();
    key(panel!, 'Escape');
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps the local icon contract accessible without loading external icon assets', () => {
    const markup = renderToStaticMarkup(<Icon name="search" size={18} />);
    expect(markup).toContain('<svg');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('width="18"');
  });
});
