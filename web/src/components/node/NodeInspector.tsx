import { get } from '../../lib/api';
import { formatTimestamp } from '../../lib/dates';
import { L, L2 } from '../../lib/labels';
import { keys } from '../../lib/nodeData';
import { useQuery } from '../../lib/queryCache';
import type { NodeDTO } from '../../lib/types';
import { Inspector } from '../inspector/Inspector';
import { StatusBadge } from '../StatusBadge';

/** 右栏属性面板：可编辑的 Inspector（草稿 + 保存），其下是只读的基本信息。 */
export function NodeInspector({ id }: { id: string }) {
  const query = useQuery<NodeDTO>(keys.node(id), (signal) => get<NodeDTO>('node', { id }, { signal }));
  const node = query.data;
  if (!node) return <p className="muted pane-note">{L.inspectorEmpty}</p>;
  return (
    <div className="inspector-pane" aria-label={L.inspectorLabel}>
      <Inspector key={node.id} node={node} />
      <dl className="kv" aria-label={L2.basicInfo}>
        <dt>{L.inspectorKind}</dt>
        <dd>{node.displayKind}</dd>
        <dt>{L.fieldStatus}</dt>
        <dd>
          <StatusBadge status={node.status} />
        </dd>
        <dt>{L.inspectorRevision}</dt>
        <dd>{node.revision}</dd>
        <dt>{L.inspectorCreated}</dt>
        <dd>{formatTimestamp(node.createdAt)}</dd>
        <dt>{L.inspectorUpdated}</dt>
        <dd>{formatTimestamp(node.updatedAt)}</dd>
        <dt>{L.inspectorPath}</dt>
        <dd>{node.nodePath}</dd>
      </dl>
    </div>
  );
}
