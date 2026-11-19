"""Materials, reports and file references (task 44). Temporary databases; File Hub is faked."""
from __future__ import annotations
import contextlib
import json
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parent))
import work_v2_common as common  # noqa: E402
from work_v2_common import connect, full_digest, nodes, query, revisions, store  # noqa: E402
import work_hub_api as api  # noqa: E402

F1 = "file_" + "1" * 32
F2 = "file_" + "2" * 32
GONE = "file_" + "9" * 32


def setUpModule():
    common.module_setup()


def tearDownModule():
    common.module_teardown()


class FakeHub:
    """Just enough of ``file_hub`` for the materials code paths (never the real catalog)."""
    class Missing(ValueError):
        pass

    def __init__(self):
        self.files = {F1: {"name": "spec.pdf", "path": "Projects/WorkHub/spec.pdf", "size": 10},
                      F2: {"name": "plan.md", "path": "General/plan.md", "size": 20}}
        self.links = []                    # (file_id, target_type, target_id, relation)
        self.aliases = {}

    def lookup(self, file_id):
        return True, self.files.get(file_id)

    def linked_context(self, kind, node_id):
        return [{"id": f, "path": self.files[f]["path"], "size": self.files[f]["size"], "deleted": 0,
                 "link_relation": rel} for f, t, n, rel in self.links
                if t == kind and n == node_id and f in self.files]

    def _db(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.execute("CREATE TABLE links(file_id,target_type,target_id,relation)")
        con.executemany("INSERT INTO links VALUES(?,?,?,?)", self.links)
        return con

    def work_media_alias(self, media_id):
        return self.aliases.get(media_id)


class MaterialsBase(common.V2Base):
    def setUp(self):
        self.hub = FakeHub()
        self.patches = [mock.patch.object(nodes, "_file_hub", lambda: self.hub),
                        mock.patch.object(nodes, "_file_lookup", self.hub.lookup)]
        for patch in self.patches:
            patch.start()
        self.addCleanup(lambda: [p.stop() for p in reversed(self.patches)])
        super().setUp()

    def add(self, node_id, **spec):
        return nodes.material_add({"id": node_id, "baseRevision": self.rev(node_id), **spec}, path=self.db)

    def remove(self, node_id, material_id):
        return nodes.material_remove({"id": node_id, "baseRevision": self.rev(node_id),
                                      "materialId": material_id}, path=self.db)

    def items(self, node_id):
        return nodes.materials_view(node_id, path=self.db)["items"]


class AddAndRemove(MaterialsBase):
    def test_sample_project_lineage_separates_workstream_and_initiative_materials(self):
        direct = self.add('t1', type='link', title='Task evidence', url='https://example.com/task')['material']['id']
        shared = self.add('ws', type='file', fileId=F1)['material']['id']
        initiative = self.add('init', type='file', fileId=F2)['material']['id']
        data = nodes.materials_view('t1', path=self.db)
        self.assertEqual([i['id'] for i in data['items']], [direct])
        self.assertEqual([i['id'] for i in data['inherited']], [shared, initiative])
        self.assertEqual([i['sourceLevel'] for i in data['inherited']], [2, 1])
        self.assertEqual(data['items'][0]['purpose'], 'reference')
        self.assertEqual(data['items'][0]['usedBy'], [{'nodeId': 't1', 'title': 'Task 1', 'purpose': 'reference'}])
        self.assertEqual(data['inherited'][0]['usedBy'], [{'nodeId': 'ws', 'title': 'Workstream', 'purpose': 'reference'}])
        self.assertEqual((data['inherited'][0]['scope'], data['inherited'][0]['sourceNodeId']), ('workstream', 'ws'))
        self.assertEqual([x['id'] for x in data['lineage']], ['init', 'ws', 't1'])
        self.assertEqual([i['id'] for i in nodes.materials_view('t2', path=self.db)['inherited']], [shared, initiative])
        # Calling a read-only view never copies, deletes or relinks the canonical file.
        self.assertEqual(self.hub.files, FakeHub().files)

    def test_three_types(self):
        link = self.add("t1", type="link", title="Docs", url="https://example.com/a")
        file_ = self.add("t1", type="file", fileId=F1)
        report = self.add("t1", type="report", title="Weekly", fileId=F2, format="md")
        items = {i["id"]: i for i in self.items("t1")}
        self.assertEqual(len(items), 3)
        self.assertEqual((items[link["material"]["id"]]["materialType"], items[link["material"]["id"]]["url"]),
                         ("link", "https://example.com/a"))
        self.assertEqual((items[file_["material"]["id"]]["title"], items[file_["material"]["id"]]["name"]),
                         ("spec.pdf", "spec.pdf"))
        rep = items[report["material"]["id"]]
        self.assertEqual((rep["materialType"], rep["format"], rep["fileId"], rep["origin"]), ("report", "md", F2, "user"))
        self.assertEqual(report["node"]["revision"], 4)

    def test_exactly_one_node_revision_per_add(self):
        before = len(revisions(self.db, "t1"))
        result = self.add("t1", type="link", title="Docs", url="http://example.com")
        history = revisions(self.db, "t1")
        self.assertEqual(len(history), before + 1)
        after = json.loads(history[0]["after_json"])
        self.assertEqual(after["_change"], {"type": "material-add", "materialId": result["material"]["id"]})
        self.assertEqual((history[0]["actor"], history[0]["source"]), ("user", "shell:material-add"))
        self.assertEqual(len(revisions(self.db, result["material"]["id"])), 1)

    def test_bad_links_and_specs_leave_database_untouched(self):
        for url in ("ftp://example.com/a", "javascript:alert(1)", "file:///etc/passwd", "//example.com", "example.com",
                    "https://a b"):
            self.assert_rejected(lambda url=url: self.add("t1", type="link", title="x", url=url))
        exc = self.assert_rejected(lambda: self.add("t1", type="link", title="x", url="ftp://a/b"),
                                   code="link_scheme_unsupported")
        self.assertEqual(exc.status, 400)
        for spec in ({"type": "folder"}, {"type": "link", "title": "x"}, {"type": "file"},
                     {"type": "file", "fileId": "nope"}, {"type": "report", "title": "r", "fileId": F1},
                     {"type": "report", "title": "r", "fileId": F1, "format": "pdf"},
                     {"type": "link", "url": "https://a.b"}):
            self.assert_rejected(lambda spec=spec: self.add("t1", **spec))
        self.hub.files.pop(F2)
        self.assert_rejected(lambda: self.add("t1", type="file", fileId=F2), status=404, code="file_not_found")
        self.assertEqual(self.items("t1"), [])
        self.assert_rejected(lambda: nodes.material_add({"id": "t1", "type": "link", "title": "x",
                                                         "url": "https://a.b"}, path=self.db),
                             code="base_revision_required")
        self.assert_rejected(lambda: nodes.material_add({"id": "t1", "baseRevision": 99, "type": "link",
                                                         "title": "x", "url": "https://a.b"}, path=self.db),
                             status=409, code="revision_conflict")

    def test_same_file_on_several_nodes_without_copying(self):
        a = self.add("t1", type="file", fileId=F1)["material"]["id"]
        b = self.add("t2", type="file", fileId=F1)["material"]["id"]
        self.assertNotEqual(a, b)
        self.assertEqual(self.hub.files, FakeHub().files)
        refs = nodes.file_refs_view(F1, path=self.db)
        self.assertEqual(sorted(r["nodeId"] for r in refs[F1]), ["t1", "t2"])

    def test_remove_keeps_file_and_other_references(self):
        a = self.add("t1", type="file", fileId=F1)["material"]["id"]
        before = len(revisions(self.db, "t1"))
        node = self.remove("t1", a)["node"]
        self.assertEqual(self.items("t1"), [])
        self.assertEqual(len(revisions(self.db, "t1")), before + 1)
        self.assertEqual(node["revision"], before + 1)
        self.assertEqual(self.hub.files, FakeHub().files)                      # the File Hub file stays
        self.assertIsNotNone(store.get_record(a, path=self.db)["deleted_at"])   # unreferenced -> soft deleted
        # a material still referenced by another node is kept
        shared = self.add("t1", type="link", title="Shared", url="https://a.b")["material"]["id"]
        with contextlib.closing(connect(self.db)) as con:
            con.execute("INSERT INTO links VALUES('t2',?,'reference')", (shared,))
        self.remove("t1", shared)
        self.assertIsNone(store.get_record(shared, path=self.db)["deleted_at"])
        self.assertEqual([i["id"] for i in self.items("t2")], [shared])
        self.assert_rejected(lambda: self.remove("t1", shared), status=404, code="material_not_found")

    def test_stale_reference_is_flagged_not_dropped(self):
        material = self.add("t1", type="file", fileId=F1)["material"]["id"]
        del self.hub.files[F1]
        item = self.items("t1")[0]
        self.assertEqual((item["id"], item["missing"], item["fileId"]), (material, True, F1))

    def test_cap_of_200_and_legacy_inference(self):
        stamp = "2026-01-01T00:00:00"
        with contextlib.closing(connect(self.db)) as con:
            for index in range(205):
                con.execute("INSERT INTO records VALUES(?, 'material', NULL, ?, 'Planned', 1, ?, ?, ?, NULL, NULL)",
                            ("m%03d" % index, "M%03d" % index, json.dumps({"url": "https://a.b/%d" % index}),
                             "2026-01-01T00:%02d:00" % (index // 60), stamp))
                con.execute("INSERT INTO links VALUES('t1', ?, 'reference')", ("m%03d" % index,))
        items = self.items("t1")
        self.assertEqual(len(items), 200)
        self.assertTrue(all(i["materialType"] == "link" for i in items))

    def test_legacy_media_id_resolves_through_alias(self):
        media = "whm-" + "a" * 32
        self.hub.aliases[media] = {"file_id": F2}
        with contextlib.closing(connect(self.db)) as con:
            con.execute("INSERT INTO records VALUES('lm','material',NULL,'Old','Planned',1,?,?,?,NULL,NULL)",
                        (json.dumps({"mediaId": media, "fileName": "a.pdf"}), "2026-01-01T00:00:00",
                         "2026-01-01T00:00:00"))
            con.execute("INSERT INTO links VALUES('t1','lm','reference')")
        item = self.items("t1")[0]
        self.assertEqual((item["materialType"], item["fileId"], item["name"]), ("file", F2, "plan.md"))

    def test_direct_file_hub_references_exclude_note_images(self):
        self.hub.links += [(F1, "task", "t1", "related"), (F2, "task", "t1", "note-image")]
        refs = nodes.materials_view("t1", path=self.db)["fileHubRefs"]
        self.assertEqual([(r["fileId"], r["relation"]) for r in refs], [(F1, "related")])
        self.assertEqual(sorted(r["nodeId"] for r in nodes.file_refs_view([F1, F2], path=self.db)[F1]), ["t1"])
        self.assertEqual(nodes.file_refs_view([F2], path=self.db)[F2], [])


class FileRefsAndRouter(MaterialsBase):
    def test_file_refs_validation(self):
        for ids in (None, "", "nope", ",".join([F1] * 0), [F1] * 0):
            with self.assertRaises(nodes.NodeError):
                nodes.file_refs_view(ids, path=self.db)
        with self.assertRaises(nodes.NodeError):
            nodes.file_refs_view(",".join("file_%032x" % i for i in range(51)), path=self.db)
        self.assertEqual(nodes.file_refs_view(",".join([F1, F1]), path=self.db), {F1: []})

    def test_router(self):
        status, payload = api.handle("POST", "/api/work-hub", {}, {
            "action": "material-add", "id": "t1", "baseRevision": 1, "type": "link", "title": "Docs",
            "url": "https://example.com"}, {"path": self.db})
        self.assertEqual(status, 200, payload)
        material = payload["data"]["material"]["id"]
        status, payload = api.handle("GET", "/api/work-hub", {"view": ["materials"], "id": ["t1"]}, None,
                                     {"path": self.db})
        self.assertEqual([i["id"] for i in payload["data"]["items"]], [material])
        status, payload = api.handle("GET", "/api/work-hub", {"view": ["file-refs"], "ids": [F1]}, None,
                                     {"path": self.db})
        self.assertEqual((status, payload["data"]), (200, {F1: []}))
        status, payload = api.handle("POST", "/api/work-hub", {}, {
            "action": "material-remove", "id": "t1", "baseRevision": 2, "materialId": material}, {"path": self.db})
        self.assertEqual(status, 200, payload)


if __name__ == "__main__":
    unittest.main()
