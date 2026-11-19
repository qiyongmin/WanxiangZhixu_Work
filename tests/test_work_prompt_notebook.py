"""Prompt Notebook V2 contract tests. All storage is isolated from real KB_Work."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import work_resources as store
import work_prompt_notebook as prompts
import work_resource_api as api

class PromptNotebookTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="kbw-prompt-notebook-")
        self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name)
        self.data=patch.object(store,"root",return_value=self.base/"ai-resources")
        self.data.start()
        self.addCleanup(self.data.stop)

    def test_new_prompt_is_searchable_draft_without_approval(self):
        p=prompts.create({"title":"Blueprint Reviewer","content":"Check {{project_name}} for risks",
           "role":"review","timing":"review","scenarios":["Vibe Coding","Documentation & Presentation"],
           "favorite":True})
        self.assertEqual(p["type"],"prompt")
        self.assertEqual(p["category"],"Vibe Coding")
        self.assertTrue(p["favorite"])
        self.assertEqual(p["variables"],["project_name"])
        self.assertEqual(p["draft"]["files"]["PROMPT.md"],"Check {{project_name}} for risks")
        self.assertEqual(len(prompts.list_prompts("Blueprint")),1)
        self.assertEqual(len(prompts.list_prompts("risks")),1)
        self.assertEqual(len(prompts.list_prompts("research")),0)
        self.assertEqual(prompts.list_prompts()[0]["role"],"review")

    def test_save_revisions_and_favorite_are_preserved(self):
        p=prompts.create({"title":"Planning","content":"Initial"})
        saved=prompts.save({"resourceId":p["id"],"baseRevision":1,"content":"For {{goal}}",
            "title":"Planning V2","role":"steering","timing":"always-on",
            "scenarios":["Steering & Instructions"],"favorite":True})
        self.assertEqual(saved["draft"]["revision"],2)
        self.assertEqual(saved["name"],"Planning V2")
        self.assertTrue(saved["favorite"])
        with self.assertRaises(store.ResourceError) as exc:
            prompts.save({"resourceId":p["id"],"baseRevision":1,"content":"lost"})
        self.assertEqual(exc.exception.code,"revision_conflict")
        favorite=prompts.set_favorite(p["id"],False)
        self.assertFalse(favorite["favorite"])
        self.assertFalse(prompts.detail(p["id"])["favorite"])

    def test_version_remains_immutable_and_new_draft_edits_only(self):
        p=prompts.create({"title":"Generation","content":"Original {{task}}"})
        v=store.snapshot(p["id"],{"baseRevision":1})
        self.assertIsNone(prompts.detail(p["id"])["draft"])
        new=prompts.start_revision(p["id"])
        self.assertEqual(new["draft"]["revision"],1)
        updated=prompts.save({"resourceId":p["id"],"baseRevision":1,"content":"Edited {{task}}"})
        self.assertEqual(updated["body"],"Edited {{task}}")
        self.assertEqual(store.version_detail(v["versionId"])["files"]["PROMPT.md"],"Original {{task}}")
        version2=store.snapshot(p["id"],{"baseRevision":updated["draft"]["revision"]})
        self.assertNotEqual(v["sha256"],version2["sha256"])
        self.assertEqual(prompts.detail(p["id"])["versionCount"] if "versionCount" in prompts.detail(p["id"]) else len(prompts.detail(p["id"])["versions"]),2)

    def test_existing_legacy_prompt_is_not_migrated_or_overwritten(self):
        legacy=store.create_draft({"type":"prompt","name":"Legacy",
            "category":"Old Custom Collection",
            "files":{"instructions.txt":"Original note","reference.md":"Context"}})
        p=prompts.detail(legacy["id"])
        self.assertEqual(p["body"],"Original note")
        self.assertEqual(p["role"],"task")
        self.assertFalse(p["hasMetadata"])
        self.assertEqual(p["scenarios"],["Old Custom Collection"])
        result=prompts.save({"resourceId":legacy["id"],"baseRevision":1,"content":"New body"})
        self.assertIn("reference.md",result["draft"]["files"])
        self.assertEqual(result["draft"]["files"]["instructions.txt"],"New body")
        self.assertEqual(result["draft"]["files"]["reference.md"],"Context")
        self.assertEqual(result["scenarios"],["Old Custom Collection"])
        self.assertEqual(result["id"],legacy["id"])

    def test_other_resource_types_are_unchanged(self):
        skill=store.create_draft({"type":"skill","name":"Keep Skill"})
        with self.assertRaises(store.ResourceError):
            prompts.save({"resourceId":skill["id"],"baseRevision":1,"content":"No"})
        with self.assertRaises(store.ResourceError):
            prompts.mark_used(skill["id"])
        self.assertEqual(store.detail(skill["id"])["type"],"skill")

    def test_copy_and_variable_templates(self):
        prompt=prompts.create({"title":"Use this","content":"Hi {{first}}, do {{task}}!"})
        self.assertEqual(prompts.render(prompt["body"],{"first":"Ada","task":"tests"}),
                         "Hi Ada, do tests!")
        with self.assertRaises(store.ResourceError):
            prompts.render(prompt["body"],{"task":"tests"})
        with self.assertRaises(store.ResourceError):
            prompts.render(prompt["body"],{"first":"x","task":"y","extra":"z"})
        self.assertEqual(prompts.mark_used(prompt["id"])["resourceId"],prompt["id"])
        self.assertIsNotNone(prompts.detail(prompt["id"])["lastUsed"])

    def test_flows_are_ordered_links_with_cas(self):
        a=prompts.create({"title":"Grill","content":"Ask questions"})
        b=prompts.create({"title":"Blueprint","content":"Draft design"})
        flow=prompts.save_flow({"title":"Coding Cycle","steps":[a["id"],b["id"]]})
        self.assertEqual(flow["steps"],[a["id"],b["id"]])
        self.assertEqual(flow["revision"],1)
        updated=prompts.save_flow({"flowId":flow["id"],"baseRevision":1,
                      "title":"Coding Cycle V2","steps":[b["id"],a["id"]]})
        self.assertEqual(updated["revision"],2)
        self.assertEqual(updated["steps"],[b["id"],a["id"]])
        with self.assertRaises(store.ResourceError):
            prompts.save_flow({"flowId":flow["id"],"baseRevision":1,
                      "title":"Stale","steps":[a["id"]]})
        self.assertEqual(len(prompts.flows()),1)

    def test_steering_export_preview_and_atomic_replacement(self):
        p=prompts.create({"title":"Always","content":"Use tests","role":"steering","timing":"always-on"})
        workspace=self.base/"project"
        workspace.mkdir()
        target=workspace/"AGENTS.md"
        with patch.object(prompts,"_steering_target",return_value=target):
            request={"resourceId":p["id"],"agent":"codex","projectRoot":str(workspace)}
            plan=prompts.steering_preview(request)
            self.assertFalse(plan["conflict"])
            with self.assertRaises(store.ResourceError):
                prompts.steering_export({**request,"expectedTargetHash":None})
            exported=prompts.steering_export({**request,"expectedTargetHash":None,
                               "confirmation":"Export this steering prompt"})
            self.assertEqual(exported["status"],"exported")
            self.assertEqual(target.read_text(),"Use tests")
            plan2=prompts.steering_preview(request)
            self.assertTrue(plan2["conflict"])
            self.assertIn("Use tests",plan2["existingPreview"])
            target.write_text("external edit")
            with self.assertRaises(store.ResourceError):
                prompts.steering_export({**request,"expectedTargetHash":plan2["existingHash"],
                           "onConflict":"replace","confirmation":"Export this steering prompt"})
            self.assertEqual(target.read_text(),"external edit")
            hash_after=hashlib.sha256(target.read_bytes()).hexdigest()
            result=prompts.steering_export({**request,"expectedTargetHash":hash_after,
                  "onConflict":"replace","confirmation":"Export this steering prompt"})
            self.assertTrue(Path(result["backup"]).exists())
            self.assertEqual(Path(result["backup"]).read_text(),"external edit")
            self.assertEqual(target.read_text(),"Use tests")

    def test_steering_export_rejects_unsafe_project_root(self):
        p=prompts.create({"title":"Guard","content":"Test first","role":"steering"})
        with self.assertRaises(store.ResourceError):
            prompts.steering_preview({"resourceId":p["id"],
                "projectRoot":"/tmp", "agent":"codex"})
        with self.assertRaises(store.ResourceError):
            prompts.steering_preview({"resourceId":p["id"],
                "projectRoot":str(store.ROOT.parent/"KB_Site"),"agent":"codex"})

    def test_steering_requires_role_and_no_template_variables(self):
        p=prompts.create({"title":"Basic","content":"{{project_name}}"})
        with self.assertRaises(store.ResourceError):
            prompts.steering_preview({"resourceId":p["id"],"agent":"codex",
                         "projectRoot":str(self.base)})
        changed=prompts.save({"resourceId":p["id"],"baseRevision":1,
                "content":"{{project_name}}","role":"steering"})
        with self.assertRaises(store.ResourceError):
            prompts.steering_preview({"resourceId":p["id"],"agent":"codex",
                         "projectRoot":str(self.base)})

    def test_api_exposes_notebook_without_central_execution(self):
        item=api.handle("POST",{},{"action":"prompt-create",
          "title":"Research Evidence","content":"Assess {{research_topic}}",
          "scenarios":["Research & Analysis"]})
        results=api.handle("GET",{"view":["prompt-list"]})
        self.assertEqual(results[0]["id"],item["id"])
        updated=api.handle("POST",{},{"action":"prompt-save","resourceId":item["id"],
          "baseRevision":1,"title":"Research Evidence","content":"Collect {{research_topic}}"})
        self.assertEqual(updated["body"],"Collect {{research_topic}}")

if __name__=="__main__":
    unittest.main()
