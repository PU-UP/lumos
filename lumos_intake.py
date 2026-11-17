"""Versioned inputs and atomic Agent reconciliations, sharing the task store."""
import json
import re
import uuid
from datetime import datetime, timedelta, timezone

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


def validate_intake(data, nodes):
    require(data.get('workspace') in {'lingguang', 'lumos'} and data.get('status') in STATES, 'Invalid intake state/space')
    require(type(data.get('revision')) is int and data['revision'] > 0, 'Invalid intake revision')
    for field, limit in [('title', 300), ('text', 200000), ('summary', 4000), ('error', 2000)]:
        require(isinstance(data.get(field, ''), str) and len(data.get(field, '')) <= limit, 'Invalid intake '+field)
    require(isinstance(data.get('source'), dict) and data['source'].get('ref'), 'Intake needs a source')
    require(isinstance(data.get('question_key', ''), str) and len(data.get('question_key', '')) <= 500, 'Invalid question key')
    require(isinstance(data.get('questions', []), list) and all(isinstance(q, str) and len(q) <= 2000 for q in data.get('questions', [])), 'Invalid questions')
    answers = data.get('resolutions', [])
    require(isinstance(answers, list), 'Invalid resolutions')
    indices = set()
    for answer in answers:
        require(isinstance(answer, dict) and type(answer.get('index')) is int
                and 0 <= answer['index'] < len(data.get('questions', [])) and answer['index'] not in indices, 'Invalid resolved question')
        require(all(isinstance(answer.get(k), str) and answer[k] for k in ('answer', 'excerpt', 'source_intake', 'at')), 'Resolution source required')
        require(nodes.get(answer['source_intake'], {}).get('kind') == 'intake', 'Resolution intake missing')
        indices.add(answer['index'])
    review = data.get('review')
    if review:
        require(isinstance(review, dict) and set(review) == {'id', 'on', 'revision'}
                and nodes.get(review['id'], {}).get('kind') == 'mainline'
                and isinstance(review['on'], str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', review['on'])
                and type(review['revision']) is int and review['revision'] >= 0, 'Invalid scheduled review')
    note = data.get('note')
    if note:
        require(set(note) == {'id', 'revision'} and nodes.get(note['id'], {}).get('kind') == 'note', 'Invalid intake note')
        require(type(note['revision']) is int and 0 < note['revision'] <= nodes[note['id']]['data']['revision'], 'Invalid intake note revision')


def note_intake(node):
    data = node['data']
    return {'id': 'intake-'+digest(f"{node['id']}:{data['revision']}".encode())[:32], 'kind': 'intake', 'data': {
        'title': data['title'], 'workspace': data['workspace'], 'status': 'pending', 'revision': 1,
        'note': {'id': node['id'], 'revision': data['revision']}, 'created_at': now(), 'updated_at': now(),
        'summary': '', 'questions': [], 'source': {'type': 'user', 'ref': f"结束笔记 {node['id']} revision {data['revision']}"}}}


def note_intake_status(nodes, note_id):
    jobs = [n for n in nodes.values() if n['kind'] == 'intake' and n['data'].get('note', {}).get('id') == note_id]
    return max(jobs, key=lambda n: n['data']['note']['revision']) if jobs else None


def list_intakes(store, workspace='lingguang'):
    require(workspace in {'lingguang', 'lumos'}, 'Invalid workspace')
    with process_lock(store.root), store.db() as db:
        nodes = store.nodes(db)
        jobs = [n for n in nodes.values() if n['kind'] == 'intake' and n['data']['workspace'] == workspace]
        jobs.sort(key=lambda n: n['data']['created_at'], reverse=True)
        return {'intakes': [{**n, 'subjects': [{'id': i, 'title': nodes[i]['data'].get('title') or nodes[i]['data'].get('text', i)}
                    for i in n['data'].get('related_ids', []) if i in nodes], 'targets': [{'id': i, 'kind': nodes[i]['kind'],
                    'title': nodes[i]['data'].get('title') or nodes[i]['data'].get('text', i)}
                    for i in n['data'].get('destinations', []) if i in nodes]} for n in jobs], 'enabled': enabled(nodes, workspace)}


def save_intake(store, request):
    require(isinstance(request, dict) and set(request) <= {'request_id', 'workspace', 'text', 'title', 'source', 'note_id', 'id', 'expected_revision', 'execution', 'related_ids', 'question_key'}, 'Invalid intake request')
    require(request.get('execution', 'automatic') in {'automatic', 'conversation'}, 'Invalid execution mode')
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
            require(note and note['kind'] == 'note' and note['data'].get('recording', 'finished') == 'finished', '请先结束笔记记录')
            node = note_intake(note)
            if node['id'] in nodes:
                return {'intake': nodes[node['id']], 'replayed': True}
        else:
            require(isinstance(request.get('text'), str) and request['text'].strip(), 'Progress text required')
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
        require(enabled(nodes, node['data']['workspace']), '尚未启用此空间的自主整理规则')
        commit_tasks(store, nodes, {'reason': reason, 'updates': [node]}, node['id'])
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


def open_questions(nodes, workspace):
    return [{'intake_id': n['id'], 'index': index, 'question': question,
             'related_ids': n['data'].get('related_ids', []), 'destinations': n['data'].get('destinations', [])}
            for n in nodes.values() if n['kind'] == 'intake' and n['data']['workspace'] == workspace
            and n['data']['status'] == 'needs_review'
            for index, question in enumerate(n['data'].get('questions', []))
            if index not in {r['index'] for r in n['data'].get('resolutions', [])}]


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
        updates = []
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
        if updates:
            commit_tasks(store, nodes, {'reason': 'enqueue due mainline reviews', 'updates': updates}, updates[0]['id'])
        return len(updates)


def review_changes(previous, changes, field, item, source):
    """Keep explicit user schedules distinct from inferred internal arrangements."""
    require(field in changes or not (set(changes) & {'review_basis', 'review_reason'}), '复核依据必须随日期一起保存')
    if field not in changes:
        return changes
    changes = dict(changes)
    basis = 'agent' if item['mode'] == 'planned' or changes.get('review_basis') == 'agent' else 'user'
    old = previous['data'] if previous else {}
    protected = old.get('review_basis') == 'user' or (old.get(field) and old.get('review_basis') != 'agent')
    if protected and changes[field] != old.get(field, ''):
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
        return {'intake': job, 'text': text, 'today': today(), 'basis': context_basis(nodes, job['data']['workspace']),
                'records': visible, 'open_questions': open_questions(nodes, job['data']['workspace'])}


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
        commit_tasks(store, nodes, {'reason': 'intake failed; no partial result applied', 'updates': [node]}, ident)


def apply_intake(store, request):
    require(isinstance(request, dict) and set(request) == {'id', 'claim', 'basis', 'plan'}, 'Invalid reconciliation envelope')
    plan = request['plan']
    require(isinstance(plan, dict) and {'summary', 'questions', 'updates'} <= set(plan)
            and set(plan) <= {'summary', 'questions', 'updates', 'resolutions'}, 'Invalid reconciliation plan')
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
            if job.get('applied_hash') == plan_hash:
                return {'intake': old, 'replayed': True}
            require(job['status'] == 'running' and job.get('claim') == request['claim'], '整理已换批次，请重新读取')
            require(enabled(nodes, job['workspace']), '自主整理授权已停用')
            require(context_basis(nodes, job['workspace']) == request['basis'], '相关任务、人员或待答问题已变化，请重新整理；尚未写入结果。')
            note_ref = job.get('note')
            source_note = nodes[note_ref['id']] if note_ref else None
            text = note_version(db, note_ref['id'], note_ref['revision'])['data']['body'] if note_ref else job['text']
        if source_note and (source_note['data']['revision'] != note_ref['revision'] or source_note['data'].get('recording') == 'editing'):
            node = {**old, 'data': {**job, 'status': 'obsolete', 'summary': '笔记已修改，本次未应用；请结束新版本后整理。',
                                  'revision': job['revision']+1, 'updated_at': now()}}
            commit_tasks(store, nodes, {'reason': 'stale intake source', 'updates': [node]}, old['id'])
            return {'intake': node, 'replayed': False}
        source = {'type': 'agent', 'ref': '自主整理 '+old['id'], 'intake_id': old['id'], 'authorization': POLICY}
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
            if review:
                require(item['mode'] == 'planned' and kind == 'mainline' and ident == review['id']
                        and set(changes) <= {'summary', 'risk', 'next_step', 'review_on', 'review_basis', 'review_reason'},
                        '系统复核只能整理该主线的现有摘要、风险和复核安排，不能推定新进展')
            if kind == 'action':
                require(set(changes) <= FIELDS, 'Invalid task fields')
                changes = dict(changes)
                if item['mode'] == 'planned':
                    allowed = not (set(changes) & {'due', 'completed_on', 'status', 'condition'}) if previous else not changes.get('due') and changes.get('status', 'todo') == 'todo'
                    require(allowed,
                            'Agent计划不能改承诺、验收条件或任务状态')
                owner_planned = item['mode'] == 'planned' or changes.get('owner_basis') == 'agent'
                if 'owner' in changes:
                    if owner_planned:
                        if previous and previous['data'].get('owner') and previous['data'].get('owner_basis') != 'agent':
                            require(changes['owner'] == previous['data']['owner'], '已有明确负责人不能由推测改派')
                        people = [n['data'] for n in nodes.values() if n['kind'] == 'person' and n['data']['title'] == changes['owner']
                                  and job['workspace'] in n['data']['workspaces'] and n['data'].get('status', 'active') == 'active'
                                  and n['data'].get('membership_status', 'member') == 'member']
                        require(len(people) == 1 or changes['owner'] == '待分配', '自动分配需要当前在岗人员或待分配')
                    changes.update(owner_basis='agent' if owner_planned else 'user', owner_reason=item['reason'])
                if not previous and not changes.get('owner'):
                    changes.update(owner='待分配', owner_basis='agent', owner_reason='尚无可靠分工依据')
                if 'planned_due' in changes:
                    changes['planning_reason'] = item['reason']
                changes = review_changes(previous, changes, 'follow_up', item, own_source)
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
                if 'follow_up' in changes and data.get('review_basis') == 'agent':
                    due = data.get('due', '')
                    if due and due != 'long_term' and due >= today():
                        require(not data.get('follow_up') or data['follow_up'] <= due,
                                'Lumos的跟进安排不能晚于尚未到期的交付日期')
            elif kind == 'mainline':
                require(previous and set(changes) <= {'goal', 'summary', 'phase', 'risk', 'next_step', 'as_of', 'review_on', 'review_basis', 'review_reason', 'priority', 'priority_basis', 'priority_reason', 'task_ids', 'milestone_ids', 'source_ids', 'related_mainlines'}, 'Invalid mainline change')
                if 'priority' in changes:
                    changes = {**changes, 'priority_basis': 'agent' if item['mode'] == 'planned' or changes.get('priority_basis') == 'agent' else 'user',
                               'priority_reason': item['reason']}
                changes = review_changes(previous, changes, 'review_on', item, own_source)
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
            require(isinstance(answer, dict) and set(answer) == {'intake_id', 'index', 'answer', 'excerpt'}, 'Invalid question resolution')
            require(isinstance(answer['intake_id'], str) and type(answer['index']) is int, 'Invalid question identity')
            key = (answer['intake_id'], answer['index'])
            require(key in available and key[0] != old['id'], '问题已处理或不属于当前空间')
            available.remove(key)
            require(isinstance(answer['answer'], str) and 0 < len(answer['answer']) <= 2000, 'Answer required')
            require(isinstance(answer['excerpt'], str) and answer['excerpt'].strip() and len(answer['excerpt']) <= 20000
                    and answer['excerpt'] in text, 'Answer excerpt must match input')
            prior = resolved.setdefault(key[0], {**nodes[key[0]], 'data': {**nodes[key[0]]['data'],
                'resolutions': list(nodes[key[0]]['data'].get('resolutions', []))}})
            prior['data']['resolutions'].append({**answer, 'source_intake': old['id'], 'at': now()})
        for prior in resolved.values():
            data = prior['data']
            data.update(status='done' if len(data['resolutions']) == len(data['questions']) else 'needs_review',
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
        require(updates or plan['questions'], '不能把未承接的内容标为已整理')
        receipt = {**old, 'data': {**job, 'status': 'needs_review' if plan['questions'] else 'done',
                   'summary': plan['summary'], 'questions': plan['questions'], 'destinations': [n['id'] for n in updates],
                   'applied_hash': plan_hash, 'revision': job['revision']+1, 'updated_at': now(), 'error': ''}}
        updates.append(receipt)
        if source_note and not plan['questions']:
            data = {**source_note['data'], 'status': 'archived', 'archive_reason': plan['summary'][:1000]+'；去向：'+', '.join(receipt['data']['destinations'])[:900],
                    'revision': source_note['data']['revision']+1, 'checkpoint': False, 'updated_at': now(), 'source': source}
            updates.append({**source_note, 'data': data})
        commit_tasks(store, nodes, {'reason': 'reconcile:'+old['id']+':'+plan_hash, 'updates': updates}, old['id'])
        return {'intake': receipt, 'replayed': False}
