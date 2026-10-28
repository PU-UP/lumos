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

    def test_board_moves_are_atomic_persistent_and_replayable(self):
        a = save_task(self.store, self.request(text="A"))["id"]
        b = save_task(self.store, self.request(text="B"))["id"]
        def move(ident, status, before=None):
            return {**self.request(), "id": ident, "changes": {"status": status}, "before_id": before}
        save_task(self.store, move(a, "todo", b))
        order = list_tasks(self.store)["board_order"]
        self.assertEqual(order.index(a) + 1, order.index(b))
        request = move(b, "todo", a)
        save_task(self.store, request)
        self.assertTrue(save_task(self.store, request)["replayed"])
        order = list_tasks(self.store)["board_order"]
        self.assertLess(order.index(b), order.index(a))
        stale = move(a, "blocked")
        save_task(self.store, move(b, "done"))
        with self.assertRaisesRegex(lumos.Error, "记录已变化"):
            save_task(self.store, stale)
        save_task(self.store, move(a, "done", b))
        detail = task_detail(self.store, a)
        self.assertEqual(detail["task"]["data"]["completion"]["basis"], "user_report")
        save_task(self.store, move(a, "doing"))
        self.assertNotIn("completion", task_detail(self.store, a)["task"]["data"])
        seq = self.store.status()["seq"]
        for target in ("missing", a, b, [], 3):
            with self.subTest(target=target), self.assertRaises(lumos.Error):
                save_task(self.store, move(a, "doing", target))
            self.assertEqual(self.store.status()["seq"], seq)
            self.assertIsNone(self.store.status()["session"])

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

    def test_workspace_groups_preserve_background_and_isolate_moves(self):
        self.assertTrue(all(c["data"]["workspace"] == "lingguang" for c in list_tasks(self.store)["contexts"]))
        ctx = next(n for n in self.store.context("prep")["nodes"] if n["id"] == "prep")
        ctx["data"]["workspace"] = "lumos"
        batch = self.store.begin({"reason": "synthetic workspace", "updates": [ctx]}, True)
        self.store.commit(batch["batch"], True)
        other = save_task(self.store, self.request(context="prep", group="维护"))["id"]
        ident = save_task(self.store, self.request(group="  感知与地图  "))["id"]
        detail = task_detail(self.store, ident)
        self.assertEqual(detail["task"]["data"]["group"], "感知与地图")
        self.assertEqual(detail["task"]["data"]["context"], "mapping")
        self.assertIn("plan", detail["documents"])
        request = {**self.request(), "id": ident, "changes": {"status": "todo"}, "before_id": other}
        with self.assertRaisesRegex(lumos.Error, "Move target"):
            save_task(self.store, request)
        original = task_detail(self.store, other)
        request["before_id"] = None
        save_task(self.store, request)
        self.assertEqual(task_detail(self.store, other)["history"], original["history"])
        self.assertEqual(task_detail(self.store, ident)["task"]["data"]["group"], "感知与地图")
        request = {**self.request(), "id": ident, "changes": {"group": ""}}
        save_task(self.store, request)
        detail = task_detail(self.store, ident)
        self.assertEqual(detail["task"]["data"]["group"], "")
        self.assertEqual(detail["history"][-1]["after"]["data"]["group"], "感知与地图")
        ctx["data"]["workspace"] = "invalid"
        batch = self.store.begin({"reason": "synthetic invalid workspace", "updates": [ctx]}, True)
        with self.assertRaisesRegex(lumos.Error, "Invalid workspace"):
            self.store.commit(batch["batch"], True)
        self.store.abandon(batch["batch"])

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
        detail = task_detail(self.store, "talk")
        self.assertEqual(detail["document_info"]["plan"]["relation"], "context")
        self.assertEqual(detail["document_info"]["old-plan"]["relation"], "direct")
        self.assertEqual(detail["document_info"]["old-plan"]["context_status"], "archived")

    def test_discussion_relinked_task_reads_current_document_and_preserves_history(self):
        batch = self.store.begin({"reason": "synthetic discussion", "updates": [
            {"id": "discussion", "kind": "context", "data": {
                "title": "专项讨论", "entry": "discussion-note", "status": "active"}}],
            "documents": [{"id": "discussion-note", "path": "work/discussion.md",
                           "title": "讨论结论", "context": "discussion", "role": "understanding"}],
            "links": [["discussion", "mapping", "related"]]}, True)
        Path(batch["candidates"]["discussion-note"]).write_text("已明确：模拟结论；待定：模拟边界", encoding="utf-8")
        self.store.commit(batch["batch"], True)
        # A broad context relation must not pull every sibling discussion into a task.
        self.assertNotIn("discussion-note", task_detail(self.store, "talk")["documents"])
        original = task_detail(self.store, "talk")["task"]["data"]
        save_task(self.store, {**self.request(), "id": "talk", "changes": {
            "context": "discussion", "progress": "已明确：模拟结论；待定：模拟边界", "next_step": "继续澄清边界"}})
        detail = task_detail(self.store, "talk")
        self.assertEqual(set(detail["documents"]), {"discussion-note"})
        self.assertEqual(detail["task"]["data"]["progress"], "已明确：模拟结论；待定：模拟边界")
        self.assertEqual(detail["task"]["data"]["source"], original["source"])
        self.assertEqual(detail["task"]["data"]["status"], original["status"])
        self.assertEqual(detail["history"][0]["before"]["data"]["context"], "mapping")

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
                        {"priority": "urgent"}, {"status": "unknown"}, {"details": []},
                        {"owner": []}, {"owner": "x" * 301}, {"group": []},
                        {"group": "x" * 81}, {"group": "A\nB"}):
            with self.subTest(changes=changes), self.assertRaises(lumos.Error):
                save_task(self.store, self.request(**changes))
            self.assertIsNone(self.store.status()["session"])
        bad = self.request()
        bad["source"]["type"] = "agent"
        with self.assertRaises(lumos.Error):
            save_task(self.store, bad)

    def test_owner_defaults_updates_and_three_priorities(self):
        legacy = task_detail(self.store, "talk")
        self.assertEqual(legacy["task"]["data"]["owner"], "Mango")
        self.assertEqual(legacy["task"]["data"]["priority"], "normal")
        ident = save_task(self.store, self.request())["id"]
        task = task_detail(self.store, ident)
        self.assertEqual(task["task"]["data"]["owner"], "Mango")
        self.assertEqual(task["history"][0]["after"]["data"]["owner"], "Mango")
        for priority in ("low", "normal", "high"):
            request = self.request(owner="  同事  ", priority=priority)
            request["id"] = ident
            save_task(self.store, request)
            row = next(t for t in list_tasks(self.store)["tasks"] if t["id"] == ident)
            self.assertEqual(row["data"]["owner"], "同事")
            self.assertEqual(row["data"]["priority"], priority)
            self.assertEqual("重要事项" in row["attention"], priority == "high")
        request = self.request(progress="仅更新进展")
        request["id"] = ident
        save_task(self.store, request)
        self.assertEqual(task_detail(self.store, ident)["task"]["data"]["owner"], "同事")
        request = self.request(owner="  ")
        request["id"] = ident
        save_task(self.store, request)
        self.assertEqual(task_detail(self.store, ident)["task"]["data"]["owner"], "Mango")

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
        ident = save_task(self.store, self.request(details="模拟完整内容", follow_up="2026-10-21", group="模拟分组"))["id"]
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
        status, raw = call("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), {"app": "lumos", "root": str(self.root)})
        headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{port}", "X-Lumos-Token": board["token"]}
        request = self.request(text="模拟 <script>alert(1)</script>", group="HTTP 分组")
        status, raw = call("POST", "/api/tasks", request, headers)
        self.assertEqual(status, 200, raw)
        ident = json.loads(raw)["id"]
        self.assertEqual(task_detail(self.store, ident)["task"]["data"]["group"], "HTTP 分组")
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

    def test_follow_up_review_pending_and_date_lifecycle(self):
        ident = save_task(self.store, self.request(status='doing', follow_up='2099-01-01', due='2099-02-01'))['id']
        def update(changes, **extra):
            return save_task(self.store, {**self.request(), 'id': ident, 'changes': changes, **extra})
        def data():
            return task_detail(self.store, ident)['task']['data']
        update({'progress': '仅补充进展'})
        self.assertEqual(data()['follow_up'], '2099-01-01')
        req = {**self.request(), 'id': ident, 'changes': {}, 'follow_up_reviewed': True}
        save_task(self.store, req)
        self.assertTrue(save_task(self.store, req)['replayed'])
        self.assertEqual(data()['status'], 'doing')
        self.assertEqual(data()['follow_up'], '')
        self.assertTrue(data()['follow_up_pending'])
        self.assertEqual(data()['due'], '2099-02-01')
        task = next(t for t in list_tasks(self.store)['tasks'] if t['id'] == ident)
        self.assertIn('待设置关心时间', task['attention'])
        update({'progress': '再次补充'})
        self.assertTrue(data()['follow_up_pending'])
        update({'follow_up': '2099-01-02'}, follow_up_reviewed=True)
        self.assertFalse(data()['follow_up_pending'])
        self.assertEqual(data()['follow_up'], '2099-01-02')
        update({'follow_up': ''})
        self.assertTrue(data()['follow_up_pending'])
        for status in ['done', 'cancelled']:
            update({'status': status}, follow_up_reviewed=True)
            self.assertFalse(data()['follow_up_pending'])
            task = next(t for t in list_tasks(self.store)['tasks'] if t['id'] == ident)
            self.assertEqual(task['attention'], [])
        with self.assertRaises(lumos.Error):
            update({}, follow_up_reviewed='true')
        with self.assertRaises(lumos.Error):
            save_task(self.store, {**self.request(), 'follow_up_reviewed': True})
        self.assertIsNone(self.store.status()['session'])
