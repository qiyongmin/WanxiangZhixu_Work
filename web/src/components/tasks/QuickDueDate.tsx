import { useEffect, useState } from 'react';
import { describeError } from '../../lib/errors';
import { isConflict } from '../../lib/nodeData';
import { showNotice } from '../../lib/notice';
import { updateNode } from '../../lib/taskWrite';
import type { TaskRow } from '../../lib/types';
import { Icon } from '../icons';

/** Small revision-safe due date editor. Enabled only by L1 Project Canvas. */
export function QuickDueDate({task}: {task:TaskRow}) {
  const [open,setOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [date,setDate]=useState(task.dueDate ?? '');
  const [error,setError]=useState('');
  useEffect(()=>{if(!busy)setDate(task.dueDate ?? '');},[task.id,task.revision,task.dueDate,busy]);

  const change=async(next:string)=>{
    if(busy)return;
    if(next===(task.dueDate??'')){setOpen(false);return;}
    setBusy(true);setError('');
    try{
      await updateNode(task.id,task.revision,{dueDate:next});
      setDate(next);setOpen(false);
    }catch(err){
      setDate(task.dueDate??'');
      const reason=isConflict(err)?'Task was updated elsewhere. Reload and retry.':
        'Due date was not saved: '+describeError(err);
      setError(reason);showNotice(reason);
    }finally{setBusy(false);}
  };
  return <span className="quick-due" data-task-due={task.id}
    onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}>
    <button type="button" className="quick-due-trigger" aria-expanded={open}
      aria-label={'Edit Due Date: '+task.title} disabled={busy} onClick={()=>setOpen(v=>!v)}>
      <Icon name="week" size={14}/>{busy?'Saving…':task.dueDate??'Set due'}
    </button>
    {open?<span className="quick-due-popover">
      <input type="date" aria-label={'Due Date: '+task.title} value={date}
        disabled={busy} onChange={event=>{const value=event.target.value;setDate(value);void change(value);}}/>
      {task.dueDate?<button type="button" disabled={busy} onClick={()=>void change('')}>Clear</button>:null}
      <button type="button" disabled={busy} aria-label="Close due date editor"
        onClick={()=>setOpen(false)}>Close</button>
    </span>:null}
    {error?<span className="quick-due-error" role="alert">{error}</span>:null}
  </span>;
}
