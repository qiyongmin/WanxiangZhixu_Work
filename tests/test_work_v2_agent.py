"""Agent write core: five additive writes, confirm / undo, atomicity (task 45). Temporary databases only."""
from __future__ import annotations
import hashlib
import json
import random
import sys
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pbt  # noqa: E402
import work_v2_common as common  # noqa: E402
from work_v2_common import full_digest, nodes, query, revisions, store  # noqa: E402
from test_work_v2_materials import F1, FakeHub  # noqa: E402
import work_hub_agent as agent  # noqa: E402

ACTOR = "agent:kiro"


def setUpModule():
    common.module_setup()


def tearDownModule():
    common.module_teardown()


class AgentHub(FakeHub):
    """FakeHub plus the upload / lifecycle calls used by report uploads."""
    class Conflict(ValueError):
        pass

    def __init__(self):
        super().__init__()
        self.uploads, self.trashed, self.purged = [], [], []

    def folder_create(self, folder):
        pass

    def upload(self, folder, name, raw):
        file_id = "file_%032x" % (len(self.uploads) + 1)
        self.uploads.append((folder, name, raw))
        self.files[file_id] = {"name": name, "path": folder + "/" + name, "size": len(raw)}
        return {"id": file_id, "name": name}

    def details(self, file_id):
        return {"revision": 1, **self.files[file_id]}

    def lifecycle(self, file_id, revision, operation, confirm=False):
        (self.trashed if operation == "trash" else self.purged).append(file_id)
        self.files.pop(file_id, None)


class AgentBase(common.V2Base):
    def setUp(self):
        self.hub = AgentHub()
        patches = [mock.patch.object(nodes, "_file_hub", lambda: self.hub),
                   mock.patch.object(nodes, "_file_lookup", self.hub.lookup)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        super().setUp()

    # -- request helpers (revision defaults to the node's current one) ---------
    def body(self, node="t1", **extra):
        body = {"actor": ACTOR, "node": node, **extra}
        if node and "baseRevision" not in extra:
            body["baseRevision"] = self.rev(node)
        return body

    def note(self, node="t1", **extra):
        return agent.add_note(self.body(node, title=extra.pop("title", "Findings"),
                                        markdown=extra.pop("markdown", "# Hi\n正文"), **extra), path=self.db)

    def summary(self, node="t1", text="摘要", **extra):
        return agent.update_summary(self.body(node, markdown=text, **extra), path=self.db)

    def material(self, node="t1", **extra):
        return agent.add_material(self.body(node, **{"type": "link", "title": "Docs",
                                                      "url": "https://example.com", **extra}), path=self.db)

    def report(self, node="t1", **extra):
        return agent.upload_report(self.body(node, **{"title": "周报 W45", "format": "md", "content": "# R",
                                                      **extra}), path=self.db)

    def task(self, parent="ws", **extra):
        return agent.add_task({"actor": ACTOR, "node": parent, "title": "Follow up", **extra}, path=self.db)

    def confirm(self, write_id):
        return agent.agent_confirm({"writeId": write_id}, path=self.db)

    def undo(self, write_id):
        return agent.agent_undo({"writeId": write_id}, path=self.db)

    def write(self, write_id):
        return query(self.db, "SELECT * FROM work_agent_writes WHERE write_id=?", write_id)[0]

    def notes(self, node="t1"):
        return nodes.notes_view(node, path=self.db)["items"]


class FiveWrites(AgentBase):
    def check_audit(self, node_id, result, op, source, revision=None):
        row = self.write(result["writeId"])
        self.assertEqual((row["op"], row["actor"], row["source"], row["state"], row["record_id"]),
                         (op, ACTOR, source, "unconfirmed", node_id))
        self.assertEqual(row["node_revision"], result["revision"])
        top = revisions(self.db, node_id)[0]
        self.assertEqual((top["revision"], top["actor"], top["source"]), (result["revision"], ACTOR, source))
        self.assertEqual(len(row["content_hash"]), 64)

    def test_add_note(self):
        count = len(revisions(self.db, "t1"))
        result = self.note()
        self.assertEqual(result["revision"], 2)
        self.assertEqual(len(revisions(self.db, "t1")), count + 1)
        self.check_audit("t1", result, "add_note", "agent-api:add_note")
        note = self.notes()[0]
        self.assertEqual((note["id"], note["title"]), (result["noteId"], "Findings"))
        self.assertIn("<h2>Hi</h2>", note["html"])
        self.assertIsNone(self.write(result["writeId"])["before_json"])
        self.assertEqual(self.node("t1")["unconfirmed"][0]["writeId"], result["writeId"])
        self.assertEqual(self.tree_node("t1")["unconfirmed"], 1)
        self.assertEqual(self.tree_node("ws")["unconfirmed"], 1)           # aggregated upwards

    def test_add_note_html_and_client_header(self):
        result = agent.add_note(self.body(title="H", html="<p>ok</p>"), path=self.db, client="kbw/1")
        self.check_audit("t1", result, "add_note", "agent-api:add_note@kbw/1")
        self.assert_rejected(lambda: agent.add_note(self.body(title="H", html="<script>1</script>"), path=self.db),
                             code="note_html_invalid", field="html")
        self.assert_rejected(lambda: agent.add_note(self.body(title="H", html="<p>x</p>", markdown="x"), path=self.db))
        self.assert_rejected(lambda: agent.add_note(self.body(title="H"), path=self.db))
        self.assert_rejected(lambda: agent.add_note(self.body(title="H", markdown="x" * (1024 * 1024 + 1)),
                                                    path=self.db), code="markdown_too_large")

    def test_note_limit(self):
        for _ in range(50):
            self.note()
        self.assert_rejected(lambda: self.note(), code="too_many_notes")

    def test_add_material_and_report(self):
        result = self.material()
        self.check_audit("t1", result, "add_material", "agent-api:add_material")
        item = nodes.materials_view("t1", path=self.db)["items"][0]
        self.assertEqual((item["id"], item["materialType"], item["unconfirmed"]),
                         (result["materialId"], "link", result["writeId"]))
        file_result = self.material(**{"type": "file", "fileId": F1, "title": "Spec"})
        self.assertEqual(file_result["revision"], 3)
        report = self.report()
        self.check_audit("t1", report, "upload_report", "agent-api:upload_report")
        folder, name, raw = self.hub.uploads[0]
        self.assertEqual((folder, raw), ("Projects/WorkHub/Reports", b"# R"))
        self.assertRegex(name, r"^agent-report-[0-9a-f]{8}-w45\.md$")
        material = store.get_record(report["materialId"], path=self.db)
        self.assertEqual((material["data"]["materialType"], material["data"]["format"], material["data"]["origin"],
                          material["data"]["fileId"]), ("report", "md", "agent", report["fileId"]))
        self.assertEqual(len(revisions(self.db, report["materialId"])), 1)

    def test_update_summary(self):
        result = self.summary(text="**重点**")
        self.check_audit("t1", result, "update_summary", "agent-api:update_summary")
        self.assertEqual(self.node("t1")["summary"]["text"], "**重点**")
        self.assertEqual(json.loads(self.write(result["writeId"])["before_json"]), {"summaryBlock": None})
        second = self.summary(text="第二版")
        self.assertEqual(json.loads(self.write(second["writeId"])["before_json"])["summaryBlock"]["text"], "**重点**")
        self.assert_rejected(lambda: self.summary(text="x" * 5001), code="summary_too_long")

    def test_add_task(self):
        before = len(revisions(self.db, "ws"))
        result = self.task(description="d", priority="High", tags=["a", "b"])
        task_id = result["nodeId"]
        self.assertEqual(result["revision"], 1)
        self.assertEqual(len(revisions(self.db, "ws")), before)                      # parent untouched
        self.check_audit(task_id, result, "add_task", "agent-api:add_task")
        node = self.node(task_id)
        self.assertEqual((node["status"], node["priority"], node["tags"], node["parentId"], node["kind"]),
                         ("Planned", "High", ["a", "b"], "ws", "task"))
        self.assertEqual(self.write(result["writeId"])["ref"], task_id)
        # base revision is optional but validated when present
        self.task(baseRevision=self.rev("ws"))
        self.assert_rejected(lambda: self.task(baseRevision=99), status=409, code="revision_conflict")
        self.assert_rejected(lambda: self.task(parent="missing"), status=404, code="node_not_found")
        self.assertEqual(self.node(self.task(parent="act")["nodeId"])["parentId"], "act")  # legacy action parent

    def test_task_depth_limit(self):
        parent = "t3"                                    # init > ws > t1 > t3 is depth 4
        self.assert_rejected(lambda: self.task(parent=parent), code="depth_exceeded")


class Validation(AgentBase):
    def test_actor_rules(self):
        base = {"node": "t1", "baseRevision": 1, "title": "x", "markdown": "y"}
        for actor in (None, "", "kiro", "agent:", "agent: x", "agent:a b", "agent:\x01", "agent:" + "x" * 76, 5,
                      "user", "Agent:x"):
            body = dict(base)
            if actor is not None:
                body["actor"] = actor
            self.assert_rejected(lambda body=body: agent.add_note(body, path=self.db), code="actor_invalid")
        agent.add_note({**base, "actor": "agent:" + "x" * 75}, path=self.db)
        self.assertEqual(revisions(self.db, "t1")[0]["actor"], "agent:" + "x" * 75)

    def test_base_revision_rules(self):
        self.assert_rejected(lambda: agent.add_note({"actor": ACTOR, "node": "t1", "title": "x", "markdown": "y"},
                                                    path=self.db), code="base_revision_required")
        before = full_digest(self.db)
        exc = self.assert_rejected(lambda: agent.add_note(self.body(baseRevision=7, title="x", markdown="y"),
                                                          path=self.db), status=409, code="revision_conflict")
        self.assertEqual(exc.current_revision, 1)
        self.assertEqual(exc.payload()["currentRevision"], 1)
        self.assertEqual(full_digest(self.db), before)
        for bad in (0, -1, "1", True, 1.5):
            self.assert_rejected(lambda bad=bad: agent.update_summary(
                {"actor": ACTOR, "node": "t1", "baseRevision": bad, "markdown": "x"}, path=self.db))

    def test_human_owned_fields_are_refused_with_guidance(self):
        for field, value in (("status", "Done"), ("dueDate", "2026-12-01"), ("owner", "me"), ("assignee", "x"),
                             ("parent_id", "ws"), ("parentId", "ws")):
            for call in (lambda: agent.add_note(self.body(title="x", markdown="y", **{field: value}), path=self.db),
                         lambda: agent.update_summary(self.body(markdown="y", **{field: value}), path=self.db),
                         lambda: agent.add_material(self.body(type="link", title="x", url="https://a.b",
                                                              **{field: value}), path=self.db),
                         lambda: agent.add_task({"actor": ACTOR, "node": "ws", "title": "t", field: value},
                                                path=self.db)):
                exc = self.assert_rejected(call, code="human_owned_field")
                self.assertIn("请改用 Change_Proposal", str(exc))
                self.assertIn(field, [f["field"] for f in exc.details["fields"]])
        # the title of an EXISTING node is human-owned (a summary has no title of its own)
        exc = self.assert_rejected(lambda: agent.update_summary(self.body(markdown="y", title="Renamed"),
                                                                path=self.db), code="human_owned_field")
        self.assertEqual(store.get_record("t1", path=self.db)["title"], "Task 1")

    def test_unknown_fields_are_listed(self):
        exc = self.assert_rejected(lambda: agent.add_note(self.body(title="x", markdown="y", bogus=1, other=2),
                                                          path=self.db))
        self.assertEqual({f["field"] for f in exc.details["fields"]}, {"bogus", "other"})

    def test_team_management_individual_data_is_refused(self):
        self.assert_rejected(lambda: agent.add_task({"actor": ACTOR, "node": "topic", "title": "t",
                                                     "employees": [{"name": "A"}]}, path=self.db))
        before = full_digest(self.db)
        with self.assertRaises(nodes.NodeError) as caught:
            agent.submit_proposal(self.body("topic", changes={"data": {"individualReviews": [1]}}, rationale="r"),
                                  path=self.db)
        self.assertEqual(caught.exception.code, "section_rule_violation")
        self.assertIn("Section_Rule", str(caught.exception))
        self.assertEqual(full_digest(self.db), before)

    def test_locators(self):
        result = agent.add_note({"actor": ACTOR, "nodePath": "Initiatives/SAMPLE-PROJECT/Workstream/Task 1",
                                 "baseRevision": 1, "title": "x", "markdown": "y"}, path=self.db)
        self.assertEqual(result["nodeId"], "t1")
        self.assert_rejected(lambda: agent.add_note({"actor": ACTOR, "node": "nope", "baseRevision": 1, "title": "x",
                                                     "markdown": "y"}, path=self.db), status=404)
        self.assertEqual(agent.add_note({"actor": ACTOR, "nodeId": "t2", "baseRevision": 1, "title": "x",
                                         "markdown": "y"}, path=self.db)["nodeId"], "t2")
        self.assert_rejected(lambda: agent.add_note({"actor": ACTOR, "nodeId": "t1", "node": "t2", "baseRevision": 1,
                                                     "title": "x", "markdown": "y"}, path=self.db),
                             code="locator_conflict")


class ConfirmUndo(AgentBase):
    def test_confirm_changes_state_only(self):
        result = self.note()
        before_notes = self.notes()
        outcome = self.confirm(result["writeId"])
        self.assertEqual(outcome["write"]["state"], "confirmed")
        top = revisions(self.db, "t1")[0]
        self.assertEqual((top["revision"], top["actor"], top["source"]), (3, "user", "confirm:" + result["writeId"]))
        self.assertEqual(json.loads(top["after_json"])["_change"]["type"], "confirm")
        self.assertEqual(self.notes(), before_notes)
        self.assertEqual(outcome["node"]["unconfirmed"], [])
        row = self.write(result["writeId"])
        self.assertEqual((row["resolved_by"], row["resolved_revision"]), ("user", 3))
        for call in (self.confirm, self.undo):
            self.assert_rejected(lambda call=call: call(result["writeId"]), status=409, code="not_unconfirmed")
        self.assert_rejected(lambda: self.confirm("aw-missing"), status=404, code="write_not_found")

    def test_undo_each_operation(self):
        note = self.note()
        summary = self.summary(text="新摘要")
        material = self.material()
        report = self.report()
        task = self.task()
        before = len(revisions(self.db, "t1"))
        for write in (note, summary, material, report):
            self.undo(write["writeId"])
        self.assertEqual(self.notes(), [])
        self.assertEqual(self.node("t1")["summary"], {"text": "", "html": ""})
        self.assertEqual(nodes.materials_view("t1", path=self.db)["items"], [])
        self.assertEqual(len(revisions(self.db, "t1")), before + 4)            # one new Revision each
        self.undo(task["writeId"])
        self.assertIsNotNone(store.get_record(task["nodeId"], path=self.db)["deleted_at"])
        for write in (note, summary, material, report, task):
            self.assertEqual(self.write(write["writeId"])["state"], "undone")
        undo_rev = revisions(self.db, "t1")[0]
        self.assertEqual((undo_rev["actor"], json.loads(undo_rev["after_json"])["_change"]["type"]), ("user", "undo"))
        # the original Agent Revisions are still there
        agent_revs = [r for r in revisions(self.db, "t1") if r["actor"] == ACTOR]
        self.assertEqual(len(agent_revs), 4)

    def test_undo_restores_the_previous_summary(self):
        self.summary(text="旧")
        second = self.summary(text="新")
        self.undo(second["writeId"])
        self.assertEqual(self.node("t1")["summary"]["text"], "旧")

    def test_undo_refused_after_later_modification(self):
        result = self.note()
        nodes.notes_save({"id": "t1", "baseRevision": self.rev("t1"),
                          "entries": [{**self.notes()[0], "html": "<p>edited by user</p>"}]}, path=self.db)
        before = full_digest(self.db)
        self.assert_rejected(lambda: self.undo(result["writeId"]), status=409, code="modified_since")
        self.assertEqual(full_digest(self.db), before)
        self.assertEqual(self.write(result["writeId"])["state"], "unconfirmed")
        self.confirm(result["writeId"])                                          # confirming is still possible
        summary = self.summary(text="a")
        nodes.summary_set({"id": "t1", "baseRevision": self.rev("t1"), "text": "b"}, path=self.db)
        self.assert_rejected(lambda: self.undo(summary["writeId"]), status=409, code="modified_since")
        material = self.material()
        nodes.material_remove({"id": "t1", "baseRevision": self.rev("t1"), "materialId": material["materialId"]},
                              path=self.db)
        self.assert_rejected(lambda: self.undo(material["writeId"]), status=409, code="modified_since")
        task = self.task()
        nodes.node_update({"id": task["nodeId"], "baseRevision": 1, "changes": {"description": "d"}}, path=self.db)
        self.assert_rejected(lambda: self.undo(task["writeId"]), status=409, code="modified_since")

    def test_unrelated_edits_do_not_block_undo(self):
        result = self.note()
        self.update("t1", {"description": "unrelated"})
        self.undo(result["writeId"])
        self.assertEqual(self.notes(), [])

    def test_task_with_child_cannot_be_undone(self):
        task = self.task()
        nodes.node_create({"kind": "task", "parentId": task["nodeId"], "title": "child"}, path=self.db)
        self.assert_rejected(lambda: self.undo(task["writeId"]), status=409, code="modified_since")


class Atomicity(AgentBase):
    def test_failure_after_content_leaves_nothing(self):
        for call in (self.note, self.summary, self.material, self.report, self.task):
            before = full_digest(self.db)
            with mock.patch.object(agent, "_register", side_effect=RuntimeError("boom")):
                with self.assertRaises(Exception):
                    call()
            self.assertEqual(full_digest(self.db), before, call.__name__)

    def test_failure_in_revision_writing_leaves_nothing(self):
        before = full_digest(self.db)
        with mock.patch.object(store, "_insert_revision", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                self.note()
        self.assertEqual(full_digest(self.db), before)

    def test_report_database_failure_trashes_the_file_but_never_purges(self):
        before = full_digest(self.db)
        with mock.patch.object(agent, "_register", side_effect=RuntimeError("boom")):
            with self.assertRaises(nodes.NodeError) as caught:
                self.report()
        self.assertEqual((caught.exception.status, caught.exception.code), (500, "internal_error"))
        self.assertEqual(full_digest(self.db), before)
        self.assertEqual(len(self.hub.trashed), 1)
        self.assertEqual(self.hub.purged, [])

    def test_report_precheck_conflict_uploads_nothing(self):
        self.assert_rejected(lambda: self.report(baseRevision=42), status=409, code="revision_conflict")
        self.assertEqual(self.hub.uploads, [])
        without_hub = mock.patch.object(nodes, "_file_hub", lambda: None)
        with without_hub:
            self.assert_rejected(lambda: self.report(), status=503, code="file_hub_unavailable")
        self.assert_rejected(lambda: self.report(format="pdf"), field="format")
        self.assert_rejected(lambda: self.report(content=""), field="content")

    def test_agent_revisions_are_never_deleted(self):
        result = self.note()
        agent_rows = [r for r in revisions(self.db, "t1") if r["actor"] == ACTOR]
        self.undo(result["writeId"])
        self.assertEqual([r for r in revisions(self.db, "t1") if r["actor"] == ACTOR], agent_rows)


# --------------------------------------------------------------------------
# Properties 17, 23 and 14 (Agent extension)
# --------------------------------------------------------------------------
def _agent_ops(rng: random.Random, size):
    names = ("note", "summary", "material", "confirm", "undo", "user_note", "user_summary", "stale")
    return [(rng.choice(names), rng.random()) for _ in range(rng.randint(3, 12))]


class AgentProperties(AgentBase):
    def test_property_17_agent_write_state_machine(self):
        counter = [0]

        def prop(ops):
            counter[0] += 1
            node = self.create_task(title="p17-%d" % counter[0])["id"]
            writes = []                        # dicts: id, op, snapshot (what undo must find unchanged)
            agent_revisions = 0
            for name, pick in ops:
                start = revisions(self.db, node)
                if name in ("note", "summary", "material"):
                    result = {"note": self.note, "summary": self.summary, "material": self.material}[name](node)
                    agent_revisions += 1
                    row = self.write(result["writeId"])
                    assert row["state"] == "unconfirmed" and row["actor"] == ACTOR
                    assert len(revisions(self.db, node)) == len(start) + 1
                    writes.append({"id": result["writeId"], "op": name, "ref": row["ref"],
                                   "snapshot": self.snapshot(node, name, row["ref"])})
                elif name in ("confirm", "undo") and writes:
                    target = writes[int(pick * len(writes)) % len(writes)]
                    state = self.write(target["id"])["state"]
                    digest = full_digest(self.db)
                    if name == "confirm":
                        if state != "unconfirmed":
                            assert self.fails(409, "not_unconfirmed", lambda: self.confirm(target["id"]))
                            assert full_digest(self.db) == digest
                        else:
                            self.confirm(target["id"])
                            assert self.write(target["id"])["state"] == "confirmed"
                            assert len(revisions(self.db, node)) == len(start) + 1
                    else:
                        if state != "unconfirmed":
                            assert self.fails(409, "not_unconfirmed", lambda: self.undo(target["id"]))
                            assert full_digest(self.db) == digest
                        elif self.snapshot(node, target["op"], target["ref"]) != target["snapshot"]:
                            assert self.fails(409, "modified_since", lambda: self.undo(target["id"]))
                            assert full_digest(self.db) == digest
                        else:
                            self.undo(target["id"])
                            assert self.write(target["id"])["state"] == "undone"
                            assert len(revisions(self.db, node)) == len(start) + 1
                            assert self.snapshot(node, target["op"], target["ref"]) is None or target["op"] == "summary"
                elif name == "user_note":
                    entries = self.notes(node)
                    if entries:
                        nodes.notes_save({"id": node, "baseRevision": self.rev(node), "entries": [
                            {**entries[0], "html": "<p>user %s</p>" % pick}, *entries[1:]]}, path=self.db)
                elif name == "user_summary":
                    nodes.summary_set({"id": node, "baseRevision": self.rev(node), "text": "user %s" % pick},
                                      path=self.db)
                elif name == "stale":
                    digest = full_digest(self.db)
                    assert self.fails(409, "revision_conflict", lambda: agent.add_note(
                        self.body(node, baseRevision=self.rev(node) + 5, title="t", markdown="m"), path=self.db))
                    assert full_digest(self.db) == digest
            kept = [r for r in revisions(self.db, node) if r["actor"] == ACTOR]
            assert len(kept) == agent_revisions               # no Agent Revision is ever deleted or rewritten
            return True
        pbt.forall(_agent_ops, prop, runs=100)

    def snapshot(self, node, op, ref):
        """What an undo is guarded by: the note / summary text / material as the Agent left it."""
        if op == "note":
            entry = next((e for e in self.notes(node) if e["id"] == ref), None)
            return None if entry is None else hashlib.sha256((entry["title"] + entry["html"]).encode()).hexdigest()
        if op == "summary":
            return hashlib.sha256(self.node(node)["summary"]["text"].encode()).hexdigest()
        row = query(self.db, "SELECT title,data,deleted_at FROM records WHERE id=?", ref)[0]
        return None if row["deleted_at"] else (row["title"], row["data"])

    def fails(self, status, code, call):
        try:
            call()
        except nodes.NodeError as exc:
            return (exc.status, exc.code) == (status, code)
        return False

    def test_property_23_actor_and_source_consistency(self):
        def gen(rng, size):
            return [rng.choice(("legacy", "shell", "agent")) for _ in range(rng.randint(2, 8))]

        counter = [0]

        def prop(channels):
            counter[0] += 1
            node = self.create_task(title="p23-%d" % counter[0])["id"]
            for channel in channels:
                before = revisions(self.db, node)
                if channel == "legacy":
                    record = store.get_record(node, path=self.db)
                    store.save_record({**record, "title": record["title"] + "."}, actor="manual", source="local-ui",
                                      path=self.db)
                    expected = ("manual", "local-ui")
                elif channel == "shell":
                    # a hostile actor field in the body is ignored on the user channel
                    nodes.summary_set({"id": node, "baseRevision": self.rev(node), "text": "s%d" % len(before),
                                       "actor": "agent:evil"}, path=self.db)
                    expected = ("user", "shell:summary-set")
                else:
                    agent.add_note(self.body(node, title="n", markdown="m", actor="agent:p23"), path=self.db,
                                   client="kbw/1")
                    expected = ("agent:p23", "agent-api:add_note@kbw/1")
                after = revisions(self.db, node)
                assert len(after) == len(before) + 1 and after[1:] == before      # history never rewritten
                assert (after[0]["actor"], after[0]["source"]) == expected, (channel, after[0])
            return True
        pbt.forall(gen, prop, runs=100)

    def test_property_14_agent_stale_base_revision_changes_nothing(self):
        endpoints = (
            lambda node, base: agent.add_note({"actor": ACTOR, "node": node, "baseRevision": base, "title": "t",
                                               "markdown": "m"}, path=self.db),
            lambda node, base: agent.update_summary({"actor": ACTOR, "node": node, "baseRevision": base,
                                                     "markdown": "m"}, path=self.db),
            lambda node, base: agent.add_material({"actor": ACTOR, "node": node, "baseRevision": base,
                                                   "type": "link", "title": "t", "url": "https://a.b"}, path=self.db),
            lambda node, base: agent.upload_report({"actor": ACTOR, "node": node, "baseRevision": base,
                                                    "title": "t", "format": "md", "content": "c"}, path=self.db),
            lambda node, base: agent.submit_proposal({"actor": ACTOR, "node": node, "baseRevision": base,
                                                      "changes": {"status": "Blocked"}, "rationale": "r"},
                                                     path=self.db))
        gen = pbt.tuples(pbt.ints(0, len(endpoints) - 1), pbt.ints(1, 40), pbt.ints(0, 3))

        def prop(case):
            index, offset, edits = case
            for number in range(edits):
                self.update("t2", {"description": "e%d" % number})
            current = self.rev("t2")
            stale = current + offset if offset % 2 else max(1, current - (offset % current))
            if stale == current:
                stale = current + 1
            before = full_digest(self.db)
            try:
                endpoints[index]("t2", stale)
            except nodes.NodeError as exc:
                return exc.status == 409 and exc.current_revision == current and full_digest(self.db) == before
            return False
        pbt.forall(gen, prop, runs=100)


if __name__ == "__main__":
    unittest.main()
