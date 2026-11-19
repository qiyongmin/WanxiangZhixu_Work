import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Icon } from '../icons';
import { navigate } from '../../lib/router';
import { notifyDraftChange, registerEditor } from '../../lib/draftGuard';

type Role = 'steering' | 'task' | 'review' | 'workflow';
type Timing = 'always-on' | 'kickoff' | 'planning' | 'execution' | 'review' | 'handoff';
type PromptItem = {
  id: string; name: string; description: string; category: string; updated: string;
  role: Role; timing: Timing; scenarios: string[]; favorite: boolean; lastUsed: string | null;
  variables: string[]; preview: string; bodyLength: number; versionCount: number;
  hasDraft: boolean;
};
type Version = { id: string; sequence: number; created: string; review_state: string };
type PromptDetail = PromptItem & {
  body: string; filePath: string; versions: Version[];
  draft: { revision: number; id: string } | null;
};
type Flow = { id: string; title: string; description: string; scenario: string; steps: string[]; revision: number };
type Form = { title: string; description: string; content: string; role: Role; timing: Timing; scenarios: string[]; favorite: boolean };
type ExportPlan = { target: string; agent: string; content: string; conflict: boolean; existingHash: string | null; existingPreview:string|null };
const ROLES: Array<[Role, string]> = [
  ['steering','Steering'],['task','Task Prompt'],['review','Review / Checker'],['workflow','Workflow'],
];
const TIMINGS: Array<[Timing, string]> = [
  ['always-on','Always-on'],['kickoff','Kickoff'],['planning','Planning'],
  ['execution','Execution'],['review','Review'],['handoff','Handoff'],
];
const SCENARIOS = [
  'Steering & Instructions','Vibe Coding','Documentation & Presentation',
  'Research & Analysis','Workflow & Agent Collaboration','General',
];
const STARTERS: Array<{name:string;role:Role;timing:Timing;scenario:string;content:string}> = [
  {name:'Project Steering',role:'steering',timing:'always-on',scenario:'Steering & Instructions',
    content:'## Project Steering\nYou are working on {{project_name}}. Before editing, inspect the existing architecture, tests and data contract.\nPreserve all current behavior unless a change is explicitly requested.\nNever overwrite user data or secrets.\nExplain the plan briefly, implement incrementally, and run relevant regression checks before reporting results.'},
  {name:'Grill Me · Requirements',role:'task',timing:'planning',scenario:'Vibe Coding',
    content:'Help clarify this requirement: {{requirement}}\nAsk only questions that materially change architecture, behavior, security or acceptance. Group independent choices into short decision rounds. Recommend one default per question. After decisions are confirmed, synthesize a testable Blueprint; do not modify code until authorized.'},
  {name:'Implementation Blueprint',role:'task',timing:'planning',scenario:'Vibe Coding',
    content:'Create an implementation Blueprint for {{goal}}. Include current-state assessment, in/out of scope, architecture, data model, migration, interfaces, security, phased rollout, tests, compatibility, rollback and explicit acceptance criteria. Do not silently remove existing features or data.'},
  {name:'Code Review · Regression',role:'review',timing:'review',scenario:'Vibe Coding',
    content:'Review the changes for {{project_name}} against {{requirements}}. Prioritize concrete correctness issues, security boundaries, data loss, backwards compatibility, missing tests and rollback behavior. Cite specific files and evidence. Separate confirmed defects from risks and suggestions.'},
  {name:'Document Restructure',role:'task',timing:'execution',scenario:'Documentation & Presentation',
    content:'Restructure the following material for {{audience}}: {{source_material}}\nPreserve every fact and essential detail. Improve hierarchy, navigability and readability. Identify uncertainties rather than inventing content. Provide a concise overview and clearly labeled sections.'},
  {name:'Research & Evidence',role:'task',timing:'planning',scenario:'Research & Analysis',
    content:'Research {{research_question}}. Separate facts, sources, assumptions and unresolved questions. Prefer primary documentation and current evidence. Compare options with tradeoffs, limitations and explicit confidence levels. End with an actionable, evidence-grounded recommendation.'},
];
function MarkdownPreview({ source }: { source: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let active = true;
    void import('markdown-it').then(({ default: MarkdownIt }) => {
      const parser = new MarkdownIt({ html: false, linkify: false, breaks: true });
      const safe = DOMPurify.sanitize(parser.render(source));
      if (active) setHtml(safe);
    });
    return () => { active = false; };
  }, [source]);
  return <article className="pn-markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}
const variablesOf = (text: string): string[] => [...new Set(Array.from(text.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g), m => m[1]).filter((v): v is string => Boolean(v)))].sort();
const formOf = (item: PromptDetail): Form => ({
  title:item.name,description:item.description,content:item.body,role:item.role,timing:item.timing,
  scenarios:[...item.scenarios],favorite:item.favorite,
});
const stamp = (form: Form) => JSON.stringify(form);
const date = (value: string | null) => value ? new Date(value).toLocaleDateString() : '—';

async function api<T>(action: string, data?: Record<string, unknown>): Promise<T> {
  const query = !data ? '?view=' + encodeURIComponent(action) : '';
  const response = await fetch('/api/resources/v1' + query,
    data ? { method: 'POST', headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({action,...data}) } : { headers: {Accept:'application/json'} });
  const json = await response.json() as {ok:boolean;data?:T;code?:string};
  if (!response.ok || !json.ok || json.data === undefined) throw new Error(json.code || 'prompt_request_failed');
  return json.data;
}
async function getPrompt(id: string): Promise<PromptDetail> {
  const response = await fetch('/api/resources/v1?view=prompt-detail&id=' + encodeURIComponent(id));
  const json = await response.json() as {ok:boolean;data?:PromptDetail;code?:string};
  if (!response.ok || !json.ok || !json.data) throw new Error(json.code || 'prompt_not_found');
  return json.data;
}
const link = (id: string) => '/resources/prompts/' + id;

export function PromptNotebook({ id }: { id?: string }) {
  const [items,setItems] = useState<PromptItem[]>([]);
  const [flows,setFlows] = useState<Flow[]>([]);
  const [selected,setSelected] = useState<PromptDetail | null>(null);
  const [scenario,setScenario] = useState('all');
  const [role,setRole] = useState('all');
  const [timing,setTiming] = useState('all');
  const [onlyFavorites,setOnlyFavorites] = useState(false);
  const [query,setQuery] = useState('');
  const [searchResults,setSearchResults] = useState<PromptItem[]|null>(null);
  const [mode,setMode] = useState<'prompts'|'flows'>('prompts');
  const [creating,setCreating] = useState(false);
  const [refreshIndex,setRefreshIndex] = useState(0);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(false);
  const refresh = useCallback(() => setRefreshIndex(n => n+1),[]);
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);setError('');setNotice('');
    try { await work();refresh(); }
    catch (exc) { setError(exc instanceof Error ? exc.message : 'Operation failed'); }
    finally { setBusy(false); }
  },[refresh]);
  useEffect(() => {
    let active=true;
    void Promise.all([api<PromptItem[]>('prompt-list'),api<Flow[]>('prompt-flows')])
      .then(([prompts,steps]) => { if(active){setItems(prompts);setFlows(steps);} })
      .catch(exc => {if(active)setError(String(exc));});
    return () => {active=false;};
  },[refreshIndex]);
  useEffect(() => {
    if (!query.trim()) {setSearchResults(null);return;}
    let active=true;
    const handle=window.setTimeout(()=>{
      const url='/api/resources/v1?view=prompt-list&q='+encodeURIComponent(query.trim());
      void fetch(url,{headers:{Accept:'application/json'}})
        .then(async response=>{
          const payload=await response.json() as {ok:boolean;data?:PromptItem[];code?:string};
          if(!response.ok||!payload.ok||!payload.data)throw new Error(payload.code||'prompt_search_failed');
          if(active)setSearchResults(payload.data);
        }).catch(exc=>{if(active)setError(String(exc));});
    },250);
    return()=>{active=false;window.clearTimeout(handle);};
  },[query,refreshIndex]);
  useEffect(() => {
    if (!id) {setSelected(null);return;}
    let active=true;
    void getPrompt(id).then(item => {if(active)setSelected(item);})
      .catch(exc => {if(active)setError(String(exc));});
    return () => {active=false;};
  },[id,refreshIndex]);
  const visibleScenarios = useMemo(() => [
    ...SCENARIOS, ...[...new Set(items.flatMap(item=>item.scenarios))]
      .filter(name=>!SCENARIOS.includes(name)).sort((a,b)=>a.localeCompare(b)),
  ],[items]);
  const filtered = useMemo(() => (query.trim() ? searchResults || [] : items).filter(item =>
    (scenario==='all' || item.scenarios.includes(scenario)) &&
    (role==='all' || item.role===role) &&
    (timing==='all' || item.timing===timing) &&
    (!onlyFavorites || item.favorite)
  ).sort((a,b) => Number(b.favorite)-Number(a.favorite) || b.updated.localeCompare(a.updated)),[
    items,searchResults,scenario,role,timing,onlyFavorites,query,
  ]);
  const current = selected?.id===id ? selected : null;
  const showDetail=Boolean(id)||creating;
  const choose = (resourceId: string) => {setCreating(false);setMode('prompts');navigate(link(resourceId));};
  const newPrompt = () => {setCreating(true);setMode('prompts');navigate('/resources/prompts');};
  const isFlows = mode==='flows';

  return <div className={'pn-root'+(showDetail?' pn-selected':'')}>
    <div className="pn-header">
      <div>
        <p className="resources-eyebrow"><Icon name="file-text"/> PERSONAL KNOWLEDGE LIBRARY</p>
        <h2>Prompt Notebook</h2>
        <p className="muted">Organize ideas by scenario, role and timing. Write once, reuse anywhere.</p>
      </div>
      <div className="pn-top-actions">
        <button className="btn" onClick={() => {setMode(isFlows?'prompts':'flows');setCreating(false);}}>
          <Icon name="repeat" /> {isFlows?'Back to Prompts':'Prompt Flows'}
        </button>
        <button className="btn btn-primary" onClick={newPrompt}><Icon name="plus"/> New Prompt</button>
      </div>
    </div>
    {error && <div className="error-bar" role="alert">{error}
      <button onClick={() => setError('')}>Dismiss</button></div>}
    {notice && <p className="resources-notice" role="status">{notice}</p>}
    {isFlows ? <FlowWorkspace flows={flows} prompts={items} busy={busy} run={run} openPrompt={choose}/> :
      <div className="pn-workspace">
        <aside className="pn-folders" aria-label="Prompt scenario navigation">
          <div className="pn-sidebar-title">COLLECTIONS</div>
          <button className={scenario==='all' && !onlyFavorites?'is-selected':''} onClick={() => {setScenario('all');setOnlyFavorites(false);}}>
            <Icon name="layers"/><span>All Prompts</span><small>{items.length}</small></button>
          <button className={onlyFavorites?'is-selected':''} onClick={() => {setScenario('all');setOnlyFavorites(true);}}>
            <Icon name="star"/><span>Favorites</span><small>{items.filter(p=>p.favorite).length}</small></button>
          <div className="pn-sidebar-title pn-spaced">BY SCENARIO</div>
          {visibleScenarios.map(name => <button key={name} className={scenario===name&&!onlyFavorites?'is-selected':''}
            onClick={() => {setScenario(name);setOnlyFavorites(false);}}>
            <Icon name={name.startsWith('Steering')?'compass':name.startsWith('Vibe')?'code':
              name.startsWith('Documentation')?'file-text':name.startsWith('Research')?'search':
              name.startsWith('Workflow')?'repeat':'folder'}/>
            <span>{name}</span><small>{items.filter(i=>i.scenarios.includes(name)).length}</small>
          </button>)}
          <div className="pn-sidebar-note">一份 Prompt 可属于多个场景，Role 与 Timing 可以交叉筛选。</div>
        </aside>
        <div className="pn-list-pane">
          <div className="pn-list-title"><strong>Prompts <span>{filtered.length}</span></strong>
            <button className="pn-icon-button" aria-label="New Prompt" title="New Prompt" onClick={newPrompt}>
              <Icon name="plus"/></button></div>
          <label className="pn-search"><Icon name="search"/>
            <input type="search" aria-label="Search prompts" placeholder="Search titles and content..."
              value={query} onChange={e=>setQuery(e.target.value)}/></label>
          <div className="pn-list-filters">
            <select aria-label="Prompt role" value={role} onChange={e=>setRole(e.target.value)}>
              <option value="all">All roles</option>
              {ROLES.map(([v,label])=><option value={v} key={v}>{label}</option>)}
            </select>
            <select aria-label="Prompt timing" value={timing} onChange={e=>setTiming(e.target.value)}>
              <option value="all">Any time</option>
              {TIMINGS.map(([v,label])=><option value={v} key={v}>{label}</option>)}
            </select>
          </div>
          <div className="pn-list-scroll">
            {filtered.map(item=><button key={item.id} className={'pn-list-item'+(item.id===id?' is-current':'')}
              onClick={() => choose(item.id)}>
              <span className="pn-item-title"><strong>{item.name}</strong>{item.favorite&&<Icon name="star"/>}</span>
              <span className="pn-item-preview">{item.preview.replace(/[#*\n]/g,' ').slice(0,115)||item.description||'Empty prompt'}</span>
              <span className="pn-item-foot"><em>{ROLES.find(([r])=>r===item.role)?.[1]}</em>
                <span>{TIMINGS.find(([t])=>t===item.timing)?.[1]}</span></span>
            </button>)}
            {!filtered.length && <div className="pn-list-empty">没有符合条件的 Prompt。<button onClick={newPrompt}>新建一个</button></div>}
          </div>
        </div>
        <section className="pn-editor-pane">
          {showDetail && <button className="pn-back" onClick={() => {setCreating(false);navigate('/resources/prompts');}}>
            <Icon name="arrow-left"/> Back to Prompts
          </button>}
          {creating && !id ? <NewPrompt key="new" busy={busy} run={run} created={item=>{setCreating(false);choose(item.id);}}/> :
            current ? <PromptEditor key={current.id} item={current} busy={busy} run={run}
              saved={()=>refresh()} notice={setNotice}/> :
            <div className="pn-empty-detail"><Icon name="file-text" size={32}/>
              <h3>{id ? 'Loading Prompt…' : '你的 Prompt 知识库'}</h3>
              <p>选择左侧 Prompt 查看、编辑或复制。也可以创建新模板，将好用的指令保存下来。</p>
              {!id&&<button className="btn btn-primary" onClick={newPrompt}><Icon name="plus"/> Create Prompt</button>}
            </div>}
        </section>
      </div>}
  </div>;
}

function NewPrompt({busy,run,created}:{
  busy:boolean;run:(work:()=>Promise<unknown>)=>Promise<void>;created:(item:PromptDetail)=>void;
}) {
  const [title,setTitle]=useState('');
  const [scenario,setScenario]=useState('Vibe Coding');
  const [role,setRole]=useState<Role>('task');
  const [timing,setTiming]=useState<Timing>('execution');
  const [content,setContent]=useState('');
  const latest=useRef({title,scenario,role,timing,content});
  latest.current={title,scenario,role,timing,content};
  const committed=useRef(false);
  const submitting=useRef<Promise<boolean>|null>(null);
  const submit=useCallback(async()=>{
    if (committed.current) return true;
    if (submitting.current) return submitting.current;
    const form=latest.current;
    if (!form.title.trim()) return false;
    const task=(async()=>{
      try{
        const item=await api<PromptDetail>('prompt-create',{
          title:form.title,content:form.content,role:form.role,timing:form.timing,
          scenarios:[form.scenario],
        });
        committed.current=true;
        created(item);
        return true;
      }catch{return false;}
      finally{submitting.current=null;}
    })();
    submitting.current=task;
    return task;
  },[created]);
  useEffect(()=>registerEditor('prompt-new',{
    dirty:()=>!committed.current&&Boolean(latest.current.title.trim()||latest.current.content.trim()),
    save:submit,
    discard:()=>{committed.current=true;},
  }),[submit]);
  return <div className="pn-new">
    <span className="pn-kicker">NEW PAGE</span>
    <h3>Create a reusable Prompt</h3>
    <div className="pn-starter-gallery"><span>Start from a template (optional)</span>
      <div>{STARTERS.map(starter=><button type="button" key={starter.name}
        onClick={()=>{setTitle(starter.name);setScenario(starter.scenario);setRole(starter.role);
          setTiming(starter.timing);setContent(starter.content);}}>
        <Icon name="file-text"/>{starter.name}
      </button>)}</div>
    </div>
    <label>Title<input aria-label="Prompt title" value={title} onChange={e=>setTitle(e.target.value)}
      placeholder="e.g. Architecture Review"/></label>
    <div className="pn-meta-grid">
      <label>Scenario<select value={scenario} onChange={e=>setScenario(e.target.value)}>
        {SCENARIOS.map(s=><option key={s}>{s}</option>)}</select></label>
      <label>Role<select value={role} onChange={e=>setRole(e.target.value as Role)}>
        {ROLES.map(([r,name])=><option key={r} value={r}>{name}</option>)}</select></label>
      <label>Timing<select value={timing} onChange={e=>setTiming(e.target.value as Timing)}>
        {TIMINGS.map(([t,name])=><option key={t} value={t}>{name}</option>)}</select></label>
    </div>
    <label>Prompt content (Markdown)<textarea rows={12} value={content} onChange={e=>setContent(e.target.value)}
      placeholder={'Describe what the AI should do…\nUse {{project_name}} for reusable variables.'}/></label>
    <button className="btn btn-primary" disabled={!title.trim()||busy} onClick={()=>void run(async()=>{
      if(!await submit())throw new Error('Unable to create Prompt. Check the title and try again.');
    })}><Icon name="plus"/> Save to Notebook</button>
  </div>;
}

function PromptEditor({item,busy,run,saved,notice}:{
  item:PromptDetail;busy:boolean;run:(work:()=>Promise<unknown>)=>Promise<void>;
  saved:()=>void;notice:(message:string)=>void;
}) {
  const [form,setForm]=useState<Form>(()=>formOf(item));
  const [revision,setRevision]=useState(item.draft?.revision||0);
  const revisionRef=useRef(revision);revisionRef.current=revision;
  const formRef=useRef(form);formRef.current=form;
  const savedRef=useRef(stamp(formOf(item)));
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [view,setView]=useState<'edit'|'preview'>('edit');
  const [usage,setUsage]=useState(false);
  const [values,setValues]=useState<Record<string,string>>({});
  const [rendered,setRendered]=useState('');
  const [copied,setCopied]=useState(false);
  const [exportOpen,setExportOpen]=useState(false);
  const [historyOpen,setHistoryOpen]=useState(false);
  const [startEditing,setStartEditing]=useState(Boolean(item.draft));
  const busySave=useRef<Promise<boolean>|null>(null);
  const isDirty=stamp(form)!==savedRef.current;
  const vars=variablesOf(form.content);
  const update=(patch:Partial<Form>)=>{setForm(old=>({...old,...patch}));notifyDraftChange();setRendered('');setCopied(false);};
  const save=useCallback(async()=>{
    if (!item.draft) return true;
    if (busySave.current) return busySave.current;
    if (stamp(formRef.current)===savedRef.current) return true;
    const snapshot={...formRef.current,scenarios:[...formRef.current.scenarios]};
    const signature=stamp(snapshot);
    const expected=revisionRef.current;
    const work=(async()=>{
      setSaving(true);
      try{
        const result=await api<PromptDetail>('prompt-save',{
          resourceId:item.id,baseRevision:expected,title:snapshot.title,description:snapshot.description,
          content:snapshot.content,role:snapshot.role,timing:snapshot.timing,
          scenarios:snapshot.scenarios,favorite:snapshot.favorite,
        });
        const next=result.draft?.revision;
        if(next){revisionRef.current=next;setRevision(next);}
        savedRef.current=signature;
        setError('');
        notifyDraftChange();
        return true;
      }catch(exc){setError(exc instanceof Error?exc.message:'Save failed');return false;}
      finally{setSaving(false);busySave.current=null;}
    })();
    busySave.current=work;
    return work;
  },[item.id,item.draft?.id]);
  useEffect(()=>{
    if(!item.draft)return;
    return registerEditor('prompt-notebook:'+item.id,{
      dirty:()=>stamp(formRef.current)!==savedRef.current,
      save,
      discard:()=>{setForm(formOf(item));savedRef.current=stamp(formOf(item));notifyDraftChange();},
    });
  },[item.id,item.draft?.id,save]);
  // Debounced incremental saves; revision checks prevent silent concurrent overwrite.
  useEffect(()=>{
    if(!item.draft||!isDirty||saving)return;
    const handle=window.setTimeout(()=>{void save();},1400);
    return()=>window.clearTimeout(handle);
  },[isDirty,form,revision,saving,item.draft?.id,save]);
  const favorite=async()=>{
    if(item.draft && stamp(formRef.current)!==savedRef.current && !await save()) {
      setError('Save the current draft before changing favorite');return;
    }
    const next=!form.favorite;
    await api('prompt-favorite',{resourceId:item.id,favorite:next});
    setForm(prev=>({...prev,favorite:next}));
    const baseline=JSON.parse(savedRef.current) as Form;
    savedRef.current=stamp({...baseline,favorite:next});
    notifyDraftChange();
    saved();
  };
  const markCopy=async(text:string)=>{
    try{
      await navigator.clipboard.writeText(text);
      await api('prompt-used',{resourceId:item.id});
      setCopied(true); saved();
    }catch{setRendered(text);setUsage(true);setError('Clipboard permission unavailable. Select and copy the text below.');}
  };
  const openUsage=()=>{setUsage(true);setRendered('');setCopied(false);};
  const submitVariables=()=>{setError('');setRendered(form.content.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
    (_,name:string)=>values[name]??''));};
  const snapshot=()=>void run(async()=>{
    if(!item.draft)return;
    for(let retry=0;retry<3 && stamp(formRef.current)!==savedRef.current;retry++) {
      if(!await save())throw new Error('Cannot create version until draft is saved');
    }
    if(stamp(formRef.current)!==savedRef.current)throw new Error('Draft changed during save. Try again.');
    const result=await api<{versionId:string}>('snapshot',{
      resourceId:item.id,baseRevision:revisionRef.current,
    });
    notice('Saved immutable version '+result.versionId.slice(0,8));
    saved();
  });
  const revisionCreate=()=>void run(async()=>{
    const result=await api<PromptDetail>('prompt-revision',{resourceId:item.id});
    setRevision(result.draft?.revision||1);
    setStartEditing(true);saved();
  });
  const header=<div className="pn-editor-head">
    <div className="pn-editor-title"><span className="pn-kicker">PROMPT PAGE</span>
      <h3>{form.title}</h3>
      <p>{form.description||'Prompt template · Markdown / Plain Text'}</p></div>
    <div className="pn-editor-buttons">
      <button className={'pn-icon-button'+(form.favorite?' is-starred':'')} title={form.favorite?'Unfavorite':'Favorite'}
        aria-label={form.favorite?'Unfavorite Prompt':'Favorite Prompt'} onClick={()=>void favorite()}>
        <Icon name="star"/></button>
      <button className="btn" onClick={()=>void markCopy(form.content)}><Icon name="copy"/> Copy</button>
      <button className="btn btn-primary" onClick={openUsage}><Icon name="play"/> Use Prompt</button>
    </div>
  </div>;
  return <div className="pn-editor">
    {header}
    <div className="pn-inline-info">
      <span>{form.scenarios.join(' · ')}</span><span>{ROLES.find(([r])=>r===form.role)?.[1]}</span>
      <span>{TIMINGS.find(([t])=>t===form.timing)?.[1]}</span>
      <small>{saving?'Saving…':isDirty?'Unsaved changes':'Saved'}</small>
    </div>
    {error&&<p className="error-bar" role="alert">{error}</p>}
    {copied&&<p className="resources-notice" role="status">Copied to clipboard</p>}
    {item.draft&&startEditing?<div className="pn-edit-fields">
      <label>Title<input value={form.title} onChange={e=>update({title:e.target.value})} aria-label="Prompt title"/></label>
      <label>Use case / Description<input value={form.description}
        onChange={e=>update({description:e.target.value})} aria-label="Prompt description"/></label>
      <div className="pn-meta-grid">
        <label>Role<select aria-label="Prompt role" value={form.role}
          onChange={e=>update({role:e.target.value as Role})}>
          {ROLES.map(([r,label])=><option key={r} value={r}>{label}</option>)}</select></label>
        <label>Timing<select aria-label="Prompt timing" value={form.timing}
          onChange={e=>update({timing:e.target.value as Timing})}>
          {TIMINGS.map(([t,label])=><option key={t} value={t}>{label}</option>)}</select></label>
      </div>
      <fieldset className="pn-scenarios"><legend>Scenarios · Multiple allowed</legend>
        {SCENARIOS.map(name=><label key={name}><input type="checkbox" checked={form.scenarios.includes(name)}
          onChange={e=>{const next=e.target.checked?[...form.scenarios,name]:form.scenarios.filter(x=>x!==name);
            if(next.length)update({scenarios:next});}}/>{name}</label>)}
      </fieldset>
      <div className="pn-editor-bar"><strong>Prompt Content</strong><div>
        <button className={view==='edit'?'is-active':''} onClick={()=>setView('edit')}>Edit</button>
        <button className={view==='preview'?'is-active':''} onClick={()=>setView('preview')}>Preview</button>
      </div></div>
      {view==='edit'?<textarea className="pn-markdown-editor" spellCheck={false}
        aria-label="Prompt content" rows={16} value={form.content} onChange={e=>update({content:e.target.value})}/>:
        <MarkdownPreview source={form.content}/>}
      <div className="pn-save-row">
        <span>Variables: {vars.length?vars.map(v=>'{{'+v+'}}').join(', '):'None'}</span>
        <button className="btn" disabled={saving||busy||!isDirty} onClick={()=>void save()}>
          <Icon name="check"/>{saving?'Saving…':'Save Now'}</button>
        <button className="btn" disabled={saving||busy||!form.title.trim()} onClick={snapshot}>
          <Icon name="history"/> Save Version</button>
      </div>
    </div>:<div className="pn-edit-fields">
      <div className="pn-readonly-tip">This page has no active draft. Immutable versions are kept for reference.</div>
      <MarkdownPreview source={form.content}/>
      <button className="btn" onClick={revisionCreate}><Icon name="edit"/> Edit as new draft</button>
    </div>}
    {usage&&<div className="pn-usage" role="region" aria-label="Use Prompt">
      <div className="pn-usage-title"><strong>Use this Prompt</strong>
        <button className="pn-icon-button" onClick={()=>setUsage(false)} aria-label="Close Use Prompt"><Icon name="close"/></button></div>
      {vars.length?<><p>Fill in the template variables before copying.</p>
        <div className="pn-variable-grid">{vars.filter((v):v is string=>Boolean(v)).map(name=><label key={name}>{'{{'+name+'}}'}
          <input value={values[name]||''} onChange={e=>{setValues(prev=>({...prev,[name]:e.target.value}));setRendered('');}}
            aria-label={'Variable '+name}/></label>)}</div>
        <button className="btn" disabled={vars.some(v=>!values[v]?.trim())} onClick={submitVariables}>
          Generate Prompt</button></>:<p>No variables in this Prompt. Copy the original text as-is.</p>}
      {(rendered||!vars.length)&&<><textarea readOnly value={rendered||form.content} aria-label="Rendered Prompt"
        rows={7} onFocus={e=>e.target.select()}/>
        <button className="btn btn-primary" onClick={()=>void markCopy(rendered||form.content)}>
          <Icon name="copy"/> Copy Final Prompt</button></>}
    </div>}
    <div className="pn-lower-tools">
      <button onClick={()=>setHistoryOpen(o=>!o)}><Icon name="history"/> Version History ({item.versions.length})</button>
      {form.role==='steering'&&<button onClick={()=>setExportOpen(o=>!o)}><Icon name="download"/> Steering Export</button>}
    </div>
    {historyOpen&&<div className="pn-history">{item.versions.length?item.versions.map(v=><div key={v.id}>
      <span>v{v.sequence} · {date(v.created)} · {v.review_state}</span>
      <button onClick={()=>void run(async()=>{
        const draft=await api<PromptDetail>('prompt-revision',{
          resourceId:item.id,versionId:v.id,
        });
        setStartEditing(true);setForm(formOf(draft));saved();
      })} disabled={Boolean(item.draft)}>Restore as draft</button></div>):<p>No snapshots. Use Save Version to create one.</p>}</div>}
    {exportOpen&&form.role==='steering'&&<SteeringExport item={item} busy={busy} run={run} />}
    <div className="pn-footer"><small>Local-only · {item.versionCount??item.versions.length} saved versions · Last used {date(item.lastUsed)}</small></div>
  </div>;
}

function SteeringExport({item,busy,run}:{item:PromptDetail;busy:boolean;run:(f:()=>Promise<unknown>)=>Promise<void>}) {
  const [agent,setAgent]=useState('codex');
  const [root,setRoot]=useState('');
  const [plan,setPlan]=useState<ExportPlan|null>(null);
  const [replace,setReplace]=useState(false);
  const [result,setResult]=useState('');
  return <section className="pn-steering">
    <h4>Steering Export</h4><p>Export to an existing WSL project only. Inspect the target before replacing existing instructions.</p>
    <div className="pn-meta-grid"><label>Agent<select value={agent} onChange={e=>{setAgent(e.target.value);setPlan(null);}}>
      <option value="codex">Codex → AGENTS.md</option>
      <option value="claude-code">Claude Code → CLAUDE.md</option></select></label>
      <label>Project Root<input value={root} placeholder="/home/user/project" aria-label="Steering project root"
        onChange={e=>{setRoot(e.target.value);setPlan(null);}}/></label></div>
    <button className="btn" disabled={!root||busy} onClick={()=>void run(async()=>{
      setPlan(await api<ExportPlan>('prompt-steering-preview',{
        resourceId:item.id,agent,projectRoot:root,
      }));
    })}><Icon name="eye"/> Preview Target</button>
    {plan&&<div className="pn-export-plan"><code>{plan.target}</code>
      <span>{plan.conflict?'Existing instructions found · inspect before replacing':'New file'}</span>
      <details><summary>New instructions preview</summary><pre>{plan.content}</pre></details>
      {plan.conflict&&<details><summary>Current instructions preview (first 4,000 characters)</summary>
        <pre>{plan.existingPreview}</pre></details>}
      {plan.conflict&&<label><input type="checkbox" checked={replace}
        onChange={e=>setReplace(e.target.checked)}/> Back up and replace existing instructions</label>}
      <button className="btn btn-primary" disabled={busy||(plan.conflict&&!replace)}
        onClick={()=>{if(!window.confirm('Export this Steering Prompt to '+plan.target+'?'))return;
          void run(async()=>{
            const res=await api<{target:string}>('prompt-steering-export',{
              resourceId:item.id,agent,projectRoot:root,
              expectedTargetHash:plan.existingHash,onConflict:replace?'replace':'reject',
              confirmation:'Export this steering prompt',
            });setResult('Exported to '+res.target);setPlan(null);
          });}}><Icon name="download"/> Export</button></div>}
    {result&&<p role="status">{result}</p>}
  </section>;
}

function FlowWorkspace({flows,prompts,busy,run,openPrompt}:{
  flows:Flow[];prompts:PromptItem[];busy:boolean;run:(f:()=>Promise<unknown>)=>Promise<void>;
  openPrompt:(id:string)=>void;
}) {
  const [creating,setCreating]=useState(false);
  const [edit,setEdit]=useState<Flow|null>(null);
  const [title,setTitle]=useState('');
  const [description,setDescription]=useState('');
  const [scenario,setScenario]=useState('Vibe Coding');
  const [steps,setSteps]=useState<string[]>([]);
  const begin=(flow?:Flow)=>{setEdit(flow||null);setCreating(true);setTitle(flow?.title||'');
    setDescription(flow?.description||'');setScenario(flow?.scenario||'Vibe Coding');setSteps([...(flow?.steps||[])]);};
  return <div className="pn-flows">
    <div className="pn-flow-header"><div><span className="pn-kicker">REUSABLE WORKFLOWS</span>
      <h3>Prompt Flows</h3><p>Connect prompts in order. Run each step manually—no autonomous execution.</p></div>
      <button className="btn btn-primary" onClick={()=>begin()}><Icon name="plus"/> New Flow</button></div>
    {creating&&<section className="pn-flow-form">
      <label>Flow title<input value={title} onChange={e=>setTitle(e.target.value)} placeholder="e.g. Vibe Coding"/></label>
      <label>Description<input value={description} onChange={e=>setDescription(e.target.value)}/></label>
      <label>Scenario<select value={scenario} onChange={e=>setScenario(e.target.value)}>
        {SCENARIOS.map(c=><option key={c}>{c}</option>)}</select></label>
      <div className="pn-flow-form-steps"><strong>Ordered Steps</strong>
        {steps.map((step,index)=><div key={index}>
          <span>{index+1}</span><select aria-label={'Flow step '+(index+1)} value={step}
            onChange={e=>setSteps(old=>old.map((p,i)=>i===index?e.target.value:p))}>
            {prompts.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button className="pn-icon-button" title="Move up" disabled={index===0} onClick={()=>setSteps(old=>{
            const next=[...old];const current=next[index];const other=next[index-1];if(current&&other){next[index-1]=current;next[index]=other;}return next;})}>↑</button>
          <button className="pn-icon-button" title="Move down" disabled={index===steps.length-1} onClick={()=>setSteps(old=>{
            const next=[...old];const current=next[index];const other=next[index+1];if(current&&other){next[index+1]=current;next[index]=other;}return next;})}>↓</button>
          <button className="pn-icon-button" title="Remove step" onClick={()=>setSteps(old=>old.filter((_,i)=>i!==index))}>×</button>
        </div>)}
        <button className="btn" disabled={!prompts.length||steps.length>=24} onClick={()=>
          setSteps(old=>prompts[0]?[...old,prompts[0].id]:old)}><Icon name="plus"/> Add Step</button>
      </div>
      <div className="pn-flow-form-actions"><button className="btn" onClick={()=>setCreating(false)}>Cancel</button>
        <button className="btn btn-primary" disabled={!title.trim()||!steps.length||busy}
          onClick={()=>void run(async()=>{
            await api('prompt-flow-save',{title,description,scenario,steps,
              ...(edit?{flowId:edit.id,baseRevision:edit.revision}:{})});setCreating(false);
          })}><Icon name="check"/> Save Flow</button></div>
    </section>}
    <div className="pn-flow-grid">{flows.map(flow=><article className="pn-flow-card" key={flow.id}>
      <div><h4>{flow.title}</h4><p>{flow.description||flow.scenario}</p><small>{flow.steps.length} steps · Revision {flow.revision}</small></div>
      <ol>{flow.steps.map((step,index)=><li key={index}><button onClick={()=>openPrompt(step)}>
        <span>{index+1}</span><strong>{prompts.find(p=>p.id===step)?.name||'Unavailable Prompt'}</strong>
        <Icon name="chevron-right"/></button></li>)}</ol>
      <button className="btn" onClick={()=>begin(flow)}><Icon name="edit"/> Edit Flow</button>
    </article>)}
    {!flows.length&&<div className="pn-flow-empty">还没有 Prompt Flow。创建一个，把需求澄清、Blueprint、实施和复盘串联起来。</div>}
    </div>
  </div>;
}
