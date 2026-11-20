"""Connect waiting questions to exact tasks and bounded follow-up dates."""
import re
from datetime import datetime, timedelta, timezone

from lumos_tasks import current_due


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
