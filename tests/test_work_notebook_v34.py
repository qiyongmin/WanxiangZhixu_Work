"""Notes V3.4 additive timeline, Section safety and migration regression.

All test DBs are isolated by V2Base; real company data is never modified.
"""
from __future__ import annotations
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import work_v2_common as common
import work_notebook as nb
import work_notebook_v34 as v34
import work_hub_api as api
from work_v2_common import nodes, query

def setUpModule():
    common.module_setup()

def tearDownModule():
    common.module_teardown()

class NotebookV34(common.V2Base):
    def init(self):
        nb.migrate(path=self.db)
        return v34.migrate(path=self.db)

    def journal(self, owner="ws"):
        return next(s for s in v34.sections_view({"id":owner},path=self.db)["sections"]
                    if s["role"]=="journal")

    def page(self, owner="ws", section=None, title="Test", day="2026-11-01"):
        return nb.page_action({"action":"notebook-page-create","id":owner,
            "sectionId": section or self.journal(owner)["id"],
            "title":title,"timelineDate":day},path=self.db)["page"]

    def event(self, owner="ws", pages=None, date="2026-11-01", kind="journal"):
        return nb.event_action({"action":"notebook-event-create","id":owner,
            "title":"Event","eventDate":date,"kind":kind,"pageIds":pages or []},path=self.db)["event"]

    def test_migration_journal_first_all_levels_idempotent_and_work_source_preserved(self):
        before = self.node("ws")
        self.assertTrue(self.init()["changed"])
        journal = self.journal()
        self.assertEqual(journal["title"], "Journal / Timeline")
        self.assertEqual(journal["role"], "journal")
        self.assertEqual(self.journal("init")["role"], "journal")
        self.assertEqual(self.journal("t1")["role"], "journal")
        self.assertFalse(v34.migrate(path=self.db)["changed"])
        self.assertEqual(self.node("ws"), before)
        self.assertEqual(v34.sections_view({"id":"ws"},path=self.db)["sections"][0]["id"],journal["id"])

    def test_date_create_ordinary_page_excluded_and_bad_calendar_rejected(self):
        self.init()
        pg = self.page(day="2026-05-03")
        self.assertEqual(pg["timelineDate"], "2026-05-03")
        self.assertEqual(v34.timeline_view({"id":"init"},path=self.db)["total"],1)
        section=nb.section_action({"action":"notebook-section-create","id":"ws","title":"Report"},path=self.db)["section"]["id"]
        ordinary=nb.page_action({"action":"notebook-page-create","id":"ws","sectionId":section,"title":"Report"},path=self.db)["page"]
        self.assertIsNone(ordinary["timelineDate"])
        self.assertEqual(v34.timeline_view({"id":"init"},path=self.db)["total"],1)
        with self.assertRaises(nodes.NodeError):
            v34.timeline_date_set({"pageId":pg["id"],"baseRevision":1,
               "timelineDate":"2026-02-30"},path=self.db)

    def test_quick_capture_paired_dedup_and_atomic_date_CAS(self):
        self.init()
        captured=nb.event_action({"action":"notebook-quick-capture","id":"ws",
            "title":"Quick","eventDate":"2026-11-02"},path=self.db)
        pg, event = captured["page"], captured["event"]
        self.assertEqual(pg["timelineDate"],"2026-11-02")
        listing=v34.timeline_view({"id":"init"},path=self.db)
        self.assertEqual(listing["total"],1)
        self.assertEqual(listing["items"][0]["type"],"paired")
        self.assertEqual(listing["items"][0]["pageId"],pg["id"])
        result=v34.timeline_date_set({"pageId":pg["id"],"baseRevision":pg["revision"],
            "timelineDate":"2026-10-09","linkedEventId":event["id"],
            "eventBaseRevision":event["revision"]},path=self.db)
        self.assertEqual(result["page"]["revision"],2)
        self.assertEqual(result["event"]["revision"],2)
        self.assertEqual(result["event"]["event_date"],"2026-10-09")
        self.assertEqual(result["page"]["timelineDate"],"2026-10-09")
        with self.assertRaises(nodes.NodeError) as error:
            v34.timeline_date_set({"pageId":pg["id"],"baseRevision":2,
              "timelineDate":"2026-11-01","linkedEventId":event["id"],
              "eventBaseRevision":1},path=self.db)
        self.assertEqual(error.exception.status,409)
        self.assertEqual(nb.page_view({"id":"ws","page":pg["id"]},path=self.db)["timelineDate"],"2026-10-09")
        self.assertEqual(nb.event_view({"id":"ws","event":event["id"]},path=self.db)["event_date"],"2026-10-09")

    def test_event_editor_date_sync_and_page_CAS(self):
        self.init()
        captured=nb.event_action({"action":"notebook-quick-capture","id":"ws","title":"Quick",
                                  "eventDate":"2026-11-02"},path=self.db)
        pg,ev=captured["page"],captured["event"]
        with self.assertRaises(nodes.NodeError) as error:
            nb.event_action({"action":"notebook-event-save","eventId":ev["id"],
              "baseRevision":1,"eventDate":"2026-11-09"},path=self.db)
        self.assertEqual(error.exception.status,409)
        updated=nb.event_action({"action":"notebook-event-save","eventId":ev["id"],
             "baseRevision":1,"pageBaseRevision":1,"eventDate":"2026-11-09"},path=self.db)
        self.assertEqual(updated["event"]["event_date"],"2026-11-09")
        self.assertEqual(nb.page_view({"id":"ws","page":pg["id"]},path=self.db)["timelineDate"],"2026-11-09")

    def test_multilink_independent_dates_and_no_guess_pair(self):
        self.init()
        p1=self.page(title="First",day="2026-11-01")
        p2=self.page(title="Second",day="2026-11-02")
        ev=self.event(pages=[p1["id"],p2["id"]],date="2026-11-09",kind="milestone")
        items=v34.timeline_view({"id":"init"},path=self.db)["items"]
        self.assertEqual(len(items),3)
        self.assertEqual({i["type"] for i in items},{"page","event"})
        self.assertEqual(len({i["key"] for i in items}),3)
        v34.timeline_date_set({"pageId":p1["id"],"baseRevision":1,
                               "timelineDate":"2026-10-15"},path=self.db)
        self.assertEqual(nb.event_view({"id":"ws","event":ev["id"]},path=self.db)["event_date"],"2026-11-09")

    def test_section_archive_restore_keeps_independent_archived_pages(self):
        self.init()
        sec=nb.section_action({"action":"notebook-section-create","id":"ws","title":"Reports"},path=self.db)["section"]
        a=self.page(section=sec["id"],title="A")
        b=self.page(section=sec["id"],title="B")
        nb.page_action({"action":"notebook-page-archive","pageId":b["id"],
             "baseRevision":b["revision"]},path=self.db)
        hidden=v34.archive_section({"action":"notebook-section-archive","id":"ws",
             "sectionId":sec["id"],"expectedUpdatedAt":sec["updated_at"]},path=self.db)
        self.assertTrue(hidden["archived"])
        self.assertEqual(v34.pages_view({"id":"ws"},path=self.db)["total"],0)
        self.assertEqual(len(v34.sections_view({"id":"ws","archived":"1"},path=self.db)["sections"]),1)
        restored=v34.archive_section({"action":"notebook-section-restore","id":"ws",
             "sectionId":sec["id"],"expectedUpdatedAt":hidden["updatedAt"]},path=self.db)
        self.assertFalse(restored["archived"])
        self.assertEqual(v34.pages_view({"id":"ws","section":sec["id"]},path=self.db)["total"],1)
        self.assertEqual(v34.pages_view({"id":"ws","section":sec["id"],"archived":"1"},path=self.db)["total"],1)
        self.assertEqual(nb.page_view({"id":"ws","page":a["id"]},path=self.db)["id"],a["id"])

    def test_journal_protected_by_all_old_section_actions(self):
        self.init()
        journal=self.journal()
        for action in ("notebook-section-rename","notebook-section-delete"):
            with self.assertRaises(nodes.NodeError) as e:
                nb.section_action({"action":action,"id":"ws",
                    "sectionId":journal["id"],"title":"Changed"},path=self.db)
            self.assertEqual(e.exception.code,"notebook_journal_protected")
        with self.assertRaises(nodes.NodeError):
            nb.section_action({"action":"notebook-section-reorder","id":"ws",
               "ids":[journal["id"]],"expectedIds":[journal["id"]]},path=self.db)
        with self.assertRaises(nodes.NodeError):
            v34.archive_section({"action":"notebook-section-archive","id":"ws",
              "sectionId":journal["id"],"expectedUpdatedAt":journal["updated_at"]},path=self.db)

    def test_api_unified_timeline_and_same_root(self):
        self.init()
        self.page()
        status,data=api.handle("GET","/api/work-hub",
            {"view":"notebook-timeline","id":"ws"},None,{"path":self.db})
        self.assertEqual(status,200,data)
        self.assertEqual(data["data"]["total"],1)
        status,invalid=api.handle("GET","/api/work-hub",
            {"view":"notebook-timeline","id":"ws","source":"know"},None,{"path":self.db})
        self.assertEqual(status,400,invalid)
        self.assertEqual(invalid["code"],"notebook_cross_root")

    def test_archived_section_deep_link_is_readonly_and_restorable(self):
        self.init()
        sec=nb.section_action({"action":"notebook-section-create","id":"ws","title":"Older"},path=self.db)["section"]
        pg=self.page(section=sec["id"],title="Archived note")
        v34.archive_section({"action":"notebook-section-archive","id":"ws",
            "sectionId":sec["id"],"expectedUpdatedAt":sec["updated_at"]},path=self.db)
        code,result=api.handle("GET","/api/work-hub",
            {"view":"notebook-page","id":"ws","page":pg["id"]},None,{"path":self.db})
        self.assertEqual(code,200,result)
        self.assertTrue(result["data"]["sectionArchived"])
        with self.assertRaises(nodes.NodeError) as blocked:
            nb.page_action({"action":"notebook-page-save","pageId":pg["id"],
                "baseRevision":pg["revision"],"title":"Never overwrite","html":""},path=self.db)
        self.assertEqual(blocked.exception.code,"notebook_section_archived")

    def test_old_archived_event_url_can_restore_without_recreating_id(self):
        self.init()
        ev=self.event()
        archived=nb.event_action({"action":"notebook-event-archive",
             "eventId":ev["id"],"baseRevision":ev["revision"]},path=self.db)["event"]
        code,data=api.handle("GET","/api/work-hub",
            {"view":"notebook-event","id":"ws","event":ev["id"]},None,{"path":self.db})
        self.assertEqual(code,200,data)
        self.assertTrue(data["data"]["archivedAt"])
        restored=v34.restore_event({"eventId":ev["id"],"baseRevision":archived["revision"]},
                                    path=self.db)["event"]
        self.assertEqual(restored["id"],ev["id"])
        self.assertEqual(restored["revision"],archived["revision"]+1)
        self.assertEqual(v34.timeline_view({"id":"init"},path=self.db)["total"],1)

if __name__=="__main__":
    unittest.main()
