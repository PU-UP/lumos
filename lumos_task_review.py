"""Task stewardship: exact review coverage, manual edits and unresolved questions."""
from lumos import now, require
from lumos_tasks import FIELDS

MANUAL_FIELDS = FIELDS - {'owner_basis', 'owner_reason', 'review_basis', 'review_reason', 'planning_reason'}


def mark_manual_edits(previous, data, changes, source):
    edits = dict(previous.get('manual_edits', {}))
    for field in MANUAL_FIELDS & changes.keys():
        if data.get(field, '') != previous.get(field, ''):
            edits[field] = {'value': data.get(field, ''), 'at': now(), 'source': source}
    if edits:
        data['manual_edits'] = edits


def acknowledge_edits(data):
    if data.get('manual_edits'):
        data['manual_edits'] = {k: {**v, 'seen_at': v.get('seen_at') or now()}
                                for k, v in data['manual_edits'].items()}


def task_issues(data, today):
    if data['status'] in {'done', 'cancelled'}:
        return []
    issues = []
    due, follow, target = data.get('due', ''), data.get('follow_up', ''), data.get('planned_due', '')
    if not data.get('owner') or data['owner'] == '待分配':
        issues.append('负责人待落实')
    if not follow:
        issues.append('跟进时间未安排')
    elif follow <= today:
        issues.append('跟进结果待核对')
    if due and due != 'long_term':
        if due < today:
            issues.append('原交付结果待核对')
        elif follow and follow > due:
            issues.append('跟进晚于交付')
    if not due and not target:
        issues.append('交付计划待安排')
    if target and target < today:
        issues.append('计划节点结果待核对')
    elif target and follow and follow > target:
        issues.append('跟进晚于计划节点')
    if data['status'] == 'blocked':
        issues.append('阻塞待处理')
    return issues


def complete_task_review(nodes, updates, job, reviews, questions, open_questions, today):
    from lumos_intake import scoped_nodes
    scope = {i: n for i, n in scoped_nodes(nodes, job['data']['workspace']).items()
             if n['kind'] == 'action' and n['data']['status'] not in {'done', 'cancelled'}}
    require(isinstance(reviews, list) and len(reviews) == len(scope), '全量复核必须逐项覆盖全部当前任务')
    changed = {n['id']: n for n in updates}
    available = {f"question:{q['intake_id']}:{q['index']}": {'intake_id': q['intake_id'], 'index': q['index']}
                 for q in open_questions}
    available.update({f'new:{index}': {'intake_id': job['id'], 'index': index} for index in range(len(questions))})
    seen = set()
    for review in reviews:
        require(isinstance(review, dict) and set(review) == {'id', 'question', 'reason'}, 'Invalid task review')
        ident = review['id']
        require(isinstance(ident, str) and ident in scope and ident not in seen, '任务复核范围错误或重复')
        seen.add(ident)
        require(isinstance(review['reason'], str) and 0 < len(review['reason']) <= 2000, '任务复核需要依据')
        require(isinstance(review['question'], str) and (not review['question'] or review['question'] in available), '待回答必须关联真实未答问题')
        target = changed.get(ident)
        if target is None:
            target = {**scope[ident], 'data': dict(scope[ident]['data'])}
            updates.append(target)
        issues = task_issues(target['data'], today)
        require(not issues or review['question'], '仍有未处理的任务异常，须自行安排或关联待答问题：'+ident+' / '+ '、'.join(issues))
        acknowledge_edits(target['data'])
        target['data']['task_review'] = {'at': now(), 'receipt': job['id'], 'reason': review['reason'],
                                       'issues': issues, 'question': available.get(review['question'])}
    return reviews


def request_task_review(store, request):
    from lumos_intake import save_intake
    require(isinstance(request, dict) and set(request) <= {'request_id', 'workspace', 'source'}, 'Invalid review request')
    return save_intake(store, {**request, 'task_review': True, 'title': 'Lumos 全部任务复核',
        'text': '全面复核当前空间全部未结束任务与关联主线。接续王牧楠的手动修改，主动维护排期、跟进、负责人和下一步；没有新结果不得编造进展。可自行处理的异常直接处理，仍需确认的异常关联真实待答问题。逐项返回复核结果。'})
