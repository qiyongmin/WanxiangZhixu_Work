import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotesTab } from '../src/components/notes/NotesTab';
import { resetCache } from '../src/lib/queryCache';
import { cancelDraftNavigation } from '../src/lib/draftGuard';
import { cleanup, render, flush, click } from './helpers';
import { dto, stubFetch, setValue } from './p2';

const owner = dto({id:'ws',kind:'workstream',depth:2});
const journal = {id:'ns_j',owner_id:'ws',role:'journal',title:'Journal / Timeline',
  position:3,pageCount:1,updated_at:'2026-11-16T10:00:00Z'};
const ordinary = {id:'ns_report',owner_id:'ws',role:null,title:'Work Report',
  position:0,pageCount:1,updated_at:'2026-11-16T10:00:00Z'};
const page = {id:'np_01',owner_id:'ws',section_id:'ns_j',title:'Daily update',
  html:'<p>Preserve daily details</p>',revision:3,updated_at:'2026-11-16T11:00:00Z',
  timelineDate:'2026-11-16',legacy_id:null,unconfirmedWriteIds:[],links:[],position:0};
const event = {id:'ne_01',owner_id:'ws',kind:'journal',title:'Daily update',event_date:'2026-11-16',
  event_time:null,timezone:null,summary_html:'',revision:2,pageIds:['np_01'],taskIds:[],
  sourcePath:[{id:'init',title:'Sample Project'},{id:'ws',title:'Review'}],
  linkedPages:[{id:'np_01',owner_id:'ws',section_id:'ns_j',title:'Daily update',revision:3}],
  linkedTasks:[]};
const paired = {key:'paired:ne_01',type:'paired',eventId:'ne_01',pageId:'np_01',
  pageOwnerId:'ws',eventOwnerId:'ws',pageSectionId:'ns_j',pageRevision:3,eventRevision:2,
  date:'2026-11-16',eventTime:null,title:'Daily update',kind:'journal',
  sourcePath:[{id:'init',title:'Sample Project'},{id:'ws',title:'Review'}],
  linkedPageIds:['np_01'],linkedTaskIds:[]};
const standalone = {key:'event:ne_02',type:'event',eventId:'ne_02',pageId:null,
  pageOwnerId:null,eventOwnerId:'ws',pageRevision:null,eventRevision:1,date:'2026-11-13',
  eventTime:null,title:'Review checkpoint',kind:'milestone',
  sourcePath:[{id:'init',title:'Sample Project'},{id:'ws',title:'Review'}],
  linkedPageIds:[],linkedTaskIds:[]};

function mock(){
  return stubFetch({views:{
    'notebook-status':()=>({ready:true,version:4}),
    'notebook-sections':params=>params.archived==='1'?
      ({sections:[{...ordinary,id:'ns_archive',title:'Past Reports',pageCount:2}],linkedPages:[]}):
      ({sections:[journal,ordinary],linkedPages:[{...page,id:'np_link',title:'From L1',owner_id:'init',section_id:'ns_remote',target_node_id:'ws'}]}),
    'notebook-pages':params=>({items:params.section==='ns_report'?
      [{...page,id:'np_report',section_id:'ns_report',title:'Monthly report'}]:
      [page],total:1,offset:0,limit:40}),
    'notebook-page':()=>({...page}),
    'notebook-page-history':()=>({items:[]}),
    'notebook-timeline':()=>({items:[paired,standalone],total:2,rootId:'init',offset:0,limit:40}),
    'notebook-event':()=>event,
    'notebook-delete-preview':params=>({
      kind:params.kind,targetId:params.targetId,ownerId:params.id,
      title:params.kind==='section'?(params.targetId==='ns_archive'?'Past Reports':'Work Report'):'Daily update',
      archived:params.targetId==='ns_archive',signature:'test-signature',
      pageCount:params.kind==='section'?2:1,archivedPageCount:0,
      linkedEventCount:1,attachmentRefs:0,legacyPageCount:0,
      linkedPageCount:1,linkedTaskCount:0,
    }),
    tree:()=>({sections:[],nodes:[{id:'init',parentId:null,title:'Sample Project',depth:1},
      {id:'ws',parentId:'init',title:'Review',depth:2}]}),
  },actions:{
    'notebook-section-rename':()=>({changed:true}),
    'notebook-section-restore':()=>({changed:true}),
    'notebook-section-archive':()=>({changed:true}),
    'notebook-permanent-delete':()=>({deleted:true}),
    'notebook-page-timeline-date-set':()=>({page:{...page,revision:4,timelineDate:'2026-11-12'},
      event:{...event,revision:3,event_date:'2026-11-12'}}),
  }});
}
afterEach(()=>{cleanup();resetCache();vi.unstubAllGlobals();vi.restoreAllMocks();
  cancelDraftNavigation();window.history.replaceState(null,'','/app/');});

describe('Notes V3.4 · Unified Sections and Vertical Stream',()=>{
  it('replaces three top-level tabs with protected OneNote Journal and compact Pages/Timeline',async()=>{
    mock();window.history.replaceState(null,'','/app/n/ws/notes');
    const c=render(<NotesTab node={owner} focused/>);await flush(15);
    const tabs=c.querySelector('.notebook-v34-tabs')!;
    expect(tabs.textContent).toContain('Journal / Timeline');
    expect(tabs.querySelectorAll('button')[0]?.textContent).toContain('Journal');
    expect(c.querySelector('.notebook-view-switch')).toBeNull();
    expect(c.querySelectorAll('.note-editor')).toHaveLength(1);
    expect(c.querySelector('.notebook-v34-linked-toggle')).not.toBeNull();
    expect(c.textContent).not.toContain('Project Timeline');
    const heading=c.querySelector('.notebook-section-heading')!;
    expect(heading.querySelector('.notebook-section-tabs')).not.toBeNull();
    expect(heading.querySelector('button[aria-label="Section actions"]')).not.toBeNull();
    const actions=c.querySelector('.notebook-v34-topline .notebook-top-utilities')!;
    expect(Array.from(actions.querySelectorAll('button')).map(b=>b.textContent))
      .toEqual(['Quick Capture','New Event']);
    expect(c.querySelector('button[aria-label="New Page"]')).toBeNull();
    click(c.querySelector('button[aria-label="Section actions"]')!);
    expect(c.textContent).toContain('Journal is fixed and protected');
  });

  it('shows Journal Vertical Stream and paired/event cards without duplicate Page entries',async()=>{
    const server=mock();window.history.replaceState(null,'','/app/n/ws/notes?view=timeline');
    const c=render(<NotesTab node={owner} focused/>);await flush(18);
    expect(c.querySelector('.notebook-v34-stream')).not.toBeNull();
    expect(c.querySelector('.notebook-timeline')?.getAttribute('data-root-id')).toBe('init');
    expect(c.querySelectorAll('[data-event-id="ne_01"]')).toHaveLength(1);
    expect(c.querySelector('.notebook-event-list')?.textContent).toContain('Review checkpoint');
    expect(server.gets.some(x=>x.view==='notebook-timeline'&&x.params.id==='ws')).toBe(true);
    click(c.querySelector('[data-event-id="ne_01"] button')!);
    await flush(12);
    expect(c.querySelector('.notebook-v34-page-detail')).not.toBeNull();
    expect(c.textContent).toContain('Preserve daily details');
    expect(c.querySelector('input[aria-label="Timeline Date"]')).not.toBeNull();
  });

  it('changes paired Page and Event date with both expected CAS revisions',async()=>{
    const server=mock();window.history.replaceState(null,'','/app/n/ws/notes?view=timeline');
    const c=render(<NotesTab node={owner} focused/>);await flush(15);
    click(c.querySelector('[data-event-id="ne_01"] button')!);
    await flush(12);
    const input=c.querySelector<HTMLInputElement>('input[aria-label="Timeline Date"]')!;
    setValue(input,'2026-11-12');
    input.dispatchEvent(new Event('change',{bubbles:true}));
    await flush(15);
    expect(server.posts.find(p=>p.action==='notebook-page-timeline-date-set')).toMatchObject({
      pageId:'np_01',baseRevision:3,linkedEventId:'ne_01',eventBaseRevision:2,
      timelineDate:'2026-11-12'});
  });

  it('keeps Linked Pages as a collapsed sidebar group and restores archived Sections',async()=>{
    const server=mock();window.history.replaceState(null,'','/app/n/ws/notes?view=linked');
    const c=render(<NotesTab node={owner} focused/>);await flush(16);
    expect(c.querySelector('.notebook-linked-view')).toBeNull();
    expect(c.querySelector('.notebook-v34-linked-list')).not.toBeNull();
    click(c.querySelector('button[aria-label="Section actions"]')!);
    click(Array.from(c.querySelectorAll<HTMLButtonElement>('.notebook-section-menu button'))
      .find(b=>b.textContent==='Archived Sections')!);
    await flush(12);
    expect(c.textContent).toContain('Past Reports');
    click(Array.from(c.querySelectorAll<HTMLButtonElement>('.notebook-v34-archived-sections button'))
      .find(b=>b.textContent?.includes('Past Reports'))!);
    await flush(12);
    expect(server.posts.some(p=>p.action==='notebook-section-restore'&&p.sectionId==='ns_archive')).toBe(true);
  });

  it('permanently deletes a selected non-Journal Section with two confirmations',async()=>{
    const server=mock();window.history.replaceState(null,'','/app/n/ws/notes?section=ns_report');
    vi.spyOn(window,'prompt').mockReturnValue('Work Report');
    vi.spyOn(window,'confirm').mockReturnValue(true);
    const c=render(<NotesTab node={owner} focused/>);await flush(17);
    click(c.querySelector('button[aria-label="Section actions"]')!);
    click(Array.from(c.querySelectorAll<HTMLButtonElement>('.notebook-section-menu button'))
      .find(b=>b.textContent?.includes('Delete Section Permanently'))!);
    await flush(15);
    expect(server.gets.some(g=>g.view==='notebook-delete-preview'&&
      g.params.kind==='section'&&g.params.targetId==='ns_report')).toBe(true);
    expect(server.posts.some(p=>p.action==='notebook-permanent-delete'&&p.kind==='section'&&
      p.targetId==='ns_report'&&p.confirmTitle==='Work Report'&&
      p.confirm==='DELETE PERMANENTLY')).toBe(true);
  });

  it('offers true deletion for active Pages in the Page context menu',async()=>{
    const server=mock();window.history.replaceState(null,'','/app/n/ws/notes');
    vi.spyOn(window,'prompt').mockReturnValue('Daily update');
    vi.spyOn(window,'confirm').mockReturnValue(true);
    const c=render(<NotesTab node={owner} focused/>);await flush(18);
    click(c.querySelector<HTMLButtonElement>('[aria-label="Page actions: Daily update"]')!);
    const danger=Array.from(c.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find(b=>b.textContent?.includes('Delete Page Permanently'));
    expect(danger).toBeDefined();
    click(danger!);
    await flush(12);
    expect(server.posts.find(p=>p.action==='notebook-permanent-delete')).toMatchObject({
      kind:'page',targetId:'np_01',confirmTitle:'Daily update',
    });
  });

  it('offers Event permanent deletion independently from Archive',async()=>{
    const server=mock();window.history.replaceState(null,'','/app/n/ws/notes?view=timeline&event=ne_01');
    vi.spyOn(window,'prompt').mockReturnValue('Daily update');
    vi.spyOn(window,'confirm').mockReturnValue(true);
    const c=render(<NotesTab node={owner} focused/>);await flush(18);
    const danger=c.querySelector<HTMLButtonElement>('.notebook-event-buttons .kbw-notebook-delete-danger');
    expect(danger).not.toBeNull();
    click(danger!);
    await flush(14);
    expect(server.posts.find(p=>p.action==='notebook-permanent-delete')).toMatchObject({
      kind:'event',targetId:'ne_01',confirmTitle:'Daily update',
    });
  });

  it('requires the exact typed name and never submits delete on mismatch',async()=>{
    const server=mock();window.history.replaceState(null,'','/app/n/ws/notes?section=ns_report');
    vi.spyOn(window,'prompt').mockReturnValue('Wrong name');
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
    const c=render(<NotesTab node={owner} focused/>);await flush(17);
    click(c.querySelector('button[aria-label="Section actions"]')!);
    click(Array.from(c.querySelectorAll<HTMLButtonElement>('.notebook-section-menu button'))
      .find(b=>b.textContent?.includes('Delete Section Permanently'))!);
    await flush(12);
    expect(confirm).not.toHaveBeenCalled();
    expect(server.posts.some(p=>p.action==='notebook-permanent-delete')).toBe(false);
    expect(c.textContent).toContain('Exact title did not match');
  });

  it('double-click rename on non-Journal Section preserves existing data actions',async()=>{
    const server=mock();window.history.replaceState(null,'','/app/n/ws/notes');
    vi.spyOn(window,'prompt').mockReturnValue('Work reports updated');
    const c=render(<NotesTab node={owner} focused/>);await flush(14);
    const button=Array.from(c.querySelectorAll<HTMLButtonElement>('.notebook-v34-tabs button'))
      .find(b=>b.textContent==='Work Report')!;
    button.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    await flush(10);
    expect(server.posts.find(p=>p.action==='notebook-section-rename')).toMatchObject({
      sectionId:'ns_report',title:'Work reports updated'});
  });
});
