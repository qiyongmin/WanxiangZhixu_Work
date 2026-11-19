"""AI Resources journal: legacy audit evidence, enrichment and safe pagination."""
from __future__ import annotations
from pathlib import Path
import json
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import work_resources as store
import work_resource_api as api

class LocalActivityJournalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="kbw-activity-journal-")
        self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name)/"resources"
        p=patch.object(store,"root",return_value=root)
        p.start();self.addCleanup(p.stop)

    def test_historical_source_and_names_are_grounded_not_actors(self):
        resource=store.create_draft({
          "type":"skill","name":"knowledge-skill",
          "files":{"SKILL.md":"---\nname: knowledge-skill\ndescription: Test\n---\n"},
          "source":{"type":"github","repository":"mattpocock/skills",
                    "ref":"a"*40,"secret":"never-expose"}})
        resource_id=resource["id"]
        snapshot=store.snapshot(resource_id,{"baseRevision":resource["draft"]["revision"]})
        store.decide(snapshot["versionId"],{
          "decision":"approve","actor":"local-user",
          "confirmation":"I reviewed this exact version","evidence":"Test"})
        page=api.handle("GET",{"view":["activity-journal"],"limit":["20"]})
        self.assertTrue(page["localOnly"])
        self.assertEqual(len(page["items"]),3)
        self.assertEqual([r["kind"] for r in page["items"]],
                         ["review_approve","snapshotted","created_draft"])
        self.assertEqual({r["name"] for r in page["items"]},{"knowledge-skill"})
        self.assertEqual({r["sourceRepository"] for r in page["items"]},{"mattpocock/skills"})
        self.assertEqual(page["items"][0]["actor"],"local-user")
        self.assertTrue(page["items"][0]["actorRecorded"])
        self.assertFalse(page["items"][1]["actorRecorded"])
        self.assertIsNone(page["items"][1]["actor"])
        self.assertEqual(page["items"][1]["sourceRef"],"a"*40)
        self.assertNotIn("never-expose",json.dumps(page))
        self.assertNotIn("SKILL.md",json.dumps(page))
        self.assertEqual(page["historicalActorPolicy"],"unrecorded-means-unknown")

    def test_page_cursor_and_empty_result(self):
        for i in range(6):
            store.create_draft({"type":"prompt","name":f"Prompt {i}"})
        seen=[]
        cursor=""
        while True:
            page=store.activity_journal(limit=2,before=cursor)
            seen.extend(row["id"] for row in page["items"])
            cursor=page["nextCursor"] or ""
            if not cursor:break
        self.assertEqual(len(seen),6)
        self.assertEqual(len(set(seen)),6)
        self.assertFalse(store.activity_journal(20,"2100-01-01T00:00:00+00:00|"+"f"*32)["nextCursor"])
        with self.assertRaises(store.ResourceError):
            store.activity_journal(999)
        for invalid in ("yesterday","2026-10-10|"+"z"*32):
            with self.assertRaises(store.ResourceError):
                store.activity_journal(20,invalid)

    def test_local_project_skill_update_has_distinct_provenance(self):
        with store._db() as db:
            store._audit(db,"project_skill_updated","project:work.example",
                        detail="SKILL.md · old → new · local API")
        result=api.handle("GET",{"view":["activity-journal"]})["items"][0]
        self.assertEqual(result["name"],"work.example")
        self.assertEqual(result["origin"],"project-skill")
        self.assertEqual(result["resourceType"],"skill")
        self.assertIsNone(result["actor"])
        self.assertIn("SKILL.md",result["detail"])

if __name__=="__main__":
    unittest.main()
