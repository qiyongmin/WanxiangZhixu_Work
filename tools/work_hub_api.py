"""Work Hub v2 API routing (Phase 1): pure ``(method, route, params, body, ctx) -> (status, payload)``.

No HTTP and no sockets here; ``work_server`` parses the request, calls ``handle``
and writes the result. Success is ``{"ok": true, "data": ...}``; failure is
``{"ok": false, "error", "code", "details"?}`` (design 5 / 13.1).

ctx keys (all optional, used by tests): ``path`` (database file), ``root``
(workspace root for ``backup-create``), ``backup_dir`` (for ``view=schema``).
Until the database is migrated every view/action except ``schema``, ``migrate``
and ``backup-create`` answers 409 ``migration_required`` without opening the
database for writing.
"""
from __future__ import annotations
import hashlib
import json
import subprocess
import sys
import traceback
from pathlib import Path

import work_hub_admin as admin
import work_hub_agent as agent
import work_hub_nodes as nodes
import work_hub_sections as sections
import work_hub_paths as paths
import work_hub_schema as schema
import work_hub_store as store
import work_notebook as notebook
import work_notebook_v34 as notebook_v34
import work_notebook_v35 as notebook_v35
import work_notebook_purge as notebook_purge
import work_migrate
import work_shell

ROUTE = "/api/work-hub"
UNKNOWN_ENDPOINT = "Unknown Work API endpoint"
BACKUP_TIMEOUT = 120
LARGE_BODY_LIMIT = 12 * 1024 * 1024
LARGE_ACTIONS = frozenset({"summary-set", "notes-save", "notebook-page-save", "notebook-page-create", "notebook-quick-capture", "notebook-v35-document-save"})   # media-upload keeps its legacy limit
GET_VIEWS = ("schema", "sections", "tree", "node", "children", "activity", "notes", "materials", "materials-v3",
             "tasks", "cockpit", "reminders", "search", "tags", "tag-nodes",
             "summary-history", "file-refs", "agent-writes", "change-proposals", "integrity", "removed",
             "notebook-status", "notebook-sections", "notebook-pages", "notebook-page",
             "notebook-page-history", "notebook-page-revision", "notebook-event", "notebook-events",
             "notebook-timeline", "notebook-v35-status", "notebook-v35-page",
             "notebook-v35-search", "notebook-v35-email-preview", "notebook-v35-page-options",
             "notebook-v35-staged", "notebook-v35-history", "notebook-delete-preview")
POST_ACTIONS = ("migrate", "backup-create", "node-create", "node-update", "node-move", "node-reorder",
                "node-lifecycle", "summary-set", "reminder-handle", "link-add", "link-remove",
                "notes-save", "summary-rollback", "material-add", "material-remove", "material-meta",
                "agent-confirm", "agent-undo", "proposal-approve", "proposal-reject",
                "section-create", "section-rename", "section-reorder", "section-delete",
                "section-rule-set", "backup-verify", "shell-switch", "shell-rollback",
                "notebook-section-create", "notebook-section-rename", "notebook-section-reorder", "notebook-section-delete",
                "notebook-page-create", "notebook-page-save", "notebook-page-move", "notebook-page-archive",
                "notebook-page-restore", "notebook-page-reorder", "notebook-page-link", "notebook-page-unlink",
                "notebook-event-create", "notebook-event-save", "notebook-event-archive", "notebook-quick-capture",
                "notebook-section-archive", "notebook-section-restore", "notebook-page-timeline-date-set",
                "notebook-event-restore", "notebook-v35-migrate",
                "notebook-v35-document-save", "notebook-v35-index-page",
                "notebook-v35-file-sync", "notebook-v35-maintenance", "notebook-permanent-delete")
MULTI_PARAMS = frozenset(k + s for k in ("status", "priority", "tag", "section") for s in ("", "[]"))
UNMIGRATED_OK = frozenset({"schema", "migrate", "backup-create"})
_ROOT = Path(__file__).resolve().parents[1]


def is_view(view):
    return view in GET_VIEWS


def is_action(action):
    return action in POST_ACTIONS


def is_large_action(action):
    return action in LARGE_ACTIONS


# --------------------------------------------------------------------------
# Responses
# --------------------------------------------------------------------------
def _ok(data):
    return 200, {"ok": True, "data": data}


def _fail(status, code, message, details=None, **extra):
    body = {"ok": False, "error": message, "code": code}
    if details:
        body["details"] = details
    body.update(extra)
    return status, body


def error_response(exc):
    """Map any exception to ``(status, payload)``. Writes were already rolled back."""
    if isinstance(exc, nodes.NodeError):
        return exc.status, exc.payload()
    if isinstance(exc, schema.MigrationRequired):
        return _fail(409, "migration_required", str(exc))
    if isinstance(exc, work_migrate.BackupRequired):
        return _fail(409, "backup_required", str(exc), {"hint": work_migrate.BACKUP_HINT})
    if isinstance(exc, store.HierarchyError):
        return _fail(exc.status, exc.code, str(exc), exc.details)
    if isinstance(exc, store.Conflict):
        return _fail(409, "revision_conflict", str(exc))
    if isinstance(exc, paths.LocatorError):
        return exc.status, exc.payload()
    if isinstance(exc, ValueError) and isinstance(getattr(exc, "status", None), int) \
            and isinstance(getattr(exc, "code", None), str):   # SectionRuleViolation, ContentError, ...
        return _fail(exc.status, exc.code, str(exc), getattr(exc, "details", None))
    if isinstance(exc, store.NotFound):
        return _fail(404, "node_not_found", str(exc))
    if isinstance(exc, ValueError) and not isinstance(exc, (UnicodeError, json.JSONDecodeError)):
        return _fail(400, "invalid_request", str(exc))
    print("work_hub_api internal error:", file=sys.stderr)
    traceback.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)
    return _fail(500, "internal_error", "内部错误，操作已回滚，数据与调用前一致")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _db_path(ctx):
    path = ctx.get("path")
    return Path(path) if path is not None else Path(store.DB_PATH)


def _single(params):
    out = {}
    for key, value in (params or {}).items():
        if key in MULTI_PARAMS and isinstance(value, (list, tuple)):
            out[key] = list(value)          # filter dimensions keep every repeated value
        else:
            out[key] = value[0] if isinstance(value, (list, tuple)) and value else value
    return out


def _required(params, key):
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise nodes._fields_error([(key, "必填")])
    return value


def _jsonable(value):
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


# --------------------------------------------------------------------------
# Views
# --------------------------------------------------------------------------
def _view_schema(params, ctx, db):
    state = work_migrate.read_state(db)
    backup = work_migrate.backup_status(backup_dir=ctx.get("backup_dir"))
    return {"version": state["schemaVersion"], "migrated": state["migrated"],
            "backup": {"ok": backup["ok"], "newest": backup["newest"],
                       "ageHours": backup["ageHours"], "reason": backup["reason"]},
            "shellRoot": "shell" if work_shell.root_is_shell(db) else "legacy"}


def _view_sections(params, ctx, db):
    return nodes.sections_view(path=db)


def _view_tree(params, ctx, db):
    return nodes.tree_view(path=db, now=params.get("now") or None)


def _view_node(params, ctx, db):
    node_id, node_path = params.get("id") or None, params.get("path") or None
    return nodes.node_view(id=node_id, node_path=node_path, path=db)


def _view_children(params, ctx, db):
    return nodes.children_view(_required(params, "id"), limit=params.get("limit"),
                               offset=params.get("offset"), path=db)


def _view_removed(params, ctx, db):
    return nodes.removed_view(path=db)
def _view_activity(params, ctx, db):
    return nodes.activity_view(_required(params, "id"), limit=params.get("limit"),
                               before=params.get("before"), path=db)


def _view_notebook_status(params, ctx, db):
    return notebook.status(path=db)

def _view_notebook_sections(params, ctx, db):
    if notebook.status(path=db).get("version")==4:
        return notebook_v34.sections_view(params,path=db)
    return notebook.sections_view(params,path=db)

def _view_notebook_pages(params, ctx, db):
    if notebook.status(path=db).get("version")==4:
        return notebook_v34.pages_view(params,path=db)
    return notebook.pages_view(params,path=db)

def _view_notebook_timeline(params, ctx, db):
    return notebook_v34.timeline_view(params,path=db)

def _view_notebook_page(params, ctx, db):
    if notebook.status(path=db).get("version")==4:
        return notebook_v34.page_view(params,path=db)
    return notebook.page_view(params,path=db)

def _view_notebook_history(params, ctx, db):
    return notebook.history_view(params,path=db)

def _view_notebook_revision(params,ctx,db):
    return notebook.revision_view(params,path=db)

def _view_notebook_event(params,ctx,db):
    if notebook.status(path=db).get("version")==4:
        return notebook_v34.event_view(params,path=db)
    return notebook.event_view(params,path=db)

def _view_notebook_events(params, ctx, db):
    return notebook.timeline_view(params,path=db)

def _view_notes(params, ctx, db):
    return nodes.notes_view(_required(params, "id"), path=db)


def _view_materials(params, ctx, db):
    return nodes.materials_view(_required(params, "id"), path=db)


def _view_materials_v3(params, ctx, db):
    return nodes.materials_v3_view(_required(params, "id"), path=db,
        q=params.get("q") or "", limit=params.get("limit") or 100,
        offset=params.get("offset") or 0, format_filter=params.get("format") or "",
        source=params.get("source") or "", purpose=params.get("purpose") or "",
        tag_filter=_first(params.get("tag")) or "", sort_by=params.get("sort") or "created")


def _view_tasks(params, ctx, db):
    keys = ("status", "status[]", "priority", "priority[]", "tag", "tag[]",
            "section", "section[]", "dueFrom", "dueTo")
    filters = {k: params[k] for k in keys if k in params}
    return nodes.tasks_view(scope=params.get("scope") or "all", id=params.get("id") or None,
                            direct=params.get("direct"), filters=filters, path=db,
                            now=params.get("now") or None)


def _view_cockpit(params, ctx, db):
    return nodes.cockpit_view(today=params.get("today") or None, now=params.get("now") or None,
                              group=params.get("group") or None, path=db)


def _view_reminders(params, ctx, db):
    return nodes.reminders_view(now=params.get("now") or None, path=db)


def _first(value):
    """Views with a single-valued parameter that shares its name with a filter dimension."""
    return value[0] if isinstance(value, list) and value else (None if isinstance(value, list) else value)


def _view_search(params, ctx, db):
    return nodes.search_view(params.get("q"), limit=params.get("limit") or None,
                             section=_first(params.get("section")) or None, path=db)


def _view_tags(params, ctx, db):
    return nodes.tags_view(path=db)


def _view_tag_nodes(params, ctx, db):
    return nodes.tag_nodes_view(_first(params.get("tag")), path=db)


def _view_summary_history(params, ctx, db):
    return nodes.summary_history_view(_required(params, "id"), path=db)


def _view_file_refs(params, ctx, db):
    return nodes.file_refs_view(params.get("ids"), path=db)


def _view_agent_writes(params, ctx, db):
    return agent.agent_writes_view(params, path=db)


def _view_change_proposals(params, ctx, db):
    return agent.change_proposals_view(params, path=db)


def _view_integrity(params, ctx, db):
    include = str(_first(params.get("backup")) or "").lower() in ("1", "true", "yes")
    return admin.integrity_view(db, ctx.get("root"), include_backup=include,
                                backup_dir=ctx.get("backup_dir"), now=params.get("now") or None)


_VIEWS = {"notebook-status":_view_notebook_status,"notebook-sections":_view_notebook_sections,
          "notebook-pages":_view_notebook_pages,"notebook-page":_view_notebook_page,
          "notebook-page-history":_view_notebook_history,"notebook-page-revision":_view_notebook_revision,
          "notebook-event":_view_notebook_event,"notebook-events":_view_notebook_events,
          "notebook-timeline":_view_notebook_timeline,
          "notebook-delete-preview":lambda params,ctx,db: notebook_purge.preview(params,path=db),
          "notebook-v35-status":lambda params,ctx,db: notebook_v35.state(db),
          "notebook-v35-page":lambda params,ctx,db: notebook_v35.page_document(params,path=db),
          "notebook-v35-search":lambda params,ctx,db: notebook_v35.search(params,path=db),
          "notebook-v35-email-preview":lambda params,ctx,db: notebook_v35.email_preview(params,path=db),
          "notebook-v35-page-options":lambda params,ctx,db: notebook_v35.page_options(params,path=db),
          "notebook-v35-staged":lambda params,ctx,db: notebook_v35.staged_files(params,path=db),
          "notebook-v35-history":lambda params,ctx,db: notebook_v35.knowledge_history(params,path=db),
          "integrity": _view_integrity, "summary-history": _view_summary_history, "file-refs": _view_file_refs,
          "agent-writes": _view_agent_writes, "change-proposals": _view_change_proposals, "tasks": _view_tasks, "cockpit": _view_cockpit, "reminders": _view_reminders,
          "search": _view_search, "tags": _view_tags, "tag-nodes": _view_tag_nodes,
          "schema": _view_schema, "sections": _view_sections, "tree": _view_tree,
          "node": _view_node, "children": _view_children, "activity": _view_activity,
          "notes": _view_notes, "materials": _view_materials, "materials-v3": _view_materials_v3, "removed": _view_removed}


# --------------------------------------------------------------------------
# Actions
# --------------------------------------------------------------------------
def _action_migrate(body, ctx, db):
    # ctx overrides exist for tests; work_migrate refuses them for the live database.
    return _jsonable(work_migrate.migrate(db, backup_dir=ctx.get("backup_dir"),
                                          backup_check=ctx.get("backup_check")))


def run_backup(root):
    """Run ``tools/work_backup.py create`` for the workspace at ``root`` (patched in tests)."""
    return subprocess.run([sys.executable, str(Path(root) / "tools" / "work_backup.py"), "create"],
                          cwd=str(root), capture_output=True, text=True, timeout=BACKUP_TIMEOUT)


def _incomplete(root):
    base = Path(root) / ".backups"
    return set(base.glob("*.incomplete")) if base.is_dir() else set()


def _action_backup_create(body, ctx, db):
    root = Path(ctx.get("root") or _ROOT)
    stale = _incomplete(root)
    message, status = None, 500
    try:
        done = run_backup(root)
    except subprocess.TimeoutExpired:
        message = "备份超时（%d 秒），已放弃" % BACKUP_TIMEOUT
    except OSError as exc:
        message = "无法启动备份: %s" % exc
    else:
        if done.returncode == 0:
            try:
                result = json.loads(done.stdout)
                archive = Path(result["backup"])
                digest = hashlib.sha256()
                with archive.open("rb") as handle:
                    for block in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(block)
                return {"path": str(archive), "sha256": digest.hexdigest(),
                        "files": result["files"], "bytes": archive.stat().st_size}
            except (ValueError, KeyError, TypeError, OSError):
                message = "备份已结束，但无法确认归档"
        else:
            tail = (done.stderr or done.stdout or "").strip().splitlines()
            message = "备份失败: " + (tail[-1] if tail else "exit %d" % done.returncode)
            if "changed during backup" in (done.stderr or ""):
                status = 409
    for leftover in _incomplete(root) - stale:       # a failed attempt must leave nothing half-written
        leftover.unlink(missing_ok=True)
    code = "backup_data_changed" if status == 409 else "internal_error"
    return _FailedAction(status, code, message)


class _FailedAction:
    """Returned (not raised) by an action to report a mapped failure without a traceback."""
    def __init__(self, status, code, message):
        self.response = _fail(status, code, message)


def _node_action(function):
    def run(body, ctx, db):
        return function(body, path=db)
    return run


def _action_backup_verify(body, ctx, db):
    return admin.backup_verify(db, ctx.get("root"), ctx.get("backup_dir"), body.get("now") or None)


def _action_shell_switch(body, ctx, db):
    return admin.shell_switch(db, ctx.get("root"), ctx.get("backup_dir"), body.get("now") or None)


def _action_shell_rollback(body, ctx, db):
    return admin.shell_rollback(db)


def _notebook_page_action(body,ctx,db):
    """Refresh structured knowledge after legacy Page metadata CAS operations."""
    result=notebook.page_action(body,path=db)
    if body.get('action') in ('notebook-page-save','notebook-page-move',
                              'notebook-page-archive','notebook-page-restore'):
        page=result.get('page') if isinstance(result,dict) else None
        if page and page.get('documentFormat')=='json':
            try:notebook_v35.index_page(page['id'],path=db)
            except (ValueError,sqlite3.Error,OSError):pass
    return result


_ACTIONS = {**{action: _node_action(notebook.section_action) for action in
               ("notebook-section-create", "notebook-section-rename", "notebook-section-reorder", "notebook-section-delete")},
            **{action: _notebook_page_action for action in
               ("notebook-page-create", "notebook-page-save", "notebook-page-move", "notebook-page-archive",
                "notebook-page-restore", "notebook-page-reorder", "notebook-page-link", "notebook-page-unlink")}, 
            **{action: _node_action(notebook.event_action) for action in
               ("notebook-event-create", "notebook-event-save", "notebook-event-archive", "notebook-quick-capture")},
            **{action: _node_action(notebook_v34.archive_section) for action in
               ("notebook-section-archive", "notebook-section-restore")},
            "notebook-page-timeline-date-set": _node_action(notebook_v34.timeline_date_set),
            "notebook-permanent-delete": _node_action(notebook_purge.delete),
            "notebook-event-restore": _node_action(notebook_v34.restore_event),
            "notebook-v35-migrate": lambda body,ctx,db: notebook_v35.migrate(path=db),
            "notebook-v35-document-save": _node_action(notebook_v35.document_save),
            "notebook-v35-index-page": lambda body,ctx,db: notebook_v35.index_page(body.get("pageId"),path=db),
            "notebook-v35-file-sync": lambda body,ctx,db: notebook_v35.reconcile_file_links(path=db),
            "notebook-v35-maintenance": lambda body,ctx,db: notebook_v35.reconcile_pending(path=db),
            "backup-verify": _action_backup_verify, "shell-switch": _action_shell_switch,
            "shell-rollback": _action_shell_rollback,
            "section-create": _node_action(sections.section_create),
            "section-rename": _node_action(sections.section_rename),
            "section-reorder": _node_action(sections.section_reorder),
            "section-delete": _node_action(sections.section_delete),
            "section-rule-set": _node_action(sections.section_rule_set),
            "migrate": _action_migrate, "backup-create": _action_backup_create,
            "node-create": _node_action(nodes.node_create),
            "node-update": _node_action(nodes.node_update),
            "node-move": _node_action(nodes.node_move),
            "node-reorder": _node_action(nodes.node_reorder),
            "node-lifecycle": _node_action(nodes.node_lifecycle),
            "summary-set": _node_action(nodes.summary_set),
            "reminder-handle": _node_action(nodes.reminder_handle),
            "link-add": _node_action(nodes.link_add),
            "link-remove": _node_action(nodes.link_remove),
            "notes-save": _node_action(nodes.notes_save),
            "summary-rollback": _node_action(nodes.summary_rollback),
            "material-add": _node_action(nodes.material_add),
            "material-remove": _node_action(nodes.material_remove),
            "material-meta": _node_action(nodes.material_meta),
            "agent-confirm": _node_action(agent.agent_confirm),
            "agent-undo": _node_action(agent.agent_undo),
            "proposal-approve": _node_action(agent.proposal_approve),
            "proposal-reject": _node_action(agent.proposal_reject)}


def _handle_agent(method, route, params, body, ctx):
    """``/api/work-hub/agent/*``: no token, same Host/Origin gate as every other write (server side)."""
    try:
        db = _db_path(ctx)
        if route[len(agent.AGENT_PREFIX):] not in (
                agent.GET_ROUTES if method == "GET" else agent.POST_ROUTES):
            return _fail(404, "unknown_endpoint", UNKNOWN_ENDPOINT)
        if not work_migrate.read_state(db)["migrated"]:
            raise schema.MigrationRequired()
        result = agent.dispatch(method, route, _single(params) if method == "GET" else {}, body, db,
                                ctx.get("client"))
        return _ok(result)
    except Exception as exc:  # noqa: BLE001 - every failure is mapped to a response
        return error_response(exc)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------
def handle(method, route, params, body, ctx=None):
    ctx = ctx or {}
    if agent.is_agent_route(route) and method in ("GET", "POST"):
        return _handle_agent(method, route, params, body, ctx)
    if route != ROUTE or method not in ("GET", "POST"):
        return _fail(404, "unknown_endpoint", UNKNOWN_ENDPOINT)
    try:
        db = _db_path(ctx)
        if method == "GET":
            params = _single(params)
            name = params.get("view")
            table, kind = _VIEWS, "view"
            argument = params
        else:
            if not isinstance(body, dict):
                raise nodes.NodeError("请求体必须是对象", code="invalid_body")
            name = body.get("action")
            table, kind = _ACTIONS, "action"
            argument = body
        if not isinstance(name, str) or name not in table:
            return _fail(400, "invalid_request", "Unknown " + kind)
        if name not in UNMIGRATED_OK and not work_migrate.read_state(db)["migrated"]:
            raise schema.MigrationRequired()
        result = table[name](argument, ctx, db)
        if isinstance(result, _FailedAction):
            return result.response
        return _ok(result)
    except Exception as exc:  # noqa: BLE001 - every failure is mapped to a response
        return error_response(exc)
