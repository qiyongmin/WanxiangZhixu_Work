import { get, post } from './api';

export type NotebookDeleteKind = 'section' | 'page' | 'event';
export interface NotebookDeletePreview {
  kind:NotebookDeleteKind; targetId:string; ownerId:string; title:string;
  signature:string; archived:boolean; pageCount:number; archivedPageCount:number;
  linkedEventCount:number; attachmentRefs:number; legacyPageCount:number;
  linkedPageCount?:number; linkedTaskCount?:number;
}

/** Never submit a deletion until the server has supplied the exact impact
 * snapshot, the title has been typed verbatim, and the final warning accepted.
 * Return false only when the user cancels.
 */
export async function permanentlyDeleteNotebookItem(
  kind:NotebookDeleteKind,ownerId:string,targetId:string,
):Promise<boolean> {
  const preview=await get<NotebookDeletePreview>('notebook-delete-preview',
    {kind,id:ownerId,targetId});
  const noun=kind==='section'?'Section':kind==='page'?'Page':'Event';
  const impact=kind==='section'
    ? `This will permanently delete ALL ${preview.pageCount} Pages (${preview.archivedPageCount} archived) and their revision histories, dates and page indexes. ${preview.linkedEventCount} Event link(s) will be detached.`
    :kind==='page'
    ? `Its content, all revisions, indexes and ${preview.linkedEventCount} Event link(s) will be deleted. Linked Events remain.`
    : `The Event and its revision history will be deleted; ${preview.linkedPageCount||0} linked Pages and ${preview.linkedTaskCount||0} Tasks remain.`;
  const files=kind!=='event'
    ? ` File Hub originals stay untouched (${preview.attachmentRefs} references in scope).`:'';
  const legacy=preview.legacyPageCount
    ? ' Historical copies in older Work Node revision snapshots may still exist.':'';
  const typed=window.prompt(
    `DELETE ${noun} PERMANENTLY: "${preview.title}"\n\n${impact}${files}${legacy}\n\nThere is NO Restore or Undo. Type the exact ${noun} name to continue:`,'');
  if(typed===null)return false;
  if(typed!==preview.title)throw new Error('Exact title did not match. Nothing was deleted.');
  if(!window.confirm(`LAST CONFIRMATION: Permanently DELETE ${noun} "${preview.title}" and its owned Notebook data? This cannot be undone.`))
    return false;
  await post('notebook-permanent-delete',{
    id:ownerId,kind,targetId,signature:preview.signature,
    confirm:'DELETE PERMANENTLY',confirmTitle:typed,
  });
  return true;
}
