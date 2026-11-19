import { useEffect, useState, type ReactNode } from 'react';
import { getJson } from '../../lib/api';
import { describeError } from '../../lib/errors';

interface OfficeStatus {
  name: string;
  format: string;
  pdfAvailable: boolean;
  sheetAvailable: boolean;
  reason?: string | null;
}
interface SheetResult {
  sheets: Array<{ name: string; rows: number; columns: number }>;
  sheetIndex: number;
  start: number;
  limit: number;
  rows: string[][];
  totalRows: number;
  truncatedColumns: boolean;
}
export function OfficePreview({ fileId, name, fallback }: { fileId: string; name: string; fallback: ReactNode }) {
  const [status, setStatus] = useState<OfficeStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [mode, setMode] = useState<'sheet' | 'pdf' | 'text' | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [sheet, setSheet] = useState<SheetResult | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStatus(null); setProblem(null); setMode(null);
    getJson<OfficeStatus>(`/api/file-hub/office/status?id=${encodeURIComponent(fileId)}`, { signal: controller.signal })
      .then((result) => {
        setStatus(result);
        // Preserve document layout by default; Sheet Browser remains a secondary mode.
        setMode(result.pdfAvailable ? 'pdf' : result.sheetAvailable ? 'sheet' : 'text');
      }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setProblem(describeError(error)); setMode('text');
      });
    return () => controller.abort();
  }, [fileId]);

  useEffect(() => {
    if (mode !== 'sheet' || !status?.sheetAvailable) return undefined;
    const controller = new AbortController();
    setSheet(null); setSheetError(null);
    getJson<SheetResult>(
      `/api/file-hub/office/sheet?id=${encodeURIComponent(fileId)}&index=${sheetIndex}&start=${offset}&limit=80`,
      { signal: controller.signal, timeoutMs: 30000 })
      .then(setSheet).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setSheetError(describeError(error));
      });
    return () => controller.abort();
  }, [fileId, sheetIndex, offset, mode, status?.sheetAvailable]);

  return <section className="office-preview" aria-label={`Office preview: ${name}`}>
    {status ? <div className="office-preview-modes" role="group" aria-label="Office preview mode">
      {status.sheetAvailable ? <button type="button" className={mode === 'sheet' ? 'btn is-active' : 'btn'} aria-pressed={mode === 'sheet'} onClick={() => setMode('sheet')}>Sheets</button> : null}
      {status.pdfAvailable ? <button type="button" className={mode === 'pdf' ? 'btn is-active' : 'btn'} aria-pressed={mode === 'pdf'} onClick={() => setMode('pdf')}>{status.sheetAvailable ? 'Print preview (PDF)' : 'PDF preview'}</button> : null}
      <button type="button" className={mode === 'text' ? 'btn is-active' : 'btn'} aria-pressed={mode === 'text'} onClick={() => setMode('text')}>Extracted text</button>
    </div> : <p className="muted">Checking local Office preview capabilities…</p>}
    {problem ? <p className="muted" role="status">Preview conversion unavailable: {problem}. Showing extracted text.</p> : null}
    {status?.reason && !status.pdfAvailable ? <p className="muted" role="status">{status.reason}</p> : null}
    {mode === 'pdf' ? <div className="office-pdf-preview">
      <iframe className="preview-frame" title={`PDF: ${name}`}
        src={`/api/file-hub/office/pdf?id=${encodeURIComponent(fileId)}`} />
      <p className="muted">Read-only generated PDF. For authoritative formatting and Office editing, use the original file.</p>
      <button type="button" className="btn" onClick={() => setMode('text')}>PDF unavailable? Show extracted text</button>
    </div> : null}
    {mode === 'sheet' ? <div className="office-sheet-browser">
      {sheet ? <>
        <div className="office-sheet-tabs" role="group" aria-label="Excel sheets">
          {sheet.sheets.map((item, index) =>
            <button type="button" key={item.name} className={sheetIndex === index ? 'btn is-active' : 'btn'}
              aria-pressed={sheetIndex === index}
              onClick={() => { setSheetIndex(index); setOffset(0); }}>{item.name}</button>)}
        </div>
        <p className="muted">Read-only cached cell values · rows {sheet.start + 1}–{Math.min(sheet.start + sheet.limit, sheet.totalRows)} of {sheet.totalRows}{sheet.truncatedColumns ? ' · first 80 columns shown' : ''}</p>
        <div className="office-sheet-scroll" role="region" tabIndex={0} aria-label="Excel sheet cells">
          <table className="office-sheet-table"><thead><tr><th scope="col">#</th>
            {(sheet.rows[0] ?? []).map((_, i) => <th scope="col" key={i}>{i + 1}</th>)}</tr></thead>
            <tbody>{sheet.rows.map((row, i) => <tr key={sheet.start + i}><th scope="row">{sheet.start + i + 1}</th>
              {row.map((cell, j) => <td key={j} title={cell}>{cell}</td>)}</tr>)}</tbody></table>
        </div>
        <div className="office-sheet-paging">
          <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 80))}>Previous rows</button>
          <button type="button" className="btn" disabled={offset + 80 >= sheet.totalRows} onClick={() => setOffset(offset + 80)}>Next rows</button>
        </div>
      </> : <p role="status" className="muted">{sheetError ? `Sheet preview failed: ${sheetError}` : 'Loading sheet…'}</p>}
      {sheetError ? <button type="button" className="btn" onClick={() => setMode('text')}>Show extracted text instead</button> : null}
    </div> : null}
    {mode === 'text' ? fallback : null}
  </section>;
}
