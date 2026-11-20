"""Standalone Work-only HTTP server. No Personal module imports or APIs.

This local loopback server is NOT enterprise SSO. Do not expose it to the
internet or a personal Cloudflare Tunnel.
"""
from __future__ import annotations
import argparse
import base64
import binascii
import functools
import hashlib
import http.server
import json
import mimetypes
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import uuid
import webbrowser
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs,quote,unquote,urlsplit

import site_boundary
import file_hub
import office_preview
import work_file_open
import work_hub_store
import work_hub_ops
import work_hub_notes
import work_hub_api
import work_shell
import work_shortcuts
import work_hub_nodes
import work_material_storage
import work_provider_vault
import work_portal_protocol
import work_resource_api
import work_resources

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[1]
if not site_boundary.WORK_RELEASE or site_boundary.PROFILE != 'work':
    raise RuntimeError('This server may run only inside standalone KB_Work')
SERVER_INSTANCE=None


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    with tempfile.NamedTemporaryFile("wb", dir=path.parent, delete=False) as tmp:
        tmp.write(encoded)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)

def server_pid_path(port: int) -> Path:
    return ROOT / ".maintenance" / f"server-{port}.pid.json"

def write_server_pid(port: int) -> dict:
    record = {
        "version": 1,
        "pid": os.getpid(),
        "port": port,
        "root": str(ROOT.resolve()),
        "token": uuid.uuid4().hex,
        "startedAt": datetime.now().astimezone().isoformat(),
    }
    atomic_write_json(server_pid_path(port), record)
    return record

def remove_server_pid(record: dict) -> None:
    path = server_pid_path(record["port"])
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
        if current.get("token") == record.get("token"):
            path.unlink()
    except (OSError, ValueError, json.JSONDecodeError):
        pass

class VideoRangeHandler(http.server.SimpleHTTPRequestHandler):

    def send_response(self, code, message=None):
        self._response_status=code
        return super().send_response(code, message)

    def send_header(self, keyword, value):
        if keyword.lower()=='cache-control':self._cache_control_sent=True
        return super().send_header(keyword, value)

    def end_headers(self):
        # KB_Site is an SPA: never reuse obsolete application modules after a reload.
        # Keep large images/videos, user files and API cache policies unchanged.
        request_path=urlsplit(self.path).path
        if request_path.startswith(work_shell.APP_PREFIX):
            # New Shell: strict CSP plus classified caching (design 7.1).
            for name,value in work_shell.SECURITY_HEADERS:
                self.send_header(name,value)
            if not getattr(self,'_cache_control_sent',False):
                self.send_header('Cache-Control',work_shell.cache_control_for(
                    request_path,getattr(self,'_response_status',200)))
            self._cache_control_sent=False
            return super().end_headers()
        if (request_path in ('/', '/index.html')
                or (request_path.startswith('/js/') and request_path.endswith(('.js', '.mjs')))
                or (request_path.startswith('/assets/css/') and request_path.endswith('.css'))):
            self.send_header('Cache-Control', 'no-store')
        return super().end_headers()

    def _send_json(self, status: int, payload: dict, nosniff: bool = False) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if nosniff:
            self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _work_hub_v2(self, method, params, body=None):
        """Work Hub v2 views/actions (``work_hub_api``); same status/payload contract everywhere."""
        ctx = {'client': self.headers.get('X-Work-Client')}
        status, payload = work_hub_api.handle(method, urlsplit(self.path).path, params, body, ctx)
        self._send_json(status, payload, nosniff=True)

    def work_hub_agent_post(self):
        """``POST /api/work-hub/agent/*``: same Host/Origin write gate as every other write; no token."""
        if not self._work_hub_write_allowed():
            self._send_json(403,{'ok':False,'error':'Localhost only','code':'forbidden'},nosniff=True);return
        try:
            length=int(self.headers.get('Content-Length','0'))
        except ValueError:
            length=0
        if length<=0:
            self._send_json(400,{'ok':False,'error':'Invalid payload length','code':'invalid_body'},nosniff=True);return
        if length>work_hub_api.LARGE_BODY_LIMIT:
            self._send_json(413,{'ok':False,'error':'Payload too large','code':'payload_too_large'},nosniff=True);return
        try:
            payload=json.loads(self.rfile.read(length))
        except (ValueError,UnicodeError):
            self._send_json(400,{'ok':False,'error':'Invalid JSON','code':'invalid_body'},nosniff=True);return
        self._work_hub_v2('POST',{},payload)

    def work_provider_keys_post(self):
        """Write-only local provider keys. Never return, log or proxy key content."""
        if not self._work_hub_write_allowed():
            self._send_json(403, {'ok':False,'code':'forbidden','error':'Local same-origin access required'}, nosniff=True)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8192 or self.headers.get('Content-Type','').split(';',1)[0].strip() != 'application/json':
                raise ValueError('Invalid provider configuration request')
            value = json.loads(self.rfile.read(length))
            if not isinstance(value, dict):
                raise ValueError('Invalid provider configuration')
            if value.get('action') == 'save' and set(value) == {'action','provider','key'}:
                work_provider_vault.set_key(value['provider'], value['key'])
            elif value.get('action') == 'remove' and set(value) == {'action','provider'}:
                work_provider_vault.remove_key(value['provider'])
            else:
                raise ValueError('Unsupported provider operation')
            # No key material, suffix, length, or masked secret in the response.
            self._send_json(200,{'ok':True,'data':{'saved':work_provider_vault.statuses()}},nosniff=True)
        except (ValueError, TypeError, work_provider_vault.VaultError):
            self._send_json(400,{'ok':False,'code':'invalid_request','error':'Provider configuration rejected'},nosniff=True)
        except (OSError, RuntimeError):
            self._send_json(503,{'ok':False,'code':'vault_unavailable','error':'Local provider vault unavailable'},nosniff=True)

    def _serve_app(self, head_only=False):
        """``/app/…``: static Shell files, SPA fallback, 503 page when the build is missing."""
        request_path = urlsplit(self.path).path
        kind, target = work_shell.resolve_app_request(request_path)
        if kind == 'missing_build':
            body = work_shell.missing_build_page()
            self.send_response(503)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if not head_only:
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            return
        if kind == 'not_found':
            self.send_error(404, 'Not found')
            return
        # 'file' / 'index': hand over to the normal static path, keeping its boundary checks.
        self.path = work_shell.url_for(target)
        if head_only:
            return http.server.SimpleHTTPRequestHandler.do_HEAD(self)
        return http.server.SimpleHTTPRequestHandler.do_GET(self)

    def _app_route(self, head_only=False):
        """True when the request was an ``/app`` route and has been answered."""
        request_path = urlsplit(self.path).path
        if request_path == '/app':
            query = urlsplit(self.path).query
            self.send_response(301)
            self.send_header('Location', '/app/' + ('?' + query if query else ''))
            self.send_header('Content-Length', '0')
            self.end_headers()
            return True
        if request_path.startswith(work_shell.APP_PREFIX):
            self._serve_app(head_only)
            return True
        return False

    def _root_redirect(self):
        """The standalone KB_Work serves only the React Shell.

        Old bookmarks for /index.html are redirected instead of loading the
        retired legacy application. Keep compatibility for non-standalone test
        profiles; never mutate work_meta or the business database here.
        """
        parsed = urlsplit(self.path)
        if site_boundary.WORK_RELEASE:
            if parsed.path not in ('/', '/index.html'):
                return False
        elif parsed.path != '/' or not work_shell.root_is_shell():
            return False
        self.send_response(302)
        self.send_header('Location', '/app/' + ('?' + parsed.query if parsed.query else ''))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', '0')
        self.end_headers()
        return True

    def _work_hub_local(self):
        host=self.headers.get('Host','')
        origin=self.headers.get('Origin','')
        return (bool(re.fullmatch(r'(?:localhost|127\.0\.0\.1)(?::\d+)?',host))
                and (not origin or bool(re.fullmatch(r'https?://(?:localhost|127\.0\.0\.1)(?::\d+)?',origin))))

    def _work_hub_write_allowed(self):
        if not self._work_hub_local():return False
        origin=self.headers.get('Origin','')
        host=self.headers.get('Host','')
        token=os.environ.get('KB_WORK_HUB_AGENT_TOKEN','')
        return origin=='http://'+host or (not origin and bool(token) and self.headers.get('X-Work-Hub-Agent-Key','')==token)

    def work_hub_restore_post(self, route):
        if not self._work_hub_write_allowed():
            self._send_json(403,{'ok':False,'error':'Localhost only'});return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=45_000_000:
                self._send_json(413,{'ok':False,'error':'Snapshot too large'});return
            payload=json.loads(self.rfile.read(length))
            if not isinstance(payload,dict):raise ValueError('Invalid request')
            raw=base64.b64decode(payload['snapshot'],validate=True)
            if route=='preview':
                result=work_hub_ops.preview_merge(raw)
            else:
                if payload.get('confirm')!='APPLY_SELECTED_RESTORE':raise ValueError('Explicit confirmation required')
                if hashlib.sha256(raw).hexdigest()!=payload.get('sha256'):raise ValueError('Archive changed since preview')
                result=work_hub_ops.apply_merge(raw,payload['ids'],payload['expected'])
            self._send_json(200,{'ok':True,'data':result})
        except work_hub_store.Conflict as exc:self._send_json(409,{'ok':False,'error':str(exc)})
        except (ValueError,KeyError,TypeError,zipfile.BadZipFile,binascii.Error) as exc:self._send_json(400,{'ok':False,'error':str(exc)})
        except (OSError,sqlite3.DatabaseError):self._send_json(500,{'ok':False,'error':'Restore operation failed'})

    def work_hub_note_image_post(self):
        if not self._work_hub_write_allowed():
            self._send_json(403,{'ok':False,'error':'Local write access required'});return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if length<=0 or length>work_hub_notes.MAX_IMAGE:
                self._send_json(413,{'ok':False,'error':'Clipboard image exceeds 8 MB'});return
            task_id=(parse_qs(urlsplit(self.path).query).get('taskId') or [''])[0]
            mime=self.headers.get('Content-Type','').split(';',1)[0].strip().lower()
            payload=self.rfile.read(length)
            if len(payload)!=length:raise ValueError('Incomplete image upload')
            data=work_hub_notes.upload_image(task_id,payload,mime)
            self._send_json(200,{'ok':True,'data':data})
        except work_hub_store.NotFound as exc:self._send_json(404,{'ok':False,'error':str(exc)})
        except (ValueError,TypeError) as exc:self._send_json(400,{'ok':False,'error':str(exc)})
        except (OSError,sqlite3.DatabaseError):self._send_json(500,{'ok':False,'error':'Note image could not be saved'})

    def work_folder_open_post(self):
        """Explicit click opens an approved L1 folder on this local WSL Windows host."""
        if not self._work_hub_write_allowed():
            self._send_json(403, {'ok': False, 'error': 'Local same-origin access required'});return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 2048 or self.headers.get('Content-Type', '').split(';', 1)[0] != 'application/json':
                raise ValueError('Invalid folder request')
            request = json.loads(self.rfile.read(size))
            if not isinstance(request, dict) or set(request) != {'id', 'shortcutId'}:
                raise ValueError('Invalid folder request')
            if not isinstance(request['id'], str) or len(request['id']) > 128:
                raise ValueError('Invalid Work item')
            # Resolve from the live read-only node view; never accept a raw path
            # from the caller, and never read or upload any directory contents.
            node = work_hub_nodes.node_view(id=request['id'])
            result = work_shortcuts.open_local_folder(node, request['shortcutId'])
            self._send_json(200, {'ok': True, 'data': result})
        except work_hub_nodes.NodeNotFound:
            self._send_json(404, {'ok': False, 'error': 'Work item not found'})
        except FileNotFoundError:
            self._send_json(404, {'ok': False, 'error': 'Folder not available on this Windows / WSL host'})
        except NotImplementedError:
            self._send_json(501, {'ok': False, 'error': 'Native Explorer is unavailable on this host; copy path instead'})
        except (ValueError, TypeError, KeyError):
            self._send_json(400, {'ok': False, 'error': 'Invalid or unregistered folder shortcut'})
        except (OSError, subprocess.SubprocessError):
            self._send_json(500, {'ok': False, 'error': 'Could not request Windows File Explorer'})

    def work_hub_post(self):
        if not self._work_hub_write_allowed():
            self._send_json(403,{'ok':False,'error':'Localhost only'});return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if length<=0 or length>27_000_000:
                self._send_json(413,{'ok':False,'error':'Invalid payload length'});return
            payload=json.loads(self.rfile.read(length))
            if not isinstance(payload,dict):raise ValueError('Invalid payload')
            action=payload.get('action','save')
            if work_hub_api.is_large_action(action):
                if length>work_hub_api.LARGE_BODY_LIMIT:
                    self._send_json(413,{'ok':False,'error':'Payload too large','code':'payload_too_large'},nosniff=True);return
            elif action!='media-upload' and length>300000:raise ValueError('Request too large')
            if work_hub_api.is_action(action) or work_hub_api.is_large_action(action):
                self._work_hub_v2('POST',{},payload);return
            if action=='save':
                data=work_hub_store.save_record(payload.get('record'),actor='manual',source='local-ui')
            elif action=='lifecycle':
                data=work_hub_store.set_lifecycle(payload['id'],payload['revision'],payload['operation'])
            elif action=='link':
                data=work_hub_store.link_records(payload['source_id'],payload['target_id'],payload.get('relation','related'))
            elif action=='unlink':
                data=work_hub_store.unlink_records(payload['source_id'],payload['target_id'],payload.get('relation','related'))
            elif action in ('ai-suggest','propose','review'):
                self._send_json(410,{'ok':False,'error':'Work Hub AI proposals are disabled'});return
            elif action=='media-upload':
                file_info=work_hub_ops.save_media(payload['fileName'],payload['contentBase64'])
                data=work_hub_store.save_record({'kind':'material','title':file_info['fileName'],'status':'Planned','data':file_info})
                if file_info.get('fileId'):
                    file_hub.register_work_media(file_info['mediaId'],file_info['fileName'],
                         work_hub_ops.read_media(file_info['mediaId']),material_id=data['id'])
            elif action=='guide-draft':
                data=work_hub_ops.guide_draft(payload['text'])
            elif action=='guide-publish':
                data=work_hub_ops.guide_publish(payload['expected_sha'])
            else:raise ValueError('Unknown action')
            self._send_json(200,{'ok':True,'data':data})
        except work_hub_store.Conflict as exc:self._send_json(409,{'ok':False,'error':str(exc)})
        except work_hub_store.NotFound as exc:self._send_json(404,{'ok':False,'error':str(exc)})
        except (ValueError,KeyError,TypeError,UnicodeError,binascii.Error) as exc:self._send_json(400,{'ok':False,'error':str(exc)})
        except (OSError,sqlite3.DatabaseError):self._send_json(500,{'ok':False,'error':'Work data could not be saved'})

    def file_reveal_post(self, native=False):
        if not self._work_hub_write_allowed():
            self._send_json(403,{'ok':False,'error':'Trusted local UI required'});return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=256 or self.headers.get('Content-Type','').split(';',1)[0]!='application/json':
                raise ValueError('Invalid reveal request')
            request=json.loads(self.rfile.read(length))
            if not isinstance(request,dict) or set(request)!={'fileId'}:
                raise ValueError('Expected stable File ID only')
            result=(work_file_open.open_native(request['fileId']) if native
                    else work_file_open.reveal(request['fileId']))
            self._send_json(200,{'ok':True,'data':result})
        except NotImplementedError as exc:
            self._send_json(501,{'ok':False,'error':str(exc)})
        except (file_hub.Missing,FileNotFoundError) as exc:
            self._send_json(404,{'ok':False,'error':str(exc)})
        except (ValueError,KeyError,TypeError) as exc:
            self._send_json(400,{'ok':False,'error':str(exc)})
        except (OSError,subprocess.SubprocessError):
            self._send_json(500,{'ok':False,'error':'Local Explorer could not be requested'})

    def file_hub_post(self, upload=False):
        if not self._work_hub_write_allowed():
            self._send_json(403,{'ok':False,'error':'Local write access required'});return
        # Allow creation of entirely NEW Materials, never replace/update existing bytes.
        # Existing File ID editing/revision uploads remain forbidden in the browser.
        if upload:
            q=parse_qs(urlsplit(self.path).query)
            node_upload = set(q) == {'nodeId', 'name'} and len(q.get('nodeId', [])) == 1
            note_upload = set(q) == {'notePageId', 'operationId', 'name'} and len(q.get('notePageId', [])) == 1
            legacy_upload = (set(q) == {'folder', 'name'} and
                             q.get('folder') == ['Projects/WorkHub/Materials'])
            if not (node_upload or legacy_upload or note_upload) or len(q.get('name',[])) != 1:
                self._send_json(403,{'ok':False,'error':'Only new Work Materials or Page attachment uploads are allowed.'});return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if upload:
                if not 0<length<=file_hub.MAX_FILE:
                    self._send_json(413,{'ok':False,'error':'Upload exceeds 100MB limit'});return
                q=parse_qs(urlsplit(self.path).query)
                if 'notePageId' in q:
                    import work_notebook_v35 as notebook_v35
                    from work_hub_nodes import _reader
                    pid=q['notePageId'][0]
                    operation=q['operationId'][0]
                    if not re.fullmatch(r'[a-zA-Z0-9_-]{8,80}',operation):
                        raise ValueError('Invalid attachment upload operation ID')
                    # Validate Page before any new file is created.
                    # The reader requires an explicit path; None uses the Work DB.
                    with _reader(None) as con:
                        if not notebook_v35.ready(con):raise ValueError('Notes V3.5 migration required')
                        pg=notebook_v35.nb._page(con,pid)
                        notebook_v35.nb._node(con,pg['owner_id'])
                    for folder_part in ('Projects/WorkHub','Projects/WorkHub/Notes',
                                        'Projects/WorkHub/Notes/Attachments'):
                        try:file_hub.folder_create(folder_part)
                        except file_hub.Conflict as exc:
                            if str(exc)!='Folder exists':raise
                    folder='Projects/WorkHub/Notes/Attachments'
                elif 'nodeId' in q:
                    location=work_material_storage.ensure_for_node(q['nodeId'][0])
                    folder=location['folder']
                else:
                    folder='Projects/WorkHub/Materials'  # Compatibility with an older cached Work UI.
                name=(q.get('name') or [''])[0]
                raw=self.rfile.read(length)
                if len(raw)!=length:raise ValueError('Incomplete upload')
                if 'notePageId' in q:
                    safe_name=re.sub(r'[^\w .()+-]', '_', Path(name).name)[:120]
                    if not safe_name or safe_name.startswith('.'):
                        raise ValueError('Invalid attachment name')
                    with _reader(None) as con:
                        existing=con.execute('SELECT page_id,file_id FROM work_note_v35_staging '
                                             'WHERE operation_id=?',(operation,)).fetchone()
                    if existing:
                        if existing['page_id']!=pid:
                            raise file_hub.Conflict('Upload operation ID belongs to another Page')
                        prior=file_hub.details(existing['file_id'])
                        if prior['deleted'] or prior['sha']!=hashlib.sha256(raw).hexdigest():
                            raise file_hub.Conflict('Upload operation replay contains different bytes')
                        self._send_json(200,{'ok':True,'data':{'id':prior['id'],
                            'fileId':prior['id'],'operationId':operation,'status':'staged',
                            'name':safe_name}})
                        return
                    name=operation+'_'+safe_name
                data=file_hub.upload(folder,name,raw)
                if 'notePageId' in q:
                    data.update(notebook_v35.attach_upload(pid,data['id'],operation))
            else:
                if not 0<length<=3_000_000:raise ValueError('Invalid request length')
                payload=json.loads(self.rfile.read(length))
                if not isinstance(payload,dict):raise ValueError('Invalid request')
                if payload.get('action') not in ('link','unlink','tags','rename-tag'):
                    self._send_json(403,{'ok':False,'error':'File content management is read-only in the web UI. Modify the canonical file in its Work storage folder.'});return
                data=file_hub.act(payload)
            self._send_json(200,{'ok':True,'data':data})
        except file_hub.Conflict as exc:self._send_json(409,{'ok':False,'error':str(exc)})
        except file_hub.Missing as exc:self._send_json(404,{'ok':False,'error':str(exc)})
        except (ValueError,KeyError,TypeError,UnicodeError) as exc:self._send_json(400,{'ok':False,'error':str(exc)})
        except (OSError,sqlite3.DatabaseError):
            self._send_json(500,{'ok':False,'error':'File Hub operation failed'})

    def file_bulk_download_get(self, query):
        """Bounded, read-only ZIP from stable File Hub IDs, never arbitrary paths."""
        if not self._work_hub_local():
            self._send_json(403, {'ok': False, 'error': 'Localhost only'}); return
        try:
            raw_items = (query.get('items') or query.get('ids') or [''])[0].split(',')
            if not 1 <= len(raw_items) <= 30 or len(set(raw_items)) != len(raw_items):
                raise ValueError('Provide 1-30 distinct File Hub references')
            sources = []
            total = 0
            for item in raw_items:
                fid, sep, raw_rev = item.partition('@')
                if not re.fullmatch(r'file_[a-f0-9]{32}', fid) or (sep and not raw_rev.isdigit()):
                    raise ValueError('Invalid stable File Hub reference')
                revision = int(raw_rev) if sep else None
                path, name = file_hub.content(fid, revision)
                total += path.stat().st_size
                if total > 200 * 1024 * 1024:
                    self._send_json(413, {'ok': False, 'error': 'Selection exceeds 200 MB'}); return
                sources.append((fid, path, name, revision))
            with tempfile.TemporaryFile() as output:
                with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                    for fid, path, name, revision in sources:
                        # Stable ID and evidence revision prevent collisions and zip slip.
                        safe = re.sub(r'[^\w .()-]', '_', Path(name).name)[:140] or 'file'
                        suffix = f'_R{revision}' if revision is not None else ''
                        archive.write(path, arcname=f'{fid[:22]}{suffix}_{safe}')
                length = output.tell()
                output.seek(0)
                self.send_response(200)
                self.send_header('Content-Type', 'application/zip')
                self.send_header('Content-Disposition', 'attachment; filename="KB_Work_Materials.zip"')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(length))
                self.end_headers()
                while True:
                    block = output.read(1024 * 1024)
                    if not block: break
                    self.wfile.write(block)
        except file_hub.Missing as exc:
            self._send_json(404, {'ok': False, 'error': str(exc)})
        except (ValueError, OSError) as exc:
            self._send_json(400, {'ok': False, 'error': str(exc)})

    def file_hub_get(self,path,query):
        if not self._work_hub_local():
            self._send_json(403,{'ok':False,'error':'Localhost only'});return
        try:
            if path=='/api/file-hub':
                data=file_hub.listing((query.get('folder') or [''])[0],
                      (query.get('q') or [''])[0],query.get('trash')==['1'])
                self._send_json(200,{'ok':True,'data':data});return
            if path=='/api/file-hub/linked':
                data=file_hub.linked_context((query.get('type') or [''])[0],(query.get('id') or [''])[0])
                self._send_json(200,{'ok':True,'data':data});return
            if path=='/api/file-hub/health':
                data=file_hub.storage_health()
                self._send_json(200,{'ok':True,'data':data});return
            if path=='/api/file-hub/migration-preview':
                data=file_hub.migration_preview()
                self._send_json(200,{'ok':True,'data':data});return
            if path=='/api/file-hub/lookup':
                data=file_hub.lookup_legacy_source((query.get('source') or [''])[0])
                self._send_json(200,{'ok':True,'data':data});return
            if path=='/api/file-hub/candidates':
                name=(query.get('name') or [''])[0]
                ids=(query.get('ids') or [''])[0].split(',')
                data=file_hub.version_candidates(name,[x for x in ids if x])
                self._send_json(200,{'ok':True,'data':data});return
            if path=='/api/file-hub/office/status':
                data=office_preview.status((query.get('id') or [''])[0])
                self._send_json(200,{'ok':True,'data':data});return
            if path=='/api/file-hub/office/sheet':
                fid=(query.get('id') or [''])[0]
                index=int((query.get('index') or ['0'])[0])
                start=int((query.get('start') or ['0'])[0])
                limit=int((query.get('limit') or ['100'])[0])
                data=office_preview.sheet(fid,index,start,limit)
                self._send_json(200,{'ok':True,'data':data});return
            if path=='/api/file-hub/office/pdf':
                fid=(query.get('id') or [''])[0]
                rendered=office_preview.pdf(fid)
                self.send_response(200)
                self.send_header('Content-Type','application/pdf')
                self.send_header('Content-Disposition','inline')
                self.send_header('X-Content-Type-Options','nosniff')
                self.send_header('Cache-Control','private, no-store')
                self.send_header('Content-Length',str(rendered.stat().st_size))
                self.end_headers()
                with rendered.open('rb') as inp:
                    import shutil
                    shutil.copyfileobj(inp,self.wfile,1024*1024)
                return
            if path=='/api/file-hub/extracted':
                data=file_hub.extracted_text((query.get('id') or [''])[0])
                self._send_json(200,{'ok':True,'data':data});return
            if path=='/api/file-hub/detail':
                data=file_hub.details((query.get('id') or [''])[0])
                self._send_json(200,{'ok':True,'data':data});return
            if path=='/api/file-hub/file':
                fid=(query.get('id') or [''])[0]
                rev=(query.get('revision') or [None])[0]
                file,name=file_hub.content(fid,rev)
                extension=Path(name).suffix.lower()
                mode=(query.get('mode') or ['download'])[0]
                if mode=='text':
                    if extension not in ('.md','.txt','.html','.csv','.json','.py','.js','.css','.svg') or file.stat().st_size>2_000_000:
                        raise ValueError('Text preview unavailable for this file')
                    self._send_json(200,{'ok':True,'data':{'name':name,'text':file.read_text(encoding='utf-8',errors='replace')}})
                    return
                if mode=='preview-text':
                    # Preview_Drawer text mode (design 4.11): Markdown/plain text up to 10 MiB.
                    if extension not in ('.md','.markdown','.txt') or file.stat().st_size>10*1024*1024:
                        raise ValueError('Text preview unavailable for this file')
                    self._send_json(200,{'ok':True,'data':{'name':name,'text':file.read_text(encoding='utf-8',errors='replace')}})
                    return
                if mode=='safe-html' and extension!='.html':
                    raise ValueError('Safe HTML preview unavailable for this file')
                mime,_=mimetypes.guess_type(name)
                isolated_html=mode=='html' and extension=='.html'
                safe_html=mode=='safe-html'
                inline=(mode=='inline' and extension in ('.pdf','.png','.jpg','.jpeg','.webp','.gif','.svg')) or isolated_html or safe_html
                self.send_response(200)
                self.send_header('Content-Type',('text/html; charset=utf-8' if (isolated_html or safe_html) else mime) if inline else 'application/octet-stream')
                self.send_header('X-Content-Type-Options','nosniff')
                if isolated_html:self.send_header('Content-Security-Policy',
                    "sandbox allow-scripts; default-src 'none'; "
                    "script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data: blob:; "
                    "img-src data: blob:; font-src data:; media-src data: blob:; "
                    "connect-src 'none'; form-action 'none'; object-src 'none'; "
                    "base-uri 'none'; frame-src 'none'")
                if safe_html:self.send_header('Content-Security-Policy',"sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:")
                # Preserve ASCII/Unicode filenames; replace only control and header-unsafe characters.
                safe=''.join(ch if ord(ch)>=32 and ord(ch)!=127 and ch not in '\";' else '_' for ch in name)[:180]
                disposition = 'inline' if inline else 'attachment'
                self.send_header('Content-Disposition', f"{disposition}; filename=\"file\"; filename*=UTF-8''{quote(safe)}")
                self.send_header('Content-Length',str(file.stat().st_size))
                self.send_header('Cache-Control','no-store')
                self.end_headers()
                with file.open('rb') as stream:
                    for part in iter(lambda:stream.read(1024*1024),b''):
                        self.wfile.write(part)
                return
            self._send_json(404,{'ok':False,'error':'Unknown File Hub route'})
        except office_preview.PreviewUnavailable as exc:self._send_json(422,{'ok':False,'error':str(exc)})
        except file_hub.Missing as exc:self._send_json(404,{'ok':False,'error':str(exc)})
        except (ValueError,TypeError) as exc:self._send_json(400,{'ok':False,'error':str(exc)})
        except (OSError,sqlite3.DatabaseError):self._send_json(500,{'ok':False,'error':'File Hub unavailable'})

    def work_resources_get(self, query):
        if not self._work_hub_local():
            self._send_json(403,{'ok':False,'code':'forbidden'},nosniff=True)
            return
        try:
            result=work_resource_api.handle('GET',parse_qs(query))
            self._send_json(200,{'ok':True,'data':result},nosniff=True)
        except (ValueError,TypeError,KeyError) as exc:
            status,payload=work_resource_api.error(exc)
            self._send_json(status,payload,nosniff=True)
        except (OSError,sqlite3.DatabaseError):
            self._send_json(503,{'ok':False,'code':'local_registry_unavailable'},nosniff=True)

    def work_resources_post(self):
        if not self._work_hub_write_allowed():
            self._send_json(403,{'ok':False,'code':'forbidden'},nosniff=True)
            return
        try:
            length=int(self.headers.get('Content-Length','0'))
            content_type=self.headers.get('Content-Type','').split(';',1)[0].strip()
            if not 0<length<=23_000_000 or content_type!='application/json':
                self._send_json(413,{'ok':False,'code':'invalid_request_size'},nosniff=True)
                return
            payload=json.loads(self.rfile.read(length))
            result=work_resource_api.handle('POST',{},payload)
            self._send_json(200,{'ok':True,'data':result},nosniff=True)
        except (ValueError,TypeError,KeyError,UnicodeError) as exc:
            status,data=work_resource_api.error(exc)
            self._send_json(status,data,nosniff=True)
        except (OSError,sqlite3.DatabaseError):
            self._send_json(503,{'ok':False,'code':'local_registry_unavailable'},nosniff=True)

    def do_GET(self):
        parsed=urlsplit(self.path)
        request_path=parsed.path
        if request_path.startswith('/local/v1/'):
            # The only V1.1 Local Agent routes available before approved
            # pairing are non-sensitive, read-only protocol metadata.
            # No cross-origin CORS headers: a central webpage cannot use
            # these routes to read local Work content.
            if not self._work_hub_local():
                self._send_json(403,{'ok':False,'code':'forbidden'},nosniff=True)
            elif request_path == '/local/v1/capabilities':
                self._send_json(200,{'ok':True,'data':work_portal_protocol.capabilities()},nosniff=True)
            elif request_path == '/local/v1/release/status':
                self._send_json(200,{'ok':True,'data':work_portal_protocol.release_status()},nosniff=True)
            else:
                self._send_json(404,{'ok':False,'code':'endpoint_not_enabled'},nosniff=True)
            return
        if not site_boundary.api_allowed(request_path):
            self._send_json(404,{'ok':False,'error':'Unavailable in Work workspace'})
            return
        if self._root_redirect():
            return
        if self._app_route():
            return
        if request_path in ('/data/index.json','/data/review-index.json'):
            base=Path(os.environ['KB_WORK_DATA_ROOT']) if os.environ.get('KB_WORK_DATA_ROOT') else ROOT
            source=base/('data/index.json' if request_path.endswith('/index.json') else 'data/review-index.json')
            fn=site_boundary.filtered_index if request_path.endswith('/index.json') else site_boundary.filtered_review_index
            # A new external instance does not inherit any source-checkout
            # private metadata from the user's older standalone environment.
            if not source.is_file():
                self._send_json(404,{'ok':False,'code':'instance_metadata_missing'},nosniff=True)
            else:
                self._send_json(200,fn(json.loads(source.read_text(encoding='utf-8'))),nosniff=True)
            return
        if request_path == '/data/project-skills.json' and os.environ.get('KB_WORK_DATA_ROOT'):
            if not self._work_hub_local():
                self._send_json(403,{'ok':False,'code':'forbidden'},nosniff=True)
            else:
                import project_skills
                try:
                    self._send_json(200,project_skills.dashboard_catalog(),nosniff=True)
                except (ValueError,OSError):
                    self._send_json(503,{'ok':False,'code':'local_skill_catalog_unavailable'},nosniff=True)
            return
        if request_path == '/api/resources/v1/export':
            if not self._work_hub_local():
                self._send_json(403,{'ok':False,'code':'forbidden'},nosniff=True);return
            try:
                version_id=(parse_qs(parsed.query).get('versionId') or [''])[0]
                payload=work_resources.export_zip(version_id)
                self.send_response(200)
                self.send_header('Content-Type','application/zip')
                self.send_header('X-Content-Type-Options','nosniff')
                self.send_header('Content-Disposition','attachment; filename="ai-resource-version.zip"')
                self.send_header('Cache-Control','no-store')
                self.send_header('Content-Length',str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except work_resources.ResourceError as exc:
                self._send_json(exc.status,{'ok':False,'code':exc.code},nosniff=True)
            except (OSError,sqlite3.DatabaseError):
                self._send_json(503,{'ok':False,'code':'local_registry_unavailable'},nosniff=True)
            return
        if request_path == '/api/resources/v1':
            self.work_resources_get(parsed.query)
            return
        if request_path == '/api/file-hub/bulk-download':
            self.file_bulk_download_get(parse_qs(parsed.query))
            return
        if request_path.startswith('/api/file-hub'):
            self.file_hub_get(request_path,parse_qs(parsed.query))
            return
        if request_path == '/api/work-hub/provider-keys':
            if not self._work_hub_local():
                self._send_json(403,{'ok':False,'code':'forbidden','error':'Localhost only'},nosniff=True);return
            try:
                self._send_json(200,{'ok':True,'data':{'saved':work_provider_vault.statuses()}},nosniff=True)
            except (OSError,ValueError,RuntimeError):
                self._send_json(503,{'ok':False,'code':'vault_unavailable','error':'Local provider vault unavailable'},nosniff=True)
            return
        if request_path=='/api/server-info':
            if not self._work_hub_local():
                self._send_json(403,{'ok':False,'error':'Localhost only'});return
            instance=SERVER_INSTANCE or {}
            self._send_json(200,{'ok':True,'profile':'work','data':{
                'workspace':'KB_WORK_STANDALONE_V1',
                'pid':instance.get('pid',os.getpid()),
                'port':instance.get('port'),
                'root':instance.get('root'),
                'token':instance.get('token')}})
            return
        if request_path.startswith('/api/work-hub/media/'):
            if not self._work_hub_local():self._send_json(403,{'ok':False,'error':'Localhost only'});return
            media_id=request_path.rsplit('/',1)[-1]
            try:
                records=work_hub_store.list_records(kind='material')
                found=next((r for r in records if r['data'].get('mediaId')==media_id),None)
                if not found:raise FileNotFoundError('Media unavailable')
                body=work_hub_ops.read_media(media_id)
                if hashlib.sha256(body).hexdigest()!=found['data'].get('sha256'):raise ValueError('Media verification failed')
                self.send_response(200)
                self.send_header('Content-Type','application/octet-stream')
                self.send_header('X-Content-Type-Options','nosniff')
                # Preserve a safe original filename for Work Hub attachment downloads.
                # Keep a fixed ASCII fallback and encode non-ASCII names for browsers.
                supplied=found['data'].get('fileName') or 'work-hub-attachment'
                safe_name=Path(str(supplied).replace('\\','/')).name
                safe_name=re.sub(r'[\x00-\x1f\x7f";]','_',safe_name)[:180] or 'work-hub-attachment'
                self.send_header('Content-Disposition',
                                 'attachment; filename="work-hub-attachment"; filename*=UTF-8\'\''+quote(safe_name))
                self.send_header('Cache-Control','no-store')
                self.send_header('Content-Length',str(len(body)))
                self.end_headers();self.wfile.write(body)
            except (ValueError,OSError):self._send_json(404,{'ok':False,'error':'Media unavailable'})
            return
        if request_path == '/api/work-hub/export':
            if not self._work_hub_local():self._send_json(403,{'ok':False,'error':'Localhost only'});return
            try:
                blob=work_hub_ops.export_bytes()
                self.send_response(200)
                self.send_header('Content-Type','application/zip')
                self.send_header('Content-Disposition','attachment; filename="work-hub-snapshot.zip"')
                self.send_header('Content-Length',str(len(blob)))
                self.send_header('Cache-Control','no-store')
                self.end_headers()
                self.wfile.write(blob)
            except ValueError as exc:self._send_json(409,{'ok':False,'error':str(exc)})
            except (OSError,sqlite3.DatabaseError):self._send_json(500,{'ok':False,'error':'Work Hub export failed'})
            return
        if request_path.startswith('/api/work-hub/agent/'):
            if not self._work_hub_local():
                self._send_json(403,{'ok':False,'error':'Localhost only','code':'forbidden'},nosniff=True);return
            self._work_hub_v2('GET',parse_qs(parsed.query));return
        if request_path == '/api/work-hub':
            if not self._work_hub_local():
                self._send_json(403,{'ok':False,'error':'Localhost only'});return
            view=(parse_qs(parsed.query).get('view') or [None])[0]
            if work_hub_api.is_view(view):
                self._work_hub_v2('GET',parse_qs(parsed.query));return
            try:
                # Legacy compatibility GET must be read-only. A fresh colleague
                # Fresh checkouts must never auto-create any prior user project.
                query=parse_qs(parsed.query)
                rid=(query.get('id') or [None])[0]
                if query.get('view')==['proposals']:
                    self._send_json(410,{'ok':False,'error':'Work Hub AI proposals are disabled'});return
                elif query.get('view')==['context']:
                    if not rid:raise ValueError('Missing target ID')
                    data=work_hub_ops.context(rid)
                elif query.get('view')==['guide']:
                    data=work_hub_ops.guide_read()
                elif query.get('view')==['consistency']:
                    data=work_hub_ops.scan_consistency()
                elif rid:
                    data=work_hub_store.get_record(rid)
                    data['history']=work_hub_store.history(rid)
                    data['links']=work_hub_store.list_links(rid)
                else:
                    data=work_hub_store.list_records(kind=(query.get('kind') or [None])[0],include_deleted=(query.get('include_deleted')==['1']))
                self._send_json(200,{'ok':True,'data':data})
            except work_hub_store.NotFound as exc:self._send_json(404,{'ok':False,'error':str(exc)})
            except ValueError as exc:self._send_json(400,{'ok':False,'error':str(exc)})
            except (OSError,sqlite3.DatabaseError):self._send_json(500,{'ok':False,'error':'Work data unavailable'})
            return

        return super().do_GET()

    def do_POST(self):
        request_path=urlsplit(self.path).path
        if not site_boundary.api_allowed(request_path):
            self._send_json(404,{'ok':False,'error':'Unavailable in Work workspace'})
            return
        if request_path == '/api/resources/v1':
            self.work_resources_post()
        elif request_path == '/api/work-hub/provider-keys':
            self.work_provider_keys_post()
        elif request_path == '/api/work-hub/open-folder':
            self.work_folder_open_post()
        elif request_path == '/api/work-hub/note-image':
            self.work_hub_note_image_post()
        elif request_path.startswith('/api/work-hub/agent/'):
            self.work_hub_agent_post()
        elif request_path == '/api/file-hub/open-location':
            self.file_reveal_post()
        elif request_path == '/api/file-hub/open-native':
            self.file_reveal_post(native=True)
        elif request_path in ('/api/file-hub','/api/file-hub/upload'):
            self.file_hub_post(upload=request_path.endswith('/upload'))
        elif request_path in ('/api/work-hub/preview','/api/work-hub/apply'):
            self.work_hub_restore_post(request_path.rsplit('/',1)[-1])
        elif request_path == '/api/work-hub':
            self.work_hub_post()
        else:
            self._send_json(404,{'ok':False,'error':'Unknown Work API endpoint'})

    def do_HEAD(self):
        if not site_boundary.static_allowed(self.path):
            self.send_error(403,'Work-only static boundary')
            return
        if self._root_redirect():
            return
        if self._app_route(head_only=True):
            return
        return super().do_HEAD()


    def send_head(self):
        path = Path(self.translate_path(self.path))
        try:
            parts = path.resolve().relative_to(ROOT.resolve()).parts
        except ValueError:
            self.send_error(403, "Outside published root")
            return None
        if ((site_boundary.PROFILE != 'combined' and not site_boundary.static_allowed(self.path))
            or any(part.startswith('.') or part in {"node_modules", "__pycache__"} for part in parts)
            or (parts and parts[0] in {"content", "library"})
            or (os.environ.get('KB_WORK_DATA_ROOT') and parts and parts[0]=='data')):
            self.send_error(403, "Private maintenance files")
            return None
        self._byte_range = None
        if path.suffix.lower() != ".mp4" or not path.is_file():
            return super().send_head()
        try:
            stream = path.open("rb")
        except OSError:
            self.send_error(404, "Video not found")
            return None
        size = os.fstat(stream.fileno()).st_size
        start, end = 0, size - 1
        range_header = self.headers.get("Range")
        if range_header:
            try:
                if not range_header.startswith("bytes=") or "," in range_header:
                    raise ValueError
                left, right = range_header[6:].split("-", 1)
                if not left:
                    count = int(right)
                    if count <= 0:
                        raise ValueError
                    start = max(0, size - count)
                else:
                    start = int(left)
                    if right:
                        end = min(size - 1, int(right))
                if start < 0 or start >= size or end < start:
                    raise ValueError
            except (ValueError, OverflowError):
                stream.close()
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
            self._byte_range = (start, end)
        self.send_response(206 if range_header else 200)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Last-Modified", self.date_time_string(os.fstat(stream.fileno()).st_mtime))
        if range_header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        stream.seek(start)
        return stream

    def copyfile(self, source, outputfile):
        if self._byte_range is None:
            return super().copyfile(source, outputfile)
        remaining = self._byte_range[1] - self._byte_range[0] + 1
        while remaining:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            try:
                outputfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                # Browsers commonly cancel an in-flight byte-range request once
                # they have enough buffered media or start a new seek request.
                # This is normal for HTML5 video and should not print a traceback.
                break
            remaining -= len(chunk)

def _notes_v35_maintenance(stop):
    """Local-only, bounded retry for structured Notes projection/File Hub outboxes."""
    import work_notebook_v35
    while not stop.is_set():
        try:work_notebook_v35.reconcile_pending(limit=30)
        except (OSError,sqlite3.Error,ValueError):pass
        stop.wait(30)


def main():
    global SERVER_INSTANCE
    site_boundary.validate_isolated_runtime()
    parser = argparse.ArgumentParser(description="启动本地知识库")
    parser.add_argument("port", nargs="?", type=int, default=8001)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1 到 65535 之间")
    handler = functools.partial(VideoRangeHandler, directory=str(ROOT))
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    except OSError as exc:
        raise SystemExit(
            f"端口 {args.port} 已被占用。若知识库已打开，请继续使用 "
            f"http://localhost:{args.port}/；否则运行 ./stop.sh {args.port} 关闭旧服务，或指定其他端口启动。"
        ) from exc
    url = f"http://localhost:{server.server_port}/"
    SERVER_INSTANCE = write_server_pid(server.server_port)
    file_hub_stop = file_hub.start_watcher()
    notes_maintenance_stop=threading.Event()
    threading.Thread(target=_notes_v35_maintenance,args=(notes_maintenance_stop,),
                     name='kbw-notes-v35-outbox',daemon=True).start()
    print(f"知识库已启动：{url}", flush=True)
    print("按 Ctrl+C 停止；若终端已关闭，可在项目目录运行 ./stop.sh。", flush=True)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        notes_maintenance_stop.set()
        file_hub_stop.set()
        server.server_close()
        remove_server_pid(SERVER_INSTANCE)

if __name__=='__main__':
    main()
