// 三栏布局状态（Req 3.5 / 3.6）：kbw:v1:layout 保存；读取失败均展开；窄屏 Inspector 默认折叠。
import { useCallback, useState } from 'react';
import { KEYS, readJson, validateLayout, writeJson, type LayoutState } from './storage';

export const NARROW_BREAKPOINT = 1024;
export const DEFAULT_LAYOUT: LayoutState = { leftOpen: true, inspectorOpen: true };

/** 由已保存状态与视口宽度得到初始布局：视口 <1024px 时忽略已保存的 Inspector 展开状态。 */
export function initialLayout(stored: LayoutState, viewportWidth: number): LayoutState {
  return {
    leftOpen: stored.leftOpen,
    inspectorOpen: viewportWidth < NARROW_BREAKPOINT ? false : stored.inspectorOpen,
  };
}

export function readInitialLayout(): LayoutState {
  const stored = readJson<LayoutState>(KEYS.layout, validateLayout, DEFAULT_LAYOUT);
  const width = typeof window === 'undefined' ? NARROW_BREAKPOINT : window.innerWidth;
  return initialLayout(stored, width);
}

export interface LayoutApi extends LayoutState {
  toggleLeft: () => void;
  toggleInspector: () => void;
}

export function useLayout(): LayoutApi {
  const [state, setState] = useState<LayoutState>(readInitialLayout);
  const update = useCallback((patch: (current: LayoutState) => LayoutState) => {
    setState((current) => {
      const next = patch(current);
      writeJson(KEYS.layout, next);
      return next;
    });
  }, []);
  const toggleLeft = useCallback(() => update((s) => ({ ...s, leftOpen: !s.leftOpen })), [update]);
  const toggleInspector = useCallback(() => update((s) => ({ ...s, inspectorOpen: !s.inspectorOpen })), [update]);
  return { ...state, toggleLeft, toggleInspector };
}
