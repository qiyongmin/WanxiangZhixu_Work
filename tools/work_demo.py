#!/usr/bin/env python3
"""Opt-in, completely fictional KB_Work demo; never runs on fresh startup.

The source repository contains NO demo database. This tool only touches an
already initialized, zero-record Work database in the explicitly chosen root.
Refuses any workspace containing business revisions, records or Notes content.
"""
from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path
import sqlite3
import sys

import work_hub_store as store
import work_notebook as notebook
import work_hub_nodes as nodes

ROOT = Path(__file__).resolve().parents[1]
WORK_MARKER = 'KB_WORK_STANDALONE_V1'


class DemoRefused(RuntimeError):
    pass


def install_demo(root: Path) -> dict:
    root = Path(root).resolve()
    marker = root / 'WORKSPACE_KIND'
    if not marker.is_file() or marker.read_text(encoding='utf-8').strip() != WORK_MARKER:
        raise DemoRefused('Not an initialized standalone Work checkout')
    db = root / 'content' / 'work-hub' / 'work.sqlite3'
    if db.is_symlink() or not db.is_file():
        raise DemoRefused('Initialize an empty Work database first')
    # A File Hub or independent Section may contain meaningful user data even
    # when the Work records table is empty; never seed such a workspace.
    library = root / 'library'
    if library.is_dir() and any(path.is_file() or path.is_symlink() for path in library.rglob('*')):
        raise DemoRefused('Library already contains private files')
    hub_db = root / 'content' / 'file-hub' / 'catalog.sqlite3'
    if hub_db.exists():
        with sqlite3.connect(f'file:{hub_db}?mode=ro', uri=True) as con:
            if con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='files'").fetchone():
                if con.execute('SELECT count(*) FROM files').fetchone()[0]:
                    raise DemoRefused('File Hub already contains private files')
    index_file = root / 'data' / 'index.json'
    if not index_file.is_file():
        raise DemoRefused('Missing empty-clone instance metadata')
    metadata = json.loads(index_file.read_text(encoding='utf-8'))
    if metadata.get('domains') or metadata.get('collections'):
        raise DemoRefused('Instance metadata contains user content')
    with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as con:
        counts = {table: con.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for table in (
            'records', 'revisions', 'links', 'work_note_pages', 'work_note_events',
            'work_note_sections', 'work_section_audit',
        )}
        if con.execute('SELECT count(*) FROM work_sections').fetchone()[0] != 4:
            raise DemoRefused('Existing custom Sections detected')
        ready = con.execute(
            'SELECT value FROM work_meta WHERE key=?', ('notebook_v3_ready',)
        ).fetchone()
        if not ready or ready[0] != '1' or any(counts.values()):
            raise DemoRefused('Existing Work data found: refusing to import demo content')
        if con.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise DemoRefused('Work database integrity check failed')
    # These static IDs are ONLY for synthetic demo records, not imported from
    # the user, company, network, local files or any other project.
    records = [
        ('demo-orion', 'initiative', None, 'Orion · Fictional Project', 'Planned', {}),
        ('demo-orion-review', 'workstream', 'demo-orion', 'Concept Review', 'In Progress', {}),
        ('demo-orion-task-a', 'task', 'demo-orion-review', 'Review the fictional roadmap', 'Planned', {'priority': 'High'}),
        ('demo-orion-task-b', 'task', 'demo-orion-review', 'Draft a sample milestone', 'In Progress', {'priority': 'Medium'}),
    ]
    # Make the smallest possible set of local-only edits and never upload files.
    for identifier, kind, parent, title, state, data in records:
        store.save_record({'id': identifier, 'kind': kind, 'title': title,
                           'parent_id': parent, 'status': state, 'revision': 0, 'data': data}, path=db)
    # Synthetic fixture records use low-level save_record(), not node_create().
    # Initialize their protected V3.4 Journals explicitly, without touching
    # any real workspace data.
    import work_notebook_v34
    with nodes._writer(db) as con:
        for identifier, *_ in records:
            work_notebook_v34.ensure_journal(con, identifier)
    sample_material = nodes.material_add({
        'id': 'demo-orion',
        'baseRevision': store.get_record('demo-orion', path=db)['revision'],
        'type': 'link', 'title': 'Fictional design specification',
        'url': 'https://example.com/sample-specification',
    }, path=db)['material']
    page = notebook.page_action({
        'action': 'notebook-page-create', 'id': 'demo-orion',
        'title': 'Welcome to Orion (fictional demo)',
        'html': '<p>This entire project is fictional and contains no company information.</p>',
    }, path=db)['page']
    event = notebook.event_action({
        'action': 'notebook-event-create', 'id': 'demo-orion',
        'kind': 'milestone', 'title': 'Fictional checkpoint',
        'eventDate': '2026-01-15', 'html': '<p>Synthetic demonstration only.</p>',
        'pageIds': [page['id']], 'taskIds': ['demo-orion-task-a'],
    }, path=db)['event']
    return {
        'status': 'synthetic-demo-created', 'recordCount': len(records) + 1,
        'materialCount': 1, 'materialId': sample_material['id'],
        'pageCount': 1, 'eventCount': 1, 'rootId': 'demo-orion',
        'note': 'All content is fictional; no uploaded files, actual people or real service addresses.',
        'eventId': event['id'],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT,
                        help='Explicit standalone Work checkout to initialize with sample data')
    parser.add_argument('--confirm-synthetic-demo', action='store_true',
                        help='Required explicit opt-in; never run automatically')
    args = parser.parse_args(argv)
    if not args.confirm_synthetic_demo:
        parser.error('Synthetic demo is disabled unless --confirm-synthetic-demo is passed')
    try:
        result = install_demo(args.root)
    except (DemoRefused, sqlite3.Error, ValueError, OSError) as error:
        print(f'Demo refused: {error}', file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
