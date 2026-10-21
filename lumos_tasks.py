"""Task queries and atomic writes shared by the CLI and local board."""
import json
import re
from datetime import date, datetime, timedelta, timezone

from lumos import Error, digest, now, process_lock, require, safe_path

FIELDS = {"text", "context", "status", "condition", "details", "next_step", "progress",
          "due", "follow_up", "priority"}
STATES = {"todo", "doing", "blocked", "done", "cancelled"}


def validate_fields(data):
    for field in FIELDS & data.keys():
        require(isinstance(data[field], str), f"{field} must be text")
        require(len(data[field]) <= (300 if field == "text" else 20000), f"{field} too long")
    for field in ("due", "follow_up"):
        value = data.get(field, "")
        if value:
            require(bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)), f"{field}: use YYYY-MM-DD")
            try:
                date.fromisoformat(value)
            except ValueError as exc:
                raise Error(f"{field}: invalid date") from exc
    require(data.get("priority", "normal") in {"normal", "high"}, "Invalid priority")


def attention(data, today):
    if data["status"] in {"done", "cancelled"}:
        return []
    reasons = []
    due = data.get("due")
    if due and due < today.isoformat():
        reasons.append("已逾期")
    elif due and due <= (today + timedelta(days=7)).isoformat():
        reasons.append("七天内到期")
    if data.get("follow_up") and data["follow_up"] <= today.isoformat():
        reasons.append("到跟进日")
    if data["status"] == "blocked":
        reasons.append("有阻塞")
    if data.get("priority") == "high":
        reasons.append("重要事项")
    return reasons


def list_tasks(store, today=None):
    today = date.fromisoformat(today) if today else datetime.now(timezone(timedelta(hours=8))).date()
    with process_lock(store.root):
        integrity = store.verify()
        with store.db() as db:
            nodes, seq = store.nodes(db), store.seq(db)
        contexts = [n for n in nodes.values() if n["kind"] == "context"
                    and n["data"].get("status", "active") in {"active", "waiting"}]
        ids = {n["id"] for n in contexts}
        tasks = []
        for node in nodes.values():
            if node["kind"] == "action" and node["data"]["context"] in ids:
                tasks.append({**node, "attention": attention(node["data"], today)})
        tasks.sort(key=lambda n: (not bool(n["attention"]),
                                 "已逾期" not in n["attention"],
                                 n["data"].get("due") or "9999", n["id"]))
        ctl = store.control()
        return {"seq": seq, "today": today.isoformat(), "contexts": contexts, "tasks": tasks,
                "attention": [n["id"] for n in tasks if n["attention"]],
                "writable": ctl["mode"] in {"active", "trial", "sandbox"}
                and ctl["bound_root"] == str(store.root) and not store.status()["session"],
                "integrity": integrity}


def task_detail(store, ident):
    with process_lock(store.root):
        store.verify()
        with store.db() as db:
            nodes, seq = store.nodes(db), store.seq(db)
            task = nodes.get(ident)
            require(task and task["kind"] == "action", "Task not found")
            history = [{"at": at, "reason": reason, "before": json.loads(before),
                        "after": json.loads(after)} for at, reason, before, after in db.execute(
                            "SELECT b.at,b.reason,h.before,h.after FROM history h JOIN batches b "
                            "ON b.id=h.batch WHERE h.node=? ORDER BY b.seq DESC", (ident,))]
            links = [list(row) for row in db.execute(
                "SELECT src,dst,relation FROM links WHERE src=? OR dst=?", (ident, ident))]
        related_ids = {i for a, b, _ in links for i in (a, b)} - {ident}
        documents = {}
        for node in nodes.values():
            data = node["data"]
            if (node["kind"] == "document" and data["path"].endswith(".md")
                    and (data["context"] == task["data"]["context"] or node["id"] in related_ids)):
                documents[node["id"]] = safe_path(store.root, data["version"]).read_text(encoding="utf-8")
        return {"seq": seq, "task": task, "history": history, "links": links,
                "related": [nodes[i] for i in sorted(related_ids)],
                "documents": documents}


def save_task(store, request):
    require(isinstance(request, dict), "Expected task request object")
    require(set(request) <= {"request_id", "expected_seq", "id", "changes", "source"}, "Unknown request field")
    key = request.get("request_id", "")
    require(isinstance(key, str) and bool(re.fullmatch(r"[a-f0-9]{32}", key)), "request_id must be UUID hex")
    changes = request.get("changes")
    require(isinstance(changes, dict) and changes and set(changes) <= FIELDS, "Invalid task fields")
    validate_fields(changes)
    source = request.get("source", {})
    require(isinstance(source, dict) and source.get("type") in {"user", "user_report"}
            and isinstance(source.get("ref"), str) and 0 < len(source["ref"]) <= 2000,
            "Task needs user provenance")
    require(type(request.get("expected_seq")) is int, "expected_seq required")
    ident = request.get("id") or "task-" + key
    require(isinstance(ident, str) and bool(re.fullmatch(r"[A-Za-z0-9_-]+", ident)), "Invalid task ID")
    reason = "task:" + key + ":" + digest(json.dumps(request, sort_keys=True, ensure_ascii=False).encode())
    with process_lock(store.root):
        store.writable()
        store.idle()
        store.verify()
        with store.db() as db:
            replay = db.execute("SELECT reason FROM batches WHERE reason LIKE ?", ("task:" + key + ":%",)).fetchone()
            if replay:
                require(replay[0] == reason, "Request ID reused with different content")
                return {"id": ident, "seq": store.seq(db), "replayed": True}
            seq, nodes = store.seq(db), store.nodes(db)
        require(request["expected_seq"] == seq, "记录已变化，请刷新后核对再保存；你的输入尚未提交。")
        old = nodes.get(ident)
        if request.get("id"):
            require(old and old["kind"] == "action", "Task not found")
        else:
            require(old is None, "Task ID already exists")
        data = dict(old["data"]) if old else {"status": "todo", "priority": "normal", "source": source}
        data.update(changes)
        require(data.get("text", "").strip(), "任务标题不能为空")
        require(data.get("status") in STATES, "Invalid task status")
        ctx = nodes.get(data.get("context"))
        require(ctx and ctx["kind"] == "context" and ctx["data"].get("status", "active") in {"active", "waiting"},
                "请选择当前工作脉络，归档内容不能新增或修改任务。")
        if not data.get("condition", "").strip():
            data["condition"] = "用户确认完成：" + data["text"]
        data["updated_at"] = now()
        data["last_source"] = source
        if data["status"] == "done" and (not old or old["data"]["status"] != "done"):
            data["completion"] = {"basis": "user_report", "ref": source["ref"]}
        elif data["status"] != "done":
            for field in ("completion", "technical_result", "acceptance", "result_evidence"):
                data.pop(field, None)
        update = {"id": ident, "kind": "action", "data": data}
        batch_request = {"reason": reason, "updates": [update]}
        # Validate before creating a persistent session; invalid UI input must not leave it occupied.
        with store.db() as db:
            links = set(db.execute("SELECT src,dst,relation FROM links"))
        store.validate(nodes, {**nodes, ident: update}, batch_request, links, links)
        batch = store._begin(batch_request)
        store._commit(batch["batch"])
        with store.db() as db:
            return {"id": ident, "seq": store.seq(db), "replayed": False}
