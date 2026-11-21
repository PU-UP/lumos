"""Versioned inputs and atomic Agent reconciliations, sharing the task store."""
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone

from lumos import digest, now, process_lock, require, safe_path
from lumos_tasks import FIELDS, context_workspace, prepare_task, commit_tasks, task_numbers
from lumos_notes import note_version

POLICY = 'lumos-autonomy-policy'
ACTIVE = {'active', 'waiting'}
STATES = {'pending', 'running', 'failed', 'needs_review', 'done', 'obsolete'}


def today():
    return datetime.now(timezone(timedelta(hours=8))).date().isoformat()


def authorized(nodes, context, policy=POLICY):
    record = nodes.get(policy, {})
    data = record.get('data', {})
    return (policy == POLICY and record.get('kind') == 'decision'
            and data.get('source', {}).get('type') == 'user'
            and context in nodes
            and context_workspace(nodes[context]) in data.get('autonomy_workspaces', []))


def enabled(nodes, workspace):
    data = nodes.get(POLICY, {}).get('data', {})
    return (nodes.get(POLICY, {}).get('kind') == 'decision' and data.get('source', {}).get('type') == 'user' and data.get('status', 'current') == 'current'
            and workspace in data.get('autonomy_workspaces', []))


def management_enabled(nodes, workspace):
    spaces = nodes.get(POLICY, {}).get('data', {}).get('task_management_workspaces', [])
    return enabled(nodes, workspace) and isinstance(spaces, list) and workspace in spaces


def validate_intake(data, nodes):
    from lumos_agents import ROLES
    require(data.get('agent_role', 'lumos') in ROLES, 'Invalid agent role')
    if data.get('episode_ref'):
        ref = nodes.get(data['episode_ref'], {})
        require(ref.get('kind') == 'intake' and ref['data']['workspace'] == data['workspace'], 'Invalid episode reference')
    require(data.get('workspace') in {'lingguang', 'lumos'} and data.get('status') in STATES, 'Invalid intake state/space')
    require(type(data.get('revision')) is int and data['revision'] > 0, 'Invalid intake revision')
    for field, limit in [('title', 300), ('text', 200000), ('summary', 4000), ('error', 2000), ('reply', 20000), ('question_text', 4000)]:
        require(isinstance(data.get(field, ''), str) and len(data.get(field, '')) <= limit, 'Invalid intake '+field)
    require(isinstance(data.get('source'), dict) and data['source'].get('ref'), 'Intake needs a source')
    require(isinstance(data.get('question_key', ''), str) and len(data.get('question_key', '')) <= 500, 'Invalid question key')
    keys = data.get('question_keys', [])
    require(isinstance(keys, list) and len(keys) <= 100 and all(isinstance(k, str) and 0 < len(k) <= 500 for k in keys), 'Invalid question keys')
    if 'chat_id' in data:
        require(isinstance(data['chat_id'], str) and re.fullmatch('[a-f0-9]{32}', data['chat_id']), 'Invalid chat ID')
        parent = data.get('chat_parent', '')
        require(isinstance(parent, str) and (not parent or (nodes.get(parent, {}).get('kind') == 'intake'
                and nodes[parent]['data'].get('chat_id') == data['chat_id']
                and nodes[parent]['data']['workspace'] == data['workspace'])), 'Invalid chat parent')
    model = data.get('model', '')
    require(isinstance(model, str) and (not model or re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,99}', model)), 'Invalid Codex model')
    require(isinstance(data.get('questions', []), list) and all(isinstance(q, str) and len(q) <= 2000 for q in data.get('questions', [])), 'Invalid questions')
    answers = data.get('resolutions', [])
    require(isinstance(answers, list), 'Invalid resolutions')
    indices = set()
    for answer in answers:
        require(isinstance(answer, dict) and type(answer.get('index')) is int
                and 0 <= answer['index'] < len(data.get('questions', [])) and answer['index'] not in indices, 'Invalid resolved question')
        require(all(isinstance(answer.get(k), str) and answer[k] for k in ('answer', 'excerpt', 'source_intake', 'at')), 'Resolution source required')
        require(nodes.get(answer['source_intake'], {}).get('kind') == 'intake', 'Resolution intake missing')
        validate_answer_state(answer)
        if answer.get('state', 'resolved') == 'resolved':
            indices.add(answer['index'])
    require(type(data.get('task_review', False)) is bool, 'Invalid task review flag')
    review = data.get('review')
    if review:
        require(isinstance(review, dict) and set(review) == {'id', 'on', 'revision'}
                and nodes.get(review['id'], {}).get('kind') == 'mainline'
                and isinstance(review['on'], str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', review['on'])
                and type(review['revision']) is int and review['revision'] >= 0, 'Invalid scheduled review')
    note = data.get('note')
    require(data.get('note_mode', 'archive') in {'archive', 'format'}, 'Invalid note mode')
    if note:
        require(set(note) == {'id', 'revision'} and nodes.get(note['id'], {}).get('kind') == 'note', 'Invalid intake note')
        require(type(note['revision']) is int and 0 < note['revision'] <= nodes[note['id']]['data']['revision'], 'Invalid intake note revision')


def note_intake(node, mode='archive'):
    data = node['data']
    return {'id': 'intake-'+digest(f"{node['id']}:{data['revision']}:{mode}".encode())[:32], 'kind': 'intake', 'data': {
        'title': data['title'], 'workspace': data['workspace'], 'status': 'pending', 'revision': 1,
        'note': {'id': node['id'], 'revision': data['revision']}, 'created_at': now(), 'updated_at': now(),
        'note_mode': mode, 'model': 'gpt-6.2-astra',
        'summary': '', 'questions': [], 'source': {'type': 'user', 'ref': f"结束笔记 {node['id']} revision {data['revision']}"}}}


def note_intake_status(nodes, note_id):
    jobs = [n for n in nodes.values() if n['kind'] == 'intake' and n['data'].get('note', {}).get('id') == note_id]
    return max(jobs, key=lambda n: (n['data']['note']['revision'], n['data']['created_at'])) if jobs else None


def list_intakes(store, workspace='lingguang'):
    require(workspace in {'lingguang', 'lumos'}, 'Invalid workspace')
    with process_lock(store.root), store.db() as db:
        nodes = store.nodes(db)
        jobs = [n for n in nodes.values() if n['kind'] == 'intake' and n['data']['workspace'] == workspace]
        jobs.sort(key=lambda n: n['data']['created_at'], reverse=True)
        return {'intakes': [{**n, 'data': {**n['data'], 'agent_steps': [{k: v for k, v in s.items() if k != 'proposal'} for s in n['data'].get('agent_steps', [])]}, 'subjects': [{'id': i, 'title': nodes[i]['data'].get('title') or nodes[i]['data'].get('text', i)}
                    for i in n['data'].get('related_ids', []) if i in nodes], 'targets': [{'id': i, 'kind': nodes[i]['kind'],
                    'title': nodes[i]['data'].get('title') or nodes[i]['data'].get('text', i)}
                    for i in n['data'].get('destinations', []) if i in nodes]} for n in jobs], 'enabled': enabled(nodes, workspace)}


def save_intake(store, request):
    from lumos_agents import ROLES, role_for
    require(isinstance(request, dict) and set(request) <= {'request_id', 'workspace', 'text', 'title', 'source', 'note_id', 'id', 'expected_revision', 'execution', 'related_ids', 'question_key', 'question_keys', 'question_text', 'chat_id', 'chat_parent', 'model', 'task_review', 'agent_role', 'episode_ref'}, 'Invalid intake request')
    require(request.get('agent_role', 'lumos') in ROLES, 'Invalid agent role')
    require(request.get('execution', 'automatic') in {'automatic', 'conversation'}, 'Invalid execution mode')
    require(type(request.get('task_review', False)) is bool, 'Invalid task review flag')
    key = request.get('request_id', '')
    require(isinstance(key, str) and re.fullmatch('[a-f0-9]{32}', key), 'Invalid request_id')
    reason = 'intake:'+key+':'+digest(json.dumps(request, sort_keys=True, ensure_ascii=False).encode())
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            replay = db.execute('SELECT reason,manifest FROM batches WHERE reason LIKE ?', ('intake:'+key+':%',)).fetchone()
            if replay:
                require(replay[0] == reason, 'Request ID reused with different content')
                return {'intake': json.loads(replay[1])['request']['updates'][0], 'replayed': True}
            nodes = store.nodes(db)
        if request.get('id'):
            old = nodes.get(request['id'])
            require(old and old['kind'] == 'intake', 'Intake not found')
            require(old['data']['revision'] == request.get('expected_revision'), '整理记录已变化，请刷新后重试。')
            require(old['data']['status'] in {'failed', 'pending'}
                    or (old['data']['status'] == 'running' and old['data'].get('lease_until', '') < now()), '当前整理不能重试')
            node = {**old, 'data': {**old['data'], 'status': 'pending', 'error': '', 'revision': old['data']['revision']+1, 'updated_at': now()}}
        elif request.get('note_id'):
            note = nodes.get(request['note_id'])
            require(note and note['kind'] == 'note' and note['data'].get('recording', 'finished') == 'finished'
                    and note['data']['status'] == 'active', '请先结束笔记记录；已归档或删除笔记不能自动整理')
            require(note['data'].get('formatted_revision'), '请先自动整理当前笔记，完成后才能Lumos归档')
            require(not any(n['kind'] == 'intake' and n['data'].get('note', {}).get('id') == note['id']
                            and n['data']['status'] in {'pending', 'running'} and n['data'].get('note_mode') == 'format'
                            for n in nodes.values()), '请等待笔记润色完成')
            node = note_intake(note)
            if node['id'] in nodes:
                return {'intake': nodes[node['id']], 'replayed': True}
        else:
            require(isinstance(request.get('text'), str) and request['text'].strip(), 'Progress text required')
            chat_role = request.get('agent_role', 'lumos')
            if 'chat_id' in request:
                require(isinstance(request['chat_id'], str) and re.fullmatch('[a-f0-9]{32}', request['chat_id']), 'Invalid chat ID')
                conversation = nodes.get('chat-'+request['chat_id'])
                if conversation:
                    meta = conversation['data']
                    require(meta['status'] == 'active', '此对话已结束或为混合历史，请新建对话')
                    require(meta['workspace'] == request.get('workspace', 'lingguang'), '对话不属于当前空间')
                    chat_role = meta['agent_role']
                    require(request.get('agent_role', chat_role) == chat_role, '对话角色已固定，请新建对应角色的对话')
                require(request.get('execution', 'automatic') == 'automatic', '网页对话需要自动执行')
                turns = [n for n in nodes.values() if n['kind'] == 'intake' and n['data'].get('chat_id') == request['chat_id']]
                require(all(n['data']['workspace'] == request.get('workspace', 'lingguang') for n in turns), '对话不属于当前空间')
                roles = {role_for(n['data']) for n in turns}
                require(len(roles) <= 1, '此历史对话包含多个角色，请新建对应角色的对话；原历史保留')
                require(not conversation or not roles or roles == {chat_role}, '对话历史与固定角色不一致，请新建对话并保留原历史')
                if roles:
                    chat_role = next(iter(roles))
                    require(request.get('agent_role', chat_role) == chat_role, '对话角色已固定，请新建对应角色的对话')
                parents = {n['data'].get('chat_parent') for n in turns}
                latest = next((n for n in turns if n['id'] not in parents), None)
                require(request.get('chat_parent', '') == (latest['id'] if latest else ''), '对话已有新消息，请刷新后接续')
                require(not latest or latest['data']['status'] in {'done', 'needs_review'}, '请先等待本轮完成或重试失败消息')
            else:
                require('chat_parent' not in request, 'Missing chat ID')
            if request.get('task_review'):
                require(management_enabled(nodes, request.get('workspace', 'lingguang')), '尚未启用任务统筹授权')
                require(not (set(request) & {'chat_id', 'note_id', 'question_key'}), '全量复核不能混入对话或笔记')
                active = next((n for n in nodes.values() if n['kind'] == 'intake' and n['data'].get('task_review')
                               and n['data']['workspace'] == request.get('workspace', 'lingguang')
                               and n['data']['status'] in {'pending', 'running'}), None)
                if active:
                    return {'intake': active, 'replayed': True}
            refs = request.get('related_ids', [])
            require(isinstance(refs, list) and len(refs) <= 20 and all(isinstance(i, str) for i in refs), 'Invalid feedback references')
            scoped = scoped_nodes(nodes, request.get('workspace', 'lingguang'))
            require(all(i in scoped and scoped[i]['kind'] in {'mainline', 'action'} for i in refs), '反馈事项不属于当前空间或已归档，请刷新核对。')
            node = {'id': 'intake-'+key, 'kind': 'intake', 'data': {
                'title': request.get('title') or '对话进展整理', 'text': request['text'], 'workspace': request.get('workspace', 'lingguang'),
                'source': request.get('source'), 'created_at': now(), 'updated_at': now(), 'status': 'pending', 'revision': 1,
                'summary': '', 'questions': [], 'related_ids': refs, 'execution': request.get('execution', 'automatic')}}
            if 'question_key' in request:
                node['data']['question_key'] = request['question_key']
            for field in ('chat_id', 'chat_parent', 'model', 'question_text', 'question_keys', 'task_review', 'agent_role', 'episode_ref'):
                if field in request:
                    node['data'][field] = request[field]
            if 'chat_id' in request:
                node['data']['agent_role'] = chat_role
        node['data']['agent_role'] = role_for(node['data'])
        require(enabled(nodes, node['data']['workspace']), '尚未启用此空间的自主整理规则')
        updates = [node]
        if node['data'].get('chat_id') and 'chat-'+node['data']['chat_id'] not in nodes:
            with store.db() as db:
                upgraded = db.execute('PRAGMA user_version').fetchone()[0] == 2
            if upgraded:
                from lumos_conversations import conversation_node
                updates.append(conversation_node(node['data']['chat_id'], node['data']['agent_role'],
                    node['data']['workspace'], node['data']['title']))
        commit_tasks(store, nodes, {'reason': reason, 'updates': updates}, node['id'])
        return {'intake': node, 'replayed': False}


def scoped_nodes(nodes, workspace):
    contexts = {i for i, n in nodes.items() if n['kind'] == 'context' and context_workspace(n) == workspace
                and n['data'].get('status', 'active') in ACTIVE}
    records = {i: n for i, n in nodes.items() if (n['kind'] in {'action', 'mainline', 'person', 'evidence', 'decision'}
               and n['data'].get('context') in contexts) or i in contexts or i == POLICY}
    refs = {ref for n in records.values() if n['kind'] == 'mainline' for ref in n['data'].get('source_ids', [])}
    records.update({i: nodes[i] for i in refs if i in nodes and nodes[i]['kind'] == 'document'
                    and context_workspace(nodes[nodes[i]['data']['context']]) == workspace})
    return records


def fingerprint(nodes):
    return digest(json.dumps(nodes, ensure_ascii=False, sort_keys=True).encode())


def validate_answer_state(answer):
    state = answer.get('state', 'resolved')
    require(state in {'resolved', 'pending', 'waiting'}, 'Invalid question state')
    for field in ('remaining', 'review_on', 'waiting_for'):
        require(isinstance(answer.get(field, ''), str) and len(answer.get(field, '')) <= 2000, 'Invalid question '+field)
    remaining, review, trigger = (answer.get(k, '') for k in ('remaining', 'review_on', 'waiting_for'))
    if state == 'resolved':
        require(not (remaining or review or trigger), '已答问题不能带剩余问题或跟进条件')
    else:
        require(remaining.strip(), '部分答复必须写明剩余问题')
        if state == 'waiting':
            require(review or trigger.strip(), '后续跟进必须有日期或触发条件')
        else:
            require(not review and not trigger, '当前待答不能带等待条件')
    if review:
        require(bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', review)), '问题跟进日期格式错误')
        try:
            date.fromisoformat(review)
        except ValueError:
            require(False, '问题跟进日期无效')


def open_questions(nodes, workspace):
    result = []
    for n in nodes.values():
        data = n['data']
        if n['kind'] != 'intake' or data['workspace'] != workspace or data['status'] != 'needs_review':
            continue
        for index, question in enumerate(data.get('questions', [])):
            answers = [r for r in data.get('resolutions', []) if r['index'] == index]
            last = answers[-1] if answers else {}
            if answers and last.get('state', 'resolved') == 'resolved':
                continue
            original = next((r['previous'] for r in data.get('question_revisions', []) if r['index'] == index), question)
            result.append({'intake_id': n['id'], 'index': index,
                'question': last.get('remaining') or question, 'original_question': original,
                'answer_state': last.get('state', ''), 'answers': answers,
                'review_on': last.get('review_on', ''), 'waiting_for': last.get('waiting_for', ''),
                'related_ids': list(dict.fromkeys(data.get('related_ids', []) + [r['id'] for r in data.get('task_reviews', []) if r['question'] == f'new:{index}'])),
                'destinations': data.get('destinations', [])})
    return result


def context_basis(nodes, workspace):
    return fingerprint({'records': scoped_nodes(nodes, workspace), 'questions': open_questions(nodes, workspace)})


def review_matches(nodes, review):
    line = nodes.get(review['id'], {})
    data = line.get('data', {})
    return (line.get('kind') == 'mainline' and data.get('status', 'active') == 'active'
            and nodes.get(data.get('context'), {}).get('data', {}).get('status', 'active') in ACTIVE
            and data.get('review_on') == review['on'] and data.get('review_revision', 0) == review['revision'])


def enqueue_due_reviews(store):
    """One durable review per scheduled date/version, including after a restart."""
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            nodes = store.nodes(db)
            numbers = task_numbers(db)
        from lumos_followup import synchronize_followups
        updates = synchronize_followups(nodes, numbers)
        scheduled = 0
        for line in nodes.values():
            data = line['data']
            if line['kind'] != 'mainline' or not data.get('review_on') or data['review_on'] > today():
                continue
            review = {'id': line['id'], 'on': data['review_on'], 'revision': data.get('review_revision', 0)}
            workspace = context_workspace(nodes[data['context']])
            if not review_matches(nodes, review) or not enabled(nodes, workspace):
                continue
            ident = 'review-'+fingerprint(review)[:32]
            if ident in nodes:
                continue
            updates.append({'id': ident, 'kind': 'intake', 'data': {
                'title': data['title']+' · 到期复核', 'text': '系统到期复核：核对当前已有依据、风险和下一步；本次没有新增用户进展。',
                'workspace': workspace, 'review': review, 'related_ids': [line['id']],
                'status': 'pending', 'revision': 1, 'summary': '', 'questions': [],
                'created_at': now(), 'updated_at': now(),
                'source': {'type': 'agent', 'ref': '主线复核日期 '+data['review_on'], 'authorization': POLICY}}})
            scheduled += 1
        if updates:
            commit_tasks(store, nodes, {'reason': 'enqueue due mainline reviews', 'updates': updates}, updates[0]['id'])
        return scheduled


def review_changes(previous, changes, field, item, source, management=False):
    """Keep explicit user schedules distinct from inferred internal arrangements."""
    require(field in changes or not (set(changes) & {'review_basis', 'review_reason'}), '复核依据必须随日期一起保存')
    if field not in changes:
        return changes
    changes = dict(changes)
    basis = 'agent' if item['mode'] == 'planned' or changes.get('review_basis') == 'agent' else 'user'
    old = previous['data'] if previous else {}
    protected = old.get('review_basis') == 'user' or (old.get(field) and old.get('review_basis') != 'agent')
    if protected and changes[field] != old.get(field, '') and not management:
        require(basis == 'user', '用户安排的复核日期只能依据新的明确用户安排修改')
    if field == 'review_on' and basis == 'agent' and changes[field] and changes[field] != old.get(field):
        require(changes[field] > today(), 'Agent新复核安排必须晚于今天，避免重复到期循环')
    if changes[field] == old.get(field, '') and old.get('review_basis'):
        changes.update(review_basis=old['review_basis'], review_reason=old.get('review_reason', ''))
    else:
        changes.update(review_basis=basis, review_reason=item['reason'])
        if field == 'review_on':
            changes.update(review_source=source, review_revision=old.get('review_revision', 0)+1)
    return changes


def intake_context(store, ident):
    with process_lock(store.root), store.db() as db:
        nodes = store.nodes(db)
        job = nodes.get(ident)
        require(job and job['kind'] == 'intake', 'Intake not found')
        records = scoped_nodes(nodes, job['data']['workspace'])
        note = job['data'].get('note')
        text = note_version(db, note['id'], note['revision'])['data']['body'] if note else job['data']['text']
        numbers = task_numbers(db)
        # Send current working records and exact linked evidence, not all historical conversations.
        evidence = {ref for n in records.values() if n['kind'] == 'mainline' for ref in n['data'].get('source_ids', [])}
        visible = [dict(n, **({'short_id': numbers[n['id']]} if n['kind'] == 'action' else {})) for n in records.values()
                   if n['kind'] not in {'evidence', 'decision'} or n['id'] in evidence or n['id'] == POLICY]
        for record in visible:
            if record['kind'] == 'document' and record['data']['path'].endswith('.md'):
                content = safe_path(store.root, record['data']['version']).read_bytes()
                require(digest(content) == record['data']['sha256'], 'Damaged source version: '+record['id'])
                record['content'] = content.decode('utf-8-sig')
        from lumos_followup import followup_questions
        result = {'intake': job, 'text': text, 'today': today(), 'basis': context_basis(nodes, job['data']['workspace']),
                  'records': visible, 'open_questions': followup_questions(nodes, job['data']['workspace'], numbers)}
        from lumos_agents import ROLES, role_for, diagnostics, role_reports
        result['agent'] = {'role': role_for(job['data']), **ROLES[role_for(job['data'])]}
        result['diagnostics'] = diagnostics(nodes, job['data']['workspace'])
        result['lumos_reports'] = role_reports(nodes, job['data']['workspace'], 'lumos')[:30]
        result['ops_reports'] = role_reports(nodes, job['data']['workspace'], 'maintainer')[:30]
        if job['data'].get('episode_ref'):
            ref = nodes[job['data']['episode_ref']]
            result['episode'] = {'id': ref['id'], **{k: ref['data'][k] for k in
                ('status', 'summary', 'error', 'destinations', 'lumos_report', 'ops_report') if k in ref['data']},
                'agent_steps': [{k: v for k, v in s.items() if k != 'proposal'} for s in ref['data'].get('agent_steps', [])]}
        if job['data'].get('chat_id'):
            conversation = nodes.get('chat-'+job['data']['chat_id'])
            if conversation:
                result['conversation'] = conversation
            history, parent = [], job['data'].get('chat_parent')
            visited = {job['id']}
            while parent:
                require(parent not in visited, 'Invalid chat history cycle')
                visited.add(parent)
                prior = nodes[parent]
                history.append({'id': parent, 'text': prior['data']['text'], 'reply': prior['data'].get('reply', ''),
                                'summary': prior['data']['summary'], 'created_at': prior['data']['created_at'],
                                'agent_role': prior['data'].get('agent_role', 'legacy')})
                parent = prior['data'].get('chat_parent')
            result['chat_history'] = list(reversed(history))
        return result


def claim_intake(store, ident=None):
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            nodes = store.nodes(db)
        jobs = sorted((n for n in nodes.values() if n['kind'] == 'intake' and enabled(nodes, n['data']['workspace'])
                       and (n['id'] == ident if ident else n['data'].get('execution') != 'conversation')
                       and (n['data']['status'] == 'pending' or (n['data']['status'] == 'running' and n['data'].get('lease_until', '') < now()))),
                      key=lambda n: (bool(n['data'].get('review')), n['data']['created_at']))
        for old in list(jobs):
            if old['data'].get('review') and not review_matches(nodes, old['data']['review']):
                node = {**old, 'data': {**old['data'], 'status': 'obsolete', 'summary': '复核安排已变化，本次不再执行。',
                                      'revision': old['data']['revision']+1, 'updated_at': now()}}
                commit_tasks(store, nodes, {'reason': 'obsolete mainline review', 'updates': [node]}, node['id'])
                nodes[node['id']] = node
                jobs.remove(old)
        if not jobs:
            return None
        old = jobs[0]
        node = {**old, 'data': {**old['data'], 'status': 'running', 'claim': uuid.uuid4().hex,
                'lease_until': (datetime.now(timezone.utc)+timedelta(minutes=15)).isoformat(),
                'revision': old['data']['revision']+1, 'updated_at': now()}}
        node['data']['agent_steps'] = [{**s, 'status': 'interrupted', 'finished_at': now()} if s['status'] == 'running' else s
                                      for s in old['data'].get('agent_steps', [])]
        from lumos_agents import role_for
        if role_for(node['data']) == 'maintainer' and node['data'].get('episode_ref'):
            node['data']['episode_claim'] = nodes[node['data']['episode_ref']]['data'].get('claim', '')
        if role_for(node['data']) in {'aipm', 'librarian'} and not node['data'].get('lumos_report'):
            node['data']['lumos_report'] = {'from_role': role_for(node['data']), 'to_role': 'lumos',
                'status': 'processing', 'at': now(), 'summary': '已接收：'+node['data']['title'], 'decision': None}
        commit_tasks(store, nodes, {'reason': 'claim intake', 'updates': [node]}, node['id'])
        return node


def fail_intake(store, ident, claim, error):
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            nodes = store.nodes(db)
        old = nodes[ident]
        if old['data'].get('claim') != claim or old['data']['status'] != 'running':
            return
        node = {**old, 'data': {**old['data'], 'status': 'failed', 'error': str(error)[:2000],
                'revision': old['data']['revision']+1, 'updated_at': now()}}
        from lumos_agents import role_for
        prior = old['data'].get('ops_report', {})
        node['data']['ops_report'] = {'from_role': role_for(old['data']), 'to_role': 'maintainer', 'report_to': '王牧楠',
            'status': 'pending', 'at': now(), 'count': prior.get('count', 0)+1,
            'summary': str(error)[:2000], 'claim': claim,
            'impact': '本次处理未完成，原输入仍保留；没有应用本轮业务结果。',
            'previous_diagnosis': prior.get('diagnosis', prior.get('previous_diagnosis', ''))}
        commit_tasks(store, nodes, {'reason': 'intake failed; no partial result applied', 'updates': [node]}, ident)


def apply_intake(store, request):
    require(isinstance(request, dict) and set(request) == {'id', 'claim', 'basis', 'plan'}, 'Invalid reconciliation envelope')
    plan = request['plan']
    require(isinstance(plan, dict) and {'summary', 'questions', 'updates'} <= set(plan)
            and set(plan) <= {'summary', 'questions', 'updates', 'resolutions', 'reply', 'task_reviews', 'note_format', 'findings'}, 'Invalid reconciliation plan')
    require(isinstance(plan.get('reply', ''), str) and len(plan.get('reply', '')) <= 20000, 'Invalid chat reply')
    require(isinstance(plan['summary'], str) and 0 < len(plan['summary']) <= 4000, 'Receipt summary required')
    require(isinstance(plan['questions'], list) and all(isinstance(q, str) and 0 < len(q) <= 2000 for q in plan['questions']), 'Invalid questions')
    require(isinstance(plan['updates'], list) and len(plan['updates']) <= 100, 'Too many updates')
    resolutions = plan.get('resolutions', [])
    require(isinstance(resolutions, list) and len(resolutions) <= 100, 'Invalid question resolutions')
    plan_hash = fingerprint(request)
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            nodes = store.nodes(db)
            old = nodes.get(request['id'])
            require(old and old['kind'] == 'intake', 'Intake not found')
            job = old['data']
            require(bool(plan.get('reply', '').strip()) if job.get('chat_id') else 'reply' not in plan, '对话需要答复；普通整理不能用答复代替承接')
            if job.get('applied_hash') == plan_hash:
                return {'intake': old, 'replayed': True}
            require(job['status'] == 'running' and job.get('claim') == request['claim'], '整理已换批次，请重新读取')
            from lumos_agents import check_plan, role_for, diagnostics, report_receipt, missing_followups
            role = role_for(job)
            if job.get('agent_steps'):
                require(job.get('prepared_claim') == request['claim'] and job.get('prepared_plan') == fingerprint(plan),
                        '协作结果尚未完整校验，不能保存')
            else:
                # Desktop callers compose their own plans; named specialists retain the same field boundaries.
                if job.get('note_mode') == 'format':
                    require(not (plan['updates'] or plan['questions'] or resolutions), '笔记润色不能修改业务记录或提出主线问题')
                check_plan(role, plan, coordinator=role == 'lumos')
            report = report_receipt(job, plan, request['basis'])
            if job.get('agent_steps') and report.get('lumos_report', {}).get('decision'):
                require(not missing_followups(plan, nodes), 'Lumos 决策仍缺少下次关心时间，尚未保存')
            if 'findings' in plan:
                actual = {f['key']: f for f in diagnostics(nodes, job['workspace'])}
                require(role == 'maintainer' and isinstance(plan['findings'], list)
                        and all(f in actual.values() for f in plan['findings']), '诊断必须引用当前巡检证据')
            require(enabled(nodes, job['workspace']), '自主整理授权已停用')
            require(context_basis(nodes, job['workspace']) == request['basis'], '相关任务、人员或待答问题已变化，请重新整理；尚未写入结果。')
            note_ref = job.get('note')
            source_note = nodes[note_ref['id']] if note_ref else None
            text = note_version(db, note_ref['id'], note_ref['revision'])['data']['body'] if note_ref else job['text']
        if source_note and (source_note['data']['revision'] != note_ref['revision'] or source_note['data'].get('recording') == 'editing'
                            or source_note['data']['status'] != 'active'):
            node = {**old, 'data': {**job, 'status': 'obsolete', 'summary': '笔记已修改，本次未应用；请结束新版本后整理。',
                                  'revision': job['revision']+1, 'updated_at': now()}}
            commit_tasks(store, nodes, {'reason': 'stale intake source', 'updates': [node]}, old['id'])
            return {'intake': node, 'replayed': False}
        source = {'type': 'agent', 'ref': '自主整理 '+old['id'], 'intake_id': old['id'], 'authorization': POLICY,
                  'episode_id': old['id'], 'agent_role': role, 'operation_id': plan_hash}
        if job.get('note_mode') == 'format':
            require(source_note and not (plan['updates'] or plan['questions'] or resolutions), '笔记润色不能修改业务记录或提出主线问题')
            formatted = plan.get('note_format')
            require(isinstance(formatted, dict) and set(formatted) == {'title', 'body', 'related_ids'}, 'Invalid note formatting result')
            refs = formatted['related_ids']
            scoped = scoped_nodes(nodes, job['workspace'])
            require(isinstance(refs, list) and len(refs) <= 20 and all(isinstance(i, str) and i in scoped
                    and scoped[i]['kind'] in {'action', 'mainline'} for i in refs), '笔记关联必须是当前空间的任务或主线')
            from lumos_notes import validate_note
            data = {**source_note['data'], 'title': formatted['title'], 'body': formatted['body'], 'suggested_refs': list(dict.fromkeys(refs)),
                    'formatted_revision': source_note['data']['revision']+1, 'original_revision': note_ref['revision'],
                    'revision': source_note['data']['revision']+1, 'checkpoint': True, 'updated_at': now(),
                    'source': {**source, 'original_revision': note_ref['revision']}}
            require(isinstance(data['body'], str) and (data['body'].strip() or not text.strip()), '润色结果不能丢弃原正文')
            validate_note(data)
            note = {**source_note, 'data': data}
            receipt = {**old, 'data': {**job, 'status': 'done', 'summary': plan['summary'], 'questions': [],
                'destinations': [note['id']], 'applied_hash': plan_hash, 'revision': job['revision']+1, 'updated_at': now(), 'error': '', **report}}
            commit_tasks(store, nodes, {'reason': 'reconcile:'+old['id']+':'+plan_hash, 'updates': [note, receipt]}, old['id'])
            return {'intake': receipt, 'replayed': False}
        require('note_format' not in plan, '只有笔记润色可以改写笔记正文')
        management = management_enabled(nodes, job['workspace'])
        full_review = job.get('task_review', False)
        require('task_reviews' not in plan or full_review, '只有全量复核才能提交逐任务回执')
        if full_review:
            require(management and not resolutions, '全量复核需要统筹授权，不能代替王牧楠回答旧问题')
        review = job.get('review')
        if review:
            require(review_matches(nodes, review), '复核安排已变化，请重新整理')
            require(not resolutions, '系统复核没有新答复，不能关闭旧问题')
        updates, seen = [], set()
        for item in plan['updates']:
            require(isinstance(item, dict) and set(item) == {'id', 'kind', 'changes', 'reason', 'excerpt', 'mode'}, 'Invalid update item')
            ident, kind, changes = item['id'], item['kind'], item['changes']
            require(isinstance(ident, str) and re.fullmatch('[A-Za-z0-9_-]+', ident) and ident not in seen, 'Invalid/duplicate update ID')
            seen.add(ident)
            require(isinstance(changes, dict) and changes and isinstance(item['reason'], str) and 0 < len(item['reason']) <= 2000, 'Change and reason required')
            require(isinstance(item['excerpt'], str) and item['excerpt'].strip() and len(item['excerpt']) <= 20000 and item['excerpt'] in text, 'Update excerpt must match input')
            require(item['mode'] in {'reported', 'planned'}, 'Invalid update mode')
            previous = nodes.get(ident)
            require(not previous or previous['kind'] == kind, 'Cannot change record kind')
            own_source = {**source, 'quote': item['excerpt'], 'reason': item['reason'], 'mode': item['mode']}
            author = next((s for s in reversed(job.get('agent_steps', [])) if s['claim'] == job.get('claim')
                           and s['role'] != 'lumos' and ident in s.get('targets', [])), None)
            if author:
                own_source.update(agent_role=author['role'], attempt_id=author['attempt_id'])
            if review:
                require(item['mode'] == 'planned' and kind == 'mainline' and ident == review['id']
                        and set(changes) <= {'summary', 'risk', 'next_step', 'review_on', 'review_basis', 'review_reason'},
                        '系统复核只能整理该主线的现有摘要、风险和复核安排，不能推定新进展')
            if full_review:
                require(item['mode'] == 'planned', '全量复核没有新进展报告，必须保留推断性质')
                require(kind in {'action', 'mainline', 'evidence'}, '全量任务复核不调整人员档案')
                if kind == 'action':
                    require(previous and previous['data']['status'] not in {'done', 'cancelled'}, '只复核当前未结束任务')
                if kind == 'mainline':
                    require(not (set(changes) & {'as_of', 'phase', 'goal'}), '复核时间不能冒充主线新进展')
            if kind == 'action':
                require(set(changes) <= FIELDS, '整理方案包含不允许修改的任务字段：' + '、'.join(sorted(set(changes) - FIELDS)) + '；任务未更新，原答复已保留。需修正整理方案后重试。')
                changes = dict(changes)
                if item['mode'] == 'planned':
                    allowed = not (set(changes) & {'due', 'completed_on', 'status', 'condition'}) if previous else not changes.get('due') and changes.get('status', 'todo') == 'todo'
                    require(allowed,
                            'Agent计划不能改承诺、验收条件或任务状态')
                owner_planned = item['mode'] == 'planned' or changes.get('owner_basis') == 'agent'
                if 'owner' in changes:
                    if owner_planned:
                        if previous and previous['data'].get('owner') and previous['data'].get('owner_basis') != 'agent' and not management:
                            require(changes['owner'] == previous['data']['owner'], '已有明确负责人不能由推测改派')
                        names = [name.strip() for name in changes['owner'].split('、')]
                        people = [n['data'] for n in nodes.values() if n['kind'] == 'person' and n['data']['title'] in names
                                  and job['workspace'] in n['data']['workspaces'] and n['data'].get('status', 'active') == 'active'
                                  and n['data'].get('membership_status', 'member') == 'member']
                        require((len(people) == len(names) == len(set(names))) or changes['owner'] == '待分配', '自动分配需要当前在岗人员或待分配')
                    changes.update(owner_basis='agent' if owner_planned else 'user', owner_reason=item['reason'])
                if not previous and not changes.get('owner'):
                    changes.update(owner='待分配', owner_basis='agent', owner_reason='尚无可靠分工依据')
                if 'planned_due' in changes:
                    changes['planning_reason'] = item['reason']
                changes = review_changes(previous, changes, 'follow_up', item, own_source, management)
                if changes.get('status') == 'done' and (not previous or previous['data']['status'] != 'done'):
                    require(item['mode'] == 'reported', '完成须有明确报告')
                    if not changes.get('completed_on'):
                        changes['completed_on'] = today()
                        own_source['date_basis'] = '未说明实际日期，按报告录入当天记录'
                refs = list(previous['data'].get('note_refs', [])) if previous else []
                if note_ref and not any(r['id'] == note_ref['id'] and r['revision'] == note_ref['revision'] for r in refs):
                    refs.append({**note_ref, 'excerpt': item['excerpt']})
                changes_source = {**own_source, 'type': 'user_report'} if item['mode'] == 'reported' else own_source
                data = prepare_task(store, nodes, previous, changes, changes_source, refs)
                from lumos_task_review import acknowledge_edits
                acknowledge_edits(data)
                if {'follow_up', 'planned_due'} & changes.keys() and data.get('review_basis') == 'agent':
                    from lumos_tasks import current_due
                    due = current_due(data)
                    if due and due != 'long_term' and due >= today():
                        require(not data.get('follow_up') or data['follow_up'] <= due,
                                'Lumos的跟进安排不能晚于尚未到期的交付日期')
            elif kind == 'mainline':
                require(previous and set(changes) <= {'goal', 'summary', 'phase', 'risk', 'next_step', 'as_of', 'review_on', 'review_basis', 'review_reason', 'priority', 'priority_basis', 'priority_reason', 'task_ids', 'milestone_ids', 'source_ids', 'related_mainlines'}, 'Invalid mainline change')
                if 'priority' in changes:
                    changes = {**changes, 'priority_basis': 'agent' if item['mode'] == 'planned' or changes.get('priority_basis') == 'agent' else 'user',
                               'priority_reason': item['reason']}
                changes = review_changes(previous, changes, 'review_on', item, own_source, management)
                data = {**previous['data'], **changes, 'source': own_source}
            elif kind == 'person':
                require(previous and set(changes) == {'assessment'}, 'Only responsibility assessment may be inferred')
                assessment = changes['assessment']
                require(isinstance(assessment, dict) and set(assessment) == {'summary', 'responsibilities', 'uncertainties', 'basis_ids'}, 'Invalid assessment')
                require(isinstance(assessment['summary'], str) and 0 < len(assessment['summary']) <= 2000, 'Assessment summary required')
                for field in ('responsibilities', 'uncertainties', 'basis_ids'):
                    require(isinstance(assessment[field], list) and all(isinstance(v, str) and 0 < len(v) <= 1000 for v in assessment[field]), 'Invalid assessment '+field)
                require(all(i in scoped_nodes(nodes, job['workspace']) for i in assessment['basis_ids']), 'Assessment basis missing or outside workspace')
                data = {**previous['data'], 'assessment': {**assessment, 'as_of': today(), 'source': own_source}}
            elif kind == 'evidence':
                require(not previous and set(changes) == {'context', 'text', 'title'}, 'New evidence only')
                data = {**changes, 'source': own_source}
            else:
                require(False, 'Unsupported reconciliation kind')
            context = nodes.get(data.get('context'))
            require(context and context['kind'] == 'context' and context_workspace(context) == job['workspace']
                    and context['data'].get('status', 'active') in ACTIVE, 'Update outside active workspace')
            updates.append({'id': ident, 'kind': kind, 'data': data})
        resolved = {}
        available = {(q['intake_id'], q['index']) for q in open_questions(nodes, job['workspace'])}
        for answer in resolutions:
            require(isinstance(answer, dict) and {'intake_id', 'index', 'answer', 'excerpt'} <= set(answer) <= {'intake_id', 'index', 'answer', 'excerpt', 'state', 'remaining', 'review_on', 'waiting_for'}, 'Invalid question resolution')
            require(isinstance(answer['intake_id'], str) and type(answer['index']) is int, 'Invalid question identity')
            key = (answer['intake_id'], answer['index'])
            require(key in available and key[0] != old['id'], '问题已处理或不属于当前空间')
            available.remove(key)
            require(isinstance(answer['answer'], str) and 0 < len(answer['answer']) <= 2000, 'Answer required')
            require(isinstance(answer['excerpt'], str) and answer['excerpt'].strip() and len(answer['excerpt']) <= 20000
                    and answer['excerpt'] in text, 'Answer excerpt must match input')
            validate_answer_state(answer)
            prior = resolved.setdefault(key[0], {**nodes[key[0]], 'data': {**nodes[key[0]]['data'],
                'resolutions': list(nodes[key[0]]['data'].get('resolutions', []))}})
            prior['data']['resolutions'].append({**answer, 'source_intake': old['id'], 'at': now()})
        for question_key in set([job.get('question_key', ''), *job.get('question_keys', [])]):
            if not question_key.startswith('question:'):
                continue
            selected = next((q for q in open_questions(nodes, job['workspace']) if f"question:{q['intake_id']}:{q['index']}" == question_key), None)
            require(not selected or any(a['intake_id'] == selected['intake_id'] and a['index'] == selected['index'] for a in resolutions),
                    '答复尚未接续所选问题：请记录已答内容、剩余问题或后续跟进；任务未更新。')
        for prior in resolved.values():
            data = prior['data']
            latest = {r['index']: r for r in data['resolutions']}
            data.update(status='done' if all(i in latest and latest[i].get('state', 'resolved') == 'resolved' for i in range(len(data['questions']))) else 'needs_review',
                        revision=data['revision']+1, updated_at=now())
            updates.append(prior)
            note = data.get('note')
            if note and data['status'] == 'done' and (not note_ref or note['id'] != note_ref['id']):
                original = nodes[note['id']]
                if original['data']['revision'] == note['revision'] and original['data'].get('recording') != 'editing':
                    updates.append({**original, 'data': {**original['data'], 'status': 'archived',
                        'archive_reason': '剩余问题已由 '+old['id']+' 承接；原整理去向：'+', '.join(data.get('destinations', []))[:900],
                        'revision': original['data']['revision']+1, 'checkpoint': False, 'updated_at': now(), 'source': source}})
        if review:
            target = next((n for n in updates if n['id'] == review['id']), None)
            if target is None:
                target = {**nodes[review['id']], 'data': dict(nodes[review['id']]['data'])}
                updates.append(target)
            target['data'].update(review_checked_on=review['on'], review_checked_revision=review['revision'],
                                  review_checked_at=now(), review_receipt=old['id'])
        if full_review:
            from lumos_task_review import complete_task_review
            complete_task_review(nodes, updates, old, plan.get('task_reviews'), plan['questions'], open_questions(nodes, job['workspace']), today())
        require(updates or plan['questions'] or job.get('chat_id') or full_review or role == 'maintainer', '不能把未承接的内容标为已整理')
        receipt = {**old, 'data': {**job, 'status': 'needs_review' if plan['questions'] else 'done',
                   'summary': plan['summary'], 'questions': plan['questions'], 'destinations': [n['id'] for n in updates],
                   'applied_hash': plan_hash, 'revision': job['revision']+1, 'updated_at': now(), 'error': '', **report}}
        if job.get('ops_report'):
            receipt['data']['ops_report'] = {**job['ops_report'], 'status': 'recovered', 'recovered_at': now(),
                'impact': '该次处理已成功接续；不代表底层故障已永久修复。'}
        if full_review:
            receipt['data'].update(task_reviews=plan['task_reviews'], completed_at=now())
        if job.get('chat_id'):
            receipt['data']['reply'] = plan['reply']
        if role == 'maintainer':
            require(not (updates or resolutions or plan['questions']), '仓库维护者不能修改业务记录')
            receipt['data']['findings'] = plan.get('findings', [])
            target = nodes.get(job.get('episode_ref'))
            if target and (target['data'].get('ops_report') or target['data']['status'] in {'failed', 'running'}):
                require(target['data'].get('claim', '') == job.get('episode_claim', ''), '原执行已重新领取，需核对新故障后再诊断')
                prior_report = target['data'].get('ops_report') or {'from_role': role_for(target['data']), 'to_role': 'maintainer',
                    'report_to': '王牧楠', 'status': 'pending', 'at': target['data']['updated_at'], 'summary': target['data'].get('error', ''),
                    'claim': target['data'].get('claim', '')}
                updated = {**target, 'data': {**target['data'], 'ops_report': {**prior_report,
                    'status': 'diagnosed' if prior_report['status'] != 'recovered' else 'recovered',
                    'diagnosis': plan.get('reply', plan['summary']), 'diagnosis_episode': old['id'], 'diagnosed_at': now()},
                    'revision': target['data']['revision']+1, 'updated_at': now()}}
                updates.append(updated)
        updates.append(receipt)
        if source_note and (not plan['questions'] or job.get('note_mode') == 'archive'):
            data = {**source_note['data'], 'status': 'archived', 'archive_mode': 'lumos', 'archive_reason': plan['summary'][:1000]+'；去向：'+', '.join(receipt['data']['destinations'])[:900],
                    'revision': source_note['data']['revision']+1, 'checkpoint': False, 'updated_at': now(), 'source': source}
            updates.append({**source_note, 'data': data})
        from lumos_followup import synchronize_followups
        merged = {**nodes, **{n['id']: n for n in updates}}
        with store.db() as db:
            numbers = task_numbers(db)
        # Knowledge-only and diagnostic work cannot change task schedules as a side effect.
        task_work = bool(plan['questions'] or resolutions or full_review or review
                         or any(n['kind'] in {'action', 'mainline', 'person'} for n in updates))
        synchronized = {n['id']: n for n in synchronize_followups(merged, numbers)} if task_work else {}
        updates = [synchronized.pop(n['id'], n) for n in updates] + list(synchronized.values())
        commit_tasks(store, nodes, {'reason': 'reconcile:'+old['id']+':'+plan_hash, 'updates': updates}, old['id'])
        return {'intake': receipt, 'replayed': False}
