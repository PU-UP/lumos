"""Small local working-memory store. Python 3.12+, standard library only."""
from __future__ import annotations

import argparse
from contextlib import contextmanager, closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import subprocess
import sys
import uuid

if __name__ == "__main__":
    sys.modules["lumos"] = sys.modules[__name__]
    sys.dont_write_bytecode = True  # Running a bundled engine must not mutate the backup.

ENGINE = Path(__file__).resolve().parent
SCHEMA = 1
KINDS = {"context", "evidence", "decision", "action", "document"}
RELATIONS = {"related", "supports", "refutes", "depends_on", "derived_from", "supersedes"}


class Error(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Error(message)


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with tmp.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def write_json(path, value):
    atomic(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())


def safe_path(root, relative):
    require(isinstance(relative, str) and "\\" not in relative and ":" not in relative,
            "Use a relative POSIX path without drive or backslashes")
    parts = PurePosixPath(relative).parts
    require(parts and not relative.startswith("/") and ".." not in parts, "Unsafe path")
    target = root.joinpath(*parts)
    for p in [target, *target.parents]:
        if p == root.parent:
            break
        require(not p.is_symlink() and not p.is_junction(), f"Linked path refused: {p}")
    require(target.resolve().is_relative_to(root.resolve()), "Path escapes data root")
    return target


def guard_data_path(path):
    """Check directory policy, not just database extensions."""
    path = Path(path).resolve()
    require(not ENGINE.is_relative_to(path), "Data cannot contain the engine")
    probe = path
    while not probe.exists():
        probe = probe.parent
    repo = subprocess.run(["git", "-C", str(probe), "rev-parse", "--show-toplevel"],
                          capture_output=True, text=True)
    if repo.returncode == 0:
        base = Path(repo.stdout.strip()).resolve()
        rel = path.relative_to(base).as_posix()
        ignored = subprocess.run(["git", "-C", str(base), "check-ignore", "-q", "--",
                                  rel + "/LUMOS-DATA-PROBE.md"])
        require(ignored.returncode == 0, f"Data directory must be ignored by Git: {path}")
        tracked = subprocess.check_output(["git", "-C", str(base), "ls-files", "--", rel])
        require(not tracked.strip(), f"Data directory contains tracked files: {path}")
    return path


@contextmanager
def process_lock(root):
    """OS releases this lock on a crash; session.json survives across commands."""
    with (root / ".lock").open("a+b") as stream:
        stream.seek(0)
        if stream.read(1) == b"":
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise Error("Another tool operation holds the data lock") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def initialize(root):
    root = guard_data_path(root)
    require(not root.exists() or not any(root.iterdir()), "Initialize only an empty directory")
    root.mkdir(parents=True, exist_ok=True)
    (root / "incoming").mkdir()
    with closing(sqlite3.connect(root / "lumos.sqlite3")) as db:
        db.executescript("""
            PRAGMA user_version=1;
            CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE links(src TEXT REFERENCES nodes(id), dst TEXT REFERENCES nodes(id),
                               relation TEXT, PRIMARY KEY(src,dst,relation));
            CREATE TABLE batches(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE,
                                 at TEXT, reason TEXT, manifest TEXT);
            CREATE TABLE history(batch TEXT REFERENCES batches(id), node TEXT,
                                 before TEXT, after TEXT);
        """)
    write_json(root / "control.json", {"id": uuid.uuid4().hex, "mode": "active",
                                       "bound_root": str(root), "created": now()})
    return {"root": str(root), "mode": "active"}


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        require((self.root / "lumos.sqlite3").is_file(), "Data store missing; use init or restore")
        with self.db() as db:
            require(db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA,
                    "Unsupported schema; refusing access, restore matching engine/data")

    @contextmanager
    def db(self, write=False):
        # ponytail: one SQLite connection per operation; no pool or service needed.
        uri = (self.root / "lumos.sqlite3").as_uri() + ("?mode=rw" if write else "?mode=ro")
        db = sqlite3.connect(uri, uri=True, timeout=5)
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def control(self):
        return read_json(self.root / "control.json")

    def set_control(self, value):
        write_json(self.root / "control.json", value)

    def writable(self):
        guard_data_path(self.root)
        ctl = self.control()
        require(ctl["bound_root"] == str(self.root), "Copied/moved live store: restore explicitly")
        require(ctl["mode"] in {"active", "trial", "sandbox"},
                f"Read-only location: {ctl['mode']}")
        return ctl

    def idle(self):
        require(not (self.root / "session.json").exists(), "Finish/recover/abandon edit session first")

    def seq(self, db):
        return db.execute("SELECT coalesce(max(seq),0) FROM batches").fetchone()[0]

    def nodes(self, db):
        return {i: {"id": i, "kind": k, "data": json.loads(d)}
                for i, k, d in db.execute("SELECT id,kind,data FROM nodes ORDER BY id")}

    def status(self):
        with self.db() as db:
            return {"root": str(self.root), "control": self.control(), "seq": self.seq(db),
                    "session": read_json(self.root / "session.json")
                    if (self.root / "session.json").exists() else None}

    def begin(self, request, quiet=False):
        require(quiet, "Pause manual editing/autosave first; pass --quiet-files")
        require(isinstance(request, dict) and request.get("reason"), "Batch needs a reason")
        require(set(request) <= {"reason", "updates", "documents", "links", "unlink", "reviews"},
                "Unknown batch fields")
        with process_lock(self.root):
            return self._begin(request)

    def _begin(self, request):
        self.writable()
        self.idle()
        with self.db() as db:
            seq, nodes = self.seq(db), self.nodes(db)
        batch = uuid.uuid4().hex
        folder = self.root / "candidates" / batch
        folder.mkdir(parents=True)
        docs = []
        seen = set()
        for spec in request.get("documents", []):
            spec = dict(spec)
            ident = spec["id"]
            require(re.fullmatch(r"[A-Za-z0-9_-]+", ident), "Invalid document ID")
            require(ident.casefold() not in seen, "Duplicate document ID (case-insensitive)")
            seen.add(ident.casefold())
            path = spec["path"]
            require(PurePosixPath(path).parts[0] in {"work", "raw", "output"},
                    "Work files belong in work/, raw/ or output/")
            target = safe_path(self.root, path)
            old = nodes.get(ident)
            if old:
                require(old["kind"] == "document" and old["data"]["path"] == path,
                        "Document IDs and paths stay stable; use a new ID for a new file")
            require(not target.exists() or target.is_file(), "Document target is not a file")
            content = target.read_bytes() if target.exists() else None
            if content is not None:
                atomic(folder / (ident + ".base"), content)
            atomic(folder / (ident + ".candidate"), content or b"")
            spec["baseline"] = digest(content) if content is not None else None
            docs.append(spec)
        manifest = {"id": batch, "base_seq": seq, "at": now(), "request": request,
                    "documents": docs}
        write_json(folder / "batch.json", manifest)
        write_json(self.root / "session.json", {"batch": batch})
        return {"batch": batch, "candidates": {d["id"]: str(folder / (d["id"] + ".candidate"))
                                                 for d in docs}}

    def batch(self, ident):
        require(re.fullmatch(r"[a-f0-9]{32}", ident), "Invalid batch ID")
        return self.root / "candidates" / ident

    def conflict(self, folder, spec, current):
        name = spec["id"] + ".conflict-" + uuid.uuid4().hex
        if current is not None:
            atomic(folder / name, current)
        write_json(folder / (name + ".json"), {"path": spec["path"], "at": now(),
                                                "missing": current is None})

    def compare(self, folder, spec):
        path = safe_path(self.root, spec["path"])
        current = path.read_bytes() if path.is_file() else None
        if (digest(current) if current is not None else None) != spec["baseline"]:
            self.conflict(folder, spec, current)
            raise Error(f"File changed since read; preserve/merge baseline + candidate + current: {spec['path']}")

    def validate(self, old, nodes, request, links, prior_links=()):
        for ident, node in nodes.items():
            require(re.fullmatch(r"[A-Za-z0-9_-]+", ident), "Invalid node ID")
            kind, data = node["kind"], node["data"]
            require(kind in KINDS and isinstance(data, dict), "Invalid node kind/data")
            require(data.get("title") or data.get("text"), f"Missing title/text: {ident}")
            if kind == "context":
                from lumos_tasks import WORKSPACES
                require(data.get("workspace", "lingguang") in WORKSPACES, "Invalid workspace")
                require(data.get("status", "active") in {"active", "waiting", "retained", "archived"},
                        "Invalid context status")
                require(data.get("entry") in nodes and nodes[data["entry"]]["kind"] == "document",
                        f"Context needs an entry document: {ident}")
            else:
                require(data.get("context") in nodes and nodes[data["context"]]["kind"] == "context",
                        f"Missing context for {ident}")
            if kind in {"evidence", "decision", "action"}:
                source = data.get("source", {})
                require(source.get("type") in {"user", "user_report", "source", "agent"}
                        and source.get("ref"), f"Source type/ref required: {ident}")
            if kind == "decision":
                require(data["source"]["type"] == "user" and data.get("reason") and data.get("scope"),
                        "A decision requires user provenance, reason and scope")
                require(data.get("status", "current") in {"current", "superseded"}, "Invalid decision status")
            if kind == "action":
                from lumos_tasks import validate_fields
                validate_fields(data)
                require(data["source"]["type"] != "agent", "Suggestions are not committed actions")
                require(data.get("condition"), "Agent must infer a minimal action completion condition")
                require(data.get("status") in {"todo", "doing", "blocked", "done", "cancelled"}, "Invalid action status")
                if data["status"] == "done":
                    evidence = data.get("completion", {})
                    require(evidence.get("basis") in {"user_report", "observed"} and evidence.get("ref"),
                            "Completion needs explicit report/observation provenance")
                if data.get("technical_result") == "passed":
                    require(data.get("acceptance") and data.get("result_evidence"),
                            "Technical pass requires acceptance conditions and evidence")
            if kind == "document":
                require(data.get("version") and data.get("sha256"), "Document must go through candidate save")
        documents = [n for n in nodes.values() if n["kind"] == "document"]
        document_ids = [n["id"].casefold() for n in documents]
        require(len(document_ids) == len(set(document_ids)), "Duplicate document ID (case-insensitive)")
        paths = [str(safe_path(self.root, n["data"]["path"]).resolve()).casefold() for n in documents]
        require(len(paths) == len(set(paths)), "Two document IDs cannot own the same path")
        for src, dst, relation in links:
            require(src in nodes and dst in nodes and relation in RELATIONS, "Invalid link")
        # A semantic review remains the Agent's job; the tool enforces explicit coverage.
        reviews = {r["id"]: r for r in request.get("reviews", [])}
        changed = {i for i in nodes if nodes[i] != old.get(i)}
        for ident in changed:
            data = nodes[ident]["data"]
            replaced = data.get("supersedes")
            if replaced:
                require(replaced in old and replaced != ident and data.get("reason"), "Invalid correction")
                require(old[replaced]["kind"] == nodes[ident]["kind"], "Correction changes record kind")
                require(nodes[replaced]["data"].get("status") == "superseded", "Retire replaced record explicitly")
                affected = {src for src, dst, _ in set(links) | set(prior_links) if dst == replaced}
                ctx = old[replaced]["data"].get("context")
                if ctx:
                    affected.add(nodes[ctx]["data"]["entry"])
                for target in affected - {ident, replaced}:
                    review = reviews.get(target, {})
                    require(review.get("reason") and review.get("disposition") in {"updated", "unchanged"},
                            f"Correction requires impact review: {target}")
                    require(review["disposition"] != "updated" or target in changed,
                            f"Claimed updated but unchanged: {target}")

    def commit(self, ident, quiet=False, hook=None):
        require(quiet, "Pause manual editing/autosave; pass --quiet-files")
        with process_lock(self.root):
            return self._commit(ident, hook)

    def _commit(self, ident, hook=None):
        self.writable()
        folder = self.batch(ident)
        require(read_json(self.root / "session.json")["batch"] == ident, "Different edit session")
        with self.db() as db:
            committed = db.execute("SELECT manifest FROM batches WHERE id=?", (ident,)).fetchone()
        if committed:
            return self._refresh(json.loads(committed[0]), hook)
        manifest = read_json(folder / "batch.json")
        request = manifest["request"]
        with self.db() as db:
            require(self.seq(db) == manifest["base_seq"], "Stale database baseline")
            old = self.nodes(db)
            links = set(db.execute("SELECT src,dst,relation FROM links"))
        prior_links = links.copy()
        nodes = json.loads(json.dumps(old))
        seen = set()
        for update in request.get("updates", []):
            ident_node = update["id"]
            require(ident_node not in seen and update["kind"] != "document", "Duplicate/invalid update")
            require(ident_node not in old or old[ident_node]["kind"] == update["kind"], "Cannot change node kind")
            seen.add(ident_node)
            nodes[ident_node] = update
        for spec in manifest["documents"]:
            self.compare(folder, spec)
            content = (folder / (spec["id"] + ".candidate")).read_bytes()
            version = f"versions/{ident}/{spec['id']}.blob"
            spec.update(version=version, sha256=digest(content))
            data = {k: v for k, v in spec.items() if k not in {"id", "baseline"}}
            nodes[spec["id"]] = {"id": spec["id"], "kind": "document", "data": data}
        links.update(tuple(link) for link in request.get("links", []))
        removed = {tuple(link) for link in request.get("unlink", [])}
        require(removed <= prior_links, "Can only unlink existing relationships")
        require(all(link[2] != "supersedes" for link in removed), "Replacement history cannot be unlinked")
        require(not removed.intersection(tuple(link) for link in request.get("links", [])),
                "Cannot add and remove the same relationship")
        links.difference_update(removed)
        for node in nodes.values():
            if node["data"].get("supersedes"):
                links.add((node["id"], node["data"]["supersedes"], "supersedes"))
        self.validate(old, nodes, request, links, prior_links)
        for spec in manifest["documents"]:
            path = safe_path(self.root, spec["version"])
            content = (folder / (spec["id"] + ".candidate")).read_bytes()
            require(digest(content) == spec["sha256"], "Candidate changed during save")
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists():
                require(digest(path.read_bytes()) == spec["sha256"], "Staged version differs; abandon and start again")
            else:
                with path.open("xb") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
        if hook:
            hook("versions")
        for spec in manifest["documents"]:
            self.compare(folder, spec)
        with self.db(True) as db:
            db.execute("BEGIN IMMEDIATE")
            require(self.seq(db) == manifest["base_seq"], "Stale database baseline")
            db.execute("INSERT INTO batches(id,at,reason,manifest) VALUES(?,?,?,?)",
                       (ident, now(), request["reason"], json.dumps(manifest, ensure_ascii=False)))
            for key, node in nodes.items():
                if old.get(key) != node:
                    db.execute("INSERT INTO nodes VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                               (key, node["kind"], json.dumps(node["data"], ensure_ascii=False)))
                    db.execute("INSERT INTO history VALUES(?,?,?,?)", (ident, key,
                               json.dumps(old.get(key), ensure_ascii=False), json.dumps(node, ensure_ascii=False)))
            db.executemany("DELETE FROM links WHERE src=? AND dst=? AND relation=?", sorted(removed))
            db.executemany("INSERT OR IGNORE INTO links VALUES(?,?,?)", sorted(links))
        if hook:
            hook("transaction")
        return self._refresh(manifest, hook)

    def _refresh(self, manifest, hook=None):
        folder = self.batch(manifest["id"])
        conflicts = []
        for index, spec in enumerate(manifest["documents"]):
            path = safe_path(self.root, spec["path"])
            content = safe_path(self.root, spec["version"]).read_bytes()
            require(digest(content) == spec["sha256"], "Committed version damaged")
            current = path.read_bytes() if path.is_file() else None
            value = digest(current) if current is not None else None
            if value == spec["sha256"]:
                continue
            if value != spec["baseline"]:
                self.conflict(folder, spec, current)
                conflicts.append(spec["path"])
                continue
            atomic(path, content)
            if hook:
                hook(f"refresh:{index}")
        require(not conflicts, f"Committed, but working copies conflict: {conflicts}; preserve and merge")
        self.verify()
        (self.root / "session.json").unlink()
        return {"batch": manifest["id"], "status": "committed-and-readback-verified"}

    def abandon(self, ident):
        with process_lock(self.root):
            self.writable()
            require(read_json(self.root / "session.json")["batch"] == ident, "Different session")
            with self.db() as db:
                committed = bool(db.execute("SELECT 1 FROM batches WHERE id=?", (ident,)).fetchone())
            (self.root / "session.json").unlink()
            return {"batch": ident, "committed": committed, "candidates_retained": True,
                    "note": "Does not undo committed records; merge in a new batch"}

    def verify(self):
        drafts = []
        with self.db() as db:
            require(db.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "Database integrity failure")
            require(not db.execute("PRAGMA foreign_key_check").fetchall(), "Broken database references")
            nodes = self.nodes(db)
            manifests = [json.loads(row[0]) for row in db.execute("SELECT manifest FROM batches")]
            links = set(db.execute("SELECT src,dst,relation FROM links"))
        self.validate(nodes, nodes, {}, links)
        for manifest in manifests:
            for spec in manifest["documents"]:
                path = safe_path(self.root, spec["version"])
                require(path.is_file() and digest(path.read_bytes()) == spec["sha256"],
                        f"Missing/damaged version: {spec['version']}")
        registered = set()
        for node in nodes.values():
            if node["kind"] == "document":
                data = node["data"]
                version = safe_path(self.root, data["version"])
                require(version.is_file() and digest(version.read_bytes()) == data["sha256"],
                        f"Missing/damaged current version: {node['id']}")
                path = safe_path(self.root, data["path"])
                registered.add(data["path"])
                if not path.is_file() or digest(path.read_bytes()) != data["sha256"]:
                    drafts.append(data["path"])
        unregistered = []
        for directory in ("work", "raw", "output"):
            for path in (self.root / directory).rglob("*"):
                if path.is_file() and path.relative_to(self.root).as_posix() not in registered:
                    unregistered.append(path.relative_to(self.root).as_posix())
        return {"integrity": "ok", "drafts_or_missing_working_copies": drafts,
                "unregistered_files": unregistered, "nodes": len(nodes)}

    def context(self, question=""):
        with process_lock(self.root):
            return self._context(question)

    def _context(self, question=""):
        integrity = self.verify()
        with self.db() as db:
            nodes = self.nodes(db)
            links = list(db.execute("SELECT src,dst,relation FROM links ORDER BY src,dst"))
            contexts = [n for n in nodes.values() if n["kind"] == "context"]
            matched = [n for n in contexts if not question or question.casefold() in
                       (n["id"] + json.dumps(n["data"], ensure_ascii=False)).casefold()]
            # ponytail: substring search + explicit IDs; no embeddings until a real search gap.
            if question and not matched:
                ids = {n["data"].get("context") for n in nodes.values()
                       if question.casefold() in json.dumps(n, ensure_ascii=False).casefold()}
                matched = [n for n in contexts if n["id"] in ids]
            ids = {n["id"] for n in matched}
            selected = {i: n for i, n in nodes.items() if i in ids or n["data"].get("context") in ids}
            for src, dst, _ in links:
                if src in selected and dst not in selected:
                    selected[dst] = nodes[dst]
            documents = {}
            for i, node in selected.items():
                if node["kind"] == "document":
                    data = node["data"]
                    if data["path"].endswith(".md"):
                        documents[i] = safe_path(self.root, data["version"]).read_text(encoding="utf-8")
            history = [{"batch": b, "node": i, "at": at, "reason": reason,
                        "before": json.loads(before), "after": json.loads(after)}
                       for b, i, before, after, at, reason in db.execute(
                           "SELECT h.batch,h.node,h.before,h.after,b.at,b.reason FROM history h "
                           "JOIN batches b ON b.id=h.batch ORDER BY h.rowid")
                       if i in selected]
            link_changes = []
            for batch_id, at, reason, raw in db.execute("SELECT id,at,reason,manifest FROM batches ORDER BY seq"):
                request = json.loads(raw)["request"]
                added = [r for r in request.get("links", []) if r[0] in selected or r[1] in selected]
                removed = [r for r in request.get("unlink", []) if r[0] in selected or r[1] in selected]
                if added or removed:
                    link_changes.append({"batch": batch_id, "at": at, "reason": reason,
                                         "added": added, "removed": removed})
        return {"status": self.status(), "integrity": integrity, "matches": [n["id"] for n in matched],
                "index": contexts, "nodes": list(selected.values()), "documents": documents,
                "links": [r for r in links if r[0] in selected], "history": history, "link_changes": link_changes,
                "notice": "No match is not memory. Dates are recorded evidence dates, not a freshness guarantee."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path(os.environ.get("LUMOS_DATA", ENGINE / "lumos-data")))
    subs = parser.add_subparsers(dest="command", required=True)
    for name in ["init", "status", "verify"]:
        subs.add_parser(name)
    command = subs.add_parser("context")
    command.add_argument("question", nargs="?", default="")
    command = subs.add_parser("tasks")
    command.add_argument("--today", help="YYYY-MM-DD, defaults to Asia/Shanghai")
    command = subs.add_parser("task")
    command.add_argument("id")
    command = subs.add_parser("task-save")
    command.add_argument("request", type=Path)
    command = subs.add_parser("serve")
    command.add_argument("--port", type=int, default=8765)
    command = subs.add_parser("begin")
    command.add_argument("request", type=Path)
    command.add_argument("--quiet-files", action="store_true")
    for name in ["commit", "recover", "abandon"]:
        command = subs.add_parser(name)
        command.add_argument("batch")
        if name != "abandon":
            command.add_argument("--quiet-files", action="store_true")
    command = subs.add_parser("backup")
    command.add_argument("destination", type=Path)
    command.add_argument("--quiet-files", action="store_true")
    command = subs.add_parser("restore")
    command.add_argument("snapshot", type=Path)
    command.add_argument("--source", type=Path)
    command.add_argument("--sandbox", action="store_true")
    command = subs.add_parser("migrate-start")
    command.add_argument("snapshot", type=Path)
    command.add_argument("target", type=Path)
    command.add_argument("--quiet-files", action="store_true")
    command = subs.add_parser("migrate-finish")
    command.add_argument("target", type=Path)
    command.add_argument("--quiet-files", action="store_true")
    command = subs.add_parser("migrate-cancel")
    command.add_argument("--quiet-files", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "init":
            result = initialize(args.data)
        elif args.command == "restore":
            from lumos_transfer import restore
            result = restore(args.snapshot, args.data, args.source, args.sandbox)
        else:
            store = Store(args.data)
            if args.command in {"status", "verify"}:
                result = getattr(store, args.command)()
            elif args.command == "context":
                result = store.context(args.question)
            elif args.command in {"tasks", "task", "task-save"}:
                from lumos_tasks import list_tasks, task_detail, save_task
                if args.command == "tasks":
                    result = list_tasks(store, args.today)
                elif args.command == "task":
                    result = task_detail(store, args.id)
                else:
                    result = save_task(store, read_json(args.request))
            elif args.command == "serve":
                from lumos_web import serve
                serve(store, args.port)
                return 0
            elif args.command == "begin":
                result = store.begin(read_json(args.request), args.quiet_files)
            elif args.command in {"commit", "recover"}:
                result = store.commit(args.batch, args.quiet_files)
            elif args.command == "abandon":
                result = store.abandon(args.batch)
            else:
                import lumos_transfer as transfer
                if args.command == "backup":
                    result = transfer.backup(store, args.destination, args.quiet_files)
                elif args.command == "migrate-start":
                    result = transfer.migration_start(store, args.snapshot, args.target, args.quiet_files)
                elif args.command == "migrate-finish":
                    result = transfer.migration_finish(store, args.target, args.quiet_files)
                else:
                    result = transfer.migration_cancel(store, args.quiet_files)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (Error, OSError, ValueError, KeyError, TypeError, sqlite3.Error) as exc:
        print(json.dumps({"error": str(exc), "type": type(exc).__name__}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
