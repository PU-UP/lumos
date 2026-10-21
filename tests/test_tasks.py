import copy
import http.client
import json
from pathlib import Path
import subprocess
import sys
import threading
import uuid

import lumos
from lumos_tasks import list_tasks, task_detail, save_task
from lumos_transfer import backup, restore
from lumos_web import make_server
from test_core import BaseStoreCase


class TaskTest(BaseStoreCase):
    def setUp(self):
        super().setUp()
        self.seed()

    def request(self, **changes):
        return {"request_id": uuid.uuid4().hex, "expected_seq": self.store.status()["seq"],
                "source": {"type": "user", "ref": "fixture: explicit synthetic task"},
                "changes": {"context": "mapping", "text": "模拟任务", **changes}}

    def test_cli_write_detail_and_same_board_data(self):
        request = self.request(details="模拟详细背景", next_step="模拟下一步")
        path = self.area / "request.json"
        path.write_text(json.dumps(request), encoding="utf-8")
        result = subprocess.run([sys.executable, str(lumos.ENGINE / "lumos.py"), "--data", str(self.root),
                                 "task-save", str(path)], capture_output=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        ident = json.loads(result.stdout)["id"]
        task = task_detail(self.store, ident)
        self.assertEqual(task["task"]["data"]["details"], "模拟详细背景")
        self.assertEqual(len(task["history"]), 1)
        self.assertTrue(any(n["id"] == ident for n in list_tasks(self.store)["tasks"]))
        self.assertIn("plan", task["documents"])

    def test_duplicate_and_stale_update_preserve_newer_task(self):
        request = self.request()
        result = save_task(self.store, request)
        self.assertTrue(save_task(self.store, request)["replayed"])
        self.assertEqual(self.store.status()["seq"], result["seq"])
        stale = self.request(text="older update")
        stale["id"] = result["id"]
        fresh = copy.deepcopy(stale)
        fresh["request_id"] = uuid.uuid4().hex
        fresh["changes"]["text"] = "newer update"
        save_task(self.store, fresh)
        with self.assertRaisesRegex(lumos.Error, "记录已变化"):
            save_task(self.store, stale)
        request["changes"]["text"] = "changed duplicate"
        with self.assertRaisesRegex(lumos.Error, "reused"):
            save_task(self.store, request)
        self.assertEqual(task_detail(self.store, result["id"])["task"]["data"]["text"], "newer update")
        self.assertIsNone(self.store.status()["session"])

    def test_detail_uses_exact_context_and_explicit_document_links(self):
        request = {"reason": "synthetic similar context", "updates": [
            {"id": "mapping-old", "kind": "context", "data": {
                "title": "历史 mapping", "entry": "old-plan", "status": "archived"}}
        ], "documents": [{"id": "old-plan", "path": "work/old-plan.md", "title": "历史背景",
                          "context": "mapping-old", "role": "understanding"}]}
        batch = self.store.begin(request, True)
        Path(batch["candidates"]["old-plan"]).write_text("Archived unrelated context", encoding="utf-8")
        self.store.commit(batch["batch"], True)
        self.assertEqual(set(task_detail(self.store, "talk")["documents"]), {"plan"})
        batch = self.store.begin({"reason": "explicit task reference",
                                 "links": [["talk", "old-plan", "derived_from"]]}, True)
        self.store.commit(batch["batch"], True)
        self.assertEqual(set(task_detail(self.store, "talk")["documents"]), {"plan", "old-plan"})

    def test_attention_dates_undated_closed_and_archived(self):
        overdue = save_task(self.store, self.request(due="2026-10-20", follow_up="2026-10-21", priority="high", status="blocked"))["id"]
        near = save_task(self.store, self.request(due="2026-10-28"))["id"]
        later = save_task(self.store, self.request(due="2026-10-29"))["id"]
        done = save_task(self.store, self.request(due="2026-10-20", status="done"))["id"]
        tasks = list_tasks(self.store, "2026-10-21")
        self.assertEqual(set(tasks["attention"]), {overdue, near})
        self.assertEqual(next(t for t in tasks["tasks"] if t["id"] == overdue)["attention"],
                         ["已逾期", "到跟进日", "有阻塞", "重要事项"])
        self.assertTrue({"talk", later, done} <= {t["id"] for t in tasks["tasks"]})
        ctx = next(n for n in self.store.context("mapping")["nodes"] if n["id"] == "mapping")
        ctx["data"]["status"] = "archived"
        b = self.store.begin({"reason": "synthetic archive", "updates": [ctx]}, True)
        self.store.commit(b["batch"], True)
        self.assertEqual(list_tasks(self.store)["tasks"], [])
        with self.assertRaisesRegex(lumos.Error, "归档"):
            save_task(self.store, self.request())

    def test_bad_input_does_not_leave_session(self):
        for changes in ({"due": "2026-02-30"}, {"follow_up": "tomorrow"}, {"text": "  "},
                        {"priority": "urgent"}, {"status": "unknown"}, {"details": []}):
            with self.subTest(changes=changes), self.assertRaises(lumos.Error):
                save_task(self.store, self.request(**changes))
            self.assertIsNone(self.store.status()["session"])
        bad = self.request()
        bad["source"]["type"] = "agent"
        with self.assertRaises(lumos.Error):
            save_task(self.store, bad)

    def test_generic_batches_share_date_validation(self):
        node = next(n for n in self.store.context("mapping")["nodes"] if n["id"] == "talk")
        node["data"]["due"] = "not-a-date"
        batch = self.store.begin({"reason": "synthetic bad date", "updates": [node]}, True)
        with self.assertRaises(lumos.Error):
            self.store.commit(batch["batch"], True)
        self.store.abandon(batch["batch"])

    def test_done_reopen_and_sources_retained(self):
        result = save_task(self.store, self.request(status="done"))
        original = task_detail(self.store, result["id"])["task"]["data"]
        self.assertEqual(original["completion"]["basis"], "user_report")
        self.assertNotIn("technical_result", original)
        request = self.request(status="doing")
        request["id"] = result["id"]
        request["source"]["ref"] = "fixture: reopen"
        save_task(self.store, request)
        detail = task_detail(self.store, result["id"])
        self.assertNotIn("completion", detail["task"]["data"])
        self.assertEqual(detail["task"]["data"]["source"], original["source"])
        self.assertEqual(len(detail["history"]), 2)

    def test_session_and_readonly_prevent_write(self):
        batch = self.edit()
        self.assertFalse(list_tasks(self.store)["writable"])
        with self.assertRaisesRegex(lumos.Error, "session"):
            save_task(self.store, self.request())
        self.store.abandon(batch["batch"])
        ctl = self.store.control()
        ctl["mode"] = "retired"
        self.store.set_control(ctl)
        self.assertFalse(list_tasks(self.store)["writable"])
        with self.assertRaisesRegex(lumos.Error, "Read-only"):
            save_task(self.store, self.request())

    def test_backup_restore_retains_tasks_details_and_history(self):
        ident = save_task(self.store, self.request(details="模拟完整内容", follow_up="2026-10-21"))["id"]
        snapshot = self.area / "snapshot"
        backup(self.store, snapshot, True)
        target = self.area / "restored"
        restore(snapshot, target, None, True)
        restored = lumos.Store(target)
        self.assertEqual(task_detail(restored, ident)["task"], task_detail(self.store, ident)["task"])
        self.assertEqual(task_detail(restored, ident)["history"], task_detail(self.store, ident)["history"])
        self.assertIn(ident, list_tasks(restored, "2026-10-21")["attention"])
        self.assertTrue((snapshot / "engine/web/board.js").is_file())

    def test_http_write_read_replay_and_security_boundaries(self):
        server = make_server(self.store, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_port

        def call(method, path, body=None, headers=None):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request(method, path, json.dumps(body) if body is not None else None, headers or {})
            response = conn.getresponse()
            data = response.read()
            conn.close()
            return response.status, data

        status, raw = call("GET", "/api/tasks")
        self.assertEqual(status, 200)
        board = json.loads(raw)
        headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{port}", "X-Lumos-Token": board["token"]}
        request = self.request(text="模拟 <script>alert(1)</script>")
        status, raw = call("POST", "/api/tasks", request, headers)
        self.assertEqual(status, 200, raw)
        ident = json.loads(raw)["id"]
        self.assertEqual(task_detail(self.store, ident)["task"]["data"]["source"]["type"], "user")
        self.assertTrue(json.loads(call("POST", "/api/tasks", request, headers)[1])["replayed"])
        for bad in ({**headers, "Origin": "https://untrusted.example"},
                    {**headers, "Host": "untrusted.example"}, {**headers, "X-Lumos-Token": "wrong"}):
            self.assertEqual(call("POST", "/api/tasks", request, bad)[0], 409)
        self.assertEqual(call("GET", "/lumos-data/lumos.sqlite3")[0], 404)
        self.assertEqual(call("GET", "/", headers={"Host": "untrusted.example"})[0], 409)
        self.assertEqual(call("GET", "/api/task?id=" + ident)[0], 200)
        large = self.request(details="中" * 20000, progress="文" * 20000)
        status, raw = call("POST", "/api/tasks", large, headers)
        self.assertEqual(status, 200, raw)
