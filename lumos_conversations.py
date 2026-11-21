"""Persistent role conversations; messages and business records remain in their existing stores."""
import json
import re
import uuid

from lumos import digest, now, process_lock, require
from lumos_agents import ROLES
from lumos_tasks import commit_tasks


def conversation_node(chat_id, role, workspace, title, created=None, status='active'):
    return {'id': 'chat-'+chat_id, 'kind': 'conversation', 'data': {
        'chat_id': chat_id, 'agent_role': role, 'workspace': workspace, 'title': title,
        'status': status, 'revision': 1, 'created_at': created or now(), 'updated_at': now(),
        'memo': '', 'source_ids': []}}


def validate_conversation(node, old, nodes):
    d = node['data']
    require(isinstance(d.get('chat_id'), str) and re.fullmatch('[a-f0-9]{32}', d['chat_id'])
            and node['id'] == 'chat-'+d['chat_id'], 'Invalid conversation ID')
    require(d.get('agent_role') in {*ROLES, 'legacy'} and d.get('workspace') in {'lingguang', 'lumos'}, 'Invalid conversation scope')
    require(d.get('status') in {'active', 'closed', 'legacy'}, 'Invalid conversation status')
    require((d['agent_role'] == 'legacy') == (d['status'] == 'legacy'), 'Mixed history must remain read-only')
    for key, limit in [('title', 300), ('memo', 10000)]:
        require(isinstance(d.get(key), str) and len(d[key]) <= limit, 'Invalid conversation '+key)
    require(d['title'].strip(), '请填写对话标题')
    refs = d.get('source_ids')
    require(isinstance(refs, list) and len(refs) <= 20 and all(isinstance(i, str) and i in nodes for i in refs), 'Invalid memo references')
    require(type(d.get('revision')) is int and d['revision'] > 0, 'Invalid conversation revision')
    if old:
        require(all(d[k] == old['data'][k] for k in ('chat_id', 'agent_role', 'workspace', 'created_at')), '对话身份与资料范围不能更改')
    if old != node:
        require(d['revision'] == (old['data']['revision']+1 if old else 1), 'Conversation revision must advance once')


def legacy_conversations(nodes):
    groups = {}
    for node in nodes.values():
        if node['kind'] == 'intake' and node['data'].get('chat_id'):
            groups.setdefault(node['data']['chat_id'], []).append(node)
    result = []
    for chat_id, turns in groups.items():
        if 'chat-'+chat_id in nodes:
            require(nodes['chat-'+chat_id]['kind'] == 'conversation', '会话 ID 与已有记录冲突：'+chat_id)
            continue
        turns.sort(key=lambda n: (n['data']['created_at'], n['id']))
        roles = {n['data'].get('agent_role', 'legacy') for n in turns}
        spaces = {n['data']['workspace'] for n in turns}
        require(len(spaces) == 1, '历史对话跨资料范围，须先核对：'+chat_id)
        first = turns[0]['data']
        role = next(iter(roles)) if len(roles) == 1 else 'legacy'
        result.append(conversation_node(chat_id, role, first['workspace'], first['title'], first['created_at'],
                                        'legacy' if role == 'legacy' else 'active'))
    return result


def list_conversations(store, workspace='lingguang'):
    require(workspace in {'lingguang', 'lumos'}, 'Invalid workspace')
    with process_lock(store.root), store.db() as db:
        nodes = store.nodes(db)
        return {'conversations': sorted([n for n in [*nodes.values(), *legacy_conversations(nodes)]
                if n['kind'] == 'conversation' and n['data']['workspace'] == workspace],
                key=lambda n: n['data']['updated_at'], reverse=True),
                'schema': db.execute('PRAGMA user_version').fetchone()[0]}


def save_conversation(store, request):
    require(isinstance(request, dict) and set(request) <= {'request_id', 'chat_id', 'agent_role', 'workspace',
        'title', 'memo', 'source_ids', 'status', 'expected_revision', 'source'}, 'Invalid conversation request')
    key = request.get('request_id', '')
    require(isinstance(key, str) and re.fullmatch('[a-f0-9]{32}', key), 'Invalid request ID')
    chat_id = request.get('chat_id', '')
    require(isinstance(chat_id, str) and re.fullmatch('[a-f0-9]{32}', chat_id), 'Invalid chat ID')
    reason = 'conversation:'+key+':'+digest(json.dumps(request, sort_keys=True, ensure_ascii=False).encode())
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            require(db.execute('PRAGMA user_version').fetchone()[0] == 2, '请先完成四角色数据升级')
            replay = db.execute('SELECT reason,manifest FROM batches WHERE reason LIKE ?', ('conversation:'+key+':%',)).fetchone()
            if replay:
                require(replay[0] == reason, 'Request ID reused with different content')
                return {'conversation': json.loads(replay[1])['request']['updates'][0], 'replayed': True}
            nodes = store.nodes(db)
        old = nodes.get('chat-'+chat_id)
        require(not old or old['kind'] == 'conversation', 'Conversation ID conflicts with an existing record')
        require(request.get('expected_revision', 0) == (old['data']['revision'] if old else 0), '对话信息已变化，请刷新后重试')
        if old:
            require(old['data']['status'] != 'legacy', '混合角色历史保留只读，请新建对话')
            node = {**old, 'data': {**old['data'], 'revision': old['data']['revision']+1, 'updated_at': now()}}
        else:
            role = request.get('agent_role', 'lumos')
            require(role in ROLES, 'Invalid agent role')
            node = conversation_node(chat_id, role, request.get('workspace', 'lingguang'), request.get('title', '新对话'))
        for k in ('title', 'memo', 'source_ids', 'status', 'agent_role', 'workspace'):
            if k in request:
                node['data'][k] = request[k]
        # References may aid recovery but never grant access to another workspace.
        from lumos_tasks import context_workspace
        require(isinstance(node['data']['source_ids'], list) and all(isinstance(i, str) for i in node['data']['source_ids']), 'Invalid memo references')
        for ident in node['data']['source_ids']:
            ref = nodes.get(ident, {})
            data = ref.get('data', {})
            space = data.get('workspace') or context_workspace(nodes.get(data.get('context'), {'id': '', 'data': {}}))
            require(ref and space == node['data']['workspace'], '备忘来源不属于当前资料范围')
        commit_tasks(store, nodes, {'reason': reason, 'updates': [node]}, node['id'])
        return {'conversation': node, 'replayed': False}


def upgrade_conversations(store, quiet=False):
    require(quiet, '升级前须暂停全部写入，并指定 --quiet-files')
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db(True) as db:
            db.execute('BEGIN IMMEDIATE')
            nodes = store.nodes(db)
            updates = legacy_conversations(nodes)
            if db.execute('PRAGMA user_version').fetchone()[0] == 2 and not updates:
                return {'schema': 2, 'created': 0}
            batch = uuid.uuid4().hex
            request = {'reason': '四角色会话升级 schema 1 → 2；原消息不变', 'updates': updates}
            manifest = {'id': batch, 'base_seq': store.seq(db), 'at': now(), 'request': request, 'documents': []}
            store.validate(nodes, {**nodes, **{n['id']: n for n in updates}}, request, set(db.execute('SELECT src,dst,relation FROM links')))
            db.execute('INSERT INTO batches(id,at,reason,manifest) VALUES(?,?,?,?)',
                       (batch, now(), request['reason'], json.dumps(manifest, ensure_ascii=False)))
            for node in updates:
                db.execute('INSERT INTO nodes VALUES(?,?,?)', (node['id'], node['kind'], json.dumps(node['data'], ensure_ascii=False)))
                db.execute('INSERT INTO history VALUES(?,?,?,?)', (batch, node['id'], 'null', json.dumps(node, ensure_ascii=False)))
            db.execute('PRAGMA user_version=2')
        return {'schema': 2, 'created': len(updates)}
