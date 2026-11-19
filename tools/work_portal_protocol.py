"""V1.1 read-only, non-identifying Local Agent protocol discovery.

The version contract is intentionally NOT pairing or remote API access. Portal
access remains disabled until enterprise approval and security gates pass.
"""
from __future__ import annotations

MIN_PROTOCOL = 1
MAX_PROTOCOL = 1
AGENT_VERSION = "0.1.0-foundation"
CAPABILITIES = (
    "work.core",
    "notes.v35",
    "materials.filehub",
    "skills.common-private",
    "offline.local-ui",
    "data-root.optional",
)

def capabilities() -> dict:
    # No local paths, PID, user, company project, login, secret or DB counts.
    return {"protocolMin": MIN_PROTOCOL, "protocolMax": MAX_PROTOCOL,
            "agentVersion": AGENT_VERSION,
            "localUiAvailable": True,
            "portalPairingEnabled": False,
            "remoteApiEnabled": False,
            "centralDataStorage": False,
            "capabilities": list(CAPABILITIES)}

def compatibility(minimum: int, maximum: int) -> dict:
    if type(minimum) is not int or type(maximum) is not int or minimum < 1 or maximum < minimum:
        return {"compatible": False, "status": 400, "code": "invalid_protocol_range"}
    overlap = minimum <= MAX_PROTOCOL and maximum >= MIN_PROTOCOL
    return {"compatible": overlap, "status": 200 if overlap else 426,
            "code": "compatible" if overlap else "upgrade_required",
            "localModeAvailable": True,
            "remoteWriteAllowed": False}

def release_status() -> dict:
    return {"localStandaloneReady": True, "portalPilotReady": False,
            "enterpriseDeploymentApproved": False,
            "pairingSupported": False,
            "transport": "loopback-only",
            "releaseGate": "security-and-identity-review-required"}
