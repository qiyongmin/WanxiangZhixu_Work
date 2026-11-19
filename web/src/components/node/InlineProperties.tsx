import { useEffect, useRef, useState } from 'react';
import { get } from '../../lib/api';
import { localNow } from '../../lib/dates';
import { notifyDraftChange, registerEditor } from '../../lib/draftGuard';
import { describeError } from '../../lib/errors';
import { isConflict } from '../../lib/nodeData';
import { updateNode } from '../../lib/taskWrite';
import { PRIORITIES, STATUSES, type NodeDTO, type NodeUpdateBody, type TasksView } from '../../lib/types';
import { Icon } from '../icons';

type Field = 'status' | 'priority' | 'dueDate';
type Pending = { field: Field; value: string; before: string } | null;

const valueOf = (node: NodeDTO, field: Field): string => field === 'status' ? node.status : node[field] ?? '';
const fieldName: Record<Field, string> = {status:'Status',priority:'Priority',dueDate:'Due'};

/** Small, accessible, revision-safe inline edit controls for L1/L2/L3.
 * Each change is one node-update. No optimistic success and no silent rebase.
 */
export function InlineProperties({node}: {node: NodeDTO}) {
  const [open,setOpen] = useState<Field|null>(null);
  const [busy,setBusy] = useState(false);
  const [state,setState] = useState<'idle'|'saved'|'failed'>('idle');
  const [error,setError] = useState('');
  const [pending,setPending] = useState<Pending>(null);
  const [confirmDone,setConfirmDone] = useState(false);
  const [openChildren,setOpenChildren] = useState<number|null>(null);
  const [dueDraft,setDueDraft] = useState(node.dueDate ?? '');
  const current = useRef(node);
  const saving = useRef(false);
  const element = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current=pending;
  const retryRef=useRef<()=>Promise<boolean>>(async()=>true);
  useEffect(()=>registerEditor('inline-properties:'+node.id,{
    dirty:()=>Boolean(pendingRef.current),
    save:()=>retryRef.current(),
    discard:()=>{pendingRef.current=null;setPending(null);setError('');setState('idle');}
  }),[node.id]);
  useEffect(()=>notifyDraftChange(),[pending]);
  useEffect(()=>{
    if(!open) return undefined;
    const outside=(event:PointerEvent)=>{if(!element.current?.contains(event.target as Node))setOpen(null);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(null);};
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',escape);
    return ()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  useEffect(() => {
    if (!saving.current) current.current=node;
    if (!pending || pending.field!=='dueDate') setDueDraft(node.dueDate??'');
  },[node,pending]);

  const submit=async (field:Field,value:string,expected=valueOf(current.current,field),replay=false) => {
    if(saving.current || node.archivedAt) return false;
    if(value===expected) {setPending(null);setOpen(null);return true;}
    saving.current=true;setBusy(true);setError('');setState('idle');setOpen(null);
    const request:Pending={field,value,before:expected};
    setPending(request);
    try {
      const source = replay ? await get<NodeDTO>('node',{id:node.id}) : current.current;
      // Only a user-initiated Retry after a 409 can rebase a conflicting change.
      if(source.id!==node.id) throw new Error('Node identity changed. No data was saved.');
      const changes:NodeUpdateBody['changes'] = {[field]:value};
      const result=await updateNode(source.id,source.revision,changes);
      current.current=result.node;
      setPending(null);setState('saved');setError('');
      setDueDraft(result.node.dueDate??'');
      return true;
    } catch (err) {
      setPending(request);setState('failed');
      setError(isConflict(err)
        ? 'Revision conflict. Your choice was retained. Check the latest value and choose Retry to confirm.'
        : describeError(err)+'. Your selection has not been saved; choose Retry or Discard.');
      return false;
    } finally {saving.current=false;setBusy(false);}
  };

  retryRef.current=async()=>{
    const choice=pendingRef.current;
    if(!choice||saving.current)return !choice;
    return submit(choice.field,choice.value,choice.before,true);
  };

  const choose = (field:Field,value:string) => {
    if(field==='status' && value==='Done') {
      setOpen(null);setConfirmDone(true);setOpenChildren(null);
      if(node.childCount) {
        void get<TasksView>('tasks',{scope:'node',id:node.id,direct:1,now:localNow()})
          .then(data=>setOpenChildren(data.items.filter(item=>item.status!=='Done').length))
          .catch(()=>setOpenChildren(null));
      } else setOpenChildren(0);
      return;
    }
    void submit(field,value);
  };

  const message = busy?'Saving…':state==='saved'?'Saved':state==='failed'?'Not saved':'';
  const fields:Field[]=['status','priority','dueDate'];
  return <div ref={element} className="inline-node-properties" data-inline-node={node.id}>
    <div className="inline-node-property-list">
      {fields.map(field=><div key={field} className="inline-property-control">
        <button type="button" className="inline-property-chip" aria-label={'Edit '+fieldName[field]+': '+(valueOf(node,field)||'Not set')}
          aria-expanded={open===field} disabled={busy||Boolean(node.archivedAt)}
          onClick={()=>{setOpen(open===field?null:field);if(field==='dueDate')setDueDraft(node.dueDate??'');}}>
          <span className="inline-property-label">{fieldName[field]}</span>
          <strong data-status={field==='status'?node.status:undefined}>{valueOf(node,field)||(field==='priority'?'Set priority':'Set due')}</strong>
          <Icon name="chevron-down" size={13}/>
        </button>
        {open===field?<div className="inline-property-popover" role="group" aria-label={'Choose '+fieldName[field]}>
          {field==='status' ? STATUSES.map(status=><button type="button" key={status} className="inline-property-option"
              aria-pressed={node.status===status} onClick={()=>choose('status',status)}>{status}</button>) : null}
          {field==='priority' ? <>
            {PRIORITIES.map(priority=><button key={priority} type="button" className="inline-property-option"
              aria-pressed={node.priority===priority} onClick={()=>choose('priority',priority)}>{priority}</button>)}
            <button type="button" className="inline-property-option" onClick={()=>choose('priority','')}>Clear priority</button>
          </> : null}
          {field==='dueDate'?<div className="inline-due-editor">
            <label>Due date <input aria-label="Due date" type="date" value={dueDraft}
              onChange={e=>{setDueDraft(e.target.value);choose('dueDate',e.target.value);}}/></label>
            <div className="inline-due-actions">
              <button type="button" className="btn" onClick={()=>choose('dueDate','')}>Clear</button>

            </div>
          </div>:null}
        </div>:null}
      </div>)}
    </div>
    {message?<span className={state==='failed'?'inline-property-save is-error':'inline-property-save'}
      role="status" aria-live="polite">{message}</span>:null}
    {pending&&state==='failed'?<div className="inline-property-error" role="alert">
      <span>{error} <strong>{fieldName[pending.field]}: {pending.value||'Clear'}</strong></span>
      <button className="btn" type="button" disabled={busy} onClick={()=>void submit(pending.field,pending.value,pending.before,true)}>Retry</button>
      <button className="btn" type="button" onClick={()=>{setPending(null);setState('idle');setError('');}}>Discard</button>
    </div>:null}
    {confirmDone?<div className="inline-property-confirm" role="group" aria-label="Confirm Done">
      <strong>Mark as Done?</strong>
      <span>{openChildren===null?'Could not verify the number of open Sub-Tasks. They will not be deleted.':
        openChildren>0?`${openChildren} open Sub-Tasks remain. They will not be deleted.`:'Confirm completion of this work item.'}</span>
      <button className="btn btn-primary" type="button" disabled={busy}
        onClick={()=>{setConfirmDone(false);void submit('status','Done');}}>Confirm Done</button>
      <button className="btn" type="button" onClick={()=>setConfirmDone(false)}>Cancel</button>
    </div>:null}
  </div>;
}
