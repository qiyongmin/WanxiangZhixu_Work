import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { Editor } from '@tiptap/core';
import { TableMap } from '@tiptap/pm/tables';
import { EXTENSIONS, StructuredPageEditor, colorTableSelection, safeStructuredPaste, setTableRowHeight } from
  '../src/components/notes/StructuredPageEditor';
import { cleanup, render, flush, click } from './helpers';
import { makeBorderToken, setTableBorders } from '../src/components/notes/tableBorders';
import { sanitizeHtml } from '../src/lib/sanitize';
import type { JSONContent } from '@tiptap/react';

beforeEach(()=>{
  const rect=new DOMRect(0,0,10,10);
  Object.defineProperty(Range.prototype,'getClientRects',{
    configurable:true,value:()=>({length:1,0:rect,item:()=>rect}),
  });
  vi.stubGlobal('scrollBy',vi.fn());
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();});

const cell = (text:string, heading=false):JSONContent => ({
  type:heading?'tableHeader':'tableCell',content:[{type:'paragraph',content:[{type:'text',text}]}],
});
const sample:JSONContent = {type:'doc',content:[{type:'table',content:[
  {type:'tableRow',content:[cell('Topic',true),cell('Owner',true)]},
  {type:'tableRow',content:[cell('Design'),cell('Engineering')]},
]}]};
function shade(doc:JSONContent,row:number,col:number) {
  return doc.content?.[0]?.content?.[row]?.content?.[col]?.attrs?.background;
}

describe('Notes table contextual editing',()=>{
  it('colors the focused cell, entire row and column, and clears a selected range',()=>{
    const editor=new Editor({extensions:EXTENSIONS,content:sample,
      element:document.createElement('div')});
    try {
      const map=TableMap.get(editor.state.doc.firstChild!);
      const cellPos=(row:number,col:number)=>1+map.map[row*map.width+col]!;
      editor.commands.setTextSelection(cellPos(1,0)+2);
      expect(colorTableSelection(editor,'cell','amber')).toBe(true);
      expect(shade(editor.getJSON(),1,0)).toBe('amber');
      expect(shade(editor.getJSON(),1,1)).toBeNull();

      expect(colorTableSelection(editor,'row','green')).toBe(true);
      expect(shade(editor.getJSON(),1,0)).toBe('green');
      expect(shade(editor.getJSON(),1,1)).toBe('green');
      expect(shade(editor.getJSON(),0,0)).toBeNull();

      expect(colorTableSelection(editor,'column','blue')).toBe(true);
      expect(shade(editor.getJSON(),0,0)).toBe('blue');
      expect(shade(editor.getJSON(),1,0)).toBe('blue');
      expect(shade(editor.getJSON(),1,1)).toBe('green');

      editor.commands.setCellSelection({anchorCell:cellPos(0,0),headCell:cellPos(1,1)});
      expect(colorTableSelection(editor,'cell','none')).toBe(true);
      for(let row=0;row<2;row++)for(let col=0;col<2;col++)
        expect(shade(editor.getJSON(),row,col)).toBeNull();
      expect(colorTableSelection(editor,'cell','none')).toBe(false);
      editor.commands.undo();
      expect(shade(editor.getJSON(),0,0)).toBe('blue');
    } finally {editor.destroy();}
  });

  it('edits one cell edge, mirrored neighbors, whole rows/columns, and outer/inner borders',()=>{
    const editor=new Editor({extensions:EXTENSIONS,content:sample,element:document.createElement('div')});
    const key=(row:number,col:number,side:string)=>
      (editor.getJSON() as JSONContent).content?.[0]?.content?.[row]?.content?.[col]?.attrs?.[side];
    try{
      const map=TableMap.get(editor.state.doc.firstChild!);
      const pos=(r:number,c:number)=>1+map.map[r*map.width+c]!;
      editor.commands.setTextSelection(pos(1,0)+2);
      expect(setTableBorders(editor,'selection','right','dashed:3:accent')).toBe(true);
      expect(key(1,0,'borderRight')).toBe('dashed:3:accent');
      expect(key(1,1,'borderLeft')).toBe('dashed:3:accent');
      expect(key(0,1,'borderLeft')).toBeNull();
      // The outer border of the second row is independent from its inside edge.
      expect(setTableBorders(editor,'row','outer','solid:2:red')).toBe(true);
      expect(key(1,0,'borderBottom')).toBe('solid:2:red');
      expect(key(1,1,'borderBottom')).toBe('solid:2:red');
      expect(key(1,0,'borderRight')).toBe('dashed:3:accent');
      expect(setTableBorders(editor,'row','inner','dotted:2:green')).toBe(true);
      expect(key(1,0,'borderRight')).toBe('dotted:2:green');
      expect(key(1,1,'borderLeft')).toBe('dotted:2:green');
      expect(key(0,1,'borderLeft')).toBeNull();
      // Every row of this column gets an outside vertical edge.
      expect(setTableBorders(editor,'column','left','double:3:purple')).toBe(true);
      expect(key(0,0,'borderLeft')).toBe('double:3:purple');
      expect(key(1,0,'borderLeft')).toBe('double:3:purple');
      // The full table outline should not repaint inner edges.
      expect(setTableBorders(editor,'table','outer','solid:3:amber')).toBe(true);
      expect(key(0,0,'borderTop')).toBe('solid:3:amber');
      expect(key(1,1,'borderBottom')).toBe('solid:3:amber');
      expect(key(1,0,'borderRight')).toBe('dotted:2:green');
      expect(setTableBorders(editor,'table','outer','none')).toBe(true);
      expect(key(0,0,'borderTop')).toBe('none');
      expect(key(1,0,'borderRight')).toBe('dotted:2:green');
      expect(setTableBorders(editor,'table','outer','none')).toBe(false);
      expect(editor.commands.undo()).toBe(true);
      expect(key(0,0,'borderTop')).not.toBe('none');
    }finally{editor.destroy();}
  });

  it('handles multiple selected cells and merged cells without changing other tables',()=>{
    const documentJson:JSONContent={type:'doc',content:[
      ...sample.content!,{type:'paragraph',content:[{type:'text',text:'Keep safe'}]},
      ...sample.content!,
    ]};
    const editor=new Editor({extensions:EXTENSIONS,content:documentJson,element:document.createElement('div')});
    try{
      const map=TableMap.get(editor.state.doc.firstChild!);
      const pos=(r:number,c:number)=>1+map.map[r*map.width+c]!;
      editor.commands.setCellSelection({anchorCell:pos(0,0),headCell:pos(1,1)});
      expect(setTableBorders(editor,'selection','outer','dashed:2:blue' as never)).toBe(false);
      expect(setTableBorders(editor,'selection','outer','dashed:2:accent')).toBe(true);
      const json=editor.getJSON() as JSONContent;
      expect(json.content?.[0]?.content?.[0]?.content?.[0]?.attrs?.borderTop).toBe('dashed:2:accent');
      expect(json.content?.[0]?.content?.[0]?.content?.[0]?.attrs?.borderRight).toBeNull();
      expect(json.content?.[2]?.content?.[0]?.content?.[0]?.attrs?.borderTop).toBeNull();
      editor.commands.setCellSelection({anchorCell:pos(0,0),headCell:pos(0,1)});
      expect(editor.commands.mergeCells()).toBe(true);
      expect(setTableBorders(editor,'selection','outer',makeBorderToken('double',1,'purple'))).toBe(true);
      const merged=(editor.getJSON() as JSONContent).content?.[0]?.content?.[0]?.content?.[0];
      expect(merged?.attrs?.colspan).toBe(2);
      expect(merged?.attrs?.borderTop).toBe('double:3:purple');
      const html=editor.getHTML();
      expect(html).toContain('data-kbw-border-top="double:3:purple"');
      const reloaded=new Editor({extensions:EXTENSIONS,element:document.createElement('div'),content:html});
      try{expect((reloaded.getJSON() as JSONContent).content?.[0]?.content?.[0]?.content?.[0]?.attrs?.borderTop).toBe('double:3:purple');}
      finally{reloaded.destroy();}
    }finally{editor.destroy();}
  });

  it('supports table insertion and row/column actions without destroying other text',()=>{
    const editor=new Editor({extensions:EXTENSIONS,element:document.createElement('div'),
      content:'<p>Keep this introduction</p>'});
    try {
      editor.chain().focus().insertTable({rows:2,cols:2,withHeaderRow:true}).run();
      expect(editor.getHTML()).toContain('<table');
      expect(editor.commands.addRowAfter()).toBe(true);
      expect(editor.commands.addColumnAfter()).toBe(true);
      const table=(editor.getJSON() as JSONContent).content?.find(node=>node.type==='table');
      expect(table?.content).toHaveLength(3);
      expect(table?.content?.[0]?.content).toHaveLength(3);
      expect(editor.getText()).toContain('Keep this introduction');
      expect(editor.commands.deleteRow()).toBe(true);
      expect(editor.commands.deleteColumn()).toBe(true);
      expect((editor.getJSON() as JSONContent).content?.find(node=>node.type==='table')?.content).toHaveLength(2);
    } finally {editor.destroy();}
  });

  it('resizes individual rows, preserves heights and column widths through JSON/HTML reload',()=>{
    const editor=new Editor({extensions:EXTENSIONS,element:document.createElement('div'),content:sample});
    try{
      const tableExtension=editor.extensionManager.extensions.find(e=>e.name==='table');
      expect(tableExtension?.options.resizable).toBe(true);
      expect(tableExtension?.options.cellMinWidth).toBe(64);
      const firstRowPos=1;
      const secondRowPos=1+editor.state.doc.firstChild!.child(0).nodeSize;
      expect(setTableRowHeight(editor,secondRowPos,120)).toBe(true);
      expect(setTableRowHeight(editor,firstRowPos,68)).toBe(true);
      expect(setTableRowHeight(editor,firstRowPos,68)).toBe(false);
      expect(setTableRowHeight(editor,firstRowPos,-100)).toBe(false);
      expect(setTableRowHeight(editor,firstRowPos,850)).toBe(false);
      expect(editor.state.doc.firstChild!.child(0).attrs.height).toBe(68);
      expect(editor.state.doc.firstChild!.child(1).attrs.height).toBe(120);
      const pos=3; // first cell content
      editor.commands.setTextSelection(pos+2);
      expect(editor.commands.setCellAttribute('colwidth',[154])).toBe(true);
      const json=editor.getJSON() as JSONContent;
      expect(json.content?.[0]?.content?.[0]?.content?.[0]?.attrs?.colwidth).toEqual([154]);
      const html=editor.getHTML();
      expect(html).toContain('data-kbw-row-height="68"');
      expect(html).toContain('colwidth="154"');
      const reloaded=new Editor({extensions:EXTENSIONS,
        element:document.createElement('div'),content:html});
      try {
        expect((reloaded.getJSON() as JSONContent).content?.[0]?.content?.[0]?.attrs?.height).toBe(68);
        expect((reloaded.getJSON() as JSONContent).content?.[0]?.content?.[1]?.attrs?.height).toBe(120);
        expect((reloaded.getJSON() as JSONContent).content?.[0]?.content?.[0]?.content?.[0]?.attrs?.colwidth).toEqual([154]);
      }finally{reloaded.destroy();}
    }finally{editor.destroy();}
  });

  it('drags a row bottom border and commits one revision on pointer release',async()=>{
    const changed=vi.fn();
    const c=render(<StructuredPageEditor pageId="np_resize" nodeId="ws"
      nodeKind="workstream" initialHtml="" initialJson={sample} toolbarTarget={null}
      onReady={()=>{}} onChange={changed}/>);
    await flush(9);
    const row=c.querySelectorAll<HTMLTableRowElement>('tr')[1]!;
    const target=row.querySelector<HTMLTableCellElement>('td')!;
    const rect=(left:number,top:number,width:number,height:number)=>
      ({left,top,width,height,right:left+width,bottom:top+height,
        x:left,y:top,toJSON:()=>({})} as DOMRect);
    vi.spyOn(row,'getBoundingClientRect').mockReturnValue(rect(0,35,260,52));
    vi.spyOn(target,'getBoundingClientRect').mockReturnValue(rect(0,35,130,52));
    const pointer=(type:string,y:number)=>new MouseEvent(type,{
      bubbles:true,cancelable:true,button:0,clientX:50,clientY:y,
    });
    act(()=>target.dispatchEvent(pointer('pointermove',85)));
    expect(row.classList.contains('kbw-v35-row-edge')).toBe(true);
    act(()=>target.dispatchEvent(pointer('pointerdown',85)));
    act(()=>document.dispatchEvent(pointer('pointermove',130)));
    act(()=>document.dispatchEvent(pointer('pointerup',130)));
    await flush(10);
    const updated=changed.mock.lastCall?.[0] as JSONContent;
    expect(updated.content?.[0]?.content?.[1]?.attrs?.height).toBe(97);
    expect(updated.content?.[0]?.content?.[0]?.attrs?.height).toBeNull();
    expect(c.querySelectorAll('tr[data-kbw-row-height="97"]')).toHaveLength(1);
  });

  it('opens actionable right-click menu and preserves semantic cell shading in revisions',async()=>{
    const changes=vi.fn();
    const c=render(<StructuredPageEditor pageId="np_table" nodeId="ws" nodeKind="workstream"
      initialHtml="" initialJson={sample} toolbarTarget={null} onReady={()=>{}} onChange={changes}/>);
    await flush(12);
    const target=c.querySelector('td')!;
    expect(target).not.toBeNull();
    act(()=>target.dispatchEvent(new MouseEvent('contextmenu',{
      bubbles:true,cancelable:true,clientX:48,clientY:60,
    })));
    await flush(4);
    expect(c.querySelector('[aria-label="Table context menu"]')).not.toBeNull();
    click(c.querySelector<HTMLButtonElement>(
      '[aria-label="Table context menu"] button[aria-label="Insert row below"]')!);
    await flush(6);
    expect(c.querySelectorAll('tr')).toHaveLength(3);

    const select=c.querySelector<HTMLSelectElement>(
      '[aria-label="Table editing tools"] select[aria-label="Background color scope"]')!;
    expect(select).not.toBeNull();
    act(()=>{select.value='row';select.dispatchEvent(new Event('change',{bubbles:true}));});
    await flush(3);
    click(c.querySelector<HTMLButtonElement>(
      '[aria-label="Table editing tools"] button[aria-label="Set row background rose"]')!);
    await flush(8);
    const updated=changes.mock.lastCall?.[0] as JSONContent;
    expect(updated?.content?.[0]?.content?.some(row=>
      row.content?.some(cell=>cell.attrs?.background==='rose'))).toBe(true);
    expect(c.querySelector('[data-kbw-bg="rose"]')).not.toBeNull();
    expect(c.querySelectorAll('.kbw-v35-content table')).toHaveLength(1);
  });

  it('shows border picker in the contextual toolbar and saves its preset',async()=>{
    const changes=vi.fn();
    const c=render(<StructuredPageEditor pageId="np_border" nodeId="ws" nodeKind="workstream"
      initialHtml="" initialJson={sample} toolbarTarget={null} onReady={()=>{}} onChange={changes}/>);
    await flush(10);
    const cell=c.querySelector('td')!;
    act(()=>cell.dispatchEvent(new MouseEvent('contextmenu',
      {bubbles:true,cancelable:true,clientX:60,clientY:70})));
    await flush(4);
    const toolbar=c.querySelector<HTMLElement>('[aria-label="Table editing tools"]')!;
    click(toolbar.querySelector<HTMLButtonElement>('[aria-label="Table border settings"]')!);
    await flush(4);
    const style=toolbar.querySelector<HTMLSelectElement>('[aria-label="Border line style"]')!;
    const placement=toolbar.querySelector<HTMLSelectElement>('[aria-label="Border placement"]')!;
    const width=toolbar.querySelector<HTMLSelectElement>('[aria-label="Border thickness"]')!;
    act(()=>{
      style.value='dashed';style.dispatchEvent(new Event('change',{bubbles:true}));
      placement.value='bottom';placement.dispatchEvent(new Event('change',{bubbles:true}));
      width.value='3';width.dispatchEvent(new Event('change',{bubbles:true}));
    });
    await flush(4);
    click(toolbar.querySelector<HTMLButtonElement>('[aria-label="Apply table borders"]')!);
    await flush(6);
    expect((changes.mock.lastCall?.[0] as JSONContent).content?.[0]?.content?.[1]?.content?.[0]?.attrs?.borderBottom).toBe('dashed:3:default');
    expect(c.querySelector('[data-kbw-border-bottom="dashed:3:default"]')).not.toBeNull();
    click(toolbar.querySelector<HTMLButtonElement>('[aria-label="Remove table borders"]')!);
    await flush(6);
    expect((changes.mock.lastCall?.[0] as JSONContent).content?.[0]?.content?.[1]?.content?.[0]?.attrs?.borderBottom).toBe('none');
  });

  it('round-trips safe borders through paste and sanitization, strips arbitrary CSS and invalid tokens',()=>{
    const pasted=safeStructuredPaste('<table><tr>'+
      '<td data-kbw-border-top="dashed:3:accent">Valid</td>'+
      '<td data-kbw-border-right="solid:2:url(javascript:evil)" style="border:99px solid red">Unsafe</td>'+
      '</tr></table><p data-kbw-border-top="solid:1:red">Not a table</p>');
    expect(pasted).toContain('data-kbw-border-top="dashed:3:accent"');
    expect(pasted).not.toContain('javascript:');
    expect(pasted).not.toContain('style=');
    expect(pasted).not.toContain('data-kbw-border-right');
    expect(pasted).not.toContain('<p data-kbw-border-top');
    const html=sanitizeHtml('<table><tr><td data-kbw-border-top="dotted:2:purple"'+
      ' data-kbw-border-left="none">Text</td></tr></table>');
    expect(html.ok).toBe(true);
    expect(html.html).toContain('data-kbw-border-top="dotted:2:purple"');
    expect(html.html).toContain('data-kbw-border-left="none"');
  });

  it('allows safe table colors in copy/paste but strips arbitrary CSS and tokens',()=>{
    const html=safeStructuredPaste('<table><tr><td data-kbw-bg="green">Safe</td>'+
      '<td data-kbw-bg="url(javascript:evil)" style="background:red">Unsafe</td></tr></table>');
    expect(html).toContain('data-kbw-bg="green"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('style=');
    expect(html).toContain('Unsafe');
  });
});
