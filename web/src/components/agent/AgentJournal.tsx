import { useCallback, useEffect, useMemo, useState } from 'react';
import { get } from '../../lib/api';
import { formatTimestamp } from '../../lib/dates';
import { describeError } from '../../lib/errors';
import { useQuery } from '../../lib/queryCache';
import { nodePath } from '../../lib/router';
import type { AgentWriteRow, AgentWritesView } from '../../lib/types';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';

type ResourceEvent = {
  id:string;kind:string;resourceId:string;versionId:string|null;
  name:string;resourceType:string;sourceRepository:string|null;sourceRef:string|null;
  detail:string;createdAt:string;actor:string|null;actorRecorded:boolean;
  origin:'ai-resources'|'project-skill';
};
type ResourcePage = {
  items:ResourceEvent[];nextCursor:string|null;localOnly:boolean;
  historicalActorPolicy:string;
};
type Event = {
  id:string;source:'resource'|'agent';time:string;label:string;name:string;
  detail:string;actor:string|null;sourceLabel:string;status:string;
  link:string|null;
};
type Filter = 'all'|'resources'|'agent';
const PAGE = 100;

function action(kind:string,resourceType:string):string {
  const names:Record<string,string>={
    created_draft:'Draft added to library',updated_draft:'Draft updated',
    snapshotted:'Version snapshot created',created_revision_draft:'Version reopened for editing',
    review_approve:'Version approved',review_reject:'Version rejected',
    installed:'Skill installed',deployment_rolled_back:'Skill installation rolled back',
    prompt_notebook_created:'Prompt created',prompt_notebook_saved:'Prompt saved',
    prompt_copied:'Prompt used',prompt_flow_saved:'Prompt Flow updated',
    steering_exported:'Steering instructions exported',
    project_skill_updated:'Project Skill edited',
  };
  if (kind==='created_draft' && resourceType==='skill') return 'Skill draft added to library';
  return names[kind]||kind.replaceAll('_',' ');
}
function routeFor(item:ResourceEvent):string|null {
  if(item.origin==='project-skill')return '/resources/skills?projectId='+encodeURIComponent(item.resourceId.slice(8));
  if(!/^[a-f0-9]{32}$/.test(item.resourceId))return null;
  const category:Record<string,string>={skill:'skills',prompt:'prompts',mcp:'mcp',agent:'agents'};
  const tab=category[item.resourceType];
  return tab?'/resources/'+tab+'/'+item.resourceId:null;
}
function normalizeResource(item:ResourceEvent):Event {
  return {
    id:'resource:'+item.id,source:'resource',time:item.createdAt,
    label:action(item.kind,item.resourceType),name:item.name,
    detail:item.detail,actor:item.actorRecorded?item.actor:null,
    sourceLabel:[item.sourceRepository,item.sourceRef?.slice(0,10)].filter(Boolean).join(' · ')||
      (item.origin==='project-skill'?'Local Project Skills':'Local AI Resources'),
    status:item.kind==='review_approve'?'Approved':'Recorded',
    link:routeFor(item),
  };
}
function normalizeWork(item:AgentWriteRow):Event {
  return {
    id:'agent:'+item.writeId,source:'agent',time:item.createdAt,
    label:item.op.replaceAll('_',' '),name:item.nodePath||'Previous Work target',
    detail:'Work Hub Agent write',actor:item.actor||null,sourceLabel:'Work Agent API',
    status:item.state,link:item.nodePath?nodePath(item.nodeId,'activity'):null,
  };
}
function dayOf(value:string) {
  const time=new Date(value);
  return Number.isNaN(time.getTime())?'Unknown date':time.toLocaleDateString('sv-SE');
}

/** Local-only audit journal. Historical actors are never invented from repository origin. */
export function AgentJournal({ onManageWrites }:{onManageWrites:()=>void}) {
  const [resourceEntries,setResourceEntries]=useState<ResourceEvent[]>([]);
  const [cursor,setCursor]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const [loadingMore,setLoadingMore]=useState(false);
  const [resourceError,setResourceError]=useState('');
  const [filter,setFilter]=useState<Filter>('all');
  const [query,setQuery]=useState('');
  const [visible,setVisible]=useState(30);
  const work=useQuery<AgentWritesView>('agent-writes:journal',
    (signal)=>get<AgentWritesView>('agent-writes',{limit:50},{signal}),{staleMs:0});
  const fetchResources=useCallback(async(before?:string)=>{
    const next=new URLSearchParams({view:'activity-journal',limit:String(PAGE)});
    if(before)next.set('before',before);
    const response=await fetch('/api/resources/v1?'+next,{headers:{Accept:'application/json'},
      cache:'no-store'});
    const body=await response.json() as {ok:boolean;data?:ResourcePage;code?:string};
    if(!response.ok||!body.ok||!body.data)throw new Error(body.code||'Activity history unavailable');
    if(!body.data.localOnly)throw new Error('Local audit boundary invalid');
    return body.data;
  },[]);
  const reload=useCallback(async()=>{
    setLoading(true);setResourceError('');setVisible(30);
    try{
      const result=await fetchResources();
      setResourceEntries(result.items);setCursor(result.nextCursor);
    }catch(error){setResourceError(error instanceof Error?error.message:String(error));}
    finally{setLoading(false);}
  },[fetchResources]);
  useEffect(()=>{void reload();},[reload]);
  const loadOlder=async()=>{
    if(!cursor||loadingMore)return;
    setLoadingMore(true);setResourceError('');
    try{
      const result=await fetchResources(cursor);
      setResourceEntries(current=>{
        const ids=new Set(current.map(item=>item.id));
        return [...current,...result.items.filter(item=>!ids.has(item.id))];
      });
      setCursor(result.nextCursor);
    }catch(error){setResourceError(error instanceof Error?error.message:String(error));}
    finally{setLoadingMore(false);}
  };
  const events=useMemo(()=>
    [...resourceEntries.map(normalizeResource),...(work.data?.items||[]).map(normalizeWork)]
      .sort((a,b)=>b.time.localeCompare(a.time)||a.id.localeCompare(b.id)),
    [resourceEntries,work.data]);
  const matching=useMemo(()=>events.filter(event=>
    (filter==='all'||event.source===(filter==='agent'?'agent':'resource')) &&
    [event.label,event.name,event.detail,event.actor,event.sourceLabel,event.status]
      .join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
  [events,filter,query]);
  const displayed=matching.slice(0,visible);
  const groups=useMemo(()=>{
    const byDay=new Map<string,Event[]>();
    displayed.forEach(event=>{
      const day=dayOf(event.time);
      if(!byDay.has(day))byDay.set(day,[]);
      byDay.get(day)!.push(event);
    });
    return [...byDay].map(([day,items])=>({day,items}));
  },[displayed]);
  const sourceSummaries=useMemo(()=>{
    const grouped=new Map<string,{count:number;ref:string|null}>();
    for(const item of resourceEntries){
      if(item.kind!=='created_draft'||item.resourceType!=='skill'||!item.sourceRepository)continue;
      const previous=grouped.get(item.sourceRepository);
      grouped.set(item.sourceRepository,{count:(previous?.count||0)+1,ref:item.sourceRef});
    }
    return [...grouped].filter(([,v])=>v.count>1)
      .sort((a,b)=>b[1].count-a[1].count).slice(0,3);
  },[resourceEntries]);
  const resourceCount=resourceEntries.length;
  const workCount=work.data?.items.length||0;
  return <section className="agent-journal" aria-labelledby="agent-journal-heading">
    <div className="agent-journal-intro">
      <div><h2 id="agent-journal-heading">Agent Activities</h2>
        <p className="muted">One local audit timeline for Work Agent writes and AI Resources changes.</p>
      </div>
      <button className="btn" type="button" onClick={()=>{
        void reload();void work.refetch();
      }}><Icon name="history"/> Refresh</button>
    </div>
    <div className="resources-mini-overview" aria-label="Activity summary">
      <span><strong>{resourceCount+workCount}</strong> Loaded events</span>
      <span><strong>{resourceCount}</strong> AI Resources</span>
      <span><strong>{workCount}</strong> Work Agent writes</span>
    </div>
    <div className="agent-journal-toolbar">
      <div role="group" aria-label="Activity source" className="agent-journal-filters">
        {([['all','All'],['resources','AI Resources'],['agent','Work Agents']] as const).map(([value,label])=>
          <button key={value} type="button" aria-pressed={filter===value}
            className={filter===value?'is-active':''} onClick={()=>{setFilter(value);setVisible(30);}}>
            {label}</button>)}
      </div>
      <label className="agent-journal-search"><Icon name="search"/>
        <input type="search" aria-label="Search activity" placeholder="Search events, Skills, sources..."
          value={query} onChange={e=>{setQuery(e.target.value);setVisible(30);}}/>
      </label>
    </div>
    {sourceSummaries.length>0&&<div className="agent-journal-source-summaries">
      <strong>Skill import history (derived from individual audit events)</strong>
      {sourceSummaries.map(([repository,summary])=><span key={repository}>
        <b>{summary.count}</b> Skill drafts · {repository}
        {summary.ref&&<> · Commit <code>{summary.ref.slice(0,10)}</code></>}
      </span>)}
    </div>}
    <p className="agent-journal-privacy"><Icon name="shield-check"/>
      Earlier Resource events record what happened and when, but usually not who performed it.
      Unknown actors are shown as unrecorded—not attributed to ChatGPT or another Agent.
      Resource content and credentials are never copied into this journal.
    </p>
    {resourceError&&<div className="error-bar" role="alert">{resourceError}
      <button type="button" className="btn" onClick={()=>void reload()}>Retry</button></div>}
    {work.status==='error'&&!work.data&&<p className="muted" role="status">
      Work Agent history is temporarily unavailable: {describeError(work.error)}
    </p>}
    {loading&&resourceEntries.length===0&&<p className="muted" role="status">Loading resource history…</p>}
    {groups.length===0&&!loading&&<div className="empty-state"><p className="muted">
      No matching events. Adjust the source or search.</p></div>}
    <div className="agent-journal-days" aria-label="Activity log">
      {groups.map(group=><section className="agent-journal-day" key={group.day}>
        <h3>{group.day}<span>{group.items.length}</span></h3>
        <ul className="agent-journal-events">
          {group.items.map(event=><li key={event.id} className="agent-journal-event"
            data-source={event.source}>
            <span className="agent-journal-icon"><Icon name={event.source==='agent'?'bot':'blocks'}/></span>
            <div className="agent-journal-event-body">
              <div className="agent-journal-event-top">
                <strong>{event.label}</strong>
                <time dateTime={event.time}>{formatTimestamp(event.time)}</time>
              </div>
              <div className="agent-journal-target">{event.link?
                <AppLink to={event.link}>{event.name}</AppLink>:event.name}</div>
              <div className="agent-journal-event-meta">
                <span>{event.sourceLabel}</span>
                <span>{event.actor?'Actor: '+event.actor:'Actor unrecorded'}</span>
                <span>{event.status}</span>
              </div>
              {event.detail&&event.detail!=='Work Hub Agent write'&&
                <p className="agent-journal-detail">{event.detail}</p>}
            </div>
          </li>)}
        </ul>
      </section>)}
    </div>
    <div className="agent-journal-bottom">
      {matching.length>visible&&<button type="button" className="btn"
        onClick={()=>setVisible(v=>v+40)}>Show more events ({matching.length-visible})</button>}
      {cursor&&<button type="button" className="btn" disabled={loadingMore}
        onClick={()=>void loadOlder()}>{loadingMore?'Loading…':'Load older Resource events'}</button>}
      <button type="button" className="btn" onClick={onManageWrites}>
        <Icon name="activity"/> Work Agent write review &amp; full history
      </button>
    </div>
  </section>;
}
