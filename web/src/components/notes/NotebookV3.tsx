import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { useQuery, invalidate, setData } from '../../lib/queryCache';
import { navigate, nodePath, useAppPath } from '../../lib/router';
import { notifyDraftChange, registerEditor, hasUnsavedDraft } from '../../lib/draftGuard';
import { NotebookEventEditor } from './NotebookEventEditor';
import { cleanNoteHtml } from '../../lib/noteHtml';
import { permanentlyDeleteNotebookItem, type NotebookDeleteKind } from '../../lib/notebookPurge';
import type { NodeDTO, TreeView } from '../../lib/types';
import { Icon } from '../icons';
import { NoteEditor, type Draft } from './NoteEditor';
import type { JSONContent } from '@tiptap/react';
const StructuredPageEditor=lazy(()=>import('./StructuredPageEditor').then(m=>({default:m.StructuredPageEditor})));
import { UnconfirmedControls } from '../agent/UnconfirmedMark';

interface Section { id:string;owner_id:string;title:string;role:string|null;position:number;pageCount:number;updated_at:string; }
interface PageMeta {id:string;owner_id:string;section_id:string;title:string;position:number;revision:number;updated_at:string;legacy_id:string|null;timelineDate?:string|null;}
interface Page extends PageMeta {html:string;unconfirmedWriteIds:string[];links:string[];legacyHistory?:boolean;
  documentJson?:JSONContent;documentFormat?:'json';documentSourceRevision?:number;
  pageArchived?:boolean;sectionArchived?:boolean;sectionUpdatedAt?:string|null;}
export interface EventEntry {id:string;owner_id:string;title:string;kind:string;event_date:string;event_time:string|null;
  timezone:string|null;instant_utc:string|null;summary_html:string;revision:number;pageIds:string[];taskIds:string[];
  sourcePath:{id:string;title:string}[];
  linkedPages?:{id:string;title:string;owner_id:string;section_id:string;revision:number}[];
  archivedAt?:string|null;
  linkedTasks?:{id:string;title:string;status:string}[];}
interface SectionsResponse {sections:Section[];linkedPages:(PageMeta&{target_node_id:string})[];}
interface PagesResponse {items:PageMeta[];total:number;limit:number;offset:number;}
interface TimelineEntry {
  key:string;type:'paired'|'page'|'event';pageId:string|null;eventId:string|null;
  pageOwnerId:string|null;eventOwnerId:string|null;pageSectionId?:string;
  pageRevision:number|null;eventRevision:number|null;date:string|null;eventTime:string|null;
  title:string;kind:string;sourcePath:{id:string;title:string;level?:number}[];
  linkedPageIds:string[];linkedTaskIds:string[];
}
interface TimelineResponse {items:TimelineEntry[];total:number;rootId:string;limit:number;offset:number;}
interface NotebookStatus {ready:boolean;version:number;}
interface PageResponse {page:Page;}

const dateToday=()=>{const now=new Date();return new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,10);};
const pageUrl=(node:string,section?:string|null,page?:string|null)=>
  nodePath(node,'notes')+(page?'?'+new URLSearchParams({...(section?{section}:{}),page}).toString():
    section?'?section='+encodeURIComponent(section):'');
function ask(label:string,initial=''):string|null {
  const text=window.prompt(label,initial);
  return text?.trim()||null;
}
/** Stable Section tint based on immutable Section ID, not its name or reorder position. */
export function sectionTone(id:string):number {
  let hash=0;
  for(const char of id)hash=(hash*33+char.charCodeAt(0))>>>0;
  return hash%6;
}
function safePreviewHtml(html:string):string {
  const result=cleanNoteHtml(html);
  return result.ok?result.html:'';
}
function isSameProject(tree:TreeView|undefined,a:string,b:string){
  if(!tree)return false;
  const index=new Map(tree.nodes.map(node=>[node.id,node]));
  const root=(id:string)=>{let cursor=index.get(id);const seen=new Set<string>();
    while(cursor?.parentId&&!seen.has(cursor.id)){seen.add(cursor.id);cursor=index.get(cursor.parentId);}
    return cursor?.id;};
  const one=root(a),two=root(b);
  return Boolean(one&&two&&one===two);
}

function NotebookPageEditor({node,page,onSaved,onDeleted,toolbarTarget,historyRequest,v35Ready}:{node:NodeDTO;page:Page;onSaved:()=>void;onDeleted:()=>void;toolbarTarget:HTMLElement|null;historyRequest:{pageId:string;seq:number}|null;v35Ready:boolean}) {
  const [draft,setDraft]=useState<Draft>(()=>({id:page.id,title:page.title,html:page.html,expanded:true,sync:1}));
  const [structured,setStructured]=useState(()=>v35Ready && (Boolean(page.documentJson)||!page.html.trim()));
  const jsonDraft=useRef<JSONContent|null>(page.documentJson??null);
  const [dirty,setDirty]=useState(false);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [conflict,setConflict]=useState(false);
  const [historyOpen,setHistoryOpen]=useState(false);
  useEffect(()=>{if(historyRequest?.pageId===page.id)setHistoryOpen(true);},[historyRequest,page.id]);
  const [historyRevision,setHistoryRevision]=useState<number|null>(null);
  const history=useQuery<{items:{revision:number;title:string;source:string;actor:string;occurred_at:string}[]}>('notebook-page-history:'+page.id,
    signal=>get('notebook-page-history',{page:page.id},{signal}),{enabled:historyOpen});
  const oldVersion=useQuery<{revision:number;title:string;html:string;occurred_at:string}>('notebook-page-revision:'+page.id+':'+historyRevision,
    signal=>get('notebook-page-revision',{page:page.id,revision:historyRevision},{signal}),
    {enabled:historyOpen&&historyRevision!==null});
  const revisionRef=useRef(page.revision);
  const draftRef=useRef(draft);draftRef.current=draft;
  const dirtyRef=useRef(dirty);dirtyRef.current=dirty;
  const version=useRef(0);
  const request=useRef<Promise<boolean>|null>(null);
  const saveRef=useRef<()=>Promise<boolean>>(async()=>true);
  useEffect(()=>registerEditor('notebook-page:'+page.id,{
    dirty:()=>dirtyRef.current||Boolean(request.current),
    save:()=>saveRef.current(),
    discard:()=>{dirtyRef.current=false;setDirty(false);}
  }),[page.id]);
  useEffect(()=>notifyDraftChange(),[dirty,saving]);
  useEffect(()=>{
    if(v35Ready && !dirtyRef.current && (page.documentJson||!page.html.trim()))setStructured(true);
  },[v35Ready,page.documentJson,page.html]);
  useEffect(()=>{
    if(!dirtyRef.current && !request.current && page.revision!==revisionRef.current){
      revisionRef.current=page.revision;
      setDraft(d=>({...d,id:page.id,title:page.title,html:page.html,sync:d.sync+1}));
      if(page.documentJson)jsonDraft.current=page.documentJson;
      setError('');setConflict(false);
    }
  },[page]);
  const change=(kind:'title'|'html',value:string)=>{
    version.current++;
    dirtyRef.current=true;setDirty(true);setError('');setConflict(false);
    setDraft(before=>({...before,[kind]:value}));
  };
  const changeJson=(value:JSONContent)=>{
    jsonDraft.current=value;version.current++;
    dirtyRef.current=true;setDirty(true);setError('');setConflict(false);
  };
  const persist=useCallback(async():Promise<boolean>=>{
    if(request.current)return request.current;
    if(!dirtyRef.current)return true;
    const work=(async()=>{
      const changedAt=version.current;
      const copy=draftRef.current;
      if(!copy.title.trim()){setError('Page title cannot be empty.');return false;}
      const clean=structured?null:cleanNoteHtml(copy.html);
      if(!structured&&!clean?.ok){setError('Page content is not valid safe HTML.');return false;}
      if(structured&&!jsonDraft.current){setError('Structured editor is not ready.');return false;}
      setSaving(true);setError('');
      try {
        const res=await post<PageResponse>(structured?'notebook-v35-document-save':'notebook-page-save',{
          pageId:page.id,baseRevision:revisionRef.current,
          title:copy.title.trim(),...(structured?{json:jsonDraft.current}:{html:clean&&clean.ok?clean.html:''}),
        },{timeoutMs:20000});
        revisionRef.current=res.page.revision;
        setData<Page>('notebook-page:'+node.id+':'+page.id,res.page);
        invalidate('notebook-pages:'+node.id);
        if(changedAt===version.current){dirtyRef.current=false;setDirty(false);}
        else window.setTimeout(()=>{void saveRef.current();},450);
        onSaved();
        return changedAt===version.current;
      }catch(err){
        const reason=describeError(err);
        setConflict(err instanceof Error && ('status' in err) && (err as {status:number}).status===409);
        setError('Not saved: '+reason+'. Your draft remains in this editor.');
        return false;
      }finally{setSaving(false);}
    })();
    request.current=work;
    try{return await work;}finally{request.current=null;notifyDraftChange();}
  },[node.id,page.id,onSaved,structured]);
  saveRef.current=persist;
  useEffect(()=>{
    if(!dirty||conflict)return;
    const timer=window.setTimeout(()=>{void persist();},1500);
    return ()=>window.clearTimeout(timer);
  },[draft,dirty,conflict,persist]);
  const remove=async()=>{
    if(!window.confirm('Archive this Page? It can be restored later.'))return;
    if(dirtyRef.current&&!await persist())return;
    try{
      await post('notebook-page-archive',{pageId:page.id,baseRevision:revisionRef.current});
      invalidate('notebook-pages:'+node.id);invalidate('notebook-sections:'+node.id);
      onDeleted();
    }catch(err){setError('Could not archive Page: '+describeError(err));}
  };
  return <div className="notebook-editor notebook-canvas-editor" data-page-id={page.id} data-dirty={dirty?'true':'false'}>
    <div className="notebook-canvas-status" role="status" aria-live="polite">
      <span className={error?'notebook-error':'notebook-save-status'} title={'Revision '+revisionRef.current}>
        {error || (saving?'Saving…':dirty?'Unsaved changes':'Saved')}</span>
      {page.unconfirmedWriteIds?.length ? <UnconfirmedControls writeId={page.unconfirmedWriteIds[0]!}
        subject={page.title} onDone={()=>{invalidate('notebook-page:'+node.id+':'+page.id);onSaved();}}/> : null}
    </div>
    {conflict?<div className="notebook-conflict" role="alert">This Page changed in another window. Copy your unsaved content before reloading. Never overwrite another Revision without reviewing it.
      <button type="button" className="btn" onClick={()=>{if(window.confirm('Discard your local edits and load the latest server version?')){dirtyRef.current=false;setDirty(false);setConflict(false);revisionRef.current=0;invalidate('notebook-page:'+node.id+':'+page.id);}}}>Reload latest</button>
    </div>:null}
    {historyOpen?<section className="notebook-page-history" aria-label="Page Revision History">
      <h3>Page Revisions {page.legacy_id?'· Older Node revisions remain in Activity':''}</h3>
      <div className="notebook-history-list">
        {(history.data?.items??[]).map(rev=><button type="button" key={rev.revision}
          aria-pressed={historyRevision===rev.revision} onClick={()=>setHistoryRevision(rev.revision)}>
          Rev {rev.revision} · {rev.occurred_at.slice(0,16).replace('T',' ')} · {rev.source}</button>)}
      </div>
      {historyRevision!==null?<div className="notebook-history-preview">
        <strong>Revision {historyRevision} · Read-only preview</strong>
        <p>{oldVersion.data?.title??'Loading revision…'}</p>
        {oldVersion.data?<div className="summary-html" dangerouslySetInnerHTML={{__html:oldVersion.data.html}}/>:null}
      </div>:null}
    </section>:null}
    {v35Ready&&!structured?<button className="kbw-v35-upgrade" type="button" onClick={()=>{
      setStructured(true);dirtyRef.current=true;setDirty(true);version.current++;
    }}>Use V3.5 Rich Editor · preserves original HTML and Revision</button>:null}
    {structured?<div className="kbw-v35-page-wrapper"><Suspense fallback={<p className="muted">Preparing rich editor…</p>}>
      <StructuredPageEditor pageId={page.id} nodeId={node.id} nodeKind={node.kind}
        targetBlockId={new URLSearchParams(window.location.search).get('block')}
        initialHtml={draft.html} initialJson={page.documentJson}
        toolbarTarget={toolbarTarget}
        onReady={json=>{jsonDraft.current=json;}}
        onChange={changeJson}/></Suspense>
    </div>:<NoteEditor nodeId={node.id} ordinal={1} draft={draft} toolbarTarget={toolbarTarget} canvasMode
      titleProblem={error&&!draft.title.trim()?'Title required':null}
      unconfirmedWriteId={page.unconfirmedWriteIds?.[0]??null}
      legacy={false} lastModifiedAt={page.updated_at}
      onTitle={(_,title)=>change('title',title)} onHtml={(_,html)=>change('html',html)}
      onToggle={()=>setDraft(d=>({...d,expanded:!d.expanded}))}
      onDelete={()=>void remove()}/>}
  </div>;
}

export function NotebookV3({node}:{node:NodeDTO}) {
  const path=useAppPath();
  const params=new URLSearchParams(path.split('?')[1]??'');
  const sectionId=params.get('section');
  const pageId=params.get('page');
  const legacyNote=params.get('note');
  const eventId=params.get('event');
  const mode=params.get('view')==='timeline'||params.get('mode')==='timeline'?'timeline':'pages';
  const [search,setSearch]=useState('');
  const [pageOffset,setPageOffset]=useState(0);
  const [showArchived,setShowArchived]=useState(false);
  const [showArchivedEvents,setShowArchivedEvents]=useState(false);
  const [searchOpen,setSearchOpen]=useState(false);
  const [toolbarHost,setToolbarHost]=useState<HTMLDivElement|null>(null);
  const [source,setSource]=useState('');
  const [kind,setKind]=useState('');
  const [dateFrom,setDateFrom]=useState('');
  const [dateTo,setDateTo]=useState('');
  const [eventOffset,setEventOffset]=useState(0);
  const [selectedEvent,setSelectedEvent]=useState<EventEntry|null>(null);
  const [error,setError]=useState('');
  const [sidebarOpen,setSidebarOpen]=useState(false);
  const [menuPageId,setMenuPageId]=useState<string|null>(null);
  const [historyRequest,setHistoryRequest]=useState<{pageId:string;seq:number}|null>(null);
  const [pageMenuOpen,setPageMenuOpen]=useState(false);
  const [sectionActionsOpen,setSectionActionsOpen]=useState(false);
  const [archivedSectionsOpen,setArchivedSectionsOpen]=useState(false);
  const [linkedOpen,setLinkedOpen]=useState(params.get('view')==='linked');
  const [focusedTimelinePage,setFocusedTimelinePage]=useState<TimelineEntry|null>(null);
  useEffect(()=>{
    // Legacy ?view=linked is a foldout inside the Pages drawer, including
    // on narrow mobile layouts where the Pages sidebar is normally hidden.
    if(new URLSearchParams(path.split('?')[1]??'').get('view')==='linked'){
      setLinkedOpen(true);
      setSidebarOpen(true);
    }
  },[path]);
  const status=useQuery<NotebookStatus>('notebook-status',signal=>get('notebook-status',{}, {signal}));
  const v35=useQuery<{ready:boolean}>('notebook-v35-status',signal=>get('notebook-v35-status',{}, {signal}));
  const sections=useQuery<SectionsResponse>('notebook-sections:'+node.id,
    signal=>get('notebook-sections',{id:node.id},{signal}));
  const tree=useQuery<TreeView>('tree',signal=>get('tree',{}, {signal}),{enabled:mode==='timeline'});
  const archivedSections=useQuery<SectionsResponse>('notebook-sections-archived:'+node.id,
    signal=>get('notebook-sections',{id:node.id,archived:'1'},{signal}),
    {enabled:archivedSectionsOpen&&status.data?.version===4});
  const journal=sections.data?.sections.find(section=>section.role==='journal');
  const currentSection=(mode==='timeline'&&journal)
    ?journal:(sections.data?.sections.find(section=>section.id===sectionId)??journal??sections.data?.sections[0]??null);
  const isJournal=currentSection?.role==='journal';
  const pages=useQuery<PagesResponse>(
    'notebook-pages:'+node.id+':'+(currentSection?.id??'none')+':'+pageOffset+':'+search+':'+showArchived,
    signal=>get('notebook-pages',{id:node.id,section:currentSection?.id,limit:40,offset:pageOffset,q:search,archived:showArchived?'1':undefined},{signal}),
    {enabled:mode==='pages'&&Boolean(currentSection)});
  const actualPageId=showArchived?null:(pageId??(!legacyNote?pages.data?.items[0]?.id:null)??null);
  const detail=useQuery<Page>('notebook-page:'+node.id+':'+(actualPageId??legacyNote??'none'),
    async signal=>{
      const data=await get<Page>('notebook-page',{id:node.id,page:actualPageId,note:!actualPageId?legacyNote:null},{signal});
      return data;
    },{enabled:mode==='pages'&&!showArchived&&Boolean(actualPageId||legacyNote)});
  const events=useQuery<TimelineResponse>(
    'notebook-timeline:'+node.id+':'+status.data?.version+':'+showArchivedEvents+':'+source+':'+kind+':'+dateFrom+':'+dateTo+':'+eventOffset,
    async signal=>{
      if(status.data?.version===4)return get<TimelineResponse>('notebook-timeline',
        {id:node.id,source,kind,from:dateFrom,to:dateTo,offset:eventOffset,limit:40,
          archived:showArchivedEvents?'1':undefined},{signal});
      const old=await get<{items:EventEntry[];total:number;rootId:string;limit:number;offset:number}>(
        'notebook-events',{id:node.id,source,kind,from:dateFrom,to:dateTo,offset:eventOffset,limit:40},{signal});
      return {...old,items:old.items.map(event=>({
        key:'event:'+event.id,type:'event' as const,pageId:null,eventId:event.id,
        pageOwnerId:null,eventOwnerId:event.owner_id,pageRevision:null,eventRevision:event.revision,
        date:event.event_date,eventTime:event.event_time,title:event.title,kind:event.kind,
        sourcePath:event.sourcePath,linkedPageIds:event.pageIds,linkedTaskIds:event.taskIds,
      }))};
    },{enabled:mode==='timeline'&&Boolean(status.data)});
  const eventDetail=useQuery<EventEntry>('notebook-event:'+node.id+':'+(eventId??'none'),
    signal=>get('notebook-event',{id:node.id,event:eventId},{signal}),
    {enabled:mode==='timeline'&&Boolean(eventId)});
  const currentPage=detail.data;
  const focusedPageDetail=useQuery<Page>(
    'notebook-timeline-page:'+node.id+':'+(focusedTimelinePage?.pageId??'none'),
    signal=>get('notebook-page',{id:focusedTimelinePage?.pageOwnerId,page:focusedTimelinePage?.pageId},{signal}),
    {enabled:mode==='timeline'&&Boolean(focusedTimelinePage?.pageId)});
  const menuPage=pages.data?.items.find(item=>item.id===menuPageId)??null;
  useEffect(()=>{
    if(mode==='pages' && currentPage && !hasUnsavedDraft() &&
       (legacyNote || (pageId&&sectionId!==currentPage.section_id))){
      navigate(pageUrl(node.id,currentPage.section_id,currentPage.id),{replace:true});
    }
  },[mode,currentPage,legacyNote,pageId,sectionId,node.id]);
  const switchMode=(next:'pages'|'timeline')=>{
    setError('');setSelectedEvent(null);setFocusedTimelinePage(null);
    navigate(nodePath(node.id,'notes')+(next==='pages'?
      (journal?'?section='+encodeURIComponent(journal.id):currentSection?'?section='+encodeURIComponent(currentSection.id):''):
      '?view=timeline'));
  };
  const selectSection=(section:string)=>{
    setMenuPageId(null);setPageMenuOpen(false);setSectionActionsOpen(false);
    setArchivedSectionsOpen(false);
    setPageOffset(0);setSearch('');setSearchOpen(false);setShowArchived(false);setSidebarOpen(true);
    setFocusedTimelinePage(null);
    navigate(pageUrl(node.id,section));
  };
  const selectPage=(id:string,section?:string)=>{
    setShowArchived(false);
    setMenuPageId(null);setPageMenuOpen(false);setSidebarOpen(false);navigate(pageUrl(node.id,section??currentSection?.id,id));
  };
  const updateList=()=>{invalidate('notebook-pages:'+node.id);invalidate('notebook-sections:'+node.id);};
  const execute=async(action:string,body:object)=>{
    setError('');
    try{const result=await post<Record<string,unknown>>(action,body);updateList();return result;}
    catch(err){setError('Operation failed: '+describeError(err));return null;}
  };
  const permanentlyDelete=async(kind:NotebookDeleteKind,ownerId:string,targetId:string,
    after:()=>void)=>{
    if(hasUnsavedDraft()){setError('Save or discard unsaved Notes edits before permanently deleting data.');return;}
    setError('');
    try{
      const deleted=await permanentlyDeleteNotebookItem(kind,ownerId,targetId);
      if(!deleted)return;
      after();
      invalidate('notebook-');
    }catch(err){setError('Permanent deletion failed: '+(
      err instanceof Error && !('status' in err)?err.message:describeError(err)));}
  };
  const permanentlyDeleteSection=(section:Section)=>permanentlyDelete(
    'section',section.owner_id,section.id,()=>{
      setSectionActionsOpen(false);
      setArchivedSectionsOpen(false);
      if(currentSection?.id===section.id)navigate(nodePath(node.id,'notes'));
    });
  const permanentlyDeletePage=(meta:PageMeta)=>permanentlyDelete(
    'page',meta.owner_id,meta.id,()=>{
      setMenuPageId(null);setPageMenuOpen(false);
      if(actualPageId===meta.id)navigate(pageUrl(node.id,meta.section_id));
      if(pageOffset>0&&pages.data?.items.length===1)setPageOffset(n=>Math.max(0,n-40));
    });
  const permanentlyDeleteEvent=(event:EventEntry)=>permanentlyDelete(
    'event',event.owner_id,event.id,()=>{
      setSelectedEvent(null);setFocusedTimelinePage(null);
      navigate(nodePath(node.id,'notes')+'?view=timeline');
      if(eventOffset>0&&events.data?.items.length===1)setEventOffset(n=>Math.max(0,n-40));
    });
  const createSection=async()=>{
    const title=ask('New Section name');if(!title)return;
    const response=await execute('notebook-section-create',{id:node.id,title});
    const result=response?.section as Section|undefined;
    if(result)selectSection(result.id);
  };
  const renameNamedSection=async(section:Section)=>{
    if(section.role==='journal')return;
    const title=ask('Rename Section',section.title);if(!title||title===section.title)return;
    await execute('notebook-section-rename',{id:node.id,sectionId:section.id,title});
  };
  const renameSection=async()=>{
    if(currentSection)await renameNamedSection(currentSection);
  };
  const moveSection=async(direction:number)=>{
    if(!currentSection||!sections.data)return;
    if(isJournal)return;
    const before=sections.data.sections.filter(x=>status.data?.version!==4||x.role!=='journal').map(x=>x.id);
    const index=before.indexOf(currentSection.id),neighbor=index+direction;
    if(neighbor<0||neighbor>=before.length)return;
    const reordered=[...before];[reordered[index],reordered[neighbor]]=[reordered[neighbor]!,reordered[index]!];
    await execute('notebook-section-reorder',{id:node.id,sectionId:currentSection.id,ids:reordered,expectedIds:before});
  };
  const removeSection=async()=>{
    if(!currentSection||isJournal||!window.confirm(
      'Archive this Section and hide its '+currentSection.pageCount+' active Pages? All content can be restored.'))return;
    const response=await execute(status.data?.version===4?'notebook-section-archive':'notebook-section-delete',
      {id:node.id,sectionId:currentSection.id,expectedUpdatedAt:currentSection.updated_at});
    if(response)navigate(nodePath(node.id,'notes'));
  };
  const restoreSection=async(id:string,expectedUpdatedAt:string)=>{
    const result=await execute('notebook-section-restore',
      {id:node.id,sectionId:id,expectedUpdatedAt});
    if(result){invalidate('notebook-sections-archived:'+node.id);selectSection(id);}
  };
  const reorderPage=async(pageId:string,direction:number)=>{
    if(!currentSection||!pages.data||pages.data.total>40||showArchived)return;
    const before=pages.data.items.map(p=>p.id);
    const idx=before.indexOf(pageId),next=idx+direction;
    if(idx<0||next<0||next>=before.length)return;
    const after=[...before];[after[idx],after[next]]=[after[next]!,after[idx]!];
    await execute('notebook-page-reorder',{id:node.id,sectionId:currentSection.id,ids:after,expectedIds:before});
  };
  const restorePage=async(page:PageMeta)=>{
    if(!window.confirm('Restore this archived Page?'))return;
    const response=await execute('notebook-page-restore',{pageId:page.id,baseRevision:page.revision});
    if(response){setShowArchived(false);selectPage(page.id,page.section_id);}
  };
  const createPage=async()=>{
    const title=ask('Page title','Untitled Page');if(!title)return;
    const response=await execute('notebook-page-create',
      {id:node.id,sectionId:currentSection?.id,title,
       ...(isJournal?{timelineDate:dateToday()}:{})});
    const page=response?.page as Page|undefined;
    if(page)selectPage(page.id,page.section_id);
  };
  const quick=async()=>{
    const title=ask('Quick Capture title','Quick Note · '+dateToday());if(!title)return;
    const response=await execute('notebook-quick-capture',{id:node.id,title,eventDate:dateToday()});
    const page=response?.page as Page|undefined;
    if(page){invalidate('notebook-events:');invalidate('notebook-timeline:');selectPage(page.id,page.section_id);}
  };
  const createEvent=async(page?:Page)=>{
    const title=ask('Timeline Event title',page?.title??'Project update');if(!title)return;
    const date=ask('Event Date (YYYY-MM-DD)',dateToday());if(!date)return;
    const select=ask('Event type: journal, meeting, decision, milestone or other','milestone');
    if(!select)return;
    const response=await execute('notebook-event-create',{id:node.id,title,eventDate:date,
      kind:select.toLowerCase(),pageIds:page?[page.id]:[]});
    const event=response?.event as EventEntry|undefined;
    if(event){invalidate('notebook-events:');invalidate('notebook-timeline:');if(!page){
      navigate(nodePath(node.id,'notes')+'?view=timeline&event='+encodeURIComponent(event.id));
    }setSelectedEvent(event);}
  };
  const linkPage=async(page:PageMeta)=>{
    if(hasUnsavedDraft()){setError('Save your current Page before changing its links.');return;}
    const treeView=tree.data??await get<TreeView>('tree');
    const targets=treeView.nodes.filter(n=>n.id!==page.owner_id&&isSameProject(treeView,node.id,n.id));
    const picked=ask('Link this Page to a Node ID (same L1 project):\n'+targets.map(n=>n.id+' · '+n.title).join('\n').slice(0,1500));
    if(!picked)return;
    await execute('notebook-page-link',{pageId:page.id,targetNodeId:picked});
    invalidate('notebook-page:'+node.id+':'+page.id);
    setPageMenuOpen(false);
  };
  const renamePage=async(meta:PageMeta)=>{
    if(hasUnsavedDraft()){setError('Save your current draft before renaming another Page.');return;}
    const title=ask('Rename Page',meta.title);if(!title||title===meta.title)return;
    try{
      const original=await get<Page>('notebook-page',{id:node.id,page:meta.id});
      if(original.revision!==meta.revision){setError('This Page changed elsewhere. Refresh before renaming.');return;}
      const result=await execute('notebook-page-save',{pageId:meta.id,baseRevision:original.revision,title,html:original.html});
      if(result){invalidate('notebook-page:'+node.id+':'+meta.id);setMenuPageId(null);}
    }catch(err){setError('Rename failed: '+describeError(err));}
  };
  const archivePage=async(meta:PageMeta)=>{
    if(hasUnsavedDraft()){setError('Save or discard current Page edits before archiving.');return;}
    if(!window.confirm('Archive this Page? It can be restored later.'))return;
    const response=await execute('notebook-page-archive',{pageId:meta.id,baseRevision:meta.revision});
    if(response){setMenuPageId(null);if(actualPageId===meta.id)navigate(pageUrl(node.id,meta.section_id));}
  };
  const showPageHistory=(meta:PageMeta)=>{
    if(meta.id!==actualPageId)selectPage(meta.id,meta.section_id);
    setHistoryRequest(n=>({pageId:meta.id,seq:(n?.seq??0)+1}));setMenuPageId(null);
  };
  const restoreEvent=async(event:EventEntry)=>{
    if(!window.confirm('Restore this archived Event with its original ID and history?'))return;
    try{
      await post('notebook-event-restore',{eventId:event.id,baseRevision:event.revision});
      invalidate('notebook-event:'+node.id+':'+event.id);invalidate('notebook-timeline:');
      invalidate('notebook-events:');setSelectedEvent(null);
    }catch(err){setError('Event Restore failed: '+describeError(err));}
  };
  const changeTimelineDate=async(item:TimelineEntry,day:string)=>{
    if(!item.pageId||!item.pageRevision||!day)return;
    if(hasUnsavedDraft()){setError('Save or discard current edits before changing Timeline Date.');return;}
    try{
      const result=await post<{page:Page;event?:EventEntry}>('notebook-page-timeline-date-set',{
        pageId:item.pageId,baseRevision:item.pageRevision,timelineDate:day,
        ...(item.type==='paired'?{linkedEventId:item.eventId,eventBaseRevision:item.eventRevision}:{})
      });
      invalidate('notebook-timeline:');invalidate('notebook-page:');
      setFocusedTimelinePage({...item,date:day,pageRevision:result.page.revision,
        eventRevision:result.event?.revision??item.eventRevision});
    }catch(err){setError('Timeline Date was not saved: '+describeError(err));}
  };
  const moveMenuPage=async(page:PageMeta,section:string)=>{
    if(section===page.section_id)return;
    if(hasUnsavedDraft()){setError('Save or discard current edits before moving a Page.');return;}
    const response=await execute('notebook-page-move',{pageId:page.id,sectionId:section,baseRevision:page.revision});
    if(response)selectPage(page.id,section);
  };
  return <section className="notebook-v3" data-notebook-node={node.id}>
    <h2 className="visually-hidden">{node.title} · Notes</h2>
    {error?<div role="alert" className="notebook-error">{error}</div>:null}
    <div className="notebook-section-heading">
      <nav className="notebook-section-tabs notebook-v34-tabs" aria-label="Notebook Sections">
      {(sections.data?.sections??[]).map(section=><button type="button" key={section.id}
        data-tone={section.role==='journal'?0:sectionTone(section.id)}
        aria-current={currentSection?.id===section.id?'page':undefined}
        className={currentSection?.id===section.id?'is-active':''}
        onClick={()=>selectSection(section.id)}
        onDoubleClick={()=>void renameNamedSection(section)}
        onContextMenu={event=>{event.preventDefault();selectSection(section.id);setSectionActionsOpen(true);}}
        title={section.role==='journal'?'Protected Journal / Timeline':'Double click to rename or right click for actions'}>
        {section.role==='journal'?'Journal / Timeline':section.title}</button>)}
      <button type="button" className="notebook-add-tab" onClick={()=>void createSection()}
        aria-label="Add Section" title="Add Section"><Icon name="plus" size={17}/></button>
    </nav>
    <div className="notebook-section-actions notebook-v34-section-actions">
      <button type="button" className="notebook-section-manage-trigger" aria-label="Section actions"
        aria-expanded={sectionActionsOpen} title="Manage current Section"
        onClick={()=>{setSectionActionsOpen(v=>!v);setArchivedSectionsOpen(false);}}>
        <Icon name="settings" size={17}/></button>
      {sectionActionsOpen?<div className="notebook-section-menu" role="group" aria-label="Section actions">
        {isJournal?<span className="notebook-v34-protected">Journal is fixed and protected</span>:<>
          <button type="button" onClick={()=>void renameSection()}>Rename Section</button>
          <button type="button" onClick={()=>void moveSection(-1)}>Move Left</button>
          <button type="button" onClick={()=>void moveSection(1)}>Move Right</button>
          <button type="button" onClick={()=>void removeSection()}>Archive Section &amp; Pages</button>
          <button type="button" className="kbw-notebook-delete-danger"
            onClick={()=>void permanentlyDeleteSection(currentSection!)}>Delete Section Permanently…</button>
        </>}
        {status.data?.version===4?<button type="button"
          onClick={()=>setArchivedSectionsOpen(v=>!v)}>Archived Sections</button>:null}
      </div>:null}
      {archivedSectionsOpen&&status.data?.version===4?<div className="notebook-v34-archived-sections">
        <strong>Archived Sections</strong>
        {(archivedSections.data?.sections??[]).map(s=><div key={s.id} className="kbw-notebook-archive-item">
          <button type="button" onClick={()=>void restoreSection(s.id,s.updated_at)}>
            Restore {s.title} ({s.pageCount} active Pages)</button>
          <button type="button" className="kbw-notebook-delete-danger"
            aria-label={'Delete archived Section permanently: '+s.title}
            onClick={()=>void permanentlyDeleteSection(s)}>Delete Permanently…</button>
        </div>)}
        {archivedSections.data?.sections.length===0?<span>No archived Sections</span>:null}
      </div>:null}
    </div>
    </div>
    <div className="notebook-v34-topline">
      <div className="notebook-v34-view-tabs" role="group" aria-label="Journal view">
        {isJournal||mode==='timeline'?<>
          <button type="button" aria-pressed={mode==='pages'} onClick={()=>switchMode('pages')}>Pages</button>
          <button type="button" aria-pressed={mode==='timeline'} onClick={()=>switchMode('timeline')}>Timeline</button>
        </>:null}
      </div>
      <div className="notebook-top-utilities">
        <button type="button" className="btn notebook-quick-capture"
          title="Capture a quick Page in Journal / Timeline" aria-label="Quick Capture"
          onClick={()=>void quick()}><Icon name="plus" size={15}/><span>Quick Capture</span></button>
        {isJournal||mode==='timeline'?<button type="button" className="btn notebook-new-event"
          title="Create a standalone Timeline Event or Milestone"
          aria-label="New Event" onClick={()=>void createEvent()}>
          <Icon name="history" size={15}/><span>New Event</span></button>:null}
      </div>
    </div>
    {mode==='pages'?<>
      <div className="notebook-two-pane notebook-onenote-canvas" data-tone={currentSection?sectionTone(currentSection.id):undefined}>
        <div className="notebook-page-stage">
          <div className="notebook-canvas-tools">
            <button type="button" className="btn notebook-pages-toggle" onClick={()=>setSidebarOpen(v=>!v)}>Pages <Icon name="chevron-down" size={14}/></button>
            <div className="notebook-shared-toolbar" aria-label="Notebook formatting controls"
              hidden={!currentPage||showArchived} ref={setToolbarHost}/>
          </div>
          {currentPage&&(currentPage.pageArchived||currentPage.sectionArchived)?
            <div className="notebook-v34-archived-notice" role="status">
              <strong>{currentPage.sectionArchived?'This Section is archived':'This Page is archived'}</strong>
              <p>Original content and Revision History are retained. Restore before editing.</p>
              <button className="btn btn-primary" type="button" onClick={()=>{
                if(currentPage.sectionArchived&&currentPage.sectionUpdatedAt){
                  void restoreSection(currentPage.section_id,currentPage.sectionUpdatedAt);
                }else if(currentPage.pageArchived){void restorePage(currentPage);}
              }}>Restore {currentPage.sectionArchived?'Section':'Page'}</button>
              <div className="summary-html notebook-v34-readonly"
                dangerouslySetInnerHTML={{__html:safePreviewHtml(currentPage.html)}}/>
            </div>:
          currentPage?<NotebookPageEditor key={currentPage.id} node={node} page={currentPage} toolbarTarget={toolbarHost}
            v35Ready={v35.data?.ready===true} historyRequest={historyRequest} onSaved={()=>updateList()}
            onDeleted={()=>navigate(pageUrl(node.id,currentSection?.id))}/>:
          <div className="notebook-page-empty">{sections.status==='error'||pages.status==='error'||detail.status==='error'?
            'Unable to load Notebook content. Refresh to retry.':
            sections.status==='loading'||pages.status==='loading'||detail.status==='loading'?'Loading Notebook…':
            <div className="notebook-empty-page-content">
              <p>{showArchived?'Use the Archived Pages list to find Pages to restore.':
                pages.data?.total===0&&!search.trim()?'This Section has no Pages yet.':
                'Select a Page to view its content.'}</p>
              {!showArchived&&pages.data?.total===0&&!search.trim()&&currentSection&&!node.archivedAt?
                <button type="button" className="btn btn-primary notebook-empty-add-page"
                  onClick={()=>void createPage()} aria-label="Add Page to empty Section">
                  <Icon name="edit" size={17}/> Add Page
                </button>:null}
            </div>}</div>}
        </div>
        <aside className={sidebarOpen?'notebook-page-sidebar is-open':'notebook-page-sidebar'} aria-label="Pages">
          <div className="notebook-page-sidebar-head">
            <div className="notebook-page-tools">
              <button type="button" className="btn notebook-add-page-primary"
                onClick={()=>void createPage()} aria-label="Add Page" title="Add a new Page">
                <Icon name="edit" size={15}/><span>Add Page</span></button>
              <button type="button" className={showArchived?'btn btn-icon notebook-archived-icon is-active':'btn btn-icon notebook-archived-icon'}
                aria-label={showArchived?'Show active Pages':'Show archived Pages'}
                title={showArchived?'Show active Pages':'Show archived Pages'}
                aria-pressed={showArchived}
                onClick={()=>{setShowArchived(v=>!v);setPageOffset(0);}}>
                <Icon name="archive" size={16}/></button>
              <button type="button" className="btn btn-icon" aria-label="Search Pages" title="Search Pages"
                aria-expanded={searchOpen} onClick={()=>{setSearchOpen(v=>!v);if(searchOpen){setSearch('');setPageOffset(0);}}}>
                <Icon name="search" size={16}/></button>
            </div>
            <strong className="notebook-page-sidebar-count">{showArchived?'Archived Pages':'Pages'} <span>{pages.data?.total??0}</span></strong>
          </div>
          {searchOpen?<label className="notebook-page-search"><Icon name="search" size={14}/>
            <input type="search" autoFocus value={search} onChange={e=>{setSearch(e.target.value);setPageOffset(0);}}
              placeholder="Find Pages…" aria-label="Find Pages"/></label>:null}
          <nav aria-label="Page list">
            {(pages.data?.items??[]).map(page=><div className="notebook-page-row" key={page.id}
              onContextMenu={event=>{event.preventDefault();setMenuPageId(page.id);setPageMenuOpen(true);}}>
              <button type="button" disabled={showArchived}
                aria-current={actualPageId===page.id?'page':undefined} onClick={()=>selectPage(page.id,page.section_id)}
                onDoubleClick={()=>void renamePage(page)} title="Double click to rename">
                <strong>{page.title}</strong><span>{page.timelineDate??page.updated_at.slice(0,10)}</span>
              </button>
              <button type="button" className="notebook-page-more" aria-label={'Page actions: '+page.title}
                aria-expanded={menuPageId===page.id&&pageMenuOpen}
                onClick={()=>{setMenuPageId(page.id);setPageMenuOpen(v=>menuPageId===page.id?!v:true);}}>⋯</button>
              {showArchived?<button type="button" className="notebook-page-restore"
                onClick={()=>void restorePage(page)}>Restore</button>:null}
            </div>)}
            {pages.data&&pages.data.total===0?<p className="muted">No Pages yet.</p>:null}
          </nav>
          {pageMenuOpen&&menuPage?<div className="notebook-page-context" role="menu" aria-label={'Page actions for '+menuPage.title}
            onKeyDown={event=>{if(event.key==='Escape'){setPageMenuOpen(false);setMenuPageId(null);}}}>
            <div className="notebook-page-context-title">{menuPage.title}</div>
            {!showArchived?<>
              <button type="button" role="menuitem" onClick={()=>void renamePage(menuPage)}>Rename Page</button>
              <button type="button" role="menuitem" onClick={()=>showPageHistory(menuPage)}>Revision History</button>
              <button type="button" role="menuitem" onClick={()=>{void createEvent(menuPage as Page);setPageMenuOpen(false);}}>Link to Timeline Event</button>
              <button type="button" role="menuitem" onClick={()=>void linkPage(menuPage)}>Link to Level</button>
              <label className="notebook-context-move">Move to Section
                <select aria-label="Move Page to Section" value={menuPage.section_id}
                  onChange={event=>{void moveMenuPage(menuPage,event.target.value);setPageMenuOpen(false);}}>
                  {(sections.data?.sections??[]).map(s=><option value={s.id} key={s.id}>{s.title}</option>)}
                </select>
              </label>
              <button type="button" role="menuitem" onClick={()=>void archivePage(menuPage)}>Archive Page</button>
            </>:<button type="button" role="menuitem" onClick={()=>void restorePage(menuPage)}>Restore Page</button>}
            <button type="button" role="menuitem" className="kbw-notebook-delete-danger"
              onClick={()=>void permanentlyDeletePage(menuPage)}>Delete Page Permanently…</button>
            <button type="button" role="menuitem" onClick={()=>{setPageMenuOpen(false);setMenuPageId(null);}}>Close Menu</button>
          </div>:null}
          <div className="notebook-v34-linked">
            <button type="button" className="notebook-v34-linked-toggle"
              aria-expanded={linkedOpen} onClick={()=>setLinkedOpen(v=>!v)}>
              <Icon name="paperclip" size={14}/> Linked Pages ({sections.data?.linkedPages?.length??0})
              <Icon name="chevron-down" size={13}/>
            </button>
            {linkedOpen?<div className="notebook-v34-linked-list">
              {(sections.data?.linkedPages??[]).map(ref=><button type="button" key={ref.id}
                onClick={()=>navigate(pageUrl(ref.owner_id,ref.section_id,ref.id))}>
                {ref.title}<small>Open original · {ref.owner_id}</small></button>)}
              {!sections.data?.linkedPages?.length?<span>No linked Pages</span>:null}
            </div>:null}
          </div>
          {!showArchived&&pages.data&&pages.data.total<=40&&pages.data.items.length>1&&actualPageId?<div className="notebook-page-order">
            <button type="button" onClick={()=>void reorderPage(actualPageId,-1)}>Move Page ↑</button>
            <button type="button" onClick={()=>void reorderPage(actualPageId,1)}>Move Page ↓</button>
          </div>:null}
          {pages.data&&pages.data.total>40?<div className="notebook-pagination">
            <button type="button" disabled={pageOffset===0} onClick={()=>setPageOffset(n=>Math.max(0,n-40))}>Previous</button>
            <span>{pageOffset+1}–{Math.min(pageOffset+40,pages.data.total)} / {pages.data.total}</span>
            <button type="button" disabled={pageOffset+40>=pages.data.total} onClick={()=>setPageOffset(n=>n+40)}>Next</button>
          </div>:null}
        </aside>
      </div>
    </>:null}
    {mode==='timeline'?<div className="notebook-timeline notebook-v34-timeline" data-root-id={events.data?.rootId}>
      <div className="notebook-timeline-filters">
        {status.data?.version===4?<label className="kbw-notebook-archive-toggle"><input type="checkbox"
          checked={showArchivedEvents} onChange={e=>{setShowArchivedEvents(e.target.checked);setEventOffset(0);}}/>
          Archived Events</label>:null}
        <label>Type <select value={kind} onChange={e=>{setKind(e.target.value);setEventOffset(0);}}>
          <option value="">All types</option>{['journal','meeting','decision','milestone','other'].map(x=><option key={x} value={x}>{x}</option>)}</select></label>
        <label>Source <select value={source} onChange={e=>{setSource(e.target.value);setEventOffset(0);}}>
          <option value="">Entire L1 project</option>
          {(tree.data?.nodes??[]).filter(x=>isSameProject(tree.data,node.id,x.id)).map(x=>
            <option value={x.id} key={x.id}>{x.title} · L{x.depth}</option>)}
        </select></label>
        <label>From <input type="date" value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setEventOffset(0);}}/></label>
        <label>To <input type="date" value={dateTo} onChange={e=>{setDateTo(e.target.value);setEventOffset(0);}}/></label>
      </div>
      <div className="notebook-v34-stream-layout">
        <div className="notebook-v34-stream-main">
          <div className="notebook-v34-stream-heading">
            {showArchivedEvents?'Archived Events':'Journal Timeline'}
            <span>{events.data?.total??0} entries · newest first</span></div>
          <ol className="notebook-event-list notebook-v34-stream">
            {(events.data?.items??[]).map((item,index)=>{
              const previous=events.data?.items[index-1];
              return <li key={item.key} data-event-id={item.eventId??undefined}
                data-page-id={item.pageId??undefined} className={(
                  (eventId&&item.eventId===eventId)||(focusedTimelinePage?.key===item.key))?'is-selected':''}>
                {(!previous||previous.date?.slice(0,7)!==item.date?.slice(0,7))?
                  <div className="notebook-v34-month">{item.date?.slice(0,7)??'Date missing'}</div>:null}
                <button type="button" onClick={()=>{
                  if(hasUnsavedDraft()){setError('Save or discard unsaved changes before switching Timeline entries.');return;}
                  setSelectedEvent(null);
                  if(item.pageId){
                    setFocusedTimelinePage(item);
                    navigate(nodePath(node.id,'notes')+'?view=timeline&page='+encodeURIComponent(item.pageId));
                  }else if(item.eventId){
                    setFocusedTimelinePage(null);
                    navigate(nodePath(node.id,'notes')+'?view=timeline&event='+encodeURIComponent(item.eventId));
                  }
                }}>
                  <time dateTime={item.date??undefined}>{item.date??'No date'}</time>
                  <div><strong>{item.title}</strong>
                    <span>{item.kind.toUpperCase()} · {item.sourcePath.map(x=>x.title).join(' / ')}</span></div>
                  <span>{item.linkedPageIds.length} Pages · {item.linkedTaskIds.length} Tasks
                    <Icon name="chevron-right" size={14}/></span>
                </button>
              </li>;
            })}
            {events.data&&events.data.total===0?<li className="notebook-event-empty">
              {showArchivedEvents?'No archived Events.':'No Journal Pages or Events yet. Use Quick Capture to record an update.'}</li>:null}
          </ol>
          {events.data&&events.data.total>40?<div className="notebook-pagination">
            <button type="button" disabled={eventOffset===0} onClick={()=>setEventOffset(n=>Math.max(0,n-40))}>Previous</button>
            <span>{eventOffset+1}–{Math.min(eventOffset+40,events.data.total)} / {events.data.total}</span>
            <button type="button" disabled={eventOffset+40>=events.data.total} onClick={()=>setEventOffset(n=>n+40)}>Next</button>
          </div>:null}
        </div>
        <aside className="notebook-v34-inspector" aria-label="Timeline detail">
          {eventId&&eventDetail.data?.archivedAt?
            <div className="notebook-v34-archived-notice" role="status">
              <strong>Archived Event / Milestone</strong>
              <p>{eventDetail.data.title} · {eventDetail.data.event_date}. Its ID, links and history are retained.</p>
              <button className="btn btn-primary" onClick={()=>void restoreEvent(eventDetail.data!)}>Restore Event</button>
              <button className="btn kbw-notebook-delete-danger"
                onClick={()=>void permanentlyDeleteEvent(eventDetail.data!)}>Delete Event Permanently…</button>
            </div>:
          eventId&&(eventDetail.data||selectedEvent)?<NotebookEventEditor key={eventId}
            event={eventDetail.data??selectedEvent!} tree={tree.data}
            onSaved={updated=>{setSelectedEvent(updated);invalidate('notebook-events:');
              invalidate('notebook-timeline:');invalidate('notebook-event:'+node.id+':'+eventId);}}
            onArchived={()=>{setSelectedEvent(null);setShowArchivedEvents(true);
              invalidate('notebook-events:');invalidate('notebook-timeline:');
              navigate(nodePath(node.id,'notes')+'?view=timeline');}}
            onDeleted={()=>{setSelectedEvent(null);navigate(nodePath(node.id,'notes')+'?view=timeline');
              invalidate('notebook-');}}
            onClose={()=>{setSelectedEvent(null);navigate(nodePath(node.id,'notes')+'?view=timeline');}}/>:
          focusedTimelinePage?.pageId?<div className="notebook-v34-page-detail">
            <div className="notebook-v34-inspector-header">Page Preview
              <button type="button" className="btn btn-icon" onClick={()=>setFocusedTimelinePage(null)}
                aria-label="Close Timeline Preview"><Icon name="close" size={15}/></button></div>
            <h3>{focusedTimelinePage.title}</h3>
            <label className="notebook-v34-date">Timeline Date
              <input type="date" aria-label="Timeline Date" value={focusedTimelinePage.date??''}
                onChange={e=>void changeTimelineDate(focusedTimelinePage,e.target.value)}/></label>
            <p className="muted">{focusedTimelinePage.kind.toUpperCase()} ·
              {focusedTimelinePage.sourcePath.map(x=>x.title).join(' / ')}</p>
            {focusedPageDetail.data?<div className="summary-html notebook-v34-readonly"
              dangerouslySetInnerHTML={{__html:safePreviewHtml(focusedPageDetail.data.html)}}/>:
              <div className="muted">Loading Page Preview…</div>}
            <button type="button" className="btn btn-primary" onClick={()=>
              navigate(pageUrl(focusedTimelinePage.pageOwnerId!,focusedTimelinePage.pageSectionId,
                focusedTimelinePage.pageId))}>Open &amp; Edit Page</button>
            <button type="button" className="btn kbw-notebook-delete-danger"
              onClick={()=>void permanentlyDelete('page',focusedTimelinePage.pageOwnerId!,
                focusedTimelinePage.pageId!,()=>{
                  setFocusedTimelinePage(null);
                  navigate(nodePath(node.id,'notes')+'?view=timeline');
                })}>Delete Page Permanently…</button>
            {focusedTimelinePage.eventId?<button type="button" className="btn" onClick={()=>{
              setFocusedTimelinePage(null);
              navigate(nodePath(node.id,'notes')+'?view=timeline&event='+focusedTimelinePage.eventId);
            }}>Event Details</button>:null}
          </div>:
          <div className="notebook-v34-inspector-empty">Select a Journal Page, Event or Milestone to view details.</div>}
        </aside>
      </div>
    </div>:null}
  </section>;
}
