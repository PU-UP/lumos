import subprocess
import sys
import json

import lumos
import lumos_transfer as transfer
from test_core import BaseStoreCase


class TransferTest(BaseStoreCase):
    def test_backup_and_new_directory_restore_without_cache(self):
        self.seed()
        (self.root / "cache").mkdir()
        (self.root / "cache/unused").write_text("rebuildable")
        (self.root / "work/unregistered.md").write_text("unique human draft")
        snapshot, target = self.area / "backup", self.area / "restored"
        transfer.backup(self.store, snapshot, True)
        transfer.restore(snapshot, target, sandbox=True)
        restored = lumos.Store(target)
        self.assertFalse((target / "cache").exists())
        self.assertEqual((target / "work/unregistered.md").read_text(), "unique human draft")
        self.assertEqual(restored.context("mapping")["documents"], self.store.context("mapping")["documents"])
        batch = restored.begin({"reason": "isolated post-restore change", "updates": [{"id": "after", "kind": "evidence", "data": {
            "context": "mapping", "text": "synthetic post-restore observation", "source": {"type": "agent", "ref": "fixture:restore"}}}]}, True)
        restored.commit(batch["batch"], True)
        result = subprocess.run([sys.executable, str(snapshot / "engine/lumos.py"), "--data", str(target), "context", "mapping"], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8"))
        self.assertIn("after", result.stdout.decode("utf-8"))

    def test_whole_inventory_detects_modify_add_delete(self):
        self.seed()
        for case in ["modify", "add", "delete"]:
            with self.subTest(case=case):
                a, b = self.root / "work/A.md", self.root / "work/B.md"
                a.write_text("old A")
                b.write_text("old B")

                def mutate(point):
                    if point == "copied:work/A.md":
                        if case == "modify":
                            a.write_text("new A")
                            b.write_text("new B")
                        elif case == "add":
                            (self.root / "work/new.md").write_text("added")
                        else:
                            a.unlink()

                snapshot = self.area / case
                with self.assertRaises(lumos.Error):
                    transfer.backup(self.store, snapshot, True, mutate)
                self.assertFalse((snapshot / "COMPLETE").exists())
                self.assertEqual(self.store.control()["mode"], "active")

    def test_snapshot_corruption_and_readonly_restore(self):
        self.seed()
        snapshot, target = self.area / "backup", self.area / "restored"
        transfer.backup(self.store, snapshot, True)
        transfer.restore(snapshot, target)
        with self.assertRaisesRegex(lumos.Error, "Read-only"):
            lumos.Store(target).begin({"reason": "no takeover"}, True)
        (snapshot / "data/work/prep.md").write_text("tampered")
        with self.assertRaisesRegex(lumos.Error, "missing/changed"):
            transfer.restore(snapshot, self.area / "another")

    def migration(self):
        self.seed()
        snapshot, target = self.area / "migration", self.area / "target"
        transfer.migration_start(self.store, snapshot, target, True)
        transfer.restore(snapshot, target, self.root)
        new = lumos.Store(target)
        batch = new.begin({"reason": "synthetic trial change", "updates": [{"id": "trial", "kind": "evidence", "data": {
            "context": "mapping", "text": "独有的试运行变化", "source": {"type": "agent", "ref": "fixture:trial"}}}]}, True)
        new.commit(batch["batch"], True)
        return target, new

    def test_migration_restart_takeover_and_retry(self):
        target, new = self.migration()
        with self.assertRaisesRegex(lumos.Error, "Read-only"):
            lumos.Store(self.root).begin({"reason": "restart must stay frozen"}, True)

        request = self.area / "blocked-request.json"
        request.write_text(json.dumps({"reason": "must not write after restart"}))
        blocked = subprocess.run([sys.executable, str(lumos.ENGINE / "lumos.py"), "--data", str(self.root),
                                  "begin", str(request), "--quiet-files"], capture_output=True)
        self.assertEqual(blocked.returncode, 1)
        self.assertIn("Read-only", blocked.stderr.decode("utf-8"))
        code = "import os,sys,lumos,lumos_transfer as t; t.migration_finish(lumos.Store(sys.argv[1]),sys.argv[2],True,lambda p: os._exit(74))"
        crash = subprocess.run([sys.executable, "-c", code, str(self.root), str(target)], capture_output=True)
        self.assertEqual(crash.returncode, 74, crash.stderr)
        self.assertEqual(lumos.Store(self.root).control()["mode"], "retired")
        self.assertEqual(lumos.Store(target).control()["mode"], "trial")
        transfer.migration_finish(lumos.Store(self.root), target, True)
        transfer.migration_finish(lumos.Store(self.root), target, True)  # idempotent
        self.assertEqual(new.control()["mode"], "active")
        with self.assertRaises(lumos.Error):
            transfer.migration_cancel(self.store, True)

    def test_cancel_preserves_trial_and_stops_it_before_old_unfreezes(self):
        target, new = self.migration()

        def interrupt(point):
            if point == "target_cancelled":
                raise RuntimeError("process interruption")

        with self.assertRaises(RuntimeError):
            transfer.migration_cancel(self.store, True, interrupt)
        self.assertEqual(new.control()["mode"], "cancelled")
        self.assertEqual(self.store.control()["mode"], "frozen")
        result = transfer.migration_cancel(lumos.Store(self.root), True)
        self.assertEqual(result["source"], "active")
        self.assertTrue((target / "CANCELLED-TRIAL.json").exists())
        self.assertIn("trial", [n["id"] for n in new.context("mapping")["nodes"]])
        self.assertNotIn("trial", [n["id"] for n in self.store.context("mapping")["nodes"]])
        with self.assertRaises(lumos.Error):
            new.begin({"reason": "cancelled target must stay stopped"}, True)
        with self.assertRaises(lumos.Error):
            transfer.restore(self.area / "migration", self.area / "other", self.root)

    def test_failed_migration_snapshot_stays_frozen_until_cancel(self):
        self.seed()

        def mutate(point):
            if point == "before_complete":
                (self.root / "work/new.md").write_text("late write")

        with self.assertRaises(lumos.Error):
            transfer.migration_start(self.store, self.area / "bad", self.area / "target", True, mutate)
        self.assertEqual(lumos.Store(self.root).control()["mode"], "frozen")
        self.assertFalse((self.area / "bad/COMPLETE").exists())
        transfer.migration_cancel(self.store, True)
        self.assertEqual(self.store.control()["mode"], "active")

    def test_snapshot_pending_session_and_no_manual_pause_refused(self):
        self.seed()
        with self.assertRaises(lumos.Error):
            transfer.backup(self.store, self.area / "a")
        batch = self.edit()
        with self.assertRaisesRegex(lumos.Error, "session"):
            transfer.backup(self.store, self.area / "b", True)
        self.store.abandon(batch["batch"])

    def test_cancellation_after_interrupted_takeover(self):
        target, new = self.migration()

        def crash(point):
            raise RuntimeError("interrupted takeover")

        with self.assertRaises(RuntimeError):
            transfer.migration_finish(self.store, target, True, crash)
        transfer.migration_cancel(lumos.Store(self.root), True)
        self.assertEqual(self.store.control()["mode"], "active")
        self.assertEqual(new.control()["mode"], "cancelled")
