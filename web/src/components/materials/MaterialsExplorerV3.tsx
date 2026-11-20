import { useEffect, useMemo, useRef, useState, type FormEvent, type CSSProperties, type PointerEvent } from 'react';
import { ApiError, get, post, postFileHub } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { MAX_UPLOAD_BYTES, uploadMaterialFile } from '../../lib/fileHub';
import { formatMaterialCreatedAt } from '../../lib/materialTime';
import { afterWrite } from '../../lib/nodeData';
import { fileUrl, formatSize } from '../../lib/preview';
import { invalidate, useQuery } from '../../lib/queryCache';
import { fetchFiles } from '../../lib/phase4';
import type { FileRefs, HubFile, MaterialsView, NodeDTO, NodeResult } from '../../lib/types';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';
import { ModalDialog } from '../ModalDialog';
import { useAppPath, navigate, nodePath } from '../../lib/router';
import { OpenStorageLocation } from '../preview/OpenStorageLocation';
import { OpenNativeFile } from '../preview/OpenNativeFile';
import { FileVersionTools } from '../preview/FileVersionTools';
import { PreviewContent } from '../preview/PreviewDrawer';
import { MaterialFormatIcon, materialFormatOf } from './MaterialFormatIcon';
import { materialGroups } from './MaterialsTab';

type PanelTab = 'preview' | 'details' | 'history' | 'links';
type GroupList = ReturnType<typeof materialGroups>;
type Entry = GroupList[number]['entries'][number];
type Chosen = { entry: Entry; inherited: boolean };
const PURPOSE = [
  ['reference','Reference'], ['plan','Main plan'], ['deliverable','Deliverable'],
  ['evidence','Verification evidence'], ['related','Related material'],
] as const;
const BUCKETS = ['items', 'fileHubRefs', 'inherited', 'inheritedFileHubRefs'] as const;
const count = (value: MaterialsView): number => BUCKETS.reduce((sum, key) => sum + (value[key]?.length ?? 0), 0);
function combine(pages: MaterialsView[]): MaterialsView {
  const first = pages[0];
  const merged: MaterialsView = { items: [], inherited: [], fileHubRefs: [], inheritedFileHubRefs: [], lineage: first?.lineage ?? [] };
  for (const page of pages) for (const key of BUCKETS) {
    if (key === 'items') merged.items.push(...page.items);
    else if (key === 'inherited') merged.inherited!.push(...(page.inherited ?? []));
    else if (key === 'fileHubRefs') merged.fileHubRefs!.push(...(page.fileHubRefs ?? []));
    else merged.inheritedFileHubRefs!.push(...(page.inheritedFileHubRefs ?? []));
  }
  return merged;
}
function entryKey(entry: Entry): string { return entry.key; }
function tagsOf(raw: string): string[] {
  return [...new Set(raw.split(/[,，\n]/).map(s => s.trim()).filter(Boolean))].slice(0, 30);
}
function seenRead(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem('kbw:materials:seen-revisions') ?? '{}') as Record<string, number>; }
  catch { return {}; }
}

export function MaterialsExplorerV3({ node }: { node: NodeDTO }) {
  const path = useAppPath();
  const requestedPreview = new URLSearchParams(path.split('?')[1] ?? '').get('preview');
  const [search, setSearch] = useState('');
  const [stableSearch, setStableSearch] = useState('');
  const [format, setFormat] = useState('');
  const [source, setSource] = useState('');
  const [purposeFilter, setPurposeFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [sort, setSort] = useState('created');
  const [extra, setExtra] = useState<MaterialsView[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Success feedback is brief; errors are kept until the user dismisses them.
  useEffect(() => {
    if (!info) return undefined;
    const timer = window.setTimeout(() => setInfo(null), 5000);
    return () => window.clearTimeout(timer);
  }, [info]);
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>('preview');
  const [panelFull, setPanelFull] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmSource, setConfirmSource] = useState<Chosen | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [oldTag, setOldTag] = useState('');
  const [newTag, setNewTag] = useState('');
  const [fileChecked, setFileChecked] = useState<Set<string>>(new Set());
  const [linkTitle, setLinkTitle] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [purposeDraft, setPurposeDraft] = useState('reference');
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');
  const [seen, setSeen] = useState<Record<string, number>>(seenRead);
  const fileInput = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useState<number>(() => {
    const parsed = Number(localStorage.getItem('kbw:materials:v3:list-width'));
    return parsed >= 12 && parsed <= 85 ? parsed : 55;
  });
  const listWidthRef = useRef(listWidth);
  const resizing = useRef(false);
  const bounds = () => {
    const width = workspaceRef.current?.getBoundingClientRect().width ?? 1000;
    // Permit a much narrower file list, but retain 170px for navigation and
    // 320px for the document preview; maximize hides the list entirely.
    const min = Math.max(12, 170 / Math.max(width, 1) * 100);
    const max = Math.max(min, Math.min(85, 100 - 320 / Math.max(width, 1) * 100));
    return {min, max};
  };
  const updateWidth = (requested: number) => {
    const {min, max} = bounds();
    const next = Math.max(min, Math.min(max, requested));
    listWidthRef.current = next;
    setListWidth(next);
  };
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizing.current || !workspaceRef.current) return;
    const rect = workspaceRef.current.getBoundingClientRect();
    if (!rect.width) return;
    updateWidth(((event.clientX - rect.left) / rect.width) * 100);
  };
  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    resizing.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    resize(event);
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizing.current) return;
    resizing.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    localStorage.setItem('kbw:materials:v3:list-width', String(listWidthRef.current));
  };

  useEffect(() => {
    const id = window.setTimeout(() => setStableSearch(search.trim()), 220);
    return () => window.clearTimeout(id);
  }, [search]);
  useEffect(() => { setExtra([]); setChecked(new Set()); setSelectedKey(null); }, [node.id, stableSearch, format, source, purposeFilter, tagFilter, sort]);
  const criteria = `${node.id}:${node.revision}:${stableSearch}:${format}:${source}:${purposeFilter}:${tagFilter}:${sort}`;
  const query = useQuery<MaterialsView>(`materials-v3:${criteria}`, async signal => {
    try {
      const response = await get<MaterialsView>('materials-v3', {id: node.id, q: stableSearch,
        format, source, purpose: purposeFilter, tag: tagFilter, sort, limit: 200, offset: 0}, {signal});
      if (Array.isArray(response.items) && typeof response.total === 'number') return response;
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
    }
    // Cached frontend against an older running Python server: show read-only
    // compatibility content until the local Work server is restarted.
    const legacy = await get<MaterialsView>('materials', {id:node.id}, {signal});
    return {...legacy, total:count(legacy), limit:200, offset:0, hasMore:false, legacy:true};
  });
  const pages = useMemo(() => query.data ? [query.data, ...extra] : [], [query.data, extra]);
  const data = useMemo(() => combine(pages), [pages]);
  const groups = useMemo(() => materialGroups(node, data), [node, data]);
  const all = groups.flatMap(g => g.entries.map(entry => ({entry, inherited:g.inherited})));
  const selected: Chosen | undefined = all.find(row => row.entry.key === selectedKey)
    ?? (requestedPreview ? all.find(row => row.entry.fileId === requestedPreview
      || row.entry.material?.id === requestedPreview) : undefined);
  useEffect(() => {
    if (!selected || panelFull) return undefined;
    // Saved widths from an older version can exceed the safe bound on a smaller screen.
    const clampToAvailableSpace = () => updateWidth(listWidthRef.current);
    clampToAvailableSpace();
    window.addEventListener('resize', clampToAvailableSpace);
    return () => window.removeEventListener('resize', clampToAvailableSpace);
  }, [selected?.entry.key, panelFull]);
  const hubFiles = useQuery<HubFile[]>('materials-v3:hub-list', signal => fetchFiles(false, signal), {enabled: pickOpen || tagManagerOpen});
  const linksQuery = useQuery<FileRefs>(`materials-v3:refs:${selected?.entry.fileId ?? ''}`,
    signal => get<FileRefs>('file-refs', {ids: selected?.entry.fileId ?? ''}, {signal}),
    {enabled: Boolean(selected?.entry.fileId)});
  const selectedFiles = all.filter(x => !x.inherited && checked.has(x.entry.key));
  const hasMore = Boolean(query.data?.total && count(data) < query.data.total);
  const legacyBackend = Boolean(query.data?.legacy);
  useEffect(() => {
    if (legacyBackend) return undefined;
    const timer = window.setInterval(() => invalidate('materials-v3:'), 60_000);
    return () => window.clearInterval(timer);
  }, [legacyBackend]);
  const tagChoices = [...new Set(all.flatMap(x => x.entry.tags ?? []))].sort((a,b)=>a.localeCompare(b));
  const globalTagChoices = [...new Set((hubFiles.data??[]).flatMap(f=>f.tags??[]))].sort((a,b)=>a.localeCompare(b));

  useEffect(() => {
    if (!query.data) return;
    setSeen(previous => {
      const next = {...previous}; let changed = false;
      for (const row of all) {
        const fid = row.entry.fileId; const revision = row.entry.fileRevision;
        if (fid && revision !== undefined && next[fid] === undefined) { next[fid] = revision; changed = true; }
      }
      if (changed) localStorage.setItem('kbw:materials:seen-revisions', JSON.stringify(next));
      return changed ? next : previous;
    });
  }, [query.data, extra]);
  useEffect(() => {
    setPurposeDraft(selected?.entry.purpose ?? 'reference');
    setDescriptionDraft(selected?.entry.description ?? '');
    setTagsDraft((selected?.entry.tags ?? []).join(', '));
  }, [selected?.entry.key, selected?.entry.purpose, selected?.entry.description, selected?.entry.tags?.join('|')]);

  function reload() { invalidate('materials-v3:'); invalidate('materials:'); invalidate('filehub:'); }
  function choose(entry: Entry, tab: PanelTab = 'preview', full = false) {
    setSelectedKey(entry.key); setPanelTab(tab); setPanelFull(full);
    if (entry.fileId && entry.fileRevision !== undefined) {
      setSeen(prev => {
        const next = {...prev, [entry.fileId!]: entry.fileRevision!};
        localStorage.setItem('kbw:materials:seen-revisions', JSON.stringify(next));
        return next;
      });
    }
  }
  function toggleChecked(key: string) {
    setChecked(prev => {const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next;});
  }
  async function loadMore() {
    if (!query.data || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const more = await get<MaterialsView>('materials-v3', {id:node.id, q:stableSearch,
        format, source, purpose:purposeFilter, tag:tagFilter, sort, limit:200, offset:count(data)});
      setExtra(prev => [...prev, more]);
    } catch (failure) { setError('加载更多文件失败：' + describeError(failure)); }
    finally { setLoadingMore(false); }
  }
  async function upload(file?: File) {
    if (!file || busy) return;
    if (fileInput.current) fileInput.current.value = '';
    if (!file.size || file.size > MAX_UPLOAD_BYTES) {setError('文件必须非空且不能超过 100 MB。'); return;}
    setBusy(true); setError(null); setInfo(null);
    let uploaded = false;
    try {
      const result = await uploadMaterialFile(file, node.id);
      uploaded = true;
      const saved = await post<NodeResult>('material-add', {id:node.id, baseRevision:node.revision,
        type:'file',fileId:result.id,title:file.name});
      afterWrite(saved.node); reload(); setExtra([]);
      setInfo('文件已安全入库并关联当前层级。');
    } catch (failure) {
      setError((uploaded ? '文件已入库但关联失败，原件已保留。' : '新增文件失败。') + describeError(failure));
    } finally {setBusy(false);}
  }
  async function addLink(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    if (!/^https?:\/\//i.test(linkUrl)) {setError('只接受 HTTP/HTTPS 链接。'); return;}
    setBusy(true); setError(null);
    try {
      const saved = await post<NodeResult>('material-add', {id:node.id,baseRevision:node.revision,
        type:'link',title:linkTitle.trim() || linkUrl,url:linkUrl.trim()});
      afterWrite(saved.node); reload(); setExtra([]); setLinkOpen(false); setLinkUrl('');setLinkTitle('');
      setInfo('链接已关联到当前工作项。');
    } catch (failure) {setError('添加链接失败：'+describeError(failure));}
    finally {setBusy(false);}
  }
  async function addExisting() {
    const files = (hubFiles.data ?? []).filter(f=>fileChecked.has(f.id));
    if (!files.length || busy) return;
    setBusy(true); setError(null); let revision=node.revision; let succeeded=0;
    const failures:string[]=[];
    const directIds = new Set(groups.filter(g=>!g.inherited).flatMap(g=>g.entries.map(e=>e.fileId)));
    for (const file of files) {
      if (directIds.has(file.id)) {failures.push(file.name+'（已直接关联）'); continue;}
      try {
        const saved=await post<NodeResult>('material-add',{id:node.id,baseRevision:revision,
          type:'file',fileId:file.id,title:file.displayName??file.name});
        revision=saved.node.revision; afterWrite(saved.node); succeeded++;
      } catch (failure) {failures.push(file.name+': '+describeError(failure));}
    }
    reload(); setExtra([]); setBusy(false);
    setInfo(`已新增 ${succeeded} 个文件关联，未复制任何原件。`);
    if (failures.length) setError('未成功：'+failures.join('；'));
    else {setPickOpen(false);setFileChecked(new Set());}
  }
  async function removeDirect() {
    if (busy || !selectedFiles.length) return;
    setBusy(true); setError(null); setConfirmRemove(false);
    let revision=node.revision; let succeeded=0; const failed:string[]=[];
    for (const {entry} of selectedFiles) {
      try {
        if (entry.material) {
          const saved=await post<NodeResult>('material-remove',{id:node.id,baseRevision:revision,
            materialId:entry.material.id});
          revision=saved.node.revision; afterWrite(saved.node);
        } else if (entry.fileHubRef && entry.fileId) {
          await postFileHub({action:'unlink', id:entry.fileId,
            targetType:node.kind,targetId:node.id,relation:entry.fileHubRef.relation});
        }
        succeeded++;
      } catch (failure) {failed.push(entry.title+': '+describeError(failure));}
    }
    reload(); setExtra([]); setChecked(new Set()); setSelectedKey(null);setBusy(false);
    setInfo(`解除 ${succeeded} 个当前层级关联，原件均保留。`);
    if (failed.length) setError('部分关联未解除：'+failed.join('；'));
  }
  async function removeFromSourceL1() {
    const chosen = confirmSource;
    const entry = chosen?.entry;
    if (!chosen?.inherited || !entry || entry.sourceLevel !== 1 || !entry.sourceId || busy) return;
    setBusy(true); setError(null);
    try {
      // Read the live source Revision rather than using the child revision.
      // This operation changes the L1 association visible to all descendants.
      const owner = await get<NodeDTO>('node', {id:entry.sourceId});
      if (owner.id !== entry.sourceId || owner.depth !== 1 ||
          !['initiative','topic','knowledge_collection'].includes(owner.kind)) {
        throw new Error('无法验证 L1 来源节点，未执行解除关联。');
      }
      if (entry.material) {
        const saved = await post<NodeResult>('material-remove', {
          id:owner.id, baseRevision:owner.revision, materialId:entry.material.id,
        });
        afterWrite(saved.node);
      } else if (entry.fileHubRef && entry.fileId) {
        await postFileHub({
          action:'unlink', id:entry.fileId, targetType:owner.kind,
          targetId:owner.id, relation:entry.fileHubRef.relation,
        });
      } else {
        throw new Error('文件缺少有效的来源关联，未执行操作。');
      }
      reload(); setExtra([]); setSelectedKey(null); setConfirmSource(null);
      setInfo('已解除来源 L1 的文件关联。所有下级继承展示将同步更新；原件未删除。');
    } catch (failure) {
      setError('解除来源 L1 关联失败：' + describeError(failure));
    } finally {setBusy(false);}
  }
  function downloadChecked() {
    const items = [...new Set(selectedFiles.filter(x=>x.entry.fileId).map(x=>
      x.entry.fileId!+(x.entry.target?.kind==='file' && x.entry.target.revision!=null?'@'+x.entry.target.revision:'')))];
    if (!items.length) {setError('所选项目没有可下载的文件。');return;}
    if (items.length > 30) {setError('单次最多下载 30 份文件。');return;}
    window.location.href='/api/file-hub/bulk-download?items='+encodeURIComponent(items.join(','));
  }
  async function renameTag() {
    if (!oldTag || !newTag.trim() || busy) return;
    setBusy(true);setError(null);
    try {
      const result=await postFileHub<{affected:number}>({action:'rename-tag',from:oldTag,to:newTag.trim()});
      setInfo('标签已重命名，影响 '+result.affected+' 个 canonical 文件；已记录审计。');
      setTagManagerOpen(false);setNewTag('');setOldTag('');reload();setExtra([]);
    } catch (failure) {setError('重命名失败：'+describeError(failure));}
    finally {setBusy(false);}
  }
  async function saveMeta() {
    if (!selected || selected.inherited || busy) return;
    const item=selected.entry;
    setBusy(true);setError(null);setInfo(null);
    const kind=item.material ? 'material' : 'hub';
    const refId=item.material?.id ?? item.fileId;
    let assocDone=false;
    try {
      if (!refId) throw new Error('关联 ID 不存在');
      const saved=await post<NodeResult>('material-meta',{id:node.id,baseRevision:node.revision,
        refKind:kind,refId,purpose:purposeDraft,description:descriptionDraft});
      assocDone=true;afterWrite(saved.node);
      if (item.fileId) {
        const desired=tagsOf(tagsDraft);
        const original=item.tags ?? [];
        if (desired.join('|') !== original.join('|')) {
          await postFileHub({action:'tags',id:item.fileId,tags:desired,expectedTags:[...original].sort()});
        }
      }
      reload();setExtra([]);
      setInfo('资料元数据已保存，文件内容未修改。');
    } catch (failure) {
      setError((assocDone ? '关联信息已保存，但 Tags 保存失败。' : '保存元数据失败。')+describeError(failure));
      reload();
    } finally {setBusy(false);}
  }

  return <div className="materials-explorer-v3" data-read-only="true">
    {data.lineage?.length ? <nav className="material-lineage task-path" aria-label="Materials 所属路径">
      {data.lineage.map((p,i)=><span key={p.id}>{i?' › ':''}<AppLink to={nodePath(p.id,'materials')}>{p.title}</AppLink></span>)}
    </nav>:null}
    <header className="materials-v3-title"><div><h2>Materials</h2>
      <p className="muted">当前层级及继承资料 · 一份原件，多处关联 · 文件内容只能在受控原目录更新</p></div>
      <div className="materials-v3-add">
        <input className="visually-hidden" type="file" ref={fileInput} aria-label="Choose new Material file"
          disabled={busy} onChange={e=>void upload(e.target.files?.[0])}/>
        <button className="btn btn-primary" type="button" disabled={busy||Boolean(node.archivedAt)||legacyBackend} onClick={()=>fileInput.current?.click()}><Icon name="plus" size={15}/> 添加文件</button>
        <button className="btn" type="button" disabled={busy||Boolean(node.archivedAt)||legacyBackend} onClick={()=>setPickOpen(true)}><Icon name="open" size={15}/> 关联已有</button>
        <button className="btn" type="button" disabled={busy||Boolean(node.archivedAt)||legacyBackend} onClick={()=>setLinkOpen(true)}>添加链接</button>
      </div>
    </header>
    <div className="materials-v3-toolbar">
      <label className="materials-v3-search"><Icon name="search" size={16}/><span className="visually-hidden">搜索 Materials</span>
        <input type="search" value={search} placeholder="搜索文件名、标签、描述、来源…" onChange={e=>setSearch(e.target.value)}/></label>
      <label>格式 <select aria-label="Material format" value={format} onChange={e=>setFormat(e.target.value)}>
        <option value="">全部</option>{['pdf','docx','xlsx','pptx','html','md','png','jpg','txt'].map(x=><option key={x} value={x}>{x.toUpperCase()}</option>)}
      </select></label>
      <label>来源 <select aria-label="Material source" value={source} onChange={e=>setSource(e.target.value)}>
        <option value="">全部层级</option><option value="direct">当前直接关联</option><option value="inherited">所有继承</option>
        <option value="1">L1</option><option value="2">L2</option><option value="3">L3</option>
      </select></label>
      <label>用途 <select aria-label="Material purpose" value={purposeFilter} onChange={e=>setPurposeFilter(e.target.value)}>
        <option value="">全部</option>{PURPOSE.map(([key,title])=><option value={key} key={key}>{title}</option>)}
      </select></label>
      <label>标签 <select aria-label="Material tags" value={tagFilter} onChange={e=>setTagFilter(e.target.value)}>
        <option value="">全部</option>{tagChoices.map(tag=><option value={tag} key={tag}>{tag}</option>)}
      </select></label>
      <label>排序 <select aria-label="Material sort" value={sort} onChange={e=>setSort(e.target.value)}>
        <option value="created">添加时间 ↓</option><option value="name">文件名 A–Z</option><option value="updated">内容更新 ↓</option>
      </select></label>
      <button type="button" className="btn" disabled={legacyBackend} onClick={()=>setTagManagerOpen(true)}>管理 Tags</button>
      <button type="button" className="btn" onClick={()=>{reload();setExtra([]);}}>刷新</button>
      <button type="button" className="btn" disabled={legacyBackend} aria-pressed={batch} onClick={()=>{setBatch(v=>!v);setChecked(new Set());}}>多选</button>
    </div>
    {batch ? <div className="materials-v3-batch" role="toolbar" aria-label="Bulk Material actions">
      <strong>已选择 {selectedFiles.length}</strong>
      <button className="btn" type="button" disabled={!selectedFiles.length} onClick={downloadChecked}>批量下载 ZIP</button>
      <button className="btn" type="button" disabled={!selectedFiles.length||busy} onClick={()=>setConfirmRemove(true)}>批量解除关联</button>
      <button className="btn" type="button" onClick={()=>setChecked(new Set())}>清除选择</button>
      <span className="muted">只能解除当前节点直接关联，不删除文件原件。</span>
    </div>:null}
    {legacyBackend?<p className="error-text" role="status">Work Server 仍在运行旧版后端。Materials 暂时使用只读兼容显示；请重启本机 KB_Work 服务后启用 V3.0 的关联、搜索、上传与元数据功能。</p>:null}
    {error?<div className="error-text materials-v3-feedback" role="alert">
      <span>{error}</span><button type="button" className="btn" aria-label="关闭 Materials 错误提示"
        onClick={() => setError(null)}>×</button>
    </div>:null}
    {info?<div role="status" className="materials-v3-info materials-v3-feedback">
      <span>{info}</span><button type="button" className="btn" aria-label="关闭 Materials 成功提示"
        onClick={() => setInfo(null)}>×</button>
    </div>:null}
    {query.status==='error'?<p role="alert" className="error-text">Materials 加载失败：{describeError(query.error)}</p>:null}
    {!query.data?<p className="muted" role="status">读取 Materials…</p>:null}
    <div ref={workspaceRef} style={{'--materials-list-ratio': listWidth+'%'} as CSSProperties}
      className={`materials-v3-workspace ${selected?'has-preview':''} ${panelFull?'is-full':''}`}>
      <div className="materials-v3-list-area">
        <div className="materials-v3-summary"><strong>{query.data?.total ?? 0} 份关联资料</strong><span className="muted">点击文件名预览 · Windows 打开 = 使用主机默认应用打开原件 · 上层资料只读</span></div>
        {groups.map(group=>{
          const entries=group.entries;
          const defaultOpen = !group.inherited || (group.level===node.depth-1 && entries.length<=5);
          const open = stableSearch || collapsed[group.key]===undefined ? (stableSearch?true:defaultOpen) : !collapsed[group.key];
          return <section className="materials-v3-group" data-level={group.level} data-origin={group.inherited?'inherited':'direct'} key={group.key}>
            <div className="materials-v3-group-head">
              <button type="button" aria-expanded={Boolean(open)} onClick={()=>setCollapsed(p=>({...p,[group.key]:open}))}>
                <Icon name={open?'chevron-down':'chevron-right'} size={15}/>
                <span className="material-level-mark">L{group.level}</span>
                <strong>{group.inherited?'继承自 '+group.title:'当前层级 · 直接关联'}</strong>
                <span className="muted">({entries.length})</span>
              </button>
              {group.sourceId?<AppLink to={nodePath(group.sourceId,'materials')}>打开来源</AppLink>:null}
            </div>
            {open ? <ul className="materials-v3-rows">{entries.map(entry=>{
              const key=entryKey(entry); const active=selected?.entry.key===key;
              const hasChange = Boolean(entry.fileId && entry.fileRevision!==undefined && seen[entry.fileId]!==undefined && entry.fileRevision>(seen[entry.fileId] ?? 0));
              const download=entry.fileId?fileUrl(entry.fileId,'download'):null;
              return <li key={key} className={active?'is-selected':''} data-card-style="type-accent"
                data-format={materialFormatOf(entry.fileName, entry.material?.materialType, entry.material?.format)}
                data-scope={group.inherited?'inherited':'direct'} data-file-id={entry.fileId??undefined}>
                <div className="materials-v3-row">
                  {batch && !group.inherited ? <input type="checkbox" aria-label={`选择 ${entry.title}`} checked={checked.has(key)} onChange={()=>toggleChecked(key)}/>:null}
                  <MaterialFormatIcon name={entry.fileName} materialType={entry.material?.materialType} format={entry.material?.format}/>
                  <div className="materials-v3-file-info">
                    <button className="material-compact-name" type="button" title={entry.title} onClick={()=>choose(entry)}>{entry.title}</button>
                    <div className="materials-v3-file-meta">
                      {formatMaterialCreatedAt(entry.createdAt)?<time>添加 {formatMaterialCreatedAt(entry.createdAt)}</time>:null}
                      {typeof entry.size==='number'?<span>{formatSize(entry.size)}</span>:null}
                      {entry.version?<span>{entry.version}</span>:null}
                      {entry.fileRevision?<span className="materials-v3-revision">R{entry.fileRevision}</span>:null}
                      {hasChange?<span className="materials-v3-new">New revision</span>:null}
                      {entry.missing?<span className="materials-v3-new">File missing</span>:null}
                    </div>
                    {(entry.purpose || entry.tags?.length || group.inherited) ? <div className="materials-v3-card-tags">
                      {entry.purpose?<span className="materials-v3-purpose-tag">{PURPOSE.find(([value])=>value===entry.purpose)?.[1]??entry.purpose}</span>:null}
                      {entry.tags?.slice(0,2).map(tag=><span className="materials-v3-topic-tag" key={tag} title={tag}>{tag}</span>)}
                      {(entry.tags?.length??0)>2?<span className="materials-v3-topic-tag" title={(entry.tags??[]).slice(2).join(', ')}>+{(entry.tags?.length??0)-2}</span>:null}
                      {group.inherited?<span className="materials-v3-inherited-tag">L{group.level} · inherited</span>:null}
                    </div>:null}
                  </div>
                  <div className="materials-v3-row-actions" role="group" aria-label={`File actions: ${entry.title}`}>
                    {entry.fileId&&!entry.missing?<><OpenNativeFile fileId={entry.fileId} name={entry.title}/><OpenStorageLocation fileId={entry.fileId} name={entry.title}/></>:null}
                    {entry.fileId?<button className="material-icon-btn" title="版本历史" type="button" onClick={()=>choose(entry,'history')}><Icon name="history" size={17}/></button>:null}
                    {!group.inherited ? <button className="material-icon-btn materials-v3-unlink" type="button"
                      title="解除当前层级关联（保留原件）" aria-label={`解除关联: ${entry.title}`}
                      disabled={busy||legacyBackend} onClick={()=>{setChecked(new Set([key]));setConfirmRemove(true);}}>
                      <Icon name="trash" size={16}/></button> :
                    group.level===1 && entry.sourceId ? <button className="material-icon-btn materials-v3-unlink" type="button"
                      title="解除来源 L1 关联（所有下级继承将移除，保留原件）"
                      aria-label={`解除来源 L1 关联: ${entry.title}`}
                      disabled={busy||legacyBackend} onClick={()=>setConfirmSource({entry,inherited:true})}>
                      <Icon name="trash" size={16}/></button> : null}
                    <details className="materials-v3-more">
                      <summary className="material-icon-btn" title="更多操作" aria-label={`More actions: ${entry.title}`}><Icon name="more" size={17}/></summary>
                      <div className="materials-v3-menu">
                        <button type="button" onClick={()=>choose(entry,'preview')}>预览</button>
                        <button type="button" onClick={()=>choose(entry,'details')}>详细信息</button>
                        {entry.fileId?<button type="button" onClick={()=>choose(entry,'preview',true)}>最大化预览</button>:null}
                        {entry.fileId?<a href={nodePath(node.id,'materials')+'?preview='+encodeURIComponent(entry.material?.id??entry.fileId)} target="_blank" rel="noopener noreferrer">新标签页</a>:null}
                        {download&&!entry.missing?<a href={download} download={entry.fileName}>下载原件</a>:null}
                        {!group.inherited?<button type="button" disabled={busy||legacyBackend} onClick={()=>{setChecked(new Set([key]));setConfirmRemove(true);}}>解除当前关联（保留原件）</button>:null}
                        {group.inherited && group.level===1 && entry.sourceId?<button type="button"
                          disabled={busy||legacyBackend} onClick={()=>setConfirmSource({entry,inherited:true})}>
                          解除来源 L1 关联（保留原件）</button>:null}
                        {group.inherited && entry.sourceId?<AppLink to={nodePath(entry.sourceId,'materials')}>前往来源管理</AppLink>:null}
                      </div>
                    </details>
                  </div>
                </div>
              </li>;
            })}</ul>:null}
          </section>;
        })}
        {query.data?.total===0?<p className="muted">没有匹配的 Materials。</p>:null}
        {hasMore?<button className="btn materials-v3-load" disabled={loadingMore} onClick={()=>void loadMore()}>{loadingMore?'正在加载…':'加载更多文件'}</button>:null}
      </div>
      {selected && !panelFull ? <div className="materials-v3-resizer" role="separator" tabIndex={0}
        aria-label="调整文件列表和预览宽度" aria-orientation="vertical"
        aria-valuemin={Math.round(bounds().min)} aria-valuemax={Math.round(bounds().max)}
        aria-valuenow={Math.round(listWidth)} onPointerDown={beginResize} onPointerMove={resize}
        onPointerUp={endResize} onPointerCancel={endResize}
        onKeyDown={event => {
          if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
          event.preventDefault();
          const {min,max} = bounds();
          const width = event.key === 'Home' ? min : event.key === 'End' ? max :
            listWidthRef.current + (event.key === 'ArrowRight' ? 3 : -3);
          updateWidth(width);
          localStorage.setItem('kbw:materials:v3:list-width', String(listWidthRef.current));
        }} /> : null}
      {selected?<aside className="materials-v3-panel" aria-label={`Material preview and details: ${selected.entry.title}`}>
        <div className="materials-v3-panel-head">
          <strong title={selected.entry.title}>{selected.entry.title}</strong>
          <button type="button" className="btn" onClick={()=>setPanelFull(v=>!v)}>{panelFull?'收起':'最大化'}</button>
          <button className="btn" type="button" aria-label="Close Preview" onClick={()=>{setSelectedKey(null);setPanelFull(false);
            if (requestedPreview) navigate(nodePath(node.id,'materials'),{replace:true});}}>关闭</button>
        </div>
        <div className="materials-v3-panel-tabs" role="tablist" aria-label="Material details tabs">
          {([['preview','Preview'],['details','Details'],['history','History'],['links','Linked Items']] as [PanelTab,string][]).map(([key,title])=>
            <button type="button" role="tab" aria-selected={panelTab===key} className={panelTab===key?'is-active':''} key={key}
              onClick={()=>setPanelTab(key)}>{title}</button>)}
        </div>
        <div className="materials-v3-panel-body">
          {panelTab==='preview' && selected.entry.target ? <PreviewContent key={selected.entry.key} target={selected.entry.target} inlineControls={false}/>:null}
          {panelTab==='details'?<div className="materials-v3-details">
            <p className="muted">文件原件始终只读。Purpose/Description 属于本层级关联，Tags 属于整个文件。</p>
            <dl>
              <div><dt>所属层级</dt><dd>L{selected.entry.sourceLevel ?? node.depth} · {selected.inherited?'Inherited':'Direct'}</dd></div>
              <div><dt>来源</dt><dd>{selected.entry.sourceTitle ?? node.title}</dd></div>
              <div><dt>添加时间</dt><dd>{formatMaterialCreatedAt(selected.entry.createdAt)??'未知'}</dd></div>
              <div><dt>文件版本</dt><dd>{selected.entry.fileRevision??'—'}</dd></div>
              <div><dt>File ID</dt><dd className="materials-v3-fileid">{selected.entry.fileId??'外部链接'}</dd></div>
            </dl>
            <label>Purpose
              <select value={purposeDraft} disabled={selected.inherited} onChange={e=>setPurposeDraft(e.target.value)}>
                {PURPOSE.map(([key,title])=><option key={key} value={key}>{title}</option>)}
              </select>
            </label>
            <label>Description
              <textarea value={descriptionDraft} rows={4} maxLength={4000} disabled={selected.inherited} onChange={e=>setDescriptionDraft(e.target.value)}/>
            </label>
            {selected.entry.fileId?<label>Tags（全局，逗号分隔）
              <input value={tagsDraft} list="materials-v3-tag-suggestions" disabled={selected.inherited} placeholder="Architecture, REVIEW, Verification" onChange={e=>setTagsDraft(e.target.value)}/>
              <datalist id="materials-v3-tag-suggestions">{[...new Set([...globalTagChoices,...tagChoices,"Architecture","Verification","REVIEW","Meeting","Decision","Deliverable"])].map(t=><option value={t} key={t}/>)}</datalist>
            </label>:null}
            {selected.inherited?<p className="muted">继承资料只能在原始所属节点编辑关联元数据。</p>:<button className="btn btn-primary" type="button" disabled={busy||legacyBackend} onClick={()=>void saveMeta()}>保存元数据</button>}
          </div>:null}
          {panelTab==='history' && selected.entry.fileId?<FileVersionTools key={selected.entry.fileId} fileId={selected.entry.fileId} openInitially
              pinnedRevision={selected.entry.target?.kind==='file'?selected.entry.target.revision:null}/>:null}
          {panelTab==='history' && !selected.entry.fileId?<p className="muted">外部链接没有 File Hub 版本历史。</p>:null}
          {panelTab==='links'?<div className="materials-v3-links">
            {!selected.entry.fileId?<p className="muted">外部链接仅关联当前工作项。</p>:null}
            {selected.entry.fileId && (linksQuery.data?.[selected.entry.fileId]??[]).map(item=>
              <p key={item.nodeId}><AppLink to={nodePath(item.nodeId,'materials')}>{item.title}</AppLink></p>)}
            {selected.entry.fileId && linksQuery.data && !linksQuery.data[selected.entry.fileId]?.length?<p className="muted">暂无其他关联工作项。</p>:null}
          </div>:null}
        </div>
      </aside>:null}
    </div>
    {linkOpen?<ModalDialog label="添加 Materials 链接" onClose={()=>setLinkOpen(false)}>
      <form className="form" onSubmit={e=>void addLink(e)}>
        <h2>添加外部链接</h2>
        <label>名称 <input value={linkTitle} onChange={e=>setLinkTitle(e.target.value)}/></label>
        <label>HTTP/HTTPS URL <input type="url" required value={linkUrl} onChange={e=>setLinkUrl(e.target.value)}/></label>
        <div className="form-actions"><button className="btn" type="button" onClick={()=>setLinkOpen(false)}>取消</button>
          <button className="btn btn-primary" type="submit" disabled={busy}>添加</button></div>
      </form>
    </ModalDialog>:null}
    {pickOpen?<ModalDialog label="关联已有 File Hub 文件" onClose={()=>setPickOpen(false)}>
      <div className="materials-v3-picker">
        <h2>从 File Hub 选择已有文件</h2>
        <p className="muted">复用 File ID，不复制原件；允许跨 L1 关联。</p>
        <input type="search" aria-label="Search File Hub" placeholder="按名称或路径搜索…" value={fileSearch} onChange={e=>setFileSearch(e.target.value)}/>
        <div className="materials-v3-picker-list">
          {!hubFiles.data?<p className="muted">正在读取文件索引…</p>:null}
          {(hubFiles.data??[]).filter(file=>(file.name+' '+file.path).toLowerCase().includes(fileSearch.toLowerCase())).slice(0,250).map(file=>
            <label key={file.id}><input type="checkbox" checked={fileChecked.has(file.id)}
              onChange={()=>setFileChecked(prev=>{const next=new Set(prev);if(next.has(file.id))next.delete(file.id);else next.add(file.id);return next;})}/>
              <span><strong>{file.displayName??file.name}</strong><small>{file.path}</small></span>
            </label>)}
        </div>
        <p>{fileChecked.size} selected</p>
        <div className="form-actions"><button className="btn" type="button" onClick={()=>setPickOpen(false)}>取消</button>
          <button className="btn btn-primary" type="button" disabled={busy||!fileChecked.size} onClick={()=>void addExisting()}>关联选中文件</button></div>
      </div>
    </ModalDialog>:null}
    {tagManagerOpen?<ModalDialog label="全局 Tags 管理" onClose={()=>setTagManagerOpen(false)}>
      <div className="materials-v3-picker">
        <h2>统一重命名 Tags</h2>
        <p className="muted">这是全 File Hub 范围的元数据操作，不修改文件内容。已有目标标签不会自动合并。</p>
        <label>原有 Tag <select value={oldTag} onChange={e=>setOldTag(e.target.value)}>
          <option value="">选择标签</option>
          {globalTagChoices.map(t=><option value={t} key={t}>{t}</option>)}
        </select></label>
        <label>新 Tag 名称 <input value={newTag} maxLength={40} onChange={e=>setNewTag(e.target.value)}/></label>
        <div className="form-actions">
          <button className="btn" type="button" onClick={()=>setTagManagerOpen(false)}>取消</button>
          <button className="btn btn-primary" type="button" disabled={!oldTag||!newTag.trim()||busy} onClick={()=>void renameTag()}>确认全局重命名</button>
        </div>
      </div>
    </ModalDialog>:null}
    {confirmSource?<ModalDialog label="确认解除 L1 来源文件关联" onClose={()=>setConfirmSource(null)}>
      <div className="materials-v3-confirm" data-confirm-source-l1="true">
        <h2>确认解除来源 L1 的关联？</h2>
        <p><strong>{confirmSource.entry.title}</strong> · 来源：{confirmSource.entry.sourceTitle}</p>
        <p>这会从来源 L1 解除关联，所有下级 Workstream / Task 的继承列表也将不再显示此关联。
          原始文件、File ID 和历史版本全部保留。此操作不能只影响当前子页面。</p>
        <div className="form-actions">
          <button className="btn" type="button" onClick={()=>setConfirmSource(null)}>取消</button>
          <button className="btn btn-danger" type="button" disabled={busy||legacyBackend}
            onClick={()=>void removeFromSourceL1()}>确认解除 L1 关联</button>
        </div>
      </div>
    </ModalDialog>:null}
    {confirmRemove?<ModalDialog label="确认解除 Materials 关联" onClose={()=>setConfirmRemove(false)}>
      <div className="materials-v3-confirm">
        <h2>确定解除 {selectedFiles.length} 个当前层级关联？</h2>
        <p>只解除当前层级的关联，不删除 File Hub 中的原件，也不会删除历史 Revision。若该文件仍由上层关联，它仍会作为继承资料显示。该操作将记录 Work Revision。</p>
        <div className="form-actions"><button className="btn" type="button" onClick={()=>setConfirmRemove(false)}>取消</button>
          <button className="btn btn-danger" type="button" disabled={!selectedFiles.length||busy} onClick={()=>void removeDirect()}>确认解除关联</button></div>
      </div>
    </ModalDialog>:null}
  </div>;
}
