"""Synthetic demo opt-in and privacy isolation regression (temporary databases only)."""
from pathlib import Path
import sqlite3
import tempfile
import unittest
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import work_init
import work_demo


class WorkDemoTests(unittest.TestCase):
    def test_default_is_empty_demo_explicitly_opt_in(self):
        with tempfile.TemporaryDirectory(prefix='kb-work-fake-demo-') as name:
            root = Path(name)
            (root / 'WORKSPACE_KIND').write_text('KB_WORK_STANDALONE_V1', encoding='utf-8')
            start = work_init.initialize(root)
            self.assertEqual(start['records'], 0)
            self.assertEqual(start['notebookVersion'], 4)
            db = root / 'content/work-hub/work.sqlite3'
            with sqlite3.connect(db) as con:
                self.assertEqual(con.execute('SELECT count(*) FROM records').fetchone()[0], 0)
                self.assertEqual(con.execute('SELECT count(*) FROM work_note_pages').fetchone()[0], 0)
            result = work_demo.install_demo(root)
            self.assertEqual(result['recordCount'], 5)
            self.assertEqual(result['materialCount'], 1)
            self.assertEqual(result['pageCount'], 1)
            self.assertEqual(result['eventCount'], 1)
            with sqlite3.connect(db) as con:
                self.assertEqual(con.execute('SELECT count(*) FROM records').fetchone()[0], 5)
                self.assertEqual(con.execute('SELECT count(*) FROM work_note_pages').fetchone()[0], 1)
                self.assertEqual(con.execute('SELECT count(*) FROM work_note_events').fetchone()[0], 1)
                self.assertEqual(con.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            with self.assertRaises(work_demo.DemoRefused):
                work_demo.install_demo(root)

    def test_private_library_blocks_demo_even_when_records_are_empty(self):
        with tempfile.TemporaryDirectory(prefix='kb-work-demo-library-protect-') as name:
            root = Path(name)
            (root / 'WORKSPACE_KIND').write_text('KB_WORK_STANDALONE_V1')
            work_init.initialize(root)
            protected = root / 'library' / 'General' / 'private-notes.txt'
            protected.write_text('Do not import', encoding='utf-8')
            with self.assertRaises(work_demo.DemoRefused):
                work_demo.install_demo(root)
            with sqlite3.connect(root / 'content/work-hub/work.sqlite3') as con:
                self.assertEqual(con.execute('SELECT count(*) FROM records').fetchone()[0], 0)
            self.assertEqual(protected.read_text(encoding='utf-8'), 'Do not import')

    def test_existing_db_or_invalid_root_refused_without_touching_bytes(self):
        with tempfile.TemporaryDirectory(prefix='kb-work-demo-protection-') as name:
            root = Path(name)
            db = root / 'content/work-hub/work.sqlite3'
            db.parent.mkdir(parents=True)
            db.write_bytes(b'important user database')
            with self.assertRaises(work_demo.DemoRefused):
                work_demo.install_demo(root)
            self.assertEqual(db.read_bytes(), b'important user database')
            (root / 'WORKSPACE_KIND').write_text('KB_WORK_STANDALONE_V1')
            with self.assertRaises((sqlite3.Error, work_demo.DemoRefused)):
                work_demo.install_demo(root)
            self.assertEqual(db.read_bytes(), b'important user database')


if __name__ == '__main__':
    unittest.main()
