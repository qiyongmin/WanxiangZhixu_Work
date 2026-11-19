"""Read-only, local-only Office preview generation for Work File Hub.

Original canonical documents are never opened for writing. LibreOffice is
optional: if unavailable the UI explicitly falls back to extracted text.
The XLSX sheet browser is separately available using openpyxl.
"""
from __future__ import annotations
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from collections import OrderedDict

import file_hub

CACHE_ROOT = file_hub.DATA / 'office-preview-cache'
MAX_OFFICE_BYTES = 35 * 1024 * 1024
MAX_PDF_BYTES = 75 * 1024 * 1024
_LOCK = threading.RLock()

class PreviewUnavailable(ValueError):
    pass

def _trusted(fid):
    source, name = file_hub.content(fid)
    # Do not allow the preview renderer to process arbitrary file system paths.
    if not source.resolve().is_relative_to(file_hub.LIBRARY) or source.is_symlink():
        raise PreviewUnavailable('Invalid Office source')
    if source.stat().st_size > MAX_OFFICE_BYTES:
        raise PreviewUnavailable('Office preview exceeds 35 MB')
    ext=source.suffix.lower()
    if ext not in ('.doc','.docx','.odt','.rtf','.xls','.xlsx','.ods','.ppt','.pptx','.odp'):
        raise PreviewUnavailable('Not an Office document')
    return source,name,ext

def status(fid):
    source,name,ext = _trusted(fid)
    converter=shutil.which('libreoffice') or shutil.which('soffice')
    return {'name':name,'format':ext,'pdfAvailable':bool(converter),
            'sheetAvailable':ext=='.xlsx' and _openpyxl_available(),
            'reason':None if converter else 'Local LibreOffice is not installed; the original and text-only preview remain available'}

def _openpyxl_available():
    try:
        import openpyxl
        return True
    except ImportError:
        return False

def sheet(fid, index=0, start=0, limit=100):
    source,_,ext=_trusted(fid)
    if ext!='.xlsx':raise PreviewUnavailable('Sheet browser supports XLSX only')
    if not isinstance(index,int) or not isinstance(start,int) or not isinstance(limit,int):
        raise PreviewUnavailable('Invalid sheet selector')
    if index<0 or start<0 or limit<1 or limit>150:
        raise PreviewUnavailable('Invalid sheet range')
    import openpyxl
    book=openpyxl.load_workbook(source,read_only=True,data_only=True,keep_links=False)
    try:
        if index>=len(book.worksheets):raise PreviewUnavailable('Sheet index out of range')
        worksheet=book.worksheets[index]
        count=min(worksheet.max_column or 0,80)
        # Bounded streaming; never recalculate formulas or execute document content.
        rows=[]
        for row in worksheet.iter_rows(min_row=start+1,max_row=start+limit, min_col=1,max_col=max(1,count),values_only=True):
            rows.append([str(x)[:300] if x is not None else '' for x in row])
        return {'sheets':[{'name':ws.title,'rows':ws.max_row,'columns':ws.max_column} for ws in book.worksheets[:60]],
                'sheetIndex':index,'start':start,'limit':limit,'rows':rows,'totalRows':worksheet.max_row or 0,
                'truncatedColumns':(worksheet.max_column or 0)>80}
    finally:
        book.close()

def pdf(fid):
    source,_,ext=_trusted(fid)
    converter=shutil.which('libreoffice') or shutil.which('soffice')
    if not converter:raise PreviewUnavailable('LibreOffice is not installed')
    digest=file_hub._sha(source)
    # Digest + renderer identity; a content revision always creates a fresh key.
    identity=hashlib.sha256((digest+'|lo-pdf-v1|'+ext).encode()).hexdigest()
    CACHE_ROOT.mkdir(parents=True,exist_ok=True)
    cached=CACHE_ROOT/(identity+'.pdf')
    if cached.is_file() and 0<cached.stat().st_size<=MAX_PDF_BYTES:
        return cached
    with _LOCK:
        if cached.is_file() and 0<cached.stat().st_size<=MAX_PDF_BYTES:
            return cached
        with tempfile.TemporaryDirectory(prefix='kbw-office-') as temp:
            base=Path(temp)
            profile=base/'lo-profile'
            incoming=base/('input'+ext)
            # Copy into isolated workspace; do not let a converter write alongside Work data.
            shutil.copyfile(source,incoming)
            env={k:v for k,v in os.environ.items() if k not in ('http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY')}
            env.update({'HOME':str(base),'TMPDIR':str(base),'SAL_USE_VCLPLUGIN':'gen'})
            command=[converter,'-env:UserInstallation=file://'+str(profile),
                     '--headless','--convert-to','pdf','--outdir',str(base),str(incoming)]
            try:
                subprocess.run(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE,check=True,timeout=50,env=env)
            except (subprocess.TimeoutExpired,subprocess.CalledProcessError,OSError) as exc:
                raise PreviewUnavailable('Office PDF conversion failed') from exc
            output=base/'input.pdf'
            if not output.is_file() or not (0<output.stat().st_size<=MAX_PDF_BYTES):
                raise PreviewUnavailable('Office conversion did not produce a valid PDF')
            with output.open('rb') as inp:
                if inp.read(5)!=b'%PDF-':raise PreviewUnavailable('Office renderer returned non-PDF')
            scratch=CACHE_ROOT/(identity+'.tmp-'+str(os.getpid()))
            try:
                shutil.copyfile(output,scratch)
                os.replace(scratch,cached)
            finally:
                scratch.unlink(missing_ok=True)
    return cached
