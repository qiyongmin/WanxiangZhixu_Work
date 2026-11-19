# KB_Work — Public GitHub source-only release checklist

KB_Work is a **personal, independently developed, MIT-licensed** local-first application.
See [LICENSE](LICENSE). Publishing the public **source code** does not publish user
records and does not enable remote service access. The GitHub source repository has
not yet been created or pushed from this working checkout.

## Strict public/private boundary

| Public GitHub source | Local private instance only |
| --- | --- |
| Generic Python backend, React/TypeScript frontend, scripts | Work records, Notes, Tasks, revisions, Timeline |
| Initialization, tests, minimal docs and GitHub CI | `content/`, `library/`, `projects/`, `data/` |
| Generic UI assets, synthetic fixtures, MIT LICENSE | File Hub originals, attachments, exports and backups |
| Source-only resource management code, no resources | All Skills and references in `.agents/` |
| Architecture / security / installation guides | Prompts, MCP/Agent configurations, activity logs and credentials |

`AGENTS.md`, `.env*`, `.backups/`, local extensions, databases, generated
`app/`, and old `.gitlab-ci.yml` must not enter the GitHub source.
The author's MIT copyright notice in LICENSE and intentional About-page credit
are permitted; unrelated identifying data remains blocked.

**Mode A** (fully local standalone) must run from a clean clone with an empty
initial database. **Mode B** (future optional Central UI + paired Local Agent)
is currently disabled and must never change Mode A or transmit local records.

## First public release — technical steps

1. Review the strict `.gitignore` allowlist. Run:
   `python3 tools/work_source_audit.py` and
   `python3 tools/work_github_public.py`; both must pass automated checks.
2. Review [Third-party Notices](THIRD_PARTY_NOTICES.md), [UI Design System](UI_DESIGN_SYSTEM.md), third-party dependency licenses, test fixtures and the complete
   proposed source tree. The [MIT License](LICENSE) is already selected.
3. Run relevant Python and frontend tests, production frontend build and the
   isolated zero-data clean-clone smoke. Do not publish local resource catalogs.
4. Create a **new local source-only review copy** with
   `python3 tools/work_github_export.py --output /tmp/KB_Work_Public_Review --review-copy`.
   The destination must not exist and must be outside this checkout.
5. Inspect the review copy and exact staged content, especially dependencies,
   lock files, URLs, sample data, SVGs and Git author email.
6. Preserve the original GitLab `.git` in a private external backup. Start an
   entirely **new Git root history** from the audited source. Do not mirror,
   fork, cherry-pick or migrate the old GitLab refs, commits, branches or tags.
7. Create a new **empty** GitHub Public repository and push only the audited
   initial commit after reviewing its staged file list. Configure protected
   branches, GitHub Actions least-privilege, secret scanning and dependency alerts.
8. Clone the published repository into a separate clean directory. Initialize
   an empty local instance and verify that the app works without bundled Work
   records, Skills, Prompts, MCP, Agents, File Hub or secrets.

The source preflight reports historical private paths **as technical evidence**,
not as a demand to repeat ownership approvals. A clean current file selection
does not make older commits suitable for public mirroring.

## Why old history is excluded

The original GitLab history previously tracked Work Skill/reference files,
despite the current `.gitignore` excluding all Skills. Previous Git commits
can also retain historical metadata. `.gitignore` does **not** delete earlier
Git objects. Keep the old history private and create a fresh initial Git commit.

## Repeat for every future public push

- Work and update in the original `KB_Work` directory after initial Git
  cutover; the review copy is a one-time review aid, not the development repo.
- Run source audit and tests before staging.
- Inspect `git diff --cached --name-only` and `git diff --cached`; do not
  rely on `.gitignore` to sanitize content of tracked code.
- Keep live databases, attachments, backups, local Skills/Prompts/MCP/Agents,
  credentials and environment configuration in local storage only.

## Validation commands

```bash
python3 tools/work_source_audit.py
python3 tools/work_github_public.py
python3 tools/work_release_gate.py
python3 -m unittest tests.test_work_source_audit tests.test_work_github_public tests.test_work_ui_design_system tests.test_work_v2_release_gate -q
python3 -m unittest tests.test_work_gitlab_fresh_clone -v
npm --prefix web run typecheck
npm --prefix web run test -- --run
npm --prefix web run build
```

The existing `tools/work_release_gate.py` separately checks whether this
**localhost-only** application has safe service boundaries. Public source
publication does **not** authorize Internet hosting or an unauthenticated
shared backend. Portal pairing, identity/authorization, network controls and
data retention need their own implementation and tests before Mode B.

The current `origin` may still point to the previous GitLab. **Do not change
remotes or push from this existing history**. First finish the reviewed,
fresh-root-commit cutover.
