"""Connect waiting questions to exact tasks and bounded follow-up dates."""
import re
from datetime import datetime, timedelta, timezone

from lumos_tasks import current_due
from lumos import require


def validate_question_options(groups, questions, *, pinned=False):
    require(isinstance(groups, list) and len(groups) <= 5, '澄清选项最多对应五个问题')
    indices = set()
    for group in groups:
        require(isinstance(group, dict) and set(group) == {'index', 'options'}, 'Invalid question options')
        index, options = group['index'], group['options']
        require(type(index) is int and 0 <= index < len(questions) and index not in indices, '澄清选项必须关联确切问题')
        indices.add(index)
        require(isinstance(options, list) and 1 <= len(options) <= 5, '每个问题提供一至五个有依据的选项')
        texts = set()
        for option in options:
            require(isinstance(option, dict) and set(option) == ({'text', 'basis_ids', 'basis'} if pinned else {'text', 'basis_ids'}), 'Invalid question option')
            text, refs = option['text'], option['basis_ids']
            require(isinstance(text, str) and text.strip() and len(text) <= 160 and text not in texts, '选项须简短且不重复')
            texts.add(text)
            require(isinstance(refs, list) and 1 <= len(refs) <= 5 and all(isinstance(i, str) and i for i in refs)
                    and len(set(refs)) == len(refs), '选项必须有确切来源')
            if pinned:
                require(isinstance(option['basis'], dict) and set(option['basis']) == set(refs)
                        and all(isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for v in option['basis'].values()), 'Invalid option basis')


def pin_question_options(groups, questions, nodes, workspace):
    from lumos_intake import scoped_nodes, fingerprint
    validate_question_options(groups, questions)
    scope = scoped_nodes(nodes, workspace)
    result = []
    for group in groups:
        options = []
        for option in group['options']:
            require(all(i in scope and scope[i]['kind'] in {'context', 'mainline', 'action', 'person', 'evidence', 'document'}
                        and scope[i]['data'].get('status') not in {'archived', 'deleted', 'done', 'cancelled'} for i in option['basis_ids']),
                    '澄清选项来源不存在、已结束或不属于当前资料范围')
            options.append({**option, 'basis': {i: fingerprint(nodes[i]) for i in option['basis_ids']}})
        result.append({'index': group['index'], 'options': options})
    return result


def current_question_options(data, nodes):
    from lumos_intake import scoped_nodes, fingerprint
    if data['status'] != 'needs_review' or not data.get('question_options'):
        return []
    scope = scoped_nodes(nodes, data['workspace'])
    answered = {r['index'] for r in data.get('resolutions', [])}
    # A partial answer changes the question; do not reuse choices for its old wording.
    return [{'index': g['index'], 'options': [{'text': o['text'],
             'available': all(i in scope and fingerprint(nodes[i]) == value for i, value in o['basis'].items())}
             for o in g['options']]} for g in data.get('question_options', []) if g['index'] not in answered]


def followup_questions(nodes, workspace, numbers):
    from lumos_intake import open_questions, scoped_nodes
    tasks = {i: n for i, n in scoped_nodes(nodes, workspace).items() if n['kind'] == 'action'}
    result = open_questions(nodes, workspace)
    for q in result:
        mentioned = set(re.findall(r'T-\d+', q['question']))
        # Current wording can narrow an old question; stale review links must not widen it.
        refs = [i for i in tasks if numbers.get(i) in mentioned] if mentioned else [
            i for i, n in tasks.items() if i in q['related_ids'] or
            n['data'].get('task_review', {}).get('question') == {'intake_id': q['intake_id'], 'index': q['index']}]
        q['task_ids'] = refs
        if q['answer_state'] != 'waiting':
            continue
        active = [tasks[i]['data'] for i in refs if tasks[i]['data']['status'] not in {'done', 'cancelled'}]
        answered_on = datetime.fromisoformat(q['answers'][-1]['at']).astimezone(timezone(timedelta(hours=8))).date()
        answered = answered_on.isoformat()
        fallback = (answered_on + timedelta(days=7)).isoformat()
        dates = [q['review_on']] if q['review_on'] else [d['follow_up'] for d in active if d.get('follow_up', '') > answered]
        # An event cannot be observed automatically. Recheck within a week, or by the next delivery.
        if not q['review_on']:
            dates.append(fallback)
        dates.extend(current_due(d) for d in active if current_due(d) and current_due(d) != 'long_term' and current_due(d) > answered)
        q['follow_up_on'] = min(dates)
    return result


def synchronize_followups(nodes, numbers):
    from lumos_intake import management_enabled
    updates = []
    for workspace in ('lingguang', 'lumos'):
        if not management_enabled(nodes, workspace):
            continue
        schedules = {}
        for q in followup_questions(nodes, workspace, numbers):
            if q['answer_state'] == 'waiting':
                for ident in q['task_ids']:
                    schedules.setdefault(ident, []).append(q)
        for ident, questions in schedules.items():
            old = nodes[ident]
            if old['data']['status'] in {'done', 'cancelled'}:
                continue
            day = min(q['follow_up_on'] for q in questions)
            if old['data'].get('follow_up') == day:
                continue
            refs = ', '.join(f"{q['intake_id']}:{q['index']}" for q in questions)
            reason = '接续已有答复与等待问题；按问题核对日、当前交付及最长七天的消息核对间隔安排：'+refs
            updates.append({**old, 'data': {**old['data'], 'follow_up': day, 'follow_up_pending': False,
                'review_basis': 'agent', 'review_reason': reason}})
    return updates
