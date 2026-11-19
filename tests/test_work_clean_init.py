"""Clean bootstrap tests: never touch the live Work database or personal project."""
from __future__ import annotations
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import work_init


class FreshWorkInit(unittest.TestCase):
    def test_empty_new_checkout_creates_only_default_sections_no_demo_records(self):
        with tempfile.TemporaryDirectory(prefix="kbwork-clean-init-") as temp:
            root = Path(temp)
            (root / "WORKSPACE_KIND").write_text("KB_WORK_STANDALONE_V1", encoding="utf-8")
            result = work_init.initialize(root)
            self.assertEqual(result["records"], 0)
            self.assertEqual(result["sectionTitles"],
                             ["Initiatives", "Team Management", "Knowledge", "Projects"])
            with sqlite3.connect(root / "content/work-hub/work.sqlite3") as con:
                self.assertEqual(con.execute("SELECT COUNT(*) FROM records").fetchone()[0], 0)
                self.assertEqual(con.execute("SELECT COUNT(*) FROM revisions").fetchone()[0], 0)
                self.assertEqual(con.execute("SELECT COUNT(*) FROM links").fetchone()[0], 0)
                self.assertEqual(con.execute("SELECT COUNT(*) FROM work_sections").fetchone()[0], 4)
                self.assertEqual(con.execute(
                    "SELECT value FROM work_meta WHERE key='schema_version'").fetchone()[0], "2")
                self.assertEqual(con.execute(
                    "SELECT value FROM work_meta WHERE key='shell.root'").fetchone()[0], "react")
            for name in ("Projects", "General", "Shared"):
                self.assertTrue((root / "library" / name).is_dir())
            index = json.loads((root / "data/index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["domains"], [])
            self.assertEqual(index["deploymentProfile"], "work")
            with self.assertRaises(work_init.AlreadyInitialized):
                work_init.initialize(root)
            self.assertEqual(work_init.prepare_assets(root)["dataIndex"], "data/index.json")

    def test_never_overwrites_existing_database_or_identity_marker(self):
        with tempfile.TemporaryDirectory(prefix="kbwork-clean-protect-") as temp:
            root = Path(temp)
            with self.assertRaises(ValueError):
                work_init.initialize(root)
            marker = root / "WORKSPACE_KIND"
            marker.write_text("KB_WORK_STANDALONE_V1", encoding="utf-8")
            db = root / "content/work-hub/work.sqlite3"
            db.parent.mkdir(parents=True)
            db.write_bytes(b"protected user database")
            with self.assertRaises(work_init.AlreadyInitialized):
                work_init.initialize(root)
            self.assertEqual(db.read_bytes(), b"protected user database")


if __name__ == "__main__":
    unittest.main()
