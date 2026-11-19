import { useEffect, useMemo, useState } from 'react';
import { describeError } from '../../lib/errors';
import { L, L4 } from '../../lib/labels';
import { fetchFiles, fetchRefs } from '../../lib/phase4';
import { fileUrl, formatSize } from '../../lib/preview';
import { formatMaterialCreatedAt } from '../../lib/materialTime';
import { invalidate, useQuery } from '../../lib/queryCache';
import type { FileRefs, HubFile } from '../../lib/types';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';
import { OpenStorageLocation } from '../preview/OpenStorageLocation';
import { FileVersionTools } from '../preview/FileVersionTools';
import { PreviewContent, type PreviewTarget } from '../preview/PreviewDrawer';
import { MaterialFormatIcon } from '../materials/MaterialFormatIcon';
import { navigate, nodePath, useAppPath } from '../../lib/router';

/** Global File Hub is now a read-only index of canonical Work library files.
 * To update any Office or other document, use Windows Explorer in its actual
 * server-side folder. The website never uploads/restores/deletes file bytes. */
export function FileHubPage() {
  const routePath = useAppPath();
  const requestedPreview = new URLSearchParams(routePath.split('?')[1] ?? '').get('preview');
  const [trash, setTrash] = useState(false);
  const [search, setSearch] = useState('');
  const [refs, setRefs] = useState<FileRefs | null>(null);
  const [open, setOpen] = useState<{ id: string; view: 'history' | 'preview'; maximize?: boolean } | null>(null);
  const files = useQuery<HubFile[]>(`filehub:list:${trash ? 'trash' : 'all'}`,
    (signal) => fetchFiles(trash, signal), { staleMs: 0 });
  const list = files.data ?? [];
  const active = open ?? (requestedPreview && list.some((file) => file.id === requestedPreview)
    ? { id: requestedPreview, view: 'preview' as const, maximize: false } : null);
  const ids = list.map((file) => file.id).join(',');
  useEffect(() => {
    if (trash || !ids) {setRefs(trash ? {} : null); return undefined;}
    const controller = new AbortController();
    setRefs(null);
    fetchRefs(ids.split(','), controller.signal).then(setRefs).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setRefs({});
    });
    return () => controller.abort();
  }, [ids, trash]);

  const visible = useMemo(() => list.filter((file) =>
    !search.trim() || (file.name + ' ' + file.path).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  ), [list, search]);
  const groups = useMemo(() => {
    const byFolder = new Map<string, HubFile[]>();
    for (const file of visible) {
      const slash = file.path.lastIndexOf('/');
      const folder = slash >= 0 ? file.path.slice(0, slash) : '(library root)';
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
    }
    return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible]);
  const closePreview = () => {
    setOpen(null);
    if (requestedPreview) navigate('/files', { replace: true });
  };
  const toggle = (file: HubFile, view: 'history' | 'preview', maximize = false) => {
    setOpen((current) => current?.id === file.id && current.view === view &&
      Boolean(current.maximize) === maximize ? null : { id: file.id, view, maximize });
  };

  const row = (file: HubFile) => {
    const current = active?.id === file.id;
    const target: PreviewTarget = { kind: 'file', fileId: file.id, name: file.name, size: file.size };
    const refList = refs?.[file.id] ?? [];
    return <li className="material-compact-item" key={file.id} data-file-id={file.id}>
      <div className="material-compact-row">
        <MaterialFormatIcon name={file.name}/>
        <div className="material-compact-primary">
          <button type="button" className="material-compact-name" title={file.path} onClick={() => toggle(file, 'preview')}>{file.displayName ?? file.name}</button>
          <span className="material-compact-meta" title={file.id}>
            {file.businessVersion ? file.businessVersion + ' · ' : ''}
            Revision {file.revision} · {formatSize(file.size)}
            {formatMaterialCreatedAt(file.created) ? ` · 添加 ${formatMaterialCreatedAt(file.created)}` : ''}
            {refList.length ? ` · ${refList.length} linked work items` : ''}
          </span>
        </div>
        <div className="material-compact-actions" role="group" aria-label={`File actions: ${file.name}`}>
          {!trash ? <>
            <button type="button" className="material-icon-btn" title="预览" aria-label={`Preview: ${file.name}`}
              onClick={() => toggle(file, 'preview')}><Icon name="eye" size={17}/></button>
            <OpenStorageLocation fileId={file.id} name={file.name}/>
          </> : null}
          <button type="button" className="material-icon-btn" title="版本历史（只读）"
            aria-label={`Version history: ${file.name}`} onClick={() => toggle(file, 'history')}>
            <Icon name="history" size={17}/></button>
          {!trash ? <>
            <button type="button" className="material-icon-btn" title="最大化预览"
              aria-label={`Maximize preview: ${file.name}`} onClick={() => toggle(file, 'preview', true)}>
              <Icon name="expand" size={17}/></button>
            <a href={`/app/files?preview=${encodeURIComponent(file.id)}`} target="_blank"
              className="material-icon-btn" rel="noopener noreferrer" title="在新标签页打开"
              aria-label={`Open in new tab: ${file.name}`}><Icon name="open" size={17}/></a>
            <a href={fileUrl(file.id, 'download')} download={file.name}
              className="material-icon-btn" title="下载原件"
              aria-label={`Download: ${file.name}`}><Icon name="download" size={17}/></a>
          </> : null}
        </div>
      </div>
      {refList.length ? <details className="material-compact-used"><summary>关联到 {refList.length} 个工作项</summary>
        {refList.map((ref) => <AppLink key={ref.nodeId} to={nodePath(ref.nodeId, 'materials')}>{ref.title}</AppLink>)}
      </details> : null}
      {current && active?.view === 'history' ? <FileVersionTools fileId={file.id} openInitially/> : null}
      {current && active?.view === 'preview' && !trash ? <section className="materials-inline-preview material-compact-preview">
        <div className="materials-preview-head"><strong>{file.name} · Read-only preview</strong>
          <button type="button" className="btn" onClick={closePreview}>Close preview</button></div>
        <PreviewContent key={file.id + String(active.maximize)} target={target}
          inlineControls={false} initialMaximized={active.maximize === true}/>
      </section> : null}
    </li>;
  };

  return <section className="page filehub-compact-page" aria-labelledby="page-title">
    <div className="filehub-compact-heading">
      <div><h1 id="page-title">{L4.filesHeading}</h1>
        <p className="muted">文件在 KB_Work/library 中统一管理。这里仅提供预览、版本记录及定位存储目录；不修改文件内容。</p>
      </div>
      <button type="button" className="btn" onClick={() => invalidate('filehub:')}>刷新文件索引</button>
    </div>
    <div className="filehub-compact-filters">
      <div className="segmented" role="group" aria-label={L4.filesHeading}>
        <button type="button" className={trash ? 'btn' : 'btn is-active'} aria-pressed={!trash}
          onClick={() => { setTrash(false); setOpen(null); }}>{L4.filesTabAll}</button>
        <button type="button" className={trash ? 'btn is-active' : 'btn'} aria-pressed={trash}
          onClick={() => { setTrash(true); setOpen(null); }}>{L4.filesTabTrash}</button>
      </div>
      <label className="filehub-search"><Icon name="search" size={16}/>
        <span className="visually-hidden">Find files</span>
        <input type="search" placeholder="搜索文件名或目录" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
    </div>
    {files.status === 'error' && !files.data ? <p role="alert" className="error-text">文件索引加载失败：{describeError(files.error)}</p> : null}
    {!files.data && files.status !== 'error' ? <p className="muted" role="status">{L.loading}</p> : null}
    {files.data && visible.length === 0 ? <p className="muted">没有匹配的文件。</p> : null}
    {groups.map(([folder, contents]) => <section className="material-owner-group" key={folder}>
      <div className="material-owner-head"><span className="material-level-mark">
        <Icon name="folder" size={15}/></span>
        <strong title={folder}>{folder}</strong>
        <span className="material-group-count">{contents.length} files</span></div>
      <ul className="material-compact-list">{contents.map(row)}</ul>
    </section>)}
  </section>;
}
