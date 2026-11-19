import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { StructuredPageEditor, safeStructuredPaste } from '../src/components/notes/StructuredPageEditor';
import { cleanup, render, flush, click, jsonResponse } from './helpers';
import type { JSONContent } from '@tiptap/react';
import { generateJSON } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();localStorage.clear();});

describe('Notes V3.5 · Structured Page editor',()=>{
  it('sanitizes Outlook/Word/web HTML and removes external image trackers and scripts',()=>{
    const html=safeStructuredPaste('<h2>Meeting</h2><table><tr><td><b>Result</b></td></tr></table>'+
      '<script>alert(1)</script><img src="https://evil.example/track.png">'+
      '<a href="javascript:alert(1)">Bad</a><a href="https://example.com">Good</a>');
    expect(html).toContain('Meeting');
    expect(html).toContain('<table>');
    expect(html).toContain('<b>Result</b>');
    expect(html).not.toContain('script');
    expect(html).not.toContain('track.png');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('https://example.com');
  });
  it('serializes normal web links with Tiptap 3 link attributes including title',()=>{
    const json=generateJSON('<p><a href="https://example.com/review">Read more</a></p>',[
      StarterKit.configure({link:{openOnClick:false,autolink:true}}),
    ]);
    const attrs=(json as JSONContent).content?.[0]?.content?.[0]?.marks?.find(mark=>mark.type==='link')?.attrs;
    expect(attrs?.href).toBe('https://example.com/review');
    expect(attrs).toHaveProperty('title');
    expect(attrs?.title).toBeNull();
  });
  it('renders Tiptap, five-level heading controls and an expandable outline',async()=>{
    const ready=vi.fn();const changed=vi.fn();
    const c=render(<StructuredPageEditor pageId="np_test" nodeId="ws" nodeKind="workstream"
      initialHtml="<h2>Technical risks</h2><p>Review this topic</p>"
      onReady={ready} onChange={changed} toolbarTarget={null}/>);
    await flush(10);
    expect(c.querySelector('.kbw-v35-content')).not.toBeNull();
    expect(c.querySelector<HTMLSelectElement>('select[aria-label="Outline level"]')?.options.length).toBe(6);
    expect(ready).toHaveBeenCalled();
    click(c.querySelector<HTMLButtonElement>('button[aria-label="Outline panel"]')!);
    await flush(8);
    expect(c.textContent).toContain('Technical risks');
    const heading=c.querySelector('h2[data-block-id]');
    expect(heading).not.toBeNull();
  });
  it('moves a heading with its entire subtree, preserving Block IDs and nested content',async()=>{
    const content:JSONContent={type:'doc',content:[
      {type:'heading',attrs:{level:2,blockId:'blk_alpha1234'},content:[{type:'text',text:'Alpha'}]},
      {type:'paragraph',content:[{type:'text',text:'Alpha body'}]},
      {type:'heading',attrs:{level:2,blockId:'blk_beta1234'},content:[{type:'text',text:'Beta'}]},
      {type:'paragraph',content:[{type:'text',text:'Beta body'}]},
      {type:'heading',attrs:{level:3,blockId:'blk_child1234'},content:[{type:'text',text:'Child'}]},
      {type:'paragraph',content:[{type:'text',text:'Child body'}]},
      {type:'heading',attrs:{level:2,blockId:'blk_gamma1234'},content:[{type:'text',text:'Gamma'}]},
      {type:'paragraph',content:[{type:'text',text:'Gamma body'}]},
    ]};
    const changed=vi.fn();
    const c=render(<StructuredPageEditor pageId="np_outline" nodeId="ws" nodeKind="workstream"
      initialHtml="" initialJson={content} onReady={()=>{}} onChange={changed}
      toolbarTarget={null}/>);
    await flush(8);
    click(c.querySelector<HTMLButtonElement>('button[aria-label="Outline panel"]')!);
    await flush(3);
    click(c.querySelector<HTMLButtonElement>('button[aria-label="up heading subtree: Beta"]')!);
    await flush(6);
    const reordered=changed.mock.lastCall?.[0] as JSONContent;
    expect(reordered.content?.map(n=>n.content?.[0]?.text)).toEqual([
      'Beta','Beta body','Child','Child body','Alpha','Alpha body','Gamma','Gamma body']);
    expect(reordered.content?.[0]?.attrs?.blockId).toBe('blk_beta1234');
    expect(reordered.content?.[2]?.attrs?.blockId).toBe('blk_child1234');
    click(c.querySelector<HTMLButtonElement>('button[aria-label="down heading subtree: Beta"]')!);
    await flush(4);
    click(c.querySelector<HTMLButtonElement>('button[aria-label="indent heading subtree: Beta"]')!);
    await flush(5);
    const nested=changed.mock.lastCall?.[0] as JSONContent;
    expect(nested.content?.[2]?.attrs?.level).toBe(3);
    expect(nested.content?.[4]?.attrs?.level).toBe(4);
    click(c.querySelector<HTMLButtonElement>('button[aria-label="outdent heading subtree: Beta"]')!);
    await flush(5);
    const restored=changed.mock.lastCall?.[0] as JSONContent;
    expect(restored.content?.[2]?.attrs?.level).toBe(2);
    expect(restored.content?.[4]?.attrs?.level).toBe(3);
    const items=[...c.querySelectorAll<HTMLElement>('.kbw-v35-outline-item')];
    const gamma=items.find(item=>item.textContent?.includes('Gamma'))!;
    const alpha=items.find(item=>item.textContent?.includes('Alpha'))!;
    act(()=>gamma.dispatchEvent(new Event('dragstart',{bubbles:true})));
    act(()=>alpha.dispatchEvent(new Event('drop',{bubbles:true,cancelable:true})));
    await flush(5);
    const dropped=changed.mock.lastCall?.[0] as JSONContent;
    expect(dropped.content?.map(item=>item.content?.[0]?.text)).toEqual([
      'Gamma','Gamma body','Alpha','Alpha body','Beta','Beta body','Child','Child body']);
    expect(dropped.content?.[0]?.attrs?.blockId).toBe('blk_gamma1234');
  });

  it('repairs copied heading and image IDs before saving a JSON document',async()=>{
    const fid='file_'+'a'.repeat(32);
    const content:JSONContent={type:'doc',content:[
      {type:'heading',attrs:{level:2,blockId:'blk_repeat1234'},content:[{type:'text',text:'One'}]},
      {type:'heading',attrs:{level:3,blockId:'blk_repeat1234'},content:[{type:'text',text:'Two'}]},
      {type:'image',attrs:{src:'/api/file-hub/file?id='+fid+'&mode=inline',alt:'Original',refId:'ref_repeat1234'}},
      {type:'image',attrs:{src:'/api/file-hub/file?id='+fid+'&mode=inline',alt:'Copy',refId:'ref_repeat1234'}},
    ]};
    const ready=vi.fn();
    const c=render(<StructuredPageEditor pageId="np_copies" nodeId="ws" nodeKind="workstream"
      initialHtml="" initialJson={content} onReady={ready} onChange={()=>{}}
      toolbarTarget={null}/>);
    await flush(12);
    expect(c.querySelectorAll('h2,h3')).toHaveLength(2);
    const canonical=ready.mock.lastCall?.[0] as JSONContent;
    const headings=(canonical.content||[]).filter(item=>item.type==='heading').map(item=>item.attrs?.blockId);
    const images=(canonical.content||[]).filter(item=>item.type==='image').map(item=>item.attrs?.refId);
    expect(new Set(headings).size).toBe(2);
    expect(new Set(images).size).toBe(2);
    expect(images.every(ref=>typeof ref==='string' && ref.startsWith('ref_'))).toBe(true);
  });

  it('lists existing File Hub attachments by path and inserts a canonical Page card',async()=>{
    const fileId='file_'+'b'.repeat(32);
    const network=vi.fn(async (request:RequestInfo|URL)=>{
      const url=String(request);
      const data=url.includes('notebook-v35-staged')?{items:[]}:
        [{id:fileId,path:'Projects/WorkHub/Materials/overview.pdf',revision:2,size:2048}];
      return jsonResponse(200,{ok:true,data});
    });
    vi.stubGlobal('fetch',network);
    const ready=vi.fn();const changed=vi.fn();
    const c=render(<StructuredPageEditor pageId="np_test_file" nodeId="ws" nodeKind="workstream"
      initialHtml="<p></p>" onReady={ready} onChange={changed} toolbarTarget={null}/>);
    await flush(8);
    click(c.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!);
    click([...c.querySelectorAll<HTMLButtonElement>('.kbw-v35-insert-menu button')]
      .find(button=>button.textContent==='Attach Existing')!);
    await flush(15);
    expect(c.textContent).toContain('overview.pdf');
    const choose=[...c.querySelectorAll<HTMLButtonElement>('.kbw-v35-file-picker button')]
      .find(button=>button.textContent==='overview.pdf');
    expect(choose).toBeDefined();
    click(choose!);
    await flush(8);
    expect(c.querySelector('.kbw-v35-attachment-node')?.textContent).toContain('overview.pdf');
    expect((changed.mock.lastCall?.[0] as JSONContent)?.content?.some(item=>
      item.type==='fileAttachment'&&item.attrs?.fileId===fileId)).toBe(true);
  });

  it('uploads an Outlook .msg file at the Page cursor as a pinned email card',async()=>{
    // jsdom does not implement Range.getClientRects used by editor.focus scroll.
    const rect=new DOMRect(0,0,10,10);
    Object.defineProperty(Range.prototype,'getClientRects',{
      configurable:true,value:()=>({length:1,0:rect,item:()=>rect}),
    });
    const fid='file_'+'c'.repeat(32);
    const request=vi.fn(async (_request:RequestInfo|URL)=>jsonResponse(200,{ok:true,data:{fileId:fid,status:'staged'}}));
    vi.stubGlobal('fetch',request);
    const changed=vi.fn();
    const c=render(<StructuredPageEditor pageId="np_msg" nodeId="ws" nodeKind="workstream"
      initialHtml="<p>Before</p><p>After</p>" onReady={()=>{}} onChange={changed} toolbarTarget={null}/>);
    await flush(9);
    click(c.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!);
    click([...c.querySelectorAll<HTMLButtonElement>('.kbw-v35-insert-menu button')]
      .find(button=>button.textContent==='Upload Attachment')!);
    const input=c.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    const file=new File(['synthetic Outlook data'],'Example.msg',{type:'application/vnd.ms-outlook'});
    Object.defineProperty(input,'files',{configurable:true,value:[file]});
    act(()=>input.dispatchEvent(new Event('change',{bubbles:true})));
    await flush(18);
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toContain('notePageId=np_msg');
    const card=c.querySelector('.kbw-v35-attachment-node');
    expect(card?.textContent).toContain('Example.msg');
    const json=changed.mock.lastCall?.[0] as JSONContent;
    const fileNode=json.content?.find(node=>node.type==='fileAttachment');
    expect(fileNode?.attrs).toMatchObject({fileId:fid,name:'Example.msg',kind:'email',
      policy:'pinned',pinnedRevision:1});
    expect(c.querySelector('[role="status"]')?.textContent).toContain('inserted at the cursor');
    click(c.querySelector<HTMLButtonElement>('button[aria-label="Attachments"]')!);
    expect(c.textContent).toContain('Pinned Rev 1');
  });

  it('shows upload failure above the canvas without altering the Page content',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>jsonResponse(400,{
      ok:false,error:'Invalid upload request',code:'invalid_request'})));
    const changed=vi.fn();
    const c=render(<StructuredPageEditor pageId="np_msg_rejected" nodeId="ws" nodeKind="workstream"
      initialHtml="<p>Safe draft</p>" onReady={()=>{}} onChange={changed} toolbarTarget={null}/>);
    await flush(9);
    click(c.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!);
    click([...c.querySelectorAll<HTMLButtonElement>('.kbw-v35-insert-menu button')]
      .find(button=>button.textContent==='Upload Attachment')!);
    const input=c.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    Object.defineProperty(input,'files',{configurable:true,
      value:[new File(['dummy'],'Broken.msg',{type:'application/vnd.ms-outlook'})]});
    act(()=>input.dispatchEvent(new Event('change',{bubbles:true})));
    await flush(16);
    const alert=c.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Broken.msg');
    const editor=c.querySelector('.kbw-v35-canvas-wrap');
    expect((alert as Element).compareDocumentPosition(editor!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(c.textContent).toContain('Safe draft');
    expect(c.querySelector('.kbw-v35-attachment-node')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it('retains Page JSON blocks and attachments as real editor nodes',async()=>{
    const content:JSONContent={type:'doc',content:[
      {type:'heading',attrs:{level:4,blockId:'blk_test1234'},content:[{type:'text',text:'Workstream'}]},
      {type:'fileAttachment',attrs:{refId:'ref_test1234',fileId:'file_'+'a'.repeat(32),
        name:'Discussion.eml',kind:'email',policy:'pinned',pinnedRevision:1}},
    ]};
    const ready=vi.fn();
    const c=render(<StructuredPageEditor pageId="np_test2" nodeId="ws" nodeKind="workstream"
      initialHtml="" initialJson={content} onReady={ready} onChange={()=>{}}
      toolbarTarget={null}/>);
    await flush(9);
    expect(c.querySelector('.kbw-v35-attachment-node')).not.toBeNull();
    click(c.querySelector<HTMLButtonElement>('button[aria-label="Attachments"]')!);
    expect(c.textContent).toContain('Discussion.eml');
    expect(c.textContent).toContain('Pinned Rev 1');
    expect((ready.mock.calls[0]?.[0] as JSONContent)?.content?.[0]?.attrs?.blockId).toBe('blk_test1234');
  });
});
