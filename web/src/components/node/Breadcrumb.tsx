import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { displaySectionTitle, L } from '../../lib/labels';
import { collapseCrumbs, shouldCollapse, type Crumb } from '../../lib/nodeForm';
import { nodePath } from '../../lib/router';
import type { NodeDTO } from '../../lib/types';
import { AppLink } from '../AppLink';

interface Props {
  node: NodeDTO;
  /** Section 标题；未知时回退为 sectionId。 */
  sectionTitle: string | null;
}

export function buildCrumbs(node: NodeDTO, sectionTitle: string | null): Crumb[] {
  const crumbs: Crumb[] = [];
  if (node.sectionId) {
    crumbs.push({ key: `s:${node.sectionId}`, label: displaySectionTitle(sectionTitle ?? node.sectionId), to: '/' });
  }
  for (const item of node.path) crumbs.push({ key: `n:${item.id}`, label: item.title, to: nodePath(item.id) });
  crumbs.push({ key: `n:${node.id}`, label: node.title, to: null });
  return crumbs;
}

/** Section › … › 当前节点。溢出时折叠中间层级，保留 Section、直接父节点与当前节点。 */
export function Breadcrumb({ node, sectionTitle }: Props) {
  const crumbs = useMemo(() => buildCrumbs(node, sectionTitle), [node, sectionTitle]);
  const navRef = useRef<HTMLElement>(null);
  const fullWidth = useRef(0);
  const [collapsed, setCollapsed] = useState(false);

  // 内容变化后先以完整形式渲染并测量，再决定是否折叠。
  useLayoutEffect(() => {
    fullWidth.current = 0;
    setCollapsed(false);
  }, [crumbs]);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    const evaluate = () => {
      if (!collapsed) fullWidth.current = nav.scrollWidth;
      const next = shouldCollapse(fullWidth.current, nav.clientWidth);
      setCollapsed((current) => (current === next ? current : next));
    };
    evaluate();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(evaluate);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [collapsed, crumbs]);

  const view = collapseCrumbs(crumbs, collapsed);
  const rendered: Array<Crumb | 'ellipsis'> = [];
  view.visible.forEach((crumb, index) => {
    rendered.push(crumb);
    if (index === 0 && view.hidden.length > 0) rendered.push('ellipsis');
  });

  return (
    <nav ref={navRef} className="breadcrumb" aria-label={L.breadcrumbLabel} data-collapsed={collapsed ? 'true' : 'false'}>
      <ol>
        {rendered.map((item, index) => {
          if (item === 'ellipsis') {
            return (
              <li key="ellipsis" className="crumb-ellipsis">
                <span title={view.hidden.map((c) => c.label).join(' › ')} aria-label={L.breadcrumbCollapsed}>
                  …
                </span>
              </li>
            );
          }
          const last = index === rendered.length - 1;
          return (
            <li key={item.key}>
              {item.to && !last ? (
                <AppLink to={item.to}>{item.label}</AppLink>
              ) : (
                <span aria-current="page">{item.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
