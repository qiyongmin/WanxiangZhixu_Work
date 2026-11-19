"""No remote authorization is accidentally introduced by protocol discovery."""
from __future__ import annotations
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import work_portal_protocol as p

class ProtocolV11(unittest.TestCase):
    def test_safe_capabilities_only(self):
        caps=p.capabilities()
        self.assertEqual(caps["protocolMin"],1)
        self.assertFalse(caps["portalPairingEnabled"])
        self.assertFalse(caps["remoteApiEnabled"])
        self.assertFalse(caps["centralDataStorage"])
        self.assertNotIn("instanceId",caps)
        self.assertNotIn("dataRoot",caps)
        self.assertNotIn("token",caps)
        self.assertNotIn("pid",caps)

    def test_negotiation_never_authorizes_remote_write(self):
        self.assertTrue(p.compatibility(1,1)["compatible"])
        self.assertFalse(p.compatibility(2,3)["compatible"])
        self.assertEqual(p.compatibility(2,3)["status"],426)
        self.assertEqual(p.compatibility(0,1)["status"],400)
        self.assertFalse(p.compatibility(1,1)["remoteWriteAllowed"])

    def test_gate_remains_closed(self):
        release=p.release_status()
        self.assertTrue(release["localStandaloneReady"])
        self.assertFalse(release["portalPilotReady"])
        self.assertFalse(release["enterpriseDeploymentApproved"])
        self.assertFalse(release["pairingSupported"])

if __name__=="__main__":
    unittest.main()
