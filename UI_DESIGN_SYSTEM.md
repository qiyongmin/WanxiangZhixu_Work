# KBW UI V1.0 — independent open-source typography and components

## Scope and safety

This change replaces the vendor-specific typography/style layer without
rebuilding Work business logic. It must not modify Work/Notes SQLite, File Hub,
Tasks/Materials/Notes APIs, Agent approval, Revision/CAS, history, URL routing
or any private local resources. Mode A runs standalone without Internet/CDN.
Mode B remains optional and disabled.

Four visual styles (default, mountains, starship, aurora), Light/Dark/System
and Classic/Precision layouts are preserved on desktop, tablet and phone.

## Implementation (2026-11-19)

1. **Local/self-hosted fonts.** The pinned dependency packages
   `@fontsource-variable/inter@5.3.0`,
   `@fontsource-variable/noto-sans-sc@5.3.1` and
   `@fontsource-variable/jetbrains-mono@5.3.0` are imported from
   `web/src/main.tsx` via their `wght.css` variants. Vite copies their
   hashed WOFF2 files to `app/assets/`. They use `font-display:swap` and
   `unicode-range` (CJK is sharded, loaded for actual glyphs).
   `tokens.css` sets `Inter Variable`, `Noto Sans SC Variable`,
   `JetBrains Mono Variable` and system fallbacks. No remote font CDN.
2. **Independent design tokens.** `web/src/styles/tokens.css` is the
   application-owned source of typography, color, spacing, theme surfaces,
   radii, contrast, motion and focus rings. Existing CSS selectors preserve
   the four visual themes, Light/Dark and responsive behavior.
3. **Vendor-neutral primitives.** The old stylesheet contents were migrated
   intact to `web/src/styles/kbw-primitives.css`, which is imported from
   `web/src/main.tsx`; the legacy `web/src/styles/eds.css` is NOT imported,
   and is excluded from public GitHub by the strict `.gitignore` allowlist.
   It is retained locally only as a convenient rollback reference.
4. **Icons.** `web/src/components/icons.tsx` maps the existing 56
   semantic `IconName` values onto `lucide-react@1.75.0` ISC SVGs.
   Existing calls, size props and aria-hidden decorations are preserved.
5. **Dialogs.** `OverlayDialog.tsx` now uses
   `@radix-ui/react-dialog@1.3.1`, preserving its current
   `.work-modal-*` selectors, title, close button and content. Radix
   supplies focus management, Escape and overlay behavior. The existing
   native `ModalDialog.tsx` remains intact for Revision/Draft Guard flows;
   domain-specific dialogs and menus are not rewritten merely to introduce
   a library.
6. **Dependency downloads.** The WSL network can use China's npm mirror
   for installation, but the committed lockfile uses canonical
   `https://registry.npmjs.org/` URLs for international portability.
   Example one-off installation:
   `npm --prefix web ci --registry=https://registry.npmmirror.com --ignore-scripts`.
   The project does not persist any user-specific mirror configuration.
7. **License notices.** The root `THIRD_PARTY_NOTICES.md` links to full
   installed font/icon/dialog licenses at `web/public/licenses/`.
   They are copied to the locally served `/app/licenses/` output.
8. **Document previews.** Materials preserve their original file layout.
   Sandboxed Markdown preview uses a preference for the new fonts but
   keeps its restrictive CSP, so system fallback can be used inside
   isolated srcdoc; no font or script privilege is added. No Notes data
   or revision history is transformed.

## Tests and acceptance

- `npm --prefix web ci`, TypeScript check, full Vitest, Vite build.
- `python3 tools/work_source_audit.py`,
  `python3 tools/work_github_public.py`,
  `python3 tools/work_release_gate.py`.
- `python3 -m unittest tests.test_work_ui_design_system -v`.
- `python3 -m unittest tests.test_work_gitlab_fresh_clone -v` (legacy
  test name; enforces source-only, empty-data standalone).
- In an isolated clone run optional Chromium read-only smoke
  `KB_WORK_PLAYWRIGHT_PATH=<path to playwright> node tests/work_empty_clone.browser.cjs`.
  Test font files served from same origin, themes × Light/Dark,
  Classic/Precision layouts and widths 1440/820/390/320.
- Confirm the source candidate excludes private data, the old stylesheet,
  generated `app/`, `node_modules/` and Git history.
- Real Safari/iPad/iPhone checks are separate if that device/browser
  environment is available. Chromium responsive mode is not Safari.

## Verified outcome — 2026-11-19

- `npm --prefix web ci --registry=https://registry.npmmirror.com --ignore-scripts`:
  clean dependency installation passed with pinned versions and a canonical npmjs lockfile.
- TypeScript and production Vite build passed. The build emits 133 hashed files
  (including Unicode-sharded local WOFF2 and 5 bundled license notices).
- Vitest: **38 files, 427 tests passed**. Focused Initiative Explorer/Quick
  Access overlay regression: **13 passed**. Radix dialog Escape/close and
  accessible title have direct regression coverage.
- Related Python publication/design system tests: **21 passed**. The historical
  pagination unit test was made deterministic by verifying the fixture record
  by ID rather than incorrectly requiring it to appear first.
- Read-only public-source privacy scan: **318 candidate files, 0 issues,
  0 missing required public files, 0 private files in candidate**.
- Independent source-only Git Clone: **PASS**, zero business records, four
  default Sections, no private Skills/Notes/Materials or local data copied.
- Real headless Chromium in that isolated Clone: **PASS** for three self-hosted
  font families, five license URLs, **64 layout/skin/mode/viewport combinations**
  (four skins × two light/dark themes × two layouts × 1440/820/390/320 px),
  no horizontal page overflow, no third-party resource requests and no JS
  page errors.
- Known pre-existing Vite warnings: non-module boot scripts, unresolved
  static visual-theme URLs at build analysis time (resolved by static serving),
  and a large initial JS chunk. They did not prevent build or browser smoke,
  and are separate performance/refactoring opportunities.
- Native iPadOS Safari and iPhone Safari were **not** used during this WSL
  validation; Chromium responsive viewport coverage is not identical to
  actual Safari device coverage.

## Rollback

Without touching databases, revert `web/src/main.tsx` CSS imports and
font declarations, the icon mapping and overlay component changes; then
rebuild. Existing backup of local `eds.css` is retained for reference.
No persistence/schema migration occurs in this UI-only update.
