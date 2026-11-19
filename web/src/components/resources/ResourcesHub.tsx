import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { notifyDraftChange, registerEditor } from '../../lib/draftGuard';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';
import { navigate } from '../../lib/router';
import { PromptNotebook } from './PromptNotebook';

type ResourceType = 'skill' | 'prompt' | 'mcp' | 'agent';
type View = 'skills' | 'prompts' | 'mcp' | 'agents' | 'discover' | 'studio' | 'deployments' | 'activity';
type CatalogStatus = 'all' | 'ready' | 'pending' | 'draft';
type Files = Record<string, string | { base64: string }>;
type Finding = { severity: string; rule: string; file: string };
type Resource = {
  id: string; type: ResourceType; name: string; description: string; category: string;
  visibility: string; tags: string[]; revision: number; updated: string;
  hasDraft?: boolean; latestReviewState?: string | null;
  latestVersionId?: string | null; latestVersionRisk?: string | null;
};
type Version = {
  id: string; resource_id: string; sequence: number; sha256: string; risk: string;
  review_state: string; created: string; files?: Files; findings?: Finding[];
  source?: Record<string, unknown>;
};
type Draft = { id: string; revision: number; files: Files; source: Record<string, unknown> };
type Detail = Resource & { versions: Version[]; draft: Draft | null };
type Imported = {
  type: ResourceType; files: Files; name: string; description: string;
  source: Record<string, unknown>; security: { risk: string; findings: Finding[] };
};
type Plan = {
  resourceId: string; versionId: string; agent: string; scope: string; target: string;
  existingHash: string | null; requestedHash: string; risk: string; conflict: boolean;
};
type Deployment = {
  id: string; agent: string; scope: string; target: string; version_id: string;
  resource_id: string; state: string; drifted: boolean; installed_hash: string; created: string;
};
type ProjectSkill = {
  id:string;name:string;description:string;status:string;
  layer:'local';source:'project-registry';
};
type ProjectSkillResponse = { skills:ProjectSkill[];localOnly:boolean;metadataOnly:boolean };
type CatalogSkill = {key:string;name:string;description:string;category:string;
  origin:'project'|'resource';project?:ProjectSkill;resource?:Resource};


async function request<T>(view: string, payload?: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/resources/v1' + (payload ? '' : '?view=' + encodeURIComponent(view)), payload
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, action: view }) }
    : { headers: { Accept: 'application/json' } });
  let parsed: { ok?: boolean; data?: T; code?: string } = {};
  try { parsed = await response.json() as typeof parsed; } catch { /* Never interpret HTML errors as successful JSON. */ }
  if (!response.ok || !parsed.ok) throw new Error(parsed.code || 'resource_service_unavailable');
  return parsed.data as T;
}
async function readDetail(id: string): Promise<Detail> {
  const response = await fetch('/api/resources/v1?view=detail&id=' + encodeURIComponent(id));
  const parsed = await response.json() as { ok: boolean; data?: Detail; code?: string };
  if (!response.ok || !parsed.ok || !parsed.data) throw new Error(parsed.code || 'Resource unavailable');
  return parsed.data;
}
async function readVersion(id: string): Promise<Version> {
  const response = await fetch('/api/resources/v1?view=version&id=' + encodeURIComponent(id));
  const parsed = await response.json() as { ok: boolean; data?: Version; code?: string };
  if (!response.ok || !parsed.ok || !parsed.data) throw new Error(parsed.code || 'Version unavailable');
  return parsed.data;
}
async function exportZip(versionId: string) {
  const response = await fetch('/api/resources/v1/export?versionId=' + encodeURIComponent(versionId));
  if (!response.ok) throw new Error('Export unavailable (HTTP ' + response.status + ')');
  const url = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'resource-' + versionId.slice(0, 12) + '.zip';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
const VIEWS: Array<{ id: View; title: string }> = [
  { id: 'skills', title: 'Skills' },
  { id: 'prompts', title: 'Prompts' },
  { id: 'mcp', title: 'MCP' },
  { id: 'agents', title: 'Agents' },
];
const TYPES: Array<{ type: ResourceType | 'all'; label: string }> = [
  { type: 'all', label: 'All resources' }, { type: 'skill', label: 'Skills' },
  { type: 'mcp', label: 'MCP' }, { type: 'agent', label: 'Agents' },
];
const TYPE_LABEL: Record<ResourceType, string> = {
  skill: 'Skill', prompt: 'Prompt', mcp: 'MCP Configuration', agent: 'Agent Definition',
};
const ORDER = ['Engineering', 'Productivity', 'Tooling & Misc', 'Experimental / In Progress'];
const ordered = (values: string[]) => values.sort((a, b) => {
  const i = ORDER.indexOf(a); const j = ORDER.indexOf(b);
  return (i < 0 ? 99 : i) - (j < 0 ? 99 : j) || a.localeCompare(b);
});
const filesOf = (files?: Files) => files ? Object.keys(files).sort() : [];
const asText = (value: string | { base64: string } | undefined) =>
  typeof value === 'string' ? value : value ? '[Binary attachment · original bytes preserved]' : '';
const fmt = (timestamp: string) => timestamp ? new Date(timestamp).toLocaleDateString() : '';
const stamp = (files: Files, license: string) => JSON.stringify([files, license]);
function statusOf(item: Resource): Exclude<CatalogStatus, 'all'> {
  if (item.hasDraft || (item.hasDraft === undefined && item.tags.includes('in-progress'))) return 'draft';
  if (item.latestReviewState === 'approved') return 'ready';
  if (item.latestReviewState === 'pending' || item.tags.includes('mattpocock')) return 'pending';
  return 'draft';
}
function statusLabel(item: Resource) {
  const status = statusOf(item);
  return status === 'ready' ? 'Approved' : status === 'pending' ? 'Needs approval' : 'Draft';
}
async function approve(versionId: string) {
  return request<Version>('review', {
    versionId, actor: 'local-user', decision: 'approve',
    confirmation: 'I reviewed this exact version', evidence: 'Approved directly in local AI Resources library',
  });
}
function Source({ source }: { source?: Record<string, unknown> }) {
  if (!source) return null;
  const url = typeof source.url === 'string' &&
    /^https:\/\/(github\.com|gitlab\.com)\/[a-zA-Z0-9._/-]+$/.test(source.url) ? source.url : null;
  const label = typeof source.repository === 'string' ? source.repository : 'Local source';
  const ref = typeof source.ref === 'string' ? source.ref.slice(0, 12) : '';
  const license = typeof source.license === 'string' ? source.license : '';
  return <div className="resources-source">
    <span className="resources-source-head"><Icon name="link" /> Source &amp; provenance</span>
    <span>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{label}</a> : label}
      {ref && <> <span className="resources-separator">/</span> <code>{ref}</code></>}
      {license && <> <span className="resources-separator">/</span> {license}</>}
    </span>
  </div>;
}
function Findings({ findings, risk }: { findings: Finding[]; risk?: string }) {
  return <details className="resources-checks">
    <summary><Icon name="shield-check" /> Static checks · {findings.length} finding{findings.length === 1 ? '' : 's'}
      {risk === 'high' && <span className="resources-risk">Script / elevated risk</span>}</summary>
    <div className="resources-findings">
      {findings.length === 0 ? <p>No flagged patterns. This is not a guarantee that imported instructions or code are safe.</p>
        : <ul>{findings.map((finding, index) => <li key={index}>
          <strong>{finding.severity}</strong> · {finding.rule} <code>{finding.file}</code></li>)}</ul>}
      <small>Approval only updates local library status. Nothing is executed or installed automatically.</small>
    </div>
  </details>;
}

export function ResourcesHub({ tab, id }: { tab: View; id?: string }) {
  const [items, setItems] = useState<Resource[]>([]);
  const [projectSkills, setProjectSkills] = useState<ProjectSkill[]>([]);
  const [projectSelected, setProjectSelected] = useState<string|null>(null);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<CatalogStatus>(() => {
    const value = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('status');
    return value === 'pending' || value === 'ready' || value === 'draft' ? value : 'all';
  });
  const [category, setCategory] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setError(''); setNotice(''); setBusy(true);
    try { await operation(); refresh(); } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Operation failed');
    } finally { setBusy(false); }
  }, [refresh]);
  useEffect(() => {
    let active = true;
    void Promise.all([request<Resource[]>('list'), request<ProjectSkillResponse>('project-skills')])
      .then(([library, project]) => { if (active) { setItems(library); setProjectSkills(project.skills || []); } })
      .catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [revision]);
  useEffect(() => {
    if (!id) { setSelected(null); return; }
    let active = true;
    void readDetail(id).then(found => { if (active) setSelected(found); })
      .catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [id, revision]);
  const skillItems = useMemo(() => items.filter(item => item.type === 'skill'), [items]);
  const catalog = useMemo<CatalogSkill[]>(() => [
    ...projectSkills.map(item => ({ key:'project:'+item.id,origin:'project' as const,
      name:item.name,description:item.description,category:'Project Skills',project:item })),
    ...skillItems.map(item => ({ key:'resource:'+item.id,origin:'resource' as const,
      name:item.name,description:item.description,category:item.category||'Uncategorized',resource:item })),
  ],[projectSkills,skillItems]);
  const categories = useMemo(() => ordered([...new Set(catalog.map(i => i.category))]), [catalog]);
  const filtered = useMemo(() => catalog.filter(item =>
    (item.origin === 'project' ? status === 'all' :
      status === 'all' || (item.resource && statusOf(item.resource) === status)) &&
    (category === 'all' || item.category === category) &&
    [item.name,item.description,item.category,...(item.resource?.tags||[])].join(' ')
      .toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  ), [catalog,status,category,query]);
  const groups = useMemo(() => ordered([...new Set(filtered.map(i => i.category))])
    .map(name => ({ name, entries: filtered.filter(i => i.category === name)
      .sort((a,b) => a.name.localeCompare(b.name)) })), [filtered]);
  const ready = skillItems.filter(i => statusOf(i) === 'ready').length;
  const pending = skillItems.filter(i => statusOf(i) === 'pending').length;
  const go = (next: View) => navigate('/resources/' + next);

  return <section className="page resources" aria-labelledby="resources-title">
    <div className="resources-top">
      <div className="resources-heading">
        <p className="resources-eyebrow"><Icon name="blocks" /> PERSONAL TOOLBOX <span>·</span> LOCAL LIBRARY</p>
        <h1 id="resources-title">AI Resources<span className="resources-heading-dot">.</span></h1>
        <p className="muted resources-subtitle">Collect once. Organize freely. Use with your favorite agents.</p>
      </div>
      <div className="resources-top-actions">
        <button className="btn" type="button" title="Discover and import Skills" onClick={() => go('discover')}>
          <Icon name="search" /> Discover
        </button>
        {tab === 'skills' && <>
          <button className="btn" type="button" onClick={() => go('deployments')}>
            <Icon name="download" /> Installations
          </button>
          <button className="btn btn-primary" type="button" onClick={() => go('studio')}>
            <Icon name="plus" /> New Skill
          </button>
        </>}
      </div>
    </div>
    <nav className="resources-tabs" aria-label="AI Resources sections">
      {VIEWS.map(view => <AppLink key={view.id}
        to={'/resources/' + view.id}
        className={tab === view.id ? 'resources-tab is-active' : 'resources-tab'}>{view.title}</AppLink>)}
    </nav>
    {error && <div className="error-bar" role="alert">{error} <button type="button" onClick={() => setError('')}>Dismiss</button></div>}
    {notice && <p className="resources-notice" role="status">{notice}</p>}
    {tab === 'skills' && id && selected && selected.id === id &&
      (selected.type === 'prompt' ? <PromptNotebook id={id}/> :
        selected.type === 'skill' ? <ResourceDetails item={selected} busy={busy} run={run} onNotice={setNotice} /> :
        <KindWorkspace type={selected.type === 'mcp' ? 'mcp' : 'agent'} items={items}
          selected={selected} busy={busy} run={run} onNotice={setNotice} />)}
    {tab === 'skills' && id && (!selected || selected.id !== id) && <p className="muted">Loading resource...</p>}
    {tab === 'skills' && !id && projectSelected && <ProjectSkillEditor skillId={projectSelected} back={()=>{setProjectSelected(null);refresh();}}/>}
    {tab === 'skills' && !id && !projectSelected && <div className="resources-library">
      <div className="resources-mini-overview" aria-label="Skills overview">
        <span><strong>{skillItems.length + projectSkills.length}</strong> Skills</span>
        <span><strong>{projectSkills.length}</strong> Original Project Skills</span>
        <span><strong>{ready}</strong> Approved</span>
        <button type="button" onClick={() => setStatus('pending')}>
          <strong>{pending}</strong> Awaiting approval
        </button>
      </div>
      <div className="resources-filter-shell">
        <label className="resources-search"><Icon name="search" />
          <input type="search" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search skills, descriptions, sources or tags..." aria-label="Search resources" />
          {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>×</button>}
        </label>
        <div className="resources-filterbar">
          <div className="resources-status-pills" role="group" aria-label="Approval filter">
            {([
              ['all','Everything'],['ready','Approved'],['pending','Needs approval'],['draft','Drafts'],
            ] as Array<[CatalogStatus,string]>).map(([value,label]) => <button key={value}
              type="button" aria-pressed={status === value}
              className={status === value ? 'resources-filter-pill is-active' : 'resources-filter-pill'}
              onClick={() => setStatus(value)}>{label}</button>)}
          </div>
          <select value={category} aria-label="Resource category" onChange={e => setCategory(e.target.value)}>
            <option value="all">All categories</option>
            {categories.map(name => <option key={name} value={name}>{name} ({catalog.filter(i => i.category === name).length})</option>)}
          </select>
        </div>
      </div>
      <p className="resources-summary"><strong>{filtered.length}</strong> local Skills
        <span> · Project Skills and Imported Skills are managed together · No GitLab Skill publishing</span></p>
      {filtered.length === 0 && <div className="resources-empty">
        <Icon name="folder" /><h2>{catalog.length === 0 ? 'Your Skills library is ready' : 'No matching Skills'}</h2>
        <p className="muted">Try another filter or import a Skill.</p>
        <button type="button" className="btn btn-primary" onClick={() => catalog.length ? (setStatus('all'), setCategory('all'), setQuery('')) : go('discover')}>
          {catalog.length ? 'Reset filters' : 'Discover Skills'}
        </button>
      </div>}
      {groups.map(group => <section className="resources-group" key={group.name} aria-label={group.name}>
        <div className="resources-group-head"><h2>{group.name}</h2><span>{group.entries.length} Skills</span></div>
        <div className="resources-cards">
          {group.entries.map(entry => entry.project
            ? <ProjectSkillCard key={entry.key} skill={entry.project} open={setProjectSelected}/>
            : entry.resource && <ResourceCard key={entry.key} item={entry.resource} busy={busy} onApprove={() =>
                void run(async () => {
                  if (!entry.resource?.latestVersionId) throw new Error('Open this Skill version first.');
                  await approve(entry.resource.latestVersionId);
                  setNotice(entry.resource.name + ' approved.');
                })}/>)}
        </div>
      </section>)}

    </div>}
    {tab === 'prompts' && <PromptNotebook id={id} />}
    {tab === 'mcp' && <KindWorkspace type="mcp" items={items} selected={selected?.type === 'mcp' ? selected : null}
      busy={busy} run={run} onNotice={setNotice}/>}
    {tab === 'agents' && <KindWorkspace type="agent" items={items} selected={selected?.type === 'agent' ? selected : null}
      busy={busy} run={run} onNotice={setNotice}/>}
    {tab === 'studio' && <Studio busy={busy} run={run} onCreated={item => navigate(item.type === 'prompt' ? '/resources/prompts/' + item.id : '/resources/' + item.id)} />}
    {tab === 'discover' && <Discover busy={busy} run={run} onImported={item => navigate('/resources/' + item.id)} />}
    {tab === 'deployments' && <Deployments busy={busy} run={run} revision={revision} />}
    {tab === 'activity' && <div className="resources-panel"><p>Activity logs moved to Agent Access.</p>
      <AppLink className="btn" to="/agent/access?tab=activities">Open Agent Activities</AppLink></div>}
  </section>;
}

function ResourceCard({ item, busy, onApprove }: { item: Resource; busy: boolean; onApprove: () => void }) {
  const isPrompt = item.type === 'prompt';
  const destination = isPrompt ? '/resources/prompts/' + item.id : '/resources/' + item.id;
  const status = statusOf(item);
  const source = item.tags.includes('mattpocock') ? 'mattpocock/skills' :
    item.tags.includes('github') ? 'GitHub' : 'My library';
  return <article className="resources-card">
    <div className="resources-card-head">
      <span className={'resources-glyph is-' + item.type}>
        <Icon name={item.type === 'skill' ? 'blocks' : item.type === 'prompt' ? 'file-text' :
          item.type === 'mcp' ? 'plug' : 'bot'} />
      </span>
      <span className={'resources-status-badge is-' + status}>{isPrompt ? 'Prompt note' : statusLabel(item)}</span>
    </div>
    <AppLink to={destination} className="resources-card-title">{item.name}</AppLink>
    <p className="resources-card-description">{item.description || 'A reusable resource for your AI workflows.'}</p>
    <div className="resources-card-tags">
      <span>{TYPE_LABEL[item.type]}</span><span>{source}</span>
      {item.latestVersionRisk === 'high' && <span className="is-risk">Scripts</span>}
    </div>
    <div className="resources-card-bottom">
      <AppLink to={destination} className="resources-card-detail">{isPrompt ? 'Open Notebook' : 'View details'} <Icon name="chevron-right" /></AppLink>
      {!isPrompt && status === 'pending' && item.latestVersionId && <button type="button"
        className="resources-inline-approve" disabled={busy} onClick={onApprove}>
        <Icon name="check" /> Approve
      </button>}
      {!isPrompt && status === 'ready' && item.type === 'skill' &&
        <AppLink to={'/resources/deployments?resourceId=' + encodeURIComponent(item.id)}
          className="resources-card-install"><Icon name="download" /> Install</AppLink>}
      {isPrompt ? <AppLink className="resources-card-install" to={destination}>Copy / Edit</AppLink>
        : status === 'draft' && <AppLink className="resources-card-install" to={destination}>Edit draft</AppLink>}
    </div>
  </article>;
}



type ProjectSkillFile = {path:string;sha256:string;size:number};
type ProjectSkillDetail = {id:string;name:string;description:string;status:string;
  files:ProjectSkillFile[];editable:boolean;localOnly:boolean};
type ProjectSkillText = {id:string;path:string;sha256:string;content:string};
async function projectSkillRead(id:string,path:string):Promise<ProjectSkillText>{
  const response=await fetch('/api/resources/v1?view=project-skill-file&id='+encodeURIComponent(id)+
    '&file='+encodeURIComponent(path));
  const parsed=await response.json() as {ok:boolean;data?:ProjectSkillText;code?:string};
  if(!response.ok||!parsed.ok||!parsed.data)throw new Error(parsed.code||'Unable to read local Skill');
  return parsed.data;
}
async function projectSkillDetail(id:string):Promise<ProjectSkillDetail>{
  const response=await fetch('/api/resources/v1?view=project-skill-detail&id='+encodeURIComponent(id));
  const parsed=await response.json() as {ok:boolean;data?:ProjectSkillDetail;code?:string};
  if(!response.ok||!parsed.ok||!parsed.data)throw new Error(parsed.code||'Unable to read local Skill');
  return parsed.data;
}
function ProjectSkillEditor({skillId,back}:{skillId:string;back:()=>void}){
  const [info,setInfo]=useState<ProjectSkillDetail|null>(null);
  const [file,setFile]=useState('SKILL.md');
  const [original,setOriginal]=useState('');
  const [content,setContent]=useState('');
  const [sha,setSha]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  const editorState=useRef({original:'',content:''});
  editorState.current={original,content};
  const fetchFile=useCallback(async(path:string)=>{
    const result=await projectSkillRead(skillId,path);
    setFile(path);setContent(result.content);setOriginal(result.content);setSha(result.sha256);
    notifyDraftChange();
  },[skillId]);
  useEffect(()=>{
    let active=true;
    void projectSkillDetail(skillId).then(result=>{
      if(active){setInfo(result);return fetchFile('SKILL.md');}
    }).catch(e=>{if(active)setError(String(e));});
    return()=>{active=false;};
  },[skillId,fetchFile]);
  const save=useCallback(async()=>{
    if(editorState.current.content===editorState.current.original)return true;
    setBusy(true);setError('');
    try{
      const result=await request<{sha256:string}>('project-skill-save',{
        skillId,filePath:file,content:editorState.current.content,
        expectedSha256:sha,confirmation:'Save this local Project Skill',
      });
      setOriginal(editorState.current.content);setSha(result.sha256);
      setNotice('Saved to original local Skill · Previous bytes preserved in private backup');
      setInfo(await projectSkillDetail(skillId));notifyDraftChange();
      return true;
    }catch(e){setError(e instanceof Error?e.message:String(e));return false;}
    finally{setBusy(false);}
  },[skillId,file,sha]);
  useEffect(()=>registerEditor('project-skill:'+skillId,{
    dirty:()=>editorState.current.content!==editorState.current.original,
    save,
    discard:()=>{setContent(editorState.current.original);notifyDraftChange();}
  }),[skillId,save]);
  const exit=()=>{
    if(content!==original&&!window.confirm('Discard unsaved local Skill edits?'))return;
    back();
  };
  const selectFile=(name:string)=>{
    if(name===file)return;
    if(content!==original&&!window.confirm('Discard edits before switching files?'))return;
    setError('');setNotice('');void fetchFile(name).catch(e=>setError(String(e)));
  };
  return <section className="resources-panel resources-project-editor">
    <button className="resources-back" type="button" onClick={exit}><Icon name="arrow-left"/> Back to Skills</button>
    <div className="resources-kind-head"><div><p className="resources-eyebrow">
      LOCAL PROJECT SKILL · AUTHORITATIVE SOURCE</p>
      <h2>{info?.name||skillId}</h2><p className="muted">{info?.description||'Loading original Skill...'}</p>
    </div><span className="resources-project-layer is-private"><Icon name="shield-check"/> Local only</span></div>
    <div className="resources-kind-caution">
      Editing updates the original local SKILL.md or reference file. It does not publish to GitLab,
      install a new Agent Skill, or run any code. The old file is kept in the local backup.
    </div>
    {error&&<p className="error-bar" role="alert">{error}</p>}
    {notice&&<p className="resources-notice" role="status">{notice}</p>}
    <div className="resources-filebar" aria-label="Project Skill files">
      {info?.files.map(entry=><button key={entry.path} type="button"
        className={'resources-file'+(file===entry.path?' is-active':'')}
        onClick={()=>selectFile(entry.path)}>{entry.path}</button>)}
    </div>
    <label className="resources-project-editor-label">Editing · {file}
      <textarea className="resources-code" rows={24} spellCheck={false}
        aria-label="Project Skill content" value={content}
        onChange={event=>{setContent(event.target.value);notifyDraftChange();}} />
    </label>
    <div className="resources-actions">
      <span className="muted">{content!==original?'Unsaved changes':'Saved'} · Revision SHA: {sha.slice(0,12)}</span>
      <button className="btn btn-primary" disabled={busy||content===original||!sha}
        onClick={()=>void save()}><Icon name="check"/> Save Local Skill</button>
    </div>
  </section>;
}

function ProjectSkillCard({skill,open}:{skill:ProjectSkill;open:(id:string)=>void}){
  return <article className="resources-card resources-project-card">
    <div className="resources-card-head">
      <span className="resources-glyph"><Icon name="blocks"/></span>
      <span className="resources-project-layer is-private"><Icon name="shield-check"/> Local only</span>
    </div>
    <button type="button" className="resources-card-title resources-project-name"
      onClick={()=>open(skill.id)}>{skill.name}</button>
    <p className="resources-card-description">{skill.description}</p>
    <div className="resources-card-tags"><span>Project Skill</span><span>Local source</span></div>
    <div className="resources-card-bottom">
      <span className="resources-card-detail">{skill.status}</span>
      <button type="button" className="resources-card-install" onClick={()=>open(skill.id)}>
        <Icon name="edit"/> View / Edit
      </button>
    </div>
  </article>;
}

function KindWorkspace({ type, items, selected, busy, run, onNotice }: {
  type: 'mcp'|'agent';items:Resource[];selected:Detail|null;busy:boolean;
  run:(action:()=>Promise<unknown>)=>Promise<void>;onNotice:(value:string)=>void;
}) {
  const [search,setSearch]=useState('');
  const [showNew,setShowNew]=useState(false);
  const [name,setName]=useState('');
  const [description,setDescription]=useState('');
  const [transport,setTransport]=useState<'stdio'|'http'>('stdio');
  const [connection,setConnection]=useState('');
  const [tools,setTools]=useState('');
  const [role,setRole]=useState('');
  const [instructions,setInstructions]=useState('');
  const [secretRefs,setSecretRefs]=useState('');
  const list=items.filter(item=>item.type===type &&
    [item.name,item.description,item.category,...item.tags].join(' ').toLowerCase().includes(search.toLowerCase()));
  const isMcp=type==='mcp';
  const label=isMcp?'MCP Servers':'Agent Definitions';
  const title=isMcp?'MCP Connection Library':'Agent Definition Library';
  const path='/resources/'+(isMcp?'mcp':'agents');
  const resource=selected?.type===type?selected:null;
  const names=(value:string)=>[...new Set(value.split(',').map(v=>v.trim()).filter(Boolean))].slice(0,20);
  const create=async()=>{
    const toolNames=names(tools);
    const file=isMcp?{
      'config.json':JSON.stringify({
        schemaVersion:1,transport,
        ...(transport==='stdio'?{command:connection.trim(),args:[]}:{url:connection.trim()}),
        tools:toolNames,secretRefs:names(secretRefs),
        enabled:false
      },null,2)
    }:{
      'AGENT.md':[
        '# '+name.trim(),'','## Role',role.trim()||'General assistant','','## Available tools (declared, not granted)',
        toolNames.length?toolNames.map(tool=>'- '+tool).join('\n'):'- None declared',
        '','## Instructions',instructions.trim()||'Describe the agent responsibilities.',''
      ].join('\n')
    };
    const resource=await request<Detail>('create-draft',{
      type,name:name.trim(),description,category:isMcp?'Connections':'Agent Profiles',
      tags:isMcp?['transport:'+transport]:['role:'+(role.trim()||'general')],
      files:file,source:{type:'local',license:''},
    });
    setShowNew(false);setName('');setDescription('');setTools('');setRole('');
    setConnection('');setInstructions('');setSecretRefs('');
    navigate(path+'/'+resource.id);
  };
  const acceptableConnection=transport==='stdio'?
    Boolean(connection.trim()) : /^https:\/\/[a-z0-9.-]+(?:\/|$)/i.test(connection.trim());
  return <div className="resources-kind">
    <div className="resources-kind-head">
      <div><p className="resources-eyebrow">{isMcp?'TOOL CONNECTIONS':'AGENT PROFILES'}</p>
        <h2>{title}</h2>
        <p className="muted">{isMcp
          ? 'Save server definitions, transports, declared tools and secret reference names. No connections are launched here.'
          : 'Describe reusable Agent roles, tools and instructions. A definition does not grant permissions or launch an Agent.'}
        </p></div>
      <button type="button" className="btn btn-primary" onClick={()=>{
        if(resource)navigate(path);
        setShowNew(v=>!v);
      }}><Icon name="plus"/> New {isMcp?'MCP':'Agent'}</button>
    </div>
    <div className="resources-mini-overview">
      <span><strong>{items.filter(item=>item.type===type).length}</strong> {label}</span>
      <span><strong>{items.filter(item=>item.type===type && item.hasDraft).length}</strong> Drafts</span>
      <span>Local Registry · No auto-execution</span>
    </div>
    {showNew && <div className="resources-kind-create">
      <h3>{isMcp?'Create an MCP configuration':'Create an Agent definition'}</h3>
      <div className="resources-form-grid">
        <label>Name<input aria-label={isMcp?'MCP name':'Agent name'} value={name} maxLength={120}
          onChange={event=>setName(event.target.value)} placeholder={isMcp?'e.g. knowledge-search':'e.g. Architecture Reviewer'}/></label>
        <label>Short description<input value={description} maxLength={1500}
          onChange={event=>setDescription(event.target.value)} placeholder="Where and when should this be used?"/></label>
        {isMcp ? <>
          <label>Transport<select aria-label="MCP transport" value={transport}
            onChange={event=>{setTransport(event.target.value as 'stdio'|'http');setConnection('');}}>
            <option value="stdio">Local stdio process</option><option value="http">Remote HTTP endpoint (HTTPS)</option>
          </select></label>
          <label>{transport==='stdio'?'Command (saved only)':'HTTPS Endpoint'}
            <input aria-label="MCP connection" value={connection}
              onChange={event=>setConnection(event.target.value)}
              placeholder={transport==='stdio'?'e.g. npx -y @example/server':'https://mcp.example.com/mcp'}/>
          </label>
          <label className="resources-wide">Secret reference names (not secret values)
            <input aria-label="MCP secret references" value={secretRefs}
              onChange={event=>setSecretRefs(event.target.value)} placeholder="GITHUB_TOKEN, PROVIDER_API_KEY"/>
          </label>
        </> : <>
          <label className="resources-wide">Agent role
            <input aria-label="Agent role" value={role} onChange={event=>setRole(event.target.value)}
              placeholder="e.g. Security-focused code reviewer"/>
          </label>
          <label className="resources-wide">Instructions (Markdown)
            <textarea aria-label="Agent instructions" rows={7} value={instructions}
              onChange={event=>setInstructions(event.target.value)}
              placeholder="Responsibilities, boundaries, expected output..."/>
          </label>
        </>}
        <label className="resources-wide">Declared tools (comma-separated)
          <input aria-label="Declared tools" value={tools} onChange={event=>setTools(event.target.value)}
            placeholder="search, read_files, knowledge_lookup"/>
        </label>
      </div>
      <p className="muted">{isMcp
        ? 'Only references and configuration are saved. Never paste actual API keys or passwords.'
        : 'These tools are descriptive metadata, not runtime permission grants.'}</p>
      <div className="resources-actions"><button className="btn" onClick={()=>setShowNew(false)}>Cancel</button>
        <button className="btn btn-primary" type="button" disabled={busy||!name.trim()||(isMcp&&!acceptableConnection)}
          onClick={()=>void run(create)}><Icon name="check"/> Save private draft</button></div>
    </div>}
    {resource && <>
      <div className="resources-kind-focus">
        <div className="resources-kind-identity">
          <span className={'resources-glyph is-'+type}><Icon name={isMcp?'plug':'bot'}/></span>
          <div><strong>{resource.name}</strong><p>{resource.description||'Local configuration record'}</p></div>
          <span className="resources-project-layer is-private"><Icon name="shield-check"/> Private</span>
        </div>
        <p className="resources-kind-caution">{isMcp
          ? 'Configuration only · MCP server is not running or connected. Secret values must stay in a separate local vault.'
          : 'Definition only · No Agent process, tool permission or session has been created.'}</p>
      </div>
      <ResourceDetails item={resource} busy={busy} run={run} onNotice={onNotice} backHref={path} backLabel={'Back to '+label}/>
    </>}
    {!resource && <>
      <div className="resources-kind-toolbar">
        <label className="resources-search"><Icon name="search"/>
          <input type="search" aria-label={'Search '+label} placeholder={'Search '+label.toLowerCase()+'...'}
            value={search} onChange={event=>setSearch(event.target.value)}/></label>
        <span>{list.length} saved records</span>
      </div>
      {list.length ? <div className="resources-kind-grid">
        {list.map(item=><article key={item.id} className="resources-kind-card">
          <div className="resources-kind-card-head">
            <span className={'resources-glyph is-'+type}><Icon name={isMcp?'plug':'bot'}/></span>
            <span className="resources-status-badge">{item.hasDraft?'Draft':item.latestReviewState||'Saved version'}</span>
          </div>
          <h3>{item.name}</h3>
          <p>{item.description|| (isMcp?'MCP server configuration':'Agent instructions and behavior')}</p>
          <div className="resources-kind-tags">
            {(item.tags.length?item.tags:[isMcp?'Connection':'Role']).slice(0,3).map(tag=>
              <span key={tag}>{tag}</span>)}
          </div>
          <AppLink className="resources-card-detail" to={path+'/'+item.id}>
            {isMcp?'Inspect configuration':'Open definition'} <Icon name="chevron-right"/>
          </AppLink>
        </article>)}
      </div> : <div className="resources-empty">
        <Icon name={isMcp?'plug':'bot'}/><h3>No {label.toLowerCase()} yet</h3>
        <p className="muted">{isMcp?'Collect a configuration without executing its server.'
          :'Create an Agent role without launching it.'}</p>
        <button className="btn btn-primary" onClick={()=>setShowNew(true)}><Icon name="plus"/> New {isMcp?'MCP':'Agent'}</button>
      </div>}
    </>}
  </div>;
}

function Studio({ busy, run, onCreated }: {
  busy: boolean; run: (work: () => Promise<unknown>) => Promise<void>; onCreated: (resource: Detail) => void;
}) {
  const [type, setType] = useState<ResourceType>('skill');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [license, setLicense] = useState('');
  return <div className="resources-panel resources-create">
    <p className="resources-eyebrow">RESOURCE STUDIO</p><h2>Make something reusable</h2>
    <p className="muted">Create a private draft. Save the files, create a version, then Approve beside the resource when ready.</p>
    <div className="resources-form-grid">
      <label>Resource type<select value={type} onChange={e => setType(e.target.value as ResourceType)}>
        {TYPES.filter(t => t.type !== 'all').map(t => <option key={t.type} value={t.type}>{t.label}</option>)}
      </select></label>
      <label>Name<input value={name} onChange={e => setName(e.target.value)} maxLength={120} placeholder="e.g. architecture-review" /></label>
      <label>Category<input value={category} onChange={e => setCategory(e.target.value)} maxLength={100} placeholder="Engineering" /></label>
      <label>License (optional)<select value={license} onChange={e => setLicense(e.target.value)}>
        <option value="">Private · unspecified</option>
        {['company-approved-internal','MIT','Apache-2.0','BSD-3-Clause','CC-BY-4.0'].map(value =>
          <option value={value} key={value}>{value}</option>)}
      </select></label>
      <label className="resources-wide">Description<textarea rows={3} maxLength={1500} value={description}
        onChange={e => setDescription(e.target.value)} placeholder="When should an agent use this resource?" /></label>
    </div>
    <button className="btn btn-primary" type="button" disabled={busy || !name.trim()} onClick={() =>
      void run(async () => onCreated(await request<Detail>('create-draft', {
        type, name, category, description, source: { license },
      })))}><Icon name="plus" /> Create draft</button>
  </div>;
}

function Discover({ busy, run, onImported }: {
  busy: boolean; run: (work: () => Promise<unknown>) => Promise<void>; onImported: (resource: Detail) => void;
}) {
  const [sourceType, setSourceType] = useState<'local' | 'url'>('local');
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState<Imported | null>(null);
  return <div className="resources-panel">
    <p className="resources-eyebrow">DISCOVER</p><h2>Bring in a new Skill</h2>
    <p className="muted">Import from a local WSL Skill folder or ZIP, or a public GitHub/GitLab repository.
      Imported content is untrusted and never executed. Corporate GitLab networking still requires approval.</p>
    <div className="resources-form-grid">
      <label>Source type<select value={sourceType} onChange={e => { setSourceType(e.target.value as 'local' | 'url'); setPreview(null); }}>
        <option value="local">Local folder / ZIP</option><option value="url">Public Git repository</option>
      </select></label>
      <label>Path or URL<input value={source} onChange={e => { setSource(e.target.value); setPreview(null); }}
        placeholder={sourceType === 'local' ? '/home/user/skills/my-skill' : 'https://github.com/org/repository'} /></label>
    </div>
    <button className="btn" type="button" disabled={busy || !source.trim()} onClick={() =>
      void run(async () => setPreview(await request<Imported>('import-preview', { source, sourceType })))}>
      <Icon name="eye" /> Preview &amp; scan
    </button>
    {preview && <div className="resources-inspect">
      <h3>{preview.name}</h3><p>{filesOf(preview.files).length} files · {preview.security.risk} risk</p>
      <Findings findings={preview.security.findings} risk={preview.security.risk} />
      <details><summary>Original SKILL.md</summary><pre>{asText(preview.files['SKILL.md'])}</pre></details>
      <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void run(async () =>
        onImported(await request<Detail>('create-draft', {
          type: preview.type, name: preview.name, description: preview.description,
          files: preview.files, source: preview.source,
        })))}>Save as private draft</button>
    </div>}
  </div>;
}

function ResourceDetails({ item, busy, run, onNotice, backHref='/resources/skills', backLabel='Back to Skills' }: {
  item: Detail; busy: boolean; run: (work: () => Promise<unknown>) => Promise<void>; onNotice: (value: string) => void;
  backHref?:string;backLabel?:string;
}) {
  const [files, setFiles] = useState<Files>(item.draft?.files || {});
  const [fileName, setFileName] = useState('');
  const [license, setLicense] = useState('');
  const licenseRef = useRef(license); licenseRef.current = license;
  const filesRef = useRef(files); filesRef.current = files;
  const baselineRef = useRef('');
  const [newPath, setNewPath] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [version, setVersion] = useState<Version | null>(null);
  const [inspectionError, setInspectionError] = useState('');
  useEffect(() => {
    const nextFiles = item.draft?.files || {};
    const nextLicense = typeof item.draft?.source.license === 'string' ? item.draft.source.license : '';
    setFiles(nextFiles); setLicense(nextLicense); baselineRef.current = stamp(nextFiles, nextLicense);
    setFileName(filesOf(nextFiles)[0] || '');
  }, [item.id, item.draft?.id, item.draft?.revision]);
  const versionId = selectedVersionId || item.versions[0]?.id || '';
  useEffect(() => {
    if (!versionId) { setVersion(null); return; }
    let active = true;
    void readVersion(versionId).then(result => { if (active) { setVersion(result); setInspectionError(''); } })
      .catch(cause => { if (active) setInspectionError(String(cause)); });
    return () => { active = false; };
  }, [versionId, item.versions]);
  const activeFile = fileName || filesOf(files)[0] || '';
  const dirty = stamp(files, license) !== baselineRef.current;
  const saveDraft = useCallback(async () => {
    if (!item.draft) return true;
    try {
      await request('update-draft', { resourceId: item.id, baseRevision: item.draft.revision,
        files: filesRef.current, source: { ...item.draft.source, license: licenseRef.current } });
      baselineRef.current = stamp(filesRef.current, licenseRef.current);
      return true;
    } catch { return false; }
  }, [item.id, item.draft?.id, item.draft?.revision]);
  useEffect(() => {
    if (!item.draft) return;
    return registerEditor('resource-draft:' + item.id, {
      dirty: () => stamp(filesRef.current, licenseRef.current) !== baselineRef.current,
      save: saveDraft,
      discard: () => { setFiles(item.draft?.files || {}); setLicense(
        typeof item.draft?.source.license === 'string' ? item.draft.source.license : ''); },
    });
  }, [item.id, item.draft?.id, saveDraft]);

  return <div className="resources-panel resources-detail-page">
    <AppLink to={backHref} className="resources-back"><Icon name="arrow-left" /> {backLabel}</AppLink>
    <div className="resources-detail-heading">
      <div><p className="resources-eyebrow">{TYPE_LABEL[item.type]} / {item.category || 'Uncategorized'}</p>
        <h2>{item.name}</h2><p className="muted">{item.description || 'A reusable AI resource.'}</p></div>
      <span className="resources-pill">{item.versions.length} version{item.versions.length === 1 ? '' : 's'}</span>
    </div>
    {item.draft && <>
      <Source source={item.draft.source} />
      <div className="resources-editor-head"><h3>Edit draft</h3><span>Revision {item.draft.revision}</span></div>
      <div className="resources-filebar">
        {filesOf(files).map(path => <button className={activeFile === path ? 'resources-file is-active' : 'resources-file'}
          type="button" key={path} onClick={() => setFileName(path)}>{path}</button>)}
      </div>
      <label>File: {activeFile}
        {typeof files[activeFile] === 'string' ? <textarea className="resources-code" rows={15}
          value={asText(files[activeFile])} spellCheck={false}
          onChange={e => { setFiles(current => ({ ...current, [activeFile]: e.target.value })); notifyDraftChange(); }} />
          : <pre>Binary file · original bytes preserved</pre>}
      </label>
      <div className="resources-add-file">
        <input aria-label="New file path" value={newPath} onChange={e => setNewPath(e.target.value)}
          placeholder="references/example.md" />
        <button className="btn" type="button" disabled={!newPath.trim() || newPath.trim() in files}
          onClick={() => { const path = newPath.trim(); setFiles(old => ({ ...old, [path]: '' }));
            setFileName(path); setNewPath(''); notifyDraftChange(); }}>Add file</button>
        <button className="btn" type="button" disabled={filesOf(files).length <= 1}
          onClick={() => { const next = { ...files }; delete next[activeFile]; setFiles(next);
            setFileName(filesOf(next)[0] || ''); notifyDraftChange(); }}>Remove</button>
      </div>
      <label>License (optional)<select value={license} onChange={e => { setLicense(e.target.value); notifyDraftChange(); }}>
        <option value="">Private · unspecified</option>
        {['company-approved-internal','MIT','Apache-2.0','BSD-3-Clause','CC-BY-4.0'].map(v =>
          <option value={v} key={v}>{v}</option>)}
      </select></label>
      <div className="resources-actions">
        <button className="btn" disabled={busy} onClick={() => void run(async () => {
          if (!await saveDraft()) throw new Error('Draft save failed or revision changed');
          onNotice('Draft saved');
        })}><Icon name="check" /> Save draft</button>
        <button className="btn btn-primary" disabled={busy || dirty} onClick={() => void run(async () => {
          await request('snapshot', { resourceId: item.id, baseRevision: item.draft?.revision });
          onNotice('Version created. Approve it directly below whenever you are ready.');
        })}><Icon name="git-commit" /> Create version</button>
      </div>
      <small className="muted">Save first, then create a version. Unsaved changes will never be silently published.</small>
    </>}
    {item.versions.length > 0 && <section className="resources-version-section">
      <div className="resources-editor-head"><h3>Version library</h3>
        {!item.draft && <button className="btn" disabled={busy} onClick={() => void run(async () =>
          request('start-revision', { resourceId: item.id, versionId: item.versions[0]?.id }))}>
          <Icon name="edit" /> Edit as new draft
        </button>}</div>
      <label>Selected version<select value={versionId} onChange={e => setSelectedVersionId(e.target.value)}>
        {item.versions.map(v => <option value={v.id} key={v.id}>v{v.sequence} · {v.review_state} · {fmt(v.created)}</option>)}
      </select></label>
      {inspectionError && <p role="alert">{inspectionError}</p>}
      {version && version.id === versionId && <div className="resources-version-view">
        <div className="resources-version-tools">
          <span className={'resources-status-badge is-' + (version.review_state === 'approved' ? 'ready' :
            version.review_state === 'pending' ? 'pending' : 'draft')}>{version.review_state}</span>
          <span className="resources-pill">v{version.sequence}</span>
          <button className="btn" onClick={() => void exportZip(version.id)
            .catch(cause => setInspectionError(String(cause)))}><Icon name="download" /> Export</button>
          {version.review_state === 'pending' && <button className="btn btn-primary" disabled={busy}
            onClick={() => void run(async () => {
              await approve(version.id);
              onNotice(item.name + ' v' + version.sequence + ' approved');
            })}><Icon name="check" /> Approve</button>}
          {version.review_state === 'approved' && item.type === 'skill' &&
            <AppLink className="btn btn-primary" to={'/resources/deployments?resourceId=' + item.id}>
              <Icon name="download" /> Install to agent
            </AppLink>}
        </div>
        <Source source={version.source} />
        <Findings findings={version.findings || []} risk={version.risk} />
        <div className="resources-file-reader">
          <strong>Files · {filesOf(version.files).length}</strong>
          {Object.entries(version.files || {}).map(([path, body]) => <details key={path} open={path === 'SKILL.md' ? true : undefined}>
            <summary>{path}</summary><pre>{asText(body)}</pre>
          </details>)}
        </div>
        <small className="muted">SHA-256: <code>{version.sha256}</code></small>
      </div>}
    </section>}
    {item.versions.length === 0 && !item.draft && <p className="muted">No versions yet.</p>}
  </div>;
}

function Deployments({ busy, run, revision }: {
  busy: boolean; run: (work: () => Promise<unknown>) => Promise<void>; revision: number;
}) {
  const [resources, setResources] = useState<Resource[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [history, setHistory] = useState<Deployment[]>([]);
  const [resourceId, setResourceId] = useState(() => new URLSearchParams(window.location.search).get('resourceId') || '');
  const [versionId, setVersionId] = useState('');
  const [agent, setAgent] = useState('codex');
  const [scope, setScope] = useState('project');
  const [projectRoot, setProjectRoot] = useState('');
  const [replace, setReplace] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  useEffect(() => {
    void Promise.all([request<Resource[]>('list'), request<Deployment[]>('deployments')])
      .then(([list, deployed]) => { setResources(list.filter(item => item.type === 'skill')); setHistory(deployed); });
  }, [revision]);
  useEffect(() => {
    if (!resourceId) { setVersions([]); return; }
    void readDetail(resourceId).then(item => {
      const allowed = item.versions.filter(v => v.review_state === 'approved');
      setVersions(allowed);
      setVersionId(current => allowed.some(v => v.id === current) ? current : allowed[0]?.id || '');
    }).catch(() => setVersions([]));
  }, [resourceId, revision]);
  const params = { versionId, agent, scope, projectRoot };
  const reset = () => { setPlan(null); setReplace(false); };
  return <div className="resources-panel">
    <p className="resources-eyebrow">AGENT DEPLOYMENTS</p><h2>Install your approved Skills</h2>
    <p className="muted">Choose a destination and preview the files before installing. No imported script or MCP server is executed by the Hub.</p>
    <div className="resources-form-grid">
      <label>Skill<select value={resourceId} onChange={e => { setResourceId(e.target.value); reset(); }}>
        <option value="">Select a Skill</option>
        {resources.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select></label>
      <label>Version<select value={versionId} onChange={e => { setVersionId(e.target.value); reset(); }}>
        <option value="">Select an approved version</option>
        {versions.map(v => <option key={v.id} value={v.id}>v{v.sequence} · {v.sha256.slice(0, 12)}</option>)}
      </select></label>
      <label>Agent<select value={agent} onChange={e => { setAgent(e.target.value); reset(); }}>
        {['codex', 'claude-code', 'cursor', 'opencode'].map(name => <option key={name} value={name}>{name}</option>)}
      </select></label>
      <label>Scope<select value={scope} onChange={e => { setScope(e.target.value); reset(); }}>
        <option value="project">Project</option><option value="global">Global · WSL</option>
      </select></label>
      {scope === 'project' && <label className="resources-wide">WSL project directory
        <input value={projectRoot} onChange={e => { setProjectRoot(e.target.value); reset(); }}
          placeholder="/home/user/my-project" />
      </label>}
    </div>
    <button className="btn" disabled={busy || !versionId || (scope === 'project' && !projectRoot)}
      onClick={() => void run(async () => setPlan(await request<Plan>('deployment-preview', params)))}>
      <Icon name="eye" /> Preview installation
    </button>
    {plan && <div className="resources-inspect">
      <h3>Ready to install</h3>
      <p>Destination: <code>{plan.target}</code></p>
      <p>Risk: {plan.risk} · {plan.conflict ? 'Existing files at destination' : 'No name conflict'}</p>
      {plan.conflict && <label className="resources-check"><input type="checkbox" checked={replace}
        onChange={e => setReplace(e.target.checked)} />
        Back up and replace existing files (rollback available).
      </label>}
      <button className="btn btn-primary" disabled={busy || (plan.conflict && !replace)} onClick={() => {
        if (!window.confirm('Install this approved version at ' + plan.target + '?')) return;
        void run(async () => {
          await request('deploy', { ...params, confirmation: 'Install this reviewed version',
            expectedTargetHash: plan.existingHash, onConflict: plan.conflict ? 'replace' : 'reject' });
          reset();
        });
      }}><Icon name="download" /> Install Skill</button>
    </div>}
    <h3>Installed &amp; history</h3>
    {history.length === 0 && <p className="muted">No installations tracked yet.</p>}
    <div className="resources-deploy-list">{history.map(item => <div className="resources-deployment" key={item.id}>
      <div><strong>{item.agent} · {item.scope}</strong><small>{item.target}</small>
        <small>{item.state} · {item.drifted ? 'Changed outside Hub' : 'Hash verified'}</small></div>
      <button className="btn" disabled={busy || item.state !== 'installed' || item.drifted}
        onClick={() => {
          if (!window.confirm('Roll back this installation? Changed files will not be overwritten.')) return;
          void run(async () => request('rollback', { deploymentId: item.id, confirmation: 'Rollback this deployment' }));
        }}><Icon name="history" /> Rollback</button>
    </div>)}</div>
  </div>;
}
