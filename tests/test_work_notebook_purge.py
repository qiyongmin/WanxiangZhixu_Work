"""Notes permanent deletion isolation and transactional integrity regressions.
Only temporary fixture SQLite databases are touched.
"""
from __future__ import annotations
import unittest
import sys
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parent))
import work_v2_common as common
import work_notebook as nb
import work_notebook_v34 as v34
import work_notebook_v35 as v35
import work_notebook_purge as purge
import work_hub_api as api
from work_v2_common import nodes, query, store


def setUpModule(): common.module_setup()
def tearDownModule(): common.module_teardown()


class PermanentNotesDelete(common.V2Base):
    def setUp(self):
        super().setUp()
        nb.migrate(path=self.db)
        v34.migrate(path=self.db)
        v35.migrate(path=self.db)

    def section(self, title="Section"):
        return nb.section_action({"action":"notebook-section-create","id":"ws",
                "title":title},path=self.db)["section"]

    def page(self, section, title="A Page", content="<p>Keep this record</p>"):
        return nb.page_action({"action":"notebook-page-create","id":"ws",
            "sectionId":section["id"],"title":title,"html":content},path=self.db)["page"]

    def event(self, page=None):
        return nb.event_action({"action":"notebook-event-create","id":"ws",
            "title":"Checkpoint","eventDate":"2026-11-08","kind":"milestone",
            "pageIds":[page["id"]] if page else [],"taskIds":["t1"]},path=self.db)["event"]

    def preview(self, kind, target):
        return purge.preview({"kind":kind,"targetId":target,"id":"ws"},path=self.db)

    def remove(self, preview, **overrides):
        request={"id":"ws","kind":preview["kind"],"targetId":preview["targetId"],
            "confirm":"DELETE PERMANENTLY","confirmTitle":preview["title"],
            "signature":preview["signature"],**overrides}
        return purge.delete(request,path=self.db)

    def assert_empty_page(self, page_id):
        for table in ("work_note_pages","work_note_page_revisions","work_note_page_links",
                      "work_note_event_pages","work_note_legacy_map",
                      "work_note_page_timeline","work_note_page_timeline_revisions",
                      "work_note_v35_docs","work_note_v35_history","work_note_v35_refs",
                      "work_note_v35_file_outbox","work_note_v35_staging",
                      "work_note_v35_index_state","work_note_v35_index_outbox"):
            key = "id" if table == "work_note_pages" else "page_id"
            self.assertEqual(query(self.db,f"SELECT * FROM {table} WHERE {key}=?",page_id),[],
                             table)
        self.assertEqual(query(self.db,"SELECT * FROM work_note_v35_fts WHERE page_id=?",page_id),[])
        self.assertEqual(query(self.db,"PRAGMA foreign_key_check"),[])

    def test_delete_page_revisions_v35_fts_and_event_link_only(self):
        section=self.section()
        page=self.page(section,content="")
        other=self.page(section,"Unrelated")
        event=self.event(page)
        source={"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"INDEXEDCONTENT"}]}]}
        v35.document_save({"pageId":page["id"],"baseRevision":1,
                           "title":page["title"],"json":source},path=self.db)
        preview=self.preview("page",page["id"])
        self.assertEqual(preview["linkedEventCount"],1)
        self.assertEqual(preview["revision"],2)
        with self.assertRaises(nodes.NodeError):
            self.remove(preview,confirmTitle="Wrong")
        with self.assertRaises(nodes.NodeError):
            self.remove(preview,confirm="ARCHIVE")
        self.assertTrue(self.remove(preview)["deleted"])
        self.assert_empty_page(page["id"])
        self.assertEqual(nb.page_view({"id":"ws","page":other["id"]},path=self.db)["id"],other["id"])
        linked=nb.event_view({"id":"ws","event":event["id"]},path=self.db)
        self.assertEqual(linked["pageIds"],[])
        self.assertEqual(linked["taskIds"],["t1"])

    def test_delete_archived_page_and_section_cascades_all_pages(self):
        section=self.section("Discard project")
        first=self.page(section,"First")
        second=self.page(section,"Second")
        ev=self.event(first)
        nb.page_action({"action":"notebook-page-archive","pageId":second["id"],
                        "baseRevision":1},path=self.db)
        preview=self.preview("section",section["id"])
        self.assertEqual((preview["pageCount"],preview["archivedPageCount"]),(2,1))
        # New Page invalidates a previous confirmation, without deleting any data.
        third=self.page(section,"Late Page")
        with self.assertRaises(nodes.NodeError) as error:
            self.remove(preview)
        self.assertEqual(error.exception.status,409)
        self.assertTrue(query(self.db,"SELECT * FROM work_note_pages WHERE id=?",first["id"]))
        fresh=self.preview("section",section["id"])
        self.assertEqual(fresh["pageCount"],3)
        self.assertEqual(self.remove(fresh)["deletedPages"],3)
        for page in (first,second,third): self.assert_empty_page(page["id"])
        self.assertEqual(query(self.db,"SELECT * FROM work_note_sections WHERE id=?",section["id"]),[])
        self.assertEqual(nb.event_view({"id":"ws","event":ev["id"]},path=self.db)["pageIds"],[])

    def test_archived_section_purge_and_journal_protection(self):
        section=self.section("Temporary")
        v34.archive_section({"action":"notebook-section-archive","id":"ws",
            "sectionId":section["id"],"expectedUpdatedAt":section["updated_at"]},path=self.db)
        preview=self.preview("section",section["id"])
        self.assertTrue(preview["archived"])
        self.remove(preview)
        self.assertEqual(query(self.db,"SELECT * FROM work_note_section_action_audit WHERE section_id=?",
                               section["id"]),[])
        journal=next(s for s in v34.sections_view({"id":"ws"},path=self.db)["sections"]
                     if s["role"]=="journal")
        with self.assertRaises(nodes.NodeError) as error:
            self.preview("section",journal["id"])
        self.assertEqual(error.exception.status,409)

    def test_event_purge_preserves_pages_tasks_and_accepts_archived_events(self):
        section=self.section()
        page=self.page(section)
        event=self.event(page)
        nb.event_action({"action":"notebook-event-archive","eventId":event["id"],
                         "baseRevision":event["revision"]},path=self.db)
        preview=self.preview("event",event["id"])
        self.assertTrue(preview["archived"])
        self.assertEqual(preview["linkedPageCount"],1)
        self.assertEqual(preview["linkedTaskCount"],1)
        self.assertTrue(self.remove(preview)["deleted"])
        for table in ("work_note_events","work_note_event_pages","work_note_event_tasks",
                      "work_note_event_revisions"):
            self.assertEqual(query(self.db,f"SELECT * FROM {table} WHERE "+
                                   ("id=?" if table=="work_note_events" else "event_id=?"),
                                   event["id"]),[])
        self.assertEqual(nb.page_view({"id":"ws","page":page["id"]},path=self.db)["id"],page["id"])
        self.assertEqual(self.node("t1")["id"],"t1")
        self.assertEqual(query(self.db,"PRAGMA foreign_key_check"),[])

    def test_archived_event_discovery_not_confused_with_active_timeline(self):
        journal=next(s for s in v34.sections_view({"id":"ws"},path=self.db)["sections"]
                     if s["role"]=="journal")
        page=self.page(journal)
        archived_event=self.event(page)
        active_event=self.event()
        nb.event_action({"action":"notebook-event-archive","eventId":archived_event["id"],
                         "baseRevision":archived_event["revision"]},path=self.db)
        archived=v34.timeline_view({"id":"init","archived":"1"},path=self.db)
        self.assertEqual(archived["total"],1)
        self.assertEqual(archived["items"][0]["eventId"],archived_event["id"])
        self.assertIsNone(archived["items"][0]["pageId"])
        active=v34.timeline_view({"id":"init"},path=self.db)
        self.assertNotIn(archived_event["id"],[x["eventId"] for x in active["items"]])
        self.assertIn(active_event["id"],[x["eventId"] for x in active["items"]])
        self.assertIn(page["id"],[x["pageId"] for x in active["items"]])

    def test_owner_scope_and_revision_cas(self):
        section=self.section()
        page=self.page(section)
        preview=self.preview("page",page["id"])
        with self.assertRaises(nodes.NodeError):
            purge.delete({"id":"know","kind":"page","targetId":page["id"],
                "signature":preview["signature"],"confirm":"DELETE PERMANENTLY",
                "confirmTitle":page["title"]},path=self.db)
        nb.page_action({"action":"notebook-page-save","pageId":page["id"],
                        "baseRevision":1,"title":"Edited Page","html":"<p>new</p>"},path=self.db)
        with self.assertRaises(nodes.NodeError) as error:
            self.remove(preview)
        self.assertEqual(error.exception.status,409)
        self.assertTrue(query(self.db,"SELECT * FROM work_note_pages WHERE id=?",page["id"]))

    def test_api_routes_are_explicit_and_missing_resources_return_404(self):
        section=self.section()
        page=self.page(section)
        resp=api.handle("GET","/api/work-hub",
            {"view":"notebook-delete-preview","id":"ws","kind":"page","targetId":page["id"]},
            None,{"path":self.db})
        self.assertEqual(resp[0],200)
        preview=resp[1]["data"]
        response=api.handle("POST","/api/work-hub",{},
            {"action":"notebook-permanent-delete","id":"ws","kind":"page",
             "targetId":page["id"],"signature":preview["signature"],
             "confirmTitle":page["title"],"confirm":"DELETE PERMANENTLY"},
            {"path":self.db})
        self.assertEqual(response[0],200)
        with self.assertRaises(nodes.NodeError):
            self.preview("page",page["id"])

class ImportedLegacyDelete(common.V2Base):
    def test_deleting_imported_page_removes_current_node_source_without_siblings(self):
        source={"id":"note_old00123","title":"Delete Old Note","html":"<p>Remove secret</p>"}
        sibling={"id":"note_old00456","title":"Keep Old Note","html":"<p>Keep record</p>"}
        previous=store.get_record("ws",path=self.db)
        store.save_record({"id":"ws","kind":"workstream","parent_id":"init",
            "title":previous["title"],"status":previous["status"],
            "revision":previous["revision"],
            "data":{**previous["data"],"noteEntries":[source,sibling]}},path=self.db)
        nb.migrate(path=self.db)
        v34.migrate(path=self.db)
        v35.migrate(path=self.db)
        result=query(self.db,"SELECT page_id FROM work_note_legacy_map WHERE "
                      "owner_id=? AND old_note_id=?","ws",source["id"])
        self.assertEqual(len(result),1)
        target=result[0]["page_id"]
        before=store.get_record("ws",path=self.db)["revision"]
        preview=purge.preview({"id":"ws","kind":"page","targetId":target},path=self.db)
        self.assertEqual(preview["legacyPageCount"],1)
        purge.delete({"id":"ws","kind":"page","targetId":target,
                      "confirm":"DELETE PERMANENTLY","confirmTitle":preview["title"],
                      "signature":preview["signature"]},path=self.db)
        updated=store.get_record("ws",path=self.db)
        self.assertEqual(updated["data"]["noteEntries"],[sibling])
        self.assertEqual(updated["revision"],before+1)
        self.assertEqual(query(self.db,"SELECT * FROM work_note_legacy_map WHERE page_id=?",target),[])
        self.assertFalse(query(self.db,"SELECT * FROM work_note_pages WHERE id=?",target))
        self.assertFalse(nb.migrate(path=self.db)["changed"])
        self.assertEqual(len(query(self.db,"SELECT * FROM work_note_legacy_map WHERE owner_id=?",
                                   "ws")),1)
        self.assertEqual(query(self.db,"PRAGMA foreign_key_check"),[])


if __name__=="__main__":
    unittest.main()
