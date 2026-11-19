import { useEffect, useRef, useState } from 'react';
import { post } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { permanentlyDeleteNotebookItem } from '../../lib/notebookPurge';
import { registerEditor, notifyDraftChange } from '../../lib/draftGuard';
import type { TreeView } from '../../lib/types';
import type { EventEntry } from './NotebookV3';

const TYPES=['journal','meeting','decision','milestone','other'];
export function NotebookEventEditor({
  event,tree,onSaved,onArchived,onDeleted,onClose
}:{
  event:EventEntry;tree:TreeView|undefined;
  onSaved:(event:EventEntry)=>void;onArchived:()=>void;onDeleted:()=>void;onClose:()=>void;
}){
  const [title,setTitle]=useState(event.title);
  const [kind,setKind]=useState(event.kind);
  const [day,setDay]=useState(event.event_date);
  const [time,setTime]=useState(event.event_time??'');
  const [tz,setTz]=useState(event.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone??'UTC');
  const [summary,setSummary]=useState(event.summary_html??'');
  const [taskIds,setTaskIds]=useState<string[]>(event.taskIds??[]);
  const [pageIds,setPageIds]=useState<string[]>(event.pageIds??[]);
  const [dirty,setDirty]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const dataRef=useRef({title,kind,day,time,tz,summary,taskIds,pageIds});
  dataRef.current={title,kind,day,time,tz,summary,taskIds,pageIds};
  const dirtyRef=useRef(dirty);dirtyRef.current=dirty;
  const revision=useRef(event.revision);
  const changed=()=>{dirtyRef.current=true;setDirty(true);setError('');};
  const saveRef=useRef<()=>Promise<boolean>>(async()=>true);
  const save=async()=>{
    if(!dirtyRef.current)return true;
    if(busy)return false;
    const data=dataRef.current;
    setBusy(true);setError('');
    try{
      const res=await post<{event:EventEntry}>('notebook-event-save',{
        eventId:event.id,baseRevision:revision.current,title:data.title,
        kind:data.kind,eventDate:data.day,eventTime:data.time||null,
        timezone:data.time?data.tz:null,html:data.summary,
        // Linked Journal Page/Event date sync uses both canonical CAS revisions.
        pageBaseRevision:event.linkedPages?.length===1?event.linkedPages[0]?.revision:undefined,
        taskIds:data.taskIds,pageIds:data.pageIds,
      });
      revision.current=res.event.revision;dirtyRef.current=false;setDirty(false);
      onSaved(res.event);
      return true;
    }catch(err){setError('Not saved: '+describeError(err));return false;}
    finally{setBusy(false);}
  };
  saveRef.current=save;
  useEffect(()=>registerEditor('notebook-event:'+event.id,{
    dirty:()=>dirtyRef.current,
    save:()=>saveRef.current(),
    discard:()=>{dirtyRef.current=false;setDirty(false);}
  }),[event.id]);
  useEffect(()=>notifyDraftChange(),[dirty]);
  const archive=async()=>{
    if(dirtyRef.current&& !await saveRef.current())return;
    if(!window.confirm('Archive this Event? Its linked Pages and Tasks will remain.'))return;
    try{await post('notebook-event-archive',{eventId:event.id,baseRevision:revision.current});onArchived();}
    catch(err){setError(describeError(err));}
  };
  const permanentDelete=async()=>{
    if(dirtyRef.current){setError('Save or discard Event edits before permanently deleting.');return;}
    setBusy(true);setError('');
    try{
      if(await permanentlyDeleteNotebookItem('event',event.owner_id,event.id))onDeleted();
    }catch(err){setError('Permanent deletion failed: '+describeError(err));}
    finally{setBusy(false);}
  };
  const root=event.sourcePath?.[0]?.id;
  const parents=new Map(tree?.nodes.map(n=>[n.id,n])??[]);
  const within=(id:string)=>{
    let current=parents.get(id);
    for(let i=0;i<8&&current?.parentId;i++)current=parents.get(current.parentId);
    return Boolean(root&&current?.id===root);
  };
  const tasks=(tree?.nodes??[]).filter(n=>(n.kind==='task'||n.kind==='action')&&within(n.id));
  return <section className="notebook-event-detail" aria-label="Event details" data-edit-event={event.id}>
    <div className="notebook-event-detail-head"><div><span className="notebook-overline">PROJECT EVENT · REVISION {revision.current}</span>
      <h3>Event Details</h3></div>
      <button type="button" className="btn" onClick={()=>{
        if(dirtyRef.current){setError('Save or discard Event changes before closing.');return;}
        onClose();
      }}>Close</button>
    </div>
    <div className="notebook-event-form">
      <label>Title <input value={title} maxLength={200} onChange={e=>{setTitle(e.target.value);changed();}}/></label>
      <label>Type <select value={kind} onChange={e=>{setKind(e.target.value);changed();}}>
        {TYPES.map(x=><option key={x} value={x}>{x}</option>)}
      </select></label>
      <label>Event Date <input type="date" required value={day} onChange={e=>{setDay(e.target.value);changed();}}/></label>
      <label>Time (optional) <input type="time" value={time} onChange={e=>{setTime(e.target.value);changed();}}/></label>
      {time?<label>Timezone <input value={tz} placeholder="IANA timezone, e.g. Europe/Stockholm"
        onChange={e=>{setTz(e.target.value);changed();}}/></label>:null}
      <div className="notebook-event-summary">
        <strong>Summary</strong>
        <div role="textbox" aria-label="Event Summary" aria-multiline="true" contentEditable
          suppressContentEditableWarning className="summary-html notebook-event-content"
          dangerouslySetInnerHTML={{__html:event.summary_html??''}}
          onInput={e=>{setSummary(e.currentTarget.innerHTML);changed();}}
          onPaste={e=>{e.preventDefault();
            const text=e.clipboardData.getData('text/plain');
            if(typeof document.execCommand==='function')document.execCommand('insertText',false,text);
          }}/>
      </div>
    </div>
    <div className="notebook-event-relations">
      <div><h4>Linked Pages ({pageIds.length})</h4>
        {(event.linkedPages??[]).map(page=><p key={page.id}>{page.title} · {page.owner_id}</p>)}
        <button type="button" className="btn" onClick={()=>{
          const text=window.prompt('Add a Page ID from the same L1 project');if(!text)return;
          const id=text.trim();
          if(!pageIds.includes(id)){setPageIds(list=>[...list,id]);changed();}
        }}>+ Link Page</button>
        <p className="muted">References never duplicate or delete original Pages.</p>
      </div>
      <div><h4>Related Tasks ({taskIds.length})</h4>
        <select multiple aria-label="Related Tasks" className="notebook-task-multiselect"
          value={taskIds} onChange={e=>{
            setTaskIds(Array.from(e.currentTarget.selectedOptions).map(o=>o.value));changed();
          }}>
          {tasks.map(task=><option key={task.id} value={task.id}>{task.title} · {task.status}</option>)}
        </select>
        <p className="muted">Task statuses are read-only; changing them never edits Event Date.</p>
      </div>
    </div>
    {error?<p role="alert" className="notebook-error">{error}</p>:null}
    <div className="notebook-event-buttons">
      <span role="status">{busy?'Saving…':dirty?'Unsaved Event changes':'Event saved'}</span>
      <button type="button" className="btn btn-primary" disabled={busy||!dirty} onClick={()=>void save()}>Save Event</button>
      <button type="button" className="btn" onClick={()=>void archive()} disabled={busy}>Archive Event</button>
      <button type="button" className="btn kbw-notebook-delete-danger"
        onClick={()=>void permanentDelete()} disabled={busy}>Delete Event Permanently…</button>
    </div>
  </section>;
}
