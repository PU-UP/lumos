"""Role boundaries and durable execution receipts; business writes stay in intake-apply."""
import copy
import uuid
from datetime import datetime, timedelta, timezone

from lumos import ENGINE, digest, now, process_lock, require
from lumos_tasks import commit_tasks

ROLES = {
    'lumos': {'name': 'Lumos', 'purpose': '理解意图、协调专业角色、综合答复'},
    'aipm': {'name': 'AIPM', 'purpose': '核对项目、建议安排，按 Lumos 决定落实'},
    'librarian': {'name': 'Atlas', 'purpose': '笔记、项目资料与来源，向 Lumos 回报'},
    'maintainer': {'name': 'Ops', 'purpose': '独立运行监督与诊断，直接向王牧楠汇报'},
}
KINDS = {'lumos': set(), 'aipm': {'action', 'mainline', 'person'},
         'librarian': {'evidence'}, 'maintainer': set()}


def role_for(data):
    if data.get('note_mode') == 'format':
        return 'librarian'
    if data.get('task_review') or data.get('review'):
        return 'aipm'
    return data.get('agent_role', 'lumos')


def check_plan(role, plan, *, coordinator=False):
    require(role in ROLES and isinstance(plan, dict), 'Invalid agent role/plan')
    require(isinstance(plan.get('updates'), list), 'Invalid agent updates')
    kinds = {item.get('kind') for item in plan['updates'] if isinstance(item, dict)}
    require(len([i for i in plan['updates'] if isinstance(i, dict)]) == len(plan['updates']), 'Invalid agent update')
    allowed = {'action', 'mainline', 'person', 'evidence'} if coordinator else KINDS[role]
    require(kinds <= allowed, ROLES[role]['name']+'不能提交这些业务变更')
    from lumos_followup import validate_question_options
    validate_question_options(plan.get('question_options', []), plan.get('questions', []))
    reads, registrations = plan.get('material_reads', []), plan.get('material_registrations', [])
    require(isinstance(reads, list) and len(reads) <= 3 and all(isinstance(p, str) and 0 < len(p) <= 1000 for p in reads), '每轮最多读取三份确切资料')
    require(isinstance(registrations, list) and len(registrations) <= 3, '每轮最多登记三份确切资料')
    require(not (reads or registrations) or role == 'librarian' or coordinator, '项目文件须交 Atlas 读取或登记')
    refs = plan.get('source_refs', [])
    require(isinstance(refs, list) and len(refs) <= 20, 'Invalid source references')
    require(not refs or role == 'librarian' or coordinator, '已有来源须由 Atlas 核对')
    if role != 'aipm' and not coordinator:
        require(not (plan.get('questions') or plan.get('resolutions') or plan.get('task_reviews')),
                '主线问题与任务复核须由 AIPM 承接')
    require('note_format' not in plan or role == 'librarian', '只有资料管理员可以整理笔记')
    delegates = plan.get('delegate_to', [])
    require(isinstance(delegates, list) and len(delegates) <= 3
            and all(r in {'aipm', 'librarian', 'maintainer'} and r != role for r in delegates), 'Invalid agent handoff')
    require('findings' not in plan or role == 'maintainer', '只有仓库维护者可以保存诊断')
    require(isinstance(plan.get('search_query', ''), str) and len(plan.get('search_query', '')) <= 500, 'Invalid knowledge query')
    if role == 'maintainer':
        require(not delegates, '仓库巡检不能派发业务写入')


def business_plan(plan):
    """The exact task proposal decided by Lumos, excluding presentation and evidence."""
    result = {k: copy.deepcopy(plan.get(k, [])) for k in ('questions', 'resolutions', 'question_options')}
    result['updates'] = [copy.deepcopy(u) for u in plan.get('updates', []) if u.get('kind') != 'evidence']
    if 'task_reviews' in plan:
        result['task_reviews'] = copy.deepcopy(plan['task_reviews'])
    return result


def needs_decision(plan, job):
    return any(business_plan(plan).values()) or bool(job.get('task_review') or job.get('review'))


def missing_followups(plan, records):
    """Check only this decision's open tasks; keep explicit user date clears intact."""
    nodes = records if isinstance(records, dict) else {n['id']: n for n in records}
    missing = []
    for item in plan.get('updates', []):
        if item.get('kind') != 'action':
            continue
        previous = nodes.get(item['id'], {}).get('data', {})
        data = {**previous, **item['changes']}
        # Reopening clears the old date in prepare_task; it needs a fresh arrangement.
        if previous.get('status') in {'done', 'cancelled'} and data.get('status') not in {'done', 'cancelled'} and 'follow_up' not in item['changes']:
            data.update(follow_up='', review_basis='agent')
        if data.get('status', 'todo') not in {'done', 'cancelled'} and not data.get('follow_up') and data.get('review_basis') != 'user':
            missing.append({'id': item['id'], 'title': data.get('text', item['id']),
                            'current_due': data.get('planned_due') or data.get('due', ''), 'owner': data.get('owner', '')})
    return missing


def execution_hashes():
    return {'rules_hash': digest(b''.join((ENGINE/f).read_bytes() for f in
            ('docs/agent-roles.md', 'docs/agent-planner.md', 'docs/chat-planner.md', 'docs/task-review-planner.md', 'docs/note-format-planner.md'))),
            'code_hash': digest(b''.join((ENGINE/f).read_bytes() for f in ('lumos_agents.py', 'lumos_worker.py', 'lumos_intake.py', 'lumos_followup.py', 'lumos_knowledge.py', 'lumos_ops.py')))}


def record_step(store, ident, claim, role, phase, basis='', *, attempt=None, plan=None, error=None, input_hash='', reused_from=''):
    """Record attempts independently; only the final apply makes proposals authoritative."""
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            nodes = store.nodes(db)
        old = nodes[ident]
        require(old['data']['status'] == 'running' and old['data'].get('claim') == claim, '整理已换批次')
        data = copy.deepcopy(old['data'])
        steps = data.setdefault('agent_steps', [])
        if attempt is None:
            attempt = uuid.uuid4().hex
            steps.append({'id': role+':'+phase, 'attempt_id': attempt, 'claim': claim,
                'attempt': 1+sum(s['id'] == role+':'+phase for s in steps), 'role': role, 'phase': phase,
                'status': 'running', 'started_at': now(), 'basis': basis, 'model': 'none' if phase in {'inspect', 'apply'} else data.get('model') or 'executor-default',
                'input_hash': input_hash, 'reused_from': reused_from, **execution_hashes()})
        else:
            step = next((s for s in steps if s['attempt_id'] == attempt), None)
            require(step and step['claim'] == claim and step['status'] == 'running', 'Invalid execution attempt')
            step.update(status='failed' if error else 'proposed', finished_at=now())
            if error:
                step['error'] = str(error)[:2000]
            else:
                from lumos_intake import fingerprint
                step.update(result_hash=fingerprint(plan), summary=plan['summary'][:4000],
                            targets=[i['id'] for i in plan.get('updates', [])], proposal=copy.deepcopy(plan))
                if role == 'lumos' and phase == 'decide':
                    step['decision_hash'] = fingerprint(business_plan(plan))
        data.update(revision=data['revision']+1, updated_at=now(),
                    lease_until=(datetime.now(timezone.utc)+timedelta(minutes=15)).isoformat())
        commit_tasks(store, nodes, {'reason': 'agent step '+role+':'+phase, 'updates': [{**old, 'data': data}]}, ident)
        return attempt


def reusable_step(store, ident, role, phase, input_hash):
    from lumos_intake import fingerprint
    with store.db() as db:
        job = store.nodes(db)[ident]['data']
    hashes = execution_hashes()
    return next((s for s in reversed(job.get('agent_steps', [])) if s['role'] == role and s['phase'] == phase
                 and s['status'] == 'proposed' and s.get('input_hash') == input_hash
                 and all(s.get(k) == v for k, v in hashes.items()) and 'proposal' in s
                 and fingerprint(s['proposal']) == s.get('result_hash')), None)


def check_decision(job, plan, basis):
    from lumos_intake import fingerprint
    if not needs_decision(plan, job):
        return None
    # External Lumos remains an explicit coordinator; specialist endpoints cannot claim this authority.
    if not job.get('agent_steps'):
        require(job.get('agent_role', 'lumos') == 'lumos', '任务安排须先由 Lumos 决策；请交由协作执行器处理')
        return {'role': 'lumos', 'phase': 'external', 'decision_hash': fingerprint(business_plan(plan))}
    steps = [s for s in job['agent_steps'] if s['claim'] == job['claim'] and s['status'] == 'proposed' and s['basis'] == basis]
    decision = next((s for s in reversed(steps) if s['role'] == 'lumos' and s['phase'] == 'decide'
                     and s.get('decision_hash') == fingerprint(business_plan(plan))), None)
    require(decision, '缺少与本次任务安排及来源版本一致的 Lumos 决策，尚未保存')
    require(any(s['role'] == 'aipm' and s['phase'] == 'apply' and s.get('proposal') == decision.get('proposal') for s in steps),
            'AIPM 尚未按 Lumos 决定落实本次安排')
    return decision


def report_receipt(job, plan, basis):
    """A shared inbox entry is a receipt, never a fabricated extra model conversation."""
    decision = check_decision(job, plan, basis)
    if decision is None:
        decision = next((s for s in reversed(job.get('agent_steps', [])) if s['claim'] == job.get('claim')
                         and s['status'] == 'proposed' and s['role'] == 'lumos' and s['phase'] == 'decide' and s['basis'] == basis), None)
    if role_for(job) == 'maintainer':
        return {}
    if role_for(job) == 'lumos' and decision is None:
        return {}
    return {'lumos_report': {'from_role': role_for(job), 'to_role': 'lumos', 'status': 'received', 'at': now(),
            'summary': plan['summary'], 'basis': basis,
            'decision': ({k: decision[k] for k in ('role', 'phase', 'attempt_id', 'decision_hash') if k in decision} if decision else None)}}


def role_reports(nodes, workspace, role):
    reports = []
    for n in nodes.values():
        d = n['data']
        if n['kind'] != 'intake' or d['workspace'] != workspace:
            continue
        report = d.get('ops_report' if role == 'maintainer' else 'lumos_report')
        if role == 'lumos' and report and report['from_role'] == 'lumos' and not report.get('decision'):
            continue
        if report:
            reports.append({'episode_id': n['id'], 'title': d['title'], 'chat_id': d.get('chat_id'),
                            'note': d.get('note'), 'agent_role': role_for(d), 'outcome': d['status'],
                            'result': d.get('reply', '')[:4000], 'result_truncated': len(d.get('reply', '')) > 4000,
                            'destinations': d.get('destinations', []), **report})
    if role == 'maintainer':
        known = {r['episode_id'] for r in reports}
        for finding in diagnostics(nodes, workspace):
            if finding['episode_id'] in known:
                continue
            d = nodes[finding['episode_id']]['data']
            reports.append({'episode_id': finding['episode_id'], 'title': d['title'], 'chat_id': d.get('chat_id'),
                'note': d.get('note'), 'agent_role': role_for(d), 'from_role': role_for(d), 'to_role': 'maintainer',
                'report_to': '王牧楠', 'outcome': d['status'], 'status': 'detected', 'at': finding['at'],
                'summary': d.get('error') or finding['title'], 'impact': finding['suggestion']})
    return sorted(reports, key=lambda r: r['at'], reverse=True)


def prepare_execution(store, ident, claim, plan):
    from lumos_intake import fingerprint
    with process_lock(store.root):
        store.writable(); store.idle()
        with store.db() as db:
            nodes = store.nodes(db)
        old = nodes[ident]
        require(old['data']['status'] == 'running' and old['data'].get('claim') == claim, '整理已换批次')
        node = {**old, 'data': {**old['data'], 'prepared_plan': fingerprint(plan),
                'prepared_claim': claim, 'revision': old['data']['revision']+1, 'updated_at': now()}}
        commit_tasks(store, nodes, {'reason': 'prepare agent result', 'updates': [node]}, ident)


def current_input(node, nodes):
    data = node['data']
    ref = data.get('note')
    if ref and ref['id'] in nodes:
        note = nodes[ref['id']]['data']
        if note['status'] != 'active' or note['revision'] != ref['revision']:
            return False
    if data.get('review'):
        from lumos_intake import review_matches
        return review_matches(nodes, data['review'])
    return True


def diagnostics(nodes, workspace, include_history=False):
    findings = []
    for n in nodes.values():
        d = n['data']
        if n['kind'] != 'intake' or d['workspace'] != workspace:
            continue
        if not include_history and (d['status'] == 'obsolete' or not current_input(n, nodes)):
            continue
        if d['status'] == 'failed':
            code, title = 'failed', '执行失败，原输入已保留'
        elif d['status'] == 'running' and d.get('lease_until', '') < now():
            code, title = 'expired', '执行租约已到期，需要接续'
        elif d['status'] == 'obsolete':
            code, title = 'obsolete', '来源已变化，旧结果未应用'
        else:
            continue
        findings.append({'key': n['id']+':'+code, 'episode_id': n['id'], 'code': code, 'title': title, 'subject': d['title'],
                         'at': d.get('updated_at', ''), 'suggestion': '查看步骤和原输入；核对后重试或重新整理。'})
    return sorted(findings, key=lambda f: f['at'], reverse=True)


def episodes(store, workspace='lingguang'):
    from lumos_ops import issue_groups, inspection_schedule
    require(workspace in {'lingguang', 'lumos'}, 'Invalid workspace')
    with process_lock(store.root), store.db() as db:
        nodes = store.nodes(db)
        rows = [{'id': n['id'], **{k: n['data'][k] for k in ('title', 'status', 'created_at', 'updated_at',
                 'agent_role', 'summary', 'error', 'destinations', 'episode_ref', 'findings', 'chat_id', 'note', 'lumos_report', 'ops_report') if k in n['data']},
                 'agent_steps': [{k: v for k, v in s.items() if k != 'proposal'} for s in n['data'].get('agent_steps', [])],
                 'recorded': bool(n['data'].get('agent_steps'))} for n in nodes.values()
                if n['kind'] == 'intake' and n['data']['workspace'] == workspace]
        findings = diagnostics(nodes, workspace)
        active = [n for n in nodes.values() if n['kind'] == 'intake' and n['data']['workspace'] == workspace and current_input(n, nodes)]
        return {'roles': ROLES, 'episodes': sorted(rows, key=lambda n: n['created_at'], reverse=True),
                'issues': issue_groups(nodes, workspace), 'inspection': inspection_schedule(nodes, workspace),
                'lumos_reports': role_reports(nodes, workspace, 'lumos'), 'ops_reports': role_reports(nodes, workspace, 'maintainer'),
                'findings': findings, 'history_count': len(diagnostics(nodes, workspace, True))-len(findings),
                'pending': sum(n['data']['status'] == 'pending' for n in active),
                'running': sum(n['data']['status'] == 'running' and n['data'].get('lease_until', '') >= now() for n in active)}


def inspect_once(store, request):
    from lumos_intake import save_intake, claim_intake, intake_context, apply_intake, fail_intake
    require(isinstance(request, dict) and set(request) <= {'request_id', 'workspace', 'source'}, 'Invalid patrol request')
    result = save_intake(store, {**request, 'agent_role': 'maintainer', 'execution': 'conversation',
        'title': '仓库维护者 · 只读巡检', 'text': '检查当前空间的执行失败、租约过期和失效结果；只保存诊断，不修改代码或业务。'})
    job = result['intake']
    if result['replayed']:
        with store.db() as db:
            job = store.nodes(db)[job['id']]
        if job['data']['status'] == 'done' or (job['data']['status'] == 'running' and job['data'].get('lease_until', '') >= now()):
            return {'intake': job, 'replayed': True}
    claimed = claim_intake(store, job['id'])
    require(claimed, '巡检未能领取，请刷新后重试')
    claim = claimed['data']['claim']
    try:
        context = intake_context(store, job['id'])
        attempt = record_step(store, job['id'], claim, 'maintainer', 'inspect', context['basis'])
        plan = {'summary': '只读巡检完成：发现 '+str(len(context['diagnostics']))+' 项需查看的运行记录。未修改代码或业务。',
                'updates': [], 'questions': [], 'resolutions': [], 'findings': context['diagnostics']}
        record_step(store, job['id'], claim, 'maintainer', 'inspect', attempt=attempt, plan=plan)
        prepare_execution(store, job['id'], claim, plan)
        return apply_intake(store, {'id': job['id'], 'claim': claim, 'basis': context['basis'], 'plan': plan})
    except Exception as exc:
        fail_intake(store, job['id'], claim, str(exc))
        raise
