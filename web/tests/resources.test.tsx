import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourcesHub } from '../src/components/resources/ResourcesHub';
import { cleanup, click, flush, render } from './helpers';

const reply = (data: unknown) => Promise.resolve({
  ok: true, json: async () => ({ ok: true, data }),
} as Response);
let privateResources: Array<Record<string, unknown>> = [];
let projectSkills: Array<Record<string, unknown>> = [];
const fetchMock = vi.fn((url: string, options?: RequestInit) => {
  if (options?.method === 'POST') {
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    if (body.action === 'review') {
      privateResources = privateResources.map(row => row.latestVersionId === body.versionId
        ? { ...row, latestReviewState: 'approved' } : row);
      return reply({ review_state: 'approved' });
    }
    if (body.action === 'project-skill-save') return reply({saved:true,sha256:'b'.repeat(64)});
    if (body.action === 'create-draft') {
      const type = body.type;
      return reply({ id: 'd'.repeat(32),type,name:body.name,
        description:body.description,category:body.category, draft:{ revision:1,files:body.files },
        versions:[] });
    }
  }
  if (url.includes('view=project-skill-detail')) return reply({
    id:'work.example',name:'local-workflow',description:'Local',status:'active',
    files:[{path:'SKILL.md',sha256:'a'.repeat(64),size:70}],editable:true,localOnly:true,
  });
  if (url.includes('view=project-skill-file')) return reply({
    id:'work.example',path:'SKILL.md',sha256:'a'.repeat(64),content:'# Local Skill Instructions',
  });
  if (url.includes('view=project-skills')) return reply({
    skills: projectSkills,localOnly:true,metadataOnly:true,
  });
  if (url.includes('view=list')) return reply(privateResources);
  if (url.includes('view=deployments')) return reply([]);
  if (url.includes('view=activity')) return reply([]);
  return reply(null);
});

beforeEach(() => {
  privateResources = [];projectSkills = [];fetchMock.mockClear();vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AI Resources Hub', () => {
  it('keeps four primary type tabs and Discover action, while Activities belong to Agent Access', async () => {
    const c = render(<ResourcesHub tab="skills" />);
    expect(c.querySelector('#resources-title')?.textContent).toBe('AI Resources.');
    expect(Array.from(c.querySelectorAll('.resources-tab')).map(x => x.textContent))
      .toEqual(['Skills','Prompts','MCP','Agents']);
    const actions = Array.from(c.querySelectorAll('.resources-top-actions button'))
      .map(x => x.textContent?.trim());
    expect(actions).toContain('Discover');
    expect(actions).not.toContain('Activity');
    await flush();
    expect(c.textContent).toContain('Your Skills library is ready');
    expect(c.textContent).not.toContain('Legacy Common Skills');
  });
  it('shows editable local Project Skills without copying source files', async () => {
    projectSkills = [
      {id:'work.work-hub',name:'work-hub',description:'Generic Work Hub',
        status:'active',layer:'local',source:'project-registry'},
      {id:'work.private-example',name:'private-workflow',description:'Private initiative',
        status:'active',layer:'local',source:'project-registry'},
    ];
    const c=render(<ResourcesHub tab="skills" />);
    await flush();
    expect(c.textContent).toContain('private-workflow');
    expect(c.textContent).toContain('work-hub');
    expect(c.textContent).toContain('Local only');
    expect(c.textContent).toContain('View / Edit');
    expect(c.textContent).toContain('No GitLab Skill publishing');
    expect(c.querySelectorAll('.resources-project-card')).toHaveLength(2);
  });
  it('opens the original local Project Skill source for in-place editing', async () => {
    projectSkills=[{id:'work.example',name:'local-workflow',description:'Local',
      status:'active',layer:'local',source:'project-registry'}];
    const c=render(<ResourcesHub tab="skills" />);
    await flush();
    click(c.querySelector<HTMLButtonElement>('.resources-project-card .resources-card-install')!);
    await flush();
    expect(c.querySelector('.resources-project-editor')).not.toBeNull();
    const textarea=c.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project Skill content"]');
    expect(textarea?.value).toBe('# Local Skill Instructions');
    expect(c.textContent).toContain('Save Local Skill');
    expect(c.textContent).toContain('It does not publish to GitLab');
    expect(fetchMock.mock.calls.some(([url])=>url.includes('view=project-skill-file'))).toBe(true);
  });
  it('keeps imported Skill status filters and direct approval', async () => {
    privateResources=[
      {id:'a'.repeat(32),name:'code-review',type:'skill',category:'Engineering',description:'Review code',
        visibility:'private',tags:['mattpocock'],updated:'2026-11-18T00:00:00Z',
        revision:1,hasDraft:false,latestReviewState:'pending',
        latestVersionId:'c'.repeat(32),latestVersionRisk:'low'},
      {id:'b'.repeat(32),name:'software-factory',type:'skill',category:'Experimental / In Progress',
        description:'Experimental',visibility:'private',tags:['mattpocock'],
        updated:'2026-11-18T00:00:00Z',revision:1,hasDraft:true,latestReviewState:null},
    ];
    const c=render(<ResourcesHub tab="skills" />);
    await flush();
    const headers=Array.from(c.querySelectorAll('.resources-group-head h2')).map(x=>x.textContent);
    expect(headers).toContain('Engineering');
    expect(headers).toContain('Experimental / In Progress');
    expect(Array.from(c.querySelectorAll('.resources-status-badge')).map(x=>x.textContent?.trim()))
      .toEqual(['Needs approval','Draft']);
    click(c.querySelector<HTMLButtonElement>('.resources-inline-approve')!);
    await flush();
    expect(c.textContent).toContain('Approved');
    const call=fetchMock.mock.calls.find(([url, options])=>
      url==='/api/resources/v1' && options?.method==='POST');
    const payload=JSON.parse(String(call![1]?.body));
    expect(payload).toMatchObject({action:'review',versionId:'c'.repeat(32),decision:'approve'});
    expect(payload).not.toHaveProperty('operatorPassphrase');
  });
  it('provides MCP-specific configuration fields, not an executable connection', async () => {
    const c=render(<ResourcesHub tab="mcp" />);
    await flush();
    expect(c.textContent).toContain('MCP Connection Library');
    expect(c.textContent).toContain('No mcp servers');
    const add=Array.from(c.querySelectorAll('button')).find(x=>x.textContent?.includes('New MCP'))!;
    click(add);
    expect(c.querySelector<HTMLInputElement>('input[aria-label="MCP name"]')).not.toBeNull();
    expect(c.querySelector<HTMLInputElement>('input[aria-label="MCP secret references"]')).not.toBeNull();
    expect(c.textContent).toContain('not secret values');
    expect(c.textContent).toContain('Never paste actual API keys');
  });
  it('provides Agents as definitions without executing agents', async () => {
    const c=render(<ResourcesHub tab="agents" />);
    await flush();
    expect(c.textContent).toContain('Agent Definition Library');
    const add=Array.from(c.querySelectorAll('button')).find(x=>x.textContent?.includes('New Agent'))!;
    click(add);
    expect(c.querySelector('textarea[aria-label="Agent instructions"]')).not.toBeNull();
    expect(c.textContent).toContain('not runtime permission grants');
  });
  it('preserves legacy Studio and Discover capabilities', async () => {
    const c=render(<ResourcesHub tab="studio" />);
    expect(c.textContent).toContain('Make something reusable');
    const choice=c.querySelector<HTMLSelectElement>('select')!;
    expect(Array.from(choice.options).map(x=>x.value)).toEqual(['skill','mcp','agent']);
    await flush();
    cleanup();
    const discovered=render(<ResourcesHub tab="discover" />);
    expect(discovered.textContent).toContain('Imported content is untrusted and never executed');
    await flush();
  });
});
