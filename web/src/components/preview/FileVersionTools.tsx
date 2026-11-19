import { useEffect, useState } from 'react';
import { describeError } from '../../lib/errors';
import { fetchDetail } from '../../lib/phase4';
import { formatSize } from '../../lib/preview';
import type { HubDetail } from '../../lib/types';
import { Icon } from '../icons';

const when = (at: number | null) => at ? new Date(at * 1000).toLocaleString() : 'Date unavailable';

/** Read-only version browser. File content changes only in the Work library directory.
 * Never upload/restore/prune/lock/pin a document from the web UI. */
export function FileVersionTools({ fileId, pinnedRevision, openInitially = false }: {
  fileId: string;
  materialId?: string;
  pinnedRevision?: number | null;
  openInitially?: boolean;
}) {
  const [expanded, setExpanded] = useState(openInitially);
  const [detail, setDetail] = useState<HubDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!expanded) return undefined;
    const controller = new AbortController();
    setProblem(null);
    fetchDetail(fileId, controller.signal).then(setDetail).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setProblem(describeError(error));
    });
    return () => controller.abort();
  }, [fileId, expanded]);

  return <section className="file-version-tools" aria-label="Read-only version history">
    {!openInitially ? <button type="button" className="btn file-history-toggle"
      aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <Icon name="history" size={15}/> {expanded ? '收起版本历史' : '版本历史'}
    </button> : null}
    {expanded ? <div className="file-version-history">
      {problem ? <p role="alert" className="error-text">历史记录不可用：{problem}</p> : null}
      {detail ? <>
        <div className="file-version-current">
          <strong>{detail.displayName ?? detail.name} · {detail.businessVersion ?? 'Current'}</strong>
          <span className="muted">当前 Revision {detail.revision} · {formatSize(detail.size)} · 只读</span>
          {pinnedRevision != null ? <span className="muted">该 Material 固定于历史 Revision {pinnedRevision}</span> : null}
        </div>
        <div className="file-version-list">
          {detail.versions.length ? detail.versions.map((v) => <div key={v.revision} className="file-version-row">
            <div><strong>Revision {v.revision}</strong><span className="muted">{when(v.at)} · {formatSize(v.size)} · {v.source}{v.locked ? ' · Protected' : ''}</span></div>
            <a className="btn" download href={`/api/file-hub/file?id=${encodeURIComponent(fileId)}&revision=${v.revision}&mode=download`}>
              <Icon name="download" size={15}/> 下载历史原件
            </a>
          </div>) : <p className="muted">暂无历史版本。直接在存储目录修改原件后，系统将记录新 Revision。</p>}
        </div>
      </> : !problem ? <p role="status" className="muted">正在读取版本历史…</p> : null}
    </div> : null}
  </section>;
}
