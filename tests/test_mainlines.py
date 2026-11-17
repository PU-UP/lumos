import copy
import http.client
import json
from pathlib import Path
import threading

import lumos
from lumos_mainlines import mainline_detail, save_review
from lumos_tasks import list_tasks, task_detail
from lumos_transfer import backup, restore
from lumos_web import make_server
from test_core import BaseStoreCase


class MainlineTest(BaseStoreCase):
    def setUp(self):
        super().setUp()
        self.seed()
        self.line = {"id": "mainline-test", "kind": "mainline", "data": {
            "title": "模拟主线 <script>", "context": "mapping", "goal": "模拟长期目标",
            "summary": "模拟阶段结论", "phase": "模拟联调", "as_of": "2026-11-14",
            "task_ids": ["talk"], "milestone_ids": ["talk"], "source_ids": ["plan", "assumption"],
            "source": {"type": "agent", "ref": "isolated synthetic fixture"}}}

    def commit_line(self, line=None):
        batch = self.store.begin({"reason": "synthetic mainline", "updates": [line or self.line]}, True)
        self.store.commit(batch["batch"], True)

    def test_summary_and_history_do_not_mutate_tasks(self):
        before = task_detail(self.store, "talk")
        self.commit_line()
        self.line["data"]["summary"] = "模拟更新，不表示任务完成"
        self.commit_line()
        after = task_detail(self.store, "talk")
        self.assertEqual(before["task"], after["task"])
        self.assertEqual(before["history"], after["history"])
        detail = mainline_detail(self.store, "mainline-test")
        self.assertEqual(len(detail["history"]), 2)
        self.assertEqual(detail["tasks"][0]["id"], "talk")
        self.assertEqual({s["id"] for s in detail["sources"]}, {"plan", "assumption"})
        self.assertEqual(list_tasks(self.store)["mainlines"][0], self.line)
        self.assertEqual(self.store.verify()["integrity"], "ok")

    def test_review_saves_only_review_fields_replays_and_rejects_stale_version(self):
        self.commit_line()
        before = mainline_detail(self.store, 'mainline-test')
        request = {'request_id': 'a'*32, 'id':'mainline-test', 'expected_seq':before['seq'],
                   'review_on':'2026-11-20', 'source':{'type':'user','ref':'synthetic date choice'}}
        save_review(self.store, request)
        self.assertTrue(save_review(self.store, request)['replayed'])
        after = mainline_detail(self.store, 'mainline-test')
        self.assertEqual(after['mainline']['data']['review_on'], '2026-11-20')
        self.assertEqual(after['mainline']['data']['source'], before['mainline']['data']['source'])
        self.assertEqual(after['tasks'], before['tasks'])
        self.assertEqual(len(after['history']), len(before['history'])+1)
        with self.assertRaises(lumos.Error):
            save_review(self.store, {**request, 'request_id':'b'*32})
        for value in ['long_term','2026-02-30',None]:
            with self.assertRaises(lumos.Error):
                save_review(self.store, {**request,'request_id':'c'*32,'expected_seq':after['seq'],'review_on':value})
        save_review(self.store, {**request,'request_id':'d'*32,'expected_seq':after['seq'],'review_on':''})
        self.assertEqual(mainline_detail(self.store,'mainline-test')['mainline']['data']['review_on'], '')

    def test_bad_references_dates_and_milestones_are_rejected(self):
        for changes in [{"task_ids": ["missing"]}, {"milestone_ids": ["assumption"]},
                        {"task_ids": [], "milestone_ids": ["talk"]}, {"source_ids": ["talk"]},
                        {"task_ids": ["talk", "talk"]}, {"as_of": "2026-02-30"},
                        {"review_on": "long_term"}, {"order": True}, {"related_mainlines": ["mainline-test"]},
                        {"title": "", "text": "Cannot replace title"}, {"goal": "   "},
                        {"priority": "P3"}, {"priority": "P4"}, {"priority": None}, {"priority": []}, {"priority_basis": "unknown"}]:
            with self.subTest(changes=changes):
                line = copy.deepcopy(self.line)
                line["data"].update(changes)
                batch = self.store.begin({"reason": "synthetic invalid", "updates": [line]}, True)
                with self.assertRaises(lumos.Error):
                    self.store.commit(batch["batch"], True)
                self.store.abandon(batch["batch"])
        self.assertEqual(task_detail(self.store, "talk")["task"]["data"]["status"], "todo")

    def test_workspace_and_archival_boundaries(self):
        with self.store.db() as db:
            nodes = self.store.nodes(db)
        ctx = nodes["prep"]
        ctx["data"]["workspace"] = "lumos"
        line = copy.deepcopy(self.line)
        line["data"]["context"] = "prep"
        batch = self.store.begin({"reason": "synthetic cross workspace", "updates": [ctx, line]}, True)
        with self.assertRaisesRegex(lumos.Error, "same workspace"):
            self.store.commit(batch["batch"], True)
        self.store.abandon(batch["batch"])
        self.commit_line()
        ctx = nodes["mapping"]
        ctx["data"]["status"] = "archived"
        batch = self.store.begin({"reason": "synthetic archive", "updates": [ctx]}, True)
        self.store.commit(batch["batch"], True)
        self.assertEqual(list_tasks(self.store)["mainlines"], [])
        self.assertEqual(mainline_detail(self.store, "mainline-test")["tasks"][0]["context_status"], "archived")

    def test_non_project_tasks_cannot_join_active_mainlines(self):
        with self.store.db() as db:
            task = self.store.nodes(db)['talk']
        task['data']['priority'] = 'P3'
        batch = self.store.begin({'reason':'synthetic non-project boundary','updates':[task,self.line]}, True)
        with self.assertRaisesRegex(lumos.Error, 'P3'):
            self.store.commit(batch['batch'], True)
        self.store.abandon(batch['batch'])
        self.assertNotEqual(task_detail(self.store, 'talk')['task']['data']['priority'], 'P3')

    def test_restore_preserves_summary_sources_and_history(self):
        self.commit_line()
        before = mainline_detail(self.store, "mainline-test")
        backup(self.store, self.area / "backup", True)
        restore(self.area / "backup", self.area / "restore", sandbox=True)
        self.assertEqual(mainline_detail(lumos.Store(self.area / "restore"), "mainline-test"), before)
        with self.store.db() as db:
            version = self.store.nodes(db)["plan"]["data"]["version"]
        (self.root / version).write_text("damaged synthetic source", encoding="utf-8")
        with self.assertRaisesRegex(lumos.Error, "Damaged current version"):
            mainline_detail(self.store, "mainline-test")

    def test_http_routes_and_old_task_bookmarks(self):
        self.commit_line()
        server = make_server(self.store, 0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        def get(path):
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            conn.request("GET", path)
            response = conn.getresponse()
            body = response.read().decode("utf-8")
            conn.close()
            return response.status, body
        for path in ["/", "/delivery"]:
            status, body = get(path)
            self.assertEqual(status, 200)
            self.assertIn('id="mainlines"', body)
        for path in ["/tasks", "/?task=talk"]:
            self.assertIn('id="task-list"', get(path)[1])
        self.assertEqual(json.loads(get('/api/mainline?id=mainline-test')[1])["tasks"][0]["id"], "talk")
        self.assertEqual(get('/api/mainline?id=missing')[0], 409)
        self.assertEqual(get('/overview.js')[0], 200)
        self.assertEqual(get('/overview.css')[0], 200)
        self.assertEqual(get('/intake.js')[0], 200)
        receipts = json.loads(get('/api/intakes')[1])
        self.assertEqual(receipts['intakes'], [])
        self.assertEqual(receipts['executor'], 'offline')
        request={'request_id':'e'*32,'id':'mainline-test','expected_seq':list_tasks(self.store)['seq'],'review_on':'2026-11-19'}
        conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
        headers={'Content-Type':'application/json','Origin':f'http://127.0.0.1:{server.server_port}'}
        conn.request('POST','/api/mainline-review',json.dumps(request),headers)
        response=conn.getresponse();self.assertEqual(response.status,409);response.read()
        headers['X-Lumos-Token']=receipts['token']
        conn.request('POST','/api/mainline-review',json.dumps(request),headers)
        response=conn.getresponse();self.assertEqual(response.status,200);response.read();conn.close()
        self.assertEqual(mainline_detail(self.store,'mainline-test')['mainline']['data']['review_on'],'2026-11-19')
