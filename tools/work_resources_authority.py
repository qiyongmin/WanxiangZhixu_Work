"""Local human-approval gate for resource activation.

Approval passphrase is set interactively, verified with scrypt, and never
stored in KB_Work, GitLab, ordinary backups, or remotely. This is a single
local-user gate, NOT corporate authentication or protection from OS admins.
"""
from __future__ import annotations
from getpass import getpass
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import stat
import threading
import time

import work_resources as store

_ATTEMPTS=0
_BLOCKED_UNTIL=0.0
_LOCK=threading.Lock()

def path():
    identity=str(store.data_root().resolve())
    digest=hashlib.sha256(identity.encode()).hexdigest()[:16]
    return Path.home()/".local"/"share"/"kb-work-resources-authority"/digest/"approval.json"

def initialize(passphrase):
    if not isinstance(passphrase,str) or len(passphrase)<16 or len(passphrase)>256:
        raise store.ResourceError("approval_passphrase_length")
    target=path()
    if target.exists() or target.is_symlink():
        raise store.ResourceError("operator_already_configured",409)
    for segment in (target.parent.parent, target.parent):
        if segment.is_symlink():
            raise store.ResourceError("unsafe_operator_path",403)
        segment.mkdir(mode=0o700,parents=True,exist_ok=True)
        if segment.stat().st_uid!=os.getuid() or stat.S_IMODE(segment.stat().st_mode)&0o077:
            raise store.ResourceError("unsafe_operator_path",403)
    salt=secrets.token_bytes(16)
    password_hash=hashlib.scrypt(passphrase.encode("utf-8"),salt=salt,n=2**14,r=8,p=1)
    fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY|getattr(os,"O_NOFOLLOW",0),0o600)
    with os.fdopen(fd,"w",encoding="utf-8") as out:
        json.dump({"format":"kb-work-resource-human-approval-v1",
                   "salt":salt.hex(),"hash":password_hash.hex()},out)
        out.flush()
        os.fsync(out.fileno())
    return True

def configured():
    item=path()
    return item.exists() and not item.is_symlink() and item.is_file()

def require(passphrase):
    global _ATTEMPTS,_BLOCKED_UNTIL
    if not isinstance(passphrase,str) or len(passphrase)>256:
        raise store.ResourceError("approval_passphrase_required",403)
    item=path()
    if item.is_symlink() or not item.is_file():
        raise store.ResourceError("operator_setup_required",409)
    if item.stat().st_uid!=os.getuid() or stat.S_IMODE(item.stat().st_mode)&0o077:
        raise store.ResourceError("unsafe_operator_credentials",403)
    with _LOCK:
        if time.monotonic()<_BLOCKED_UNTIL:
            raise store.ResourceError("operator_temporarily_locked",429)
        try:
            document=json.loads(item.read_text(encoding="utf-8"))
            if document.get("format")!="kb-work-resource-human-approval-v1":
                raise ValueError("format")
            expected=bytes.fromhex(document["hash"])
            salt=bytes.fromhex(document["salt"])
            digest=hashlib.scrypt(passphrase.encode("utf-8"),salt=salt,n=2**14,r=8,p=1)
        except (ValueError,KeyError,OSError):
            raise store.ResourceError("operator_credentials_unavailable",503) from None
        if not hmac.compare_digest(digest,expected):
            _ATTEMPTS+=1
            if _ATTEMPTS>=5:
                _BLOCKED_UNTIL=time.monotonic()+60
                _ATTEMPTS=0
            raise store.ResourceError("invalid_operator_passphrase",403)
        _ATTEMPTS=0
        _BLOCKED_UNTIL=0.0
    return True

def setup_interactive():
    entered=getpass("New resource approval passphrase (16+ chars): ")
    repeat=getpass("Confirm approval passphrase: ")
    if entered!=repeat:
        raise store.ResourceError("approval_passphrase_mismatch")
    return initialize(entered)
