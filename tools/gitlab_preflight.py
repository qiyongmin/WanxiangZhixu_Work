"""Preflight the exact Work-only source selected by Git ignore rules.

Read-only on KB_Work and Personal KB_Site. A temporary local Git index is used
to compute the would-be GitLab commit, without initializing KB_Work/.git.
Does not grant corporate approval or configure a remote.
"""
from __future__ import annotations
import ast,json,re,subprocess,tempfile
import work_source_audit
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
PERSONAL_VIZ={"english-vocab-atlas.js","warm-academy.js","inspiration-inbox.js",
 "inspiration-v2.js","news-reading.js","reflections.js","review-center.js",
 "vocab-cluster.js","vocab-reader.js","vocab-review.js","video-speaking.js"}
PERSONAL_PY={"inspiration_store.py","inspiration_v2.py","math_mistakes_store.py",
 "math_learning_units.py","math_learning_agent.py","math_mistakes_vision.py",
 "reflection_store.py","news_store.py","review_store.py","strategy_store.py"}
SECRET_PATTERNS={
 "privateKey":re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
 "githubToken":re.compile(r"\bgh[oprsu]_[A-Za-z0-9_]{25,}\b"),
 "awsKey":re.compile(r"\bAKIA[A-Z0-9]{16}\b"),
 "openaiKey":re.compile(r"\bsk-[A-Za-z0-9_-]{32,}\b")}
BLOCKED_PREFIXES=("content/","library/","projects/",".backups/",".maintenance/",
                  "runtime/","media/personal/","data/",".kiro/","tmp/")
PRIVATE_NAME_PREFIXES=(".agents/skills/work/initiatives/",".agents/skills/work/line-management/")
PRIVATE_FILES={"AGENTS.md","BUILD_VERIFICATION.json","tools/work_hub_seed.py"}
# Human identifiers deliberately use split literals: an auditor must not
# flag the auditor's own source for containing the searched full token.
IDENTITY_PATTERNS={
    "localUser":re.compile("eqi"+"yong|qi"+"yong"+"min",re.I),
    "personalSitePath":re.compile("/home/devspace-workspaces/"+ "KB_Site",re.I),
    "personalWindowsProfile":re.compile(r"C:\\\\Users\\\\[A-Za-z0-9._-]+",re.I),
    "companyHomeFolder":re.compile("OneDrive"+" - Ericsson",re.I),
    "personalEmail":re.compile(r"[A-Za-z0-9._%+-]+@(?:gmail|outlook|hotmail)\\.com",re.I),
}
def source_paths():
    with tempfile.TemporaryDirectory(prefix="kb-work-git-review-") as temp:
        base=Path(temp)
        subprocess.run(["git","init","-q"],cwd=base,check=True,stdout=subprocess.PIPE)
        git_dir=str(base/".git")
        subprocess.run(["git","--git-dir",git_dir,"--work-tree",str(ROOT),"add","-A"],
                       cwd=base,check=True,stdout=subprocess.PIPE)
        return subprocess.check_output(["git","ls-files"],cwd=base,text=True).splitlines()

def ignored_tracked_paths():
    """Detect already-published files excluded by the current slim allowlist.

    A temporary Git index only predicts NEW commits. The real checkout may
    still track obsolete files; .gitignore never untracks existing Git entries.
    Inspection only: does not stage, delete, commit or rewrite history.
    """
    if not (ROOT / ".git").exists():
        return []
    result=subprocess.run(["git","ls-files","-ci","--exclude-standard"],
                          cwd=ROOT,capture_output=True,text=True,check=True)
    return sorted(set(result.stdout.splitlines()))


def audit():
    paths=source_paths()
    excluded_tracked=ignored_tracked_paths()
    selected=set(paths)
    bad_dirs=[name for name in paths if name.startswith(BLOCKED_PREFIXES)]
    private_sources=[name for name in paths if name in PRIVATE_FILES or name.startswith(PRIVATE_NAME_PREFIXES)]
    person_viz=[name for name in PERSONAL_VIZ if "js/viz/"+name in selected]
    person_py=[name for name in PERSONAL_PY if "tools/"+name in selected]
    old_entry=["js/app.js","tools/serve.py"]
    unexpected_old=[path for path in old_entry if path in selected]
    requirements={"tools/work_server.py",
                  "tools/work_backup.py","tools/work_hub_store.py",
                  "tools/file_hub.py","WORKSPACE_KIND","index.html",
                  "web/package-lock.json","web/src/main.tsx",
                  "tools/work_hub_api.py","tools/work_migrate.py","tools/work_shortcuts.py", "tests/test_work_folder_bridge.py",
                  "tools/kbw.py",
                  "tools/work_init.py","tools/project_skills.py","AGENTS.template.md",
                  "tests/test_work_clean_init.py","tests/work_empty_clone.browser.cjs",
                  "web/public/wanxiang-work.svg","README.md","OPERATIONS.md",
                  "tools/work_hub_admin.py","tools/work_release_gate.py",
                  "web/src/components/files/FileHubPage.tsx",
                  "tools/work_source_audit.py","tools/work_server_health.py",
                  "tools/office_preview.py","tools/pdf_text.py",
                  "tools/work_notebook.py","tools/work_notebook_v34.py","tools/work_material_storage.py",
                  "tools/work_provider_vault.py","tools/work_file_open.py",
                  "tests/test_work_source_audit.py"}
    missing=sorted(requirements-selected)
    # Local import closure is a stronger check than a hand-maintained bootstrap list.
    local_modules={p.stem:p.relative_to(ROOT).as_posix() for p in (ROOT/'tools').glob('*.py')}
    missing_imports={}
    for name in paths:
        if not name.startswith('tools/') or not name.endswith('.py'):continue
        try:module=ast.parse((ROOT/name).read_text(encoding='utf-8'))
        except (UnicodeError,SyntaxError):continue
        referenced=set()
        for item in ast.walk(module):
            if isinstance(item,ast.Import):
                referenced.update(alias.name.split('.')[0] for alias in item.names)
            elif isinstance(item,ast.ImportFrom) and item.level==0 and item.module:
                referenced.add(item.module.split('.')[0])
        for mod in referenced:
            if mod in local_modules and local_modules[mod] not in selected:
                missing_imports.setdefault(local_modules[mod],[]).append(name)
    source_scan=work_source_audit.scan(ROOT,paths)
    # Every Skill definition or reference is local data, never publishable.
    wrong_skills=sorted(name for name in paths if name.startswith(".agents/skills/"))
    secrets=[]
    identity_hits=[]
    business_references=[]
    business_marker=re.compile(r"\b(?:CC[-_ ]?A"+"XIS|IT"+"SAC|CC"+"SM|CI"+"G)\b",re.I)
    for name in paths:
        file=ROOT/name
        if not file.is_file() or file.suffix.lower() not in (".js",".py",".json",".md",".sh",".bat",".html",".css"):
            continue
        if file.stat().st_size>5_000_000:continue
        content=file.read_text(encoding="utf-8",errors="replace")
        for category,pattern in SECRET_PATTERNS.items():
            if pattern.search(content):secrets.append({"path":name,"type":category})
        for category,pattern in IDENTITY_PATTERNS.items():
            if pattern.search(content):identity_hits.append({"path":name,"type":category})
        if business_marker.search(content):
            business_references.append(name)
    flags=[]
    if bad_dirs:flags.append("Git candidate includes runtime/company data")
    if private_sources:flags.append("Git candidate includes local agent or project-specific configuration")
    if identity_hits:flags.append("Potential personal identifier or local workspace path in source candidate")
    if person_viz or person_py or unexpected_old:flags.append("Git candidate includes personal-only or legacy entry files")
    if missing or missing_imports:flags.append("Git candidate missing Work runtime dependencies")
    if source_scan['issues']:flags.append("Expanded TS/TSX/SVG/text source scanner found source privacy or business-context markers")
    if source_scan['binaryRequireProvenanceReview']:flags.append("Binary source assets require provenance and license review")
    if wrong_skills:flags.append("Work skills index contains personal entries")
    if excluded_tracked:flags.append("Legacy local Git index contains ignored files; they are NOT in the fresh source snapshot and MUST NOT enter new public Git history")
    if secrets:flags.append("Detected potential secret tokens")
    if business_references:
        flags.append("Company-specific project names still occur in source/test examples; human business/IP review required")
    flags.append("Company authorization of repository, sources, attachments, access control, enterprise SSO and backup storage remains required")
    output={
        "format":"kb-work-source-candidate-preflight-v3",
        "selectedFiles":len(paths),
        "workOnlySourceTreePass":not (bad_dirs or private_sources or identity_hits or person_viz or person_py or unexpected_old or missing or missing_imports or wrong_skills or secrets or not source_scan['passAutomatedChecks']),
        "legacyIndexMatchesCandidate":not excluded_tracked,  # Existing checkout is NOT the public export.
        "excludedButStillTracked":excluded_tracked,
        "personalVueModulesInGit":sorted(person_viz),
        "personalPythonModulesInGit":sorted(person_py),
        "deprecatedEntryFilesInGit":unexpected_old,
        "businessDataFilesInGit":bad_dirs,
        "privateConfigurationInGit":private_sources,
        "potentialIdentityMarkers":identity_hits,
        "businessContextReferences":business_references,
        "businessContextReviewRequired":bool(business_references),
        "missingRequiredSources":missing,
        "missingImportedTools":missing_imports,
        "extendedSourceAudit":source_scan,
        "personalSkillEntriesInWork":wrong_skills,
        "potentialSecrets":secrets,
        "gitInitializedInKB_Work":(ROOT/".git").exists(),
        "remoteConfiguredByAssistant":False,
        "safeToPushWithoutCorporateReview":False,
        "blockers":flags,
        "next":"Public GitHub requires a separate, approved NEW history from the audited source candidate; never mirror the internal checkout. Keep all real Work data local."
    }
    return output

if __name__=="__main__":
    report=audit()
    dest=ROOT/"docs/gitlab-preflight.json"
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(report,ensure_ascii=False,indent=2))
