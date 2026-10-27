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
    require(data['status'] in {'active', 'archived'}, 'Invalid note status')
    require(data['status'] != 'archived' or data['archive_reason'].strip(), 'Archive reason required')
    require(type(data.get('revision')) is int and data['revision'] > 0, 'Invalid note revision')
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
        notes = [n for n in nodes.values() if n['kind'] == 'note' and n['data']['workspace'] == workspace
                 and (n['data']['status'] == 'archived') == archived
                 and query.casefold() in (n['data']['title'] + '\n' + n['data']['body']).casefold()]
        notes.sort(key=lambda n: (n['data']['date'], n['data']['created_at'], n['id']), reverse=True)
        ctl = store.control()
        return {'notes': [{'id': n['id'], 'data': {k: v for k, v in n['data'].items() if k != 'body'}} for n in notes],
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
            tasks = [{'id': n['id'], 'title': n['data']['text']} for n in store.nodes(db).values()
                     if n['kind'] == 'action' and any(r['id'] == ident for r in n['data'].get('note_refs', []))]
        return {'note': note, 'history': history, 'tasks': tasks}


def save_note(store, request):
    require(isinstance(request, dict) and set(request) <= {'request_id', 'id', 'expected_revision', 'changes', 'source'}, 'Unknown note request field')
    key = request.get('request_id')
    require(isinstance(key, str) and re.fullmatch(r'[a-f0-9]{32}', key), 'Invalid request_id')
    ident = request.get('id')
    require(isinstance(ident, str) and re.fullmatch(r'note-[a-f0-9]{32}', ident), 'Invalid note ID')
    require(type(request.get('expected_revision')) is int and request['expected_revision'] >= 0, 'expected_revision required')
    changes = request.get('changes')
    require(isinstance(changes, dict) and changes and set(changes) <= FIELDS, 'Invalid note fields')
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
        require(request['expected_revision'] == (old['data']['revision'] if old else 0),
                '笔记已被其他页面或 Agent 修改；草稿已保留，请查看最新版本后合并。')
        data = dict(old['data']) if old else {'title': '未命名笔记', 'body': '', 'workspace': 'lingguang',
                'date': datetime.now(timezone(timedelta(hours=8))).date().isoformat(),
                'status': 'active', 'archive_reason': '', 'created_at': now()}
        data.update(changes)
        if isinstance(data['title'], str):
            data['title'] = data['title'].strip() or '未命名笔记'
        data.update(revision=request['expected_revision'] + 1, updated_at=now(), source=request.get('source'))
        validate_note(data)
        node = {'id': ident, 'kind': 'note', 'data': data}
        batch_request = {'reason': reason, 'updates': [node]}
        with store.db() as db:
            links = set(db.execute('SELECT src,dst,relation FROM links'))
        store.validate(nodes, {**nodes, ident: node}, batch_request, links, links)
        batch = store._begin(batch_request)
        store._commit(batch['batch'])
        return {'note': node, 'replayed': False}
