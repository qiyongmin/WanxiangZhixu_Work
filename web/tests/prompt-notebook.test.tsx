import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptNotebook } from '../src/components/resources/PromptNotebook';
import { cleanup, click, flush, render } from './helpers';
import { parseRoute } from '../src/lib/router';

const rid = 'a'.repeat(32);
type Prompt = Record<string,unknown>;
const emptyDraft = { id:'b'.repeat(32), revision:1 };
const sample: Prompt = {
  id:rid,type:'prompt',name:'Coding Steering',description:'Preserve user data',
  category:'Steering & Instructions',updated:'2026-11-18T09:00:00Z',
  role:'steering',timing:'always-on',
  scenarios:['Steering & Instructions','Vibe Coding'],favorite:true,lastUsed:null,
  variables:['project_name'],preview:'Before editing {{project_name}}, validate changes.',
  bodyLength:72,versionCount:0,hasDraft:true,
};
const full = {...sample, body:'# Coding Steering\n\nBefore editing {{project_name}}, validate changes.',
  filePath:'PROMPT.md',versions:[],draft:emptyDraft};

let items: Prompt[] = [];
let flows: unknown[] = [];
const fetchMock = vi.fn(async (url:string, options?: RequestInit) => {
  if(options?.method === 'POST') {
    const body = JSON.parse(String(options.body)) as Record<string,unknown>;
    if(body.action==='prompt-create') {
      return {ok:true,json:async()=>({ok:true,data:{...full,name:body.title,body:body.content}})} as Response;
    }
    return {ok:true,json:async()=>({ok:true,data:{id:rid}})} as Response;
  }
  const view = new URL(url, 'http://localhost').searchParams.get('view');
  const data = view === 'prompt-list' ? items :
    view === 'prompt-flows' ? flows : view === 'prompt-detail' ? full : [];
  return {ok:true,json:async()=>({ok:true,data})} as Response;
});
const change = (element: HTMLInputElement|HTMLTextAreaElement, value:string) =>
  act(()=>{const setter=Object.getOwnPropertyDescriptor(element.constructor.prototype,'value')?.set;
    if(setter)setter.call(element,value);else element.value=value;
    element.dispatchEvent(new Event('input',{bubbles:true}));
    element.dispatchEvent(new Event('change',{bubbles:true}));
  });

beforeEach(()=>{
  items=[];flows=[];
  vi.stubGlobal('fetch',fetchMock);
  fetchMock.mockClear();
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

describe('Prompt Notebook V2',()=>{
  it('has stable nested prompt routes and legacy resources compatibility',()=>{
    expect(parseRoute('/resources/prompts')).toMatchObject({name:'resources',tab:'prompts'});
    expect(parseRoute('/resources/prompts/'+rid)).toMatchObject({name:'resources',tab:'prompts',id:rid});
    expect(parseRoute('/resources/'+rid)).toMatchObject({name:'resources',tab:'skills',id:rid});
  });
  it('shows scenario organization and an empty knowledge library',async()=>{
    const root = render(<PromptNotebook/>);
    await flush();
    expect(root.textContent).toContain('Prompt Notebook');
    expect(root.textContent).toContain('Steering & Instructions');
    expect(root.textContent).toContain('Vibe Coding');
    expect(root.textContent).toContain('Documentation & Presentation');
    expect(root.textContent).toContain('Research & Analysis');
    expect(root.textContent).toContain('没有符合条件的 Prompt');
  });
  it('lists prompts with role/timing and searchable text',async()=>{
    items=[sample];
    const root = render(<PromptNotebook/>);
    await flush();
    expect(root.textContent).toContain('Coding Steering');
    expect(root.textContent).toContain('Always-on');
    expect(root.textContent).toContain('Favorites');
    expect(root.querySelectorAll('.pn-list-item')).toHaveLength(1);
    const search=root.querySelector<HTMLInputElement>('input[aria-label="Search prompts"]')!;
    change(search,'not-found-term');
    await flush();
    expect(root.querySelectorAll('.pn-list-item')).toHaveLength(0);
    change(search,'Before editing');
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,340));});
    await flush();
    expect(root.querySelectorAll('.pn-list-item')).toHaveLength(1);
  });
  it('edits Markdown, detects variables, and exposes copy/use without approval',async()=>{
    items=[sample];
    const root=render(<PromptNotebook id={rid}/>);
    await flush();
    expect(root.textContent).toContain('Prompt Content');
    expect(root.textContent).toContain('Version History');
    expect(root.textContent).not.toContain('Approve version');
    const editor=root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt content"]')!;
    expect(editor.value).toContain('{{project_name}}');
    const use=Array.from(root.querySelectorAll('button')).find(b=>b.textContent?.includes('Use Prompt'))!;
    click(use);
    await flush();
    expect(root.querySelector('input[aria-label="Variable project_name"]')).not.toBeNull();
    expect(root.textContent).toContain('Generate Prompt');
    expect(root.textContent).toContain('Steering Export');
  });
  it('offers curated starter templates across scenario and timing',async()=>{
    const root=render(<PromptNotebook/>);
    await flush();
    const newPrompt=Array.from(root.querySelectorAll('button'))
      .find(b=>b.textContent?.includes('New Prompt'))!;
    click(newPrompt);
    await flush();
    const starter=Array.from(root.querySelectorAll('.pn-starter-gallery button'))
      .find(b=>b.textContent?.includes('Grill Me'))!;
    click(starter);
    const title=root.querySelector<HTMLInputElement>('input[aria-label="Prompt title"]')!;
    expect(title.value).toBe('Grill Me · Requirements');
    const content=root.querySelector<HTMLTextAreaElement>('.pn-new textarea')!;
    expect(content.value).toContain('{{requirement}}');
  });
  it('creates prompts directly as notebook pages',async()=>{
    const root=render(<PromptNotebook/>);
    await flush();
    const newButton=Array.from(root.querySelectorAll('button'))
      .find(b=>b.textContent?.includes('New Prompt'))!;
    click(newButton);
    await flush();
    expect(root.textContent).toContain('Create a reusable Prompt');
    const title=root.querySelector<HTMLInputElement>('input[aria-label="Prompt title"]')!;
    change(title,'Architecture Review');
    await flush();
    const save=Array.from(root.querySelectorAll('button'))
      .find(b=>b.textContent?.includes('Save to Notebook'))!;
    expect(save.hasAttribute('disabled')).toBe(false);
    click(save);
    await flush();
    const call=fetchMock.mock.calls.find(([url, options])=>url==='/api/resources/v1'&&
      options?.method==='POST' && JSON.parse(String(options.body)).action==='prompt-create');
    expect(call).toBeDefined();
    const requestBody=JSON.parse(String(call![1]?.body));
    expect(requestBody.type).toBeUndefined();
    expect(requestBody.title).toBe('Architecture Review');
    expect(requestBody.scenarios).toEqual(['Vibe Coding']);
  });
  it('organizes manual multi-step Prompt Flows without executing them',async()=>{
    items=[sample];
    flows=[{id:'c'.repeat(32),title:'Vibe Coding Flow',description:'Plan and review',
      scenario:'Vibe Coding',steps:[rid,rid],revision:1}];
    const root=render(<PromptNotebook/>);
    await flush();
    const open=Array.from(root.querySelectorAll('button')).find(b=>b.textContent?.includes('Prompt Flows'))!;
    click(open);
    await flush();
    expect(root.textContent).toContain('Vibe Coding Flow');
    expect(root.querySelectorAll('.pn-flow-card li')).toHaveLength(2);
    expect(root.textContent).toContain('no autonomous execution');
  });
});
