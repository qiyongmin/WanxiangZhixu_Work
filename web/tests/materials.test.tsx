import { useState, act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaterialsTab, materialGroups } from '../src/components/materials/MaterialsTab';
import { PreviewDrawer, type PreviewTarget } from '../src/components/preview/PreviewDrawer';
import { closeTopOverlay } from '../src/lib/keyboard';
import { previewKind } from '../src/lib/preview';
import type { MaterialItem, MaterialsView } from '../src/lib/types';
import { click, flush, focus, jsonResponse, render } from './helpers';
import { byText, dto, fail, ok, stubFetch } from './p2';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const FILE = 'file_' + 'a'.repeat(32);

function material(extra: Partial<MaterialItem> = {}): MaterialItem {
  return {
    id: 'mat-1',
    title: '设计.md',
    materialType: 'file',
    url: null,
    fileId: FILE,
    missing: false,
    format: null,
    origin: null,
    unconfirmed: null,
    name: '设计.md',
    size: 10,
    ...extra,
  };
}

function Harness({ target }: { target: PreviewTarget }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" id="opener" onClick={() => setOpen(true)}>
        打开
      </button>
      {open ? <PreviewDrawer target={target} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function openDrawer(target: PreviewTarget): HTMLElement {
  const c = render(<Harness target={target} />);
  const opener = c.querySelector<HTMLButtonElement>('#opener')!;
  focus(opener);
  click(opener);
  return c;
}

const file = (name: string, extra: Partial<Extract<PreviewTarget, { kind: 'file' }>> = {}): PreviewTarget => ({
  kind: 'file',
  fileId: FILE,
  name,
  size: 100,
  ...extra,
});

describe('previewKind', () => {
  it('按扩展名分类；超过 10 MB 或未知格式为 other', () => {
    expect(previewKind('a.md')).toBe('markdown');
    expect(previewKind('a.TXT')).toBe('text');
    expect(previewKind('a.html')).toBe('html');
    expect(previewKind('a.pdf')).toBe('pdf');
    expect(previewKind('a.webp')).toBe('image');
    expect(previewKind('a.docx')).toBe('extracted');
    expect(previewKind('large.pptx', 30 * 1024 * 1024)).toBe('extracted');
    expect(previewKind('cost.xlsx')).toBe('extracted');
    expect(previewKind('a.md', 10 * 1024 * 1024 + 1)).toBe('other');
    expect(previewKind('a.png', 10 * 1024 * 1024)).toBe('image');
    expect(previewKind('REVIEW-report.html', 47 * 1024 * 1024)).toBe('html');
    expect(previewKind('REVIEW-report.html', 76 * 1024 * 1024)).toBe('other');
  });
});

describe('PreviewDrawer', () => {
  it('Markdown：iframe srcdoc + sandbox 不含 allow-scripts / allow-same-origin，文档含 CSP，链接补 rel', async () => {
    const stub = stubFetch({
      views: {},
    });
    stub.mock.mockImplementation(async (url: string) =>
      String(url).includes('preview-text')
        ? ok({ name: 'a.md', text: '# 标题\n\n[链接](https://example.com) <script>alert(1)</script>' })
        : fail(404, 'x'),
    );
    const c = openDrawer(file('设计.md'));
    expect(c.ownerDocument.querySelector('dialog.drawer')).toBeTruthy();
    expect(c.ownerDocument.body.textContent).toContain('Loading preview');
    await flush(8);
    const frame = document.querySelector<HTMLIFrameElement>('dialog iframe')!;
    const sandbox = frame.getAttribute('sandbox') ?? '';
    expect(sandbox.split(/\s+/).sort()).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox']);
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    const doc = frame.getAttribute('srcdoc') ?? '';
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain('<h1>标题</h1>');
    expect(doc).toContain('rel="noopener noreferrer"');
    expect(doc).toContain('target="_blank"');
    expect(doc).not.toContain('<script>');
  });

  it('HTML 默认 Interactive sandbox，仍可打开 Safe HTML', async () => {
    stubFetch({});
    openDrawer(file('页面.html'));
    await flush();
    const frame = document.querySelector<HTMLIFrameElement>('dialog iframe')!;
    expect(frame.getAttribute('src')).toContain('mode=html');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(document.querySelector('a.preview-legacy')?.getAttribute('href')).toContain('mode=html');
  });

  it('HTML supports safe preview, interactive sandbox, maximize and isolated new tab', async () => {
    stubFetch({});
    openDrawer(file('REVIEW.html', { size: 47 * 1024 * 1024 }));
    await flush();
    const dialog = document.querySelector('dialog.drawer')!;
    const frame = dialog.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toContain('mode=html');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const open = dialog.querySelector<HTMLAnchorElement>('a[aria-label="Open file in new tab"]')!;
    expect(open.href).toContain('mode=html');
    expect(open.target).toBe('_blank');
    expect(open.rel).toContain('noopener');
    click(byText(dialog as HTMLElement, 'button', 'Safe HTML'));
    expect(dialog.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
    expect(dialog.querySelector('iframe')?.getAttribute('src')).toContain('mode=safe-html');
    click(byText(dialog as HTMLElement, 'button', 'Interactive HTML'));
    expect(dialog.querySelector('iframe')?.getAttribute('src')).toContain('mode=html');
    click(byText(dialog as HTMLElement, 'button', 'Maximize'));
    expect(dialog.querySelector('.preview-stage.is-maximized')).toBeTruthy();
    click(byText(dialog as HTMLElement, 'button', 'Restore'));
    expect(dialog.querySelector('.preview-stage.is-maximized')).toBeNull();
  });

  it('Office documents use local extracted text, with full-fidelity download', async () => {
    const stub = stubFetch({});
    stub.mock.mockImplementation(async (url: string) =>
      String(url).includes('/api/file-hub/extracted') ? ok({ text: 'Revenue 2026\nQ1 100', status: 'extracted', format: '.xlsx' }) : fail(404, 'x'));
    openDrawer(file('Financials.xlsx', { size: 14 * 1024 * 1024 }));
    await flush(8);
    const dialog = document.querySelector('dialog')!;
    expect(dialog.querySelector('pre.preview-text')?.textContent).toContain('Revenue 2026');
    expect(dialog.textContent).toContain('Text-only preview');
    expect(dialog.querySelector('a[download]')).toBeTruthy();
    expect(dialog.querySelector('iframe')).toBeNull();
  });

  it('PDF 使用 mode=inline 的 iframe；图片使用 <img>', async () => {
    stubFetch({});
    const pdf = openDrawer(file('报告.pdf'));
    await flush();
    expect(document.querySelector('dialog iframe')?.getAttribute('src')).toContain('mode=inline');
    pdf.remove();
    document.body.innerHTML = '';
    openDrawer(file('图.png'));
    await flush();
    expect(document.querySelector('dialog img')?.getAttribute('src')).toContain('mode=inline');
  });

  it('不支持的格式与超过 10 MB 的文件显示信息卡（文件名、类型、大小、下载）', async () => {
    stubFetch({});
    openDrawer(file('邮件.msg', { size: 2048 }));
    await flush();
    const text = document.querySelector('dialog')!.textContent ?? '';
    expect(text).toContain('邮件.msg');
    expect(text).toContain('msg');
    expect(text).toContain('2.0 KB');
    expect(document.querySelector('dialog a[download]')).toBeTruthy();
    expect(document.querySelector('dialog iframe')).toBeNull();
    document.body.innerHTML = '';
    openDrawer(file('大.md', { size: 11 * 1024 * 1024 }));
    await flush();
    expect(document.querySelector('dialog')!.textContent).toContain('10 MB');
    expect(document.querySelector('dialog iframe')).toBeNull();
  });

  it('外部链接：显示地址并在新标签页打开（noopener noreferrer）', () => {
    stubFetch({});
    openDrawer({ kind: 'link', url: 'https://example.com/x', title: '外链' });
    const anchor = document.querySelector<HTMLAnchorElement>('dialog a.btn-primary')!;
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    expect(document.querySelector('dialog')!.textContent).toContain('https://example.com/x');
  });

  it('文件不存在（失效引用或 404）显示「文件不存在」且没有预览', async () => {
    stubFetch({});
    openDrawer(file('x.md', { missing: true }));
    await flush();
    expect(document.querySelector('dialog')!.textContent).toContain('File not found');
    expect(document.querySelector('dialog iframe')).toBeNull();
    document.body.innerHTML = '';
    const stub = stubFetch({});
    stub.mock.mockImplementation(async () => fail(404, 'missing'));
    openDrawer(file('y.md'));
    await flush(8);
    expect(document.querySelector('dialog')!.textContent).toContain('File not found');
  });

  it('失败时保持打开并显示错误 + 重试，重试成功后显示内容', async () => {
    let attempts = 0;
    const stub = stubFetch({});
    stub.mock.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('offline');
      return ok({ name: 'z.md', text: '正文' });
    });
    openDrawer(file('z.md'));
    await flush(8);
    const dialog = document.querySelector('dialog')!;
    expect(dialog.textContent).toContain('Preview failed');
    expect(dialog.hasAttribute('open')).toBe(true);
    click(byText(dialog as HTMLElement, 'button', 'Retry'));
    await flush(8);
    expect(document.querySelector('dialog iframe')).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it('超过 10 秒仍未加载完成 → 错误 + 重试', async () => {
    vi.useFakeTimers();
    stubFetch({});
    openDrawer(file('慢.pdf'));
    act(() => {
      vi.advanceTimersByTime(10_001);
    });
    expect(document.querySelector('dialog')!.textContent).toContain('Preview failed');
    expect(byText(document.querySelector('dialog') as HTMLElement, 'button', 'Retry')).toBeTruthy();
  });

  it('打开后焦点进入抽屉，Esc / 关闭控件后焦点还原到触发元素', async () => {
    stubFetch({});
    const c = openDrawer(file('x.xlsx'));
    const opener = c.querySelector<HTMLElement>('#opener')!;
    opener.getClientRects = () => [{}] as unknown as DOMRectList; // jsdom 没有布局
    const close = document.querySelector<HTMLElement>('dialog [data-autofocus]')!;
    expect(document.activeElement).toBe(close);
    act(() => {
      closeTopOverlay();
    });
    await flush();
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    click(opener);
    click(document.querySelector<HTMLElement>('dialog [data-autofocus]')!);
    await flush();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Materials ownership hierarchy', () => {
  it('L3 displays direct references followed by inherited L2 and L1; same File ID is not duplicated within an owner', () => {
    const rootFile='file_'+'b'.repeat(32);
    const groups=materialGroups({depth:3}, {
      items:[material({id:'mine',fileId:FILE})],
      fileHubRefs:[{fileId:FILE,name:'设计.md',path:'Materials/设计.md',size:10,relation:'reference',missing:false}],
      inherited:[
        material({id:'l2',fileId:rootFile,sourceNodeId:'ws',sourceTitle:'Workstream',sourceLevel:2,scope:'workstream'}),
        material({id:'l1',fileId:FILE,sourceNodeId:'root',sourceTitle:'Initiative',sourceLevel:1,scope:'initiative'}),
      ],
      inheritedFileHubRefs:[{fileId:rootFile,name:'shared.pdf',path:'Materials/shared.pdf',size:10,
        relation:'related',missing:false,sourceNodeId:'ws',sourceTitle:'Workstream',sourceLevel:2}],
    });
    expect(groups.map((group)=>group.level)).toEqual([3,2,1]);
    expect(groups.map((group)=>group.entries.length)).toEqual([1,1,1]);
    expect(groups[1]?.sourceId).toBe('ws');
    expect(groups[2]?.sourceId).toBe('root');
    expect(groups[1]?.inherited).toBe(true);
    expect(groups[0]?.inherited).toBe(false);
  });
});

describe('MaterialsTab · compact read-only library', () => {
  const node = dto({ id: 'n1', revision: 5, depth: 3 });
  it('旧 ?preview 链接精确选择文件；没有默认的大型自动预览', async () => {
    window.history.replaceState(null, '', '/app/n/n1/materials?preview=mat-2');
    stubFetch({ views: { materials: () => ({
      items: [material(), material({id:'mat-2',title:'Tracker.html',name:'Tracker.html',fileId:'file_'+'c'.repeat(32)})],
      inherited: [], fileHubRefs:[]
    }) }});
    const c = render(<MaterialsTab node={node}/>);
    await flush();
    expect(c.querySelector('.materials-inline-preview')?.getAttribute('aria-label')).toContain('Tracker.html');
    expect(c.querySelector('.materials-inline-preview iframe')?.getAttribute('src')).toContain('mode=html');
    expect(c.querySelectorAll('.material-compact-item')).toHaveLength(2);
  });

  it('紧凑图标行，默认不展开，打开预览、关闭和新标签入口正常', async () => {
    window.history.replaceState(null, '', '/app/n/n1/materials');
    const data: MaterialsView = {
      items: [material(), material({id:'mat-2',title:'Missing',missing:true}),
        material({id:'mat-3',title:'Reference',materialType:'link',url:'https://example.com',fileId:null})],
    };
    const stub = stubFetch({ views: { materials: () => data } });
    const c = render(<MaterialsTab node={node}/>);
    await flush();
    expect(c.querySelectorAll('.material-compact-item')).toHaveLength(3);
    expect(c.querySelector('.materials-inline-preview')).toBeNull();
    expect(c.querySelector('button[aria-label="Add Material file"]')).toBeTruthy();
    expect(c.querySelector('button[aria-label="Add Material link"]')).toBeTruthy();
    expect(c.querySelector('input[type="file"]')).toBeTruthy();
    expect(c.querySelector('button[aria-label="Open storage location: 设计.md"]')).toBeTruthy();
    expect(c.querySelector('button[aria-label="Version history: 设计.md"]')).toBeTruthy();
    expect(c.querySelector('button[aria-label="Maximize preview: 设计.md"]')).toBeTruthy();
    expect(c.querySelector('a[aria-label="Download: 设计.md"]')).toBeTruthy();
    click(c.querySelector('button[aria-label="Preview: Reference"]')!);
    expect(c.querySelector('.materials-inline-preview')?.textContent).toContain('https://example.com');
    click(byText(c, 'button', 'Close preview'));
    expect(c.querySelector('.materials-inline-preview')).toBeNull();
    expect(stub.posts).toHaveLength(0);
  });

  it('相同 File ID 的直接 Material 和 File Hub 引用只展示一行', async () => {
    stubFetch({ views: { materials: () => ({
      items: [material()],
      fileHubRefs: [{fileId:FILE,name:'设计.md',path:'Materials/设计.md',size:10,relation:'reference',missing:false}],
      inherited:[],
    }) }});
    const c = render(<MaterialsTab node={node}/>);
    await flush();
    expect(c.querySelectorAll('.material-compact-item')).toHaveLength(1);
  });

  it('显示文件添加的具体时间，区分 Work Material 和 File Hub 的创建时间', async () => {
    stubFetch({ views: { materials: () => ({
      items:[material({createdAt:'2026-11-11T06:00:00Z'})],
      fileHubRefs:[{fileId:'file_'+'b'.repeat(32),name:'More.pdf',path:'Projects/WorkHub/Materials/More.pdf',
        size:42,relation:'related',missing:false,createdAt:1794376800}],
    }) }});
    const c=render(<MaterialsTab node={node}/>);
    await flush();
    const row=c.querySelector('[data-material-id="mat-1"]')!;
    expect(row.querySelector('time.material-compact-created')?.textContent).toContain('添加 2026-11-11');
    expect(c.querySelectorAll('time.material-compact-created')).toHaveLength(2);
  });

  it('每个 Level 都有新增链接入口，提交后仅创建当前层级 Material 关联', async () => {
    const stub=stubFetch({ views:{ materials:()=>({items:[]}) }, actions:{
      'material-add':()=>({node:dto({id:'n1',revision:6})}),
    }});
    const c=render(<MaterialsTab node={node}/>);
    await flush();
    click(c.querySelector('button[aria-label="Add Material link"]')!);
    expect(document.querySelector('dialog')).toBeTruthy();
    const url=document.querySelector<HTMLInputElement>('dialog input[type="url"]')!;
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
    act(()=>{setter.call(url,'https://example.com/docs');url.dispatchEvent(new Event('input',{bubbles:true}));});
    click(document.querySelector('dialog button[type="submit"]')!);
    await flush(9);
    expect(stub.posts.some((x)=>x.action==='material-add'&&x.id==='n1'&&x.type==='link')).toBe(true);
  });

  it('新文件单独导入 File Hub、再关联当前 Level；不发送版本升级参数', async () => {
    const fid='file_'+'b'.repeat(32);
    const calls:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async (input:string,init?:RequestInit)=>{
      const url=String(input);
      if(url.startsWith('/api/file-hub/upload')) {
        calls.push(url);
        return ok({id:fid,name:'new.pdf'});
      }
      if(init?.method==='POST'&&url==='/api/work-hub') {
        const body=JSON.parse(String(init.body));
        calls.push(JSON.stringify(body));
        return ok({node:dto({id:'n1',revision:6})});
      }
      if(url.includes('view=materials'))return ok({items:[]});
      return fail(404,'unknown');
    }));
    const c=render(<MaterialsTab node={node}/>);
    await flush();
    const picker=c.querySelector<HTMLInputElement>('input[aria-label="Choose new Material file"]')!;
    const f=new File(['hello'],'new.pdf',{type:'application/pdf'});
    Object.defineProperty(picker,'files',{configurable:true,value:[f]});
    act(()=>{picker.dispatchEvent(new Event('change',{bubbles:true}));});
    await flush(12);
    expect(calls[0]).toContain('folder=Projects%2FWorkHub%2FMaterials');
    expect(calls[0]).not.toContain('versionOf=');
    expect(calls[1]).toContain('"action":"material-add"');
    expect(calls[1]).toContain('"fileId":"'+fid+'"');
  });

  it('只解除关联：需要二次确认，不上传／修改原文件', async () => {
    const stub = stubFetch({
      views: { materials: () => ({ items: [material()] }) },
      actions: { 'material-remove': () => ({ node: dto({ id: 'n1', revision: 6 }) }) },
    });
    const c = render(<MaterialsTab node={node}/>);
    await flush();
    click(c.querySelector('button[aria-label="Remove: 设计.md"]')!);
    expect(c.querySelector('[data-material-id="mat-1"]')).toBeTruthy();
    expect(stub.posts).toHaveLength(0);
    click(byText(c, 'button', '确认解除关联'));
    await flush();
    expect(stub.posts).toHaveLength(1);
    expect(stub.posts[0]).toMatchObject({action:'material-remove',id:'n1',materialId:'mat-1'});
    expect(c.querySelector('[data-material-id="mat-1"]')).toBeNull();
  });

  it('Revision 冲突时保留文件行并提示错误', async () => {
    stubFetch({
      views: { materials: () => ({ items: [material()] }) },
      actions: { 'material-remove': () => jsonResponse(409, {ok:false, code:'revision_conflict', error:'版本冲突'}) },
    });
    const c = render(<MaterialsTab node={node}/>);
    await flush();
    click(c.querySelector('button[aria-label="Remove: 设计.md"]')!);
    click(byText(c, 'button', '确认解除关联'));
    await flush();
    expect(c.querySelector('[data-material-id="mat-1"]')).toBeTruthy();
    expect(c.querySelector('.error-text')?.textContent).toContain('changed elsewhere');
  });
});
