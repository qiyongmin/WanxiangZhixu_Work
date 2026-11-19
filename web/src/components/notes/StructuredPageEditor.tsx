import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { EditorContent, useEditor, type JSONContent, type Editor } from '@tiptap/react';
import { Node, Mark, Extension, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { TableMap, CellSelection } from '@tiptap/pm/tables';
import { Image } from '@tiptap/extension-image';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Highlight } from '@tiptap/extension-highlight';
import { Placeholder } from '@tiptap/extension-placeholder';
import DOMPurify from 'dompurify';
import { get, getJson, postBinary } from '../../lib/api';
import { checkImage, uploadNoteImage } from '../../lib/noteHtml';
import { safeName } from '../../lib/fileHub';
import { BORDER_COLORS, BORDER_STYLES, BORDER_WIDTHS, BORDER_SIDES,
  borderCellAttributes, isBorderToken, makeBorderToken, setTableBorders,
  type BorderScope, type BorderPlacement, type BorderStyle, type BorderWidth,
  type BorderColor } from './tableBorders';

interface Props {
  pageId: string;
  nodeId: string;
  nodeKind: string;
  initialHtml: string;
  initialJson?: JSONContent;
  targetBlockId?: string | null;
  onReady: (json: JSONContent) => void;
  onChange: (json: JSONContent) => void;
  toolbarTarget: HTMLElement | null;
}
type HeadingEntry = { id: string; level: number; title: string };
type Attachment = { refId: string; fileId: string; name: string; kind: string; policy: string; pinnedRevision?: number };
type HubFile = { id: string; name?: string; path?: string; revision: number; size?: number };

const filePattern = /^file_[0-9a-f]{32}$/;
export const TABLE_BACKGROUNDS = ['none', 'blue', 'green', 'amber', 'rose', 'purple', 'slate'] as const;
export type TableBackground = typeof TABLE_BACKGROUNDS[number];
export type TableColorScope = 'cell' | 'row' | 'column';

const coloredCellAttributes = {
  ...borderCellAttributes,
  background: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const value = element.getAttribute('data-kbw-bg');
      return TABLE_BACKGROUNDS.some(token => token !== 'none' && token === value) ? value : null;
    },
    renderHTML: (attrs: Record<string, unknown>) =>
      TABLE_BACKGROUNDS.some(token => token !== 'none' && token === attrs.background)
        ? { 'data-kbw-bg': attrs.background as string } : {},
  },
};
const ColoredCell = TableCell.extend({
  addAttributes() { return { ...this.parent?.(), ...coloredCellAttributes }; },
});
const ColoredHeader = TableHeader.extend({
  addAttributes() { return { ...this.parent?.(), ...coloredCellAttributes }; },
});
export const MIN_ROW_HEIGHT = 28;
export const MAX_ROW_HEIGHT = 800;
const ResizableRow = TableRow.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      height: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute('data-kbw-row-height') || element.getAttribute('height');
          const n = Number(raw);
          return raw && Number.isInteger(n) && n >= MIN_ROW_HEIGHT && n <= MAX_ROW_HEIGHT ? n : null;
        },
        renderHTML: (attrs: Record<string, unknown>) => {
          const n = attrs.height;
          return typeof n === 'number' && Number.isInteger(n) &&
            n >= MIN_ROW_HEIGHT && n <= MAX_ROW_HEIGHT
            ? { height: String(n), 'data-kbw-row-height': String(n) } : {};
        },
      },
    };
  },
});
/** Revision-safe row sizing. No arbitrary CSS or mutation of adjacent table rows. */
export function setTableRowHeight(editor: Editor, pos: number, height: number): boolean {
  if (!Number.isInteger(height) || height < MIN_ROW_HEIGHT || height > MAX_ROW_HEIGHT)
    return false;
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'tableRow' || node.attrs.height === height) return false;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, height }));
  return true;
}


/** Apply a semantic shade to the focused cell, full logical row or column.
 * TableMap handles merged cells without recoloring unrelated tables.
 */
export function colorTableSelection(editor: Editor, scope: TableColorScope, color: TableBackground): boolean {
  if (!TABLE_BACKGROUNDS.includes(color)) return false;
  const selection = editor.state.selection;
  const anchor = selection instanceof CellSelection ? selection.$anchorCell : selection.$from;
  let tableDepth = -1, cellDepth = -1;
  for (let depth = anchor.depth; depth > 0; depth--) {
    const kind = anchor.node(depth).type.name;
    if (cellDepth < 0 && (kind === 'tableCell' || kind === 'tableHeader')) cellDepth = depth;
    if (kind === 'table') { tableDepth = depth; break; }
  }
  if (tableDepth < 0 || (cellDepth < 0 && !(selection instanceof CellSelection))) return false;
  const table = anchor.node(tableDepth);
  const tableStart = anchor.start(tableDepth);
  const activeCellPos = selection instanceof CellSelection ? selection.$anchorCell.pos : anchor.before(cellDepth);
  const map = TableMap.get(table);
  const rect = map.findCell(activeCellPos - tableStart);
  const relativePositions = new Set<number>();
  if (scope === 'cell') {
    if (selection instanceof CellSelection) {
      selection.forEachCell((_node, pos) => {
        if (pos >= tableStart && pos < tableStart + table.content.size)
          relativePositions.add(pos - tableStart);
      });
    } else relativePositions.add(activeCellPos - tableStart);
  } else if (scope === 'row') {
    for (let col = 0; col < map.width; col++) relativePositions.add(map.map[rect.top * map.width + col]!);
  } else {
    for (let row = 0; row < map.height; row++) relativePositions.add(map.map[row * map.width + rect.left]!);
  }
  const tr = editor.state.tr;
  for (const offset of relativePositions) {
    const pos = tableStart + offset;
    const node = tr.doc.nodeAt(pos);
    if (!node || (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader')) continue;
    const background = color === 'none' ? null : color;
    if (node.attrs.background !== background)
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, background });
  }
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

const BlockId = Extension.create({
  name: 'kbwOutlineBlockId',
  addGlobalAttributes() {
    return [{
      types: ['heading'],
      attributes: {
        blockId: {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute('data-block-id'),
          renderHTML: (attrs: Record<string, unknown>) =>
            attrs.blockId ? { 'data-block-id': String(attrs.blockId) } : {},
        },
      },
    }];
  },
});

const NOTE_COLOR_TOKENS=['note-color-blue','note-color-green','note-color-red',
  'note-color-amber','note-color-purple'] as const;
const NoteColor=Mark.create({
  name:'noteColor',
  addAttributes(){return {token:{default:null,
    parseHTML:(element:HTMLElement)=>NOTE_COLOR_TOKENS.find(t=>element.classList.contains(t))??null,
    renderHTML:(attrs:Record<string,unknown>)=>NOTE_COLOR_TOKENS.includes(
      attrs.token as typeof NOTE_COLOR_TOKENS[number])?{class:String(attrs.token)}:{},
  }};},
  parseHTML(){return NOTE_COLOR_TOKENS.map(token=>({tag:'span.'+token}));},
  renderHTML({HTMLAttributes}){return ['span',mergeAttributes(HTMLAttributes),0];},
});

const FileAttachment = Node.create({
  name: 'fileAttachment',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      refId: { default: null },
      fileId: { default: null },
      name: { default: '' },
      kind: { default: 'file' },
      policy: { default: 'latest' },
      pinnedRevision: { default: null },
      mime: { default: '' },
    };
  },
  parseHTML() { return [{ tag: 'div[data-kbw-attachment]' }]; },
  renderHTML({ HTMLAttributes }) {
    const name = String(HTMLAttributes.name || 'Attachment');
    const kind = HTMLAttributes.kind === 'email' ? '✉' : '▣';
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-kbw-attachment': 'true',
      'class': 'kbw-v35-attachment-node',
      'contenteditable': 'false',
    }), kind + '  ' + name];
  },
});

const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      refId: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute('data-kbw-ref'),
        renderHTML: (attrs: Record<string, unknown>) => attrs.refId ? { 'data-kbw-ref': String(attrs.refId) } : {} },
      width: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute('width'),
        renderHTML: (attrs: Record<string, unknown>) => attrs.width ? { width: String(attrs.width) } : {} },
      align: { default: 'center', parseHTML: (el: HTMLElement) => el.getAttribute('data-align'),
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-align': String(attrs.align || 'center') }) },
      caption: { default: '', parseHTML: (el: HTMLElement) => el.getAttribute('data-caption'),
        renderHTML: (attrs: Record<string, unknown>) => attrs.caption ? { 'data-caption': String(attrs.caption) } : {} },
    };
  },
});

export const EXTENSIONS = [
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5] },
    link: { openOnClick: false, autolink: true } }),
  BlockId,
  TableKit.configure({
    tableCell: false, tableHeader: false, tableRow: false,
    table: { resizable: true, cellMinWidth: 64, handleWidth: 8, lastColumnResizable: true },
  }),
  ColoredCell,
  ColoredHeader,
  ResizableRow,
  TaskList,
  TaskItem.configure({ nested: true }),
  ResizableImage.configure({ allowBase64: false }),
  FileAttachment,
  Highlight.configure({ multicolor: false }),
  NoteColor,
  Placeholder.configure({ placeholder: 'Write your Page…  Type / for insert actions.' }),
];

const fileUrl = (id: string, revision?: number) =>
  '/api/file-hub/file?id=' + encodeURIComponent(id) +
  (revision ? '&revision=' + revision : '') + '&mode=download';

const newId = (prefix: string) => {
  if(typeof crypto.randomUUID==='function')return prefix+crypto.randomUUID().replace(/-/g,'');
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
  return prefix+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
};
function ensureCanonicalIds(editor:Editor):boolean {
  const transaction=editor.state.tr;
  const headings=new Set<string>();
  const refs=new Set<string>();
  editor.state.doc.descendants((node,pos)=>{
    if(node.type.name==='heading'){
      let id=typeof node.attrs.blockId==='string'?node.attrs.blockId:'';
      if(!/^blk_[a-zA-Z0-9_-]{8,64}$/.test(id)||headings.has(id)){
        id=newId('blk_');transaction.setNodeMarkup(pos,undefined,{...node.attrs,blockId:id});
      }
      headings.add(id);
    }else if(node.type.name==='image'||node.type.name==='fileAttachment'){
      let id=typeof node.attrs.refId==='string'?node.attrs.refId:'';
      if(!/^ref_[a-zA-Z0-9_-]{8,64}$/.test(id)||refs.has(id)){
        id=newId('ref_');transaction.setNodeMarkup(pos,undefined,{...node.attrs,refId:id});
      }
      refs.add(id);
    }
  });
  if(transaction.docChanged){editor.view.dispatch(transaction);return true;}
  return false;
}
export function editOutlineSubtree(
  editor:Editor,blockId:string,action:'up'|'down'|'indent'|'outdent',
):boolean {
  const doc=editor.state.doc;
  const blocks=Array.from({length:doc.childCount},(_,i)=>doc.child(i));
  const heading=(i:number)=>blocks[i]?.type.name==='heading'?Number(blocks[i]!.attrs.level):null;
  const at=blocks.findIndex(node=>node.type.name==='heading'&&node.attrs.blockId===blockId);
  if(at<0)return false;
  const level=heading(at)!;
  let end=at+1;
  while(end<blocks.length&&(heading(end)===null||heading(end)!>level))end++;
  const previous=()=>{
    for(let i=at-1;i>=0;i--){
      const n=heading(i);
      if(n===level)return i;
      if(n!==null&&n<level)break;
    }
    return -1;
  };
  if(action==='indent'||action==='outdent'){
    if(action==='indent'&&previous()<0)return false;
    if(action==='outdent'&&level<=1)return false;
    const delta=action==='indent'?1:-1;
    let pos=0;
    const positions=blocks.map(node=>{const current=pos;pos+=node.nodeSize;return current;});
    const transaction=editor.state.tr;
    for(let i=at;i<end;i++){
      const n=heading(i);
      if(n!==null){
        if(n+delta<1||n+delta>5)return false;
        transaction.setNodeMarkup(positions[i]!,undefined,{
          ...blocks[i]!.attrs,level:n+delta,
        });
      }
    }
    if(transaction.docChanged)editor.view.dispatch(transaction);
    return transaction.docChanged;
  }
  let replacement;
  if(action==='up'){
    const before=previous();
    if(before<0)return false;
    replacement=[...blocks.slice(0,before),...blocks.slice(at,end),
      ...blocks.slice(before,at),...blocks.slice(end)];
  }else{
    const sibling=end;
    if(sibling>=blocks.length||heading(sibling)!==level)return false;
    let following=sibling+1;
    while(following<blocks.length&&(heading(following)===null||heading(following)!>level))following++;
    replacement=[...blocks.slice(0,at),...blocks.slice(sibling,following),
      ...blocks.slice(at,end),...blocks.slice(following)];
  }
  editor.view.dispatch(editor.state.tr.replaceWith(0,doc.content.size,replacement));
  return true;
}
/** Drag/drop reorders a complete heading subtree only within the same parent.
 * Cross-parent movement must use the explicit indent/outdent controls.
 */
export function dragOutlineBefore(editor:Editor,sourceId:string,targetId:string):boolean {
  if(sourceId===targetId)return false;
  const siblings=new Map<string,{level:number;parent:string|null}>();
  const stack:{id:string;level:number}[]=[];
  editor.state.doc.descendants(node=>{
    if(node.type.name!=='heading')return;
    const id=node.attrs.blockId as string;
    const level=node.attrs.level as number;
    while(stack.length&&stack[stack.length-1]!.level>=level)stack.pop();
    siblings.set(id,{level,parent:stack[stack.length-1]?.id||null});
    stack.push({id,level});
  });
  const source=siblings.get(sourceId),target=siblings.get(targetId);
  if(!source||!target||source.level!==target.level||source.parent!==target.parent)return false;
  const order=[...siblings.entries()]
    .filter(([,entry])=>entry.level===source.level&&entry.parent===source.parent)
    .map(([id])=>id);
  const from=order.indexOf(sourceId),to=order.indexOf(targetId);
  const steps=from>to?from-to:Math.max(0,to-from-1);
  const direction=from>to?'up':'down';
  let changed=false;
  for(let i=0;i<steps;i++){
    if(!editOutlineSubtree(editor,sourceId,direction))break;
    changed=true;
  }
  return changed;
}
function collectHeadings(editor: Editor): HeadingEntry[] {
  const result: HeadingEntry[] = [];
  editor.state.doc.descendants(node => {
    if (node.type.name === 'heading' && node.attrs.blockId) {
      result.push({ id: node.attrs.blockId as string, level: node.attrs.level as number,
        title: node.textContent || 'Untitled outline' });
    }
  });
  return result;
}
function collectAttachments(doc: JSONContent): Attachment[] {
  const all: Attachment[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === 'fileAttachment' && n.attrs &&
      typeof n.attrs.fileId === 'string' && filePattern.test(n.attrs.fileId)) {
      all.push({
        refId: String(n.attrs.refId || ''), fileId: n.attrs.fileId,
        name: String(n.attrs.name || 'Attachment'), kind: String(n.attrs.kind || 'file'),
        policy: String(n.attrs.policy || 'latest'),
        pinnedRevision: Number.isInteger(n.attrs.pinnedRevision) ? n.attrs.pinnedRevision : undefined,
      });
    }
    n.content?.forEach(walk);
  };
  walk(doc);
  return all;
}

/** Non-destructive conversion: no remote image, script, iframe or arbitrary CSS survives paste. */
export function safeStructuredPaste(raw: string): string {
  const clean = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ['p','div','br','b','strong','em','i','u','s','a','h1','h2','h3','h4','h5',
      'blockquote','ul','ol','li','table','thead','tbody','tr','th','td','pre','code','img','hr','span'],
    ALLOWED_ATTR: ['href','src','alt','title','rowspan','colspan','data-kbw-bg',
      ...BORDER_SIDES.map(side=>'data-kbw-border-'+side),
      'height','data-kbw-row-height','width','colwidth'],
    FORBID_TAGS: ['script','style','iframe','object','embed','svg','form'],
    // DOMPurify blocks new data-kbw-border-* attrs when false; prune unknown data-* below.
    ALLOW_DATA_ATTR: true,
    ALLOW_ARIA_ATTR: false,
  });
  const template = document.createElement('template');
  template.innerHTML = String(clean);
  template.content.querySelectorAll('[data-kbw-bg]').forEach(element => {
    const value = element.getAttribute('data-kbw-bg');
    if (!['td','th'].includes(element.tagName.toLowerCase()) ||
        !TABLE_BACKGROUNDS.some(token => token !== 'none' && token === value))
      element.removeAttribute('data-kbw-bg');
  });
  template.content.querySelectorAll('*').forEach(element => {
    for(const attr of Array.from(element.attributes)){
      if(attr.name.startsWith('data-') && !['data-kbw-bg','data-kbw-row-height',
        ...BORDER_SIDES.map(side=>'data-kbw-border-'+side)].includes(attr.name))
        element.removeAttribute(attr.name);
    }
    if(element.tagName.toLowerCase()!=='tr')
      element.removeAttribute('data-kbw-row-height');
    if(!['td','th'].includes(element.tagName.toLowerCase()))
      element.removeAttribute('data-kbw-bg');
    for(const side of BORDER_SIDES){
      const key='data-kbw-border-'+side;
      if(!['td','th'].includes(element.tagName.toLowerCase()) ||
         !isBorderToken(element.getAttribute(key))) element.removeAttribute(key);
    }
  });
  template.content.querySelectorAll('tr').forEach(row => {
    const a=row.getAttribute('data-kbw-row-height') || row.getAttribute('height');
    if(a && /^[0-9]{2,3}$/.test(a) && Number(a)>=MIN_ROW_HEIGHT && Number(a)<=MAX_ROW_HEIGHT) {
      row.setAttribute('height',a);
      row.setAttribute('data-kbw-row-height',a);
    } else {
      row.removeAttribute('height');
      row.removeAttribute('data-kbw-row-height');
    }
  });
  template.content.querySelectorAll('td,th').forEach(cell => {
    const attr=cell.getAttribute('colwidth');
    if(!attr) {cell.removeAttribute('width');return;}
    const widths=attr.split(',');
    if(widths.length>16 || widths.some(w=>!/^\\d{2,4}$/.test(w) ||
      Number(w)<40 || Number(w)>2400)){
      cell.removeAttribute('colwidth');cell.removeAttribute('width');return;
    }
    cell.setAttribute('width',String(widths.map(Number).reduce((a,b)=>a+b,0)));
  });
  template.content.querySelectorAll('img').forEach(img => {
    if (!/^\/api\/file-hub\/file\?id=file_[0-9a-f]{32}&mode=inline$/.test(img.getAttribute('src') || '')) img.remove();
  });
  template.content.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\/[^\s<>]+$/i.test(href) && !/^mailto:[^\s<>]+$/i.test(href) &&
        !/^#\/[-\w/%?.=&]+$/.test(href) && !/^\/app\/n\/[-\w/%?.=&]+$/.test(href)) a.replaceWith(...Array.from(a.childNodes));
  });
  return template.innerHTML;
}

export function StructuredPageEditor({
  pageId, nodeId, nodeKind, initialHtml, initialJson, targetBlockId, onReady, onChange, toolbarTarget,
}: Props) {
  const [error, setError] = useState('');
  const [editorReady,setEditorReady]=useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [draggedOutline,setDraggedOutline]=useState<string|null>(null);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [files, setFiles] = useState<HubFile[]>([]);
  const [outline, setOutline] = useState<HeadingEntry[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [tableActive, setTableActive] = useState(false);
  const [tableScope, setTableScope] = useState<TableColorScope>('cell');
  const [borderScope, setBorderScope] = useState<BorderScope>('selection');
  const [borderPlacement, setBorderPlacement] = useState<BorderPlacement>('all');
  const [borderStyle, setBorderStyle] = useState<BorderStyle>('solid');
  const [borderWidth, setBorderWidth] = useState<BorderWidth>(2);
  const [borderColor, setBorderColor] = useState<BorderColor>('default');
  const [borderOpen, setBorderOpen] = useState(false);
  const [tableMenu, setTableMenu] = useState<{x:number;y:number}|null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [bubble, setBubble] = useState<{x:number;y:number}|null>(null);
  const [selectedImage, setSelectedImage] = useState(false);
  const [pagePickerOpen, setPagePickerOpen] = useState(false);
  const [pageOptions,setPageOptions] = useState<{id:string;ownerId:string;sectionId:string;title:string}[]>([]);
  const [mailPreview,setMailPreview] = useState<{status:string;subject?:string;from?:string;date?:string;body?:string;reason?:string}|null>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Remember the Page cursor before the native file picker removes focus.
  const attachmentInsertPos = useRef<number | null>(null);
  const readyRef = useRef(onReady); readyRef.current = onReady;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  const editorRef = useRef<Editor|null>(null);
  const rowDragRef = useRef<null|{cancel:()=>void}>(null);
  const rowHoverRef = useRef<HTMLTableRowElement|null>(null);
  useEffect(()=>()=>{ rowDragRef.current?.cancel(); },[]);
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const result = JSON.parse(localStorage.getItem('kbw:v35:outline:'+pageId) || '[]');
      return Array.isArray(result) ? result.filter((item): item is string => typeof item === 'string') : [];
    } catch { return []; }
  });
  const collapsedRef = useRef(collapsed); collapsedRef.current = collapsed;

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: initialJson || initialHtml || '<p></p>',
    immediatelyRender: true,
    editorProps: { attributes: {
      class: 'note-editor kbw-v35-content',
      'aria-label': 'Structured Page body',
      'data-v35-editor': 'true',
    },handleKeyDown: (view,event)=>{
      if(event.isComposing||event.key!=='Tab'||event.ctrlKey||event.altKey||event.metaKey)return false;
      const node=view.state.selection.$from.parent;
      if(node.type.name!=='heading'||typeof node.attrs.blockId!=='string')return false;
      const active=editorRef.current;
      const changed=active&&editOutlineSubtree(active,node.attrs.blockId,event.shiftKey?'outdent':'indent');
      if(changed){event.preventDefault();return true;}
      return false;
    }},
    onCreate: ({ editor: instance }) => {
      editorRef.current = instance;
      ensureCanonicalIds(instance);
      readyRef.current(instance.getJSON());
      setTableActive(instance.isActive('table'));
      setEditorReady(true);
    },
    onUpdate: ({ editor: instance }) => {
      if(ensureCanonicalIds(instance))return;
      const sel=instance.state.selection;
      const before=sel.$from.parent.textContent.slice(0,sel.$from.parentOffset);
      setSlashOpen(before.endsWith('/') && sel.empty);
      setTableActive(instance.isActive('table'));
      changeRef.current(instance.getJSON());
    },
    onSelectionUpdate: ({editor:instance})=>{
      setSelectedImage(instance.isActive('image'));
      setTableActive(instance.isActive('table'));
      if(!instance.isActive('table'))setTableMenu(null);
      const selected=instance.state.selection;
      if(selected.empty){setBubble(null);return;}
      const box=window.getSelection()?.rangeCount?window.getSelection()!.getRangeAt(0).getBoundingClientRect():null;
      const holder=instance.view.dom.parentElement?.getBoundingClientRect();
      if(!box||!holder){setBubble(null);return;}
      setBubble({x:Math.max(8,Math.min(box.left-holder.left,holder.width-190)),
        y:Math.max(0,box.top-holder.top-37)});
    },
  });

  const syncOutline = useCallback(() => {
    // Tiptap useEditor may return an Editor instance before EditorContent mounts.
    // Never access editor.view.dom before onCreate confirms the view exists.
    if (!editor || !editorReady || !editor.isInitialized) return;
    const headings = collectHeadings(editor);
    setOutline(headings);
    setAttachments(collectAttachments(editor.getJSON()));
    // Visual-only collapse, never serialized or included in Page Revision.
    const root = editor.view.dom;
    const children = Array.from(root.children) as HTMLElement[];
    const stack: number[] = [];
    for (const child of children) {
      const level = /^H[1-5]$/.test(child.tagName) ? Number(child.tagName[1]) : null;
      if (level !== null) {
        while (stack.length && stack[stack.length-1]! >= level) stack.pop();
      }
      child.classList.toggle('kbw-v35-hidden-block',stack.length>0);
      if (level !== null && collapsedRef.current.includes(child.dataset.blockId || '')) stack.push(level);
    }
  }, [editor,editorReady]);

  useEffect(() => {
    if (!editor || !editorReady) return;
    editor.on('transaction',syncOutline);
    syncOutline();
    return () => { editor.off('transaction',syncOutline); };
  }, [editor,editorReady,syncOutline]);
  useEffect(() => {
    collapsedRef.current = collapsed;
    try { localStorage.setItem('kbw:v35:outline:'+pageId,JSON.stringify(collapsed)); } catch { /* private mode */ }
    syncOutline();
  }, [collapsed,pageId,syncOutline]);

  useEffect(()=>{
    if(!editor||!editorReady||!targetBlockId||!/^blk_[a-zA-Z0-9_-]{8,64}$/.test(targetBlockId))return;
    setCollapsed([]);
    const scroll=()=>{
      const el=editor.view.dom.querySelector('[data-block-id="'+targetBlockId+'"]');
      el?.scrollIntoView({block:'center'});
      el?.classList.add('kbw-v35-target-block');
    };
    const timer=window.setTimeout(scroll,120);
    return ()=>window.clearTimeout(timer);
  },[editor,editorReady,targetBlockId]);
  const images = async (selected: File[]) => {
    if (!editor) return;
    setBusy(true);setError('');
    for (const file of selected) {
      const problem = checkImage(file);
      if (problem) { setError(problem.message); continue; }
      try {
        const saved = await uploadNoteImage(nodeId,file);
        if(editor.isActive('image'))editor.chain().focus().updateAttributes('image',{
          src:saved.url,alt:file.name,
        }).run();
        else editor.chain().focus().setImage({src:saved.url,alt:file.name}).run();
      } catch (e) {setError(e instanceof Error?e.message:'Image upload failed');}
    }
    setBusy(false);
  };

  const addNewFiles = async (selected: File[]) => {
    if (!editor || !selected.length) return;
    let insertPos = attachmentInsertPos.current ?? editor.state.selection.from;
    attachmentInsertPos.current = null;
    setBusy(true);setError('');setUploadStatus('');
    const failures:string[] = [];
    let inserted = 0;
    for (const [index,file] of selected.entries()) {
      setUploadStatus('Uploading '+(index+1)+'/'+selected.length+': '+file.name);
      if (file.size > 100*1024*1024 || !file.size) {
        failures.push(file.name+': attachment must be 1–100 MB');continue;
      }
      const operationId = newId('op_');
      const query = new URLSearchParams({notePageId:pageId,operationId,name:safeName(file.name)});
      try {
        const saved = await postBinary<{fileId:string}>(
          '/api/file-hub/upload?'+query.toString(),file,'application/octet-stream',
          {timeoutMs:300_000});
        if (!filePattern.test(saved.fileId)) throw new Error('Upload response did not contain a valid File ID');
        const kind = /\.(eml|msg)$/i.test(file.name) ? 'email' : 'file';
        const at = Math.max(0,Math.min(insertPos,editor.state.doc.content.size));
        const insertedInPage = editor.chain().focus().setTextSelection(at).insertContent({
          type:'fileAttachment',
          attrs:{refId:newId('ref_'),fileId:saved.fileId,name:file.name,kind,
            policy:kind==='email'?'pinned':'latest',pinnedRevision:kind==='email'?1:null,
            mime:file.type||''},
        }).run();
        if (!insertedInPage) throw new Error('File uploaded but could not be inserted; use Attach Existing to recover it');
        insertPos = editor.state.selection.from;
        inserted++;
      } catch (e) {
        failures.push(file.name+': '+(e instanceof Error?e.message:'Upload failed')+
          ' (check Attach Existing for recoverable uploads)');
      }
    }
    setBusy(false);
    setUploadStatus(inserted ? inserted+' attachment'+(inserted===1?'':'s')+
      ' inserted at the cursor. Waiting for Page auto-save.' : '');
    if (failures.length) setError(failures.join(' · '));
  };

  const openAttachmentChooser = () => {
    if (!editor) {setError('Page editor is not ready.');return;}
    attachmentInsertPos.current = editor.state.selection.from;
    setError('');setUploadStatus('');setMenuOpen(false);setSlashOpen(false);
    fileInput.current?.click();
  };

  const attachExisting = async () => {
    setFilePickerOpen(true);setError('');
    try {
      const [linked,staged] = await Promise.all([
        getJson<{files?:HubFile[]}|HubFile[]>(
          '/api/file-hub/linked?type='+encodeURIComponent(nodeKind)+'&id='+encodeURIComponent(nodeId)),
        get<{items:HubFile[]}>('notebook-v35-staged',{id:nodeId,page:pageId}),
      ]);
      const existing=Array.isArray(linked)?linked:(linked.files||[]);
      const readable=(file:HubFile):HubFile=>({...file,name:file.name||file.path?.split('/').pop()||file.id});
      setFiles([...staged.items.map(readable),
        ...existing.filter(file=>!staged.items.some(s=>s.id===file.id)).map(readable)]);
    } catch (e) {
      setError(e instanceof Error?e.message:'Cannot retrieve File Hub references');
    }
  };

  const linkExisting = (file: HubFile) => {
    if (!editor || !filePattern.test(file.id)) return;
    editor.chain().focus().insertContent({
      type:'fileAttachment',attrs:{
        refId:newId('ref_'),fileId:file.id,name:file.name||file.id,
        kind:/\.(eml|msg)$/i.test(file.name||'')?'email':'file',
        policy:/\.(eml|msg)$/i.test(file.name||'')?'pinned':'latest',
        pinnedRevision:/\.(eml|msg)$/i.test(file.name||'')?file.revision:null,
      },
    }).run();
    setFilePickerOpen(false);
  };

  useEffect(() => {
    if (!editor || !editorReady) return;
    const target = editor.view.dom;
    const paste = (event: ClipboardEvent) => {
      if (event.clipboardData?.files.length) {
        const all = Array.from(event.clipboardData.files);
        event.preventDefault();
        const imageFiles = all.filter(f=>f.type.startsWith('image/'));
        const otherFiles = all.filter(f=>!f.type.startsWith('image/'));
        if (imageFiles.length) void images(imageFiles);
        if (otherFiles.length) void addNewFiles(otherFiles);
      } else if (event.clipboardData?.getData('text/html')) {
        event.preventDefault();
        const safe = safeStructuredPaste(event.clipboardData.getData('text/html'));
        editor.chain().focus().insertContent(safe).run();
      }
    };
    target.addEventListener('paste',paste,true);
    return ()=>target.removeEventListener('paste',paste,true);
    // Editor is stable for this mounted Page; callback closures do not need rerender.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[editor,editorReady]);

  const actions: {label:string;run:()=>void}[] = [
    {label:'Bold',run:()=>editor?.chain().focus().toggleBold().run()},
    {label:'Italic',run:()=>editor?.chain().focus().toggleItalic().run()},
    {label:'Underline',run:()=>editor?.chain().focus().toggleUnderline().run()},
    {label:'Highlight',run:()=>editor?.chain().focus().toggleHighlight().run()},
    {label:'Bullet List',run:()=>editor?.chain().focus().toggleBulletList().run()},
    {label:'Checklist',run:()=>editor?.chain().focus().toggleTaskList().run()},
    {label:'Link',run:()=>{
      const url=window.prompt('Enter HTTP(S), mailto, or Work Page URL:','https://');
      if (url && (/^https?:\/\/[^\s<>]+$/i.test(url)||/^mailto:[^\s<>]+$/i.test(url)||
        /^#\/[-\w/%?.=&]+$/.test(url)||/^\/app\/n\/[-\w/%?.=&]+$/.test(url)))
        editor?.chain().focus().setLink({href:url}).run();
    }},
    {label:'Table',run:()=>editor?.chain().focus().insertTable({rows:3,cols:3,withHeaderRow:true}).run()},
    {label:'Undo',run:()=>editor?.chain().focus().undo().run()},
    {label:'Redo',run:()=>editor?.chain().focus().redo().run()},
  ];
  const pastePlain=async()=>{
    try{
      const plain=await navigator.clipboard.readText();
      if(!plain)return;
      editor?.chain().focus().insertContent(plain.split(/\r?\n/).map(text=>({
        type:'paragraph',...(text?{content:[{type:'text',text}]}:{}),
      }))).run();
    }catch{setError('Clipboard access was blocked. Use Ctrl+Shift+V or your browser Paste as Plain Text action.');}
  };
  const attachPageOptions=async()=>{
    setPagePickerOpen(true);setError('');
    try{
      const result=await get<{items:typeof pageOptions}>('notebook-v35-page-options',{id:nodeId});
      setPageOptions(result.items);
    }catch(e){setError(e instanceof Error?e.message:'Cannot load Page options');}
  };
  const linkPage=(page:{id:string;ownerId:string;sectionId:string;title:string})=>{
    if(!editor)return;
    const href='/app/n/'+encodeURIComponent(page.ownerId)+'/notes?section='+
      encodeURIComponent(page.sectionId)+'&page='+encodeURIComponent(page.id);
    if(!editor.state.selection.empty)editor.chain().focus().setLink({href}).run();
    else editor.chain().focus().insertContent('<a href="'+href+'">'+page.title.replace(/[<>&]/g,'')+'</a>').run();
    setPagePickerOpen(false);
  };
  const previewEmail=async(item:Attachment)=>{
    setError('');setMailPreview(null);
    try{setMailPreview(await get('notebook-v35-email-preview',{id:nodeId,page:pageId,fileId:item.fileId}));}
    catch(e){setError(e instanceof Error?e.message:'Unable to preview email');}
  };
  const insertFromSlash=(run:()=>void)=>{
    if(editor){const s=editor.state.selection;
      if(s.empty&&s.from>0&&s.$from.parent.textContent.slice(0,s.$from.parentOffset).endsWith('/'))
        editor.chain().focus().deleteRange({from:s.from-1,to:s.from}).run();}
    setSlashOpen(false);run();
  };
  const tableCommands: { label:string; short:string; run:()=>boolean; dangerous?:boolean }[] = [
    {label:'Insert row above',short:'↑ Row',run:()=>editor?.chain().focus().addRowBefore().run() || false},
    {label:'Insert row below',short:'↓ Row',run:()=>editor?.chain().focus().addRowAfter().run() || false},
    {label:'Insert column left',short:'← Col',run:()=>editor?.chain().focus().addColumnBefore().run() || false},
    {label:'Insert column right',short:'→ Col',run:()=>editor?.chain().focus().addColumnAfter().run() || false},
    {label:'Delete row',short:'− Row',run:()=>editor?.chain().focus().deleteRow().run() || false,dangerous:true},
    {label:'Delete column',short:'− Col',run:()=>editor?.chain().focus().deleteColumn().run() || false,dangerous:true},
    {label:'Merge cells',short:'Merge',run:()=>editor?.chain().focus().mergeCells().run() || false},
    {label:'Split cell',short:'Split',run:()=>editor?.chain().focus().splitCell().run() || false},
    {label:'Toggle header row',short:'Hdr Row',run:()=>editor?.chain().focus().toggleHeaderRow().run() || false},
    {label:'Toggle header column',short:'Hdr Col',run:()=>editor?.chain().focus().toggleHeaderColumn().run() || false},
    {label:'Delete table',short:'× Table',run:()=>editor?.chain().focus().deleteTable().run() || false,dangerous:true},
  ];
  const runTableCommand = (item:typeof tableCommands[number]) => {
    if (item.run()) setTableMenu(null);
  };
  useEffect(()=>{
    if(!tableMenu)return;
    const outside=(event:PointerEvent)=>{
      if(event.target instanceof Element && !event.target.closest('.kbw-v35-table-context'))
        setTableMenu(null);
    };
    document.addEventListener('pointerdown',outside);
    return ()=>document.removeEventListener('pointerdown',outside);
  },[tableMenu]);
  const borderControls = (contextMenu=false) => <div className="kbw-v35-border-editor"
    role="group" aria-label="Edit table borders">
    <select aria-label="Border target" value={borderScope} onChange={event=>setBorderScope(event.target.value as BorderScope)}>
      <option value="selection">Selected cell(s)</option><option value="row">Row(s)</option>
      <option value="column">Column(s)</option><option value="table">Whole table</option>
    </select>
    <select aria-label="Border placement" value={borderPlacement}
      onChange={event=>setBorderPlacement(event.target.value as BorderPlacement)}>
      <option value="all">All borders</option><option value="outer">Outside borders</option>
      <option value="inner">Inside borders</option><option value="top">Top border</option>
      <option value="right">Right border</option><option value="bottom">Bottom border</option>
      <option value="left">Left border</option>
    </select>
    <select aria-label="Border line style" value={borderStyle}
      onChange={event=>setBorderStyle(event.target.value as BorderStyle)}>
      {BORDER_STYLES.map(style=><option key={style} value={style}>{style}</option>)}
    </select>
    <select aria-label="Border thickness" value={borderWidth}
      onChange={event=>setBorderWidth(Number(event.target.value) as BorderWidth)}>
      {BORDER_WIDTHS.map(width=><option key={width} value={width}>{width}px</option>)}
    </select>
    <select aria-label="Border color" value={borderColor}
      onChange={event=>setBorderColor(event.target.value as BorderColor)}>
      {BORDER_COLORS.map(color=><option key={color} value={color}>{color}</option>)}
    </select>
    <button type="button" aria-label="Apply table borders"
      onMouseDown={event=>event.preventDefault()} onClick={()=>{
        if(editor) setTableBorders(editor,borderScope,borderPlacement,
          makeBorderToken(borderStyle,borderWidth,borderColor));
        if(contextMenu)setTableMenu(null);
      }}>Apply</button>
    <button type="button" aria-label="Remove table borders"
      onMouseDown={event=>event.preventDefault()} onClick={()=>{
        if(editor)setTableBorders(editor,borderScope,borderPlacement,'none');
        if(contextMenu)setTableMenu(null);
      }}>No border</button>
  </div>;
  const tableControls = (contextMenu=false) => <div className={contextMenu?'kbw-v35-table-context-actions':'kbw-v35-table-actions'}>
    {tableCommands.map(item=><button key={item.label} type="button" title={item.label}
      aria-label={item.label} data-danger={item.dangerous?'true':undefined}
      onMouseDown={event=>event.preventDefault()}
      onClick={()=>runTableCommand(item)}>{contextMenu?item.label:item.short}</button>)}
    <button type="button" className="kbw-v35-border-toggle" aria-label="Table border settings"
      aria-expanded={borderOpen} onMouseDown={event=>event.preventDefault()}
      onClick={()=>setBorderOpen(v=>!v)}>▦ Borders</button>
    {borderOpen?borderControls(contextMenu):null}
    <div className="kbw-v35-table-colors" role="group" aria-label="Table background colors">
      <select value={tableScope} aria-label="Background color scope" onChange={event=>
        setTableScope(event.target.value as TableColorScope)}>
        <option value="cell">Cell background</option><option value="row">Row background</option>
        <option value="column">Column background</option>
      </select>
      {TABLE_BACKGROUNDS.map(color=><button key={color} type="button"
        aria-label={'Set '+tableScope+' background '+color}
        title={(color==='none'?'Clear':color)+' '+tableScope+' background'}
        className="kbw-v35-swatch" data-color={color}
        onMouseDown={event=>event.preventDefault()}
        onClick={()=>{if(editor)colorTableSelection(editor,tableScope,color);if(contextMenu)setTableMenu(null);}}>
        {color==='none'?'×':''}</button>)}
    </div>
  </div>;
  const rowAtPointer = (target:EventTarget|null, clientX:number, clientY:number) => {
    if (!(target instanceof Element) || target.closest('.column-resize-handle')) return null;
    const cell=target.closest('td,th');
    if (!(cell instanceof HTMLTableCellElement) || !editor?.view.dom.contains(cell)) return null;
    if (cell.rowSpan > 1) return null; // A spanned cell's bottom is not a single row boundary.
    const row=cell.closest('tr');
    if (!(row instanceof HTMLTableRowElement)) return null;
    const rect=cell.getBoundingClientRect();
    const rowRect=row.getBoundingClientRect();
    // Keep the column handle's bottom-right corner reserved for native column resizing.
    if (Math.abs(clientY-rowRect.bottom)>8 || Math.abs(clientX-rect.right)<=12) return null;
    return row;
  };
  const handleRowBorderHover = (event:ReactPointerEvent<HTMLDivElement>) => {
    if(rowDragRef.current) return;
    const row=rowAtPointer(event.target,event.clientX,event.clientY);
    if(rowHoverRef.current!==row){
      rowHoverRef.current?.classList.remove('kbw-v35-row-edge');
      rowHoverRef.current=row;
      row?.classList.add('kbw-v35-row-edge');
    }
  };
  const handleRowResizeStart = (event:ReactPointerEvent<HTMLDivElement>) => {
    if(!editor || event.button!==0 || rowDragRef.current) return;
    const row=rowAtPointer(event.target,event.clientX,event.clientY);
    if(!row)return;
    let rowPos=-1;
    try {
      const pos=editor.view.posAtDOM(row,0);
      const resolved=editor.state.doc.resolve(pos);
      for(let depth=resolved.depth;depth>0;depth--){
        if(resolved.node(depth).type.name==='tableRow'){rowPos=resolved.before(depth);break;}
      }
    }catch{return;}
    if(rowPos<0 || editor.state.doc.nodeAt(rowPos)?.type.name!=='tableRow')return;
    event.preventDefault();
    setTableMenu(null);
    const pointerId=event.pointerId;
    const startY=event.clientY;
    const startHeight=Math.round(row.getBoundingClientRect().height);
    const previousHeight=row.style.height;
    let latest=startHeight;
    let ended=false;
    document.documentElement.classList.add('kbw-v35-row-dragging');
    row.classList.add('kbw-v35-row-being-resized');
    const move=(e:PointerEvent)=>{
      if(e.pointerId!==pointerId)return;
      latest=Math.max(MIN_ROW_HEIGHT,Math.min(MAX_ROW_HEIGHT,
        Math.round(startHeight+(e.clientY-startY))));
      row.style.height=latest+'px';
      e.preventDefault();
    };
    const cleanup=()=>{
      if(ended)return false;
      ended=true;
      document.removeEventListener('pointermove',move);
      document.removeEventListener('pointerup',up);
      document.removeEventListener('pointercancel',cancel);
      document.removeEventListener('keydown',key);
      window.removeEventListener('blur',cancel);
      document.documentElement.classList.remove('kbw-v35-row-dragging');
      row.classList.remove('kbw-v35-row-being-resized','kbw-v35-row-edge');
      row.style.height=previousHeight;
      rowHoverRef.current=null;
      rowDragRef.current=null;
      return true;
    };
    const commit=()=>{
      if(!cleanup())return;
      if(Math.abs(latest-startHeight)>=2) setTableRowHeight(editor,rowPos,latest);
    };
    const up=(e:PointerEvent)=>{if(e.pointerId===pointerId)commit();};
    const cancel=()=>{cleanup();};
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();cancel();}};
    document.addEventListener('pointermove',move,{passive:false});
    document.addEventListener('pointerup',up);
    document.addEventListener('pointercancel',cancel);
    document.addEventListener('keydown',key);
    window.addEventListener('blur',cancel);
    rowDragRef.current={cancel};
  };
  const toolbar = <div className="kbw-v35-toolbar" role="toolbar" aria-label="Page rich text tools">
    <select aria-label="Outline level" defaultValue="paragraph" onChange={e=>{
      const value=e.currentTarget.value;
      if (value==='paragraph') editor?.chain().focus().setParagraph().run();
      else editor?.chain().focus().setHeading({level:Number(value) as 1|2|3|4|5}).run();
    }}>
      <option value="paragraph">Text</option>{[1,2,3,4,5].map(n=><option key={n} value={n}>H{n}</option>)}
    </select>
    {actions.slice(0,4).map(item=><button key={item.label} type="button"
      title={item.label} aria-label={item.label}
      onMouseDown={event=>event.preventDefault()} onClick={item.run}>
      {({Bold:'B',Italic:'I',Underline:'U',Highlight:'◐'} as Record<string,string>)[item.label]}</button>)}
    <select aria-label="Text color" defaultValue="" onChange={e=>{
      if(e.target.value==='default')editor?.chain().focus().unsetMark('noteColor').run();
      else editor?.chain().focus().setMark('noteColor',{token:e.target.value}).run();
      e.target.value='';
    }}><option value="" disabled>Color</option><option value="default">Default</option>
      <option value="note-color-blue">Blue</option><option value="note-color-green">Green</option>
      <option value="note-color-red">Red</option><option value="note-color-amber">Amber</option>
      <option value="note-color-purple">Purple</option></select>
    <button type="button" aria-label="Outline panel" aria-expanded={outlineOpen}
      onClick={()=>setOutlineOpen(v=>!v)}>☷ Outline</button>
    <button type="button" aria-label="Attachments" aria-expanded={attachmentOpen}
      onClick={()=>setAttachmentOpen(v=>!v)}>▤ Files ({attachments.length})</button>
    <button type="button" aria-label="Insert" aria-expanded={menuOpen} onClick={()=>setMenuOpen(v=>!v)}>+ Insert</button>
    {menuOpen?<div className="kbw-v35-insert-menu" role="group" aria-label="Insert options">
      {actions.slice(4).map(item=><button key={item.label} type="button" onMouseDown={e=>e.preventDefault()}
        onClick={()=>{item.run();setMenuOpen(false);}}>{item.label}</button>)}
      <button type="button" onClick={()=>imgInput.current?.click()}>Insert Picture</button>
      <button type="button" onMouseDown={e=>e.preventDefault()} onClick={openAttachmentChooser}>Upload Attachment</button>
      <button type="button" onClick={()=>void attachExisting()}>Attach Existing</button>
      <button type="button" onClick={()=>void attachPageOptions()}>Link Another Page</button>
      <button type="button" onClick={()=>void pastePlain()}>Paste as Plain Text</button>
      <button type="button" onClick={()=>editor?.chain().focus().setHorizontalRule().run()}>Divider</button>
    </div>:null}
    <input type="file" ref={imgInput} hidden multiple accept="image/png,image/jpeg,image/webp,image/gif"
      onChange={e=>{void images(Array.from(e.target.files||[]));e.target.value='';}}/>
    <input type="file" ref={fileInput} hidden multiple
      onChange={e=>{void addNewFiles(Array.from(e.target.files||[]));e.target.value='';}}/>
  </div>;

  return <section className="kbw-v35-editor" data-page-id={pageId}>
    {toolbarTarget?createPortal(toolbar,toolbarTarget):toolbar}
    {busy?<p role="status" className="kbw-v35-upload-status">{uploadStatus || 'Uploading attachment…'}</p>:null}
    {error?<p role="alert" className="kbw-v35-upload-error">{error}</p>:null}
    {!busy&&!error&&uploadStatus?<p role="status" className="kbw-v35-upload-status">{uploadStatus}</p>:null}
    {outlineOpen?<aside className="kbw-v35-outline" aria-label="Page outline">
      <strong>Outline · {outline.length} headings</strong>
      {outline.length===0?<span>Use H1–H5 to create a collapsible outline.</span>:null}
      {outline.map(entry=><div key={entry.id} className="kbw-v35-outline-item"
        style={{paddingInlineStart:(entry.level-1)*15}} draggable
        data-dragged={draggedOutline===entry.id?'true':undefined}
        title="Drag to move this heading and its children before a sibling; use ⇤/⇥ for levels"
        onDragStart={event=>{setDraggedOutline(entry.id);event.dataTransfer?.setData('text/plain',entry.id);}}
        onDragOver={event=>{if(draggedOutline)event.preventDefault();}}
        onDragEnd={()=>setDraggedOutline(null)}
        onDrop={event=>{event.preventDefault();if(editor&&draggedOutline)dragOutlineBefore(editor,draggedOutline,entry.id);
          setDraggedOutline(null);}}>
        <button type="button" aria-label={'Toggle '+entry.title}
          aria-expanded={!collapsed.includes(entry.id)} onClick={()=>
            setCollapsed(curr=>curr.includes(entry.id)?
              curr.filter(id=>id!==entry.id):[...curr,entry.id])}>
          {collapsed.includes(entry.id)?'▸':'▾'}
        </button>
        <button type="button" onClick={()=>{
          setCollapsed(curr=>curr.filter(id=>id!==entry.id));
          const target=editor?.view.dom.querySelector('[data-block-id="'+entry.id+'"]');
          target?.scrollIntoView({block:'center',behavior:'smooth'});
        }}>{entry.title}</button>
        <span className="kbw-v35-outline-actions">
          {(['up','down','outdent','indent'] as const).map(action=><button
            key={action} type="button" title={action+' entire heading subtree'}
            aria-label={action+' heading subtree: '+entry.title}
            onMouseDown={e=>e.preventDefault()}
            onClick={()=>{if(editor)editOutlineSubtree(editor,entry.id,action);}}>
            {({up:'↑',down:'↓',outdent:'⇤',indent:'⇥'} as const)[action]}</button>)}
        </span>
        <button type="button" aria-label={'Copy deep link to '+entry.title} onClick={()=>{
          const url=window.location.origin+window.location.pathname+
            window.location.search.replace(/([?&])block=[^&]*&?/,'$1').replace(/[?&]$/,'')+
            (window.location.search.includes('?')?'&':'?')+'block='+encodeURIComponent(entry.id);
          void navigator.clipboard?.writeText(url).catch(()=>window.prompt('Copy link',url));
        }}>↗</button>
      </div>)}
    </aside>:null}
    {pagePickerOpen?<div className="kbw-v35-file-picker" role="dialog" aria-label="Link a Page">
      <strong>Link Page · Same Project</strong>
      <button type="button" onClick={()=>setPagePickerOpen(false)} aria-label="Close Page picker">✕</button>
      {pageOptions.map(page=><button type="button" key={page.id} onClick={()=>linkPage(page)}>{page.title}</button>)}
      {!pageOptions.length?<span>No other Pages found.</span>:null}
    </div>:null}
    {filePickerOpen?<div className="kbw-v35-file-picker" role="dialog" aria-label="Attach existing File Hub item">
      <strong>Files associated with this Work level + recoverable pending uploads</strong>
      <button type="button" onClick={()=>setFilePickerOpen(false)} aria-label="Close file picker">✕</button>
      {files.map(file=><button type="button" key={file.id}
        onClick={()=>linkExisting(file)}>{file.name||file.id}</button>)}
      {files.length===0?<span>No linked files available. Upload a new attachment instead.</span>:null}
    </div>:null}
    {tableActive?<div className="kbw-v35-table-tools" role="toolbar" aria-label="Table editing tools">
      <span className="kbw-v35-table-tools-label">Table</span>{tableControls()}
    </div>:null}
    {slashOpen?<div className="kbw-v35-slash" role="group" aria-label="Slash insert menu">
      <span>Insert using /</span>
      <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>insertFromSlash(()=>editor?.chain().focus().toggleTaskList().run())}>☑ Checklist</button>
      <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>insertFromSlash(()=>editor?.chain().focus().insertTable({rows:3,cols:3,withHeaderRow:true}).run())}>▤ Table</button>
      <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>insertFromSlash(()=>imgInput.current?.click())}>▣ Picture</button>
      <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>insertFromSlash(openAttachmentChooser)}>▦ File</button>
      <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>insertFromSlash(()=>void attachPageOptions())}>↗ Link Page</button>
    </div>:null}
    {selectedImage?<div className="kbw-v35-image-controls" role="group" aria-label="Selected image actions">
      <button type="button" onClick={()=>{
        const width=window.prompt('Image width in pixels (40–2400)','480');
        if(width&&/^\d+$/.test(width)&&Number(width)>=40&&Number(width)<=2400)
          editor?.chain().focus().updateAttributes('image',{width:Number(width)}).run();
      }}>Resize</button>
      {(['left','center','right'] as const).map(align=><button key={align} type="button"
        onClick={()=>editor?.chain().focus().updateAttributes('image',{align}).run()}>{align}</button>)}
      <button type="button" onClick={()=>imgInput.current?.click()}>Replace</button>
      <button type="button" onClick={()=>{
        const caption=window.prompt('Image description / caption','');
        if(caption!==null)editor?.chain().focus().updateAttributes('image',{caption}).run();
      }}>Caption</button>
    </div>:null}
    <div className="kbw-v35-canvas-wrap"
      onPointerMove={handleRowBorderHover}
      onPointerLeave={()=>{rowHoverRef.current?.classList.remove('kbw-v35-row-edge');rowHoverRef.current=null;}}
      onPointerDownCapture={handleRowResizeStart}
      onContextMenu={event=>{
      const cell=(event.target as HTMLElement).closest('td,th');
      if(!cell||!editor||!editor.view.dom.contains(cell))return;
      event.preventDefault();
      // Right-click targets that cell, even when the previous cursor was elsewhere.
      try{editor.commands.setTextSelection(editor.view.posAtDOM(cell,0));}catch{/* preserve selection */}
      setTableActive(true);
      const area=event.currentTarget.getBoundingClientRect();
      setTableMenu({x:Math.max(4,Math.min(event.clientX-area.left,area.width-260)),
        y:Math.max(4,event.clientY-area.top)});
    }} onKeyDown={event=>{if(event.key==='Escape')setTableMenu(null);}}>
      <EditorContent editor={editor} />
      {tableMenu?<div className="kbw-v35-table-context" role="menu" aria-label="Table context menu"
        style={{left:tableMenu.x,top:tableMenu.y}}>
        <div className="kbw-v35-table-context-head"><strong>Table</strong>
          <button type="button" aria-label="Close table menu" onClick={()=>setTableMenu(null)}>×</button>
        </div>
        {tableControls(true)}
      </div>:null}
      {bubble?<div className="kbw-v35-bubble" role="toolbar" aria-label="Selected text formatting"
        style={{left:bubble.x,top:bubble.y}}>
        <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>editor?.chain().focus().toggleBold().run()}>B</button>
        <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>editor?.chain().focus().toggleItalic().run()}>I</button>
        <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>editor?.chain().focus().toggleHighlight().run()}>◐</button>
      </div>:null}
    </div>
    {attachmentOpen?<div className="kbw-v35-attachments" aria-label="Page attachments">
      <strong>Page attachments ({attachments.length})</strong>
      {attachments.map(item=><div className="kbw-v35-attachment-row" key={item.refId}>
        <span>{item.kind==='email'?'✉':'▣'} {item.name}</span>
        <span className="muted">{item.policy==='pinned'?'Pinned Rev '+item.pinnedRevision:'Latest'}</span>
        {item.kind==='email'?<button type="button" onClick={()=>void previewEmail(item)}>Preview</button>:null}
        <a href={fileUrl(item.fileId,item.pinnedRevision)} target="_blank"
          rel="noopener noreferrer">Download</a>
      </div>)}
    </div>:null}
    {mailPreview?<div className="kbw-v35-mail-preview" role="region" aria-label="Safe email preview">
      <button type="button" onClick={()=>setMailPreview(null)} aria-label="Close email preview">✕</button>
      {mailPreview.status==='preview'?<>
        <strong>{mailPreview.subject||'Untitled email'}</strong>
        <small>From: {mailPreview.from||'Unknown'} · {mailPreview.date||'No date'}</small>
        <pre>{mailPreview.body||'(No plain-text body)'}</pre>
      </>:<span>{mailPreview.reason||'No safe preview available. Download the original file.'}</span>}
    </div>:null}
  </section>;
}
