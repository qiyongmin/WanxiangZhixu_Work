"""Explicit Work File Hub local Explorer reveal, by stable file ID only.

Never accepts a filesystem path from the browser; never opens SMB hosts,
untrusted shell commands or a personal knowledge-base path.
"""
from __future__ import annotations
import base64
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

import file_hub

FILE_ID = re.compile(r'file_[0-9a-f]{32}\Z')
# Explicit document/media types only. Never let a file uploaded to File Hub
# launch an executable, script, shortcut or installer on the Windows host.
NATIVE_OPEN_EXTENSIONS = frozenset({
    '.xlsx', '.xls', '.xlsb', '.xlsm', '.xltx', '.xltm',
    '.pptx', '.ppt', '.pptm', '.ppsx', '.pps', '.potx',
    '.docx', '.doc', '.docm', '.dotx', '.dotm',
    '.pdf', '.rtf', '.txt', '.md', '.csv', '.tsv',
    '.odt', '.ods', '.odp', '.html', '.htm', '.eml', '.msg',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
    '.zip', '.7z', '.json', '.xml', '.yaml', '.yml',
})

def open_native(fid):
    """Open the canonical Work file through its Windows default file association."""
    if not isinstance(fid, str) or not FILE_ID.fullmatch(fid):
        raise ValueError('Invalid File Hub ID')
    if sys.platform != 'linux' or 'microsoft' not in os.uname().release.lower():
        raise NotImplementedError('Windows desktop opening requires the trusted Windows/WSL host')
    if not shutil.which('powershell.exe') or not shutil.which('wslpath'):
        raise NotImplementedError('Windows desktop application integration unavailable')
    source, _ = file_hub.content(fid)
    root = file_hub.LIBRARY.resolve()
    if source.is_symlink() or not source.resolve().is_relative_to(root) or not source.is_file():
        raise ValueError('File is missing or outside Work library')
    if source.suffix.lower() not in NATIVE_OPEN_EXTENSIONS:
        raise ValueError('This file type cannot be launched by Windows Open; use the folder action')
    converted = subprocess.run(['wslpath', '-w', str(source)], check=True,
                               capture_output=True, text=True, timeout=5).stdout.strip()
    if (not converted.lower().startswith('\\\\wsl.localhost\\') and
            not converted.lower().startswith('\\\\wsl$\\') and
            not re.fullmatch(r'[A-Za-z]:\\[^\x00-\x1f]*', converted)):
        raise ValueError('Unexpected Windows file destination')
    # Encode the complete command, quoting a single literal path. No shell expansion,
    # filename-driven code execution, or browser-supplied executable selection.
    literal = converted.replace("'", "''")
    command = "Invoke-Item -LiteralPath '" + literal + "'"
    encoded = base64.b64encode(command.encode('utf-16le')).decode('ascii')
    subprocess.Popen(['powershell.exe', '-NoProfile', '-NonInteractive',
                      '-EncodedCommand', encoded], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    return {'requested': True, 'destination': 'trusted-local-Windows-host', 'fileId': fid}


def reveal(fid):
    if not isinstance(fid,str) or not FILE_ID.fullmatch(fid):
        raise ValueError('Invalid File Hub ID')
    if sys.platform!='linux' or 'microsoft' not in os.uname().release.lower():
        raise NotImplementedError('Native Explorer reveal requires the trusted Windows/WSL host')
    if not shutil.which('explorer.exe') or not shutil.which('wslpath'):
        raise NotImplementedError('Native Windows Explorer integration unavailable')
    source,_=file_hub.content(fid)
    # Canonical file, not history blob, must be physically inside this Work library.
    root=file_hub.LIBRARY.resolve()
    if source.is_symlink() or not source.resolve().is_relative_to(root):
        raise ValueError('File is outside Work library')
    if not source.is_file():
        raise FileNotFoundError('Canonical file missing')
    # Explorer /select,<file> can be parsed as a malformed switch by WSL interop,
    # causing Explorer to show Quick Access or another unrelated directory.
    # Open the *canonical containing directory* as a positional path instead.
    folder=source.parent.resolve()
    if not folder.is_relative_to(root) or not folder.is_dir():
        raise ValueError('Containing folder is outside Work library')
    converted=subprocess.run(['wslpath','-w',str(folder)],check=True,capture_output=True,
                             text=True,timeout=5).stdout.strip()
    if not converted.lower().startswith('\\\\wsl.localhost\\') and not converted.lower().startswith('\\\\wsl$\\'):
        # Native C: paths are also valid when Work is hosted on a Windows drive.
        if not re.fullmatch(r'[A-Za-z]:\\[^\x00-\x1f]*',converted):
            raise ValueError('Unexpected Explorer destination')
    subprocess.Popen(['explorer.exe',converted],stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    return {'requested':True,'destination':'trusted-local-Windows-host','fileId':fid,
            'folder':str(folder.relative_to(root)),'windowsFolder':converted}
