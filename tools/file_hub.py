"""Unified File Hub: local canonical files, stable IDs, revisions and relationships.

This module owns only library/ and content/file-hub/. It never modifies legacy
Work Hub records or externally located project files.
"""
from __future__ import annotations
import base64
import hashlib
import importlib
import sys
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import uuid
import zipfile

ROOT = Path(__file__).resolve().parent.parent
LIBRARY = Path(os.environ.get("KB_FILE_HUB_LIBRARY",str(ROOT / "library"))).resolve()
DATA = Path(os.environ.get("KB_FILE_HUB_DATA",str(ROOT / "content" / "file-hub"))).resolve()
DB = DATA / "catalog.sqlite3"
VERSIONS = DATA / "versions"
TRASH = DATA / "trash"
TOP = ("Projects", "General", "Shared")
MAX_FILE = 100 * 1024 * 1024
MAX_HISTORY = 20
_lock = threading.RLock()

class Conflict(ValueError): pass
class Missing(ValueError): pass


def _local_legacy_extension():
    try:
        return importlib.import_module("work_local_extensions")
    except ModuleNotFoundError as error:
        if error.name == "work_local_extensions":
            return None
        raise

def _db():
    DATA.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=20)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("""CREATE TABLE IF NOT EXISTS files(
      id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, sha TEXT NOT NULL,
      size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, inode TEXT,
      revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      indexed_at REAL NOT NULL DEFAULT 0, created REAL NOT NULL,
      updated REAL NOT NULL)""")
    con.execute("""CREATE TABLE IF NOT EXISTS versions(
      file_id TEXT, revision INTEGER, sha TEXT, size INTEGER, source TEXT,
      locked INTEGER NOT NULL DEFAULT 0, at REAL,
      PRIMARY KEY(file_id,revision))""")
    con.execute("""CREATE TABLE IF NOT EXISTS documents(
      file_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      business_version TEXT, last_uploaded_name TEXT, updated REAL NOT NULL)""")
    con.execute("""CREATE TABLE IF NOT EXISTS document_versions(
      file_id TEXT NOT NULL, revision INTEGER NOT NULL, business_version TEXT,
      PRIMARY KEY(file_id,revision))""")
    con.execute("""CREATE TABLE IF NOT EXISTS material_version_pins(
      file_id TEXT NOT NULL, material_id TEXT NOT NULL, revision INTEGER NOT NULL,
      created REAL NOT NULL, PRIMARY KEY(file_id,material_id))""")
    con.execute("""CREATE TABLE IF NOT EXISTS links(
      file_id TEXT, target_type TEXT, target_id TEXT, relation TEXT DEFAULT 'related',
      PRIMARY KEY(file_id,target_type,target_id,relation))""")
    con.execute("""CREATE TABLE IF NOT EXISTS note_page_version_pins(
      file_id TEXT NOT NULL, page_id TEXT NOT NULL, ref_id TEXT NOT NULL,
      revision INTEGER NOT NULL, created REAL NOT NULL,
      PRIMARY KEY(file_id,page_id,ref_id))""")
    con.execute("""CREATE TABLE IF NOT EXISTS tags(
      file_id TEXT, tag TEXT, PRIMARY KEY(file_id,tag))""")
    con.execute("""CREATE TABLE IF NOT EXISTS audit(
      id TEXT PRIMARY KEY, file_id TEXT, operation TEXT, detail TEXT, at REAL)""")
    con.execute("""CREATE TABLE IF NOT EXISTS pending(
      path TEXT PRIMARY KEY, reason TEXT, candidates TEXT, at REAL)""")
    con.execute("""CREATE TABLE IF NOT EXISTS shortcuts(
      id TEXT PRIMARY KEY, file_id TEXT NOT NULL, folder TEXT NOT NULL,
      created REAL NOT NULL, UNIQUE(file_id,folder))""")
    con.execute("""CREATE TABLE IF NOT EXISTS media_aliases(
      media_id TEXT PRIMARY KEY, file_id TEXT NOT NULL, material_id TEXT,
      sha TEXT NOT NULL, file_name TEXT NOT NULL, created REAL NOT NULL)""")
    try:
        con.execute("CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(file_id UNINDEXED, path, body)")
    except sqlite3.OperationalError: pass
    return con

def _init():
    for top in TOP: (LIBRARY / top).mkdir(parents=True,exist_ok=True)
    VERSIONS.mkdir(parents=True,exist_ok=True)
    TRASH.mkdir(parents=True,exist_ok=True)

def _rel(value, *, allow_root=False):
    if not isinstance(value,str): raise ValueError("Invalid path")
    value=value.replace("\\","/")
    if (not value and allow_root): return ""
    parts=value.split("/")
    if not parts or parts[0] not in TOP or any(
      part in ("",".","..") or part.startswith(".") or ":" in part or "\x00" in part
      for part in parts):
        raise ValueError("Path must be within a library collection")
    return "/".join(parts)

def _path(rel):
    rel=_rel(rel)
    path=LIBRARY.joinpath(*rel.split("/"))
    # Reject symlinks anywhere in the path, including the final item.
    cur=LIBRARY
    for part in rel.split("/"):
        cur=cur/part
        if cur.is_symlink():raise ValueError("Symlink paths are not supported")
    if not path.resolve().is_relative_to(LIBRARY.resolve()):
        raise ValueError("Path outside library")
    return path

def _file(fid,con):
    row=con.execute("SELECT * FROM files WHERE id=?",(fid,)).fetchone()
    if not row:raise Missing("File not found")
    return row

def _sha(path):
    h=hashlib.sha256()
    with path.open("rb") as stream:
        for b in iter(lambda:stream.read(1024*1024),b""):h.update(b)
    return h.hexdigest()

def _stat(path):
    st=path.stat()
    return st.st_size,st.st_mtime_ns,str(st.st_dev)+":"+str(st.st_ino)

def _audit(con,fid,op,detail=""):
    con.execute("INSERT INTO audit VALUES(?,?,?,?,?)",
                (uuid.uuid4().hex,fid,op,json.dumps(detail,ensure_ascii=False),time.time()))

def _blob(sha):return VERSIONS / sha[:2] / sha

def _preserve(path,sha):
    target=_blob(sha)
    if target.exists():return
    target.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent,delete=False) as tmp:
        name=tmp.name
        with path.open("rb") as src:shutil.copyfileobj(src,tmp,1024*1024)
        tmp.flush();os.fsync(tmp.fileno())
    if hashlib.sha256(Path(name).read_bytes()).hexdigest()!=sha:
        Path(name).unlink(missing_ok=True)
        raise Conflict("Concurrent file modification")
    os.replace(name,target)

def _index(con,fid,path,rev):
    ext=path.suffix.lower()
    body=""
    try:
        if ext in (".md",".txt",".csv",".json",".py",".html",".css",".js",".xml",".svg"):
            if path.stat().st_size<=2_000_000:
                body=path.read_text(encoding="utf-8",errors="replace")
                if ext in (".html",".svg"):
                    body=re.sub(r"<[^>]+>"," ",body)
        elif ext==".pdf" and path.stat().st_size<=25_000_000:
            try:
                import fitz
                with fitz.open(path) as doc:
                    body=" ".join(page.get_text() for page in doc)[:500_000]
            except ImportError:
                # Native stdlib extractor preserves partial text on systems
                # without PyMuPDF; never send private files externally.
                import pdf_text
                body=pdf_text.extract_pdf_text(path.read_bytes()).get("text","")[:500_000]
        elif ext in (".docx",".pptx",".xlsx") and path.stat().st_size<=35_000_000:
            import zipfile
            with zipfile.ZipFile(path) as z:
                names=[n for n in z.namelist() if
                   (ext==".docx" and n.startswith("word/") and n.endswith(".xml")) or
                   (ext==".pptx" and n.startswith("ppt/slides/slide") and n.endswith(".xml")) or
                   (ext==".xlsx" and n.startswith("xl/") and n.endswith(".xml"))]
                chunks=[]
                budget=3_000_000
                for n in names[:100]:
                    size=z.getinfo(n).file_size
                    if size>1_000_000 or size>budget:continue
                    budget-=size
                    chunks.append(re.sub(r"<[^>]+>"," ",z.read(n).decode("utf-8",errors="replace")))
                body=" ".join(chunks)[:500_000]
    except Exception:
        # Unparseable/broken Office or PDF documents remain downloadable.
        # One unsupported source must not break an entire library scan.
        body=""
    try:
        con.execute("DELETE FROM search WHERE file_id=?",(fid,))
        con.execute("INSERT INTO search(file_id,path,body) VALUES(?,?,?)",
                    (fid,path.name,body[:700_000]))
    except sqlite3.OperationalError:pass
    con.execute("UPDATE files SET indexed_at=? WHERE id=?",(time.time(),fid))

def _add(con,rel,path,source="discovered"):
    sha=_sha(path)
    _preserve(path,sha)
    size,mtime,inode=_stat(path)
    fid="file_"+uuid.uuid4().hex
    now=time.time()
    con.execute("INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (fid,rel,sha,size,mtime,inode,1,0,0,now,now))
    _audit(con,fid,"created",{"path":rel,"source":source})
    _index(con,fid,path,1)
    return fid

def _versions(con,fid):return con.execute(
  "SELECT * FROM versions WHERE file_id=? ORDER BY revision",(fid,)).fetchall()

_VERSION_SUFFIX = re.compile(r'(?i)[\s_.-]+(?:v(?:er(?:sion)?)?[\s_.-]*)(\d+(?:[._-]\d+)*)\s*$')

def _business_identity(name):
    stem=Path(name).stem
    matched=_VERSION_SUFFIX.search(stem)
    label=stem[:matched.start()].strip(' ._-') if matched else stem
    return label+Path(name).suffix, ('V'+matched.group(1).replace('_','.').replace('-','.')) if matched else None

def version_candidates(name, linked_ids):
    """Read-only candidates constrained to explicit Work Material file IDs."""
    if not isinstance(linked_ids,list) or len(linked_ids)>200 or any(
        not isinstance(item,str) or not re.fullmatch(r'file_[0-9a-f]{32}',item)
        for item in linked_ids):
        raise ValueError('Invalid material candidate IDs')
    base,_=_business_identity(name)
    with _db() as con:
        out=[]
        for fid in dict.fromkeys(linked_ids):
            row=con.execute("SELECT * FROM files WHERE id=? AND deleted=0",(fid,)).fetchone()
            if not row:continue
            doc=con.execute("SELECT * FROM documents WHERE file_id=?",(fid,)).fetchone()
            canonical=doc['display_name'] if doc else _business_identity(Path(row['path']).name)[0]
            if canonical.casefold()!=base.casefold():continue
            out.append({'fileId':fid,'name':Path(row['path']).name,'displayName':canonical,
                        'revision':row['revision'],
                        'businessVersion':doc['business_version'] if doc else _business_identity(Path(row['path']).name)[1],
                        'size':row['size']})
        return out


def _record_changed(con,row,path,source):
    size,mtime,inode=_stat(path)
    sha=_sha(path)
    if sha==row["sha"]:
        con.execute("UPDATE files SET mtime_ns=?,inode=?,size=? WHERE id=?",
                    (mtime,inode,size,row["id"]))
        return
    oldpath=_path(row["path"])
    # Prior content must have been snapshotted before external edit. If missing,
    # never manufacture an unavailable historical revision.
    old=_blob(row["sha"])
    versions=_versions(con,row["id"])
    if len(versions)>=MAX_HISTORY:
        # Never discard history after an external write. Temporarily exceed the
        # limit and expose the exception for manual review instead.
        _audit(con,row["id"],"history-overflow",{"newSha":sha,"count":len(versions)})
    if old.exists():
        con.execute("INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?,?,?)",
           (row["id"],row["revision"],row["sha"],row["size"],source,0,time.time()))
    _preserve(path,sha)
    rev=row["revision"]+1
    con.execute("UPDATE files SET sha=?,size=?,mtime_ns=?,inode=?,revision=?,updated=? WHERE id=?",
                (sha,size,mtime,inode,rev,time.time(),row["id"]))
    _audit(con,row["id"],"modified",{"from":row["sha"],"to":sha,"source":source})
    _index(con,row["id"],path,rev)

def reconcile():
    """Startup/on-demand scan. Ambiguous same-content moves never reassigned."""
    with _lock:
        _init()
        with _db() as con:
            rows=con.execute("SELECT * FROM files WHERE deleted=0").fetchall()
            known={r["path"]:r for r in rows}
            found={}
            for base, dirs, files in os.walk(LIBRARY,followlinks=False):
                dirs[:]=[d for d in dirs if not (Path(base)/d).is_symlink() and not d.startswith(".")]
                for name in files:
                    p=Path(base)/name
                    if p.is_symlink() or name.startswith("."):continue
                    rel=p.relative_to(LIBRARY).as_posix()
                    if p.stat().st_size>MAX_FILE:continue
                    found[rel]=p
            missing=[r for r in rows if r["path"] not in found]
            new=[(rel,p) for rel,p in found.items() if rel not in known]
            # Trust inode match when unambiguous, otherwise preserve pending state.
            consumed=set()
            for rel,p in new:
                size,mtime,inode=_stat(p)
                possible=[r for r in missing if r["inode"]==inode and r["size"]==size and r["id"] not in consumed]
                if len(possible)!=1:
                    digest=_sha(p)
                    possible=[r for r in missing if r["sha"]==digest and r["id"] not in consumed]
                if len(possible)==1:
                    r=possible[0]
                    con.execute("UPDATE files SET path=?,mtime_ns=?,inode=?,updated=? WHERE id=?",
                                (rel,mtime,inode,time.time(),r["id"]))
                    consumed.add(r["id"])
                    _audit(con,r["id"],"externally-moved",{"from":r["path"],"to":rel})
                    _index(con,r["id"],p,r["revision"])
                elif len(possible)>1:
                    con.execute("INSERT OR REPLACE INTO pending VALUES(?,?,?,?)",
                                (rel,"Ambiguous external move",json.dumps([r["id"] for r in possible]),time.time()))
                else:_add(con,rel,p)
            for rel,p in found.items():
                if rel not in known:continue
                r=known[rel]
                size,mtime,inode=_stat(p)
                if size!=r["size"] or mtime!=r["mtime_ns"]:
                    _record_changed(con,r,p,"external")
            # Missing paths are never automatically deleted; avoid spamming
            # a new audit record on every HTTP refresh.
            for r in missing:
                if r["id"] not in consumed:
                    exists=con.execute("SELECT 1 FROM pending WHERE path=?",(r["path"],)).fetchone()
                    if not exists:
                        con.execute("INSERT INTO pending VALUES(?,?,?,?)",
                                    (r["path"],"Source file missing",json.dumps([r["id"]]),time.time()))
                        _audit(con,r["id"],"missing-on-disk",{"path":r["path"]})
            for rel in found:
                con.execute("DELETE FROM pending WHERE path=?",(rel,))

def storage_health():
    with _db() as con:
        active=con.execute("SELECT COUNT(*),COALESCE(SUM(size),0) FROM files WHERE deleted=0").fetchone()
        trashed=con.execute("SELECT COUNT(*),COALESCE(SUM(size),0) FROM files WHERE deleted=1").fetchone()
        history=con.execute("SELECT COUNT(*) FROM versions").fetchone()[0]
        unresolved=con.execute("SELECT COUNT(*) FROM pending").fetchone()[0]
    def directory_bytes(path):
        return sum(p.stat().st_size for p in path.rglob("*")
                   if p.is_file() and not p.is_symlink()) if path.exists() else 0
    return {"activeFiles":active[0],"activeBytes":active[1],
            "trashFiles":trashed[0],"trashBytes":trashed[1],
            "historyRevisions":history,
            "versionStorageBytes":directory_bytes(VERSIONS),
            "pendingIdentity":unresolved}

def listing(folder="",query="",deleted=False):
    reconcile()
    folder=_rel(folder,allow_root=True)
    with _db() as con:
        rows=con.execute("SELECT * FROM files WHERE deleted=? ORDER BY path",(int(deleted),)).fetchall()
        if query:
            q=query.lower()
            matched={x[0] for x in con.execute("SELECT file_id FROM tags WHERE lower(tag) LIKE ?",("%"+q+"%",))}
            try:
                matched.update(x[0] for x in con.execute("SELECT file_id FROM search WHERE search MATCH ?",(query,)))
            except sqlite3.OperationalError:pass
            rows=[r for r in rows if q in r["path"].lower() or r["id"] in matched]
        elif folder:
            rows=[r for r in rows if r["path"].startswith(folder.rstrip("/")+"/")]
        result=[]
        for r in rows:
            d=dict(r)
            d["name"]=Path(r["path"]).name
            doc=con.execute("SELECT * FROM documents WHERE file_id=?",(r['id'],)).fetchone()
            d['displayName']=doc['display_name'] if doc else _business_identity(d['name'])[0]
            d['businessVersion']=doc['business_version'] if doc else _business_identity(d['name'])[1]
            d["tags"]=[x[0] for x in con.execute("SELECT tag FROM tags WHERE file_id=? ORDER BY tag",(r["id"],))]
            d["links"]=[dict(x) for x in con.execute(
              "SELECT target_type,target_id,relation FROM links WHERE file_id=?",(r["id"],))]
            result.append(d)
        folders=[]
        if not deleted and not query:
            root=LIBRARY if not folder else _path(folder)
            if root.is_dir():
                folders=[{"name":p.name,"path":p.relative_to(LIBRARY).as_posix()} for p in
                         sorted(root.iterdir()) if p.is_dir() and not p.is_symlink() and not p.name.startswith(".")]
        pending=[dict(x) for x in con.execute("SELECT * FROM pending ORDER BY at")]
        shortcuts=[]
        if folder and not query and not deleted:
            shortcuts=[dict(x) for x in con.execute("""SELECT s.id,s.folder,s.file_id,
                 f.path,f.deleted,f.revision FROM shortcuts s
                 JOIN files f ON f.id=s.file_id WHERE s.folder=? ORDER BY f.path""",(folder,))]
        return {"files":result,"folders":folders,"shortcuts":shortcuts,"pending":pending,"root":folder}

def linked_context(target_type,target_id):
    """Find File Hub files referenced by a project or Work Hub work item."""
    if target_type not in ("project","workstream","initiative","knowledge_collection","topic","material","action","task","campaign","note-page"):
        raise ValueError("Invalid target type")
    if not isinstance(target_id,str) or not re.fullmatch(r"[\w:.-]{1,120}",target_id):
        raise ValueError("Invalid target ID")
    reconcile()
    with _db() as con:
        return [dict(r) for r in con.execute(
           """SELECT f.*,l.relation AS link_relation FROM files f JOIN links l ON l.file_id=f.id
              WHERE l.target_type=? AND l.target_id=? ORDER BY f.path""",
           (target_type,target_id))]

def lookup_legacy_source(source):
    """Optional private legacy source resolver (not included in InnerSource)."""
    extension = _local_legacy_extension()
    if extension is None:
        raise Missing("Legacy source mapping is not configured in this clean Work clone")
    return extension.lookup_legacy_source(source, sys.modules[__name__])


def details(fid):
    reconcile()
    with _db() as con:
        row=_file(fid,con)
        out=dict(row)
        out['name']=Path(row['path']).name
        doc=con.execute('SELECT * FROM documents WHERE file_id=?',(fid,)).fetchone()
        out['displayName']=doc['display_name'] if doc else _business_identity(out['name'])[0]
        out['businessVersion']=doc['business_version'] if doc else _business_identity(out['name'])[1]
        out['lastUploadedName']=doc['last_uploaded_name'] if doc else None
        out['documentVersions']=[dict(v) for v in con.execute(
            'SELECT * FROM document_versions WHERE file_id=? ORDER BY revision DESC',(fid,))]
        out["versions"]=[dict(x) for x in con.execute(
            "SELECT * FROM versions WHERE file_id=? ORDER BY revision DESC",(fid,))]
        out["links"]=[dict(x) for x in con.execute("SELECT * FROM links WHERE file_id=?",(fid,))]
        out["tags"]=[x[0] for x in con.execute("SELECT tag FROM tags WHERE file_id=? ORDER BY tag",(fid,))]
        out["audit"]=[dict(x) for x in con.execute(
            "SELECT * FROM audit WHERE file_id=? ORDER BY at DESC LIMIT 30",(fid,))]
        return out

def extracted_text(fid):
    """Read locally indexed plain text for PDF / Office / all supported files."""
    with _db() as con:
        row=_file(fid,con)
        if row["deleted"]:raise Missing("File in trash")
        try:
            found=con.execute("SELECT body FROM search WHERE file_id=?",(fid,)).fetchone()
        except sqlite3.OperationalError:
            return {"text":"","status":"unavailable","reason":"Full-text index not installed"}
        text=found[0] if found else ""
        return {"text":text[:350_000],"status":"extracted" if text else "unavailable",
                "format":Path(row["path"]).suffix.lower(),"revision":row["revision"]}

def content(fid,revision=None):
    with _db() as con:
        row=_file(fid,con)
        if revision is None:
            if row["deleted"]:raise Missing("File in trash")
            path=_path(row["path"])
            if not path.is_file():raise Missing("File unavailable")
        else:
            if int(revision)==row["revision"] and not row["deleted"]:
                path=_path(row["path"])
                if not path.is_file():raise Missing("File unavailable")
            else:
                v=con.execute("SELECT * FROM versions WHERE file_id=? AND revision=?",
                              (fid,int(revision))).fetchone()
                if not v:raise Missing("Version unavailable")
                path=_blob(v["sha"])
        return path,Path(row["path"]).name

def _safe_parent(rel):
    path=_path(rel)
    if path.exists() and not path.is_dir():raise Conflict("Folder is a file")
    if not path.exists():raise Missing("Target folder not found")
    return path

def register_work_media(media_id, file_name, raw, material_id=None):
    """Import Work Hub attachment into the canonical File Hub, preserving mediaId."""
    if not re.fullmatch(r"whm-[a-f0-9]{32}",media_id):
        raise ValueError("Invalid media ID")
    if not isinstance(raw,bytes) or not raw or len(raw)>20_000_000:
        raise ValueError("Invalid attachment bytes")
    if not isinstance(file_name,str) or not file_name or len(file_name)>180:
        raise ValueError("Invalid attachment filename")
    ext=Path(file_name).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,12}",ext):
        raise ValueError("Invalid extension")
    digest=hashlib.sha256(raw).hexdigest()
    folder="General/Work Hub Attachments"
    with _lock:
        _init()
        target=_path(folder)
        target.mkdir(exist_ok=True)
        with _db() as con:
            alias=con.execute("SELECT * FROM media_aliases WHERE media_id=?",(media_id,)).fetchone()
            if alias:
                if alias["sha"]!=digest:raise Conflict("Work Hub media hash mismatch")
                row=_file(alias["file_id"],con)
                if row["deleted"] or row["sha"]!=digest or _sha(_path(row["path"]))!=digest:
                    raise Conflict("Canonical Work Hub attachment unavailable")
                fid=alias["file_id"]
            else:
                rel=folder+"/"+media_id+ext
                dest=_path(rel)
                if dest.exists():
                    if _sha(dest)!=digest:raise Conflict("Work Hub target collision")
                    row=con.execute("SELECT id FROM files WHERE path=? AND deleted=0",(rel,)).fetchone()
                    fid=row["id"] if row else _add(con,rel,dest,"work-hub-recovery")
                else:
                    with tempfile.NamedTemporaryFile(dir=target,delete=False) as tmp:
                        staging=Path(tmp.name)
                        tmp.write(raw);tmp.flush();os.fsync(tmp.fileno())
                    try:
                        os.link(staging,dest)
                    except FileExistsError:
                        if _sha(dest)!=digest:raise Conflict("Work Hub target collision")
                    finally:staging.unlink(missing_ok=True)
                    fid=_add(con,rel,dest,"work-hub-media")
                con.execute("INSERT INTO media_aliases VALUES(?,?,?,?,?,?)",
                            (media_id,fid,material_id,digest,file_name,time.time()))
                _audit(con,fid,"work-hub-media-registered",
                       {"mediaId":media_id,"materialId":material_id})
            if material_id:
                con.execute("UPDATE media_aliases SET material_id=? WHERE media_id=?",
                            (material_id,media_id))
                con.execute("INSERT OR IGNORE INTO links VALUES(?,?,?,?)",
                            (fid,"material",material_id,"attachment"))
            return {"fileId":fid,"mediaId":media_id,"sha256":digest,"fileName":file_name}

def work_media_alias(media_id):
    if not re.fullmatch(r"whm-[a-f0-9]{32}",media_id):
        raise ValueError("Invalid media ID")
    with _db() as con:
        row=con.execute("SELECT * FROM media_aliases WHERE media_id=?",(media_id,)).fetchone()
        return dict(row) if row else None

def work_media_bytes(media_id):
    alias=work_media_alias(media_id)
    if not alias:return None
    path,_=content(alias["file_id"])
    raw=path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=alias["sha"]:
        raise Conflict("Work Hub canonical checksum mismatch")
    return raw

def work_media_aliases():
    with _db() as con:
        return [dict(row) for row in con.execute("SELECT * FROM media_aliases ORDER BY media_id")]

def folder_create(path):
    rel=_rel(path)
    if len(rel.split("/"))==1:raise Conflict("Collection exists")
    with _lock:
        parent=_safe_parent(rel.rsplit("/",1)[0])
        dst=_path(rel)
        if dst.exists():raise Conflict("Folder exists")
        dst.mkdir()
    return {"path":rel}

def _update(fid,raw,revision,source="web",uploaded_name=None):
    with _lock:
        with _db() as con:
            row=_file(fid,con)
            if row["revision"]!=revision:raise Conflict("Revision changed: reload before saving")
            if row["deleted"]:raise Conflict("File in trash")
            if uploaded_name and Path(uploaded_name).suffix.lower()!=Path(row['path']).suffix.lower():
                raise Conflict('New version must use the same file extension')
            path=_path(row["path"])
            stable_name=_business_identity(uploaded_name)[0] if uploaded_name else None
            old_name=Path(row['path']).name
            canonical_name=_business_identity(old_name)[0]
            normalize=(bool(stable_name) and stable_name.casefold()==canonical_name.casefold()
                       and old_name!=stable_name)
            renamed_path=path.with_name(stable_name) if normalize else path
            if normalize and renamed_path.exists():
                raise Conflict('Stable document filename already exists; resolve the path collision first')
            if _sha(path)!=row["sha"]:raise Conflict("File changed on disk")
            incoming_sha=hashlib.sha256(raw).hexdigest()
            if incoming_sha==row['sha']:
                result=dict(row);result['unchanged']=True
                return result
            if len(_versions(con,fid))>=MAX_HISTORY:
                raise Conflict("Historical version limit reached; review versions before saving")
            _preserve(path,row["sha"])
            with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as tmp:
                name=tmp.name
                tmp.write(raw);tmp.flush();os.fsync(tmp.fileno())
            try:os.replace(name,path)
            finally:Path(name).unlink(missing_ok=True)
            _record_changed(con,row,path,source)
            if uploaded_name:
                current=con.execute('SELECT * FROM documents WHERE file_id=?',(fid,)).fetchone()
                display,new_business=_business_identity(uploaded_name)
                old_business=(current['business_version'] if current else
                              _business_identity(Path(row['path']).name)[1])
                con.execute('INSERT OR IGNORE INTO document_versions VALUES(?,?,?)',
                            (fid,row['revision'],old_business))
                con.execute('INSERT OR REPLACE INTO documents VALUES(?,?,?,?,?)',
                            (fid,display,new_business,uploaded_name,time.time()))
                con.execute('INSERT OR REPLACE INTO document_versions VALUES(?,?,?)',
                            (fid,row['revision']+1,new_business))
                _audit(con,fid,'business-version-upgraded',{'from':old_business,'to':new_business,
                    'uploadedName':uploaded_name,'displayName':display})
                if normalize:
                    new_rel=renamed_path.relative_to(LIBRARY).as_posix()
                    os.replace(path,renamed_path)
                    try:
                        con.execute('UPDATE files SET path=? WHERE id=?',(new_rel,fid))
                        _audit(con,fid,'canonical-name-normalized',{'from':row['path'],'to':new_rel})
                        _index(con,fid,renamed_path,row['revision']+1)
                    except BaseException:
                        os.replace(renamed_path,path)
                        raise
            return dict(_file(fid,con))

def edit(fid,revision,text):
    path,_=content(fid)
    if path.suffix.lower() not in (".md",".txt",".html",".json",".csv"):
        raise ValueError("Only text files can be edited in the browser")
    raw=text.encode("utf-8")
    if len(raw)>MAX_FILE:raise ValueError("File too large")
    return _update(fid,raw,int(revision),"web")

def upload(folder,name,raw,as_version=None,revision=None):
    if len(raw)>MAX_FILE:raise ValueError("File too large")
    if not name or name in (".","..") or "/" in name or "\\" in name or ":" in name or name.startswith("."):
        raise ValueError("Invalid filename")
    if as_version:return _update(as_version,raw,int(revision),"upload-revision",uploaded_name=name)
    with _lock:
        parent=_safe_parent(folder)
        dest=parent/name
        _path(dest.relative_to(LIBRARY).as_posix())
        if dest.exists():raise Conflict("Name already exists; choose new name or upload as revision")
        with tempfile.NamedTemporaryFile(dir=parent,delete=False) as tmp:
            t=Path(tmp.name);tmp.write(raw);tmp.flush();os.fsync(tmp.fileno())
        try:os.replace(t,dest)
        finally:t.unlink(missing_ok=True)
        with _db() as con:fid=_add(con,dest.relative_to(LIBRARY).as_posix(),dest,"upload")
        return {"id":fid,"name":name}

def move(fid,target,revision,copy=False):
    target=_rel(target)
    with _lock:
        with _db() as con:
            row=_file(fid,con)
            if row["deleted"] or row["revision"]!=int(revision):raise Conflict("Revision conflict")
            src=_path(row["path"]);dst=_path(target)
            _safe_parent(str(Path(target).parent).replace("\\","/"))
            if dst.exists():raise Conflict("Name already exists")
            if _sha(src)!=row["sha"]:raise Conflict("File modified externally")
            if copy:
                shutil.copy2(src,dst)
                return {"id":_add(con,target,dst,"copy")}
            os.replace(src,dst)
            size,mtime,inode=_stat(dst)
            con.execute("UPDATE files SET path=?,mtime_ns=?,inode=?,updated=? WHERE id=?",
                        (target,mtime,inode,time.time(),fid))
            _audit(con,fid,"move",{"from":row["path"],"to":target})
            _index(con,fid,dst,row["revision"])
            return {"id":fid}

def lifecycle(fid,revision,operation,confirm=False):
    if operation not in ("trash","restore","purge"):raise ValueError("Unknown operation")
    with _lock:
        with _db() as con:
            row=_file(fid,con)
            if row["revision"]!=int(revision):raise Conflict("Revision conflict")
            links=con.execute("SELECT COUNT(*) FROM links WHERE file_id=?",(fid,)).fetchone()[0]
            notes=con.execute("SELECT 1 FROM links WHERE file_id=? AND target_type='note-page' LIMIT 1",(fid,)).fetchone()
            pinned=con.execute("SELECT 1 FROM note_page_version_pins WHERE file_id=? LIMIT 1",(fid,)).fetchone()
            if notes or pinned:raise Conflict("File is referenced by a Notes Page or pinned history; unlink safely first")
            if operation=="trash":
                if row["deleted"]:raise Conflict("Already trashed")
                if links and not confirm:raise Conflict(f"File has {links} links; confirm affected links")
                src=_path(row["path"])
                dst=TRASH/(fid+".bin")
                if dst.exists():raise Conflict("Trash entry exists")
                if _sha(src)!=row["sha"]:raise Conflict("File changed externally")
                os.replace(src,dst)
                con.execute("UPDATE files SET deleted=1,revision=revision+1,updated=? WHERE id=?",
                            (time.time(),fid))
            elif operation=="restore":
                if not row["deleted"]:raise Conflict("Not in trash")
                dst=_path(row["path"]);_safe_parent(str(Path(row["path"]).parent))
                if dst.exists():raise Conflict("Original path occupied")
                os.replace(TRASH/(fid+".bin"),dst)
                size,mtime,inode=_stat(dst)
                con.execute("UPDATE files SET deleted=0,mtime_ns=?,inode=?,revision=revision+1,updated=? WHERE id=?",
                            (mtime,inode,time.time(),fid))
            else:
                if not row["deleted"] or not confirm:raise Conflict("Purge requires explicit confirmation")
                (TRASH/(fid+".bin")).unlink(missing_ok=True)
                con.execute("DELETE FROM links WHERE file_id=?",(fid,))
                con.execute("DELETE FROM tags WHERE file_id=?",(fid,))
                con.execute("DELETE FROM shortcuts WHERE file_id=?",(fid,))
                con.execute("DELETE FROM media_aliases WHERE file_id=?",(fid,))
                con.execute("DELETE FROM versions WHERE file_id=?",(fid,))
                con.execute("DELETE FROM files WHERE id=?",(fid,))
                try:con.execute("DELETE FROM search WHERE file_id=?",(fid,))
                except sqlite3.OperationalError:pass
            _audit(con,fid,operation,{"links":links})
            return {"operation":operation,"id":fid}

def shortcut(fid,folder,remove_id=None):
    with _lock:
        with _db() as con:
            if remove_id:
                match=con.execute("SELECT file_id FROM shortcuts WHERE id=?",(remove_id,)).fetchone()
                if not match:raise Missing("Shortcut not found")
                con.execute("DELETE FROM shortcuts WHERE id=?",(remove_id,))
                _audit(con,match["file_id"],"shortcut-removed",{"shortcut":remove_id})
                return {"removed":remove_id}
            _file(fid,con)
            folder=_rel(folder)
            _safe_parent(folder)
            sid="shortcut_"+uuid.uuid4().hex
            con.execute("INSERT OR IGNORE INTO shortcuts VALUES(?,?,?,?)",
                        (sid,fid,folder,time.time()))
            actual=con.execute("SELECT id FROM shortcuts WHERE file_id=? AND folder=?",
                               (fid,folder)).fetchone()[0]
            _audit(con,fid,"shortcut-created",{"folder":folder,"shortcut":actual})
            return {"shortcutId":actual,"fileId":fid,"folder":folder}

def link(fid,target_type,target_id,relation="related",remove=False):
    if target_type not in ("project","workstream","initiative","knowledge_collection","topic","material","action","task","campaign","note-page") or not re.fullmatch(r"[\w:.-]{1,120}",target_id):
        raise ValueError("Invalid relation target")
    with _lock:
        with _db() as con:
            _file(fid,con)
            if remove:con.execute("DELETE FROM links WHERE file_id=? AND target_type=? AND target_id=? AND relation=?",
                                  (fid,target_type,target_id,relation))
            else:con.execute("INSERT OR IGNORE INTO links VALUES(?,?,?,?)",
                             (fid,target_type,target_id,relation))
            _audit(con,fid,"unlink" if remove else "link",{"type":target_type,"target":target_id})
            return {"id":fid,"linked":not remove}

def pin_note_page_revision(fid,page_id,ref_id,revision):
    """Retain immutable File Hub evidence referenced by a Notes Page Revision.

    Pins are conservative: removing a current Page card never deletes historical pins.
    """
    if not re.fullmatch(r'np_[a-zA-Z0-9_-]{2,80}',page_id) or not re.fullmatch(r'ref_[a-zA-Z0-9_-]{8,64}',ref_id):
        raise ValueError('Invalid Page attachment identity')
    if type(revision) is not int or revision < 1:
        raise ValueError('Invalid pinned revision')
    # content() handles both current and historical revisions (may raise Missing).
    content(fid,revision)
    with _lock:
        with _db() as con:
            con.execute('INSERT OR IGNORE INTO note_page_version_pins VALUES(?,?,?,?,?)',
                        (fid,page_id,ref_id,revision,time.time()))
            con.execute('UPDATE versions SET locked=1 WHERE file_id=? AND revision=?',
                        (fid,revision))
            _audit(con,fid,'note-page-version-pin',{'pageId':page_id,'revision':revision})
    return {'fileId':fid,'pageId':page_id,'revision':revision}


def lock_version(fid,revision,locked):
    with _lock:
        with _db() as con:
            if not locked and (con.execute('SELECT 1 FROM material_version_pins WHERE file_id=? AND revision=? LIMIT 1',(fid,int(revision))).fetchone()
                    or con.execute('SELECT 1 FROM note_page_version_pins WHERE file_id=? AND revision=? LIMIT 1',(fid,int(revision))).fetchone()):
                raise Conflict('Cannot unlock a Revision referenced by pinned evidence')
            n=con.execute("UPDATE versions SET locked=? WHERE file_id=? AND revision=?",
                          (int(bool(locked)),fid,int(revision))).rowcount
            if not n:raise Missing("Version not found")
            _audit(con,fid,"version-lock",{"revision":revision,"locked":bool(locked)})
            return {"id":fid}



def resolve_pending(path,fid):
    """User-confirmed identity resolution; never conflate identical copies."""
    path=_rel(path)
    with _lock:
        with _db() as con:
            entry=con.execute("SELECT * FROM pending WHERE path=?",(path,)).fetchone()
            if not entry:raise Missing("No pending identity decision")
            try:candidates=json.loads(entry["candidates"])
            except (ValueError,TypeError):raise Conflict("Pending candidate list invalid")
            if fid not in candidates:raise Conflict("File is not a listed candidate")
            row=_file(fid,con)
            if _path(row["path"]).exists():raise Conflict("Original file still exists")
            target=_path(path)
            if not target.is_file():raise Missing("Target file missing")
            size,mtime,inode=_stat(target)
            if inode!=row["inode"] and _sha(target)!=row["sha"]:
                raise Conflict("File identity cannot be verified")
            con.execute("UPDATE files SET path=?,size=?,mtime_ns=?,inode=?,updated=? WHERE id=?",
                        (path,size,mtime,inode,time.time(),fid))
            con.execute("DELETE FROM pending WHERE path=?",(path,))
            _audit(con,fid,"manual-identity-resolution",{"from":row["path"],"to":path})
            _record_changed(con,_file(fid,con),target,"external-move")
            _index(con,fid,target,_file(fid,con)["revision"])
            return {"id":fid,"path":path}

def set_tags(fid,tags,expected_tags=None):
    if not isinstance(tags,list) or len(tags)>30 or not all(
        isinstance(t,str) and 1 <= len(t.strip()) <= 40 and t == t.strip() and
        not any(ord(c) < 32 or c in "/\\\\<>" for c in t) for t in tags):
        raise ValueError("Invalid tags")
    with _lock:
        with _db() as con:
            _file(fid,con)
            previous = [row[0] for row in con.execute("SELECT tag FROM tags WHERE file_id=? ORDER BY tag", (fid,))]
            if expected_tags is not None and (not isinstance(expected_tags, list) or
                 sorted(expected_tags) != previous):
                raise Conflict("Tags changed since last read; refresh before saving")
            normalized = sorted(dict.fromkeys(tags), key=str.casefold)
            con.execute("DELETE FROM tags WHERE file_id=?",(fid,))
            con.executemany("INSERT INTO tags VALUES(?,?)",[(fid,t) for t in normalized])
            _audit(con,fid,"tags-updated",{"before":previous,"after":normalized})
            return {"id":fid,"tags":normalized}

def rename_tag(old, new):
    """Audit-only global tag rename; no file bytes or Work associations change."""
    if not all(isinstance(t, str) and 1 <= len(t.strip()) <= 40 and t == t.strip() and
               not any(ord(c) < 32 or c in "/\\<>" for c in t) for t in (old, new)):
        raise ValueError("Invalid tag")
    with _lock:
        with _db() as con:
            ids = [r[0] for r in con.execute("SELECT file_id FROM tags WHERE tag=?", (old,))]
            if old == new:
                return {"from": old, "to": new, "affected": 0}
            if con.execute("SELECT 1 FROM tags WHERE tag=? LIMIT 1", (new,)).fetchone():
                raise Conflict("Target tag already exists; merge is not automatic")
            for fid in ids:
                con.execute("UPDATE tags SET tag=? WHERE file_id=? AND tag=?", (new, fid, old))
                _audit(con, fid, "tag-renamed", {"from": old, "to": new})
            return {"from": old, "to": new, "affected": len(ids)}


def pinned_material_version(fid, material_id):
    with _db() as con:
        row=con.execute('SELECT revision FROM material_version_pins WHERE file_id=? AND material_id=?',
                        (fid,material_id)).fetchone()
        return row['revision'] if row else None

def pin_material_version(fid,material_id,revision):
    """Pin explicit evidence Material identity. Never changes a Work Material record."""
    if not isinstance(material_id,str) or not re.fullmatch(r'[\w:.-]{1,120}',material_id):
        raise ValueError('Invalid Material ID')
    import work_hub_store
    try:
        material=work_hub_store.get_record(material_id)
    except work_hub_store.NotFound as exc:
        raise Missing('Material record not found') from exc
    if material.get('kind')!='material' or material.get('data',{}).get('fileId')!=fid:
        raise Conflict('Material does not directly reference this canonical File ID')
    with _lock:
        with _db() as con:
            row=_file(fid,con)
            if row['deleted']:raise Conflict('File in trash')
            if revision is None:
                con.execute('DELETE FROM material_version_pins WHERE file_id=? AND material_id=?',
                            (fid,material_id))
                _audit(con,fid,'material-version-unpinned',{'materialId':material_id})
                return {'fileId':fid,'materialId':material_id,'revision':None}
            rev=int(revision)
            history=con.execute('SELECT sha FROM versions WHERE file_id=? AND revision=?',
                                (fid,rev)).fetchone()
            if not history:raise Missing('Historical Revision unavailable for pin')
            if not _blob(history['sha']).is_file():raise Missing('Historical content is missing')
            con.execute('INSERT OR REPLACE INTO material_version_pins VALUES(?,?,?,?)',
                        (fid,material_id,rev,time.time()))
            con.execute('UPDATE versions SET locked=1 WHERE file_id=? AND revision=?',(fid,rev))
            _audit(con,fid,'material-version-pinned',{'materialId':material_id,'revision':rev})
            return {'fileId':fid,'materialId':material_id,'revision':rev}

def remove_version(fid,old_revision):
    """Manual pruning: locked snapshots are never removed."""
    with _lock:
        with _db() as con:
            row=_file(fid,con)
            v=con.execute("SELECT * FROM versions WHERE file_id=? AND revision=?",
                          (fid,int(old_revision))).fetchone()
            if not v:raise Missing("Historical version not found")
            if v["locked"]:raise Conflict("Unlock the historical version first")
            if (con.execute('SELECT 1 FROM material_version_pins WHERE file_id=? AND revision=? LIMIT 1',
                            (fid,int(old_revision))).fetchone() or
                con.execute('SELECT 1 FROM note_page_version_pins WHERE file_id=? AND revision=? LIMIT 1',
                            (fid,int(old_revision))).fetchone()):
                raise Conflict('Historical Revision referenced by pinned evidence')
            con.execute("DELETE FROM versions WHERE file_id=? AND revision=?",(fid,int(old_revision)))
            _audit(con,fid,"version-pruned",{"revision":old_revision})
            return {"id":fid,"removedRevision":old_revision}

def restore_version(fid,old_revision,expected_revision):
    with _db() as con:
        v=con.execute("SELECT * FROM versions WHERE file_id=? AND revision=?",
                      (fid,int(old_revision))).fetchone()
        if not v:raise Missing("Historical version not found")
        p=_blob(v["sha"])
        if not p.is_file():raise Missing("Historical content unavailable")
        raw=p.read_bytes()
    return _update(fid,raw,int(expected_revision),"manual-restore")

def folder_move(source,target):
    src_rel=_rel(source);dst_rel=_rel(target)
    if src_rel in TOP or dst_rel in TOP:raise ValueError("Cannot rename library collection")
    if dst_rel.startswith(src_rel+"/"):raise Conflict("Cannot move folder into itself")
    with _lock:
        src=_path(src_rel);dst=_path(dst_rel)
        if not src.is_dir():raise Missing("Folder not found")
        _safe_parent(str(Path(dst_rel).parent))
        if dst.exists():raise Conflict("Target already exists")
        with _db() as con:
            rows=con.execute("SELECT * FROM files WHERE path LIKE ?",(src_rel+"/%",)).fetchall()
            updates=[(dst_rel+r["path"][len(src_rel):],r) for r in rows]
            for new,r in updates:
                clash=con.execute("SELECT id FROM files WHERE path=?",(new,)).fetchone()
                if clash:raise Conflict("File path collision")
            os.replace(src,dst)
            for new,r in updates:
                p=_path(new);size,mtime,inode=_stat(p)
                con.execute("UPDATE files SET path=?,size=?,mtime_ns=?,inode=?,updated=? WHERE id=?",
                            (new,size,mtime,inode,time.time(),r["id"]))
                _audit(con,r["id"],"folder-move",{"from":r["path"],"to":new})
                _index(con,r["id"],p,r["revision"])
        return {"from":src_rel,"to":dst_rel,"fileCount":len(rows)}

def migration_preview(project=None):
    """Private, explicit legacy import only; not part of the generic Work package."""
    extension = _local_legacy_extension()
    if extension is None:
        raise Missing("No legacy migration extension installed")
    return extension.migration_preview(project, sys.modules[__name__])


def migration_commit(expected):
    extension = _local_legacy_extension()
    if extension is None:
        raise Missing("No legacy migration extension installed")
    return extension.migration_commit(expected, sys.modules[__name__])


def start_watcher(interval=30):
    """Periodic reconciliation while the local server is running."""
    stop=threading.Event()
    def poll():
        while not stop.is_set():
            try:reconcile()
            except (OSError,sqlite3.DatabaseError,ValueError):pass
            stop.wait(interval)
    thread=threading.Thread(target=poll,name="KBFileHubWatcher",daemon=True)
    thread.start()
    return stop

def act(payload):
    a=payload.get("action")
    if a=="folder":return folder_create(payload["path"])
    if a=="move":return move(payload["id"],payload["path"],payload["revision"],payload.get("copy",False))
    if a=="edit":return edit(payload["id"],payload["revision"],payload["text"])
    if a in ("trash","restore","purge"):return lifecycle(payload["id"],payload["revision"],a,payload.get("confirm",False))
    if a in ("link","unlink"):return link(payload["id"],payload["targetType"],payload["targetId"],
                                          relation=payload.get("relation","related"),remove=(a=="unlink"))
    if a=="lock":return lock_version(payload["id"],payload["revision"],payload["locked"])
    if a=="pin-material-version":return pin_material_version(payload["id"],payload["materialId"],payload.get("revision"))
    if a=="tags":return set_tags(payload["id"],payload["tags"],payload.get("expectedTags"))
    if a=="rename-tag":return rename_tag(payload["from"],payload["to"])
    if a=="shortcut":return shortcut(payload["id"],payload["folder"])
    if a=="remove-shortcut":return shortcut("", "",remove_id=payload["shortcutId"])
    if a=="resolve-path":return resolve_pending(payload["path"],payload["id"])
    if a=="prune-version":return remove_version(payload["id"],payload["revision"])
    if a=="restore-version":return restore_version(payload["id"],payload["version"],payload["revision"])
    if a=="folder-move":return folder_move(payload["from"],payload["to"])
    if a=="migration-commit":return migration_commit(payload["manifestSha256"])
    raise ValueError("Unknown action")
