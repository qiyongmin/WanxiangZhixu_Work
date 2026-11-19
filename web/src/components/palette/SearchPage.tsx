import { L, L2 } from '../../lib/labels';
import { openPalette } from '../../lib/ui';

/** `/search` 路由：全局搜索由 Command_Palette 承载，这里提供入口说明。 */
export function SearchPage() {
  return (
    <section className="page" aria-labelledby="page-title">
      <h1 id="page-title">{L.searchTitle}</h1>
      <p className="muted">{L2.searchPageHint}</p>
      <button type="button" className="btn btn-primary" onClick={openPalette}>
        {L2.searchOpen}
      </button>
    </section>
  );
}
