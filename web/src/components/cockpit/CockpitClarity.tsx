import { isMissed } from '../../lib/reminders';
import { englishOr } from '../../lib/errorMessages';
import { describeError } from '../../lib/errors';
import type { QueryResult } from '../../lib/queryCache';
import { nodePath, shouldIntercept, withBase } from '../../lib/router';
import { L, L2 } from '../../lib/labels';
import type { CockpitGroupData, CockpitGroupId, TaskRow } from '../../lib/types';
import { Icon, type IconName } from '../icons';
import { AppLink } from '../AppLink';
import { ReminderActions } from '../ReminderActions';
import { StatusBadge } from '../StatusBadge';
import { NotifyStatus } from '../settings/NotifyStatus';

export type ClarityLaneId = 'attention'|'follow'|'upcoming';
export type ClarityItem = { group: CockpitGroupId; row: TaskRow };
export type ClarityData = Record<ClarityLaneId, ClarityItem[]>;
export type ClarityQueries = Record<CockpitGroupId, QueryResult<CockpitGroupData>>;
export const CLARITY_LANES: readonly ClarityLaneId[] = ['attention','follow','upcoming'];
const SOURCES: Record<ClarityLaneId, readonly CockpitGroupId[]> = {
  attention: ['overdue','followUp'],
  follow: ['followUp','reminders'],
  upcoming: ['today','week'],
};

/** Classifies the existing six independent Cockpit queries without modifying the server contract.
 * A blocked item is urgent regardless of due date; a waiting item belongs to
 * follow-up. Duplicate IDs are shown exactly once, in priority lane order.
 * The raw four KPI totals remain untouched (followUp KPI still counts both).
 */
export function buildClarityData(
  queries: ClarityQueries, gone: ReadonlySet<string>,
): ClarityData {
  const result: ClarityData={attention:[],follow:[],upcoming:[]};
  const used=new Set<string>();
  const append=(lane:ClarityLaneId,group:CockpitGroupId,predicate:(r:TaskRow)=>boolean=()=>true)=>{
    const query=queries[group].data;
    if(!query?.ok)return;
    for(const row of query.items) {
      if(gone.has(row.id)||used.has(row.id)||!predicate(row))continue;
      used.add(row.id);
      result[lane].push({group,row});
    }
  };
  append('attention','overdue');
  append('attention','followUp',row=>row.status==='Blocked');
  append('follow','followUp',row=>row.status==='Waiting');
  append('follow','reminders');
  append('upcoming','today');
  append('upcoming','week');
  return result;
}

export function clarityScope(row:TaskRow):string {
  return row.path[0]?.title || 'Unassigned';
}
export function clarityFilter(data:ClarityData,scope:string,search:string):ClarityData {
  const needle=search.trim().toLocaleLowerCase();
  const filter=({row}:ClarityItem)=>{
    if(scope!=='all' && clarityScope(row)!==scope)return false;
    if(!needle)return true;
    const text=[row.title,row.status,row.assignee??'',row.priority??'',...(row.tags??[]),...(row.path??[]).map(p=>p.title)].join(' ').toLocaleLowerCase();
    return text.includes(needle);
  };
  return {
    attention:data.attention.filter(filter),
    follow:data.follow.filter(filter),
    upcoming:data.upcoming.filter(filter),
  };
}
export function clarityScopes(data:ClarityData):string[]{
  const count=new Map<string,number>();
  for(const lane of CLARITY_LANES)for(const item of data[lane]){
    const scope=clarityScope(item.row);count.set(scope,(count.get(scope)??0)+1);
  }
  return [...count].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([scope])=>scope);
}

const META:Record<ClarityLaneId,{heading:string;eyebrow:string;subtitle:string;icon:IconName}>={
  attention:{heading:'Needs Attention',eyebrow:'01 / ACT NOW',subtitle:'Overdue · Blocked · requiring a decision',icon:'bell'},
  follow:{heading:'Needs Follow-up',eyebrow:'02 / WAITING ON OTHERS',subtitle:'Waiting · Reminders · pending responses',icon:'activity'},
  upcoming:{heading:'Coming Up',eyebrow:"03 / WHAT'S NEXT",subtitle:'Due today · This week',icon:'week'},
};
const SOURCE_NAMES:Record<CockpitGroupId,string>={
  overdue:'Overdue',followUp:'Needs follow-up',reminders:'Reminders due',
  today:'Due today',week:'Due this week',recent:'Recently updated',
};

interface LaneProps {
  lane:ClarityLaneId;
  items:ClarityItem[];
  allItems:ClarityItem[];
  queries:ClarityQueries;
  filtered:boolean;
  activeId:string|null;
  onSelect:(id:string)=>void;
  onOpen:(row:TaskRow)=>void;
}

/** Keep source-specific loading, errors and retry actions visible. */
export function ClarityLane({lane,items,allItems,queries,filtered,activeId,onSelect,onOpen}:LaneProps){
  const meta=META[lane];
  const sourceErrors=SOURCES[lane].flatMap(group=>{
    const query=queries[group];
    const response=query.data;
    const error=response&&!response.ok?englishOr(response.error,L2.groupFailed):
      query.status==='error'?describeError(query.error):null;
    return error?[{group,message:error,query}]:[];
  });
  const sourceLoading=SOURCES[lane].some(group=>!queries[group].data && queries[group].status!=='error');
  const truncated=SOURCES[lane].some(group=>{
    const data=queries[group].data;
    return data?.ok && data.total>data.items.length;
  });
  return <section className={`clarity-lane clarity-lane--${lane}`}
    id={`clarity-${lane}`} data-clarity-lane={lane}
    aria-labelledby={`clarity-title-${lane}`}>
    <div className="clarity-lane-head">
      <span className="clarity-lane-icon" aria-hidden="true"><Icon name={meta.icon} size={21}/></span>
      <div className="clarity-lane-heading">
        <span className="clarity-lane-eyebrow">{meta.eyebrow}</span>
        <h2 id={`clarity-title-${lane}`}>{meta.heading}</h2>
        <p className="clarity-lane-subtitle">{meta.subtitle}</p>
      </div>
      <span className="clarity-lane-count" aria-label={`${items.length} visible items`}>
        {items.length}{truncated?' +':''} {items.length===1?'ITEM':'ITEMS'}
      </span>
    </div>
    {sourceErrors.map(({group,message,query})=><div className="error-bar clarity-source-error"
      role="alert" data-group={group} key={group}>
      <strong>{SOURCE_NAMES[group]}</strong>: {message}
      <button type="button" className="btn" onClick={()=>void query.refetch()}>{L.retry}</button>
    </div>)}
    {sourceLoading ? <p className="muted clarity-lane-loading" role="status">{L.loading}</p> : null}
    {lane==='follow' ? <div className="clarity-notify"><NotifyStatus inline/></div> : null}
    {items.length?<ul className="clarity-task-list" aria-label={meta.heading}>
      {items.map(({group,row})=>{
        const id=`${group}:${row.id}`;
        const pendingReminder=Boolean(row.remindAt&&(group==='reminders'||row.remindPending));
        const missed=Boolean(pendingReminder&&isMissed(row));
        return <li key={row.id} className={id===activeId?'clarity-task is-active':'clarity-task'}
          data-task-id={row.id} data-group={group} data-nav-id={id}
          data-active={id===activeId?'true':undefined} aria-current={id===activeId?'true':undefined}
          onClick={()=>onSelect(id)}>
          <div className="clarity-task-copy">
            <a className="clarity-task-title" href={withBase(nodePath(row.id))}
              onClick={event=>{if(shouldIntercept(event)){event.preventDefault();onOpen(row);}}}>{row.title}</a>
            <span className="clarity-task-path">{[...row.path.map(x=>x.title), ...(row.assignee?[row.assignee]:[])].join(' · ')||'Task'}</span>
            {missed?<span className="flag flag-missed"><Icon name="bell" size={12}/> {L2.reminderMissed}</span>:null}
            {row.unconfirmed>0?<span className="flag">{L2.newMark}</span>:null}
            {pendingReminder&&row.remindAt?<div className="clarity-reminder-actions">
              <ReminderActions taskId={row.id} remindAt={row.remindAt} revision={row.revision}/>
            </div>:null}
          </div>
          <div className="clarity-task-right">
            <StatusBadge status={row.status}/>
            <span className="clarity-task-date" title={row.dueDate??'No due date'}>
              {row.dueDate??(row.remindAt?row.remindAt.slice(0,10):'No due date')}
            </span>
            <a className="clarity-task-arrow" href={withBase(nodePath(row.id))}
              aria-label={`Open ${row.title}`} title="Open task"
              onClick={event=>{if(shouldIntercept(event)){event.preventDefault();onOpen(row);}}}>
              <Icon name="chevron-right" size={16}/>
            </a>
          </div>
        </li>;
      })}
    </ul>:!sourceLoading && !sourceErrors.length?
      <p className="clarity-lane-empty">{filtered&&allItems.length?'No matches for the current filters.':'Nothing to address in this area.'}</p>:null}
    {truncated?<p className="clarity-lane-more">
      This group is showing only the first {allItems.length} distinct items available from the overview feeds.
      <AppLink to="/?view=board"> Open all work in Board</AppLink>
    </p>:null}
  </section>;
}
