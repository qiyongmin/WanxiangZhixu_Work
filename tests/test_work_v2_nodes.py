"""Node views and basic write actions (task 12). Temporary database copies only."""
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
import work_hub_schema as schema  # noqa: E402
import work_hub_sections as sections  # noqa: E402
import work_hub_store as store  # noqa: E402
import work_migrate  # noqa: E402

_GUARD = fx.FormalDbGuard()
_STATE = {}
NOW = datetime(2026, 11, 6, 12, 0, 0, tzinfo=timezone.utc)
STAMP = "2026-01-01T00:00:00+00:00"


def setUpModule():
    _GUARD.start()
    fx.install_write_guard(store)
    _STATE["ws"] = fx.TempWorkspace(files="none", with_db=False)


def tearDownModule():
    try:
        _STATE["ws"].close()
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


def digest(db):
    with contextlib.closing(connect(db)) as con:
        return {t: [tuple(r) for r in con.execute(f"SELECT * FROM {t} ORDER BY 1,2")]
                for t in ("records", "revisions", "links", "work_node_section")}


def raw(db, sql, *args):
    with contextlib.closing(connect(db)) as con:
        con.execute(sql, args)


def revisions(db, record_id):
    return [dict(r) for r in store.history(record_id, path=db)]


def save(db, record_id, kind, parent_id=None, **extra):
    return store.save_record({"id": record_id, "kind": kind, "title": extra.pop("title", record_id),
                              "parent_id": parent_id, **extra}, path=db)


class NodesBase(unittest.TestCase):
    migrate = True

    def setUp(self):
        self.db = _STATE["ws"].root / f"{self.id().rsplit('.', 1)[-1]}.sqlite3"
        self.build()
        if self.migrate:
            work_migrate.migrate(self.db, now=NOW, backup_check=lambda now: True)

    def build(self):
        db = self.db
        save(db, "init", "initiative", title="SAMPLE-PROJECT",
             data={"description": "desc", "notes": "legacy notes", "customFields": {"k": ["v", 1]}, "materialsLineage": True})
        save(db, "know", "knowledge_collection", title="Library")
        save(db, "topic", "topic", title="Team A")
        save(db, "ws", "workstream", "init", title="Workstream")
        save(db, "t1", "task", "ws", title="Task 1")
        save(db, "t2", "task", "ws", title="Task 2", status="Done")
        save(db, "t3", "task", "t1", title="Sub task", status="In Progress")
        save(db, "camp", "campaign", "topic", title="Campaign")
        save(db, "act", "action", "camp", title="Legacy action", status="Blocked")
        save(db, "mat", "material", title="A material")
        store.link_records("init", "mat", "reference", path=db)
        store.link_records("t1", "t2", "related", path=db)

    def assert_error(self, code, status, call, *args, **kwargs):
        before = digest(self.db)
        with self.assertRaises(Exception) as caught:
            call(*args, path=self.db, **kwargs)
        exc = caught.exception
        self.assertEqual(getattr(exc, "code", None), code, repr(exc))
        self.assertEqual(getattr(exc, "status", None), status, repr(exc))
        self.assertEqual(digest(self.db), before, "rejected action changed the database")
        return exc

    def rev_count(self, record_id):
        return len(revisions(self.db, record_id))


class NotMigrated(NodesBase):
    migrate = False

    def test_every_view_and_action_requires_migration(self):
        calls = [
            lambda: nodes.sections_view(path=self.db), lambda: nodes.tree_view(path=self.db),
            lambda: nodes.node_view(id="init", path=self.db), lambda: nodes.children_view("init", path=self.db),
            lambda: nodes.activity_view("init", path=self.db),
            lambda: nodes.node_create({"kind": "task", "parentId": "ws", "title": "x"}, path=self.db),
            lambda: nodes.node_update({"id": "t1", "baseRevision": 1, "changes": {"title": "x"}}, path=self.db),
            lambda: nodes.node_move({"id": "t1", "baseRevision": 1, "parentId": "init"}, path=self.db),
            lambda: nodes.node_lifecycle({"id": "t1", "baseRevision": 1, "operation": "archive"}, path=self.db),
            lambda: nodes.summary_set({"id": "t1", "baseRevision": 1, "text": "x"}, path=self.db),
        ]
        before = digest_raw(self.db)
        for call in calls:
            with self.assertRaises(schema.MigrationRequired) as caught:
                call()
            self.assertEqual((caught.exception.status, caught.exception.code), (409, "migration_required"))
        self.assertEqual(digest_raw(self.db), before)


def digest_raw(db):
    with contextlib.closing(connect(db)) as con:
        return {t: [tuple(r) for r in con.execute(f"SELECT * FROM {t} ORDER BY 1,2")]
                for t in ("records", "revisions", "links")}


# --------------------------------------------------------------------------
# Views
# --------------------------------------------------------------------------
class SectionsAndTree(NodesBase):
    def test_sections_view_counts(self):
        result = {s["id"]: s for s in nodes.sections_view(path=self.db)}
        self.assertEqual([s["title"] for s in nodes.sections_view(path=self.db)],
                         ["Initiatives", "Team Management", "Knowledge", "Projects"])
        self.assertEqual(result["sec-initiatives"]["nodeCount"], 5)       # init, ws, t1, t2, t3
        self.assertEqual(result["sec-team-management"]["nodeCount"], 3)   # topic, camp, act
        self.assertEqual(result["sec-knowledge"]["nodeCount"], 1)
        self.assertEqual(result["sec-team-management"]["rules"], {"departmentSummaryOnly": True})
        self.assertEqual(set(result["sec-initiatives"]), {"id", "title", "sortOrder", "itemKind", "rules", "nodeCount"})
        # archived nodes still count (they block Section deletion), deleted ones do not
        row = store.get_record("t2", path=self.db)
        store.set_lifecycle("t2", row["revision"], "archive", path=self.db)
        row = store.get_record("t3", path=self.db)
        store.set_lifecycle("t3", row["revision"], "delete", path=self.db)
        self.assertEqual({s["id"]: s["nodeCount"] for s in nodes.sections_view(path=self.db)}["sec-initiatives"], 4)

    def test_tree_contains_visible_tree_nodes_only(self):
        tree = nodes.tree_view(path=self.db)
        by_id = {n["id"]: n for n in tree["nodes"]}
        self.assertEqual(set(by_id), {"init", "know", "topic", "ws", "t1", "t2", "t3", "camp", "act"})
        self.assertNotIn("mat", by_id)
        self.assertIn("generatedAt", tree)
        self.assertEqual(by_id["act"]["displayKind"], "Task")
        self.assertEqual(by_id["act"]["kind"], "action")
        self.assertEqual((by_id["init"]["depth"], by_id["ws"]["depth"], by_id["t3"]["depth"]), (1, 2, 4))
        self.assertEqual({k: by_id[i]["sectionId"] for k, i in (("a", "t3"), ("b", "act"), ("c", "know"))},
                         {"a": "sec-initiatives", "b": "sec-team-management", "c": "sec-knowledge"})
        # open = non-Done Tasks, self + descendants: t1 (Planned) + t3 (In Progress)
        self.assertEqual((by_id["t1"]["open"], by_id["t2"]["open"], by_id["ws"]["open"], by_id["init"]["open"]),
                         (2, 0, 2, 2))
        self.assertEqual((by_id["act"]["open"], by_id["camp"]["open"], by_id["topic"]["open"]), (1, 1, 1))
        sec = {s["id"]: s for s in tree["sections"]}
        self.assertEqual((sec["sec-initiatives"]["open"], sec["sec-team-management"]["open"],
                          sec["sec-knowledge"]["open"]), (2, 1, 0))
        for node in tree["nodes"]:                                  # Phase 2/3 placeholders
            self.assertEqual((node["remind"], node["unconfirmed"]), (False, 0))

    def test_tree_order_and_hidden_subtrees(self):
        row = store.get_record("t1", path=self.db)
        store.set_lifecycle("t1", row["revision"], "archive", path=self.db)
        ids = [n["id"] for n in nodes.tree_view(path=self.db)["nodes"]]
        self.assertNotIn("t1", ids)
        self.assertNotIn("t3", ids, "descendants of an archived node are hidden too")
        # Sections come in sortOrder; parents precede their children
        self.assertLess(ids.index("init"), ids.index("topic"))
        self.assertLess(ids.index("topic"), ids.index("know"))
        self.assertLess(ids.index("ws"), ids.index("t2"))

    def test_unclassified_group_only_when_non_empty(self):
        raw(self.db, "DELETE FROM work_sections WHERE id='sec-knowledge'")
        result = {s["id"]: s for s in nodes.sections_view(path=self.db)}
        self.assertEqual(result[sections.UNCLASSIFIED_ID]["nodeCount"], 1)
        self.assertEqual(nodes.tree_view(path=self.db)["nodes"][-1]["sectionId"], sections.UNCLASSIFIED_ID)


class NodeView(NodesBase):
    def test_dto_fields_and_values(self):
        dto = nodes.node_view(id="t1", path=self.db)
        self.assertEqual(set(dto), {
            "id", "kind", "displayKind", "parentId", "title", "status", "revision", "createdAt", "updatedAt",
            "archivedAt", "deletedAt", "depth", "overDepth", "sectionId", "path", "nodePath", "description",
            "priority", "dueDate", "assignee", "customFields", "resourceLinks", "remindAt", "remindPending", "repeat", "tags", "summary", "stats",
            "childCount", "unconfirmed", "links", "backRefs"})
        self.assertEqual((dto["kind"], dto["displayKind"], dto["parentId"], dto["depth"], dto["overDepth"]),
                         ("task", "Task", "ws", 3, False))
        self.assertEqual(dto["sectionId"], "sec-initiatives")
        self.assertEqual(dto["path"], [{"id": "init", "title": "SAMPLE-PROJECT"}, {"id": "ws", "title": "Workstream"}])
        self.assertEqual(dto["nodePath"], "Initiatives/SAMPLE-PROJECT/Workstream/Task 1")
        self.assertEqual(dto["stats"], {"open": 1, "byStatus": {"Planned": 0, "In Progress": 1, "Waiting": 0, "Blocked": 0}})
        self.assertEqual(dto["childCount"], 1)
        self.assertEqual(dto["summary"], {"text": "", "html": ""})
        self.assertEqual(dto["links"], [{"relation": "related", "otherId": "t2", "otherTitle": "Task 2", "direction": "out"}])
        self.assertEqual((dto["remindAt"], dto["remindPending"], dto["repeat"], dto["tags"], dto["unconfirmed"]),
                         (None, False, None, [], []))

    def test_action_and_task_share_the_same_shape(self):
        action = nodes.node_view(id="act", path=self.db)
        task = nodes.node_view(id="t1", path=self.db)
        self.assertEqual(set(action), set(task))
        self.assertEqual((action["kind"], action["displayKind"]), ("action", "Task"))
        self.assertEqual(store.get_record("act", path=self.db)["kind"], "action")
        self.assertEqual(action["sectionId"], "sec-team-management")

    def test_description_reads_only_data_description(self):
        self.assertEqual(nodes.node_view(id="init", path=self.db)["description"], "desc")
        raw(self.db, "UPDATE records SET data='{\"notes\":\"only notes\"}' WHERE id='ws'")
        self.assertEqual(nodes.node_view(id="ws", path=self.db)["description"], "")

    def test_reference_links_to_material_are_not_listed(self):
        dto = nodes.node_view(id="init", path=self.db)
        self.assertEqual(dto["links"], [])
        self.assertEqual(nodes.node_view(id="t2", path=self.db)["backRefs"],
                         [{"relation": "related", "sourceId": "t1", "sourceTitle": "Task 1"}])

    def test_stats_exclude_archived_and_deleted_descendants(self):
        self.assertEqual(nodes.node_view(id="init", path=self.db)["stats"]["open"], 2)
        row = store.get_record("t3", path=self.db)
        store.set_lifecycle("t3", row["revision"], "archive", path=self.db)
        self.assertEqual(nodes.node_view(id="init", path=self.db)["stats"]["open"], 1)
        self.assertEqual(nodes.node_view(id="t1", path=self.db)["childCount"], 0)

    def test_over_depth_flag(self):
        raw(self.db, "INSERT INTO records VALUES('d5','task','t3','deep5','Planned',1,'{}',?,?,NULL,NULL)", STAMP, STAMP)
        dto = nodes.node_view(id="d5", path=self.db)
        self.assertEqual((dto["depth"], dto["overDepth"]), (5, True))

    def test_not_found_and_deleted(self):
        self.assert_error("node_not_found", 404, nodes.node_view, id="missing")
        row = store.get_record("t3", path=self.db)
        store.set_lifecycle("t3", row["revision"], "delete", path=self.db)
        exc = self.assert_error("node_not_found", 404, nodes.node_view, id="t3")
        self.assertEqual(exc.details["value"], "t3")
        self.assert_error("locator_required", 400, nodes.node_view)

    def test_by_node_path(self):
        self.assertEqual(nodes.node_view(node_path="initiatives/sample-project/WORKSTREAM", path=self.db)["id"], "ws")
        self.assertEqual(nodes.node_view(id="ws", node_path="Initiatives/SAMPLE-PROJECT/Workstream", path=self.db)["id"], "ws")
        self.assert_error("node_not_found", 404, nodes.node_view, node_path="Initiatives/Nope")
        self.assert_error("locator_conflict", 400, nodes.node_view, id="t1", node_path="Initiatives/SAMPLE-PROJECT")

    def test_path_escaping_and_ambiguity(self):
        save(self.db, "slash", "task", "ws", title="A/B \\ C")
        dto = nodes.node_view(id="slash", path=self.db)
        self.assertEqual(dto["nodePath"], "Initiatives/SAMPLE-PROJECT/Workstream/A\\/B \\\\ C")
        self.assertEqual(nodes.node_view(node_path=dto["nodePath"], path=self.db)["id"], "slash")
        save(self.db, "dup1", "task", "ws", title="Same")
        save(self.db, "dup2", "task", "ws", title="same")
        exc = self.assert_error("ambiguous_path", 409, nodes.node_view, node_path="Initiatives/SAMPLE-PROJECT/Workstream/Same")
        self.assertEqual(sorted(c["id"] for c in exc.details["candidates"]), ["dup1", "dup2"])

    def test_invalid_paths(self):
        for text, category in (("", "empty"), ("a//b", "empty"), ("a/b\\x", "invalid"), ("a\\", "invalid"),
                               ("x" * 301, "too_long"), ("a" * 2049, "too_long"), ("a/b/c/d/e/f", "invalid")):
            exc = self.assert_error("invalid_path", 400, nodes.node_view, node_path=text)
            self.assertEqual(exc.category, category, text)
        for text in ("a", "a/b/c/d/e", "a\\/b", "中文/段 落"):
            nodes.parse_node_path(text)
        for segments in (["a/b", "c\\d"], ["x"], ["万象", "a\\\\/"]):
            self.assertEqual(nodes.parse_node_path(nodes.format_node_path(segments)), segments)


class ChildrenAndActivity(NodesBase):
    def test_children_pagination(self):
        for index in range(120):
            save(self.db, f"c{index:03d}", "task", "ws", title=f"child {index}")
        page = nodes.children_view("ws", path=self.db)
        self.assertEqual((len(page["items"]), page["total"]), (50, 122))
        page = nodes.children_view("ws", limit=100, offset=100, path=self.db)
        self.assertEqual((len(page["items"]), page["total"]), (22, 122))
        # Creation timestamps can tie on fast hosts. Validate slice identity
        # against the same query's canonical order rather than assume a tie rank.
        first_page = nodes.children_view("ws", limit=50, path=self.db)
        self.assertEqual(nodes.children_view("ws", limit="3", offset="1", path=self.db)["items"][0]["id"],
                         first_page["items"][1]["id"])
        # New child timestamps may sort ahead of the older fixture task on fast
        # hosts; verify t1's values by identity, not an unstable first-page rank.
        all_items = nodes.children_view("ws", limit=100, path=self.db)["items"] + \
            nodes.children_view("ws", limit=100, offset=100, path=self.db)["items"]
        item = next(x for x in all_items if x["id"] == "t1")
        self.assertEqual((item["childCount"], item["open"], item["displayKind"]), (1, 2, "Task"))
        for bad in ({"limit": 101}, {"limit": 0}, {"offset": -1}, {"limit": "x"}):
            self.assert_error("invalid_" + next(iter(bad)), 400, nodes.children_view, "ws", **bad)
        self.assert_error("node_not_found", 404, nodes.children_view, "missing")
        self.assertEqual(nodes.children_view("t3", path=self.db), {"items": [], "total": 0})

    def test_activity_pages_of_fifty(self):
        record = store.get_record("t2", path=self.db)
        for index in range(124):
            record = store.save_record({"id": "t2", "kind": "task", "title": f"v{index}", "parent_id": "ws",
                                        "status": "Done", "revision": record["revision"], "data": {}},
                                       actor="tester", source="unit", path=self.db)
        first = nodes.activity_view("t2", path=self.db)
        self.assertEqual(len(first["items"]), 50)
        self.assertEqual((first["items"][0]["revision"], first["nextBefore"]), (125, 76))
        self.assertEqual(first["items"][0]["actor"], "tester")
        self.assertEqual(first["items"][0]["source"], "unit")
        self.assertEqual(first["items"][0]["changeLabel"], "修改标题")
        second = nodes.activity_view("t2", before=first["nextBefore"], path=self.db)
        self.assertEqual((second["items"][0]["revision"], len(second["items"]), second["nextBefore"]), (75, 50, 26))
        last = nodes.activity_view("t2", before=second["nextBefore"], path=self.db)
        self.assertEqual((len(last["items"]), last["nextBefore"]), (25, None))
        self.assertEqual(last["items"][-1]["changeLabel"], "创建")
        self.assertEqual(last["items"][-1]["actor"], "manual")
        self.assertEqual(set(first["items"][0]), {"revision", "actor", "source", "occurredAt", "changeLabel", "agentWrite"})

    def test_activity_edge_cases(self):
        raw(self.db, "INSERT INTO records VALUES('norev','task','ws','n','Planned',1,'{}',?,?,NULL,NULL)", STAMP, STAMP)
        self.assertEqual(nodes.activity_view("norev", path=self.db), {"items": [], "nextBefore": None})
        self.assert_error("node_not_found", 404, nodes.activity_view, "missing")
        self.assert_error("invalid_limit", 400, nodes.activity_view, "t1", limit=101)
        self.assert_error("invalid_before", 400, nodes.activity_view, "t1", before=0)

    def test_change_labels(self):
        label = nodes.change_label
        base = {"title": "a", "status": "Planned", "parent_id": None, "archived_at": None, "deleted_at": None, "data": {}}
        self.assertEqual(label(None, base), "创建")
        self.assertEqual(label(base, {**base, "status": "Done"}), "状态 Planned → Done")
        self.assertEqual(label(base, {**base, "archived_at": "x"}), "归档")
        self.assertEqual(label({**base, "deleted_at": "x"}, base), "恢复")
        self.assertEqual(label(base, {**base, "parent_id": "p"}), "移动")
        self.assertEqual(label(base, {**base, "data": {"description": "d", "summaryBlock": {"text": "s", "html": ""}}}),
                         "修改描述、更新摘要")
        self.assertEqual(label(base, {**base, "data": {"x": 1}}), "更新内容")
        self.assertEqual(label(base, {**base, "_change": {"type": "confirm"}}), "确认 Agent 写入")
        self.assertEqual(label(base, base), "保存")


# --------------------------------------------------------------------------
# Actions
# --------------------------------------------------------------------------
class NodeCreate(NodesBase):
    def test_creates_task_with_one_user_revision(self):
        result = nodes.node_create({"kind": "task", "parentId": "ws", "title": "  New task  ",
                                    "description": "why", "actor": "agent:evil"}, path=self.db)
        node = result["node"]
        self.assertEqual((node["kind"], node["title"], node["status"], node["revision"], node["description"]),
                         ("task", "New task", "Planned", 1, "why"))
        self.assertEqual(node["parentId"], "ws")
        history = revisions(self.db, node["id"])
        self.assertEqual([(r["revision"], r["actor"], r["source"]) for r in history],
                         [(1, "user", "shell:node-create")])

    def test_never_creates_action(self):
        self.assert_error("invalid_kind", 400, nodes.node_create, {"kind": "action", "parentId": "camp", "title": "x"})
        for kind in ("material", "banana", None, ["task"]):
            self.assert_error("invalid_kind", 400, nodes.node_create, {"kind": kind, "parentId": "ws", "title": "x"})
        self.assert_error("invalid_parent", 400, nodes.node_create,
                          {"kind": "workstream", "parentId": "ws", "title": "x"})
        self.assertEqual(store.list_records(kind="action", path=self.db)[0]["id"], "act")
        self.assertEqual(len(store.list_records(kind="action", path=self.db)), 1)

    def test_creates_workstream_and_campaign_under_the_correct_l1_and_audits(self):
        for kind, parent, section_id, depth in (
            ("workstream", "init", "sec-initiatives", 2),
            ("workstream", "know", "sec-knowledge", 2),
            ("campaign", "topic", "sec-team-management", 2),
        ):
            dto = nodes.node_create({"kind": kind, "parentId": parent,
                                     "title": "  New %s  " % kind}, path=self.db)["node"]
            self.assertEqual((dto["kind"], dto["parentId"], dto["sectionId"], dto["depth"],
                              dto["title"], dto["revision"], dto["status"]),
                             (kind, parent, section_id, depth, "New %s" % kind, 1, "Planned"))
            self.assertIn(dto["id"], [row["id"] for row in nodes.tree_view(path=self.db)["nodes"]])
            self.assertEqual([(r["revision"], r["actor"], r["source"]) for r in revisions(self.db, dto["id"])],
                             [(1, "user", "shell:node-create")])
            child = nodes.node_create({"kind": "task", "parentId": dto["id"], "title": "Task"},
                                      path=self.db)["node"]
            self.assertEqual((child["parentId"], child["sectionId"], child["depth"]),
                             (dto["id"], section_id, 3))

    def test_structural_children_reject_wrong_parent_and_missing_parent_without_writes(self):
        for kind, parent in (("workstream", "topic"), ("workstream", "ws"),
                             ("workstream", "t1"), ("campaign", "init"),
                             ("campaign", "ws"), ("task", "mat")):
            self.assert_error("invalid_parent", 400, nodes.node_create,
                              {"kind": kind, "parentId": parent, "title": "Invalid"})
        for kind in ("workstream", "campaign", "task"):
            self.assert_error("parent_required", 400, nodes.node_create,
                              {"kind": kind, "title": "Invalid"})
        for kind in ("initiative", "topic", "knowledge_collection"):
            self.assert_error("invalid_parent", 400, nodes.node_create,
                              {"kind": kind, "parentId": "init", "title": "Invalid"})

    def test_item_creation_and_section_defaults(self):
        item = nodes.node_create({"kind": "initiative", "title": "New init"}, path=self.db)["node"]
        self.assertEqual((item["parentId"], item["sectionId"], item["depth"]), (None, "sec-initiatives", 1))
        topic = nodes.node_create({"kind": "topic", "title": "New topic", "sectionId": "sec-team-management"},
                                  path=self.db)["node"]
        self.assertEqual(topic["sectionId"], "sec-team-management")
        with contextlib.closing(connect(self.db)) as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM work_node_section").fetchone()[0], 0)

    def test_custom_section_gets_explicit_assignment(self):
        raw(self.db, "INSERT INTO work_sections VALUES('sec-custom','Custom','custom',5,'initiative','{}',?,?)", STAMP, STAMP)
        item = nodes.node_create({"kind": "initiative", "title": "In custom", "sectionId": "sec-custom"},
                                 path=self.db)["node"]
        self.assertEqual(item["sectionId"], "sec-custom")
        child = nodes.node_create({"kind": "task", "parentId": item["id"], "title": "child"}, path=self.db)["node"]
        self.assertEqual(child["sectionId"], "sec-custom")
        self.assertTrue(child["nodePath"].startswith("Custom/In custom/"))
        self.assertIn("sec-custom", {s["id"] for s in nodes.sections_view(path=self.db)})

    def test_section_rule_uses_the_chosen_section(self):
        raw(self.db, "INSERT INTO work_sections VALUES('sec-dept','Dept','dept',5,'initiative',?,?,?)",
            json.dumps({"departmentSummaryOnly": True}), STAMP, STAMP)
        item = nodes.node_create({"kind": "initiative", "title": "Dept item", "sectionId": "sec-dept"}, path=self.db)["node"]
        row = store.get_record(item["id"], path=self.db)
        with self.assertRaises(sections.SectionRuleViolation):          # rule of 'sec-dept' applies, not the default's
            store.save_record({"id": item["id"], "kind": "initiative", "title": "x", "revision": row["revision"],
                               "data": {"employees": []}}, path=self.db)

    def test_section_errors(self):
        self.assert_error("section_not_found", 404, nodes.node_create, {"kind": "initiative", "title": "x", "sectionId": "nope"})
        self.assert_error("section_kind_mismatch", 400, nodes.node_create,
                          {"kind": "initiative", "title": "x", "sectionId": "sec-knowledge"})
        self.assert_error("section_mismatch", 400, nodes.node_create,
                          {"kind": "task", "parentId": "ws", "title": "x", "sectionId": "sec-knowledge"})
        nodes.node_create({"kind": "task", "parentId": "ws", "title": "ok", "sectionId": "sec-initiatives"}, path=self.db)

    def test_title_and_description_boundaries(self):
        ok = nodes.node_create({"kind": "task", "parentId": "ws", "title": "t" * 200, "description": "d" * 10000},
                               path=self.db)["node"]
        self.assertEqual((len(ok["title"]), len(ok["description"])), (200, 10000))
        for title in ("", "   ", "t" * 201, None, 5):
            exc = self.assert_error("invalid_title", 400, nodes.node_create, {"kind": "task", "parentId": "ws", "title": title})
            self.assertEqual(exc.details["fields"][0]["field"], "title")
        exc = self.assert_error("invalid_title", 400, nodes.node_create,
                                {"kind": "task", "parentId": "ws", "title": "", "description": "d" * 10001})
        self.assertEqual([f["field"] for f in exc.details["fields"]], ["title", "description"])
        self.assert_error("invalid_description", 400, nodes.node_create,
                          {"kind": "task", "parentId": "ws", "title": "x", "description": "d" * 10001})
        self.assertEqual(nodes.node_create({"kind": "task", "parentId": "ws", "title": " " + "t" * 200 + " "},
                                           path=self.db)["node"]["title"], "t" * 200)

    def test_parent_rules(self):
        self.assert_error("parent_required", 400, nodes.node_create, {"kind": "task", "title": "x"})
        self.assert_error("node_not_found", 404, nodes.node_create, {"kind": "task", "parentId": "missing", "title": "x"})
        self.assert_error("invalid_parent", 400, nodes.node_create, {"kind": "initiative", "parentId": "init", "title": "x"})
        self.assert_error("depth_exceeded", 400, nodes.node_create, {"kind": "task", "parentId": "t3", "title": "x"})
        for extra in ({"parentIds": ["ws"]}, {"parents": ["ws"]}, {"parentId": ["ws", "init"]}, {"parentId": 3}):
            body = {"kind": "task", "parentId": "ws", "title": "x", **extra}
            self.assert_error("multiple_parents", 400, nodes.node_create, body)
        row = store.get_record("ws", path=self.db)
        store.set_lifecycle("ws", row["revision"], "archive", path=self.db)   # archived parents are still valid
        nodes.node_create({"kind": "task", "parentId": "ws", "title": "under archived"}, path=self.db)

    def test_body_must_be_object(self):
        self.assert_error("invalid_body", 400, nodes.node_create, ["task"])


class NodeUpdate(NodesBase):
    def update(self, node_id, changes, revision=None, **extra):
        revision = revision if revision is not None else store.get_record(node_id, path=self.db)["revision"]
        return nodes.node_update({"id": node_id, "baseRevision": revision, "changes": changes, **extra}, path=self.db)


    def test_l1_quick_access_revision_and_data_preservation(self):
        """Quick Access is L1-only and saved as a normal manual Revision."""
        from work_shortcuts import validate_resource_links
        folder = {"id": "shortcut-" + "a" * 32, "kind": "folder", "title": "SAMPLE-PROJECT source",
                  "target": "/home/devspace-workspaces/KB_Work/projects/sample-project"}
        links = [folder, {"id": "shortcut-" + "b" * 32, "kind": "teams", "title": "SAMPLE-PROJECT Teams",
                          "target": "https://teams.microsoft.com/l/team/example"}]
        self.assertEqual(validate_resource_links(links), links)
        prior = store.get_record("init", path=self.db)
        result = self.update("init", {"resourceLinks": links})["node"]
        self.assertEqual(result["resourceLinks"], links)
        self.assertEqual(result["revision"], prior["revision"] + 1)
        self.assertEqual(store.get_record("init", path=self.db)["data"]["customFields"], {"k": ["v", 1]})
        self.assertEqual(revisions(self.db, "init")[0]["source"], "shell:node-update")
        # Edit, reorder and remove are safe list replacements under Revision control.
        updated = self.update("init", {"resourceLinks": [dict(folder, title="Code directory")]})["node"]
        self.assertEqual(updated["resourceLinks"][0]["title"], "Code directory")
        self.assertEqual(updated["revision"], result["revision"] + 1)
        self.assertEqual(self.update("init", {"resourceLinks": []})["node"]["resourceLinks"], [])

    def test_shortcuts_rejected_outside_l1_or_with_unsafe_targets(self):
        from work_shortcuts import valid_folder, validate_resource_links
        folder = {"id": "shortcut-" + "a" * 32, "kind": "folder",
                  "title": "Local folder", "target": "C:\\\\Work\\\\SAMPLE-PROJECT"}
        self.assertTrue(valid_folder(folder["target"]))
        self.assertFalse(valid_folder("\\\\server\\\\share"))
        self.assertFalse(valid_folder("/home/a/../private"))
        for item in ("ws", "t1"):
            self.assert_error("invalid_resourceLinks", 400, nodes.node_update, {
                "id": item, "baseRevision": store.get_record(item, path=self.db)["revision"],
                "changes": {"resourceLinks": [folder]}})
        base = store.get_record("init", path=self.db)["revision"]
        valid = dict(folder)
        invalid = (
            dict(valid, target="\\\\\\\\server\\\\share"),
            dict(valid, target="file:///etc/passwd"),
            dict(valid, target="/home/work/../private"),
            dict(valid, id="shortcut-not-uuid"),
            dict(valid, title=""),
            dict(valid, kind="unknown"),
            dict(valid, target="C:\\\\Work\\\\..\\\\Secrets"),
            {"id":valid["id"],"kind":"link","title":"Unsafe","target":"javascript:alert(1)"},
            {"id":valid["id"],"kind":"teams","title":"token",
             "target":"https://" + "synthetic-user" + ":" + "fake-pass" + "@example.invalid/"},
        )
        for bad in invalid:
            self.assert_error("invalid_resourceLinks", 400, nodes.node_update, {
                "id":"init","baseRevision":base, "changes":{"resourceLinks":[bad]}})
        self.assert_error("invalid_resourceLinks", 400, nodes.node_update, {
            "id":"init", "baseRevision":base, "changes":{"resourceLinks":[valid,valid]}})
        self.assert_error("invalid_resourceLinks", 400, nodes.node_update, {
            "id":"init", "baseRevision":base, "changes":{"resourceLinks":42}})

    def test_one_revision_per_save_with_actor_user(self):
        before = store.get_record("t1", path=self.db)
        node = self.update("t1", {"title": " Renamed ", "status": "Done", "description": "new"},
                           actor="agent:x")["node"]
        self.assertEqual((node["title"], node["status"], node["description"], node["revision"]),
                         ("Renamed", "Done", "new", before["revision"] + 1))
        history = revisions(self.db, "t1")
        self.assertEqual(len(history), before["revision"] + 1)
        self.assertEqual((history[0]["actor"], history[0]["source"]), ("user", "shell:node-update"))
        self.assertEqual({r["actor"] for r in history[1:]}, {"manual"}, "historic manual revisions are untouched")

    def test_field_boundaries(self):
        self.update("t1", {"title": "t" * 200})
        self.update("t1", {"description": "d" * 10000})
        self.update("t1", {"description": ""})
        for status in sorted(store.STATES):
            self.update("t1", {"status": status})
        for changes, field in (({"title": "t" * 201}, "title"), ({"title": "  "}, "title"), ({"title": 3}, "title"),
                               ({"description": "d" * 10001}, "description"), ({"description": None}, "description"),
                               ({"status": "Finished"}, "status"), ({"status": None}, "status")):
            exc = self.assert_error("invalid_" + field, 400, nodes.node_update,
                                    {"id": "t1", "baseRevision": store.get_record("t1", path=self.db)["revision"],
                                     "changes": changes})
            self.assertIn(field, [f["field"] for f in exc.details["fields"]])

    def test_changes_shape_and_unknown_fields(self):
        rev = store.get_record("t1", path=self.db)["revision"]
        for changes in (None, {}, [], "x"):
            self.assert_error("invalid_changes", 400, nodes.node_update, {"id": "t1", "baseRevision": rev, "changes": changes})
        self.assert_error("invalid_owner", 400, nodes.node_update,   # priority is supported since Phase 2
                          {"id": "t1", "baseRevision": rev, "changes": {"owner": "x"}})
        self.assert_error("invalid_id", 400, nodes.node_update, {"baseRevision": 1, "changes": {"title": "x"}})

    def test_revision_conflict_keeps_data_and_reports_current(self):
        current = store.get_record("t1", path=self.db)
        exc = self.assert_error("revision_conflict", 409, nodes.node_update,
                                {"id": "t1", "baseRevision": current["revision"] + 1, "changes": {"title": "x"}})
        self.assertEqual(exc.current_revision, current["revision"])
        self.assertEqual(exc.current["title"], "Task 1")
        self.assertEqual(exc.payload()["currentRevision"], current["revision"])
        self.assertEqual(exc.payload()["current"]["status"], "Planned")
        self.assertEqual(exc.payload()["code"], "revision_conflict")
        self.update("t1", {"title": "fresh"})
        self.assert_error("revision_conflict", 409, nodes.node_update,
                          {"id": "t1", "baseRevision": current["revision"], "changes": {"title": "stale"}})

    def test_base_revision_required_and_typed(self):
        self.assert_error("base_revision_required", 400, nodes.node_update, {"id": "t1", "changes": {"title": "x"}})
        for bad in ("2", 0, -1, 1.5, True):
            self.assert_error("invalid_baseRevision", 400, nodes.node_update,
                              {"id": "t1", "baseRevision": bad, "changes": {"title": "x"}})

    def test_missing_and_deleted_nodes(self):
        self.assert_error("node_not_found", 404, nodes.node_update, {"id": "missing", "baseRevision": 1, "changes": {"title": "x"}})
        row = store.get_record("t3", path=self.db)
        store.set_lifecycle("t3", row["revision"], "delete", path=self.db)
        self.assert_error("node_not_found", 404, nodes.node_update,
                          {"id": "t3", "baseRevision": row["revision"] + 1, "changes": {"title": "x"}})

    def test_custom_fields_and_other_data_are_preserved(self):
        before = store.get_record("init", path=self.db)["data"]
        self.update("init", {"title": "Renamed", "description": "changed"})
        after = store.get_record("init", path=self.db)["data"]
        self.assertEqual(after["customFields"], before["customFields"])
        self.assertEqual(after["notes"], before["notes"])
        self.assertEqual({k: v for k, v in after.items() if k != "description"},
                         {k: v for k, v in before.items() if k != "description"})
        self.update("init", {"status": "Waiting"})                        # a save without description keeps it
        self.assertEqual(store.get_record("init", path=self.db)["data"]["description"], "changed")

    def test_over_deep_records_remain_editable(self):
        raw(self.db, "INSERT INTO records VALUES('d5','task','t3','deep5','Planned',1,'{}',?,?,NULL,NULL)", STAMP, STAMP)
        node = self.update("d5", {"title": "still editable", "status": "Done", "description": "x"})["node"]
        self.assertEqual((node["parentId"], node["id"], node["overDepth"]), ("t3", "d5", True))

    def test_long_legacy_title_is_not_revalidated_when_untouched(self):
        raw(self.db, "UPDATE records SET title=? WHERE id='t2'", "x" * 250)
        self.assertEqual(self.update("t2", {"status": "Planned"})["node"]["title"], "x" * 250)

    def test_legacy_history_stays_readable(self):
        self.update("t1", {"title": "via shell"})
        record = store.get_record("t1", path=self.db)
        self.assertEqual(record["title"], "via shell")
        saved = store.save_record({"id": "t1", "kind": "task", "title": "via legacy", "parent_id": "ws",
                                   "revision": record["revision"], "data": record["data"]}, path=self.db)
        self.assertEqual(saved["revision"], record["revision"] + 1)


class NodeMove(NodesBase):
    def move(self, node_id, parent_id, **extra):
        revision = store.get_record(node_id, path=self.db)["revision"]
        return nodes.node_move({"id": node_id, "baseRevision": revision, "parentId": parent_id, **extra}, path=self.db)

    def test_move_success_one_revision(self):
        before = self.rev_count("t3")
        node = self.move("t3", "ws")["node"]
        self.assertEqual((node["parentId"], node["depth"]), ("ws", 3))
        self.assertEqual(self.rev_count("t3"), before + 1)
        latest = revisions(self.db, "t3")[0]
        self.assertEqual((latest["actor"], latest["source"]), ("user", "shell:node-move"))

    def test_hierarchy_errors(self):
        rev = lambda i: store.get_record(i, path=self.db)["revision"]  # noqa: E731
        self.assert_error("hierarchy_cycle", 400, nodes.node_move, {"id": "t1", "baseRevision": rev("t1"), "parentId": "t3"})
        exc = self.assert_error("hierarchy_cycle", 400, nodes.node_move,
                                {"id": "t1", "baseRevision": rev("t1"), "parentId": "t1"})
        self.assertIn("不允许形成循环层级", str(exc))
        save(self.db, "o1", "workstream", "init")
        save(self.db, "o2", "task", "o1")
        exc = self.assert_error("depth_exceeded", 400, nodes.node_move,
                                {"id": "t1", "baseRevision": rev("t1"), "parentId": "o2"})
        self.assertIn("Depth 上限为 4", str(exc))
        for extra in ({"parentIds": ["a"]}, {"parentId": ["ws", "init"]}):
            self.assert_error("multiple_parents", 400, nodes.node_move,
                              {"id": "t3", "baseRevision": rev("t3"), "parentId": "ws", **extra})
        self.assert_error("invalid_parentId", 400, nodes.node_move, {"id": "t3", "baseRevision": rev("t3")})
        self.assert_error("node_not_found", 404, nodes.node_move, {"id": "t3", "baseRevision": rev("t3"), "parentId": "missing"})
        self.assert_error("revision_conflict", 409, nodes.node_move, {"id": "t3", "baseRevision": 99, "parentId": "ws"})

    def test_move_to_top_level_only_for_items(self):
        revision = store.get_record("t3", path=self.db)["revision"]
        self.assert_error("parent_required", 400, nodes.node_move,
                          {"id": "t3", "baseRevision": revision, "parentId": None})
        self.assert_error("parent_required", 400, nodes.node_move,
                          {"id": "act", "baseRevision": store.get_record("act", path=self.db)["revision"],
                           "parentId": None})
        item = store.get_record("init", path=self.db)
        self.assertIsNone(nodes.node_move({"id": "init", "baseRevision": item["revision"], "parentId": None},
                                          path=self.db)["node"]["parentId"])

    def test_moved_subtree_must_satisfy_destination_rule(self):
        record = store.get_record("t1", path=self.db)
        store.save_record({"id": "t1", "kind": "task", "title": "Task 1", "parent_id": "ws", "revision": record["revision"],
                           "data": {"nested": [{"employees": ["x"]}]}}, path=self.db)
        before = digest(self.db)
        with self.assertRaises(sections.SectionRuleViolation):     # t1 itself
            self.move("t1", "camp")
        self.assertEqual(digest(self.db), before)
        raw(self.db, "UPDATE records SET data='{\"employees\":[1]}' WHERE id='t3'")
        raw(self.db, "UPDATE records SET data='{}' WHERE id='t1'")
        before = digest(self.db)
        with self.assertRaises(sections.SectionRuleViolation) as caught:    # only a descendant violates
            self.move("t1", "camp")
        self.assertEqual(caught.exception.details["fields"][0]["field"], "employees")
        self.assertTrue(caught.exception.details["fields"][0]["path"].startswith("t3."))
        self.assertEqual(digest(self.db), before)


class NodeLifecycle(NodesBase):
    def op(self, node_id, operation, revision=None):
        revision = revision if revision is not None else store.get_record(node_id, path=self.db)["revision"]
        return nodes.node_lifecycle({"id": node_id, "baseRevision": revision, "operation": operation}, path=self.db)

    def test_each_operation_adds_exactly_one_revision(self):
        for operation in ("archive", "unarchive", "delete", "restore"):
            before = store.get_record("t3", path=self.db)
            counted = self.rev_count("t3")
            node = self.op("t3", operation)["node"]
            self.assertEqual(node["revision"], before["revision"] + 1, operation)
            self.assertEqual(self.rev_count("t3"), counted + 1, operation)
            latest = revisions(self.db, "t3")[0]
            self.assertEqual((latest["actor"], latest["source"]), ("user", "shell:node-lifecycle"))
        stored = store.get_record("t3", path=self.db)
        self.assertEqual((stored["archived_at"], stored["deleted_at"]), (None, None))

    def test_delete_rejected_while_active_children(self):
        exc = self.assert_error("has_children", 400, nodes.node_lifecycle,
                                {"id": "t1", "baseRevision": store.get_record("t1", path=self.db)["revision"],
                                 "operation": "delete"})
        self.assertEqual(exc.details["count"], 1)
        self.assertIn("先归档或移动", str(exc))

    def test_delete_allowed_when_children_are_archived_or_deleted(self):
        self.op("t3", "archive")
        self.assertTrue(self.op("t1", "delete")["node"]["deletedAt"])
        self.assertIsNotNone(store.get_record("t1", path=self.db)["deleted_at"])

    def test_restore_requires_live_parent(self):
        self.op("t3", "delete")
        self.op("t1", "delete")
        revision = store.get_record("t3", path=self.db)["revision"]
        exc = self.assert_error("parent_deleted", 400, nodes.node_lifecycle,
                                {"id": "t3", "baseRevision": revision, "operation": "restore"})
        self.assertEqual(exc.details["parentId"], "t1")
        self.op("t1", "restore")
        self.assertIsNone(self.op("t3", "restore")["node"]["deletedAt"])

    def test_conflict_and_invalid_input(self):
        self.assert_error("revision_conflict", 409, nodes.node_lifecycle, {"id": "t3", "baseRevision": 9, "operation": "archive"})
        self.assert_error("invalid_operation", 400, nodes.node_lifecycle, {"id": "t3", "baseRevision": 1, "operation": "explode"})
        self.assert_error("base_revision_required", 400, nodes.node_lifecycle, {"id": "t3", "operation": "archive"})
        self.assert_error("node_not_found", 404, nodes.node_lifecycle, {"id": "missing", "baseRevision": 1, "operation": "archive"})
        revision = store.get_record("t3", path=self.db)["revision"]
        self.assert_error("invalid_state", 400, nodes.node_lifecycle, {"id": "t3", "baseRevision": revision, "operation": "unarchive"})
        self.assert_error("invalid_state", 400, nodes.node_lifecycle, {"id": "t3", "baseRevision": revision, "operation": "restore"})

    def test_legacy_lifecycle_behaviour_is_unchanged(self):
        self.op("t3", "archive")
        row = store.get_record("t1", path=self.db)
        with self.assertRaisesRegex(ValueError, "Archive or move child records first"):
            store.set_lifecycle("t1", row["revision"], "delete", path=self.db)    # legacy: archived child still blocks


class SummarySet(NodesBase):
    def summary(self, node_id, text, revision=None):
        revision = revision if revision is not None else store.get_record(node_id, path=self.db)["revision"]
        return nodes.summary_set({"id": node_id, "baseRevision": revision, "text": text}, path=self.db)

    def test_set_render_clear(self):
        before = self.rev_count("t1")
        node = self.summary("t1", "**结论** <script>alert(1)</script>")["node"]
        self.assertEqual(node["summary"]["text"], "**结论** <script>alert(1)</script>")
        self.assertEqual(node["summary"]["html"], "<p><strong>结论</strong> &lt;script&gt;alert(1)&lt;/script&gt;</p>")
        self.assertEqual(self.rev_count("t1"), before + 1)
        latest = revisions(self.db, "t1")[0]
        self.assertEqual((latest["actor"], latest["source"]), ("user", "shell:summary-set"))
        stored = store.get_record("t1", path=self.db)["data"]["summaryBlock"]
        self.assertEqual(stored, node["summary"])
        self.assertEqual(nodes.node_view(id="t1", path=self.db)["summary"], node["summary"])
        cleared = self.summary("t1", "")["node"]
        self.assertEqual(cleared["summary"], {"text": "", "html": ""})

    def test_client_cannot_supply_html(self):
        node = nodes.summary_set({"id": "t1", "baseRevision": store.get_record("t1", path=self.db)["revision"],
                                  "text": "plain", "html": "<script>x</script>"}, path=self.db)["node"]
        self.assertEqual(node["summary"]["html"], "<p>plain</p>")

    def test_length_boundary_writes_no_revision_when_rejected(self):
        self.summary("t1", "x" * 5000)
        exc = self.assert_error("summary_too_long", 400, nodes.summary_set,
                                {"id": "t1", "baseRevision": store.get_record("t1", path=self.db)["revision"],
                                 "text": "x" * 5001})
        self.assertEqual(exc.details["maxLength"], 5000)
        self.assert_error("invalid_summary", 400, nodes.summary_set,
                          {"id": "t1", "baseRevision": store.get_record("t1", path=self.db)["revision"], "text": None})

    def test_conflict_and_other_data_preserved(self):
        self.assert_error("revision_conflict", 409, nodes.summary_set, {"id": "t1", "baseRevision": 99, "text": "x"})
        self.summary("init", "hello")
        data = store.get_record("init", path=self.db)["data"]
        self.assertEqual((data["description"], data["customFields"]), ("desc", {"k": ["v", 1]}))
        self.assert_error("node_not_found", 404, nodes.summary_set, {"id": "missing", "baseRevision": 1, "text": "x"})


if __name__ == "__main__":
    unittest.main()
