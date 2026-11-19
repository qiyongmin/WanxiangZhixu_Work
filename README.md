# 万象知序 · Work (KB_Work)

**One local-first workspace for projects, tasks, notes, files and follow-ups.**  
A structured Work cockpit that connects actions and supporting materials without replacing Microsoft Teams, SharePoint or company systems.

### Dual deployment modes · Blueprint V1.1 (implementation status)

**Mode A — Standalone Local is the default and must never depend on Central Portal.** Clone the source, install dependencies, build and run `./start.sh` exactly as before; existing local SQLite/File Hub paths and all existing user data remain unchanged. No Portal account, device PIN, enterprise gateway or server availability is required.

**Mode B — Central Portal + Local Agent is not yet enabled for real data.** The current implementation contains a safe, read-only protocol capability endpoint and foundations for external Data Root and **all-local** Skill storage. Local Agent pairing, SSO/security approvals, signed Trusted UI delivery and central enterprise deployment remain blocked. `KB_WORK_MODE=portal` is explicitly refused instead of exposing the existing localhost API to an untrusted webpage.

**Optional, new empty Data Root (WSL Linux filesystem only; no automatic migration):**

```bash
python3 tools/work_instance_paths.py init --path "$HOME/KB_Work_Data"
export KB_WORK_DATA_ROOT="$HOME/KB_Work_Data"
./start.sh 8001 --no-browser
```

Do not run `init` over existing Work data, do not manually move a live database, and do not set `KB_WORK_DATA_ROOT` unless the whole target instance has passed `verify`. The original `./start.sh` with this variable **unset** is still the fully supported local workflow. The new external root is being validated for the future Portal mode; do not switch the current business instance until the full migration gate has passed.

**New colleague? Start with [Choose your installation path](#choose-your-installation-path) and follow the steps below.**  
中文完整安装说明：[Windows + WSL2 部署指南](DEPLOYMENT_WINDOWS_WSL_ZH.md).

## 1. What does it do?

| Workspace feature | What you can do |
|---|---|
| **Cockpit** | Priorities, overdue/blocked items, follow-ups, Week view and cross-project Board |
| **Hierarchical work** | Initiative → Workstream → Task; Topic → Campaign → Task; customizable Sections such as Projects |
| **Tasks & Kanban** | Status, priority, due date, navigation, Done history and Revision-aware editing |
| **Notes V3.5** | OneNote-style Section/Page canvas, structured rich text, five-level collapsible outline, images, File Hub attachments / email files, Page history and Journal/Timeline; local AI-readable Markdown and knowledge search |
| **Materials / File Hub** | Copy files into a private managed library, read-only preview, file associations, history and download |
| **Quick Access** | Shortcuts to local Windows/WSL folders, Teams, SharePoint, EriDoc and ordinary links |
| **Agent Review** | Track proposed changes and audit activity; human review gates protect work items |
| **AI Resources Hub (personal local library)** | Four focused tabs: **Skills / Prompts / MCP / Agents**. ALL Skills are locally stored: original Project Skills are editable in place with SHA-protected backups; imported Skills retain local version/installation controls. Zero Skill content is distributed via public GitHub. Prompts uses Notebook V2; MCP/Agents store configuration/definitions only. Visit `/app/resources/skills`. |
| **UI Layout** | Choose the original Classic UI (default) or the optional Precision Workspace; independent of the four Visual Styles and Light/Dark/System theme |

**Open-source UI / typography:** KBW UI uses independent Design Tokens and a self-contained primitives stylesheet; pinned Inter, Noto Sans SC and JetBrains Mono variable fonts are **self-hosted by Vite**, and Lucide SVGs plus Radix Dialog use permissive open-source licenses. No runtime font CDN or shared backend is required. See [UI Design System](UI_DESIGN_SYSTEM.md) and [Third-party Notices](THIRD_PARTY_NOTICES.md). When the public npm registry is inaccessible, install dependencies using `npm --prefix web ci --registry=https://registry.npmmirror.com --ignore-scripts`; the lockfile keeps standard npmjs URLs for users in other regions.

In the top toolbar, use **UI Layout** to switch between **Current default (Classic)** and **Precision Workspace**. The same control is available in **Settings → Appearance**. Classic is always the fallback if no valid choice is stored. This is a local browser/device preference: it does not sync across devices, change your active task, remount a Notes editor or modify Work records. The four Visual Styles and Light/Dark/System theme remain independently selectable.

**Notes V3.5:** New/empty Pages use the optional Tiptap structured editor after the V3.5 schema is ready. Existing HTML Pages keep their original HTML and revision history; the **Use V3.5 Rich Editor** action performs a guarded, progressive conversion rather than rewriting the notebook. A Page can contain images, Page links, file attachments and original `.eml`/`.msg` mail files. `.eml` has local plain-text safe preview; `.msg` always retains original download and may fall back to file-only preview. The authoritative editing format is JSON; Markdown and safe HTML are read-only projections. A local SQLite FTS5 index supports same-project knowledge lookup without any external AI service. Cross-project Agent discovery is deliberately disabled until company identity/authorization are implemented. Fresh clones initialize V3.5 automatically; existing databases require a verified backup and explicit additive `notebook-v35-migrate` action. No legacy Page or Event is bulk rewritten by that migration.

The desktop, tablet and phone layouts are responsive. **This does not mean the server is ready for remote access from those devices**; corporate networking and authentication must be approved before offering access to other machines.

## 2. Choose your installation path

| Host computer | Recommended server environment | Status |
|---|---|---|
| **Windows 11** | **WSL2 + Ubuntu 24.04 LTS**; browser runs in Windows | **Recommended and verified baseline** |
| Windows 10 with compatible WSL2 | WSL2 + supported Ubuntu; browser runs in Windows | Supported architecture; verify organization policy |
| Linux / Ubuntu | Native Linux Python + Node.js | Compatible with the tested Linux runtime |
| Windows without WSL2 | Native Windows Python using `start.bat` | **Experimental, not fully validated; not the colleague deployment path** |

Why WSL2 on Windows? The current safe service stop logic relies on Linux `/proc`; the File Hub “open location” and folder shortcut features use the Windows/WSL bridge (`explorer.exe` and `wslpath`). LibreOffice PDF conversion is also validated with Linux executables, not native Windows `soffice.exe`. The presence of `start.bat` does **not** establish native Windows feature parity.

**Important storage rule:** On Windows/WSL2 clone KB_Work into the **Linux home filesystem** (`~/workspace/KB_Work`), not `/mnt/c/...`, `C:\...` or a `\\wsl.localhost\...` share used by **Windows Python**. Keep SQLite and File Hub on the filesystem of the process running the server. Linux files under `~/...` are available to Windows Explorer through the WSL integration, without starting the backend using Windows Python.

## 3. Dependencies: required vs optional

| Component | Minimum / recommendation | Why |
|---|---|---|
| **Windows WSL2** | For Windows users: Windows 11 + Ubuntu 24.04 LTS recommended | Linux backend with browser on Windows |
| **Git** | Installation approved by the company | Clone/update reviewed public source |
| **Python** | **3.12+ recommended** (3.12.3 tested) | HTTP API, SQLite, local file operations |
| **Node.js + npm** | **Node 22.12+ in the supported Node 22 line** (22.23.2 tested) | React/Vite build; Node 18 is insufficient |
| **Python `cryptography`** | `requirements.txt` (mandatory) | Local encrypted provider key vault |
| **LibreOffice** | Optional, **strongly recommended** for Materials | Headless high-fidelity Word/Excel/PowerPoint → PDF preview |
| **Python `openpyxl`** | Optional, recommended for Excel | XLSX Sheet Browser; independent of LibreOffice |
| **CJK fonts** | Optional (`fonts-noto-cjk`) | Improves Chinese/Japanese/Korean text in Office-generated PDF |

**Without LibreOffice:** Work, Tasks, Notes, upload, download and other file-management functions still operate. Office files do **not** get high-fidelity PDF conversion, and the UI may fall back to text-only previews. The website does not edit original Office documents. Actual edits take place in the original local folder and are reindexed by File Hub.

## 4. Step-by-step: Windows 11 + WSL2 (recommended)

### Step 1 — Install WSL2 / Ubuntu (Windows PowerShell)

If WSL2 is not already installed, run **PowerShell as Administrator**:

```powershell
wsl --install -d Ubuntu-24.04
```

Restart Windows if requested. Open **Ubuntu 24.04** and create your Linux username/password. Verify from PowerShell:

```powershell
wsl --list --verbose
```

The Ubuntu distribution should show **VERSION 2**. Installation may require corporate IT/administrator approval. If Windows is managed and virtualization, WSL, Microsoft Store or downloads are blocked, follow the internal IT-approved provisioning process instead.

### Step 2 — Install Linux dependencies (Ubuntu terminal)

All subsequent commands in this section must run **inside Ubuntu/WSL**, not in Windows PowerShell:

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip
python3 --version
git --version
```

Install **Node.js 22** in **Ubuntu** using your organization's approved Node.js distribution or Node version manager. If `nvm` is already approved and installed:

```bash
nvm install 22
nvm use 22
node --version
npm --version
```

Confirm Node is at least **22.12**. Installing Node only in Windows does not establish a working WSL toolchain. Do not use an unknown `curl | bash` bootstrap script on a managed company device.

### Step 3 — Install LibreOffice (recommended)

For full Office-to-PDF preview:

```bash
sudo apt install -y libreoffice fonts-noto-cjk
command -v libreoffice
libreoffice --version
```

The runtime searches for `libreoffice` or `soffice` in its **PATH**. This is **not a core startup dependency**, but highly recommended for the complete Materials experience. Excel Sheet Browser is separately enabled in Step 5.

### Step 4 — Clone the reviewed GitHub source-only repository (once published)

Use only the official public repository URL supplied by the source maintainer once it is published. Never transfer another user's `content/`, `library/`, `projects/`, `.agents/` or backups.

```bash
mkdir -p ~/workspace
cd ~/workspace
git clone <OFFICIAL_APPROVED_GITHUB_REPOSITORY_URL> KB_Work
cd KB_Work
```

The URL is a placeholder: **no authorized Public GitHub repository has been announced yet**. Clone contains the generic code only; initialize your own empty data separately.

### Step 5 — Python environment and frontend build

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt

# Optional but recommended for the Excel XLSX sheet browser:
python -m pip install openpyxl

npm --prefix web ci
npm --prefix web run build
```

A React `app/` directory is generated locally from `web/src/` (it is intentionally not checked into public GitHub). If your company blocks direct npm/PyPI downloads, use approved internal package mirrors; do not copy `node_modules` from another employee.

### Step 6 — Initialize **your own empty workspace** (once)

```bash
python tools/work_init.py
python tools/work_doctor.py
```

First initialization creates an empty Work SQLite database, four Sections (**Initiatives, Team Management, Knowledge, Projects**), an empty File Hub and Notes V3 schema, and local Agent instructions. The initializer refuses to overwrite existing data. `work_doctor.py` is read-only: it checks versions, optional Office preview dependencies, initialization and the built app, without reading business content or credentials.

An optional, entirely fabricated demo is available **only on a fresh empty workspace** and **only when explicitly chosen**:

```bash
python tools/work_demo.py --confirm-synthetic-demo
```

Skip this if you want a clean workspace. The demo is never seeded automatically.

### Step 7 — Start, open and stop

```bash
./start.sh 8001 --no-browser
python tools/work_server_health.py 8001 --wait
```

Open in your **Windows** browser: **http://localhost:8001/app/**

Stop/restart inside WSL:

```bash
./stop.sh 8001
./start.sh 8001 --no-browser
```

`./start.sh` starts the genuine local service in the background; `./stop.sh` verifies the process belongs to the current KB_Work checkout rather than killing an unrelated application. Foreground mode is also available: `./start.sh 8001 --foreground --no-restart` (Ctrl+C stops it).

### Step 8 — First-run acceptance checks

1. `python tools/work_doctor.py` reports `readyToStart: true` and finds LibreOffice if full Office preview is desired.
2. The browser shows 万象知序 · Work with its Logo, Cockpit and four initial Sections; there are **no preloaded real projects**.
3. Create a test Initiative → Workstream → Task; edit Status, Notes and a test Material.
4. Upload a **non-confidential synthetic DOCX/XLSX/PPTX**, verify the Materials PDF preview. For XLSX, check the Sheet Browser if `openpyxl` is installed.
5. Use File Hub's “Open Storage Location” **from the same Windows machine hosting WSL**; the operation opens the server host's Explorer, not a remote user's computer.
6. Stop and restart the service; confirm the newly created test items persist. Remove fictional test items through approved Work UI operations if desired.

## 5. Linux / Ubuntu installation

On a native Ubuntu machine, start at [Step 2](#step-2--install-linux-dependencies-ubuntu-terminal) and follow the same Python/Node/LibreOffice/clone steps. Run `./start.sh` and visit `http://localhost:8001/app/` **on the same machine**. Windows Explorer shortcut features are **WSL-host-specific** and not available on generic Linux; links, Notes, File Hub and previews remain available.

## 6. Native Windows: current limitations

Native Windows is **not a supported, end-to-end-verified distribution** today. The existing `start.bat` may launch the Python HTTP server when the project is on a local Windows drive, but:

- `stop.bat` calls a stop verifier that currently relies on Linux `/proc`; a safe Windows-native stop is **not guaranteed**.
- Quick Access local-folder launching and File Hub “Open Storage Location” depend on WSL and are **not implemented as native Windows bridges**.
- Office conversion discovers `libreoffice` / `soffice` in PATH and its isolated PDF-conversion flow was validated on Linux. Installing Windows LibreOffice alone does not validate this application path.
- SQLite on a Windows Python process accessing `\\wsl.localhost\...` can exhibit file locking problems. Do **not** use that combination.

**Recommendation:** Do not send colleagues through `start.bat` native setup until a separate Windows test matrix covers service shutdown, LibreOffice conversion, file locks, folder launch and database recovery. WSL2 already provides the required Windows desktop experience with a Linux backend.

## 7. Troubleshooting

| Symptom | What to check |
|---|---|
| `wsl` is not recognized / access denied | Windows version, WSL2/virtualization and company IT privileges; install/restart per Windows policy |
| `npm` / `node` not found in Ubuntu | Install **Node inside WSL**; check `node --version` ≥ 22.12 |
| `No module named cryptography` | Activate `.venv`; run `python -m pip install -r requirements.txt` |
| Frontend blank / old UI | Run `npm --prefix web run build`, then `./start.sh 8001 --no-browser` and refresh `/app/` |
| `Office PDF preview unavailable` | `command -v libreoffice`, `libreoffice --version`; restart server after installing; fallback is expected if absent |
| `XLSX Sheet Browser unavailable` | `python -m pip install openpyxl` in the same Python environment that starts the server |
| Port 8001 occupied | `./stop.sh 8001` verifies KB_Work ownership; do not `kill -9` an unknown process |
| Database seems missing / empty | Verify you are in your own WSL clone and use the correct `content/work-hub/` root; do **not** import another employee's DB |
| “Open Storage Location” unavailable | Must be a local Windows + WSL host with working `explorer.exe` and `wslpath`; not supported on native Linux or remote browsers |
| Browser on another device cannot connect | Expected: backend is localhost-only and has no enterprise SSO; do not bind it to `0.0.0.0` |

For advanced diagnostics, see [Operations](OPERATIONS.md). The repository includes a small Work-only test suite; historical implementation notes and stage-by-stage tests remain local.

## 8. Repository structure and data protection

```text
KB_Work/
├── web/src/                 React/TypeScript source
├── web/tests/               Frontend tests
├── app/                     Generated frontend build, not Git source
├── tools/                   Work-only Python API/CLI, init, doctor and audits
├── tests/                   Python integration and isolated fixture tests
├── .agents/skills/work/     Local Skills directory (not shipped to GitHub)
├── content/                 PRIVATE local SQLite and versioned File Hub data
├── library/                 PRIVATE local canonical documents
├── projects/                PRIVATE existing-instance materials
├── .backups/                PRIVATE manual backup ZIPs, not source
├── README.md                This first-time setup guide
├── DEPLOYMENT_WINDOWS_WSL_ZH.md  Chinese installation guide
├── ARCHITECTURE.md          Current architecture
├── OPERATIONS.md            Service lifecycle / backup / maintenance
└── SECURITY.md              Local-only security boundary
```

The GitHub source-only candidate **excludes** actual Work records, File Hub, `projects/`, `.backups/`, local `AGENTS.md`, all local Skills and private local extensions. Each colleague starts with a clean copy. Generic `AGENTS.template.md` is used to create individual local Agent instructions.

**Important:** Public GitHub receives only audited source files. Portable Work and private-instance backup ZIPs contain personal/business data, must never be published and are not alternatives to separately approved private backups.

## Official installation references

- [Microsoft: Install WSL](https://learn.microsoft.com/en-us/windows/wsl/install) — install WSL2/Ubuntu and verify requirements.
- [Microsoft: Set up a WSL development environment](https://learn.microsoft.com/en-us/windows/wsl/setup/environment) — working with Linux distributions on Windows.
- [LibreOffice: Command-line startup parameters](https://help.libreoffice.org/latest/en-GB/text/shared/guide/start_parameters.html) — supported \`--headless\` and conversion options.

## 9. For contributors and maintainers

Start with [Architecture](ARCHITECTURE.md), [Operations](OPERATIONS.md), [Security](SECURITY.md) and [Public Release Checklist](PUBLIC_RELEASE.md). This compact distribution excludes local resources, historical reports and most phase-specific regression tests. `tools/work_github_public.py` checks the exact source candidate and Git history, but **never** authorizes publication.

Basic checks after cloning:

```bash
python tools/work_doctor.py
python tools/work_source_audit.py
python tools/gitlab_preflight.py  # compatibility source candidate checker
python tools/work_github_public.py
# A separate, reviewed local source-only copy can later be created with:
# python tools/work_github_export.py --output /tmp/KB_Work_Public_Review --review-copy
python tools/work_release_gate.py
npm --prefix web run typecheck
npm --prefix web run test
npm --prefix web run build
```

**Security and license:** KB_Work is licensed under [MIT](LICENSE); the planned Public GitHub repository is **source-only**, not a hosted multi-user service. The old GitLab history includes previously tracked Skills and **must not be mirrored**. Review third-party dependency license obligations, use a fresh audited initial commit and inspect Git author email and staged files. Personal records, paths, credentials and business projects must never enter Git. The local backend must not be exposed to the network without separate authentication and access-control work.
