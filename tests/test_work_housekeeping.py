"""Safe housekeeping contracts. All write tests target disposable temp directories."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import work_housekeeping as tidy


class HousekeepingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kbw-housekeeping-test-")
        self.root = Path(self.temp.name) / "KB_Work"
        self.root.mkdir()
        (self.root / "WORKSPACE_KIND").write_text(tidy.MARKER, encoding="utf-8")
        (self.root / ".backups").mkdir()
        (self.root / "content").mkdir()
        (self.root / "content" / "work.sqlite3").write_bytes(b"never touch")

    def tearDown(self):
        self.temp.cleanup()

    def test_plan_does_not_remove_anything(self):
        files = ["KB_Work_20261115T010000Z.zip", "KB_Work_Private_20261115T020000Z.zip"]
        for name in files:
            (self.root / ".backups" / name).write_bytes(b"pretend zip")
        result = tidy.plan_backups(self.root)
        self.assertTrue(result["dryRun"])
        self.assertEqual(result["files"], 2)
        self.assertEqual(result["bytes"], 22)
        self.assertTrue(all((self.root / ".backups" / item).exists() for item in files))

    def test_confirm_removes_backups_only_and_writes_inventory(self):
        path = self.root / ".backups" / "KB_Work_20261115T010000Z.zip"
        path.write_bytes(b"backup payload")
        result = tidy.prune_backups(self.root, confirm=True)
        self.assertEqual(result["deleted"], 1)
        self.assertFalse(path.exists())
        self.assertEqual((self.root / "content" / "work.sqlite3").read_bytes(), b"never touch")
        manifest = Path(result["manifest"])
        self.assertTrue(manifest.exists())
        self.assertEqual(json.loads(manifest.read_text())["items"][0]["name"], path.name)

    def test_unknown_file_or_symlink_blocks_entire_delete(self):
        expected = self.root / ".backups" / "KB_Work_20261115T010000Z.zip"
        expected.write_bytes(b"safe")
        (self.root / ".backups" / "foreign.zip").write_bytes(b"other")
        with self.assertRaises(tidy.CleanupRefused):
            tidy.prune_backups(self.root, confirm=True)
        self.assertTrue(expected.exists())

    def test_wrong_workspace_refused(self):
        other = Path(self.temp.name) / "KB_Site"
        other.mkdir()
        (other / "WORKSPACE_KIND").write_text(tidy.MARKER)
        with self.assertRaises(tidy.CleanupRefused):
            tidy.prune_backups(other, confirm=True)

    def test_stale_pids_only_when_process_is_gone(self):
        folder = self.root / ".maintenance"
        folder.mkdir()
        name = "server-45555.pid.json"
        (folder / name).write_text(json.dumps({
            "root": str(self.root), "pid": 99999999, "port": 45555}))
        (folder / "server-8001.pid.json").write_text(json.dumps({
            "root": str(self.root), "pid": 1, "port": 8001}))
        plan = tidy.plan_stale_pid_files(self.root)
        self.assertEqual([e["name"] for e in plan["entries"]], [name])
        report = tidy.prune_stale_pid_files(self.root, confirm=True)
        self.assertEqual(report["removed"], [name])
        self.assertTrue((folder / "server-8001.pid.json").exists())


if __name__ == "__main__":
    unittest.main()
