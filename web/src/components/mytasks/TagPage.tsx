import { get } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { displaySectionTitle, L, L2 } from '../../lib/labels';
import { useQuery } from '../../lib/queryCache';
import { nodePath } from '../../lib/router';
import type { TagNode } from '../../lib/types';
import { AppLink } from '../AppLink';

/** `/tag/:tag`：列出所有 Section 中带该 Tag 的未删除 Node（标题与所属 Section）。 */
export function TagPage({ tag }: { tag: string }) {
  const query = useQuery<TagNode[]>(`tag-nodes:${tag}`, (signal) => get<TagNode[]>('tag-nodes', { tag }, { signal }), {
    staleMs: 0,
  });
  return (
    <section className="page" aria-labelledby="page-title">
      <h1 id="page-title">
        {L2.tagPageTitle}: <span className="tag-chip">{tag}</span>
      </h1>
      {query.status === 'error' && !query.data ? (
        <div className="error-bar" role="alert">
          <span>
            {L2.tagPageLoadFailed}: {describeError(query.error)}
          </span>
          <button type="button" className="btn" onClick={() => void query.refetch()}>
            {L.retry}
          </button>
        </div>
      ) : null}
      {!query.data && query.status !== 'error' ? (
        <p className="muted" role="status">
          {L.loading}
        </p>
      ) : null}
      {query.data && query.data.length === 0 ? <p className="muted">{L2.tagPageEmpty}</p> : null}
      {query.data && query.data.length > 0 ? (
        <ul className="item-list" aria-label={`${L2.tagPageTitle} ${tag}`}>
          {query.data.map((item) => (
            <li key={item.id} data-node-id={item.id}>
              <AppLink to={nodePath(item.id)}>{item.title}</AppLink>
              <span className="muted">
                {L2.tagBelongs}: {displaySectionTitle(item.sectionTitle)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
