"""Work backup portability vs explicitly private instance backup tests."""
from __future__ import annotations

from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import work_backup


class PrivateBackupSelectionTests(unittest.TestCase):
    def test_real_workspace_selection_is_read_only_and_private_segregated(self):
        if not (work_backup.ROOT / "content/work-hub/work.sqlite3").exists() or not (
            work_backup.ROOT / "content/file-hub/catalog.sqlite3"
        ).exists():
            self.skipTest("Fresh source-only checkout has not yet initialized both Work and File Hub stores")
        public = {path for path, _ in work_backup.collect()}
        private = {path for path, _ in work_backup.collect(private_instance=True)}
        self.assertTrue(public.issubset(private))
        self.assertNotIn("tools/work_local_extensions.py", public)
        if (work_backup.ROOT / "tools/work_local_extensions.py").exists():
            self.assertIn("tools/work_local_extensions.py", private)
        if (work_backup.ROOT / "AGENTS.md").exists():
            self.assertIn("AGENTS.md", private)
        self.assertNotIn("AGENTS.md", public)
        if (work_backup.ROOT / ".agents/skills/work/initiatives").exists():
            self.assertTrue(any(name.startswith(".agents/skills/work/initiatives/") for name in private))
        self.assertFalse(any(name.startswith(".agents/skills/work/initiatives/") for name in public))
        self.assertNotIn("data/project-skills.json", public)
        if (work_backup.ROOT / "data/project-skills.json").exists():
            self.assertIn("data/project-skills.json", private)
        self.assertTrue(all("KB_Site/" not in name for name in private))

    def test_private_local_archive_round_trip_without_live_data(self):
        # Patch source selection and root to an isolated miniature Work checkout.
        with tempfile.TemporaryDirectory(prefix="kbw-private-archive-test-") as folder:
            root = Path(folder) / "KB_Work"
            root.mkdir()
            for name in ("index.html", "start.sh", "WORKSPACE_KIND",
                         "AGENTS.md", "AGENTS.template.md", "tools/work_local_extensions.py",
                         "data/project-skills.json", "docs/local.md",
                         "content/work-hub/work.sqlite3", "content/file-hub/catalog.sqlite3"):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.suffix == ".sqlite3":
                    with sqlite3.connect(target) as con:
                        con.execute("CREATE TABLE probe(id INTEGER PRIMARY KEY)")
                else:
                    target.write_text("only temporary fictional content", encoding="utf-8")
            archive = Path(folder) / "private.zip"
            public_source = ["index.html", "start.sh", "WORKSPACE_KIND", "AGENTS.template.md"]
            with mock.patch.object(work_backup, "ROOT", root), mock.patch(
                "gitlab_preflight.source_paths", return_value=public_source
            ):
                created = work_backup.create(archive, private_instance=True)
                self.assertTrue(created["verified"])
                verified = work_backup.verify(archive)
                self.assertTrue(verified["privateInstance"])
                restored = Path(folder) / "restored"
                response = work_backup.restore(archive, restored)
                self.assertTrue(response["verified"])
                self.assertTrue((restored / "AGENTS.md").is_file())
                self.assertTrue((restored / "tools/work_local_extensions.py").is_file())
                self.assertTrue((restored / "data/project-skills.json").is_file())
                self.assertTrue((restored / "content/work-hub/work.sqlite3").is_file())
                self.assertFalse((root / ".backups").exists())


if __name__ == "__main__":
    unittest.main()
