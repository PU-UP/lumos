"""Deterministic checks and weekly scheduling; no business or repository changes."""
import hashlib
from datetime import datetime, timedelta

from lumos import Error, digest, now, safe_path
from lumos_tasks import context_workspace

INSPECTION_TEXT = '检查当前空间的执行失败、租约过期和失效结果；只保存诊断，不修改代码或业务。'


def inspection_job(node):
    d = node['data']
    return node['kind'] == 'intake' and d.get('agent_role') == 'maintainer' and d.get('text') == INSPECTION_TEXT


def inspection_findings(store, nodes, workspace):
    from lumos_agents import diagnostics
    findings = diagnostics(nodes, workspace)
    for n in nodes.values():
        d = n['data']; context = nodes.get(d.get('context'), {})
        if context.get('kind') != 'context' or context_workspace(context) != workspace:
            continue
        if context['data'].get('status', 'active') not in {'active', 'waiting'}:
            continue
        version = d if n['kind'] == 'document' else d.get('material') if n['kind'] == 'evidence' else None
        if not version:
            continue
        try:
            path = safe_path(store.root, version['version'])
            with path.open('rb') as stream:
                valid = hashlib.file_digest(stream, 'sha256').hexdigest() == version['sha256']
        except (OSError, Error):
            valid = False
        if not valid:
            findings.append({'key': n['id']+':source', 'subject_id': n['id'], 'code': 'source',
                'title': '固定来源缺失或内容不匹配', 'subject': d.get('title') or d.get('path') or n['id'],
                'version': version['version'], 'sha256': version['sha256'],
                'suggestion': '暂停依赖此来源的结论；在维护环境核对原件与匹配备份，不自动替换固定版本。'})
    return findings


def failure_code(error):
    text = error.casefold()
    for code, words in [('permission', ('permission', '权限', 'denied')), ('executor', ('执行器', '模型', 'codex', 'timeout')),
                        ('conflict', ('已变化', '版本', '冲突', 'basis', '重新领取')), ('validation', ('invalid', '须', '必须', '决策', '不能'))]:
        if any(word in text for word in words):
            return code
    return 'failure-'+digest(text.encode())[:12]


def issue_groups(nodes, workspace):
    from lumos_agents import role_reports, current_input
    groups = {}
    for report in role_reports(nodes, workspace, 'maintainer'):
        if not current_input(nodes[report['episode_id']], nodes):
            continue
        note = report.get('note')
        subject = note['id']+':'+str(note['revision']) if note else report['episode_id']
        code = report.get('code') or failure_code(report['summary'])
        key = subject+':'+code
        old = groups.get(key)
        count = sum(e['code'] == code for e in report.get('occurrences', [])) or report.get('count', 1)
        if old:
            old['count'] += count; old['episode_ids'].append(report['episode_id'])
        else:
            groups[key] = {**report, 'key': key, 'count': count, 'episode_ids': [report['episode_id']]}
    inspections = sorted((n for n in nodes.values() if inspection_job(n) and n['data']['workspace'] == workspace
                          and n['data']['status'] == 'done'), key=lambda n: n['data']['updated_at'])
    for n in inspections:
        for finding in n['data'].get('findings', []):
            if 'subject_id' not in finding:
                continue
            prior = groups.get(finding['key'], {})
            groups[finding['key']] = {**finding, 'episode_id': n['id'], 'episode_ids': [n['id']], 'title': finding['subject'],
                'agent_role': 'maintainer', 'at': n['data']['updated_at'], 'summary': finding['title'], 'impact': finding['suggestion'],
                'count': prior.get('count', 0)+1, 'status': 'detected'}
    if inspections:
        current = {f['key'] for f in inspections[-1]['data'].get('findings', [])}
        for g in groups.values():
            if g.get('subject_id') and g['key'] not in current:
                g['status'] = 'rechecked'; g['impact'] = '最近一次检查未再发现此来源异常；未据此确认其他业务结果。'
    recent = sorted(groups.values(), key=lambda g: g['at'], reverse=True)
    return sorted(recent, key=lambda g: g['status'] in {'recovered', 'rechecked'})


def inspection_schedule(nodes, workspace):
    from lumos_intake import POLICY, enabled
    allowed = enabled(nodes, workspace) and workspace in nodes.get(POLICY, {}).get('data', {}).get('ops_inspection_workspaces', [])
    jobs = sorted((n for n in nodes.values() if inspection_job(n) and n['data']['workspace'] == workspace),
                  key=lambda n: n['data']['updated_at'], reverse=True)
    last = next((n for n in jobs if n['data']['status'] in {'done', 'failed'}), None)
    due = (datetime.fromisoformat(last['data']['updated_at'])+timedelta(days=7)).isoformat() if last else ''
    active = next((n for n in jobs if n['data']['status'] in {'pending', 'running'}), None)
    return {'enabled': allowed, 'last_at': last['data']['updated_at'] if last else '', 'last_status': last['data']['status'] if last else '',
            'next_at': due, 'due': allowed and (not due or due <= now()), 'active_id': active['id'] if active else ''}


def inspect_due(store):
    from lumos_agents import inspect_once
    with store.db() as db:
        nodes = store.nodes(db)
    if any(n['kind'] == 'intake' and not inspection_job(n) and
           (n['data']['status'] == 'pending' and n['data'].get('execution') != 'conversation'
            or n['data']['status'] == 'running' and n['data'].get('lease_until', '') >= now()) for n in nodes.values()):
        return None
    for workspace in ('lingguang', 'lumos'):
        schedule = inspection_schedule(nodes, workspace)
        if not schedule['enabled']:
            continue
        active = nodes.get(schedule['active_id'])
        if active:
            d = active['data']
            if d.get('source', {}).get('inspection') != 'weekly' or (d['status'] == 'running' and d.get('lease_until', '') >= now()):
                continue
            request = {'request_id': active['id'].removeprefix('intake-'), 'workspace': workspace, 'source': d['source']}
        elif schedule['due']:
            request = {'request_id': digest(('ops-weekly:'+workspace+':'+now()[:10]).encode())[:32], 'workspace': workspace,
                       'source': {'type': 'agent', 'ref': '每周只读检查；离线后合并补查一次', 'inspection': 'weekly'}}
        else:
            continue
        return inspect_once(store, request)
    return None

def maintenance_work(nodes, workspace, numbers):
    """Read-only maintenance queue in the unified workspace; never a second task store."""
    from lumos_intake import scoped_nodes
    from lumos_tasks import work_role
    from lumos_followup import followup_questions
    tasks = [{**n, 'short_id': numbers.get(i, ''), 'work_role': 'maintainer'} for i, n in scoped_nodes(nodes, workspace).items()
             if n['kind'] == 'action' and work_role(n) == 'maintainer' and n['data']['status'] not in {'done', 'cancelled'}]
    ids = {n['id'] for n in tasks}
    questions = [q for q in followup_questions(nodes, workspace, numbers)
                 if q['work_role'] == 'maintainer' and ids.intersection(q['task_ids'])]
    for task in tasks:
        chat = next((n for n in nodes.values() if n['kind'] == 'conversation' and n['data']['workspace'] == workspace
                     and n['data']['agent_role'] == 'maintainer' and n['data']['status'] == 'active'
                     and not n['data'].get('deleted') and not n['data'].get('merged_into')
                     and task['id'] in n['data'].get('source_ids', [])), None)
        if chat: task['chat_id'] = chat['data']['chat_id']
    return {'tasks': tasks, 'questions': questions}
