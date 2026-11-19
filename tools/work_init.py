#!/usr/bin/env python3
"""Initialize an empty, company-approved KB_Work clone without importing user data.

This is NOT a migration or a restore. It refuses to initialize over an existing
Work SQLite database. Real records, File Hub attachments and personal/project
source material never cross the clone boundary.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import io
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import unicodedata

import work_hub_schema as schema
import work_hub_sections as sections
import work_hub_store as store

ROOT = Path(__file__).resolve().parents[1]
MARKER = "KB_WORK_STANDALONE_V1"

class AlreadyInitialized(RuntimeError):
    pass


def _verify_root(root: Path):
    marker = root / "WORKSPACE_KIND"
    if not marker.is_file() or marker.read_text(encoding="utf-8").strip() != MARKER:
        raise ValueError("Not a verified standalone KB_Work checkout")


def prepare_assets(root: Path) -> dict:
    """Generate only missing neutral local assets, never replace existing content."""
    root = Path(root).resolve()
    _verify_root(root)
    data = root / "data"
    data.mkdir(parents=True, exist_ok=True)
    index = data / "index.json"
    if not index.exists():
        index.write_text(json.dumps({
            "version": 2,
            "site": {"title": "万象知序 - Work", "tagline": "收集万象，梳理成序"},
            "domains": [], "collections": [], "deploymentProfile": "work"
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    agent_template = root / "AGENTS.template.md"
    agent = root / "AGENTS.md"
    if agent_template.is_file() and not agent.exists():
        agent.write_bytes(agent_template.read_bytes())
    # Only when called inside this checkout: build registry from the skills
    # actually present in the GitLab starter, never from another user's site.
    if root == ROOT and not (data / "project-skills.json").exists():
        import project_skills
        with redirect_stdout(io.StringIO()):
            built = project_skills.main(["build"])
        if built != 0:
            raise RuntimeError("Could not build the Work-only project skills catalog")
    return {"dataIndex": str(index.relative_to(root)), "agentInstructions": agent.exists()}


def initialize(root: Path = ROOT) -> dict:
    root = Path(root).resolve()
    _verify_root(root)
    db = root / "content" / "work-hub" / "work.sqlite3"
    # Stronger than a row-count check: an empty but already-created DB might
    # belong to the user, so refuse to overwrite or reinitialize it.
    now = datetime.now(timezone.utc).isoformat()
    db.parent.mkdir(parents=True, exist_ok=True)
    # Atomic exclusive create closes the exists()/connect() race. Never open
    # a pre-existing user's database for bootstrap writes.
    try:
        with db.open("xb"):
            pass
    except FileExistsError as exc:
        raise AlreadyInitialized("Work database already exists. Nothing changed; use existing data or restore explicitly.") from exc
    try:
        with store._connection(db) as con:
            for statement in schema.DDL:
                con.execute(statement)
            for section_id, title, order, kind, rules in sections.SEED_SECTIONS:
                con.execute(
                    "INSERT INTO work_sections(id,title,title_key,sort_order,item_kind,rules_json,created_at,updated_at)"
                    " VALUES(?,?,?,?,?,?,?,?)",
                    (section_id, title, unicodedata.normalize("NFC", title).casefold(),
                     order, kind, json.dumps(rules, sort_keys=True), now, now))
            for key, value in (("schema_version", str(schema.SCHEMA_VERSION)),
                               ("shell.root", "react"),
                               ("initializedAt", now)):
                con.execute(
                    "INSERT INTO work_meta(key,value,updated_at) VALUES(?,?,?)",
                    (key, value, now))
            if con.execute("SELECT COUNT(*) FROM records").fetchone()[0] != 0:
                raise AssertionError("New Work database was not empty")
            issues = con.execute("PRAGMA foreign_key_check").fetchall()
            if issues:
                raise RuntimeError("Fresh database foreign key check failed")
    except Exception as exc:
        # Fail closed: leave the owned new file for manual investigation rather
        # than unlinking a DB which another local process might have opened.
        # The next initializer call still refuses to overwrite it.
        raise RuntimeError("New Work DB initialization failed. The file was preserved; inspect it before retrying.") from exc
    # Fresh clones start with the current Notes V3 schema, not the legacy editor.
    # This acts only on the newly created zero-record database; existing user DBs
    # remain protected by the exclusive-create guard above.
    import work_notebook
    notebook = work_notebook.migrate(path=db)
    if notebook['sourceCount'] != 0 or notebook['mappedCount'] != 0:
        raise RuntimeError('A fresh Work clone must never import legacy Notes')
    import work_notebook_v34
    journal = work_notebook_v34.migrate(path=db)
    if not journal['ready'] or journal['datedPages'] != 0:
        raise RuntimeError('Fresh Work clone Notes V3.4 initialization failed')
    import work_notebook_v35
    structured = work_notebook_v35.migrate(path=db)
    if not structured['ready']:
        raise RuntimeError('Fresh Work clone Notes V3.5 initialization failed')
    for collection in ("Projects", "General", "Shared"):
        (root / "library" / collection).mkdir(parents=True, exist_ok=True)
    for folder in ("content/file-hub", "content/work-hub/media", "content/work-hub/notes"):
        (root / folder).mkdir(parents=True, exist_ok=True)
    prepare_assets(root)
    return {
        "status": "initialized", "records": 0, "revisions": 0, "links": 0,
        "sectionTitles": [row[1] for row in sections.SEED_SECTIONS],
        "notebookVersion": 4, "notebookV35Ready": True,
        "privateRuntime": ["content/", "library/", "projects/", ".backups/"]
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="KB_Work checkout to initialize")
    parser.add_argument("--assets-only", action="store_true",
                        help="Create only absent generic metadata for a restored Work checkout; do not touch DB")
    args = parser.parse_args(argv)
    try:
        result = {"status": "assets-prepared", **prepare_assets(args.root)} if args.assets_only else initialize(args.root)
    except AlreadyInitialized as err:
        print(json.dumps({"status": "existing", "notice": str(err)}, ensure_ascii=False))
        return 0
    except (ValueError, OSError, RuntimeError) as err:
        print(f"Work init refused: {err}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
