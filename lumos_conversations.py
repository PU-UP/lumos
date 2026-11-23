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


def validate_agent_memo(value):
    require(isinstance(value, dict) and set(value) == {'title', 'memo', 'state'}, 'Invalid agent conversation memo')
    require(isinstance(value['title'], str) and 0 < len(value['title'].strip()) <= 80, '对话标题须简短')
    require(isinstance(value['memo'], str) and len(value['memo']) <= 2000, '对话备忘过长')
    require(value['state'] in {'ongoing', 'waiting', 'settled'}, 'Invalid topic state')


def maintain_conversation(nodes, receipt, plan):
    """Same transaction as the reply; an agent cannot overwrite a manual title."""
    d = receipt['data']; old = nodes.get('chat-'+d.get('chat_id', ''))
    if not old or old['data']['status'] != 'active' or old['data'].get('deleted', False):
        return []
    value = plan.get('conversation')
    if value is not None:
        validate_agent_memo(value)
    data = {**old['data'], 'revision': old['data']['revision']+1, 'updated_at': now(),
            'memo': value['memo'] if value else old['data']['memo'],
            'topic_state': value['state'] if value else old['data'].get('topic_state', 'ongoing'),
            'memo_receipt': receipt['id']}
    if value and data.get('title_mode') == 'auto':
        data['title'] = value['title']
    destinations = [i for i in d.get('destinations', []) if nodes.get(i, {}).get('kind') in {'action', 'mainline'}]
    data['source_ids'] = list(dict.fromkeys([*data['source_ids'], *d.get('related_ids', []), *destinations]))[-20:]
    from lumos_attention import conversation_topic
    if not data.get('topic_id'):
        data['topic_id'] = conversation_topic(nodes, old['data']['source_ids'] or data['source_ids'])
    from lumos_intake import open_questions
    related = set(data['source_ids'])
    unresolved = [q for q in open_questions(nodes, d['workspace'])
                  if q.get('answer_state') != 'waiting' and
                  (nodes[q['intake_id']]['data'].get('chat_id') == d.get('chat_id') or related.intersection(q['related_ids']))]
    data['awaiting_reply'] = bool(plan.get('questions') or unresolved or (value and value['state'] == 'waiting'))
    if plan.get('questions') or unresolved:
        data['topic_state'] = 'waiting'
    answered = set([d.get('question_key', ''), *d.get('question_keys', [])])
    data['notices'] = [{**n, 'active': False} if n['kind'] != 'reply' and (n.get('question_key') or n['key']) in answered else n
                       for n in data.get('notices', [])]
    from lumos_attention import notice
    item = notice('reply:'+receipt['id'], 'reply', d['summary'], receipt['id'], d.get('related_ids', []))
    data['notices'] = [*data.get('notices', []), item]
    return [{**old, 'data': data}]


def validate_conversation(node, old, nodes):
    d = node['data']
    require(isinstance(d.get('chat_id'), str) and re.fullmatch('[a-f0-9]{32}', d['chat_id'])
            and node['id'] == 'chat-'+d['chat_id'], 'Invalid conversation ID')
    require(d.get('agent_role') in {*ROLES, 'legacy'} and d.get('workspace') in {'lingguang', 'lumos'}, 'Invalid conversation scope')
    require(d.get('status') in {'active', 'closed', 'legacy'}, 'Invalid conversation status')
    require(type(d.get('deleted', False)) is bool, 'Invalid conversation deletion state')
    require(type(d.get('awaiting_reply', False)) is bool, 'Invalid awaiting reply state')
    require(not d.get('topic_id') or nodes.get(d['topic_id'], {}).get('kind') in {'action', 'mainline'}, 'Invalid conversation topic')
    require((d['agent_role'] == 'legacy') == (d['status'] == 'legacy'), 'Mixed history must remain read-only')
    for key, limit in [('title', 300), ('memo', 10000)]:
        require(isinstance(d.get(key), str) and len(d[key]) <= limit, 'Invalid conversation '+key)
    require(d['title'].strip(), '请填写对话标题')
    refs = d.get('source_ids')
    require(isinstance(refs, list) and len(refs) <= 20 and all(isinstance(i, str) and i in nodes for i in refs), 'Invalid memo references')
    require(type(d.get('revision')) is int and d['revision'] > 0, 'Invalid conversation revision')
    require(d.get('title_mode', 'manual') in {'manual', 'auto'}, 'Invalid title mode')
    require(d.get('topic_state', 'ongoing') in {'ongoing', 'waiting', 'settled'}, 'Invalid topic state')
    from lumos_attention import validate_notices
    validate_notices(d.get('notices', []), d['agent_role'], d['workspace'], nodes, old['data'].get('notices', []) if old else [])
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
        'title', 'memo', 'source_ids', 'status', 'expected_revision', 'source', 'operation', 'confirmed'}, 'Invalid conversation request')
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
        if 'operation' in request:
            require(set(request) <= {'request_id', 'chat_id', 'agent_role', 'workspace', 'expected_revision', 'source', 'operation', 'confirmed'}, '删除或恢复不能同时修改对话内容')
            require(request['operation'] in {'delete', 'restore'}, 'Invalid conversation operation')
            require(old and old['data']['workspace'] == request.get('workspace') and old['data']['agent_role'] == request.get('agent_role'), '对话不属于当前角色或资料范围')
            require(request['operation'] != 'delete' or request.get('confirmed') is True, '删除对话需要确认')
            require(not any(n['kind'] == 'intake' and n['data'].get('chat_id') == chat_id and n['data']['status'] in {'pending', 'running'} for n in nodes.values()), '对话仍在处理中，请完成后再删除或恢复')
            node = {**old, 'data': {**old['data'], 'deleted': request['operation'] == 'delete',
                    'revision': old['data']['revision']+1, 'updated_at': now()}}
            commit_tasks(store, nodes, {'reason': reason, 'updates': [node]}, node['id'])
            return {'conversation': node, 'replayed': False}
        require('confirmed' not in request, '确认标记仅用于删除对话')
        require(not old or not old['data'].get('deleted'), '此对话已删除，请先恢复')
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
        if 'title' in request:
            node['data']['title_mode'] = 'manual'
        elif not old:
            node['data']['title_mode'] = 'auto'
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
