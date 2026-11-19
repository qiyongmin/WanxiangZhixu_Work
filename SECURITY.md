# Security Policy — KB_Work Public Source

This is a **single-user localhost development application**. It is **not** approved for corporate shared hosting, public tunnels or Internet access. Local loopback Host/Origin checks are **not SSO/RBAC**. For new Windows colleagues use the approved WSL2+Ubuntu setup documented in [README](README.md); do not treat native `start.bat` as a validated standalone service/Office/Explorer platform.

Do not commit company records, credentials, personal projects, database files, backups, local paths or internal business-specific Skills. The MIT copyright notice in LICENSE and explicit About-page author credit are intentional public attribution; unrelated personal names, private paths, business records and credentials remain excluded.

Report suspected vulnerabilities privately to repository maintainers using the configured GitHub private vulnerability reporting channel once available, or via a channel approved by the code owner. Never file a public issue containing secrets, source records, employer systems or production URLs.

Before approval of broader deployment, require enterprise SSO, authorization, secrets management, network restrictions, backup ownership, audit retention, and incident response. A public source repository does not grant those approvals. The source code is MIT-licensed. Public GitHub must use a NEW history with no private artifacts; review third-party dependency licenses and the exact public source candidate. See [Public Release Checklist](PUBLIC_RELEASE.md).
