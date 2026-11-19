"""Read-only KB_Work deployment safety preflight.

This distinguishes local Work-only usability from safe source-only GitHub
publication and network service exposure. It never performs Git operations, sets credentials,
changes server binding or authorizes a remote release.
"""
from __future__ import annotations

import json
from pathlib import Path

import gitlab_preflight

ROOT = Path(__file__).resolve().parents[1]
WORK_MARKER = 'KB_WORK_STANDALONE_V1'


def audit(root=None, source_report=None):
    base = Path(root) if root is not None else ROOT
    source = source_report if source_report is not None else gitlab_preflight.audit()
    marker = (base / 'WORKSPACE_KIND').read_text(encoding='utf-8').strip() if (base / 'WORKSPACE_KIND').is_file() else ''
    server_file = base / 'tools/work_server.py'
    server = server_file.read_text(encoding='utf-8') if server_file.is_file() else ''
    locally_bound = 'ThreadingHTTPServer(("127.0.0.1", args.port)' in server
    site_file = base / 'tools/site_boundary.py'
    boundary = site_file.read_text(encoding='utf-8') if site_file.is_file() else ''
    boundary_guard = 'validate_isolated_runtime' in boundary and 'WORK_RELEASE' in boundary
    git_initialized = (base / '.git').exists()

    checks = {
        'workOnlyMarker': marker == WORK_MARKER,
        'loopbackOnlyServer': locally_bound,
        'isolatedDataGuardPresent': boundary_guard,
        'sourceCandidateClean': bool(source.get('workOnlySourceTreePass')),
        'noRuntimeFilesInSourceCandidate': not source.get('businessDataFilesInGit'),
        'noDetectedSourceSecrets': not source.get('potentialSecrets'),
    }
    # A local checkout can be safe to run after Git was initialized and a remote
    # was configured. Neither Git presence nor absence establishes corporate
    # publishing authorization; those approvals are gated separately.
    local_ready = all(checks.values())
    # InnerSource source distribution and shared-service deployment have different
    # approval prerequisites. Source-only review must not be blocked merely by
    # absent enterprise SSO, but cannot itself authorize any public GitHub push.
    source_checks = {
        'workOnlySourceTreePass': bool(source.get('workOnlySourceTreePass')),
        'noLiveRecordsInSource': not source.get('businessDataFilesInGit'),
        'noPrivateConfiguration': not source.get('privateConfigurationInGit'),
        'noDetectedSecrets': not source.get('potentialSecrets'),
        'noMissingRuntimeDependencies': not source.get('missingRequiredSources') and not source.get('missingImportedTools'),
        'noUnreviewedBinaryOrTextFindings': not (source.get('extendedSourceAudit') or {}).get('issues')
            and not (source.get('extendedSourceAudit') or {}).get('binaryRequireProvenanceReview'),
    }
    source_review_ready = all(source_checks.values())
    source_approvals = [
        'Create a fresh reviewed initial Git commit; never mirror the legacy Git history.',
        'Inspect final staged files, Git author email and third-party dependency licenses.',
        'Configure GitHub branch protection, secret scanning and least-privilege Actions.',
    ]
    service_approvals = [
        'Network access requires real authentication, authorization and tested network restrictions.',
        'Shared service mode requires secrets isolation, audit, backup and recovery safeguards.',
    ]
    return {
        'format': 'kb-work-release-safety-v2',
        'checks': checks,
        'gitTrackingPresent': git_initialized,
        'readyForLocalWorkOnly': local_ready,
        'readyForSourceOnlyHumanReview': source_review_ready,
        'readyForPublicDeployment': False,
        'readyForCorporateGitLabPush': False,  # Deprecated compatibility output.
        'readyForPublicGitHubSourcePush': False,
        'dualDeploymentV11': {
            'defaultMode': 'local',
            'modeAStandaloneSupported': local_ready,
            'modeACentralDependency': False,
            'externalDataRoot': 'explicit-opt-in-only',
            'modeBPortalEnabled': False,
            'modeBPairedLocalApiEnabled': False,
            'modeBEnterpriseDeploymentAuthorized': False,
            'modeAIsHardReleaseGate': True,
        },
        'sourceGate': {
            'automatedChecks': source_checks,
            'automatedChecksPass': source_review_ready,
            'authorizedToPush': False,
            'pendingApprovals': source_approvals,
        },
        'serviceDeploymentGate': {
            'localhostOnly': bool(checks['loopbackOnlyServer']),
            'authorizedToExposeService': False,
            'pendingApprovals': service_approvals,
        },
        'blockers': (source_approvals + service_approvals +
                     (['Local Work-only source/boundary preflight failed.'] if not local_ready else [])),
        'next': 'Review the clean source snapshot and dependencies, create a fresh Git root commit, and configure GitHub security. Shared backend deployment separately requires implemented authentication and network controls.',
    }


if __name__ == '__main__':
    print(json.dumps(audit(), ensure_ascii=False, indent=2))
