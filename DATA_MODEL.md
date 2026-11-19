# KB_Work Data Model & Preservation Rules

**Authoritative current implementation:** `tools/work_hub_store.py`, `tools/work_hub_schema.py`, `tools/work_notebook.py`, `tools/work_hub_agent.py`, `tools/file_hub.py`.

## Persistent data owners

| Owner | Private local path | Important identity/invariant |
|---|---|---|
| Work Hub | `content/work-hub/work.sqlite3` | Stable Node/Task identities, parent/child structure, Revision/CAS history and audit |
| Notes V3 | Same Work Hub database | Section, Page, Event, Page Revision and owner; one canonical Page, references are links |
| File Hub | `content/file-hub/catalog.sqlite3` | Stable File ID, canonical path, SHA, revision, associations, tags, audit |
| Canonical files | `library/` | Local originals; never remove based on name or matching bytes alone |
| File versions | `content/file-hub/versions/` | SHA-addressed history, not interchangeable with current originals |
| Local project resources | `projects/` | Historical material links and potentially original source documents |
| Private local extension | `tools/work_local_extensions.py` | Historical instance adapters, never shipped as generic source |
| Local credentials | Outside source checkout | Do not include keys in Git, backups, reports or logs |

## Work hierarchy and revisions

- L1: Initiative / Topic / Knowledge Collection. L2: Workstream / Campaign. L3 and deeper: Tasks as permitted by the current hierarchy.
- Legacy `action` records remain for compatibility; newly created Task records use `task`.
- Do not bypass Revision/CAS, Draft Guard, human approval gates, or audit history when changing Notes, Tasks, Materials, links or ownership.
- Moving or reordering a node is different from changing its parent; do not merge both operations.

## Notes and Materials

- Notes V3 Pages have independent autosave, history and owner; existing legacy `?note=` links must keep resolving.
- File associations do not copy a canonical file. Inheritance from L1 is not a separate original at L2/L3.
- Equal SHA-256 does **not** imply safe removal: source paths, File IDs, versions, externally bookmarked file paths and audit events may differ.
- The Office-preview cache may be regenerated, but canonical originals, version blobs and File Hub SQLite may not be casually pruned.
- A pending office lockfile or Windows `Zone.Identifier` sidecar is not evidence that the corresponding file can be deleted.

## Migration & disaster recovery

Do not reset live SQLite from a prior snapshot. Use independent temporary clones, verify `PRAGMA integrity_check`, enforce original/restore ID counts and SHA checks, and approve any migration by explicit evidence. For private instance backup boundaries see `OPERATIONS.md`.
