"""Isolated skill and external backup regression; never touches live data."""
from __future__ import annotations
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import work_instance_paths as paths
import work_instance_backup as backup
import work_skill_layers as skills

class WorkV11Contract(unittest.TestCase):
    def test_common_registry_is_empty_and_all_skills_are_local(self):
        report = skills.audit_common()
        self.assertTrue(report["passed"])
        self.assertEqual(report["commonCount"], 0)
        listed = skills.common_registry()["skills"]
        self.assertEqual(listed, [])
        self.assertFalse(any(("cc" + "-" + "axis") in item["path"] for item in listed))

    def test_private_registry_is_local_and_duplicate_rejected(self):
        with tempfile.TemporaryDirectory(prefix="kbw-skills-") as tmp:
            root = Path(tmp) / "instance"
            paths.initialize(root)
            folder = root / "agents/private/skills/demo"
            folder.mkdir(parents=True)
            definition = folder / "SKILL.md"
            definition.write_text('''---
name: personal-example
id: local.example
description: Example local-only metadata
status: active
scope: ["notes/**"]
triggers: ["personal"]
aliases: ["private-example"]
---
# Private demo

Global Guardrails from AGENTS.md apply.
''', encoding="utf-8")
            published = skills.write_private(root)
            self.assertEqual(published["privateCount"], 1)
            local = skills.merge(root)["skills"]
            self.assertEqual(len(local), 1)
            self.assertEqual(skills.common_registry()["skills"], [])
            self.assertNotIn("personal-example", json.dumps(skills.common_registry()))
            definition.write_text(definition.read_text().replace(
                "id: local.example", "id: work.work-hub"))
            self.assertEqual(skills.merge(root)["skills"][0]["id"],"work.work-hub")
            other=root/"agents/private/skills/duplicate"
            other.mkdir(parents=True)
            (other/"SKILL.md").write_text(definition.read_text(),encoding="utf-8")
            with self.assertRaises(skills.SkillBoundaryError):
                skills.merge(root)

    def test_external_backup_and_new_destination_restore(self):
        with tempfile.TemporaryDirectory(prefix="kbw-backup-") as tmp:
            base=Path(tmp)
            source=base/"source"
            paths.initialize(source)
            secret=source/"agents/private/skills/private.txt"
            secret.write_text("local-only fixture", encoding="utf-8")
            sidecar=source/"library/Projects/example.docx:Zone.Identifier"
            sidecar.write_text("Windows metadata fixture",encoding="utf-8")
            archive=base/"backup.zip"
            with self.assertRaises(ValueError):
                backup.create(source, archive, quiescent=False)
            report=backup.create(source,archive,quiescent=True)
            self.assertTrue(report["verified"])
            self.assertTrue(backup.inspect(archive)["verified"])
            target=base/"restored"
            restored=backup.restore(archive,target)
            self.assertTrue(restored["restored"])
            self.assertEqual((target/"agents/private/skills/private.txt").read_text(),
                             "local-only fixture")
            self.assertEqual((target/"library/Projects/example.docx:Zone.Identifier").read_text(),
                             "Windows metadata fixture")
            with self.assertRaises(ValueError):
                backup.restore(archive,target)

if __name__=="__main__":
    unittest.main()
