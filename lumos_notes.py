"""Versioned free-form notes; the browser and Agent share these operations."""
import json
import re
from datetime import date, datetime, timedelta, timezone

from lumos import digest, now, process_lock, require

FIELDS = {'title', 'body', 'date', 'workspace', 'status', 'archive_reason'}


def validate_note(data):
    require("context" not in data, 'Notes are independent of contexts')
    for field in ('created_at', 'updated_at'):
        require(isinstance(data.get(field), str), 'Note timestamp required')
        require(datetime.fromisoformat(data[field]).tzinfo is not None, 'Note timestamp needs timezone')
    for field, limit in {'title': 300, 'body': 200000, 'date': 10, 'workspace': 20,
                         'status': 10, 'archive_reason': 2000}.items():
        require(isinstance(data.get(field), str) and len(data[field]) <= limit, 'Invalid note ' + field)
    require(data['title'].strip(), 'Note title required')
    require(re.fullmatch(r'\d{4}-\d{2}-\d{2}', data['date']), 'Invalid note date')
    date.fromisoformat(data['date'])
    require(data['workspace'] in {'lingguang', 'lumos'}, 'Invalid workspace')
    require(data['status'] in {'active', 'archived', 'deleted'}, 'Invalid note status')
    require(data['status'] != 'archived' or data['archive_reason'].strip(), 'Archive reason required')
    require(type(data.get('revision')) is int and data['revision'] > 0, 'Invalid note revision')
    require(data.get('recording', 'finished') in {'editing', 'finished'}, 'Invalid recording state')
    require(type(data.get('checkpoint', True)) is bool, 'Invalid checkpoint')
    require(isinstance(data.get('suggested_refs', []), list) and len(data.get('suggested_refs', [])) <= 20
            and all(isinstance(i, str) for i in data.get('suggested_refs', [])), 'Invalid suggested references')
    source = data.get('source', {})
    require(isinstance(source, dict) and source.get('type') in {'user', 'agent', 'source', 'user_report'}
            and isinstance(source.get('ref'), str) and 0 < len(source['ref']) <= 2000, 'Note needs provenance')


def validate_refs(refs, nodes):
    require(isinstance(refs, list) and len(refs) <= 100, 'Invalid note references')
    seen = set()
    for ref in refs:
        require(isinstance(ref, dict) and set(ref) == {'id', 'revision', 'excerpt'}, 'Invalid note reference')
        ident = ref['id']
        require(isinstance(ident, str) and ident in nodes and nodes[ident]['kind'] == 'note', 'Note not found')
        require(type(ref['revision']) is int and 0 < ref['revision'] <= nodes[ident]['data']['revision'], 'Invalid reference revision')
        require(isinstance(ref['excerpt'], str) and 0 < len(ref['excerpt']) <= 20000, 'Excerpt required')
        key = (ident, ref['revision'])
        require(key not in seen, 'Duplicate note reference')
        seen.add(key)


def note_version(db, ident, revision=None):
    row = db.execute("SELECT data FROM nodes WHERE id=? AND kind='note'", (ident,)).fetchone()
    require(row, 'Note not found')
    current = json.loads(row[0])
    if revision is None or revision == current['revision']:
        return {'id': ident, 'kind': 'note', 'data': current}
    for raw, in db.execute('SELECT after FROM history WHERE node=? ORDER BY rowid DESC', (ident,)):
        node = json.loads(raw)
        if node and node['data']['revision'] == revision:
            return node
    require(False, 'Note revision not found')


def list_notes(store, workspace='lingguang', archived=False, query=''):
    require(workspace in {'lingguang', 'lumos'}, 'Invalid workspace')
    with process_lock(store.root):
        store.verify()
        with store.db() as db:
            nodes = store.nodes(db)
        from lumos_intake import note_intake_status
        notes = [n for n in nodes.values() if n['kind'] == 'note' and n['data']['workspace'] == workspace
                 and n['data']['status'] != 'deleted'
                 and (n['data']['status'] == 'archived') == archived
                 and query.casefold() in (n['data']['title'] + '\n' + n['data']['body']).casefold()]
        notes.sort(key=lambda n: (n['data']['date'], n['data']['created_at'], n['id']), reverse=True)
        ctl = store.control()
        return {'notes': [{'id': n['id'], 'data': {k: v for k, v in n['data'].items() if k != 'body'},
                          'intake': note_intake_status(nodes, n['id'])} for n in notes],
                'today': datetime.now(timezone(timedelta(hours=8))).date().isoformat(),
                'store_id': ctl['id'], 'writable': ctl['mode'] in {'active', 'trial', 'sandbox'}
                and ctl['bound_root'] == str(store.root) and not store.status()['session']}


def note_detail(store, ident, revision=None):
    with process_lock(store.root):
        store.verify()
        with store.db() as db:
            note = note_version(db, ident, revision)
            history = [{'at': at, 'data': json.loads(raw)['data']} for at, raw in db.execute(
                'SELECT b.at,h.after FROM history h JOIN batches b ON b.id=h.batch WHERE h.node=? ORDER BY b.seq DESC', (ident,))]
            history = [h for h in history if h['data'].get('checkpoint', True)]
            tasks = [{'id': n['id'], 'title': n['data']['text']} for n in store.nodes(db).values()
                     if n['kind'] == 'action' and any(r['id'] == ident for r in n['data'].get('note_refs', []))]
            from lumos_intake import note_intake_status
            nodes = store.nodes(db)
            intake = note_intake_status(nodes, ident)
            suggestions = [{'id': i, 'kind': nodes[i]['kind'], 'title': nodes[i]['data'].get('text') or nodes[i]['data'].get('title', i)}
                           for i in note['data'].get('suggested_refs', []) if i in nodes]
        return {'note': note, 'history': history, 'tasks': tasks, 'intake': intake, 'suggestions': suggestions}


def save_note(store, request):
    require(isinstance(request, dict) and set(request) <= {'request_id', 'id', 'expected_revision', 'changes', 'source', 'operation', 'confirmed'}, 'Unknown note request field')
    operation = request.get('operation', 'save')
    require(operation in {'save', 'edit', 'finish', 'archive', 'process', 'delete'}, 'Invalid note operation')
    require(operation not in {'archive', 'delete'} or request.get('confirmed') is True, '请先确认归档或删除笔记')
    key = request.get('request_id')
    require(isinstance(key, str) and re.fullmatch(r'[a-f0-9]{32}', key), 'Invalid request_id')
    ident = request.get('id')
    require(isinstance(ident, str) and re.fullmatch(r'note-[a-f0-9]{32}', ident), 'Invalid note ID')
    require(type(request.get('expected_revision')) is int and request['expected_revision'] >= 0, 'expected_revision required')
    changes = request.get('changes')
    require(isinstance(changes, dict) and (changes or operation != 'save') and set(changes) <= FIELDS, 'Invalid note fields')
    reason = 'note:' + key + ':' + digest(json.dumps(request, ensure_ascii=False, sort_keys=True).encode())
    with process_lock(store.root):
        store.writable()
        store.idle()
        store.verify()
        with store.db() as db:
            replay = db.execute('SELECT reason,manifest FROM batches WHERE reason LIKE ?', ('note:' + key + ':%',)).fetchone()
            if replay:
                require(replay[0] == reason, 'Request ID reused with different content')
                saved = json.loads(replay[1])['request']['updates'][0]
                return {'note': saved, 'replayed': True}
            nodes = store.nodes(db)
        old = nodes.get(ident)
        require(old is None or old['kind'] == 'note', 'Invalid note ID')
        require(not old or old['data']['status'] != 'deleted', '笔记已删除，不能修改；历史引用仍保留。')
        require(operation not in {'process', 'delete'} or old, '请先保存笔记')
        require(operation != 'process' or not changes, 'Lumos归档不能同时修改正文')
        require(request['expected_revision'] == (old['data']['revision'] if old else 0),
                '笔记已被其他页面或 Agent 修改；草稿已保留，请查看最新版本后合并。')
        data = dict(old['data']) if old else {'title': '未命名笔记', 'body': '', 'workspace': 'lingguang',
                'date': datetime.now(timezone(timedelta(hours=8))).date().isoformat(),
                'status': 'active', 'archive_reason': '', 'created_at': now()}
        recording = data.get('recording', 'finished' if old else 'editing')
        content_changed = any(k in changes and changes[k] != data.get(k) for k in ('title', 'body', 'date', 'workspace'))
        require(operation == 'edit' or recording == 'editing' or not content_changed,
                '请先点击编辑，再修改已结束的笔记。')
        require(operation != 'finish' or recording == 'editing', '记录已经结束。')
        require(changes.get('status') != 'archived' or data['status'] == 'archived'
                or (operation != 'edit' and ('recording' not in data or recording == 'finished')),
                '请先结束记录，再归档已处理的笔记。')
        data.update(changes)
        require(data['status'] != 'deleted', '删除须使用确认后的删除操作')
        if operation == 'archive':
            data.update(status='archived', archive_reason='王牧楠确认普通归档，无需Agent处理。', archive_mode='manual')
        if operation == 'delete':
            data.update(status='deleted')
        if isinstance(data['title'], str):
            data['title'] = data['title'].strip() or '未命名笔记'
        data.update(revision=request['expected_revision'] + 1, updated_at=now(), source=request.get('source'))
        # Keep raw checkpoints and audit revisions immutable for pinned task sources.
        data.update(recording='finished' if operation in {'finish', 'archive', 'delete'} else 'editing' if operation == 'edit' else recording,
                    checkpoint=operation == 'finish' or (operation == 'archive' and recording == 'editing'))
        validate_note(data)
        node = {'id': ident, 'kind': 'note', 'data': data}
        batch_request = {'reason': reason, 'updates': [node]}
        from lumos_intake import enabled, note_intake
        if operation == 'process':
            require(recording == 'finished' and data['status'] == 'active', '请先结束记录，已归档笔记请先恢复')
            require(enabled(nodes, data['workspace']), '此空间尚未启用自主整理')
            require(not any(n['kind'] == 'intake' and n['data'].get('note', {}).get('id') == ident
                            and n['data']['status'] in {'pending', 'running'} for n in nodes.values()), '笔记正在整理，请完成后再归档')
            batch_request['updates'].append(note_intake(node, 'archive'))
        if operation == 'finish' and data['status'] == 'active' and enabled(nodes, data['workspace']):
            batch_request['updates'].append(note_intake(node, 'format'))
        # A withdrawn note must not be applied by an already-running planner.
        if data['status'] in {'archived', 'deleted'} or operation == 'edit':
            for n in nodes.values():
                if n['kind'] == 'intake' and n['data'].get('note', {}).get('id') == ident and n['data']['status'] in {'pending', 'running', 'failed'}:
                    batch_request['updates'].append({**n, 'data': {**n['data'], 'status': 'obsolete',
                        'summary': '笔记已归档、删除或重新编辑，本次整理已停止。', 'revision': n['data']['revision']+1, 'updated_at': now()}})
        with store.db() as db:
            links = set(db.execute('SELECT src,dst,relation FROM links'))
        store.validate(nodes, {**nodes, **{n['id']: n for n in batch_request['updates']}}, batch_request, links, links)
        batch = store._begin(batch_request)
        store._commit(batch['batch'])
        return {'note': node, 'replayed': False}
