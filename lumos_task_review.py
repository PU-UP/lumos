"""Task stewardship: exact review coverage, manual edits and unresolved questions."""
from lumos import now, require
from lumos_tasks import FIELDS, current_due, work_role

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
    due, follow = current_due(data), data.get('follow_up', '')
    if not data.get('owner') or data['owner'] == '待分配':
        issues.append('负责人待落实')
    if not follow:
        issues.append('跟进时间未安排')
    elif follow <= today:
        issues.append('跟进结果待核对')
    if due and due != 'long_term':
        if due < today:
            issues.append('当前交付计划已过，需重新安排或确认关键结果')
        if follow and follow > due:
            issues.append('跟进晚于交付')
    if not due:
        issues.append('交付计划待安排')
    if data['status'] == 'blocked':
        issues.append('阻塞待处理')
    return issues


def complete_task_review(nodes, updates, job, reviews, questions, open_questions, today):
    from lumos_intake import scoped_nodes
    scope = {i: n for i, n in scoped_nodes(nodes, job['data']['workspace']).items()
             if n['kind'] == 'action' and n['data']['status'] not in {'done', 'cancelled'} and work_role(n) == 'lumos'}
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
    require(isinstance(request, dict) and set(request) <= {'request_id', 'workspace', 'source', 'model', 'reasoning_effort'}, 'Invalid review request')
    return save_intake(store, {**request, 'task_review': True, 'title': 'Lumos 全部任务复核',
        'text': '从主线阶段成果拆解当前空间全部未结束任务的合理排期，核对前置依赖、执行顺序、负责人协作和下游节点影响。接续王牧楠的手动修改，主动维护排期、跟进、负责人和下一步；没有新结果不得编造进展。可自行处理的异常直接协调交付和跟进计划，不能只为消除颜色而顺延；仍需确认的异常在主页关联具体主线问题。逐项返回复核结果。'})
