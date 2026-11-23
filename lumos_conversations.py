"""Persistent role conversations; messages and business records remain in their existing stores."""
import json
import copy
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
    if d.get('merged_into'):
        target = nodes.get('chat-'+d['merged_into'], {})
        require(target.get('kind') == 'conversation' and target['id'] != node['id']
                and not target['data'].get('merged_into') and d['status'] == 'closed'
                and all(target['data'][k] == d[k] for k in ('workspace', 'agent_role')), 'Invalid merged conversation')
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
        'title', 'memo', 'source_ids', 'status', 'expected_revision', 'source', 'operation', 'confirmed', 'merge_from', 'reason'}, 'Invalid conversation request')
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
        require(not old or not old['data'].get('merged_into'), '此对话已合并，请刷新后在主话题中继续')
        if request.get('operation') == 'merge':
            return merge_notice_conversations(store, nodes, old, request, reason)
        require('merge_from' not in request and 'reason' not in request, '合并字段仅用于合并操作')
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


def merge_notice_conversations(store, nodes, target, request, reason):
    """Consolidate old reminder threads without rewriting any user-message chain."""
    require(set(request) <= {'request_id', 'chat_id', 'agent_role', 'workspace', 'expected_revision',
                            'source', 'operation', 'merge_from', 'reason', 'title'}, 'Invalid merge fields')
    require(target and target['data']['status'] == 'active' and not target['data'].get('deleted'), '主话题不可用')
    require(all(target['data'][k] == request.get(k) for k in ('workspace', 'agent_role')), '合并范围不符')
    require(isinstance(request.get('reason'), str) and request['reason'].strip(), '合并须说明核对依据')
    sources = request.get('merge_from')
    require(isinstance(sources, dict) and 0 < len(sources) <= 50 and target['data']['chat_id'] not in sources, 'Invalid merge sources')
    chats = [target]
    for ident, revision in sources.items():
        old = nodes.get('chat-'+ident) if isinstance(ident, str) else None
        require(old and old['kind'] == 'conversation' and old['data']['revision'] == revision, '待合并对话已变化，请重新核对')
        d = old['data']
        require(d['status'] == 'active' and not d.get('deleted') and not d.get('merged_into')
                and all(d[k] == target['data'][k] for k in ('workspace', 'agent_role')), '不能跨角色或资料范围合并')
        # These historical reminder threads contain notices only. Keep real discussions separate.
        require(not any(n['kind'] == 'intake' and n['data'].get('chat_id') == ident for n in nodes.values()),
                '含实际交流的旧对话须单独核对，本入口仅合并提醒话题')
        require(not any(n['kind'] == 'conversation' and n['data'].get('merged_into') == ident for n in nodes.values()), '不能再次合并已有主话题')
        chats.append(old)
    require(not any(n['kind'] == 'intake' and n['data'].get('chat_id') == target['data']['chat_id']
                    and n['data']['status'] in {'pending', 'running', 'failed'} for n in nodes.values()), '主话题仍在处理或等待重试')
    node = copy.deepcopy(target); d = node['data']; refs = list(dict.fromkeys(i for c in chats for i in c['data']['source_ids']))
    require(len(refs) <= 20, '合并后的关联过多，请按主题拆分')
    d['source_ids'] = refs
    notices = {n['id']: n for n in d.get('notices', [])}
    for c in chats[1:]:
        for item in c['data'].get('notices', []):
            if item['id'] in notices:
                require({k:v for k,v in item.items() if k not in {'active','seen_at'}} ==
                        {k:v for k,v in notices[item['id']].items() if k not in {'active','seen_at'}}, '消息来源冲突')
                notices[item['id']]['seen_at'] = notices[item['id']]['seen_at'] or item['seen_at']
                notices[item['id']]['active'] |= item['active']
            else:
                notices[item['id']] = copy.deepcopy(item)
    d['notices'] = sorted(notices.values(), key=lambda n:(n['at'], n['id']))
    d['awaiting_reply'] = any(c['data'].get('awaiting_reply') for c in chats)
    if d['awaiting_reply'] or any(n['active'] and n['kind'] in {'question','followup'} for n in d['notices']):
        d['topic_state'] = 'waiting'
    if 'title' in request:
        d['title'] = request['title']; d['title_mode'] = 'manual'
    from lumos_attention import conversation_topic, notice_topic
    from lumos_intake import scoped_nodes
    scope = scoped_nodes(nodes, d['workspace'])
    topics = {notice_topic(nodes, scope, item) for item in d['notices']}
    d['topic_id'] = d.get('topic_id') or conversation_topic(scope, refs) or (next(iter(topics)) if len(topics) == 1 else '')
    d['revision'] += 1; d['updated_at'] = now()
    updates = [node]
    for c in chats[1:]:
        updates.append({**c, 'data': {**c['data'], 'merged_into': d['chat_id'], 'merge_reason': request['reason'],
                        'status': 'closed', 'revision': c['data']['revision']+1, 'updated_at': now()}})
    commit_tasks(store, nodes, {'reason': reason, 'updates': updates}, node['id'])
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
