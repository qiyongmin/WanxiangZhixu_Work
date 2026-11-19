"""Project Skill edits are local-only, CAS guarded and history-preserving."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"tools"))
import project_skills
import work_resources
import work_project_skills_local as manager
import work_resource_api

SKILL="""---
name: local-demo
id: work.local-demo
description: A private local work skill
status: active
scope: ["projects/example/**"]
triggers: ["demo"]
aliases: ["local-demo"]
---

# Demo instructions
Follow the project's Global Guardrails from AGENTS.md.
"""

class LocalProjectSkillEditing(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="kbw-local-skill-")
        self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name)
        self.root=root
        folder=root/".agents/skills/work/demo"
        (folder/"references").mkdir(parents=True)
        (folder/"SKILL.md").write_text(SKILL,encoding="utf-8")
        (folder/"references/example.md").write_text("# Original reference",encoding="utf-8")
        self.skill_file=folder/"SKILL.md"
        self.patches=[
            patch.object(project_skills,"ROOT",root),
            patch.object(project_skills,"SKILLS",root/".agents/skills"),
            patch.object(project_skills,"EXTERNAL_DATA",None),
            patch.object(project_skills,"INDEX",root/".agents/skills/registry.json"),
            patch.object(project_skills,"PUBLIC_CATALOG",root/"data/project-skills.json"),
            patch.object(work_resources,"root",return_value=root/"content/ai-resources"),
        ]
        for p in self.patches:
            p.start();self.addCleanup(p.stop)

    def test_in_place_project_skill_edit_and_cas(self):
        self.assertEqual(len(project_skills.registry()["skills"]),1)
        details=work_resource_api.handle("GET",{"view":["project-skill-detail"],
                                                "id":["work.local-demo"]})
        self.assertTrue(details["editable"])
        self.assertEqual(len(details["files"]),2)
        original=work_resource_api.handle("GET",{"view":["project-skill-file"],
                     "id":["work.local-demo"],"file":["SKILL.md"]})
        self.assertEqual(original["content"],SKILL)
        with self.assertRaises(work_resources.ResourceError) as denied:
            manager.update({"skillId":"work.local-demo","filePath":"SKILL.md",
                "expectedSha256":original["sha256"],"content":SKILL+"\n# Update"})
        self.assertEqual(denied.exception.status,403)
        payload={"skillId":"work.local-demo","filePath":"SKILL.md",
            "expectedSha256":original["sha256"],"content":SKILL+"\n## New instructions\n",
            "confirmation":"Save this local Project Skill"}
        saved=work_resource_api.handle("POST",{},{"action":"project-skill-save",**payload})
        self.assertTrue(saved["saved"])
        self.assertTrue(saved["activityRecorded"])
        journal=work_resources.activity_journal(limit=10)["items"]
        self.assertEqual(journal[0]["kind"],"project_skill_updated")
        self.assertEqual(journal[0]["name"],"work.local-demo")
        self.assertIn("SKILL.md",journal[0]["detail"])
        self.assertIsNone(journal[0]["actor"])
        self.assertEqual(self.skill_file.read_text(),payload["content"])
        self.assertTrue(list((self.root/"content/ai-resources/project-skill-backups").rglob("*.bak")))
        with self.assertRaises(work_resources.ResourceError) as conflict:
            manager.update(payload)
        self.assertEqual(conflict.exception.status,409)
        self.assertEqual(project_skills.registry()["skills"][0]["id"],"work.local-demo")

    def test_scope_id_and_path_validation(self):
        original=manager.read("work.local-demo","SKILL.md")
        base={"skillId":"work.local-demo","filePath":"SKILL.md",
              "expectedSha256":original["sha256"],
              "confirmation":"Save this local Project Skill"}
        for invalid in (SKILL.replace("id: work.local-demo","id: work.changed"),
                        SKILL.replace('scope: ["projects/example/**"]','scope: ["**"]'),
                        SKILL.replace("Global Guardrails","Escalate all privileges")):
            with self.assertRaises(work_resources.ResourceError):
                manager.update({**base,"content":invalid})
        for invalid_path in ("../../AGENTS.md","../other.txt","/tmp/abc",
                             "references/missing.txt","scripts/install.sh"):
            with self.assertRaises(work_resources.ResourceError):
                manager.read("work.local-demo",invalid_path)
        self.assertEqual(self.skill_file.read_text(),SKILL)

    def test_local_reference_edit_preserves_core_skill(self):
        ref=manager.read("work.local-demo","references/example.md")
        result=manager.update({"skillId":"work.local-demo","filePath":"references/example.md",
            "expectedSha256":ref["sha256"],"content":"# Updated reference",
            "confirmation":"Save this local Project Skill"})
        self.assertTrue(result["saved"])
        self.assertEqual(self.skill_file.read_text(),SKILL)
        self.assertEqual((self.skill_file.parent/"references/example.md").read_text(),"# Updated reference")

    def test_backup_preserves_edit_history_and_never_touches_git(self):
        old=manager.read("work.local-demo","SKILL.md")
        manager.update({"skillId":"work.local-demo","filePath":"SKILL.md",
            "expectedSha256":old["sha256"],"content":SKILL+"\nSafe note\n",
            "confirmation":"Save this local Project Skill"})
        archived=list((self.root/"content/ai-resources/project-skill-backups").rglob("*.bak"))
        self.assertEqual(len(archived),1)
        self.assertEqual(archived[0].read_text(),SKILL)
        self.assertFalse((self.root/".git").exists())

if __name__=="__main__":
    unittest.main()
