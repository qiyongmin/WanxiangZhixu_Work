# KB_Work Architecture — Current Reference

**Status:** Current source-of-truth for the Work-only application.  
**Last reviewed:** 2026-11-15.  
**Scope:** Local-first, localhost-only, single-workspace product. For colleague installation see [README.md](README.md) and [Windows + WSL2 Chinese guide](DEPLOYMENT_WINDOWS_WSL_ZH.md). The tested host is Ubuntu 24.04 under WSL2; native Windows process shutdown, WSL Explorer integration and LibreOffice converter are not fully validated. This document supersedes dated UI implementation notes for architecture; historical reports remain evidence, not runtime instructions.

## V1.1 dual-mode compatibility contract

**Mode A (Standalone Local)** is mandatory, default, offline-capable and independent of any central login, PIN, Portal, Relay or identity provider. Current Clone → Build → `./start.sh` behaviour and all in-checkout data paths remain supported. **Mode B (Central Portal + Local Data)** is an optional future adapter to the *same* UI/business/SQLite/File Hub semantics. Current Mode B remains disabled until pairing, enterprise identity, signed UI and security gates are approved and implemented. Neither adapter may start a second writer on the same SQLite or silently copy existing records.

An external `KB_WORK_DATA_ROOT` can be explicitly created using `tools/work_instance_paths.py init` and selected for a new local instance. Data-root verification is fail-closed and existing Mode A paths are unchanged when the environment variable is absent. The separate `tools/work_instance_backup.py` is reserved for verified, quiescent external instances. There is no publishable Common Skill layer: ALL Skills stay in the local instance and public GitHub contains manager code only. Full migration of current real data and Central Portal deployment is intentionally not automatic.

## AI Resources Hub V1.1 · personal library UX (2026-11-18)

The isolated `tools/work_resources.py` Resource Registry stores four resource types (Skill, Prompt, MCP configuration and Agent definition) in local `content/ai-resources/registry.sqlite3`, with immutable SHA-256 file objects, revision-aware drafts, security findings and reviews. In external Data Root mode, all private objects live under `KB_WORK_DATA_ROOT/content/ai-resources/`. All Work Skills are local-only, including former generic/Common definitions; no Skill content or metadata is automatically published. The user interface lives at `/app/resources`, the loopback-only API at `/api/resources/v1`, local CLI at `python3 tools/kbw.py resources`, and opt-in restricted stdio MCP at `python3 tools/work_resources_mcp.py`. Only native Skill-copy deployment is implemented; other resource formats are stored and reviewed but not auto-activated. The self-use localhost UI offers inline version Approve and no separate operator passphrase. Installation and rollback retain explicit user confirmation, target-hash checks and backup/restore; the restricted Agent MCP endpoint cannot approve or deploy. This simplifies local UX but does not provide OS-level security isolation or enterprise identity.

Skill Common/publication is **disabled**: the Resource API rejects old Common-candidate endpoints, while explicit local version ZIP exports remain available for personal backup. The source-only public repository never includes private registry, local drafts, review history or install receipts. Resource HTTP routes are not exposed through `/local/v1` and cannot bypass the still-disabled Portal mode. No automatic execution of imported scripts/MCP tools, remote execution, sandbox claim, or central retention of private content is implemented. Source/import/static checks are advisory, not proof of safe execution. For operations, see `OPERATIONS.md`.

## AI Resources Hub V2.1 · focused workspaces and Project Skills

The four primary tabs are Skills, Prompts, MCP and Agents. Discover and Activity are toolbar buttons; Skills installations and the legacy Studio remain available as secondary actions/URLs. The header summary is reduced to a compact single-line status. `/resources` and old resource-ID links continue to resolve to Skills. Type-specific routes `/resources/mcp/:id` and `/resources/agents/:id` are additive and preserve existing immutable Resource IDs.

**Project Skills and imported Skills** appear in one locally searchable catalog, using each source's existing file IDs and data. `project_skills.registry()` remains authoritative for original Project Skills, and the separate local AI Resource Registry keeps imported Skills and immutable versions. Project Skills can be edited in place through a local-only editor (SKILL.md and text/JSON reference files): writes require exact SHA-256 match, preserve the stable Skill ID and scope, and save the previous file in ignored local backup storage. The catalog API exposes only metadata; full content is available through a separate explicit local-detail endpoint. No source file is copied into GitHub or moved from its original runtime path. Agent Access keeps only a shortcut to this unified catalog.

The MCP tab contains draft connection records for stdio or HTTPS transport, declared tool names and **secret reference names**, explicitly without process launch or credentials. The Agents tab contains draft role/instructions/tool declarations, without giving execution or tool rights. Both keep their own list, search, creation and detail layouts while reusing the Resource Registry's revision/snapshot primitives.

The `.gitignore` strict allowlist still excludes local Project Skills and generated project registry/catalog files; the independent source-only preflight verifies the selected GitHub source closure. The existing Git history contains previously tracked generic Skill files, even though the current source snapshot excludes them. Never reuse that history for the public repository. The MIT license applies to the public framework; data and source privacy checks remain mandatory.

## Agent Access · unified Activities journal (2026-11-18)

Open `/app/agent/access?tab=activities` from **Agent Access → Agent Activities**. This replaces the former independent left-sidebar Agent Activity and AI Resources Activity locations. Previous `/app/agent` and `/app/resources/activity` URLs canonicalize to the new tab without losing the underlying audit records.

The default **All** timeline combines two existing local authorities, preserving their original timestamps and event IDs: Work Hub Agent writes (`agent-writes`) and AI Resources audit records (`content/ai-resources/registry.sqlite3`). Entries are sortable by timestamp, searchable by source/resource/operation and filterable by Work Agents vs AI Resources. The detailed Work Agent history, pagination, confirm/undo and review controls are still available from the **Work Agent write review & full history** button on the Activities page.

The Resource Journal read endpoint `GET /api/resources/v1?view=activity-journal` enriches existing immutable audit rows with their resource names, type and **limited** source-repository provenance, through a local SQLite join; it supports bounded cursor pagination. It does not create retrospective events or claim a trustworthy Agent identity that was never recorded. For legacy Skill imports, `created_draft`, `snapshotted` and `review_approve` events remain separate and grouped by actual source (for example `mattpocock/skills`), while unrecorded actors display **Actor unrecorded**. Recorded human review labels originate only from existing review records; no automatic actor inference is performed.

Future in-place Project Skill edits are also logged locally as `project_skill_updated` with the Skill ID, original file name and before/after hash prefixes; **no Skill content, credentials or external-agent permissions** are added to the event. A successful write reports whether the audit event was stored. External Local Data Root backups already include the Registry and its journal; the current legacy in-checkout backup remains the private recovery path. Events never go to public GitHub or the Central Portal.

## Prompt Notebook V2 · additive resource extension (2026-11-18)

The `/app/resources/prompts` route is a dedicated Markdown-first Notes-style UI. It reuses the **same** Local Resource Registry, stable Resource IDs, drafts, SHA-256 immutable versions and history. An additive pair of SQLite tables (`prompt_notes`, `prompt_flows`) holds scenario, role, timing, favorite, last-used and manually ordered Prompt Flow metadata. Existing Prompts are not rewritten: metadata defaults are computed lazily, preserving legacy categories, version histories and attachments. Skills, MCP Configs and Agent Definitions retain independent data contracts; all Skills use local-only storage.

Local-only `/api/resources/v1` adds `prompt-list`, `prompt-detail`, `prompt-flows`, `prompt-create`, `prompt-save`, `prompt-revision`, `prompt-favorite`, `prompt-used`, `prompt-flow-save`, `prompt-steering-preview` and `prompt-steering-export`. The Markdown/plain-text editor uses revision CAS, debounced save and the shared browser Draft Guard. The preview sanitizes Markdown, and template substitution only produces plain text. Flows are manual ordered links, not autonomous execution.

Steering Export supports explicitly selected WSL-local project `AGENTS.md` (Codex) / `CLAUDE.md` (Claude Code) only. It requires Steering role, no unresolved `{{variables}}`, local project validation, old/new preview, explicit confirmation, target-hash verification and a private backup on overwrite. No Skill or script is executed. Agent sandbox behavior varies by product/configuration; the Hub does not assume a universal sandbox.

## Runtime boundary

- `WORKSPACE_KIND` marks a standalone Work root; `tools/site_boundary.py` checks that the Work process uses local Work-only storage.
- `start.sh` / `stop.sh` manage the **single real service** on default port 8001. `tools/work_server.py` serves both the Work API and the built React shell on loopback only. The Host/Origin boundary is **not user authentication**.
- Do not expose the service to a shared network, tunnel, or public endpoint. Enterprise SSO/RBAC, audit and approved networking are separate release gates.
- Work and personal knowledge-base projects are independent; do not import, copy or change personal-project directories.

## Data and rendering flow

```text
web/src/ (React + TypeScript; single active Work UI)
       | vite build
       v
app/ (local compiled assets; ignored by Git)
       |  localhost /app/ + /api/work-hub + /api/file-hub
       v
tools/work_server.py
   +-- work_hub_api / work_hub_nodes / work_hub_sections
   |     +-- Work SQLite (records, revisions, tasks, Notes V3)
   +-- work_notebook / work_hub_agent
   +-- file_hub / work_material_storage / office_preview
         +-- File Hub SQLite and library canonical files
```

- `web/src/main.tsx` is the single frontend entry point. Old `js/`, `assets/`, and `tools/serve.py` are legacy local assets, **not** active Work frontend entry points.
- `web/src/styles/` contains 39 currently imported CSS layers. They are still imported intentionally. Retire or merge only with cascade, theme and four-breakpoint visual regression coverage.
- Local business-specific migration/linkage behavior lives in ignored `tools/work_local_extensions.py`. It is optional in a clean generic clone; keep its private source within approved local Work storage.
- ALL `.agents/skills/` entries, including generic `work-hub` and `work-agent`, are local and Git-ignored. A fresh Clone starts without Skills, while the Work framework still operates.

## Persistence & non-destructive compatibility

Current Work SQLite, File Hub SQLite, `library/`, `projects/`, history blobs, Notes V3 IDs, Agent audits and Revisions are **authoritative state**. Never replace them with an older ZIP or collapse two files simply because their SHA-256 bytes currently match. Preserve stable File/Node/Note IDs, CAS revisions, audit history, associations and draft safeguards.

## Public GitHub source-only boundary

`tools/gitlab_preflight.py` (legacy tool name) computes the exact source-only allowlist using a temporary Git index; `tools/work_source_audit.py` scans its contents. `tools/work_github_public.py` separately checks those candidate files, rejects private classes, and detects previously committed private paths. `app/`, live data, `.backups/`, `.maintenance/`, local `AGENTS.md`, private extensions and **ALL Skills** are excluded. Prompts, MCP/Agent definitions and audit events stay in local SQLite; no resource definitions are published.

The PUBLIC repository must use a NEW, reviewed root commit, never mirror the old GitLab history. GitHub Actions builds/tests only. Mode A standalone is the hard release gate; future optional Mode B cannot change the default, require Central services or export business records. Source-readiness is **not** permission to push or expose the unauthenticated server. Follow [Public Release Checklist](PUBLIC_RELEASE.md) for source privacy, third-party dependency licensing, safe Git history and GitHub security configuration.

## Canonical current contracts

- Notes: V3.3 OneNote Canvas presentation over V3 Notes revision/CAS storage; do not revive V2 notes-save writes.
- Materials: Explorer Focus/Focus Stack with Type Accent cards; canonical originals and stable File IDs, read-only preview and controlled association.
- Work hierarchy: L1 Project Canvas; L2/L3 focused owner pages; a single LeftTree navigation.
- Cockpit: Clarity Layers selected, with attention/follow-up/upcoming and collapsed recently updated.
- UI: default style plus three optional themes, independent of light/dark preference.

Historical reports and phase-specific working notes are retained outside the generic Git repository. This file is the concise architecture reference for fresh clones.
