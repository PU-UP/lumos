"""Role boundaries and durable execution receipts; business writes stay in intake-apply."""
import copy
import uuid
from datetime import datetime, timedelta, timezone

from lumos import ENGINE, digest, now, process_lock, require
from lumos_tasks import commit_tasks

ROLES = {
    'lumos': {'name': 'Lumos', 'purpose': '理解意图、协调专业角色、综合答复'},
    'aipm': {'name': 'AIPM', 'purpose': '任务、主线、内部排期与关键问题'},
    'librarian': {'name': '资料管理员', 'purpose': '笔记整理、知识依据与资料检索'},
    'maintainer': {'name': '仓库维护者', 'purpose': '只读巡检、运行诊断与改进建议'},
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


def record_step(store, ident, claim, role, phase, basis='', *, attempt=None, plan=None, error=None):
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
                'status': 'running', 'started_at': now(), 'basis': basis, 'model': 'none' if phase == 'inspect' else data.get('model') or 'executor-default',
                'rules_hash': digest((ENGINE/'docs/agent-roles.md').read_bytes()),
                'code_hash': digest(b''.join((ENGINE/f).read_bytes() for f in ('lumos_agents.py', 'lumos_worker.py', 'lumos_intake.py')))})
        else:
            step = next((s for s in steps if s['attempt_id'] == attempt), None)
            require(step and step['claim'] == claim and step['status'] == 'running', 'Invalid execution attempt')
            step.update(status='failed' if error else 'proposed', finished_at=now())
            if error:
                step['error'] = str(error)[:2000]
            else:
                from lumos_intake import fingerprint
                step.update(result_hash=fingerprint(plan), summary=plan['summary'][:4000],
                            targets=[i['id'] for i in plan.get('updates', [])])
        data.update(revision=data['revision']+1, updated_at=now(),
                    lease_until=(datetime.now(timezone.utc)+timedelta(minutes=15)).isoformat())
        commit_tasks(store, nodes, {'reason': 'agent step '+role+':'+phase, 'updates': [{**old, 'data': data}]}, ident)
        return attempt


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


def diagnostics(nodes, workspace):
    findings = []
    for n in nodes.values():
        d = n['data']
        if n['kind'] != 'intake' or d['workspace'] != workspace:
            continue
        if d['status'] == 'failed':
            code, title = 'failed', '执行失败，原输入已保留'
        elif d['status'] == 'running' and d.get('lease_until', '') < now():
            code, title = 'expired', '执行租约已到期，需要接续'
        elif d['status'] == 'obsolete':
            code, title = 'obsolete', '来源已变化，旧结果未应用'
        else:
            continue
        findings.append({'key': n['id']+':'+code, 'episode_id': n['id'], 'code': code, 'title': title,
                         'at': d.get('updated_at', ''), 'suggestion': '查看步骤和原输入；核对后重试或重新整理。'})
    return sorted(findings, key=lambda f: f['at'], reverse=True)


def episodes(store, workspace='lingguang'):
    require(workspace in {'lingguang', 'lumos'}, 'Invalid workspace')
    with process_lock(store.root), store.db() as db:
        nodes = store.nodes(db)
        rows = [{'id': n['id'], **{k: n['data'][k] for k in ('title', 'status', 'created_at', 'updated_at',
                 'agent_role', 'agent_steps', 'summary', 'error', 'destinations', 'episode_ref', 'findings', 'chat_id', 'note') if k in n['data']},
                 'recorded': bool(n['data'].get('agent_steps'))} for n in nodes.values()
                if n['kind'] == 'intake' and n['data']['workspace'] == workspace]
        return {'roles': ROLES, 'episodes': sorted(rows, key=lambda n: n['created_at'], reverse=True),
                'findings': diagnostics(nodes, workspace)}


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
