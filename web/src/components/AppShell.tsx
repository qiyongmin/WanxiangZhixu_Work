import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { L } from '../lib/labels';
import { useLayout } from '../lib/layout';
import { readJson, writeJson } from '../lib/storage';
import { nextTheme, useTheme } from '../lib/theme';
import { STYLE_INFO, VISUAL_STYLES, useVisualStyle } from '../lib/visualStyle';
import { UI_LAYOUT_INFO, UI_LAYOUTS, useUiLayout } from '../lib/uiLayout';
import type { Theme } from '../lib/types';
import { openPalette } from '../lib/ui';
import { AnnounceContext } from './announce';
import { ErrorBoundary } from './ErrorBoundary';
import { Icon, type IconName } from './icons';
import { IconMenu } from './Menu';

interface Props {
  /** Focus Navigator uses drawer navigation on tablet/mobile. */
  focus?: boolean;
  /** L1 Explorer and L2/L3 Focus: hide the right inspector and return its width to main. */
  fullWidthFocus?: boolean;
  left: ReactNode;
  inspector: ReactNode;
  children: ReactNode;
  /** Extra toolbar content on the right (for example the "browser notifications off" hint). */
  toolbarExtra?: ReactNode;
  /** Overlays (New Task, Command_Palette, notices): they need the announce context, so they live inside the Shell. */
  overlays?: ReactNode;
}

const THEME_LABELS: Record<Theme, string> = {
  light: L.themeLight,
  dark: L.themeDark,
  system: L.themeSystem,
};

const THEME_ICONS: Record<Theme, IconName> = { light: 'sun', dark: 'moon', system: 'auto' };

type Pane = 'left' | 'right';
type PaneWidths = { left: number; right: number };
const DEFAULT_PANES: PaneWidths = { left: 248, right: 280 };
function validWidths(value: unknown): PaneWidths | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (!Number.isFinite(obj.left) || !Number.isFinite(obj.right)) return undefined;
  const left = Number(obj.left);
  const right = Number(obj.right);
  return left >= 192 && left <= 550 && right >= 250 && right <= 640 ? { left, right } : undefined;
}
function clampPane(pane: Pane, requested: number, widths: PaneWidths, viewport: number): number {
  const reserved = 400; // keep the central editor usable on desktop
  return pane === 'left'
    ? Math.max(192, Math.min(requested, 550, viewport - widths.right - reserved))
    : Math.max(250, Math.min(requested, 640, viewport - widths.left - reserved));
}

/**
 * Frame: a slim top bar spans the full width; below it [left] var(--left-w) [main] minmax(0,1fr) [right] var(--right-w).
 * Collapsing only toggles data attributes and aria-hidden/inert; the scroll container of the main column is always the
 * same DOM node, so it never remounts.
 */
export function AppShell({ left, inspector, children, toolbarExtra, overlays, focus = false, fullWidthFocus = false }: Props) {
  const layout = useLayout();
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() =>
    readJson('pane-widths', validWidths, DEFAULT_PANES));
  const widthsRef = useRef(paneWidths);
  widthsRef.current = paneWidths;
  const dragRef = useRef<{ pane: Pane; x: number; width: number; pointerId: number } | null>(null);
  const [viewport, setViewport] = useState(() => typeof window === 'undefined' ? 1280 : window.innerWidth);
  const [drawer, setDrawer] = useState<'left' | 'right' | 'right-closed' | null>(null);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => { setDrawer(null); }, [focus]);
  useEffect(() => {
    if (!drawer) return undefined;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawer(null);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [drawer]);
  const resizePane = useCallback((pane: Pane, value: number) => {
    setPaneWidths((current) => {
      const updated = { ...current, [pane]: clampPane(pane, value, current, window.innerWidth) };
      widthsRef.current = updated;
      return updated;
    });
  }, []);
  const persistWidths = useCallback(() => writeJson('pane-widths', widthsRef.current), []);
  const startResize = (pane: Pane, event: PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth < 1180 || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    dragRef.current = { pane, x: event.clientX, width: paneWidths[pane], pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const keyboardResize = (pane: Pane, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === 'Home' ? 0 : (event.key === 'ArrowRight' ? 1 : -1);
    const value = event.key === 'Home' ? DEFAULT_PANES[pane] :
      widthsRef.current[pane] + 16 * direction * (pane === 'left' ? 1 : -1);
    resizePane(pane, value);
    // Persist synchronously on the next microtask when keyboard layout settles.
    writeJson('pane-widths', { ...widthsRef.current, [pane]: clampPane(pane, value, widthsRef.current, window.innerWidth) });
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const offset = (event.clientX - drag.x) * (drag.pane === 'left' ? 1 : -1);
    resizePane(drag.pane, drag.width + offset);
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    persistWidths();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const paneStyle = { '--left-w-open': paneWidths.left + 'px', '--right-w-open': paneWidths.right + 'px' } as CSSProperties;
  const compact = focus && viewport < 1180;
  const mobile = focus && viewport < 780;
  const leftOpen = compact ? drawer === 'left' : layout.leftOpen;
  const rightOpen = fullWidthFocus ? false : compact ? (mobile ? drawer === 'right' : drawer !== 'left' && drawer !== 'right-closed') : layout.inspectorOpen;
  const toggleLeft = compact ? () => setDrawer((value) => value === 'left' ? null : 'left') : layout.toggleLeft;
  const toggleRight = compact ? () => setDrawer((value) => mobile
    ? (value === 'right' ? null : 'right')
    : (value === 'left' ? null : value === 'right-closed' ? null : 'right-closed')) : layout.toggleInspector;
  const [theme, setTheme] = useTheme();
  const [visualStyle, setVisualStyle] = useVisualStyle();
  const [uiLayout, setUiLayout] = useUiLayout();
  const [message, setMessage] = useState('');
  const announce = useCallback((text: string) => {
    // Clear first so identical text is announced again by screen readers.
    setMessage('');
    window.setTimeout(() => setMessage(text), 20);
  }, []);

  return (
    <AnnounceContext.Provider value={announce}>
      <a className="skip-link" href="#main">
        {L.skipToMain}
      </a>
      <div
        className="app-shell"
        data-focus={focus ? 'true' : 'false'}
        data-full-width-focus={fullWidthFocus ? 'true' : 'false'}
        data-left={leftOpen ? 'open' : 'closed'}
        data-right={rightOpen ? 'open' : 'closed'}
        style={paneStyle}
      >
        <div className="toolbar">
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            aria-label={L.toggleLeft}
            title={L.toggleLeft}
            aria-expanded={leftOpen}
            onClick={toggleLeft}
          >
            <Icon name="panel-left" />
          </button>
          <span className="toolbar-brand" aria-label={L.appName}>
            <img className="toolbar-brand-logo" src="/app/wanxiang-work.svg?v=20261110-selected" alt="" width={47} height={28} />
            <span className="toolbar-brand-chinese">万象知序</span>
            <span className="toolbar-brand-divider" aria-hidden="true" />
            <span className="toolbar-brand-work">Work</span>
          </span>
          <span className="toolbar-spacer" />
          {toolbarExtra}
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            aria-label={L.entrySearchLabel}
            title={L.entrySearchLabel}
            onClick={openPalette}
          >
            <Icon name="search" />
          </button>
          <IconMenu
            label={`界面布局：${UI_LAYOUT_INFO[uiLayout].name}`}
            menuLabel="切换界面布局：当前默认或 Precision Workspace"
            icon="layout"
            align="end"
            className="toolbar-ui-layout-menu"
            items={UI_LAYOUTS.map((option) => ({
              key: option,
              label: UI_LAYOUT_INFO[option].name,
              checked: uiLayout === option,
              onSelect: () => setUiLayout(option),
            }))}
          />
          <IconMenu
            label={`视觉风格：${STYLE_INFO[visualStyle].name}`}
            menuLabel="切换万象知序视觉风格"
            icon="palette"
            align="end"
            className="toolbar-style-menu"
            items={VISUAL_STYLES.map((style) => ({
              key: style,
              label: `${visualStyle === style ? '✓ ' : ''}${STYLE_INFO[style].name}`,
              onSelect: () => setVisualStyle(style),
            }))}
          />
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            aria-label={L.themeButton(THEME_LABELS[theme])}
            title={L.themeButtonHint(THEME_LABELS[theme], THEME_LABELS[nextTheme(theme)])}
            onClick={() => setTheme(nextTheme(theme))}
          >
            <Icon name={THEME_ICONS[theme]} />
          </button>
          {!fullWidthFocus ? <button
            type="button"
            className="btn btn-icon btn-ghost"
            aria-label={L.toggleInspector}
            title={L.toggleInspector}
            aria-expanded={rightOpen}
            onClick={toggleRight}
          >
            <Icon name="panel-right" />
          </button> : null}
        </div>

        {compact && drawer === 'left' ? <button type="button" className="focus-drawer-backdrop" aria-label="Close navigation drawer" onClick={() => setDrawer(null)} /> : null}
        <aside
          className="pane-left"
          aria-label={L.leftTreeLabel}
          aria-hidden={!leftOpen}
          inert={!leftOpen}
        >
          <div className="pane-inner pane-inner-left">
            <ErrorBoundary label="left">{left}</ErrorBoundary>
          </div>
        </aside>

        {viewport >= 1180 && leftOpen ? (
          <div className="pane-resizer pane-resizer-left" role="separator" tabIndex={0}
            aria-label="Resize left navigation" aria-orientation="vertical"
            aria-valuemin={192} aria-valuemax={550} aria-valuenow={paneWidths.left}
            title="Drag to resize navigation · Double-click to reset"
            onPointerDown={(event) => startResize('left', event)} onPointerMove={onResizeMove}
            onPointerUp={endResize} onPointerCancel={endResize}
            onDoubleClick={() => { resizePane('left', DEFAULT_PANES.left); writeJson('pane-widths', { ...widthsRef.current, left: DEFAULT_PANES.left }); }}
            onKeyDown={(event) => keyboardResize('left', event)} />
        ) : null}
        {!fullWidthFocus && viewport >= 1180 && rightOpen ? (
          <div className="pane-resizer pane-resizer-right" role="separator" tabIndex={0}
            aria-label="Resize right inspector" aria-orientation="vertical"
            aria-valuemin={250} aria-valuemax={640} aria-valuenow={paneWidths.right}
            title="Drag to resize inspector · Double-click to reset"
            onPointerDown={(event) => startResize('right', event)} onPointerMove={onResizeMove}
            onPointerUp={endResize} onPointerCancel={endResize}
            onDoubleClick={() => { resizePane('right', DEFAULT_PANES.right); writeJson('pane-widths', { ...widthsRef.current, right: DEFAULT_PANES.right }); }}
            onKeyDown={(event) => keyboardResize('right', event)} />
        ) : null}
        <div className="main-col">
          <main id="main" className="main-scroll" tabIndex={-1} aria-label={L.mainLabel}>
            <ErrorBoundary label="main">{children}</ErrorBoundary>
          </main>
        </div>

        {!fullWidthFocus && mobile && drawer === 'right' ? <button type="button" className="focus-drawer-backdrop" aria-label="Close context drawer" onClick={() => setDrawer(null)} /> : null}
        {!fullWidthFocus ? <aside
          className="pane-right"
          aria-label={L.inspectorLabel}
          aria-hidden={!layout.inspectorOpen}
          inert={!layout.inspectorOpen}
        >
          <div className="pane-inner pane-inner-right">
            <ErrorBoundary label="right">{inspector}</ErrorBoundary>
          </div>
        </aside> : null}
      </div>
      {overlays}
      <div className="visually-hidden" role="status" aria-live="polite" aria-label={L.statusRegionLabel}>
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}
