"""P0 release-security gate: production data and source never leave the Work workspace."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import work_release_gate  # noqa: E402

CLEAN = {'workOnlySourceTreePass': True, 'businessDataFilesInGit': [], 'potentialSecrets': []}


class ReleaseSafety(unittest.TestCase):
    def test_local_work_boundary_passes_but_corporate_release_remains_blocked(self):
        result = work_release_gate.audit(source_report=CLEAN)
        self.assertTrue(result['readyForLocalWorkOnly'], result)
        self.assertFalse(result['readyForPublicDeployment'])
        self.assertFalse(result['readyForCorporateGitLabPush'])
        self.assertGreaterEqual(len(result['blockers']), 3)
        self.assertTrue(result['checks']['loopbackOnlyServer'])
        self.assertTrue(result['readyForSourceOnlyHumanReview'])
        self.assertTrue(result['sourceGate']['automatedChecksPass'])
        self.assertFalse(result['sourceGate']['authorizedToPush'])
        self.assertFalse(result['serviceDeploymentGate']['authorizedToExposeService'])
        self.assertTrue(result['serviceDeploymentGate']['pendingApprovals'])
        self.assertTrue(result['dualDeploymentV11']['modeAStandaloneSupported'])
        self.assertFalse(result['dualDeploymentV11']['modeACentralDependency'])
        self.assertFalse(result['dualDeploymentV11']['modeBPortalEnabled'])
        self.assertTrue(result['dualDeploymentV11']['modeAIsHardReleaseGate'])

    def test_initialized_git_repository_is_not_a_local_runtime_failure(self):
        with tempfile.TemporaryDirectory(prefix='kbw-git-release-gate-test-') as directory:
            root = Path(directory)
            (root / '.git').mkdir()
            (root / 'tools').mkdir()
            (root / 'WORKSPACE_KIND').write_text('KB_WORK_STANDALONE_V1')
            (root / 'tools/work_server.py').write_text('ThreadingHTTPServer(("127.0.0.1", args.port)')
            (root / 'tools/site_boundary.py').write_text('validate_isolated_runtime WORK_RELEASE')
            result = work_release_gate.audit(root=root, source_report=CLEAN)
            self.assertTrue(result['gitTrackingPresent'])
            self.assertTrue(result['readyForLocalWorkOnly'])
            self.assertTrue(result['readyForSourceOnlyHumanReview'])
            self.assertFalse(result['readyForCorporateGitLabPush'])
            self.assertFalse(result['readyForPublicDeployment'])

    def test_business_files_and_secrets_fail_the_local_gate(self):
        for report in ({**CLEAN, 'businessDataFilesInGit': ['content/work-hub/work.sqlite3']},
                       {**CLEAN, 'potentialSecrets': [{'path': 'x', 'type': 'token'}]},
                       {**CLEAN, 'workOnlySourceTreePass': False}):
            result = work_release_gate.audit(source_report=report)
            self.assertFalse(result['readyForLocalWorkOnly'])
            self.assertFalse(result['readyForSourceOnlyHumanReview'])


if __name__ == '__main__':
    unittest.main()
