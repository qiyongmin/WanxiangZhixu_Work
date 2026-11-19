"""Explicit, local-only KB_Work backup/restore (never scheduled automatically).

Usage:
 python3 tools/work_backup.py create                         # portable Work package
 python3 tools/work_backup.py create --private-instance      # plus private local config
 python3 tools/work_backup.py verify /path/to/backup.zip
 python3 tools/work_backup.py restore /path/to/backup.zip --to /empty/work-copy

The portable archive includes approved generic source and live Work records.
The optional private-instance archive additionally captures the local-only Work
extension, Agent instructions, private Skills, catalogs and project documentation.
Keep private-instance archives only in company-approved encrypted storage; do
not commit, share or copy them into the generic GitLab source tree. Both kinds
are manual opt-in only. KB_Site is neither opened nor modified.
"""
from __future__ import annotations

import argparse
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path,PurePosixPath
import shutil
import sqlite3
import stat
import tempfile
import zipfile

ROOT=Path(__file__).resolve().parents[1]
FORMAT="kb-work-full-backup-v1"
PRIVATE_SCOPE="WORK_PRIVATE_INSTANCE"
DBS={"content/work-hub/work.sqlite3","content/file-hub/catalog.sqlite3"}
RESOURCE_DB="content/ai-resources/registry.sqlite3"  # optional additive data, never a clean-clone prerequisite
BLOCKED_DIRS={".git",".backups",".maintenance","__pycache__","node_modules",".venv","playwright-report","test-results"}
BLOCKED_ROOTS={"media/personal","content/inspiration","content/math-mistakes",
               "data/domains/english","data/domains/math","data/domains/ai"}
MANIFEST="WORK_BACKUP_MANIFEST.json"

def sha_file(path):
    h=hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda:handle.read(1024*1024),b""):h.update(block)
    return h.hexdigest()

def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()

def _private_paths(root):
    """Explicit local Work instance additions, never GitLab source candidates."""
    private_files = ("AGENTS.md", "tools/work_local_extensions.py",
                     "data/index.json", "data/review-index.json", "data/project-skills.json")
    result = [name for name in private_files if (root/name).is_file()]
    for folder in (".agents", ".kiro", "docs", "agents/private"):
        base = root/folder
        if not base.is_dir():
            continue
        for walk, dirs, names in os.walk(base, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not (Path(walk)/d).is_symlink()
                             and d not in BLOCKED_DIRS)
            for name in sorted(names):
                item = Path(walk)/name
                if item.is_file() and not item.is_symlink() and not name.endswith('.pyc'):
                    result.append(item.relative_to(root).as_posix())
    return sorted(set(result))


def collect(root=None, *, private_instance=False):
    # The legacy combined Work ZIP uses the in-checkout data layout only.
    # Never silently archive old checkout DBs for an external Data Root.
    if root is None and os.environ.get('KB_WORK_DATA_ROOT'):
        raise RuntimeError('External Data Root requires tools/work_instance_backup.py; legacy archive is refused')
    root = Path(root or ROOT)
    # Generic source is exactly the audited GitLab candidate; optional local
    # private files never enter source_paths() or a GitLab commit.
    from gitlab_preflight import source_paths
    source_names=source_paths()
    if private_instance:
        source_names=sorted(set(source_names) | set(_private_paths(root)))
    files=[(name,root/name) for name in source_names]
    for folder in ('content','library','projects'):
        base=root/folder
        if not base.exists():continue
        for walk,dirs,names in os.walk(base,followlinks=False):
            dirs[:]=sorted(d for d in dirs if not (Path(walk)/d).is_symlink())
            for name in sorted(names):
                src=Path(walk)/name
                if not src.is_file() or src.is_symlink() or name.endswith(('-wal','-shm','.pyc')):continue
                relative=src.relative_to(root).as_posix()
                if relative.startswith(tuple(x+'/' for x in BLOCKED_ROOTS)):
                    raise ValueError('Personal data present in Work release: '+relative)
                files.append((relative,src))
    if len({name for name,_ in files})!=len(files):
        raise ValueError('Duplicate Work backup entry detected')
    if not {"index.html","start.sh","WORKSPACE_KIND","content/work-hub/work.sqlite3",
            "content/file-hub/catalog.sqlite3"}.issubset({x[0] for x in files}):
        raise ValueError("Incomplete Work release; backup refused")
    return files

def snapshot(src,dst):
    dst.parent.mkdir(parents=True,exist_ok=True)
    with sqlite3.connect(f"file:{src}?mode=ro",uri=True) as original,sqlite3.connect(dst) as target:
        original.backup(target)
        if target.execute("PRAGMA integrity_check").fetchone()[0]!="ok":
            raise ValueError("SQLite integrity check failed: "+str(src))

def create(output=None, *, private_instance=False):
    if os.environ.get('KB_WORK_DATA_ROOT'):
        raise RuntimeError('External Data Root requires tools/work_instance_backup.py; legacy archive is refused')
    files=collect(private_instance=private_instance)
    timestamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    prefix="KB_Work_Private_" if private_instance else "KB_Work_"
    dest=Path(output).expanduser().resolve() if output else ROOT/".backups"/f"{prefix}{timestamp}.zip"
    if dest.exists():raise FileExistsError("Backup destination exists: "+str(dest))
    if dest.suffix.lower()!=".zip":raise ValueError("Backup output must end in .zip")
    if dest==ROOT or ROOT in dest.parents and ".backups" not in dest.parts:
        raise ValueError("Store Work backup outside the source tree or inside .backups/")
    dest.parent.mkdir(parents=True,exist_ok=True)
    tmp_zip=dest.with_name(dest.name+".incomplete")
    if tmp_zip.exists():raise FileExistsError("Incomplete backup exists; investigate before retrying")
    live_dbs=DBS | ({RESOURCE_DB} if (ROOT/RESOURCE_DB).is_file() else set())
    before={name:sha_file(ROOT/name) for name in live_dbs}
    manifest={"format":FORMAT,"createdUtc":timestamp,
              "scope":PRIVATE_SCOPE if private_instance else "WORK_ONLY",
              "files":[],"source":"KB_Work",
              "includesWorkDatabase":True,"containsPersonalKB_Site":False,
              "containsLocalPrivateConfiguration":bool(private_instance)}
    try:
        with tempfile.TemporaryDirectory(prefix="kb-work-sqlite-") as temp:
            snaps={}
            for rel in live_dbs:
                target=Path(temp)/rel
                snapshot(ROOT/rel,target)
                snaps[rel]=target
            with zipfile.ZipFile(tmp_zip,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=2,
                                 allowZip64=True) as out:
                for rel,source in files:
                    input_file=snaps.get(rel,source)
                    size=input_file.stat().st_size
                    digest=sha_file(input_file)
                    # Windows Zone.Identifier sidecars are real Work files under WSL.
                    # Store in a portable ZIP path, with a verified original-path mapping.
                    # Never omit or silently delete these metadata files.
                    sidecar=rel.endswith(':Zone.Identifier')
                    stored=rel[:-len(':Zone.Identifier')]+'.kbw-zone-identifier-sidecar' if sidecar else rel
                    out.write(input_file,arcname=stored)
                    item={"path":stored,"bytes":size,"sha256":digest}
                    if sidecar:item['originalPath']=rel
                    manifest["files"].append(item)
                out.writestr(MANIFEST,json.dumps(manifest,ensure_ascii=False,sort_keys=True,indent=2))
        # Detect concurrent database modifications. The original site should be
        # quiescent during backup; abort rather than returning a mismatched snapshot.
        after={name:sha_file(ROOT/name) for name in live_dbs}
        if before!=after:raise RuntimeError("Work data changed during backup; stop writes and retry")
        verify(tmp_zip)
        os.replace(tmp_zip,dest)
    except BaseException:
        tmp_zip.unlink(missing_ok=True)
        raise
    return {"backup":str(dest),"files":len(files),
            "bytesUncompressed":sum(f["bytes"] for f in manifest["files"]),
            "bytesArchive":dest.stat().st_size,
            "personalSiteUntouched":True,"verified":True}

def _path_ok(name):
    if not isinstance(name,str) or not name or "\\" in name or ":" in name:
        return False
    p=PurePosixPath(name)
    return not p.is_absolute() and all(x not in {"",".",".."} for x in p.parts) and not any(x in {'.git','.backups','.maintenance'} for x in p.parts)

def verify(archive):
    archive=Path(archive).resolve()
    with zipfile.ZipFile(archive) as incoming:
        bad=incoming.testzip()
        if bad:raise ValueError("Corrupt ZIP entry: "+bad)
        names=incoming.namelist()
        if not names or len(names)!=len(set(names)) or names.count(MANIFEST)!=1:
            raise ValueError("Missing manifest or duplicate archive entries")
        manifest=json.loads(incoming.read(MANIFEST))
        if manifest.get("format")!=FORMAT or manifest.get("scope") not in ("WORK_ONLY",PRIVATE_SCOPE):
            raise ValueError("Not an authorized standalone Work backup")
        rows=manifest.get("files",[])
        if sorted(names)!=sorted([r["path"] for r in rows]+[MANIFEST]):
            raise ValueError("Files differ from signed inventory")
        for row in rows:
            name=row["path"]
            original=row.get('originalPath',name)
            if not _path_ok(name) or name.startswith(tuple(x+"/" for x in BLOCKED_ROOTS)):
                raise ValueError("Unsafe archive path: "+name)
            if original!=name and (not name.endswith('.kbw-zone-identifier-sidecar') or
                original!=name[:-len('.kbw-zone-identifier-sidecar')]+':Zone.Identifier' or
                ':' in original[:-len(':Zone.Identifier')] or
                not _path_ok(original[:-len(':Zone.Identifier')])):
                raise ValueError('Unsafe sidecar mapping: '+name)
            info=incoming.getinfo(name)
            if stat.S_IFMT(info.external_attr>>16)==stat.S_IFLNK:
                raise ValueError("Symlink in Work archive")
            with incoming.open(name) as stream:
                h=hashlib.sha256();length=0
                for chunk in iter(lambda:stream.read(1024*1024),b""):
                    h.update(chunk);length+=len(chunk)
            if h.hexdigest()!=row["sha256"] or length!=row["bytes"]:
                raise ValueError("Archive SHA mismatch: "+name)
    return {"verified":True,"fileCount":len(rows),
            "workOnly":True,"privateInstance":manifest['scope']==PRIVATE_SCOPE,
            "personalSiteUntouched":True,"archive":str(archive)}

def restore(archive,destination):
    archive=Path(archive).resolve()
    target=Path(destination).expanduser().resolve()
    if target==ROOT or ROOT in target.parents or target in ROOT.parents or target.name=="KB_Site":
        raise ValueError("Restore must be into a new separate directory, never the active Work or Personal site")
    if target.exists():
        raise FileExistsError("Restore destination must not exist: "+str(target))
    report=verify(archive)
    target.mkdir(parents=True,exist_ok=False)
    with zipfile.ZipFile(archive) as incoming:
        manifest=json.loads(incoming.read(MANIFEST))
        for item in manifest["files"]:
            stored=item["path"]
            rel=item.get('originalPath',stored)
            path=target/rel
            path.parent.mkdir(parents=True,exist_ok=True)
            with incoming.open(stored) as src,path.open("xb") as out:
                shutil.copyfileobj(src,out,1024*1024)
            if sha_file(path)!=item["sha256"]:
                raise ValueError("Restored file mismatch: "+rel)
            if rel in {"start.sh","stop.sh"}:path.chmod(0o755)
    return {"restored":str(target),"fileCount":report["fileCount"],
            "verified":True,"userDataOverwrite":False}

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("action",choices=("create","verify","restore"))
    parser.add_argument("archive",nargs="?")
    parser.add_argument("--to")
    parser.add_argument("--private-instance", action="store_true",
                        help="include local Work-only Agent/Skills/config/docs; keep encrypted and never publish")
    a=parser.parse_args()
    if a.action=="create":
        result=create(a.to,private_instance=a.private_instance)
    elif a.action=="verify":
        if not a.archive:parser.error("verify requires an archive path")
        result=verify(a.archive)
    else:
        if not a.archive or not a.to:parser.error("restore requires archive and --to")
        result=restore(a.archive,a.to)
    print(json.dumps(result,ensure_ascii=False,indent=2))
