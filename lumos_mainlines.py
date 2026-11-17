"""Versioned management summaries; task commitments stay in their original records."""
import json
import re
from datetime import date

from lumos import digest, now, process_lock, require, safe_path
from lumos_tasks import commit_tasks, context_workspace, task_defaults, task_numbers


def save_review(store, request):
    require(isinstance(request, dict) and set(request) == {'request_id', 'id', 'expected_seq', 'review_on', 'source'}, 'Invalid review request')
    key = request['request_id']
    require(isinstance(key, str) and re.fullmatch('[a-f0-9]{32}', key), 'Invalid request ID')
    require(type(request['expected_seq']) is int, 'Expected version required')
    reason = 'mainline-review:'+key+':'+digest(json.dumps(request, sort_keys=True, ensure_ascii=False).encode())
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            replay = db.execute('SELECT reason FROM batches WHERE reason LIKE ?', ('mainline-review:'+key+':%',)).fetchone()
            if replay:
                require(replay[0] == reason, 'Request ID reused with different content')
                return {'id': request['id'], 'seq': store.seq(db), 'replayed': True}
            nodes, seq = store.nodes(db), store.seq(db)
        require(seq == request['expected_seq'], '记录已变化，请刷新后核对复核日期再保存。')
        old = nodes.get(request['id'])
        require(old and old['kind'] == 'mainline' and old['data'].get('status', 'active') == 'active', 'Mainline not active')
        require(nodes[old['data']['context']]['data'].get('status', 'active') in {'active', 'waiting'}, 'Context not active')
        source = request['source']
        require(isinstance(source, dict) and source.get('type') == 'user' and isinstance(source.get('ref'), str) and 0 < len(source['ref']) <= 2000, 'User source required')
        node = {**old, 'data': {**old['data'], 'review_on': request['review_on'], 'review_basis': 'user',
                             'review_revision': old['data'].get('review_revision', 0)+1,
                             'review_reason': '用户在主线页安排复核', 'review_source': source, 'updated_at': now()}}
        validate_mainline(node['id'], node['data'], nodes)
        return commit_tasks(store, nodes, {'reason': reason, 'updates': [node]}, node['id'])


def validate_mainline(ident, data, nodes):
    for key, limit in {"title": 100, "goal": 2000, "summary": 2000, "phase": 100,
                       "risk": 2000, "next_step": 2000, "review_reason": 2000, "priority_reason": 2000}.items():
        value = data.get(key, "")
        require(isinstance(value, str) and len(value) <= limit, f"Invalid mainline {key}")
    require(all(data.get(key, "").strip() for key in ("title", "goal", "summary")),
            "Mainline needs title, goal and summary")
    require(data.get("status", "active") in {"active", "archived"}, "Invalid mainline status")
    require(data.get('priority', '') in ('', 'P0', 'P1', 'P2'), '项目主线仅使用P0–P2；P3用于非项目事务')
    require(data.get('priority_basis', '') in ('', 'user', 'agent'), 'Invalid mainline priority basis')
    require(data.get('review_basis', '') in {'', 'user', 'agent'}, 'Invalid mainline review basis')
    require(type(data.get("order", 0)) is int and data.get("order", 0) >= 0, "Invalid mainline order")
    for key in ('review_revision', 'review_checked_revision'):
        require(type(data.get(key, 0)) is int and data.get(key, 0) >= 0, 'Invalid mainline '+key)
    for key in ("as_of", "review_on", "review_checked_on"):
        value = data.get(key, "")
        require(isinstance(value, str), f"Invalid mainline {key}")
        if value:
            try:
                require(date.fromisoformat(value).isoformat() == value, f"Invalid mainline {key}")
            except ValueError:
                require(False, f"Invalid mainline {key}")
    workspace = context_workspace(nodes[data["context"]])
    for key, kinds in (("task_ids", {"action"}), ("milestone_ids", {"action"}),
                       ("source_ids", {"document", "evidence", "decision"}),
                       ("related_mainlines", {"mainline"})):
        refs = data.get(key, [])
        require(isinstance(refs, list) and all(isinstance(i, str) for i in refs)
                and len(refs) == len(set(refs)), f"Invalid mainline {key}")
        for ref in refs:
            require(ref != ident and ref in nodes and nodes[ref]["kind"] in kinds,
                    f"Invalid mainline reference: {ref}")
            require(context_workspace(nodes[nodes[ref]["data"]["context"]]) == workspace,
                    "Mainline references must stay in the same workspace")
            if key == 'task_ids' and data.get('status', 'active') == 'active':
                require(nodes[ref]['data'].get('priority') != 'P3', 'P3非项目事务不能归入项目主线')
    require(set(data.get("milestone_ids", [])) <= set(data.get("task_ids", [])),
            "Milestones must reference linked tasks")


def mainline_detail(store, ident):
    with process_lock(store.root):
        with store.db() as db:
            nodes, seq = store.nodes(db), store.seq(db)
            node = nodes.get(ident)
            require(node and node["kind"] == "mainline", "Mainline not found")
            numbers = task_numbers(db)
            history = [{"at": at, "reason": reason, "before": json.loads(before), "after": json.loads(after)}
                       for at, reason, before, after in db.execute(
                           "SELECT b.at,b.reason,h.before,h.after FROM history h JOIN batches b ON b.id=h.batch "
                           "WHERE h.node=? ORDER BY b.seq DESC", (ident,))]
        tasks = [{**nodes[i], "short_id": numbers[i], "data": task_defaults(nodes[i]["data"]),
                  "context_status": nodes[nodes[i]["data"]["context"]]["data"].get("status", "active")}
                 for i in node["data"].get("task_ids", [])]
        sources = []
        for ref in node["data"].get("source_ids", []):
            source = nodes[ref]
            if source["kind"] == "document":
                data = source["data"]
                text = ""
                if data["path"].endswith(".md"):
                    content = safe_path(store.root, data["version"]).read_bytes()
                    require(digest(content) == data["sha256"], f"Damaged current version: {ref}")
                    text = content.decode("utf-8-sig")
                sources.append({"id": ref, "title": data["title"], "text": text})
            else:
                sources.append({"id": ref, "title": source["data"].get("title", ref),
                                "text": source["data"]["text"]})
        return {"seq": seq, "mainline": node, "tasks": tasks, "sources": sources, "history": history}
