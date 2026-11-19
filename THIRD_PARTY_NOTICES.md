# Third-party notices and open-source font licenses — KB_Work

The original KB_Work application framework is licensed under [MIT](LICENSE).
All third-party dependencies and fonts retain their own license terms.

## Pinned UI dependencies (web/package.json and package-lock.json)

| Package | Version | License | Included role |
| --- | --- | --- | --- |
| @fontsource-variable/inter | 5.3.0 | SIL OFL 1.1 | self-hosted Latin UI text |
| @fontsource-variable/noto-sans-sc | 5.3.1 | SIL OFL 1.1 | self-hosted simplified Chinese / mixed text |
| @fontsource-variable/jetbrains-mono | 5.3.0 | SIL OFL 1.1 | self-hosted monospace / code |
| lucide-react | 1.75.0 | ISC | SVG icon components |
| @radix-ui/react-dialog | 1.3.1 | MIT | accessible Work overlay dialogs |

**Actual license texts from the pinned installed packages**, copied verbatim
into `web/public/licenses/`, are shipped along with the built front end:

- [Inter OFL](web/public/licenses/inter-OFL-1.1.txt)
- [Noto Sans SC OFL](web/public/licenses/noto-sans-sc-OFL-1.1.txt)
- [JetBrains Mono OFL](web/public/licenses/jetbrains-mono-OFL-1.1.txt)
- [Lucide ISC and associated notices](web/public/licenses/lucide-ISC.txt)
- [Radix Dialog MIT](web/public/licenses/radix-dialog-MIT.txt)

The runtime copies these files under `/app/licenses/`; the fonts themselves
are compiled from the pinned Fontsource packages to content-hashed WOFF2 assets
under `/app/assets/`, with `font-display: swap` and CJK `unicode-range`.
No Google Fonts, remote icon assets or external CDN requests are required.
Font packages are included in the npm dependency closure, not committed as
raw font binaries in Git source. The browser downloads only needed WOFF2
subsets from the same local KB_Work origin.

The application uses `Inter Variable` + `Noto Sans SC Variable` and
`JetBrains Mono Variable`. It keeps normal system font fallbacks for
unavailable glyphs and isolated/document preview contexts. The sandboxed
Markdown source preview deliberately retains its restrictive CSP; original
Office/PDF/HTML file preview fidelity is unchanged.

## Other application dependencies

The complete dependency license truth is in the **exact installed version**,
its package LICENSE/COPYING metadata and the pinned `web/package-lock.json`
plus `requirements.txt`. In particular:

- React/React DOM — MIT
- @dnd-kit/core — MIT
- Tiptap open-source editor packages — MIT (check each installed package)
- markdown-it — MIT
- DOMPurify — (MPL-2.0 OR Apache-2.0)

These summaries do not supersede upstream license notices or cover every
transitive package. The new GitHub release requires a full dependency license
review when a version changes; never replace third-party license requirements
with the project's MIT text.
