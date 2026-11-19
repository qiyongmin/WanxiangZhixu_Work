"""Shared base for the Phase 2 backend tests (temporary databases only).

Each test module keeps its own ``setUpModule`` / ``tearDownModule`` calling
``module_setup()`` / ``module_teardown()`` so the write guard and the live-database hash
check run per module (unittest only honours those hooks in the module under test).
"""
from __future__ import annotations
import contextlib
import json
import sqlite3
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import work_fixture as fx  # noqa: E402
import work_hub_nodes as nodes  # noqa: E402
import work_hub_paths  # noqa: E402
import work_hub_store as store  # noqa: E402
import work_migrate  # noqa: E402

NOW = datetime(2026, 11, 6, 12, 0, 0, tzinfo=timezone.utc)
_GUARD = fx.FormalDbGuard()
STATE = {}


def module_setup():
    _GUARD.start()
    fx.install_write_guard(store)
    STATE["ws"] = fx.TempWorkspace(files="none", with_db=False)


def module_teardown():
    try:
        STATE["ws"].close()
        fx.verify_cleanup()
    finally:
        fx.uninstall_write_guard(store)
    _GUARD.check()


def connect(db):
    fx.assert_temp_db(db)
    con = sqlite3.connect(str(db), isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


def full_digest(db):
    """Every row of every table, for 'the database did not change' assertions."""
    with contextlib.closing(connect(db)) as con:
        names = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        return {n: sorted((tuple(r) for r in con.execute(f"SELECT * FROM {n}")), key=repr) for n in names}


def query(db, sql, *args):
    with contextlib.closing(connect(db)) as con:
        return [dict(r) for r in con.execute(sql, args)]


def revisions(db, record_id):
    return [dict(r) for r in store.history(record_id, path=db)]


def save(db, record_id, kind, parent_id=None, **extra):
    return store.save_record({"id": record_id, "kind": kind, "title": extra.pop("title", record_id),
                              "parent_id": parent_id, **extra}, path=db)


class V2Base(unittest.TestCase):
    migrate = True

    def setUp(self):
        name = f"{type(self).__name__}-{self.id().rsplit('.', 1)[-1]}"[:120]
        self.db = STATE["ws"].root / f"{name}.sqlite3"
        self.build()
        if self.migrate:
            work_migrate.migrate(self.db, now=NOW, backup_check=lambda now: True)

    def build(self):
        db = self.db
        save(db, "init", "initiative", title="SAMPLE-PROJECT", data={"description": "d", "materialsLineage": True})
        save(db, "know", "knowledge_collection", title="Library")
        save(db, "topic", "topic", title="Team A")
        save(db, "ws", "workstream", "init", title="Workstream")
        save(db, "t1", "task", "ws", title="Task 1")
        save(db, "t2", "task", "ws", title="Task 2", status="Done")
        save(db, "t3", "task", "t1", title="Sub task", status="In Progress")
        save(db, "camp", "campaign", "topic", title="Campaign")
        save(db, "act", "action", "camp", title="Legacy action", status="Blocked")
        save(db, "mat", "material", title="A material")

    # -- helpers -----------------------------------------------------------
    def rev(self, node_id):
        return store.get_record(node_id, path=self.db)["revision"]

    def update(self, node_id, changes, **extra):
        body = {"id": node_id, "baseRevision": self.rev(node_id), "changes": changes, **extra}
        return nodes.node_update(body, path=self.db)

    def node(self, node_id):
        return nodes.node_view(id=node_id, path=self.db)

    def create_task(self, parent="ws", title="New task", **extra):
        return nodes.node_create({"kind": "task", "parentId": parent, "title": title, **extra},
                                 path=self.db)["node"]

    def assert_rejected(self, call, status=400, code=None, field=None):
        """``call()`` must raise a NodeError and leave the whole database untouched."""
        before = full_digest(self.db)
        with self.assertRaises((nodes.NodeError, work_hub_paths.LocatorError, store.HierarchyError)) as caught:
            call()
        exc = caught.exception
        self.assertEqual(exc.status, status, repr(exc))
        if code:
            self.assertEqual(exc.code, code, repr(exc))
        if field:
            self.assertIn(field, [f["field"] for f in exc.details.get("fields", [])], repr(exc.details))
        self.assertEqual(full_digest(self.db), before, "rejected request changed the database")
        return exc

    def tree_node(self, node_id):
        return next(n for n in nodes.tree_view(path=self.db)["nodes"] if n["id"] == node_id)
