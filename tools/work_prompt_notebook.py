"""Prompt Notebook V2: local-only, additive extension of the AI Resources registry.

Prompt resources keep their existing IDs, drafts, immutable snapshots and objects.
Do not run or install anything. Neither Notes/Work SQLite nor other resource
types are modified. Prompt flows are manual ordered links, not autonomous agents.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlparse

import work_resources as store

ROLES = {"steering", "task", "review", "workflow"}
TIMINGS = {"always-on", "kickoff", "planning", "execution", "review", "handoff"}
SCENARIOS = (
    "Steering & Instructions", "Vibe Coding", "Documentation & Presentation",
    "Research & Analysis", "Workflow & Agent Collaboration", "General",
)
DEFAULT_SCENARIO = "General"
MAX_BODY = 250_000
MAX_FLOW_STEPS = 24
VAR_PATTERN = re.compile(r"(?<!\{)\{\{\s*([a-zA-Z_][a-zA-Z_0-9]{0,63})\s*\}\}(?!\})")
NAME_PATTERN = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]{0,63}")

def _ensure(db):
    db.executescript("""
    CREATE TABLE IF NOT EXISTS prompt_notes (
      resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'task',
      timing TEXT NOT NULL DEFAULT 'execution',
      scenarios TEXT NOT NULL DEFAULT '["General"]',
      favorite INTEGER NOT NULL DEFAULT 0,
      last_used TEXT,
      updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS prompt_flows (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      scenario TEXT NOT NULL DEFAULT 'Vibe Coding',
      steps TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    );
    """)

def _prompt_only(info):
    if info["type"] != "prompt":
        raise store.ResourceError("prompt_resource_required", 422)

def _fields(body, existing=None):
    base = existing or {}
    role = body.get("role", base.get("role", "task"))
    timing = body.get("timing", base.get("timing", "execution"))
    scenarios = body.get("scenarios", base.get("scenarios", [DEFAULT_SCENARIO]))
    favorite = body.get("favorite", base.get("favorite", False))
    if role not in ROLES or timing not in TIMINGS:
        raise store.ResourceError("invalid_prompt_classification")
    if not isinstance(scenarios, list) or not scenarios or len(scenarios) > 8 or any(
        not isinstance(s, str) or not 0 < len(s) <= 80 for s in scenarios
    ) or len(set(scenarios)) != len(scenarios):
        raise store.ResourceError("invalid_prompt_scenarios")
    if type(favorite) is not bool:
        raise store.ResourceError("invalid_prompt_favorite")
    return {"role": role, "timing": timing, "scenarios": scenarios, "favorite": favorite}

def _check_text(content):
    if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_BODY:
        raise store.ResourceError("invalid_prompt_content")
    return content.replace("\r\n", "\n")

def variables(text):
    return sorted(set(VAR_PATTERN.findall(text)))

def render(text, values):
    """Strict plain-text substitution; no eval, HTML or network effects."""
    if not isinstance(values, dict) or len(values) > 50:
        raise store.ResourceError("invalid_prompt_variables")
    found = variables(text)
    if set(found) != set(values):
        raise store.ResourceError("prompt_variable_mismatch")
    if any(not isinstance(v, str) or len(v) > 25_000 for v in values.values()):
        raise store.ResourceError("invalid_prompt_variable_value")
    return VAR_PATTERN.sub(lambda match: values[match.group(1)], text)

def _meta(db, resource_id):
    _ensure(db)
    row = db.execute("SELECT * FROM prompt_notes WHERE resource_id=?", (resource_id,)).fetchone()
    if not row:
        # Existing pre-Notebook Prompt categories remain visible and are never
        # silently rewritten to General on the first save.
        legacy=db.execute("SELECT category FROM resources WHERE id=?", (resource_id,)).fetchone()
        scenario=(legacy["category"] if legacy else "") or DEFAULT_SCENARIO
        return {"role":"task","timing":"execution","scenarios":[scenario],
                "favorite":False,"lastUsed":None,"hasMetadata":False}
    return {"role":row["role"],"timing":row["timing"],
            "scenarios":json.loads(row["scenarios"]),"favorite":bool(row["favorite"]),
            "lastUsed":row["last_used"],"hasMetadata":True}

def _content(info):
    draft = info.get("draft")
    if draft:
        files = draft["files"]
    elif info["versions"]:
        files = store.version_detail(info["versions"][0]["id"])["files"]
    else:
        files = {}
    path = "PROMPT.md" if "PROMPT.md" in files else next(
        (k for k,v in files.items() if k.lower().endswith((".md",".txt")) and isinstance(v, str)), None)
    content=files.get(path, "") if path else ""
    return (content if isinstance(content,str) else ""), path or "PROMPT.md"

def list_prompts(query=""):
    if not isinstance(query,str) or len(query)>160:
        raise store.ResourceError("invalid_prompt_search")
    # Existing resource list includes all old Prompt IDs. Metadata is lazy/defaulted.
    items = store.list_resources(kind="prompt")
    found = []
    with store._db() as db:
        for item in items:
            meta = _meta(db, item["id"])
            detail = store.detail(item["id"])
            text, path = _content(detail)
            entry = {**item, **meta,
                     "preview":text[:260], "bodyLength":len(text),
                     "variables":variables(text),"filePath":path,
                     "versionCount":len(detail["versions"])}
            if query.casefold() not in " ".join([item["name"], item["description"],
                text, *meta["scenarios"],meta["role"],meta["timing"],*item["tags"]]).casefold():
                continue
            found.append(entry)
    return found

def detail(resource_id):
    info=store.detail(resource_id)
    _prompt_only(info)
    with store._db() as db:
        meta=_meta(db,resource_id)
    text, file_path = _content(info)
    return {**info, **meta, "body":text,"filePath":file_path,"variables":variables(text)}

def create(body):
    title = body.get("title","")
    if not isinstance(title,str) or not 0 < len(title.strip()) <= 120:
        raise store.ResourceError("invalid_prompt_title")
    description=body.get("description","")
    if not isinstance(description,str) or len(description)>1500:
        raise store.ResourceError("invalid_prompt_description")
    content=_check_text(body.get("content",""))
    fields=_fields(body)
    item=store.create_draft({"type":"prompt","name":title.strip(),
        "description":description,"category":fields["scenarios"][0],
        "files":{"PROMPT.md":content},"tags":[]})
    with store._db() as db:
        _ensure(db)
        db.execute("""INSERT INTO prompt_notes
            (resource_id,role,timing,scenarios,favorite,updated)
            VALUES(?,?,?,?,?,?)""",
            (item["id"],fields["role"],fields["timing"],json.dumps(fields["scenarios"]),
             int(fields["favorite"]),store.now()))
        store._audit(db,"prompt_notebook_created",item["id"])
    return detail(item["id"])

def save(body):
    resource_id=store._id(body.get("resourceId"))
    info=store.detail(resource_id)
    _prompt_only(info)
    if type(body.get("baseRevision")) is not int:
        raise store.ResourceError("revision_conflict",409)
    content=_check_text(body.get("content"))
    title=body.get("title",info["name"])
    description=body.get("description",info["description"])
    if not isinstance(title,str) or not 0 < len(title.strip()) <= 120 or not isinstance(description,str) or len(description)>1500:
        raise store.ResourceError("invalid_prompt_metadata")
    with store._db() as db:
        previous=_meta(db,resource_id)
    fields=_fields(body,previous)
    # Existing immutable versions remain intact; prompt edits create a new draft
    # instead of overwriting approved historical snapshots.
    draft=info["draft"]
    if draft is None:
        raise store.ResourceError("prompt_revision_required",409)
    # Retain arbitrary existing supplemental prompt files.
    files=dict(draft["files"])
    file_path="PROMPT.md" if "PROMPT.md" in files else next(
        (k for k,v in files.items() if k.lower().endswith((".md",".txt")) and isinstance(v,str)),"PROMPT.md")
    files[file_path]=content
    store.checked_files(files,"prompt")
    with store._db() as db:
        _ensure(db)
        db.execute("BEGIN IMMEDIATE")
        cursor=db.execute("""UPDATE drafts SET files=?,revision=revision+1,updated=?
                WHERE id=? AND resource_id=? AND revision=?""",
            (json.dumps(files),store.now(),draft["id"],resource_id,body["baseRevision"]))
        if cursor.rowcount!=1:
            raise store.ResourceError("revision_conflict",409)
        db.execute("UPDATE resources SET name=?,description=?,category=?,revision=revision+1,updated=? WHERE id=?",
            (title.strip(),description,fields["scenarios"][0],store.now(),resource_id))
        db.execute("""INSERT INTO prompt_notes(resource_id,role,timing,scenarios,favorite,updated)
            VALUES(?,?,?,?,?,?)
            ON CONFLICT(resource_id) DO UPDATE SET role=excluded.role,timing=excluded.timing,
                scenarios=excluded.scenarios,favorite=excluded.favorite,updated=excluded.updated""",
            (resource_id,fields["role"],fields["timing"],json.dumps(fields["scenarios"]),
             int(fields["favorite"]),store.now()))
        store._audit(db,"prompt_notebook_saved",resource_id)
    return detail(resource_id)

def start_revision(resource_id,version_id=None):
    info=store.detail(resource_id)
    _prompt_only(info)
    if info["draft"]:
        return detail(resource_id)
    if not info["versions"]:
        raise store.ResourceError("prompt_revision_unavailable",409)
    selected=version_id or info["versions"][0]["id"]
    store.new_draft_from_version(resource_id,selected)
    return detail(resource_id)

def mark_used(resource_id):
    info=store.detail(resource_id)
    _prompt_only(info)
    with store._db() as db:
        meta=_meta(db,resource_id)
        db.execute("""INSERT INTO prompt_notes(resource_id,role,timing,scenarios,favorite,last_used,updated)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(resource_id) DO UPDATE SET last_used=excluded.last_used""",
           (resource_id,meta["role"],meta["timing"],json.dumps(meta["scenarios"]),
            int(meta["favorite"]),store.now(),store.now()))
        store._audit(db,"prompt_copied",resource_id)
    return {"resourceId":resource_id,"lastUsed":store.now()}

def set_favorite(resource_id,favorite):
    if type(favorite) is not bool:
        raise store.ResourceError("invalid_prompt_favorite")
    info=store.detail(resource_id); _prompt_only(info)
    with store._db() as db:
        meta=_meta(db,resource_id)
        db.execute("""INSERT INTO prompt_notes(resource_id,role,timing,scenarios,favorite,updated)
            VALUES(?,?,?,?,?,?)
            ON CONFLICT(resource_id) DO UPDATE SET favorite=excluded.favorite,updated=excluded.updated""",
            (resource_id,meta["role"],meta["timing"],json.dumps(meta["scenarios"]),
             int(favorite),store.now()))
    return {"resourceId":resource_id,"favorite":favorite}

def _check_steps(steps):
    if not isinstance(steps,list) or not 1<=len(steps)<=MAX_FLOW_STEPS:
        raise store.ResourceError("invalid_prompt_flow_steps")
    result=[]
    for rid in steps:
        rid=store._id(rid)
        info=store.detail(rid)
        _prompt_only(info)
        result.append(rid)
    return result

def flows():
    with store._db() as db:
        _ensure(db)
        return [{**dict(r),"steps":json.loads(r["steps"])} for r in db.execute(
            "SELECT * FROM prompt_flows ORDER BY updated DESC LIMIT 100")]

def save_flow(body):
    title=body.get("title","")
    description=body.get("description","")
    scenario=body.get("scenario","Vibe Coding")
    if not isinstance(title,str) or not 0<len(title.strip())<=120 or not isinstance(description,str) or len(description)>1000 or not isinstance(scenario,str) or len(scenario)>80:
        raise store.ResourceError("invalid_prompt_flow")
    steps=_check_steps(body.get("steps"))
    flow_id=body.get("flowId")
    with store._db() as db:
        _ensure(db)
        if flow_id:
            flow_id=store._id(flow_id)
            if type(body.get("baseRevision")) is not int:
                raise store.ResourceError("revision_conflict",409)
            cursor=db.execute("""UPDATE prompt_flows SET title=?,description=?,scenario=?,steps=?,
              revision=revision+1,updated=? WHERE id=? AND revision=?""",
                (title.strip(),description,scenario,json.dumps(steps),store.now(),flow_id,body["baseRevision"]))
            if not cursor.rowcount:
                raise store.ResourceError("revision_conflict",409)
        else:
            flow_id=store.uid()
            timestamp=store.now()
            db.execute("INSERT INTO prompt_flows VALUES(?,?,?,?,?,1,?,?)",
                (flow_id,title.strip(),description,scenario,json.dumps(steps),timestamp,timestamp))
        store._audit(db,"prompt_flow_saved",flow_id)
    return next(x for x in flows() if x["id"]==flow_id)

def _steering_target(project_root,agent):
    if agent not in ("codex","claude-code"):
        raise store.ResourceError("unsupported_steering_agent")
    if not isinstance(project_root,str) or not project_root.startswith("/") or len(project_root)>1024:
        raise store.ResourceError("project_root_required")
    raw=Path(project_root)
    if "." in raw.parts or ".." in raw.parts or any(p.is_symlink() for p in (raw,*raw.parents)):
        raise store.ResourceError("unsafe_steering_project",403)
    # A dedicated project folder must exist, belong to the local user and be
    # under /home. Never write across Windows mounts or into personal KB_Site.
    if not raw.is_dir() or raw.stat().st_uid!=os.getuid() or len(raw.parts)<3 or raw.parts[1]!="home":
        raise store.ResourceError("unsafe_steering_project",403)
    personal=store.ROOT.parent/"KB_Site"
    if raw==personal or personal in raw.parents:
        raise store.ResourceError("personal_site_forbidden",403)
    target=raw/("AGENTS.md" if agent=="codex" else "CLAUDE.md")
    if target.is_symlink() or (target.exists() and (not target.is_file() or target.stat().st_uid!=os.getuid())):
        raise store.ResourceError("unsafe_steering_target",403)
    return target

def steering_preview(body):
    info=detail(body.get("resourceId"))
    if info["role"]!="steering":
        raise store.ResourceError("steering_role_required",422)
    content=info["body"]
    if not content.strip():
        raise store.ResourceError("empty_steering_prompt")
    if variables(content):
        raise store.ResourceError("steering_variables_must_be_rendered")
    path=_steering_target(body.get("projectRoot"),body.get("agent"))
    existing=path.read_bytes() if path.exists() else None
    if existing is not None and len(existing)>MAX_BODY:
        raise store.ResourceError("existing_steering_too_large")
    existing_hash=hashlib.sha256(existing).hexdigest() if existing is not None else None
    return {"resourceId":info["id"],"agent":body["agent"],"target":str(path),
        "existingHash":existing_hash,"conflict":existing is not None,
        "existingPreview":existing.decode("utf-8",errors="replace")[:4000] if existing else None,
        "content":content,"preview":content[:4000],"requiresConfirmation":True,
        "noExecutionPerformed":True}

def steering_export(body):
    if body.get("confirmation")!="Export this steering prompt":
        raise store.ResourceError("explicit_export_confirmation_required",403)
    plan=steering_preview(body)
    if "expectedTargetHash" not in body or body["expectedTargetHash"]!=plan["existingHash"]:
        raise store.ResourceError("steering_target_drift",409)
    if plan["conflict"] and body.get("onConflict")!="replace":
        raise store.ResourceError("steering_target_conflict",409)
    target=Path(plan["target"])
    backup_root=store.root()/"steering-export-backups"
    temporary=None
    backup=None
    try:
        # Recheck the target immediately before staging, fail closed on drift.
        current=target.read_bytes() if target.exists() and not target.is_symlink() else None
        if (hashlib.sha256(current).hexdigest() if current is not None else None)!=plan["existingHash"]:
            raise store.ResourceError("steering_target_drift",409)
        if current is not None:
            backup_root.mkdir(parents=True,exist_ok=True,mode=0o700)
            backup=backup_root/(store.uid()+".md")
            with backup.open("xb") as output:
                output.write(current)
            os.chmod(backup,0o600)
        fd, name=tempfile.mkstemp(prefix=".kbw-steering-",dir=target.parent)
        temporary=Path(name)
        with os.fdopen(fd,"w",encoding="utf-8") as out:
            out.write(plan["content"])
            out.flush();os.fsync(out.fileno())
        os.chmod(temporary,0o600)
        # Refresh if the file was changed between backup and replace.
        if target.is_symlink() or ((hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None)!=plan["existingHash"]):
            raise store.ResourceError("steering_target_drift",409)
        os.replace(temporary,target)
        temporary=None
        with store._db() as db:
            store._audit(db,"steering_exported",plan["resourceId"],detail(plan["resourceId"])["versions"][0]["id"] if detail(plan["resourceId"])["versions"] else None,
                         "Agent:"+plan["agent"]+"; target:"+plan["target"])
        return {"target":str(target),"backup":str(backup) if backup else None,
                "status":"exported","executesCode":False}
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
