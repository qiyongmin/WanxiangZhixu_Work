"""Notes V3.5 tests: isolated Work databases only; no live company writes."""
import sys
import tempfile
import unittest
import io
import json
from types import SimpleNamespace
from urllib.parse import urlencode
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent))
import work_v2_common as common
import work_notebook as nb
import work_notebook_v34 as v34
import work_notebook_v35 as v35
import file_hub
from work_v2_common import query, nodes

def setUpModule():
    common.module_setup()

def tearDownModule():
    common.module_teardown()

def doc():
    return {"type":"doc","content":[
        {"type":"paragraph","content":[{"type":"text","text":"Legacy old content"}]},
        {"type":"heading","attrs":{"level":1,"blockId":"blk_abcd1234"},
         "content":[{"type":"text","text":"Platform synergy"}]},
        {"type":"paragraph","content":[{"type":"text","text":"Shared API can be reused",
          "marks":[{"type":"bold"}]}]},
        {"type":"heading","attrs":{"level":3,"blockId":"blk_abcd5678"},
         "content":[{"type":"text","text":"Dependency"}]},
        {"type":"paragraph","content":[{"type":"text","text":"Follow-up needed"}]},
    ]}

class NotesV35(common.V2Base):
    def init(self):
        nb.migrate(path=self.db)
        v34.migrate(path=self.db)
        return v35.migrate(path=self.db)
    def page(self):
        return nb.page_action({"action":"notebook-page-create","id":"ws",
            "title":"Meeting record","html":"<p>Legacy old content</p>"},path=self.db)["page"]

    def test_migration_idempotent_and_preserves_v34(self):
        self.assertTrue(self.init()["changed"])
        self.assertFalse(v35.migrate(path=self.db)["changed"])
        self.assertTrue(v34.ready(common.connect(self.db)))
        result=v35.state(self.db)
        self.assertTrue(result["ready"])
        self.assertFalse(result["crossProjectDiscovery"])

    def test_structured_save_projection_revision_history_and_legacy_write_guard(self):
        self.init();p=self.page()
        old=nb.page_view({"id":"ws","page":p["id"]},path=self.db)
        self.assertEqual(old["html"],"<p>Legacy old content</p>")
        result=v35.document_save({"pageId":p["id"],"baseRevision":1,
              "title":"Meeting record","json":doc()},path=self.db)
        self.assertEqual(result["page"]["revision"],2)
        page=nb.page_view({"id":"ws","page":p["id"]},path=self.db)
        self.assertEqual(page["documentJson"],doc())
        self.assertIn("Shared API",page["html"])
        self.assertEqual(v35.page_document({"id":"ws","page":p["id"]},path=self.db)["format"],"json")
        hist=query(self.db,"SELECT revision,html FROM work_note_page_revisions WHERE page_id=? ORDER BY revision",p["id"])
        self.assertEqual(hist[0]["html"],"<p>Legacy old content</p>")
        self.assertEqual(len(hist),2)
        self.assert_rejected(lambda: nb.page_action({"action":"notebook-page-save",
            "pageId":p["id"],"baseRevision":2,"title":"Meeting record",
            "html":"<p>Corrupt overwrite</p>"},path=self.db),
            status=409,code="notebook_v35_upgrade_required")
        self.assert_rejected(lambda: v35.document_save({"pageId":p["id"],"baseRevision":1,
            "title":"Conflict","json":doc()},path=self.db),status=409,code="revision_conflict")

    def test_unknown_node_and_javascript_url_rejected_no_write(self):
        self.init();p=self.page()
        invalid={"type":"doc","content":[{"type":"iframe","attrs":{"src":"https://outside"}}]}
        self.assert_rejected(lambda: v35.document_save({"pageId":p["id"],"baseRevision":1,
            "title":"Unsafe","json":invalid},path=self.db))
        bad=doc()
        bad["content"][1]["content"][0]["marks"]=[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]
        self.assert_rejected(lambda: v35.document_save({"pageId":p["id"],"baseRevision":1,
            "title":"Unsafe","json":bad},path=self.db))

    def test_tiptap_link_title_attributes_save_and_reload(self):
        """Tiptap Link 3.x includes title=None on every newly inserted URL."""
        self.init(); p=self.page()
        rich=doc()
        urls=[
            ("https://example.com/path?x=1&y=2", "External", None),
            ("mailto:team@example.com", "Email", "Contact the team"),
            ("/app/n/ws/notes?page=np_example123", "Work Page", None),
        ]
        for href,label,title in urls:
            rich["content"].append({"type":"paragraph","content":[{
                "type":"text","text":label,"marks":[{"type":"link","attrs":{
                    "href":href,"target":"_blank","rel":"noopener noreferrer",
                    "class":None,"title":title}}]}]})
        result=v35.document_save({"pageId":p["id"],"baseRevision":1,
            "title":p["title"],"json":rich},path=self.db)
        self.assertEqual(result["page"]["revision"],2)
        saved=v35.page_document({"id":"ws","page":p["id"]},path=self.db)
        self.assertEqual(saved["json"],rich)
        for href,label,_ in urls:
            self.assertIn(href.replace('&','&amp;'),saved["html"])
            self.assertIn(label,saved["markdown"])
        self.assertEqual(nb.page_view({"id":"ws","page":p["id"]},path=self.db)["revision"],2)
        for bad_attrs in ({"onclick":"alert(1)"},{"title":42},{"title":"x"*301}):
            invalid=doc()
            invalid["content"].append({"type":"paragraph","content":[{
                "type":"text","text":"Not safe","marks":[{"type":"link","attrs":{
                    "href":"https://example.com","title":None,**bad_attrs}}]}]})
            self.assert_rejected(lambda:v35.document_save({"pageId":p["id"],
                "baseRevision":2,"title":p["title"],"json":invalid},path=self.db))
        self.assertEqual(nb.page_view({"id":"ws","page":p["id"]},path=self.db)["revision"],2)

    def test_table_colors_merges_are_revisioned_and_strictly_validated(self):
        """Semantic backgrounds and merged dimensions survive JSON, HTML and history."""
        import work_hub_html
        self.init();p=self.page()
        cell=lambda kind,text,attrs:{"type":kind,"attrs":attrs,"content":[
            {"type":"paragraph","content":[{"type":"text","text":text}]}]}
        rich={"type":"doc","content":[{"type":"table","content":[
            {"type":"tableRow","attrs":{"height":72},"content":[
                cell("tableHeader","Stage",{"colspan":1,"rowspan":1,"colwidth":[154],
                    "align":None,"background":"blue"}),
                cell("tableHeader","Status",{"colspan":1,"rowspan":1,"colwidth":None,
                    "align":None,"background":"blue"})]},
            {"type":"tableRow","attrs":{"height":116},"content":[
                cell("tableCell","Merged result",{"colspan":2,"rowspan":1,
                    "colwidth":[130,130],"align":"center","background":"amber"})]}
        ]}]}
        # A new structured-only Page can be populated through normal Page CAS after
        # creating a minimal initial legacy record that has no source text to lose.
        pg=nb.page_action({"action":"notebook-page-create","id":"ws",
            "title":"Table-only","html":""},path=self.db)["page"]
        saved=v35.document_save({"pageId":pg["id"],"baseRevision":1,
            "title":"Table-only","json":rich},path=self.db)
        self.assertEqual(saved["page"]["revision"],2)
        detail=v35.page_document({"id":"ws","page":pg["id"]},path=self.db)
        self.assertEqual(detail["json"],rich)
        self.assertIn('data-kbw-bg="blue"',detail["html"])
        self.assertIn('data-kbw-bg="amber"',detail["html"])
        self.assertIn('colspan="2"',detail["html"])
        self.assertIn('data-kbw-row-height="72"',detail["html"])
        self.assertIn('height="116"',detail["html"])
        self.assertIn('colwidth="154"',detail["html"])
        self.assertIn("Merged result",detail["markdown"])
        self.assertEqual(work_hub_html.sanitize_html(detail["html"]),detail["html"])
        self.assertEqual(len(query(self.db,
            "SELECT * FROM work_note_v35_history WHERE page_id=?",pg["id"])),1)
        for field,value in (("background","url(javascript:alert(1))"),
                            ("align","justify"),("colwidth",["9999px"])):
            invalid={"type":"doc","content":[{"type":"table","content":[
                {"type":"tableRow","content":[cell("tableCell","Bad",{field:value})]}]}]}
            self.assert_rejected(lambda:v35.document_save({"pageId":pg["id"],
                "baseRevision":2,"title":"Table-only","json":invalid},path=self.db))
        for bad_height in (True, -1, 801, "80px"):
            invalid={"type":"doc","content":[{"type":"table","content":[
                {"type":"tableRow","attrs":{"height":bad_height},"content":[
                    cell("tableCell","Bad",{})]}]}]}
            self.assert_rejected(lambda:v35.document_save({"pageId":pg["id"],
                "baseRevision":2,"title":"Table-only","json":invalid},path=self.db))
        self.assertEqual(nb.page_view({"id":"ws","page":pg["id"]},
            path=self.db)["revision"],2)
        for unsafe in ('<td data-kbw-bg="javascript:">x</td>',
                       '<td colspan="300">x</td>','<td style="background:red">x</td>',
                       '<tr height="9999"><td>Invalid</td></tr>',
                       '<tr height="70" data-kbw-row-height="71"><td>Mismatch</td></tr>',
                       '<td width="9999" colwidth="9999">x</td>'):
            with self.assertRaises(ValueError):
                work_hub_html.validate_strict("<table><tr>"+unsafe+"</tr></table>")

    def test_table_border_presets_survive_revisions_and_html_security(self):
        """Independent edge presets use JSON CAS and canonical safe HTML only."""
        import work_hub_html
        self.init()
        page=nb.page_action({"action":"notebook-page-create","id":"ws",
            "title":"Border table","html":""},path=self.db)["page"]
        first={"type":"tableHeader","attrs":{
            "colspan":1,"rowspan":1,"colwidth":[130],"background":"blue",
            "borderTop":"solid:3:accent","borderRight":"dashed:2:red",
            "borderBottom":"dotted:1:green","borderLeft":"none"},
            "content":[{"type":"paragraph","content":[{"type":"text","text":"Heading"}]}]}
        other={"type":"tableCell","attrs":{"borderLeft":"dashed:2:red",
            "borderBottom":"double:3:purple"},
            "content":[{"type":"paragraph","content":[{"type":"text","text":"Body"}]}]}
        rich={"type":"doc","content":[{"type":"table","content":[
            {"type":"tableRow","attrs":{"height":64},"content":[first,other]}]}]}
        result=v35.document_save({"pageId":page["id"],"baseRevision":1,
            "title":"Border table","json":rich},path=self.db)
        self.assertEqual(result["page"]["revision"],2)
        detail=v35.page_document({"id":"ws","page":page["id"]},path=self.db)
        self.assertEqual(detail["json"],rich)
        html=detail["html"]
        for side,expected in (("top","solid:3:accent"),("right","dashed:2:red"),
                              ("bottom","dotted:1:green"),("left","none")):
            self.assertIn('data-kbw-border-%s="%s"' % (side,expected),html)
        self.assertEqual(work_hub_html.sanitize_html(html),html)
        work_hub_html.validate_strict(html)
        for invalid in ("dashed:8:accent","solid:1:url(js)", "none;color:blue",
                        "solid:2:#000000", "hidden:2:red", {"width":3}, 14):
            broken={"type":"doc","content":[{"type":"table","content":[
                {"type":"tableRow","content":[{"type":"tableCell","attrs":{
                    "borderRight":invalid},"content":[{"type":"paragraph"}]}]}]}]}
            self.assert_rejected(lambda:v35.document_save({"pageId":page["id"],
                "baseRevision":2,"title":"Border table","json":broken},path=self.db))
        for unsafe in ('<td data-kbw-border-top="javascript:alert(1)">x</td>',
                       '<td style="border:9px solid red">x</td>',
                       '<td data-kbw-border-right="dashed:5:default">x</td>',
                       '<div data-kbw-border-left="solid:1:red">x</div>'):
            with self.assertRaises(ValueError):
                work_hub_html.validate_strict("<table><tr>"+unsafe+"</tr></table>")
        # Clearing a shared border is revisioned; the previous snapshot remains.
        updated=json.loads(json.dumps(rich))
        updated["content"][0]["content"][0]["content"][0]["attrs"]["borderRight"]="none"
        updated["content"][0]["content"][0]["content"][1]["attrs"]["borderLeft"]="none"
        result=v35.document_save({"pageId":page["id"],"baseRevision":2,
            "title":"Border table","json":updated},path=self.db)
        self.assertEqual(result["page"]["revision"],3)
        self.assertEqual(v35.page_document({"id":"ws","page":page["id"]},
            path=self.db)["json"],updated)
        history=query(self.db,"SELECT json_text FROM work_note_v35_history WHERE page_id=? AND revision=2",page["id"])
        self.assertEqual(json.loads(history[0]["json_text"]),rich)

    def test_local_block_search_restricts_project_and_links(self):
        self.init();p=self.page()
        v35.document_save({"pageId":p["id"],"baseRevision":1,
            "title":"Meeting record","json":doc()},path=self.db)
        result=v35.search({"id":"ws","q":"synergy"},path=self.db)
        self.assertEqual(result["scopeRootId"],"init")
        self.assertTrue(result["items"])
        self.assertTrue(all(r["ownerId"]=="ws" for r in result["items"]))
        self.assertTrue(any("blk_abcd1234" in str(r["deepLink"]) for r in result["items"]))
        other=v35.search({"id":"know","q":"synergy"},path=self.db)
        self.assertFalse(other["items"])
        self.assert_rejected(lambda: v35.search({"id":"ws","q":"synergy","crossProject":"1"},
            path=self.db),status=403,code="notebook_v35_cross_project_disabled")

    def test_attachments_are_refs_never_inline_blobs_and_sync_is_idempotent(self):
        self.init();p=self.page()
        fid="file_"+"a"*32
        source=doc()
        source["content"].append({"type":"fileAttachment","attrs":{
            "refId":"ref_test12345678","fileId":fid,"name":"Follow-up.eml",
            "kind":"email","policy":"pinned","pinnedRevision":1}})
        detail={"id":fid,"revision":1,"deleted":0,"links":[{"target_type":"task","target_id":"t1"}],"path":"Projects/WorkHub/Notes/Attachments/test.eml"}
        with patch("file_hub.details",return_value=detail),patch("file_hub.content",return_value=(None,"file.eml")):
            v35.document_save({"pageId":p["id"],"baseRevision":1,
                "title":"Meeting record","json":source},path=self.db)
        files=query(self.db,"SELECT * FROM work_note_v35_refs WHERE page_id=?",p["id"])
        self.assertEqual(files[0]["file_id"],fid)
        self.assertEqual(files[0]["pinned_revision"],1)
        self.assertIn("attachment:"+fid,
                      v35.page_document({"id":"ws","page":p["id"]},path=self.db)["markdown"])
        with patch("file_hub.link") as link, patch("file_hub.details",return_value=detail),\
                patch("file_hub.pin_note_page_revision"):
            self.assertEqual(v35.reconcile_file_links(self.db)["synced"],1)
            self.assertEqual(v35.reconcile_file_links(self.db)["synced"],0)
            link.assert_called_once()

    def test_legacy_page_is_ai_readable_without_json_conversion_or_page_revision_change(self):
        self.init();p=self.page()
        digest=query(self.db,'SELECT revision,html FROM work_note_pages WHERE id=?',p['id'])[0]
        projected=v35.page_document({'id':'ws','page':p['id']},path=self.db)
        self.assertEqual(projected['format'],'legacy-html')
        self.assertIn('Legacy old content',projected['markdown'])
        self.assertEqual(v35.index_page(p['id'],path=self.db)['revision'],1)
        results=v35.search({'id':'ws','q':'Legacy'},path=self.db)['items']
        self.assertTrue(any(result['pageId']==p['id'] for result in results))
        self.assertEqual(query(self.db,'SELECT revision,html FROM work_note_pages WHERE id=?',
                               p['id'])[0],digest)

    def test_legacy_conversion_loss_is_rejected_without_mutating_content(self):
        self.init();p=self.page()
        missing={'type':'doc','content':[{'type':'paragraph','content':[
            {'type':'text','text':'Completely different text'}]}]}
        self.assert_rejected(lambda:v35.document_save({
            'pageId':p['id'],'baseRevision':p['revision'],
            'title':'Meeting record','json':missing},path=self.db),
            status=409,code='notebook_v35_conversion_loss')
        self.assertEqual(nb.page_view({'id':'ws','page':p['id']},path=self.db)['html'],
                         '<p>Legacy old content</p>')

    def test_opt_in_history_marks_revision_and_respects_archive_and_owner(self):
        self.init();p=self.page()
        v35.document_save({'pageId':p['id'],'baseRevision':1,'title':'Meeting record',
                           'json':doc()},path=self.db)
        previous=v35.knowledge_history({'id':'ws','page':p['id'],'revision':'1'},path=self.db)
        self.assertEqual(previous['format'],'legacy-html')
        self.assertTrue(previous['historical'])
        self.assertIn('Legacy old content',previous['html'])
        current=v35.knowledge_history({'id':'ws','page':p['id'],'revision':'2'},path=self.db)
        self.assertEqual(current['format'],'json')
        self.assertIn('synergy',current['markdown'])
        self.assert_rejected(lambda:v35.knowledge_history({
            'id':'know','page':p['id'],'revision':'1'},path=self.db),
            status=403,code='notebook_owner_mismatch')
        nb.page_action({'action':'notebook-page-archive','pageId':p['id'],
                        'baseRevision':2},path=self.db)
        self.assert_rejected(lambda:v35.knowledge_history({
            'id':'ws','page':p['id']},path=self.db),
            status=404,code='notebook_page_not_found')
        archive=v35.knowledge_history({'id':'ws','page':p['id'],
             'includeArchived':'1'},path=self.db)
        self.assertTrue(archive['archived'])
        self.assertEqual(archive['latestRevision'],3)
        self.assertFalse(v35.search({'id':'ws','q':'synergy'},path=self.db)['items'])

    def test_real_isolated_file_hub_email_upload_pin_preview_recovery_and_trash_guard(self):
        self.init()
        p=self.page()
        payload=(b'From: Colleague <sample@example.com>\r\n'
                 b'To: Reviewer <reviewer@example.com>\r\n'
                 b'Subject: Project Update\r\n'
                 b'Date: Mon, 16 Nov 2026 10:00:00 +0000\r\n'
                 b'MIME-Version: 1.0\r\n'
                 b'Content-Type: text/plain; charset=utf-8\r\n\r\n'
                 b'We can reuse the existing solution.\r\n')
        with tempfile.TemporaryDirectory(prefix='kbw-v35-isolated-hub-') as tmp:
            root=Path(tmp);lib=root/'library';data=root/'filehub'
            with patch.multiple(file_hub,LIBRARY=lib,DATA=data,DB=data/'catalog.sqlite3',
                                VERSIONS=data/'versions',TRASH=data/'trash'):
                file_hub._init()
                for folder in ('Projects/WorkHub','Projects/WorkHub/Notes',
                               'Projects/WorkHub/Notes/Attachments'):
                    file_hub.folder_create(folder)
                fid=file_hub.upload('Projects/WorkHub/Notes/Attachments','sample.eml',payload)['id']
                v35.attach_upload(p['id'],fid,'upload_example1',path=self.db)
                source=doc()
                source['content'].append({'type':'fileAttachment','attrs':{
                    'refId':'ref_mail12345','fileId':fid,'name':'sample.eml',
                    'kind':'email','policy':'pinned','pinnedRevision':1}})
                saved=v35.document_save({'pageId':p['id'],'baseRevision':1,
                    'title':'Meeting record','json':source},path=self.db)
                self.assertEqual(saved['page']['revision'],2)
                self.assertEqual(v35.state(self.db)['pendingFileSync'],0)
                self.assertEqual(v35.state(self.db)['stagedFiles'],0)
                detail=file_hub.details(fid)
                self.assertEqual(detail['links'][0]['target_type'],'note-page')
                preview=v35.email_preview({'id':'ws','page':p['id'],'fileId':fid},path=self.db)
                self.assertEqual(preview['status'],'preview')
                self.assertEqual(preview['subject'],'Project Update')
                self.assertIn('reuse',preview['body'])
                with self.assertRaises(file_hub.Conflict):
                    file_hub.lifecycle(fid,1,'trash',confirm=True)
                with file_hub._db() as con:
                    pins=con.execute('SELECT revision FROM note_page_version_pins WHERE file_id=?',
                                     (fid,)).fetchall()
                    self.assertEqual([x[0] for x in pins],[1])
                self.assertEqual(file_hub.content(fid,1)[0].read_bytes(),payload)
                newer=b'Second local source revision\r\n'
                file_hub._update(fid,newer,1,'test-revision')
                self.assertEqual(file_hub.content(fid,1)[0].read_bytes(),payload)
                with self.assertRaises(file_hub.Conflict):
                    file_hub.remove_version(fid,1)
                with self.assertRaises(file_hub.Conflict):
                    file_hub.lock_version(fid,1,False)
                self.assertEqual(file_hub.content(fid)[0].read_bytes(),newer)

    def test_real_http_upload_handler_msg_staging_and_pinned_page_attachment(self):
        """Exercise the HTTP handler's real reader calls in a fully isolated DB/Hub."""
        import work_server
        import work_hub_store
        self.init();page=self.page()
        payload=b'Synthetic Outlook msg file bytes for safe upload test'
        operation='op_'+'9'*32
        filename='Meeting Follow-up.msg'
        url='/api/file-hub/upload?'+urlencode({
            'notePageId':page['id'],'operationId':operation,'name':filename})
        with tempfile.TemporaryDirectory(prefix='kbw-msg-http-isolated-') as tmp:
            root=Path(tmp);lib=root/'library';data=root/'filehub'
            with patch.object(work_hub_store,'DB_PATH',self.db), patch.multiple(
                file_hub,LIBRARY=lib,DATA=data,DB=data/'catalog.sqlite3',
                VERSIONS=data/'versions',TRASH=data/'trash'):
                file_hub._init()
                for folder in ('Projects/WorkHub','Projects/WorkHub/Notes'):
                    file_hub.folder_create(folder)
                responses=[]
                handler=SimpleNamespace(path=url,rfile=io.BytesIO(payload),
                    headers={'Content-Length':str(len(payload))},
                    _work_hub_write_allowed=lambda:True,
                    _send_json=lambda status,data:responses.append((status,data)))
                work_server.VideoRangeHandler.file_hub_post(handler,upload=True)
                self.assertEqual(responses[-1][0],200,responses[-1][1])
                fid=responses[-1][1]['data']['fileId']
                self.assertTrue((lib/'Projects/WorkHub/Notes/Attachments').is_dir())
                self.assertTrue(file_hub.details(fid)['path'].endswith('.msg'))
                self.assertEqual(query(self.db,'SELECT status FROM work_note_v35_staging WHERE page_id=?',page['id'])[0]['status'],'staged')
                # Same operation and same bytes are safe idempotent replays.
                handler.rfile=io.BytesIO(payload)
                work_server.VideoRangeHandler.file_hub_post(handler,upload=True)
                self.assertEqual(responses[-1][0],200,responses[-1][1])
                self.assertEqual(responses[-1][1]['data']['fileId'],fid)
                with file_hub._db() as hub:
                    self.assertEqual(hub.execute('SELECT count(*) FROM files').fetchone()[0],1)
                structured=doc()
                structured['content'].insert(1,{'type':'fileAttachment','attrs':{
                    'refId':'ref_outlook12345','fileId':fid,'name':filename,
                    'kind':'email','policy':'pinned','pinnedRevision':1,'mime':''}})
                saved=v35.document_save({'pageId':page['id'],'baseRevision':1,
                    'title':page['title'],'json':structured},path=self.db)
                self.assertEqual(saved['page']['revision'],2)
                self.assertEqual(v35.state(self.db)['stagedFiles'],0)
                self.assertTrue(any(x['target_type']=='note-page'
                    for x in file_hub.details(fid)['links']))
                self.assertEqual(file_hub.content(fid,1)[0].read_bytes(),payload)

    def test_images_are_page_scoped_references_with_no_duplicate_ids(self):
        self.init();page=self.page()
        with tempfile.TemporaryDirectory(prefix='kbw-v35-image-hub-') as tmp:
            root=Path(tmp);lib=root/'library';data=root/'filehub'
            with patch.multiple(file_hub,LIBRARY=lib,DATA=data,DB=data/'catalog.sqlite3',
                                VERSIONS=data/'versions',TRASH=data/'trash'):
                file_hub._init()
                for folder in ('Projects/WorkHub','Projects/WorkHub/Notes'):
                    file_hub.folder_create(folder)
                fid=file_hub.upload('Projects/WorkHub/Notes','example.png',
                    b'\x89PNG\r\n\x1a\nsynthetic-image')['id']
                file_hub.link(fid,'workstream','ws',relation='note-image')
                image={'type':'image','attrs':{'refId':'ref_image12345678',
                    'src':'/api/file-hub/file?id='+fid+'&mode=inline',
                    'alt':'Diagram','align':'center','width':360}}
                content=doc();content['content'].append(image)
                done=v35.document_save({'pageId':page['id'],'baseRevision':1,
                    'title':page['title'],'json':content},path=self.db)
                self.assertEqual(done['page']['revision'],2)
                refs=query(self.db,'SELECT * FROM work_note_v35_refs WHERE page_id=?',page['id'])
                self.assertEqual(len(refs),1)
                self.assertEqual(refs[0]['kind'],'image')
                self.assertEqual(refs[0]['state'],'synced')
                self.assertTrue(any(item['target_type']=='note-page'
                    for item in file_hub.details(fid)['links']))
                with self.assertRaises(file_hub.Conflict):
                    file_hub.lifecycle(fid,1,'trash',confirm=True)
                repeated=doc()
                repeated['content'].extend([image,image])
                self.assert_rejected(lambda:v35.document_save({
                    'pageId':page['id'],'baseRevision':2,'title':page['title'],
                    'json':repeated},path=self.db))

    def test_realistic_tiptap_table_code_and_five_level_outline_projection(self):
        self.init()
        p=nb.page_action({'action':'notebook-page-create','id':'ws',
             'title':'Structured test','html':''},path=self.db)['page']
        rich={'type':'doc','content':[
            {'type':'heading','attrs':{'level':5,'blockId':'blk_deep1234'},
             'content':[{'type':'text','text':'Nested knowledge'}]},
            {'type':'table','content':[{'type':'tableRow','content':[
                {'type':'tableHeader','attrs':{'colspan':1,'rowspan':1,'colwidth':None},
                 'content':[{'type':'paragraph','content':[{'type':'text','text':'Decision'}]}]},
                {'type':'tableCell','attrs':{'colspan':1,'rowspan':1,'colwidth':None,'background':None},
                 'content':[{'type':'paragraph','content':[{'type':'text','text':'Approved'}]}]}]}]},
            {'type':'codeBlock','attrs':{'language':None},
             'content':[{'type':'text','text':'SELECT 1;'}]},
            {'type':'taskList','content':[{'type':'taskItem','attrs':{'checked':True},
                  'content':[{'type':'paragraph','content':[{'type':'text','text':'Notify team'}]}]}]},
            {'type':'paragraph','content':[{'type':'text','text':'Go',
              'marks':[{'type':'link','attrs':{'href':'/app/n/ws/notes?page=np_example123',
                         'target':'_blank','rel':'noopener noreferrer'}}]}]},
        ]}
        result=v35.document_save({'pageId':p['id'],'baseRevision':1,
                    'title':'Structured test','json':rich},path=self.db)
        self.assertEqual(result['page']['revision'],2)
        projected=v35.page_document({'id':'ws','page':p['id']},path=self.db)
        self.assertIn('| Decision | Approved |',projected['markdown'])
        self.assertIn('SELECT 1;',projected['markdown'])
        self.assertIn('<table>',projected['html'])
        self.assertIn('<th>',projected['html'])
        self.assertIn('<td>',projected['html'])
        self.assertIn('taskList',str(projected['json']))
        self.assertEqual(v35.search({'id':'ws','q':'Nested knowledge'},path=self.db)['items'][0]['blockId'],
                         'blk_deep1234')

    def test_title_only_legacy_rename_preserves_json(self):
        self.init();p=self.page()
        result=v35.document_save({"pageId":p["id"],"baseRevision":1,"title":"Meeting record",
            "json":doc()},path=self.db)
        html=result["page"]["html"]
        edited=nb.page_action({"action":"notebook-page-save","pageId":p["id"],"baseRevision":2,
            "title":"Updated title","html":html},path=self.db)
        self.assertEqual(edited["page"]["revision"],3)
        self.assertEqual(edited["page"]["documentJson"],doc())
        self.assertEqual(query(self.db,"SELECT count(*) n FROM work_note_v35_history WHERE page_id=?",
                               p["id"])[0]["n"],2)

if __name__=="__main__":
    unittest.main()
