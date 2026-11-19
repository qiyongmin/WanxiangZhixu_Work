import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentJournal } from '../src/components/agent/AgentJournal';
import { AgentAccess } from '../src/components/agent/AgentAccess';
import { cleanup, click, flush, render } from './helpers';

const skillId='a'.repeat(32);
const events=[
  {id:'b'.repeat(32),kind:'created_draft',resourceId:skillId,versionId:null,
    name:'chief-of-staff',resourceType:'skill',sourceRepository:'mattpocock/skills',
    sourceRef:'c'.repeat(40),detail:'',createdAt:'2026-11-18T07:37:48.681441+00:00',
    actor:null,actorRecorded:false,origin:'ai-resources'},
  {id:'d'.repeat(32),kind:'snapshotted',resourceId:skillId,versionId:'e'.repeat(32),
    name:'chief-of-staff',resourceType:'skill',sourceRepository:'mattpocock/skills',
    sourceRef:'c'.repeat(40),detail:'',createdAt:'2026-11-18T07:37:49.681441+00:00',
    actor:null,actorRecorded:false,origin:'ai-resources'},
  {id:'f'.repeat(32),kind:'review_approve',resourceId:skillId,versionId:'e'.repeat(32),
    name:'chief-of-staff',resourceType:'skill',sourceRepository:'mattpocock/skills',
    sourceRef:'c'.repeat(40),detail:'',createdAt:'2026-11-18T08:37:00.000000+00:00',
    actor:'local-user',actorRecorded:true,origin:'ai-resources'},
  {id:'1'.repeat(32),kind:'project_skill_updated',resourceId:'project:work.example',versionId:null,
    name:'work.example',resourceType:'skill',sourceRepository:null,sourceRef:null,
    detail:'SKILL.md · abc → def · local API',createdAt:'2026-11-18T10:37:00.000000+00:00',
    actor:null,actorRecorded:false,origin:'project-skill'},
];
const agentWrites=[{writeId:'write1',actor:'agent:kiro',nodeId:'n1',nodePath:'Example/Task',
  op:'add_note',createdAt:'2026-11-18T09:25:00.000000+00:00',
  state:'unconfirmed',resolvedAt:null}];
const json=(data:unknown)=>new Response(JSON.stringify({ok:true,data}),{
  status:200,headers:{'Content-Type':'application/json'},
});
const fetchMock=vi.fn(async(url:RequestInfo|URL)=>{
  const value=String(url);
  if(value.includes('view=activity-journal'))return json({
    items:events,nextCursor:null,localOnly:true,historicalActorPolicy:'unrecorded-means-unknown',
  });
  if(value.includes('view=agent-writes'))return json({items:agentWrites,nextCursor:null});
  if(value.includes('provider-keys'))return json({saved:{}});
  throw new Error('Unexpected request '+value);
});
beforeEach(()=>{fetchMock.mockClear();vi.stubGlobal('fetch',fetchMock);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

describe('Agent Access unified Activities',()=>{
  it('merges source-backed Skill import, versions, approvals, edits and agent writes by time',async()=>{
    const open=vi.fn();
    const root=render(<AgentJournal onManageWrites={open}/>);
    await flush();
    expect(root.querySelectorAll('.agent-journal-event')).toHaveLength(5);
    const labels=Array.from(root.querySelectorAll('.agent-journal-event-top strong'))
      .map(e=>e.textContent);
    expect(labels).toEqual([
      'Project Skill edited','add note','Version approved','Version snapshot created',
      'Skill draft added to library',
    ]);
    expect(root.textContent).toContain('mattpocock/skills');
    expect(root.textContent).toContain('Actor unrecorded');
    expect(root.textContent).toContain('Actor: local-user');
    expect(root.textContent).toContain('actor'); // Provenance disclaimer
    expect(root.querySelector('a[href="/app/resources/skills/'+skillId+'"]')).not.toBeNull();
    const button=Array.from(root.querySelectorAll('button'))
      .find(x=>x.textContent?.includes('full history'))!;
    click(button);
    expect(open).toHaveBeenCalledOnce();
  });
  it('filters AI Resources and Work writes independently without losing history',async()=>{
    const root=render(<AgentJournal onManageWrites={()=>{}}/>);
    await flush();
    const resource=Array.from(root.querySelectorAll('button')).find(x=>x.textContent==='AI Resources')!;
    click(resource);
    expect(root.querySelectorAll('.agent-journal-event')).toHaveLength(4);
    const work=Array.from(root.querySelectorAll('button')).find(x=>x.textContent==='Work Agents')!;
    click(work);
    expect(root.querySelectorAll('.agent-journal-event')).toHaveLength(1);
    expect(root.textContent).toContain('agent:kiro');
    const all=Array.from(root.querySelectorAll('button')).find(x=>x.textContent==='All')!;
    click(all);
    expect(root.querySelectorAll('.agent-journal-event')).toHaveLength(5);
  });
  it('nests activities in Agent Access with an expandable Work Agent review',async()=>{
    const root=render(<AgentAccess section="activities"/>);
    await flush();
    expect(root.querySelector('nav.agent-access-tabs')).not.toBeNull();
    expect(root.querySelector('a.is-active')?.textContent).toContain('Agent Activities');
    expect(root.querySelectorAll('.agent-journal-event')).toHaveLength(5);
    expect(root.querySelector('.agent-provider-section')).toBeNull();
    expect(root.querySelector('.agent-activity-embedded')).toBeNull();
    const manage=Array.from(root.querySelectorAll('button')).find(
      x=>x.textContent?.includes('Work Agent write review'))!;
    click(manage);
    await flush();
    expect(root.querySelector('.agent-activity-embedded')).not.toBeNull();
  });
});
