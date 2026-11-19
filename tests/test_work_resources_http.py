"""Loopback HTTP contract; uses isolated resource storage and ephemeral port."""
from __future__ import annotations
import http.client
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
import work_resources as store
import work_server

class ResourceHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix="kbw-resource-http-")
        self.addCleanup(self.tmp.cleanup)
        self.storage=patch.object(store,"root",return_value=Path(self.tmp.name)/"resources")
        self.storage.start()
        self.addCleanup(self.storage.stop)
        self.server=ThreadingHTTPServer(("127.0.0.1",0),work_server.VideoRangeHandler)
        self.port=self.server.server_address[1]
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def send(self,method,path,payload=None,origin=True):
        connection=http.client.HTTPConnection("127.0.0.1",self.port,timeout=5)
        headers={"Accept":"application/json"}
        if method=="POST":
            headers["Content-Type"]="application/json"
            if origin: headers["Origin"]="http://127.0.0.1:"+str(self.port)
        connection.request(method,path,body=None if payload is None else json.dumps(payload),headers=headers)
        response=connection.getresponse()
        body=response.read()
        code=response.status
        connection.close()
        return code,json.loads(body)

    def test_prompt_notebook_http_lifecycle_and_manual_flow(self):
        code,created=self.send("POST","/api/resources/v1",{
            "action":"prompt-create","title":"Project Steering",
            "content":"Before editing {{project_name}}, validate the baseline",
            "role":"steering","timing":"always-on",
            "scenarios":["Steering & Instructions","Vibe Coding"]})
        self.assertEqual(code,200)
        item=created["data"]
        self.assertEqual(item["role"],"steering")
        self.assertIsNotNone(item["draft"])
        code,listing=self.send("GET","/api/resources/v1?view=prompt-list")
        self.assertEqual(code,200)
        self.assertEqual(len(listing["data"]),1)
        code,edited=self.send("POST","/api/resources/v1",{
            "action":"prompt-save","resourceId":item["id"],"baseRevision":1,
            "title":"Project Steering V2","content":"Use tests for {{project_name}}",
            "scenarios":["Steering & Instructions"],"role":"steering","timing":"always-on"})
        self.assertEqual(code,200)
        self.assertEqual(edited["data"]["draft"]["revision"],2)
        code,flow=self.send("POST","/api/resources/v1",{
            "action":"prompt-flow-save","title":"Development Flow","steps":[item["id"]]})
        self.assertEqual(code,200)
        self.assertEqual(flow["data"]["steps"],[item["id"]])
        code,flows=self.send("GET","/api/resources/v1?view=prompt-flows")
        self.assertEqual(code,200)
        self.assertEqual(len(flows["data"]),1)
        code,denied=self.send("POST","/api/resources/v1",{
            "action":"prompt-steering-export","resourceId":item["id"],
            "agent":"codex","projectRoot":"/tmp"})
        self.assertEqual(code,403)
        self.assertEqual(denied["code"],"explicit_export_confirmation_required")

    def test_inline_review_api_no_operator_passphrase(self):
        code,created=self.send("POST","/api/resources/v1",
            {"action":"create-draft","type":"prompt","name":"local-inline"})
        self.assertEqual(code,200)
        resource_id=created["data"]["id"]
        code,snapshot=self.send("POST","/api/resources/v1",
            {"action":"snapshot","resourceId":resource_id,"baseRevision":1})
        self.assertEqual(code,200)
        version_id=snapshot["data"]["versionId"]
        code,denied=self.send("POST","/api/resources/v1",
            {"action":"review","versionId":version_id,
             "actor":"local-user","decision":"approve"})
        self.assertEqual(code,403)
        self.assertEqual(denied["code"],"explicit_human_confirmation_required")
        code,accepted=self.send("POST","/api/resources/v1",
            {"action":"review","versionId":version_id,
             "actor":"local-user","decision":"approve",
             "confirmation":"I reviewed this exact version",
             "evidence":"Approved inline in personal library"})
        self.assertEqual(code,200)
        self.assertEqual(accepted["data"]["review_state"],"approved")
        code,history=self.send("GET","/api/resources/v1?view=detail&id="+resource_id)
        self.assertEqual(code,200)
        self.assertEqual(history["data"]["versions"][0]["review_state"],"approved")

    def test_local_api_draft_lifecycle_and_remote_gate(self):
        code,data=self.send("GET","/api/resources/v1?view=capabilities")
        self.assertEqual(code,200)
        self.assertFalse(data["data"]["portalWritesEnabled"])
        code,_=self.send("POST","/api/resources/v1",{"action":"create-draft","type":"prompt","name":"test"},origin=False)
        self.assertEqual(code,403)
        code,created=self.send("POST","/api/resources/v1",{"action":"create-draft","type":"prompt","name":"test"})
        self.assertEqual(code,200)
        rid=created["data"]["id"]
        code,details=self.send("GET","/api/resources/v1?view=detail&id="+rid)
        self.assertEqual(code,200)
        self.assertEqual(details["data"]["visibility"],"private")
        self.assertTrue(details["data"]["draft"])
        code,remote=self.send("GET","/local/v1/release/status")
        self.assertEqual(code,200)
        self.assertFalse(remote["data"]["remoteApiEnabled"] if "remoteApiEnabled" in remote["data"]
                         else remote["data"]["pairingSupported"])
        self.assertFalse(remote["data"]["portalPilotReady"])

if __name__=="__main__":
    unittest.main()
