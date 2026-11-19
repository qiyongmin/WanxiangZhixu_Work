"""Untrusted resource acquisition. Explicit import preview, no code execution.

Only public GitHub/GitLab archive hosts are network-enabled; arbitrary URLs and
private GitLab are deliberately disabled pending approved enterprise egress.
"""
from __future__ import annotations
import base64
import io
import json
from pathlib import Path
import stat
from urllib.parse import urlsplit, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler
import zipfile

import work_resources as store

ALLOWED = {"github.com", "api.github.com", "codeload.github.com", "gitlab.com"}
MAX_ARCHIVE = 16 * 1024 * 1024

class StrictRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urlsplit(newurl)
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED or parsed.username or parsed.password:
            raise store.ResourceError("unsafe_redirect", 403)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def _download(url):
    parsed=urlsplit(url)
    if parsed.scheme!="https" or parsed.hostname not in ALLOWED or parsed.username or parsed.password or parsed.port not in (None,443):
        raise store.ResourceError("source_host_not_approved",403)
    try:
        response=build_opener(StrictRedirect()).open(Request(url,headers={"User-Agent":"KB-Work-ResourceHub/1.0","Accept":"application/octet-stream"}),timeout=12)
        with response:
            content=response.read(MAX_ARCHIVE+1)
        if len(content)>MAX_ARCHIVE:
            raise store.ResourceError("archive_too_large",413)
        return content
    except (TimeoutError, OSError, ValueError) as e:
        if isinstance(e,store.ResourceError):
            raise
        raise store.ResourceError("source_fetch_unavailable",503) from None

def _repo_archive(url):
    p=urlsplit(url)
    if p.scheme!="https" or p.hostname not in {"github.com","gitlab.com"} or p.username or p.password or p.port not in (None,443):
        raise store.ResourceError("source_host_not_approved",403)
    pieces=[x for x in p.path.split("/") if x]
    if len(pieces)<2 or any(x in (".","..") for x in pieces) or p.query or p.fragment:
        raise store.ResourceError("invalid_repository_url")
    if p.hostname=="github.com":
        owner,repo=pieces[:2]
        if len(pieces)>2 and (len(pieces)<4 or pieces[2] not in ("tree","blob")):
            raise store.ResourceError("invalid_repository_path")
        ref=pieces[3] if len(pieces)>=4 else "HEAD"
        subdir="/".join(pieces[4:])
        if not all(part.replace("-","").replace("_","").replace(".","").isalnum() for part in (owner,repo,ref)):
            raise store.ResourceError("invalid_repository_url")
        zip_url=f"https://api.github.com/repos/{owner}/{repo.removesuffix('.git')}/zipball/{quote(ref,safe='')}"
        return zip_url, subdir
    # GitLab archive for public projects; private GitLab/enterprise host is not auto-enabled.
    if len(pieces)>2 and pieces[-2]=="-":
        raise store.ResourceError("unsupported_gitlab_path")
    project="/".join(pieces)
    zip_url="https://gitlab.com/api/v4/projects/"+quote(project,safe="")+"/repository/archive.zip"
    return zip_url, ""

def _zip_members(raw, *, subdir=""):
    try:
        archive=zipfile.ZipFile(io.BytesIO(raw))
    except (zipfile.BadZipFile,ValueError):
        raise store.ResourceError("invalid_archive")
    entries={}
    with archive:
        members=archive.infolist()
        if len(members)>1000:
            raise store.ResourceError("archive_file_limit",413)
        total=0
        for item in members:
            if item.is_dir():
                continue
            if item.flag_bits & 0x1:
                raise store.ResourceError("encrypted_archive_rejected")
            if stat.S_IFMT(item.external_attr>>16)==stat.S_IFLNK:
                raise store.ResourceError("archive_symlink_rejected")
            p=item.filename
            if p.startswith("/") or "\\" in p or ":" in p or "\x00" in p or any(x in ("",".","..") for x in p.split("/")):
                raise store.ResourceError("unsafe_archive_path")
            total+=item.file_size
            if item.file_size>store.MAX_FILE_BYTES or total>store.MAX_BYTES*4:
                raise store.ResourceError("archive_extracted_limit",413)
            if p in entries:
                raise store.ResourceError("duplicate_archive_file")
            entries[p]=item
        # GitHub/GitLab archives add a root directory prefix. Inspect actual files,
        # not remote filenames or arbitrary symlinks.
        roots=[p for p in entries if p.endswith("/SKILL.md") or p=="SKILL.md"]
        if subdir:
            roots=[p for p in roots if p.endswith("/"+subdir.strip("/")+"/SKILL.md")]
        if not roots:
            raise store.ResourceError("skill_md_not_found")
        if len(roots)!=1:
            raise store.ResourceError("multiple_skills_select_subdirectory",409)
        key=roots[0][:-len("SKILL.md")]
        selected={}
        for path,item in entries.items():
            if not path.startswith(key):
                continue
            rel=path[len(key):]
            store._clean_path(rel)
            if len(selected)>=store.MAX_FILES:
                raise store.ResourceError("too_many_skill_files",413)
            blob=archive.read(item)
            if len(blob)!=item.file_size:
                raise store.ResourceError("archive_integrity_error")
            try:
                selected[rel]=blob.decode("utf-8")
            except UnicodeDecodeError:
                selected[rel]={"base64":base64.b64encode(blob).decode("ascii")}
        store.checked_files(selected,"skill")
        return selected

def _local_source(path_string):
    if not isinstance(path_string,str) or not path_string.startswith("/") or len(path_string)>1024:
        raise store.ResourceError("absolute_local_path_required")
    path=Path(path_string)
    # Respect the strict KB_Work / KB_Site boundary before any directory scan.
    if ".." in path.parts or "." in path.parts:
        raise store.ResourceError("unsafe_local_source",403)
    personal=store.ROOT.parent/"KB_Site"
    if path==personal or personal in path.parents:
        raise store.ResourceError("personal_site_forbidden",403)
    if any(part.is_symlink() for part in (path,*path.parents)):
        raise store.ResourceError("symlink_source_rejected",403)
    if path.is_symlink():
        raise store.ResourceError("symlink_source_rejected",403)
    if path.is_file() and path.suffix.lower()==".zip":
        if path.stat().st_size>MAX_ARCHIVE:
            raise store.ResourceError("archive_too_large",413)
        return _zip_members(path.read_bytes())
    if path.is_file() and path.name=="SKILL.md":
        path=path.parent
    if not path.is_dir() or path.is_symlink():
        raise store.ResourceError("unsupported_import_source")
    selected={}
    for item in sorted(path.rglob("*")):
        if item.is_symlink():
            raise store.ResourceError("symlink_source_rejected",403)
        if not item.is_file():
            continue
        rel=item.relative_to(path).as_posix()
        store._clean_path(rel)
        if item.stat().st_size>store.MAX_FILE_BYTES or len(selected)>=store.MAX_FILES:
            raise store.ResourceError("import_limit_exceeded",413)
        raw=item.read_bytes()
        try:
            selected[rel]=raw.decode("utf-8")
        except UnicodeDecodeError:
            selected[rel]={"base64":base64.b64encode(raw).decode("ascii")}
    store.checked_files(selected,"skill")
    return selected

def preview(body):
    mode=body.get("sourceType")
    source=body.get("source","")
    if not isinstance(source,str):
        raise store.ResourceError("invalid_source")
    if mode=="local":
        files=_local_source(source)
    elif mode=="url":
        uri,subdir=_repo_archive(source)
        files=_zip_members(_download(uri),subdir=subdir)
    else:
        raise store.ResourceError("invalid_source_type")
    report=store.security_report("skill",store.checked_files(files,"skill"))
    sample=files.get("SKILL.md","")
    if not isinstance(sample,str):
        sample=""
    return {"type":"skill","files":files,"name":_skill_name(sample),
            "description":"Imported for review; not executed","source":{"type":mode,"uri":source},
            "security":report,"importedAs":"private-draft"}

def _skill_name(markdown):
    for line in markdown.splitlines()[:25]:
        if line.startswith("name:"):
            return line[5:].strip().strip('"\'')[:120] or "Imported Skill"
    return "Imported Skill"
