import json
from pathlib import Path
import shutil
import uuid
import subprocess
import sys
import unittest

import lumos


def fixture():
    return {
        "reason": "ISOLATED SYNTHETIC ACCEPTANCE DATA, not user work history",
        "updates": [
            {"id": "prep", "kind": "context", "data": {"title": "模拟入职准备", "entry": "map", "status": "active"}},
            {"id": "mapping", "kind": "context", "data": {"title": "模拟建图定位", "entry": "plan", "status": "active"}},
            {"id": "assumption", "kind": "evidence", "data": {"context": "mapping", "text": "模拟：同步条件尚未核实", "source": {"type": "user_report", "ref": "fixture:S1"}}},
            {"id": "talk", "kind": "action", "data": {"context": "mapping", "text": "模拟：明天找同事聊同步", "condition": "完成这次交流", "status": "todo", "source": {"type": "user", "ref": "fixture:U1"}}},
        ],
        "documents": [
            {"id": "map", "path": "work/prep.md", "title": "准备地图", "context": "prep", "role": "understanding"},
            {"id": "plan", "path": "work/mapping.md", "title": "定位当前理解", "context": "mapping", "role": "understanding"},
        ],
        "links": [["mapping", "prep", "related"], ["talk", "assumption", "depends_on"], ["plan", "assumption", "derived_from"]],
    }


class BaseStoreCase(unittest.TestCase):
    def setUp(self):
        base = lumos.ENGINE / ".local" / "test-runs"
        base.mkdir(parents=True, exist_ok=True)
        self.area = (base / uuid.uuid4().hex).resolve()
        self.area.mkdir()
        self.addCleanup(self.clean)
        self.root = self.area / "data"
        lumos.initialize(self.root)
        self.store = lumos.Store(self.root)

    def clean(self):
        # Verify the resolved deletion target stays in the test workspace.
        assert self.area.resolve().is_relative_to(lumos.ENGINE / ".local" / "test-runs")
        shutil.rmtree(self.area)

    def seed(self):
        batch = self.store.begin(fixture(), True)
        for ident, path in batch["candidates"].items():
            Path(path).write_text("# 模拟数据\n" + ident + "\n同步与标定尚待核实。", encoding="utf-8")
        self.store.commit(batch["batch"], True)
        return batch

    def edit(self):
        return self.store.begin({"reason": "synthetic edit", "documents": fixture()["documents"]}, True)


class LocalTest(BaseStoreCase):
    def test_context_and_reported_action_completion(self):
        self.seed()
        action = next(n for n in self.store.context("建图定位")["nodes"] if n["id"] == "talk")
        action["data"].update(status="done", completion={"basis": "user_report", "ref": "fixture:聊完了"})
        batch = self.store.begin({"reason": "user reported conversation complete", "updates": [action]}, True)
        self.store.commit(batch["batch"], True)
        result = self.store.context("建图定位")
        done = next(n for n in result["nodes"] if n["id"] == "talk")
        self.assertEqual(done["data"]["status"], "done")
        self.assertNotIn("technical_result", done["data"])
        self.assertIn("尚待核实", result["documents"]["plan"])

    def test_human_edit_preserved_before_commit(self):
        self.seed()
        batch = self.edit()
        Path(batch["candidates"]["plan"]).write_text("Agent candidate", encoding="utf-8")
        (self.root / "work/mapping.md").write_text("Human addition", encoding="utf-8")
        with self.assertRaisesRegex(lumos.Error, "File changed"):
            self.store.commit(batch["batch"], True)
        self.assertEqual((self.root / "work/mapping.md").read_text(), "Human addition")
        self.assertTrue(list((self.root / "candidates" / batch["batch"]).glob("plan.conflict-*")))
        self.assertEqual(self.store.status()["seq"], 1)

    def test_interruption_recovery_at_three_boundaries(self):
        self.seed()
        for point in ["versions", "transaction", "refresh:0"]:
            with self.subTest(point=point):
                batch = self.edit()
                for path in batch["candidates"].values():
                    Path(path).write_text("Updated at " + point, encoding="utf-8")

                def crash(where):
                    if where == point:
                        raise RuntimeError("simulated process interruption")

                with self.assertRaises(RuntimeError):
                    self.store.commit(batch["batch"], True, hook=crash)
                reopened = lumos.Store(self.root)
                reopened.commit(batch["batch"], True)
                self.assertIsNone(reopened.status()["session"])
                self.assertEqual((self.root / "work/mapping.md").read_text(), "Updated at " + point)

    def test_human_edit_after_transaction_preserved(self):
        self.seed()
        batch = self.edit()
        for path in batch["candidates"].values():
            Path(path).write_text("candidate", encoding="utf-8")

        def human(where):
            if where == "transaction":
                (self.root / "work/mapping.md").write_text("late human", encoding="utf-8")

        with self.assertRaisesRegex(lumos.Error, "working copies conflict"):
            self.store.commit(batch["batch"], True, human)
        self.assertEqual((self.root / "work/mapping.md").read_text(), "late human")
        self.store.abandon(batch["batch"])
        merged = self.edit()
        Path(merged["candidates"]["plan"]).write_text("candidate + late human", encoding="utf-8")
        self.store.commit(merged["batch"], True)
        self.assertIn("late human", self.store.context("mapping")["documents"]["plan"])

    def test_single_editor_and_no_silent_claims(self):
        self.seed()
        batch = self.edit()
        with self.assertRaisesRegex(lumos.Error, "session"):
            lumos.Store(self.root).begin({"reason": "competing editor"}, True)
        self.store.abandon(batch["batch"])
        action = next(n for n in self.store.context()["nodes"] if n["id"] == "talk")
        action["data"].update(status="done", technical_result="passed")
        invalid = self.store.begin({"reason": "invalid completion", "updates": [action]}, True)
        with self.assertRaises(lumos.Error):
            self.store.commit(invalid["batch"], True)
        with self.assertRaisesRegex(lumos.Error, "Different edit session"):
            self.store.commit(batch["batch"], True)

    def test_agent_decision_and_unsupported_technical_pass_rejected(self):
        self.seed()
        decision = {"id": "not-a-decision", "kind": "decision", "data": {
            "context": "mapping", "text": "Agent proposal", "scope": "test", "reason": "test",
            "source": {"type": "agent", "ref": "fixture:proposal"}}}
        batch = self.store.begin({"reason": "invalid decision", "updates": [decision]}, True)
        with self.assertRaisesRegex(lumos.Error, "user provenance"):
            self.store.commit(batch["batch"], True)
        self.store.abandon(batch["batch"])
        action = next(n for n in self.store.context()["nodes"] if n["id"] == "talk")
        action["data"].update(status="done", completion={"basis": "user_report", "ref": "fixture:done"},
                              technical_result="passed")
        batch = self.store.begin({"reason": "unsubstantiated technical pass", "updates": [action]}, True)
        with self.assertRaisesRegex(lumos.Error, "Technical pass requires"):
            self.store.commit(batch["batch"], True)
        self.assertEqual(self.store.status()["seq"], 1)

    def test_correction_requires_impact_coverage_and_keeps_history(self):
        self.seed()
        before = next(n for n in self.store.context()["nodes"] if n["id"] == "assumption")
        before["data"]["status"] = "superseded"
        after = {"id": "correction", "kind": "evidence", "data": {
            "context": "mapping", "text": "模拟：只有软件时间戳，硬件同步未知", "reason": "模拟补充澄清",
            "supersedes": "assumption", "source": {"type": "user_report", "ref": "fixture:S2"}}}
        req = {"reason": "synthetic correction", "updates": [before, after],
               "documents": [fixture()["documents"][1]],
               "unlink": [["talk", "assumption", "depends_on"], ["plan", "assumption", "derived_from"]],
               "links": [["talk", "correction", "depends_on"], ["plan", "correction", "derived_from"]]}
        batch = self.store.begin(req, True)
        with self.assertRaisesRegex(lumos.Error, "impact review"):
            self.store.commit(batch["batch"], True)
        self.store.abandon(batch["batch"])
        action = next(n for n in self.store.context()["nodes"] if n["id"] == "talk")
        action["data"].update(status="blocked", waiting="先取得硬件时间戳资料")
        req["updates"].append(action)
        req["reviews"] = [{"id": i, "disposition": "updated", "reason": "模拟纠正影响"} for i in ["plan", "talk"]]
        batch = self.store.begin(req, True)
        Path(batch["candidates"]["plan"]).write_text("# 模拟更正\n只有软件时间戳；硬件同步仍未知。先取得资料。", encoding="utf-8")
        self.store.commit(batch["batch"], True)
        result = self.store.context("mapping")
        self.assertGreater(len(result["history"]), 4)
        self.assertIn("硬件同步仍未知", result["documents"]["plan"])
        self.assertIn(("talk", "correction", "depends_on"), result["links"])
        self.assertNotIn(("talk", "assumption", "depends_on"), result["links"])
        self.assertIn(["talk", "assumption", "depends_on"], result["link_changes"][-1]["removed"])

    def test_missing_immutable_and_unknown_schema_refused(self):
        self.seed()
        path = next((self.root / "versions").rglob("*.blob"))
        path.write_bytes(b"damage")
        with self.assertRaisesRegex(lumos.Error, "damaged version"):
            self.store.context()
        with self.store.db(True) as db:
            db.execute("PRAGMA user_version=99")
        with self.assertRaisesRegex(lumos.Error, "Unsupported schema"):
            lumos.Store(self.root)

    def test_data_root_and_traversal_guards(self):
        with self.assertRaisesRegex(lumos.Error, "ignored"):
            lumos.guard_data_path(lumos.ENGINE / "not-ignored-runtime")
        with self.assertRaises(lumos.Error):
            lumos.safe_path(self.root, "../outside")

    def test_actual_process_exit_and_recovery(self):
        self.seed()
        for point in ["versions", "transaction", "refresh:0"]:
            with self.subTest(point=point):
                batch = self.edit()
                for path in batch["candidates"].values():
                    Path(path).write_text("process-exit " + point, encoding="utf-8")
                code = "import os,sys,lumos; s=lumos.Store(sys.argv[1]); s.commit(sys.argv[2],True,lambda p: os._exit(73) if p==sys.argv[3] else None)"
                crash = subprocess.run([sys.executable, "-c", code, str(self.root), batch["batch"], point], capture_output=True)
                self.assertEqual(crash.returncode, 73, crash.stderr)
                recovered = subprocess.run([sys.executable, str(lumos.ENGINE / "lumos.py"), "--data", str(self.root),
                                            "recover", batch["batch"], "--quiet-files"], capture_output=True)
                self.assertEqual(recovered.returncode, 0, recovered.stderr.decode("utf-8"))
                self.assertEqual((self.root / "work/mapping.md").read_text(), "process-exit " + point)


if __name__ == "__main__":
    unittest.main()
