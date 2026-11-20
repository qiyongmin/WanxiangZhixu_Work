import { useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, get, post, postFileHub } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { L } from '../../lib/labels';
import { MAX_UPLOAD_BYTES, uploadMaterialFile } from '../../lib/fileHub';
import { formatMaterialCreatedAt } from '../../lib/materialTime';
import { afterWrite } from '../../lib/nodeData';
import { extensionOf, fileUrl, formatSize } from '../../lib/preview';
import { invalidate, useQuery } from '../../lib/queryCache';
import type { FileHubRef, MaterialItem, MaterialsView, NodeDTO, NodeResult } from '../../lib/types';
import { useAnnounce } from '../announce';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';
import { ModalDialog } from '../ModalDialog';
import { navigate, nodePath, useAppPath } from '../../lib/router';
import { UnconfirmedControls } from '../agent/UnconfirmedMark';
import { FileVersionTools } from '../preview/FileVersionTools';
import { OpenStorageLocation } from '../preview/OpenStorageLocation';
import { OpenNativeFile } from '../preview/OpenNativeFile';
import { PreviewContent, type PreviewTarget } from '../preview/PreviewDrawer';
import { MaterialFormatIcon } from './MaterialFormatIcon';

const HTTP_URL = /^https?:\/\/[^\s<>]+$/i;

const PURPOSE_LABEL: Record<string, string> = {
  plan: 'Main plan', reference: 'Reference', deliverable: 'Deliverable',
  evidence: 'Verification evidence', related: 'Related material',
};

export function materialFileName(item: Pick<MaterialItem, 'name' | 'title' | 'format' | 'displayName'>): string {
  const base = item.displayName ?? item.name ?? item.title;
  return extensionOf(base) === '' && item.format ? `${base}.${item.format}` : base;
}

export function previewTargetOf(item: MaterialItem): PreviewTarget | null {
  if (item.materialType === 'link') {
    return item.url && HTTP_URL.test(item.url) ? { kind: 'link', url: item.url, title: item.title } : null;
  }
  if (!item.fileId) return null;
  return { kind: 'file', fileId: item.fileId, name: materialFileName(item),
    size: item.size ?? null, missing: item.missing, materialId: item.id,
    revision: item.pinnedRevision ?? null };
}

interface Entry {
  key: string;
  title: string;
  fileName: string;
  target: PreviewTarget | null;
  fileId: string | null;
  material: MaterialItem | null;
  fileHubRef: FileHubRef | null;
  size?: number;
  version?: string | null;
  purpose?: string;
  sourceId?: string;
  sourceTitle?: string;
  sourceLevel?: number;
  missing?: boolean;
  createdAt?: string | number | null;
  description?: string;
  tags?: string[];
  fileRevision?: number;
  fileUpdatedAt?: number;
}

function materialEntry(item: MaterialItem): Entry {
  return {
    key: 'material:' + item.id,
    title: item.displayName ?? item.title,
    fileName: materialFileName(item),
    target: previewTargetOf(item),
    fileId: item.fileId,
    material: item,
    fileHubRef: null,
    size: item.size,
    version: item.businessVersion ?? item.publishedVersion,
    purpose: item.purpose,
    sourceId: item.sourceNodeId,
    sourceTitle: item.sourceTitle,
    sourceLevel: item.sourceLevel,
    missing: item.missing,
    createdAt: item.createdAt,
    description: item.description,
    tags: item.tags,
    fileRevision: item.fileRevision,
    fileUpdatedAt: item.fileUpdatedAt,
  };
}

function fileEntry(ref: FileHubRef): Entry {
  return {
    key: 'hub:' + ref.fileId + ':' + (ref.sourceNodeId ?? 'direct'),
    title: ref.name,
    fileName: ref.name,
    fileId: ref.fileId,
    target: { kind: 'file', fileId: ref.fileId, name: ref.name, size: ref.size, missing: ref.missing },
    material: null,
    fileHubRef: ref,
    size: ref.size,
    sourceId: ref.sourceNodeId,
    sourceTitle: ref.sourceTitle,
    sourceLevel: ref.sourceLevel,
    missing: ref.missing,
    createdAt: ref.createdAt,
    purpose: ref.purpose ?? ref.relation,
    description: ref.description,
    tags: ref.tags,
    fileRevision: ref.fileRevision,
    fileUpdatedAt: ref.fileUpdatedAt,
  };
}

type Selected = { key: string; kind: 'preview' | 'history'; maximize?: boolean };

interface Group {
  key: string;
  level: number;
  title: string;
  entries: Entry[];
  sourceId?: string;
  inherited: boolean;
}

export function materialGroups(node: Pick<NodeDTO, 'depth'>, data: MaterialsView): Group[] {
  // File Hub links and Work Materials are two ways to reference one canonical
  // File ID. Show it once within its owner level, without losing either link.
  const direct = (data.items ?? []).map(materialEntry);
  const directIds = new Set(direct.map((entry) => entry.fileId).filter(Boolean));
  direct.push(...(data.fileHubRefs ?? []).filter((ref) => !directIds.has(ref.fileId)).map(fileEntry));
  const groups: Group[] = [{
    key: 'direct', level: node.depth, title: '当前层级直接关联',
    inherited: false, entries: direct,
  }];
  const inherited = (data.inherited ?? []).map(materialEntry);
  const workIds = new Set(inherited.map((entry) => `${entry.sourceId}:${entry.fileId}`));
  inherited.push(...(data.inheritedFileHubRefs ?? [])
    .filter((ref) => !workIds.has(`${ref.sourceNodeId}:${ref.fileId}`)).map(fileEntry));
  const owners = new Map<string, Group>();
  for (const entry of inherited) {
    if (!entry.sourceId) continue;
    const level = entry.sourceLevel ?? Math.max(1, node.depth - 1);
    const group = owners.get(entry.sourceId) ?? {
      key: entry.sourceId, level,
      title: entry.sourceTitle ?? 'Parent work item', sourceId: entry.sourceId,
      inherited: true, entries: [],
    };
    group.entries.push(entry);
    owners.set(entry.sourceId, group);
  }
  groups.push(...[...owners.values()].sort((a, b) => b.level - a.level));
  return groups;
}

/** Compact, owner-aware read-only files. Remove means unlink ONLY, never delete
 * the canonical Work library file. Content changes require Windows Explorer. */
export function MaterialsTab({ node }: { node: NodeDTO }) {
  const announce = useAnnounce();
  const path = useAppPath();
  const requestedPreview = new URLSearchParams(path.split('?')[1] ?? '').get('preview');
  const query = useQuery<MaterialsView>(`materials:${node.id}:${node.revision}`,
    (signal) => get<MaterialsView>('materials', { id: node.id }, { signal }));
  const [selected, setSelected] = useState<Selected | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const addFile = async (file: File | undefined) => {
    if (!file || busy) return;
    if (fileInput.current) fileInput.current.value = '';
    setError(null);
    if (file.size > MAX_UPLOAD_BYTES || file.size === 0) {
      setError('文件必须非空且不能超过 100 MB。'); return;
    }
    setBusy(true);
    let uploaded = false;
    try {
      const result = await uploadMaterialFile(file);
      uploaded = true;
      const linked = await post<NodeResult>('material-add', {
        id: node.id, baseRevision: node.revision,
        type: 'file', fileId: result.id, title: file.name,
      });
      afterWrite(linked.node);
      invalidate('filehub:'); invalidate('materials:');
      announce('文件已新增到当前 L' + node.depth + ' 的 Materials。');
    } catch (failure) {
      setError(uploaded
        ? '文件已安全入库，但关联当前层级失败；原件已保留，请刷新后重新关联。' + describeError(failure)
        : (failure instanceof ApiError && failure.status === 409
          ? '存储目录已有同名文件；请通过「在目录中打开」处理已有原件，不会自动覆盖。'
          : '新增文件失败：' + describeError(failure)));
    } finally {
      setBusy(false);
    }
  };

  const addLink = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!HTTP_URL.test(url.trim())) { setError('只接受 http/https 链接。'); return; }
    setError(null); setBusy(true);
    try {
      const result = await post<NodeResult>('material-add', {
        id: node.id, baseRevision: node.revision,
        type: 'link', title: linkTitle.trim() || url.trim(), url: url.trim(),
      });
      afterWrite(result.node);
      invalidate('materials:');
      setLinkOpen(false); setUrl(''); setLinkTitle('');
      announce('链接已添加到当前层级。');
    } catch (failure) { setError('添加链接失败：' + describeError(failure)); }
    finally { setBusy(false); }
  };

  const groups = useMemo(() => query.data ? materialGroups(node, query.data) : [], [node, query.data]);
  const all = groups.flatMap((group) => group.entries).filter((entry) => !removed.has(entry.key));
  const active: Selected | null = selected ?? (requestedPreview
    ? (() => {
      const entry = all.find((value) =>
        value.material?.id === requestedPreview || value.fileId === requestedPreview);
      return entry ? { key: entry.key, kind: 'preview' as const } : null;
    })()
    : null);

  const remove = async (entry: Entry) => {
    if (busy || !entry.material && !entry.fileHubRef) return;
    setBusy(true);
    setError(null);
    try {
      if (entry.material) {
        const result = await post<NodeResult>('material-remove', {
          id: node.id, baseRevision: node.revision, materialId: entry.material.id,
        });
        afterWrite(result.node);
      } else if (entry.fileHubRef && entry.fileId) {
        await postFileHub({ action: 'unlink', id: entry.fileId,
          targetType: node.kind, targetId: node.id, relation: entry.fileHubRef.relation });
        invalidate('materials:');
      }
      setRemoved((previous) => new Set(previous).add(entry.key));
      setSelected(null);
      setRemoving(null);
      announce('已解除当前层级关联；存储目录中的原文件没有删除。');
    } catch (failure) {
      const message = `Remove association failed: ${describeError(failure)}`;
      setError(message); announce(message);
    } finally {
      setBusy(false);
    }
  };

  const closePreview = () => {
    setSelected(null);
    if (requestedPreview) navigate(nodePath(node.id, 'materials'), { replace: true });
  };

  const choose = (entry: Entry, kind: Selected['kind'], maximize = false) => {
    setSelected((current) => current?.key === entry.key &&
      current.kind === kind && current.maximize === maximize ? null
      : { key: entry.key, kind, maximize });
    setRemoving(null);
  };

  function renderEntry(entry: Entry, inherited: boolean) {
    const target = entry.target;
    const isFile = target?.kind === 'file';
    const pinned = isFile && target.revision != null;
    const href = target?.kind === 'link' ? target.url :
      nodePath(node.id, 'materials') +
        '?preview=' + encodeURIComponent(entry.material?.id ?? entry.fileId ?? entry.key);
    const download = isFile && target ?
      fileUrl(target.fileId, 'download') +
        (pinned ? '&revision=' + target.revision : '') : null;
    const opened = active?.key === entry.key;
    return <li className="material-compact-item" key={entry.key}
      data-material-id={entry.material?.id} data-file-id={entry.fileId ?? undefined}
      data-scope={inherited ? 'inherited' : 'direct'}
      data-missing={entry.missing ? 'true' : undefined}>
      <div className="material-compact-row">
        <MaterialFormatIcon name={entry.fileName} materialType={entry.material?.materialType} format={entry.material?.format}/>
        <div className="material-compact-primary">
          <button type="button" className="material-compact-name" title={entry.title}
            disabled={!target} onClick={() => target && choose(entry, 'preview')}>{entry.title}</button>
          <span className="material-compact-meta">
            {formatMaterialCreatedAt(entry.createdAt) ? <time title="添加时间（当前设备时区）"
              className="material-compact-created">添加 {formatMaterialCreatedAt(entry.createdAt)}</time> : null}
            {entry.version ? <span className="material-compact-version">{entry.version}</span> : null}
            {typeof entry.size === 'number' ? formatSize(entry.size) : null}
            {entry.purpose ? ' · ' + (PURPOSE_LABEL[entry.purpose] ?? entry.purpose) : null}
            {pinned ? ` · Evidence pinned R${target.revision}` : null}
            {entry.missing ? ' · File is missing' : null}
          </span>
        </div>
        <div className="material-compact-actions" role="group" aria-label={`File actions: ${entry.title}`}>
          <button type="button" className="material-icon-btn" title="预览" aria-label={`Preview: ${entry.title}`}
            disabled={!target || entry.missing} aria-pressed={opened && active.kind === 'preview' && !active.maximize}
            onClick={() => choose(entry, 'preview')}><Icon name="eye" size={17}/></button>
          {isFile && target && !entry.missing ? <><OpenNativeFile fileId={target.fileId} name={entry.title}/><OpenStorageLocation fileId={target.fileId} name={entry.title}/></> : null}
          {isFile && target ? <button type="button" className="material-icon-btn" title="版本历史（只读）"
            aria-label={`Version history: ${entry.title}`}
            aria-pressed={opened && active.kind === 'history'} onClick={() => choose(entry, 'history')}>
            <Icon name="history" size={17}/></button> : null}
          {isFile && target && !entry.missing ? <button type="button" className="material-icon-btn" title="最大化预览"
            aria-label={`Maximize preview: ${entry.title}`} onClick={() => choose(entry, 'preview', true)}>
            <Icon name="expand" size={17}/></button> : null}
          {target ? <a className="material-icon-btn" href={href} target="_blank" rel="noopener noreferrer"
            title="在新标签页打开预览" aria-label={`Open in new tab: ${entry.title}`}>
            <Icon name="open" size={17}/></a> : null}
          {download && !entry.missing ? <a className="material-icon-btn" href={download} download={entry.fileName}
            title="下载原件" aria-label={`Download: ${entry.title}`}>
            <Icon name="download" size={17}/></a> : null}
          {!inherited ? <button type="button" className="material-icon-btn material-unlink-btn"
            title="移除关联（不删除原文件）" aria-label={`Remove: ${entry.title}`}
            disabled={busy} onClick={() => {setRemoving(entry.key);setSelected(null);}}>
            <Icon name="trash" size={17}/></button> : null}
        </div>
        {entry.material?.unconfirmed ? <UnconfirmedControls writeId={entry.material.unconfirmed} subject={entry.title}/> : null}
      </div>
      {entry.material?.usedBy?.length ? <details className="material-compact-used material-uses">
        <summary>Used by ({entry.material.usedBy.length})</summary>
        {entry.material.usedBy.map((use) => <AppLink key={use.nodeId + use.purpose}
          to={nodePath(use.nodeId, 'materials')}>{use.title}</AppLink>)}
      </details> : null}
      {removing === entry.key ? <div className="material-unlink-confirm" role="alert">
        <span>只解除 L{node.depth} 的文件关联，不会删除 KB_Work 存储目录中的原文件。确定移除？</span>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove(entry)}>确认解除关联</button>
        <button type="button" className="btn" onClick={() => setRemoving(null)}>取消</button>
      </div> : null}
      {opened && active.kind === 'history' && entry.fileId ? <FileVersionTools
        fileId={entry.fileId} pinnedRevision={target?.kind === 'file' ? target.revision : null}
        openInitially/> : null}
      {opened && active.kind === 'preview' && target ? <section className="materials-inline-preview material-compact-preview"
        aria-label={`In-page Material preview: ${entry.title}`}>
        <div className="materials-preview-head">
          <strong>{entry.title} · Read-only preview</strong>
          <button type="button" className="btn" onClick={closePreview}>Close preview</button>
        </div>
        <PreviewContent key={entry.key + String(active.maximize)} target={target}
          inlineControls={false} initialMaximized={active.maximize === true}/>
      </section> : null}
    </li>;
  }

  return <div className="materials-tab materials-inline-workspace materials-compact-library" data-read-only="true">
    {query.data?.lineage?.length ? <nav className="material-lineage task-path" aria-label="Material lineage">
      {query.data.lineage.map((ancestor, index) => <span key={ancestor.id}>
        {index ? ' › ' : ''}<AppLink to={nodePath(ancestor.id, 'materials')}>{ancestor.title}</AppLink>
      </span>)}
    </nav> : null}
    <p className="materials-workflow-hint">可在当前 L{node.depth} 添加新文件或链接；已有文件内容只能在原始存储目录中编辑或替换。点击文件后的 <Icon name="folder" size={15}/> 打开真实目录；同一路径修改原件会记录新 Revision；仅将 V3 作为另一个文件并排放入不会自动覆盖 V2 的关联。</p>
    {error ? <p className="error-text" role="alert">{error}</p> : null}
    {!query.data ? query.status === 'error' ? <p role="alert" className="error-text">Cannot load Materials: {describeError(query.error)}</p>
      : <p className="muted" role="status">{L.loading}</p> : null}
    {groups.map((group) => {
      const entries = group.entries.filter((entry) => !removed.has(entry.key));
      return <section key={group.key} className="material-owner-group"
        data-level={group.level} data-origin={group.inherited ? 'inherited' : 'direct'}>
        <div className="material-owner-head">
          <span className="material-level-mark">L{group.level}</span>
          {group.inherited ? <div className="material-owner-label">
            <span>继承自上层 · </span>
            {group.sourceId ? <AppLink to={nodePath(group.sourceId, 'materials')}>{group.title}</AppLink> : group.title}
          </div> : <strong>当前 L{node.depth} · 直接关联</strong>}
          <span className="material-group-count">{entries.length} files</span>
          {!group.inherited ? <div className="materials-add-actions">
            <input ref={fileInput} type="file" className="visually-hidden" aria-label="Choose new Material file"
              disabled={busy} onChange={(event) => void addFile(event.target.files?.[0])}/>
            <button type="button" className="btn materials-add-file" disabled={busy || Boolean(node.archivedAt)}
              aria-label="Add Material file" onClick={() => fileInput.current?.click()}>
              <Icon name="plus" size={16}/> 添加文件
            </button>
            <button type="button" className="btn materials-add-link" disabled={busy || Boolean(node.archivedAt)}
              aria-label="Add Material link" onClick={() => setLinkOpen(true)}>
              <Icon name="open" size={15}/> 添加链接
            </button>
          </div> : null}
        </div>
        {entries.length ? <ul className="material-compact-list">
          {entries.map((entry) => renderEntry(entry, group.inherited))}
        </ul> : <p className="material-owner-empty">{group.inherited ? '无继承文件' : '此层级暂无直接关联的文件。'}</p>}
      </section>;
    })}
    {!groups.length && query.data ? <p className="muted">{L.materialsEmpty}</p> : null}
    {linkOpen ? <ModalDialog label="添加 Materials 链接" onClose={() => setLinkOpen(false)}>
      <form className="form" onSubmit={(event) => void addLink(event)}>
        <h2>添加当前 L{node.depth} 的链接</h2>
        <label>链接名称 <input value={linkTitle} onChange={(event) => setLinkTitle(event.target.value)}
          placeholder="例如：SharePoint 设计文档" /></label>
        <label>URL <input type="url" required value={url} onChange={(event) => setUrl(event.target.value)}
          placeholder="https://" /></label>
        {error ? <p role="alert" className="error-text">{error}</p> : null}
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => setLinkOpen(false)}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>添加链接</button>
        </div>
      </form>
    </ModalDialog> : null}
  </div>;
}
