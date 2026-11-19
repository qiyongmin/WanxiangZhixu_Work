# KB_Work Operations & Housekeeping

**Current mode:** localhost-only / default port 8001. This is not a supported multi-user service. New employees: follow [README.md](README.md) or the [Chinese Windows + WSL2 setup guide](DEPLOYMENT_WINDOWS_WSL_ZH.md). The verified local environment uses Ubuntu 24.04 in WSL2, Python 3.12, Node 22 and LibreOffice 24.2. Native Windows stop/Explorer support remains unvalidated.

## Service health

Run all commands in the **same Ubuntu/WSL session** as your server. For Office Materials preview install `sudo apt install libreoffice` (optional but recommended); for Excel Sheet Browser install `openpyxl` in the active project virtual environment. Both are optional and do not gate starting core Work. Check local dependencies without mutation:

```bash
python tools/work_doctor.py
```


```bash
./start.sh 8001 --no-browser
python3 tools/work_server_health.py 8001 --wait
./stop.sh 8001
```

The default `start.sh` detaches for real local service use. **Temporary tests** must use `--foreground --no-restart --no-browser` and terminate the actual child, not the Bash wrapper.

## Dual-mode V1.1: optional external instance (no Portal dependency)

Existing `./start.sh` remains the fully supported Mode A default. When `KB_WORK_DATA_ROOT` is unset, Work data stays in the original checkout. An explicitly initialized new WSL Linux Data Root can be selected in the same shell by `export KB_WORK_DATA_ROOT=...`; `start.sh` validates both SQLite databases, instance identity, user ownership and directory mode before starting. No automatic migration of existing business data occurs. `KB_WORK_MODE=portal` currently fails closed; never expose the legacy localhost API as a shared service.

For an external instance, **stop its Work service before taking a complete cold backup**. The old `tools/work_backup.py create` deliberately refuses external instances so it cannot archive the wrong checkout database. Use the external instance command instead:

```bash
./stop.sh 8001
python3 tools/work_instance_backup.py create --root "$HOME/KB_Work_Data" --to "$HOME/KB_Work_Backups/work-data.zip" --quiescent
python3 tools/work_instance_backup.py verify --archive "$HOME/KB_Work_Backups/work-data.zip"
# Restore ONLY into a NEW, non-existing WSL Linux directory:
python3 tools/work_instance_backup.py restore --archive "$HOME/KB_Work_Backups/work-data.zip" --to "$HOME/Restored_KB_Work_Data"
```

The `--quiescent` flag is an operator assertion that there are no ongoing writes; it is **not** proof that the service is stopped. The archive is sensitive local instance data and must not go into public GitHub. Provider secrets are deliberately outside the archive. All Skills are local, including former Common/generic Skills. A local-only Skills index can be built with `python3 tools/work_skill_layers.py build-private --data-root "$HOME/KB_Work_Data"`; `python3 tools/work_skill_layers.py audit-common` now reports **zero** publishable Skill files.

## AI Resources Hub V1.1 · streamlined personal library

The local web UI is `/app/resources/skills` (primary tabs: Skills, Prompts, MCP, Agents; toolbar: Discover, Activity, Installations). There is **no separate Reviews tab**: each resource card and version detail provides inline Approve. Four resource types are stored and versioned locally. Native deployment currently supports **Skills** to WSL-local Codex, Claude Code, Cursor and OpenCode directories with per-target preview, drift detection and explicit rollback. MCP service execution, remote Portal pairing, enterprise SSO, automatic public Pull Requests and other resource-type activation are **not** enabled. Always follow company rules before importing or installing external code; static checks cannot certify safety.

In this personal localhost-only workflow **no operator password setup is required**. Clicking **Approve** on a pending resource records approval of its immutable version; it does not run code or install anything. Installing a Skill still requires previewing the destination, explicit confirmation, and handling conflicting files. The restricted Agent MCP interface still has no approve/install/execute capability. Do not expose this unauthenticated local service to other users or a network.

Common local commands (never need a Central Portal):

```bash
python3 tools/kbw.py resources list
python3 tools/kbw.py resources list --type skill
python3 tools/kbw.py resources capabilities
python3 tools/kbw.py resources import-preview --source-type local --source /approved/local/skill-folder
python3 tools/kbw.py resources list --type prompt
```

The opt-in restricted MCP bridge runs as a **local stdio process** with `python3 tools/work_resources_mcp.py`; configure it only in an Agent already authorized to access these local resources. It is not an HTTP server. It offers search, local read, draft creation, static validation and submit-for-review; it offers no approve/install/execute tools. **By default it cannot discover pre-existing Private resources**; explicitly delegate individual approved Resource IDs via the MCP process environment variable `KB_WORK_RESOURCE_AGENT_ALLOWED_IDS` (comma-separated 32-character resource IDs). Newly created drafts are readable to that process during its session. This is application-level scoping, not OS isolation: do not give an untrusted Agent unrestricted shell/filesystem access under the same WSL user. The current MCP protocol bridge is a foundation, not blanket validation of every Agent's MCP client.

The Resource Registry and immutable objects are stored beneath `content/ai-resources/` in the selected local instance. `tools/work_instance_backup.py` captures its SQLite snapshot, private versions and installation receipt files in external-Data-Root mode; `tools/work_backup.py create --private-instance` includes the traditional in-checkout local Skills and registry. No backup contains external Agent Global directories or remote provider secrets. Backups can contain confidential business instructions; use only company-approved encrypted backup locations. Restore into an empty root, validate SQLite, then reconcile actual Agent installation paths; no separate operator passphrase is needed. A generic source-only GitHub clone must never contain these private artifacts.

**No Skills to Public GitHub:** The Common Candidate UI and API have been disabled. Skill version ZIP export remains local and does not publish anything. The Portal security gate remains disabled even when the local Hub is fully operational.

## AI Resources Hub V2.1 · four focused local workspaces

Open `http://127.0.0.1:8001/app/resources/skills` on the KB_Work host. **Skills / Prompts / MCP / Agents** are now the four primary tabs; Discover, Activity and the existing Installations/Studio functions remain accessible as toolbar actions or backward-compatible routes.

**Skills:** Project Skills and imported Skills share one searchable, categorized local catalog. Existing Project Skills are **editable in place** (SKILL.md and text/JSON reference files) with SHA-256 optimistic lock, immutable original-file backup and stable ID/scope validation. The imported Skills retain the original drafts, local review, versions and Agent install/rollback flow. All Skill content is local only. The Project Skills editor does not duplicate files into the imported-resource database. Agent Access only links here.

**Prompts:** retains the dedicated Prompt Notebook V2 editor without Skill-style approval/installation.

**MCP:** local draft configuration for transport (stdio/HTTPS), connection target, declared tools and **names of secret references only**. Creating a draft neither connects to nor launches the server. Do not paste secret values; manage them only through an approved local secret store.

**Agents:** local draft Agent Definition for role, Markdown instructions and declared tool names. Declaring a tool does not grant a permission; saving does not spawn an Agent. The generic immutable-version editor remains available in detail pages. Native runtime integrations require separate implementation and explicit validation.

**Privacy/Public GitHub:** ALL `.agents/skills/` entries, including original generic Work Skills and references, as well as generated local Skills catalogs, imported Skill SQLite and its objects are excluded from the minimal public source. The five previously tracked generic Skill files were removed from the Git **index only** with `git rm --cached`; on-disk originals remain unchanged. The existing five-commit internal Git history includes old Skill blobs: **never mirror it to public GitHub**. Use a new reviewed root commit and run `python3 tools/work_github_public.py` before preparing a source snapshot. Automated checks do not replace review of exact staged files, third-party dependency licenses or historical Git isolation. See [Public Release Checklist](PUBLIC_RELEASE.md).

## Agent Activities · one local audit timeline

Open `http://127.0.0.1:8001/app/agent/access?tab=activities`. **Agent Access** now has **Connections & API** and **Agent Activities** tabs. The latter combines prior Work Agent writes (with actor, state and node) and AI Resources audit events (Skill imports, drafts, immutable snapshots, approvals, deployments, edits). Search/filter by event source and name; open **Work Agent write review & full history** for all existing Agent confirmation/undo and pagination controls.

Existing local Skills/import audit events remain visible in the local Agent Activities journal with their original timestamps. Historical events without a verified actor display **Actor unrecorded**. New Project Skill edits write local `project_skill_updated` events with file label and before/after SHA prefixes, never instruction bodies or secrets. No personal history or audit counts are shipped in the public source.

Old `/app/agent` and `/app/resources/activity` bookmarks navigate to this tab. No separate sidebar Agent Activity entry remains. This journal uses only local storage, not GitHub or Central Portal.

## Prompt Notebook V2 · everyday workflow

Open `http://127.0.0.1:8001/app/resources/prompts` from the KB_Work host. Unlike the Skills install catalog, Prompts have a three-pane Notebook (Scenario Collections, Prompt pages, editor/Use Prompt) on desktop and one-pane navigation on phones.

1. Click **New Prompt**. Optionally select one of six original starter templates (Project Steering / Grill Me / Blueprint / Code Review / Document Restructure / Research). No sample is automatically added to the database.
2. Classify using multiple Scenarios, one Role (Steering/Task/Review/Workflow) and Timing (Always-on/Kickoff/Planning/Execution/Review/Handoff).
3. Edit Markdown or Plain Text. Draft saves are debounced and CAS-checked; **Save Version** preserves an immutable snapshot. Existing Prompt IDs, attachments and legacy categories remain compatible.
4. **Copy** the source Prompt or choose **Use Prompt** to fill `{{variable_name}}` placeholders, generate plain text and copy. Favorites, last-used and body search remain entirely local.
5. Open **Prompt Flows** to arrange existing Prompts in manual ordered steps. This does not invoke an AI Agent or execute code.
6. For Steering Prompt only, **Steering Export** previews the target and can write `AGENTS.md` or `CLAUDE.md` in an authorized WSL project after explicit user confirmation and hash-checked conflict handling. It backs up existing instructions privately before replacing them. The independent KB_Site project remains out of scope.

**Storage:** `prompt_notes` and `prompt_flows` are additive tables in `content/ai-resources/registry.sqlite3` and included in the existing private instance backup. There is no Central Portal dependency or GitHub upload. Prompts do not require Skill approval or installation.

## Windows notes

On a Windows PC, run the server **inside WSL2**, open `http://localhost:8001/app/` in the **Windows browser**, and perform service start/stop from WSL. Do not run Windows Python against a database on `\\\\wsl.localhost\\...`. The existing `start.bat` is an experimental compatibility entry point; native Windows stop/Office/Explorer behavior has not passed an acceptance test. The localhost-only backend is not a remote multi-user service.

## Targeted maintenance (no runtime DB writes)

All housekeeping commands default to **read-only inspection**:

```bash
python3 tools/work_housekeeping.py prune-backups
python3 tools/work_housekeeping.py stop-orphan-servers
python3 tools/work_housekeeping.py prune-stale-pids
```

Only after checking the printed targets, run each action with `--confirm`:

```bash
python3 tools/work_housekeeping.py stop-orphan-servers --confirm
python3 tools/work_housekeeping.py prune-stale-pids --confirm
python3 tools/work_housekeeping.py prune-backups --confirm
```

**Backup deletion is irreversible**: all recognized `KB_Work_*.zip` and `KB_Work_Private_*.zip` in `.backups/` are unlinked. It does **not** remove SQLite files, source code, library documents, revisions or `app/`. It records its exact file inventory inside `.maintenance/cleanup-plans/`. This is a deletion log, **not** a recovery copy. Users who deliberately delete all backups are accepting the absence of rollback ZIPs. No cleanup command automatically creates a replacement backup. Unknown objects, symlinks and unexpected paths cause refusal instead of broad recursive deletion.

The orphan-server action matches **only** deleted temporary Work test directories under the system temporary directory, excludes default port 8001, verifies PID/start time and never terminates a real working checkout. Stale PID cleanup acts only on absent process IDs, not live servers.

## Backups — entirely opt-in

Backup creation is not automatic. Two distinct explicit options exist:

```bash
python3 tools/work_backup.py create
python3 tools/work_backup.py create --private-instance
```

- **Portable Work archive**: generic source + Work SQLite snapshots + Work attachments and canonical files. This carries real Work data: it is **not** a public source-only bundle.
- **Private instance archive**: the above plus real local Work-specific `AGENTS.md`, private Skills, Work extension, local metadata and historical notes. It must stay encrypted inside approved company storage and never be submitted to public GitHub.
- Neither archive includes external provider secrets. Neither operation touches the personal site.

Verify and restore to a **new empty destination**:

```bash
python3 tools/work_backup.py verify /approved/path/backup.zip
python3 tools/work_backup.py restore /approved/path/backup.zip --to /approved/empty-KB_Work-restore
```

Do not restore a dated ZIP **over** an active database. If all backups are removed, the only current state is the live Work database and canonical files: prioritize protecting the device and obtaining an approved future backup destination.

## File retention

`content/file-hub/versions/`, `library/`, `projects/`, Work SQLite and File Hub SQLite are never cache files. Do not deduplicate them by SHA, name or size. Historical UI quarantine under `.maintenance/legacy-quarantine/` is rollback evidence until separately reviewed. `app/`, Python bytecode caches and `web/node_modules/` are regenerable but need not be removed just to make a local runtime leaner.

## Release gate

`tools/work_github_public.py` checks the exact public-source candidate and flags unsafe historical Git paths; `tools/work_release_gate.py` checks the local service boundary. **Neither pushes or deploys anything.** The project's [MIT LICENSE](LICENSE) is present. Before first GitHub push, confirm a new clean Git history, private-data exclusion, third-party dependency licenses, staged source changes and GitHub branch/security settings. Public-source permission does not authorize hosting a shared backend.
