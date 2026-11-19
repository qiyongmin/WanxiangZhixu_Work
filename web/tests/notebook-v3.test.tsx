import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotesTab } from '../src/components/notes/NotesTab';
import { guardNavigation, registerEditor, cancelDraftNavigation } from '../src/lib/draftGuard';
import { resetCache } from '../src/lib/queryCache';
import { dto, stubFetch, setValue } from './p2';
import { cleanup, render, flush, click } from './helpers';

const owner=dto({id:'ws',kind:'workstream',displayKind:'Workstream',depth:2});
const page={id:'np_01',owner_id:'ws',section_id:'ns_01',title:'Meeting Notes',html:'<p>Preserved</p>',
  revision:1,created_at:'2026-11-10T08:00:00Z',updated_at:'2026-11-10T08:00:00Z',
  legacy_id:'note_abcdefgh',unconfirmedWriteIds:[],links:[],position:0};
const section={id:'ns_01',owner_id:'ws',title:'Meeting Notes',role:'general',position:0,pageCount:1};
function mock(){
 return stubFetch({views:{
  'notebook-status':()=>({ready:true,version:3}),
  'notebook-sections':()=>({sections:[section],linkedPages:[]}),
  'notebook-pages':()=>({items:[{...page}],total:1,offset:0,limit:40}),
  'notebook-page':()=>({...page}),
  'notebook-event':()=>({id:'ne_01',title:'Decision Approved',kind:'decision',
    event_date:'2026-11-05',event_time:null,timezone:null,owner_id:'ws',revision:1,
    pageIds:['np_01'],taskIds:[],sourcePath:[{id:'init',title:'SAMPLE-PROJECT'}],
    linkedPages:[{id:'np_01',title:'Meeting Notes',owner_id:'ws',section_id:'ns_01'}],linkedTasks:[]}),
  'notebook-events':()=>({items:[{id:'ne_01',title:'Decision Approved',kind:'decision',
    event_date:'2026-11-05',event_time:null,timezone:null,owner_id:'ws',revision:1,
    pageIds:['np_01'],taskIds:[],sourcePath:[{id:'init',title:'SAMPLE-PROJECT'},{id:'ws',title:'REVIEW'}],
    linkedPages:[{id:'np_01',title:'Meeting Notes',owner_id:'ws',section_id:'ns_01'}],
    linkedTasks:[]}],total:1,rootId:'init',offset:0,limit:40}),
  tree:()=>({sections:[],nodes:[{id:'init',parentId:null,depth:1,title:'SAMPLE-PROJECT'},
    {id:'ws',parentId:'init',depth:2,title:'REVIEW'}]}),
 },actions:{
  'notebook-page-create':()=>({page:{...page,id:'np_new',title:'New Topic'}}),
  'notebook-quick-capture':()=>({page:{...page,id:'np_new',title:'Quick Note · Nov 14'},
    event:{id:'ne_new',kind:'journal'}}),
  'notebook-page-save':()=>({page:{...page,revision:2}}),
  'notebook-event-save':()=>({event:{id:'ne_01',title:'Decision Updated',kind:'decision',
    event_date:'2026-11-05',event_time:null,timezone:null,owner_id:'ws',revision:2,
    pageIds:['np_01'],taskIds:[],sourcePath:[{id:'init',title:'SAMPLE-PROJECT'}],
    linkedPages:[],linkedTasks:[]}}),
 }});
}
afterEach(()=>{cleanup();resetCache();vi.unstubAllGlobals();vi.restoreAllMocks();cancelDraftNavigation();
  window.history.replaceState(null,'','/app/');});
describe('Notes V3 · Notebook cutover',()=>{
 it('renders real Sections / Pages / one rich editor when migration is ready',async()=>{
  mock();window.history.replaceState(null,'','/app/n/ws/notes');
  const c=render(<NotesTab node={owner} focused/>);await flush(13);
  expect(c.querySelector('.notebook-v3')).not.toBeNull();
  expect(c.querySelector('.notebook-section-tabs')?.textContent).toContain('Meeting Notes');
  expect(c.querySelector('.notebook-page-sidebar nav button')?.textContent).toContain('Meeting Notes');
  expect(c.querySelectorAll('.note-editor')).toHaveLength(1);
  expect(c.querySelector('.notebook-editor')?.getAttribute('data-page-id')).toBe('np_01');
  expect(c.textContent).not.toContain('Save All Notes');
 });
 it('an empty Section offers a prominent Add Page in the content area, not when browsing archived or search results',async()=>{
  const server=stubFetch({views:{
    'notebook-status':()=>({ready:true,version:3}),
    'notebook-sections':()=>({sections:[{...section,pageCount:0}],linkedPages:[]}),
    'notebook-pages':()=>({items:[],total:0,offset:0,limit:40}),
    tree:()=>({nodes:[],sections:[]}),
  },actions:{
    'notebook-page-create':()=>({page:{...page,id:'np_new',title:'Started',section_id:'ns_01'}}),
  }});
  window.history.replaceState(null,'','/app/n/ws/notes?section=ns_01');
  const c=render(<NotesTab node={owner} focused/>);await flush(18);
  expect(c.querySelector('.notebook-page-empty')?.textContent).toContain('This Section has no Pages yet.');
  const add=c.querySelector<HTMLButtonElement>('button[aria-label="Add Page to empty Section"]')!;
  expect(add).not.toBeNull();
  expect(add.textContent).toContain('Add Page');
  expect(c.querySelector('button[aria-label="New Page"]')).toBeNull();
  click(c.querySelector('button[aria-label="Show archived Pages"]')!);await flush(12);
  expect(c.querySelector('button[aria-label="Add Page to empty Section"]')).toBeNull();
  expect(c.querySelector('.notebook-page-empty')?.textContent).toContain('Archived Pages');
  click(c.querySelector('button[aria-label="Show active Pages"]')!);await flush(12);
  click(c.querySelector('button[aria-label="Search Pages"]')!);await flush(2);
  setValue(c.querySelector<HTMLInputElement>('input[aria-label="Find Pages"]')!,'not found');
  await flush(12);
  expect(c.querySelector('button[aria-label="Add Page to empty Section"]')).toBeNull();
  setValue(c.querySelector<HTMLInputElement>('input[aria-label="Find Pages"]')!,'');
  await flush(12);
  vi.spyOn(window,'prompt').mockReturnValue('Started');
  click(c.querySelector('button[aria-label="Add Page to empty Section"]')!);
  await flush(12);
  expect(server.posts.some(p=>p.action==='notebook-page-create'&&p.id==='ws'&&
    p.sectionId==='ns_01'&&p.title==='Started')).toBe(true);
 });

 it('Section management lives beside Section tabs and top toolbar has no duplicate New Page',async()=>{
  mock();window.history.replaceState(null,'','/app/n/ws/notes');
  const c=render(<NotesTab node={owner} focused/>);await flush(15);
  const head=c.querySelector('.notebook-section-heading')!;
  expect(head.querySelector('.notebook-section-tabs')).not.toBeNull();
  expect(head.querySelector('button[aria-label="Add Section"]')).not.toBeNull();
  const manage=head.querySelector<HTMLButtonElement>('button[aria-label="Section actions"]')!;
  expect(manage).not.toBeNull();
  expect(manage.title).toBe('Manage current Section');
  expect(c.querySelector('.notebook-v34-topline .notebook-section-actions')).toBeNull();
  expect(c.querySelector('button[aria-label="New Page"]')).toBeNull();
  const utilities=c.querySelector('.notebook-v34-topline .notebook-top-utilities')!;
  expect(utilities.querySelector('button[aria-label="Quick Capture"]')?.textContent).toContain('Quick Capture');
  expect(utilities.querySelectorAll('button')).toHaveLength(1);
  click(manage);
  expect(head.querySelector('.notebook-section-menu')?.textContent).toContain('Rename Section');
  expect(head.querySelector('.notebook-section-menu')?.textContent).toContain('Archive Section');
 });

 it('OneNote Canvas has right-side Pages, one clean content editor and a Page actions menu',async()=>{
  const server=mock();window.history.replaceState(null,'','/app/n/ws/notes');
  const c=render(<NotesTab node={owner} focused/>);await flush(14);
  expect(c.querySelector('.notebook-onenote-canvas')).not.toBeNull();
  expect(c.querySelectorAll('.note-editor')).toHaveLength(1);
  expect(c.querySelector('.notebook-editor .note-head')).toBeNull();
  expect(c.querySelector('.notebook-editor .note-ordinal')).toBeNull();
  expect(c.querySelector('.notebook-editor .note-delete')).toBeNull();
  expect(c.querySelector('.notebook-origin')).toBeNull();
  expect(c.querySelector('.notebook-header')).toBeNull();
  expect(c.querySelectorAll('.notebook-shared-toolbar .note-toolbar')).toHaveLength(1);
  click(c.querySelector('button[aria-label="Page actions: Meeting Notes"]')!);
  expect(c.querySelector('[role="menu"][aria-label="Page actions for Meeting Notes"]')).not.toBeNull();
  expect(c.querySelector('[role="menuitem"]')?.textContent).toContain('Rename');
  expect(c.querySelector('[role="menu"]')?.textContent).toContain('Archive Page');
  click(Array.from(c.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(el=>el.textContent==='Revision History')!);
  await flush(8);
  expect(c.querySelector('.notebook-page-history')).not.toBeNull();
  expect(server.posts).toHaveLength(0);
 });
 it('Add Page is a labeled primary button and the archived icon toggles the Page query',async()=>{
  const server=mock();window.history.replaceState(null,'','/app/n/ws/notes');
  const c=render(<NotesTab node={owner} focused/>);await flush(14);
  const toolbar=c.querySelector('.notebook-page-sidebar .notebook-page-tools')!;
  const add=toolbar.querySelector<HTMLButtonElement>('button[aria-label="Add Page"]')!;
  expect(add).not.toBeNull();
  expect(add.textContent).toBe('Add Page');
  expect(add.classList.contains('notebook-add-page-primary')).toBe(true);
  expect(toolbar.querySelector('input[type="checkbox"]')).toBeNull();
  const archive=toolbar.querySelector<HTMLButtonElement>('button[aria-label="Show archived Pages"]')!;
  expect(archive).not.toBeNull();
  expect(archive.title).toBe('Show archived Pages');
  expect(archive.getAttribute('aria-pressed')).toBe('false');
  click(archive);await flush(10);
  const back=toolbar.querySelector<HTMLButtonElement>('button[aria-label="Show active Pages"]')!;
  expect(back).not.toBeNull();
  expect(back.title).toBe('Show active Pages');
  expect(back.getAttribute('aria-pressed')).toBe('true');
  expect(server.gets.some(x=>x.view==='notebook-pages'&&x.params.archived==='1')).toBe(true);
  click(back);await flush(10);
  expect(toolbar.querySelector('button[aria-label="Show archived Pages"]')).not.toBeNull();
  vi.spyOn(window,'prompt').mockReturnValue('New Topic');
  click(add);await flush(12);
  expect(server.posts.some(p=>p.action==='notebook-page-create'&&p.id==='ws'&&p.title==='New Topic')).toBe(true);
 });

 it('Page rename via the Pages menu saves the exact existing HTML with its Page Revision',async()=>{
  const server=mock();window.history.replaceState(null,'','/app/n/ws/notes');
  vi.spyOn(window,'prompt').mockReturnValue('Revised meeting title');
  const c=render(<NotesTab node={owner} focused/>);await flush(14);
  click(c.querySelector('button[aria-label="Page actions: Meeting Notes"]')!);
  click(Array.from(c.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(el=>el.textContent==='Rename Page')!);
  await flush(14);
  const saved=server.posts.find(p=>p.action==='notebook-page-save');
  expect(saved).toMatchObject({pageId:'np_01',baseRevision:1,title:'Revised meeting title',html:'<p>Preserved</p>'});
  expect(server.posts.some(p=>p.action==='notes-save')).toBe(false);
 });
 it('legacy ?note= link asks for owner-scoped legacy note ID, then renders its Page',async()=>{
  const server=mock();window.history.replaceState(null,'','/app/n/ws/notes?note=note_abcdefgh');
  const c=render(<NotesTab node={owner} focused/>);await flush(14);
  expect(c.querySelector('.notebook-editor')?.getAttribute('data-page-id')).toBe('np_01');
  expect(server.gets.some(({view,params})=>view==='notebook-page' && params.id==='ws' &&
    params.note==='note_abcdefgh')).toBe(true);
 });
 it('Timeline from an L2 Workstream remains a full-L1 query with explicit Events',async()=>{
  const server=mock();window.history.replaceState(null,'','/app/n/ws/notes?view=timeline');
  const c=render(<NotesTab node={owner} focused/>);await flush(15);
  expect(c.querySelector('.notebook-timeline')?.getAttribute('data-root-id')).toBe('init');
  expect(c.querySelector('.notebook-event-list')?.textContent).toContain('Decision Approved');
  expect(server.gets.some(({view,params})=>view==='notebook-events' && params.id==='ws' && !params.source)).toBe(true);
 });
 it('Event editor saves a standalone Event Revision without rewriting Page or Node',async()=>{
  const server=mock();window.history.replaceState(null,'','/app/n/ws/notes?view=timeline');
  const c=render(<NotesTab node={owner} focused/>);await flush(15);
  click(c.querySelector('[data-event-id="ne_01"] button')!);
  await flush(5);
  expect(c.querySelector('.notebook-event-form')).not.toBeNull();
  const title=c.querySelector<HTMLInputElement>('.notebook-event-form input[maxlength="200"]')!;
  setValue(title,'Decision Updated');
  click(Array.from(c.querySelectorAll<HTMLButtonElement>('.notebook-event-buttons button'))
    .find(b=>b.textContent?.includes('Save Event'))!);
  await flush(10);
  expect(server.posts.some(p=>p.action==='notebook-event-save' && p.eventId==='ne_01' &&
    p.baseRevision===1 && p.title==='Decision Updated')).toBe(true);
  expect(server.posts.some(p=>p.action==='notes-save'||p.action==='notebook-page-save')).toBe(false);
 });
 it('Event deep link restores an independent Event detail after refresh',async()=>{
  const stub=mock();window.history.replaceState(null,'','/app/n/ws/notes?view=timeline&event=ne_01');
  const c=render(<NotesTab node={owner} focused/>);await flush(16);
  expect(c.querySelector('[data-edit-event="ne_01"]')).not.toBeNull();
  expect(stub.gets.some(x=>x.view==='notebook-event'&&x.params.event==='ne_01')).toBe(true);
 });
 it('Quick Capture creates one Page and Event atomically through one action',async()=>{
  const server=mock();window.history.replaceState(null,'','/app/n/ws/notes');
  vi.spyOn(window,'prompt').mockReturnValue('Meeting checkpoint');
  const c=render(<NotesTab node={owner} focused/>);await flush(12);
  click(c.querySelector<HTMLButtonElement>('button[aria-label="Quick Capture"]')!);
  await flush(12);
  expect(server.posts.some(p=>p.action==='notebook-quick-capture' && p.id==='ws' &&
    p.title==='Meeting checkpoint' && /^\d{4}-\d{2}-\d{2}$/.test(String(p.eventDate)))).toBe(true);
  expect(server.posts.some(p=>p.action==='notes-save')).toBe(false);
 });
 it('dirty V3 Page blocks same-Node page and tab changes; legacy draft stays mounted across tabs',()=>{
  const unregister=registerEditor('notebook-page:np_test',{dirty:()=>true,save:async()=>true,discard:()=>{}});
  try {
   expect(guardNavigation('/app/n/ws/notes?section=s&page=p2','/app/n/ws/notes?section=s&page=p1',()=>{})).toBe(true);
   cancelDraftNavigation();
   expect(guardNavigation('/app/n/ws/materials','/app/n/ws/notes?section=s&page=p1',()=>{})).toBe(true);
  }finally{unregister();cancelDraftNavigation();}
 });
});
