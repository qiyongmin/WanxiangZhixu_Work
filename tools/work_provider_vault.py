"""Loopback-only encrypted Work model-provider API key vault.

The React browser can PUT/REMOVE a key but NEVER read it back. No provider calls,
key probing, corporate data upload, or model inference are performed here.
Store outside KB_Work under the current WSL user's home to keep secrets out of
Git, File Hub, project ZIP backups and Work Hub exports. This is not enterprise
SSO, a hardware-backed keyring or an authorization boundary between same-OS users.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading
import tempfile

from cryptography.fernet import Fernet, InvalidToken

PROVIDERS = ("openai", "anthropic", "gemini", "glm", "kimi")
_LOCK = threading.RLock()
_ROOT = Path(__file__).resolve().parents[1]


class VaultError(ValueError):
    pass


def vault_root() -> Path:
    # Keep the old per-checkout secret location for Mode A. Explicit external
    # instances get separate stores even when using the same shared code.
    identity = os.environ.get('KB_WORK_DATA_ROOT') or str(_ROOT.resolve())
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    # Store outside the project so regular Work-only backups never include
    # provider credentials (these must be backed up separately in an approved vault).
    return Path.home() / ".local" / "share" / "kb-work-secrets" / digest


def _private_directory() -> Path:
    path = vault_root()
    for folder in (path.parent.parent.parent, path.parent.parent, path.parent, path):
        if folder.is_symlink():
            raise VaultError("Vault path must not be a symbolic link")
        if not folder.exists():
            folder.mkdir(mode=0o700)
        elif not folder.is_dir():
            raise VaultError("Vault path is not a directory")
    if path.stat().st_uid != os.getuid():
        raise VaultError("Vault owner mismatch")
    path.chmod(0o700)
    return path


def _read_key(path: Path) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise VaultError("Vault master key unavailable")
    status = path.stat()
    if status.st_uid != os.getuid() or stat.S_IMODE(status.st_mode) & 0o077:
        raise VaultError("Vault master key permissions are unsafe")
    data = path.read_bytes()
    try:
        Fernet(data)
    except (ValueError, TypeError) as exc:
        raise VaultError("Vault master key is invalid") from exc
    return data


def _master_key(path: Path) -> bytes:
    keyfile = path / "master.key"
    if not keyfile.exists():
        try:
            fd = os.open(str(keyfile), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "wb") as handle:
                handle.write(Fernet.generate_key())
                handle.flush()
                os.fsync(handle.fileno())
    return _read_key(keyfile)


def _read_records(path: Path, crypto: Fernet) -> dict[str, str]:
    document = path / "keys.enc"
    if not document.exists():
        return {}
    if document.is_symlink() or document.stat().st_uid != os.getuid() or stat.S_IMODE(document.stat().st_mode) & 0o077:
        raise VaultError("Vault data permissions are unsafe")
    try:
        data = json.loads(crypto.decrypt(document.read_bytes()))
    except (InvalidToken, ValueError, UnicodeError, TypeError) as exc:
        raise VaultError("Encrypted vault could not be decrypted") from exc
    if not isinstance(data, dict):
        raise VaultError("Vault format invalid")
    return {provider: value for provider, value in data.items()
            if provider in PROVIDERS and isinstance(value, str)}


def _write_records(path: Path, crypto: Fernet, data: dict[str, str]) -> None:
    blob = crypto.encrypt(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    with tempfile.NamedTemporaryFile("wb", dir=path, prefix=".keys-", delete=False) as handle:
        temp = Path(handle.name)
        os.fchmod(handle.fileno(), 0o600)
        handle.write(blob)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(temp, path / "keys.enc")
    finally:
        temp.unlink(missing_ok=True)


def _load() -> tuple[Path, Fernet, dict[str, str]]:
    path = _private_directory()
    crypto = Fernet(_master_key(path))
    return path, crypto, _read_records(path, crypto)


def statuses() -> dict[str, bool]:
    with _LOCK:
        # A status-only GET must not create a master key or mutate local files.
        if not vault_root().exists():
            return {p: False for p in PROVIDERS}
        _, _, data = _load()
        return {p: p in data for p in PROVIDERS}


def set_key(provider: str, secret: str) -> None:
    if provider not in PROVIDERS or not isinstance(secret, str):
        raise VaultError("Unknown provider or key")
    # Standard bearer keys are single-line. Never strip or normalize secrets.
    if len(secret) < 8 or len(secret) > 4096 or re.search(r"[\s\x00-\x1f\x7f]", secret):
        raise VaultError("Invalid API key format")
    with _LOCK:
        path, crypto, data = _load()
        data[provider] = secret
        _write_records(path, crypto, data)


def remove_key(provider: str) -> None:
    if provider not in PROVIDERS:
        raise VaultError("Unknown provider")
    with _LOCK:
        path, crypto, data = _load()
        data.pop(provider, None)
        _write_records(path, crypto, data)
