"""Consistent bundles and explicit local single-writer migration."""
from contextlib import closing, ExitStack
from pathlib import Path
import os
import sqlite3
import subprocess
import uuid

from lumos import (ENGINE, SCHEMA, Error, Store, atomic, digest, guard_data_path,
                   now, process_lock, read_json, require, safe_path, write_json)

RUNTIME_EXCLUDES = {".lock", "control.json", "lumos.sqlite3", "lumos.sqlite3-wal",
                    "lumos.sqlite3-shm", "lumos.sqlite3-journal", "cache"}


def inventory(root, excludes=()):
    result = {}
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in list(dirs) + names:
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            if relative.split("/")[0] in excludes:
                if name in dirs:
                    dirs.remove(name)
                continue
            safe_path(root, relative)  # refuse symlinks/junctions, including directories
            if path.is_file():
                content = path.read_bytes()
                result[relative] = {"size": len(content), "sha256": digest(content)}
    return result


def engine_inventory():
    git = subprocess.run(["git", "-C", str(ENGINE), "rev-parse", "--show-toplevel"],
                         capture_output=True, text=True)
    if git.returncode == 0 and Path(git.stdout.strip()).resolve() == ENGINE:
        files = subprocess.check_output(["git", "-C", str(ENGINE), "ls-files", "-z", "--cached",
                                         "--others", "--exclude-standard"]).decode().split("\0")
        commit = subprocess.check_output(["git", "-C", str(ENGINE), "rev-parse", "HEAD"]).decode().strip()
        dirty = bool(subprocess.check_output(["git", "-C", str(ENGINE), "status", "--porcelain"]).strip())
    else:
        saved = read_json(ENGINE / "engine-files.json")
        files, commit, dirty = saved["files"], saved["commit"], saved["dirty"]
    result = {}
    for relative in sorted(set(files) - {"", "engine-files.json"}):
        path = safe_path(ENGINE, relative)
        if path.is_file():
            content = path.read_bytes()
            result[relative] = {"size": len(content), "sha256": digest(content)}
    return result, commit, dirty


def copy_inventory(source, target, files, hook=None):
    for relative, expected in sorted(files.items()):
        content = safe_path(source, relative).read_bytes()
        require(digest(content) == expected["sha256"], f"Changed during copy: {relative}")
        atomic(safe_path(target, relative), content)
        if hook:
            hook("copied:" + relative)


def _snapshot(store, destination, hook=None):
    destination = guard_data_path(destination)
    require(not destination.is_relative_to(store.root) and not store.root.is_relative_to(destination),
            "Snapshot must be outside its data source")
    require(not destination.exists(), "Snapshot destination must not exist")
    store.idle()
    store.verify()
    destination.mkdir(parents=True)
    before = inventory(store.root, RUNTIME_EXCLUDES)
    engine_before, commit, dirty = engine_inventory()
    with store.db() as db:
        seq = store.seq(db)
        data = destination / "data"
        data.mkdir()
        with closing(sqlite3.connect(data / "lumos.sqlite3")) as target:
            db.backup(target)
    copy_inventory(store.root, data, before, hook)
    copy_inventory(ENGINE, destination / "engine", engine_before)
    write_json(destination / "engine" / "engine-files.json",
               {"files": list(engine_before), "commit": commit, "dirty": dirty})
    require(before == inventory(store.root, RUNTIME_EXCLUDES), "Whole file set changed; incomplete snapshot")
    require(before == inventory(data, {"lumos.sqlite3"}), "Copied file set mismatch")
    require((engine_before, commit, dirty) == engine_inventory(), "Engine changed during snapshot")
    with store.db() as db:
        require(store.seq(db) == seq, "Database changed during snapshot")
    check = Store(data)
    check.verify()
    manifest = {"format": 1, "schema": SCHEMA, "at": now(), "source": store.control(),
                "seq": seq, "engine_commit": commit, "engine_dirty": dirty,
                "data": inventory(data), "engine": inventory(destination / "engine")}
    write_json(destination / "manifest.json", manifest)
    if hook:
        hook("before_complete")
    # Full recheck also catches mutations injected after the first post-copy scan.
    require(before == inventory(store.root, RUNTIME_EXCLUDES), "Source changed before completion")
    require((engine_before, commit, dirty) == engine_inventory(), "Engine changed before completion")
    atomic(destination / "COMPLETE", digest((destination / "manifest.json").read_bytes()).encode())
    return {"snapshot": str(destination), "seq": seq, "complete": True,
            "off_device_protection": False}


def backup(store, destination, quiet=False, hook=None):
    require(quiet, "Pause all writers including editors/autosave; pass --quiet-files")
    with process_lock(store.root):
        store.writable()
        return _snapshot(store, destination, hook)


def verify_snapshot(snapshot):
    snapshot = Path(snapshot).resolve()
    require((snapshot / "COMPLETE").is_file(), "Incomplete snapshot: no COMPLETE marker")
    require((snapshot / "COMPLETE").read_text() == digest((snapshot / "manifest.json").read_bytes()),
            "Snapshot manifest checksum mismatch")
    manifest = read_json(snapshot / "manifest.json")
    require(manifest["schema"] == SCHEMA and manifest["format"] == 1, "Unsupported snapshot format/schema")
    require(inventory(snapshot / "data") == manifest["data"], "Snapshot data missing/changed")
    require(inventory(snapshot / "engine") == manifest["engine"], "Snapshot engine missing/changed")
    Store(snapshot / "data").verify()
    return manifest


def migration_start(store, destination, target, quiet=False, hook=None):
    require(quiet, "Pause all writers; pass --quiet-files")
    target = guard_data_path(target)
    destination = guard_data_path(destination)
    require(not target.exists(), "Migration target must not exist")
    require(not target.is_relative_to(store.root) and not store.root.is_relative_to(target), "Overlapping locations")
    require(not target.is_relative_to(destination) and not destination.is_relative_to(target), "Snapshot/target overlap")
    require(not destination.exists(), "Snapshot destination already exists")
    with process_lock(store.root):
        control = store.writable()
        require(control["mode"] == "active", "Only the formal active location can start migration")
        store.idle()
        control.update(mode="frozen", migration={"id": uuid.uuid4().hex, "target": str(target),
                                                "snapshot": str(destination), "at": now()})
        store.set_control(control)
        # Failure intentionally leaves old location frozen; explicit cancellation unfreezes it.
        result = _snapshot(store, destination, hook)
        return {**result, "migration": control["migration"], "old_mode": "frozen"}


def restore(snapshot, target, source=None, sandbox=False):
    snapshot = Path(snapshot).resolve()
    target = guard_data_path(target)
    require(not target.exists(), "Restore target must not exist")
    require(not target.is_relative_to(snapshot) and not snapshot.is_relative_to(target), "Overlapping restore paths")
    manifest = verify_snapshot(snapshot)
    require(not (source and sandbox), "Choose migration restore OR isolated sandbox")
    with ExitStack() as stack:
        old = Store(source) if source else None
        if old:
            stack.enter_context(process_lock(old.root))
            ctl = old.control()
            migration = ctl.get("migration", {})
            require(ctl["mode"] == "frozen" and migration.get("target") == str(target),
                    "Source not frozen for this exact target")
            require(migration.get("id") == manifest["source"].get("migration", {}).get("id")
                    and ctl["id"] == manifest["source"]["id"], "Snapshot does not belong to this migration")
        target.mkdir(parents=True)
        # A failed restore stays explicitly non-writable, even if a DB was already copied.
        control = {"id": manifest["source"]["id"], "mode": "restoring", "bound_root": str(target),
                   "restored_at": now(), "snapshot": str(snapshot)}
        if old:
            control["migration"] = {**migration, "source": str(old.root)}
        write_json(target / "control.json", control)
        copy_inventory(snapshot / "data", target, manifest["data"])
        require(inventory(target, {"control.json"}) == manifest["data"], "Restore file set mismatch")
        restored = Store(target)
        restored.verify()
        with restored.db() as db:
            require(restored.seq(db) == manifest["seq"], "Restore database revision mismatch")
        control["mode"] = "trial" if old else ("sandbox" if sandbox else "readonly")
        restored.set_control(control)
        (target / "incoming").mkdir(exist_ok=True)
        return {"root": str(target), "mode": control["mode"], "seq": manifest["seq"],
                "engine": str(snapshot / "engine"), "note": "Sandbox is isolated, never a second formal location"}


def migration_finish(old, target, quiet=False, hook=None):
    require(quiet, "Pause all writers at both locations; pass --quiet-files")
    new = Store(target)
    with ExitStack() as stack:
        for root in sorted({old.root, new.root}, key=str):
            stack.enter_context(process_lock(root))
        before, after = old.control(), new.control()
        migration = before.get("migration", {})
        require(before["mode"] in {"frozen", "retired"}, "Source is not migrating")
        require(migration.get("target") == str(new.root) and
                migration.get("id") == after.get("migration", {}).get("id") and
                after.get("migration", {}).get("source") == str(old.root), "Migration identity mismatch")
        require(after["mode"] in {"trial", "active"}, "Target is not ready")
        old.idle()
        new.idle()
        new.verify()
        if after["mode"] == "active":
            require(before["mode"] == "retired", "Invalid double-active state")
            return {"source": "retired", "target": "active"}
        with new.db() as db:
            source_seq = verify_snapshot(before["migration"]["snapshot"])["seq"]
            require(new.seq(db) > source_seq, "Save and verify one trial change before takeover")
        # Source retires FIRST. Interruption leaves zero formal writers, never two.
        before["mode"] = "retired"
        old.set_control(before)
        if hook:
            hook("source_retired")
        after["mode"] = "active"
        after["accepted_at"] = now()
        new.set_control(after)
        return {"source": "retired", "target": "active", "trial_changes_retained": True}


def migration_cancel(old, quiet=False, hook=None):
    require(quiet, "Pause writers at both locations; pass --quiet-files")
    # Read target for lock ordering; recheck migration under both locks below.
    initial = old.control()
    require(initial["mode"] in {"frozen", "retired"}, "Only an unaccepted migration can be cancelled")
    target = Path(initial["migration"]["target"])
    require(initial["mode"] != "retired" or target.exists(), "Inspect the handoff target before cancelling")
    with ExitStack() as stack:
        for root in sorted({old.root, *([target] if target.exists() else [])}, key=str):
            stack.enter_context(process_lock(root))
        control = old.control()
        require(control == initial, "Migration changed; retry")
        archive = None
        if target.exists():
            if (target / "control.json").exists():
                target_ctl = read_json(target / "control.json")
                require(target_ctl.get("migration", {}).get("id") == control["migration"]["id"] and
                        target_ctl["mode"] in {"trial", "restoring", "cancelled"}, "Target not cancellable")
            else:
                # Restore may have died just after mkdir. Without control it cannot write via Store.
                target_ctl = {"id": control["id"], "bound_root": str(target),
                              "migration": control["migration"]}
            target_ctl.update(mode="cancelled", cancelled_at=now())
            write_json(target / "control.json", target_ctl)
            # Keep ALL trial files/batches in place; an immutable non-authoritative archive, no deletion.
            write_json(target / "CANCELLED-TRIAL.json", {"authority": False, "at": now(),
                       "source": str(old.root), "snapshot": control["migration"]["snapshot"],
                       "instruction": "Do not resume here. Review unique trial changes and reapply to the active location."})
            archive = str(target)
        if hook:
            hook("target_cancelled")
        control["mode"] = "active"
        control["last_cancelled_migration"] = control.pop("migration")
        old.set_control(control)
        return {"source": "active", "target": "cancelled" if target.exists() else "absent",
                "non_authoritative_trial_archive": archive,
                "note": "Trial changes were NOT imported into the source"}
