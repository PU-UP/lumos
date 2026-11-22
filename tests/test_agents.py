import copy
import uuid
from unittest.mock import patch

import lumos
from lumos_agents import episodes, inspect_once, record_step
from lumos_intake import POLICY, save_intake, claim_intake, intake_context, apply_intake, fail_intake
from lumos_tasks import save_task, task_detail
from lumos_worker import run_once
from test_core import BaseStoreCase


class AgentsTest(BaseStoreCase):
    def test_ops_continuation_keeps_own_exact_history_without_business_records(self):
        first = self.create('maintainer')
        run_once(self.store, lambda *_: self.plan(reply='确切错误标记：91827'))
        second = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'agent_role': 'maintainer',
            'text': '刚才的具体错误是什么？', 'source': self.source,
            'chat_id': first['data']['chat_id'], 'chat_parent': first['id']})['intake']
        def planner(context, root):
            self.assertEqual(context['chat_history'][0]['reply'], '确切错误标记：91827')
            self.assertEqual(context['chat_history'][0]['id'], first['id'])
            for field in ('records', 'open_questions', 'lumos_reports', 'proposals'):
                self.assertNotIn(field, context)
            return self.plan()
        result = run_once(self.store, planner)['intake']
        self.assertEqual((result['id'], result['data']['status']), (second['id'], 'done'))

    def test_handoff_models_are_role_specific_pinned_for_retry_and_recorded(self):
        from lumos_models import save_role_models
        save_role_models(self.store, {'models': {'aipm': 'project-model', 'lumos': 'coordinator-model'},
                                     'expected': {'aipm': None, 'lumos': None}})
        job = self.create('aipm'); calls = []
        def planner(context, root):
            role = context['agent']['role']; calls.append((role, context['intake']['data']['model']))
            if role == 'lumos' and len(calls) == 2:
                raise lumos.Error('isolated first decision failure')
            return self.plan(updates=[self.update()])
        failed = run_once(self.store, planner)
        self.assertEqual(failed['status'], 'failed')
        save_role_models(self.store, {'models': {'lumos': 'new-coordinator'}, 'expected': {'lumos': 'coordinator-model'}})
        with self.store.db() as db:
            revision = self.store.nodes(db)[job['id']]['data']['revision']
        save_intake(self.store, {'request_id': uuid.uuid4().hex, 'id': job['id'], 'expected_revision': revision})
        done = run_once(self.store, planner)['intake']['data']
        self.assertEqual(done['status'], 'done')
        self.assertEqual(calls, [('aipm', 'project-model'), ('lumos', 'coordinator-model'), ('lumos', 'coordinator-model')])
        self.assertEqual({s['model'] for s in done['agent_steps'] if s['role'] == 'lumos'}, {'coordinator-model'})
        self.assertEqual(done['role_models']['lumos'], 'coordinator-model')

    def test_atlas_references_existing_source_without_business_decision_or_duplicate_record(self):
        job = self.create('lumos')
        before = task_detail(self.store, 'talk')['task']
        def planner(context, root):
            if context['agent']['phase'] == 'coordinate':
                return self.plan(delegate_to=['librarian'])
            if context['agent']['role'] == 'librarian':
                return self.plan(source_refs=[{'id': 'talk', 'excerpt': '同步条件已核对'}])
            return self.plan()
        result = run_once(self.store, planner)['intake']['data']
        self.assertEqual(result['status'], 'done')
        self.assertEqual(result['source_refs'][0]['id'], 'talk')
        self.assertEqual(result['destinations'], [])
        self.assertNotIn('decide', [s['phase'] for s in result['agent_steps']])
        self.assertEqual(task_detail(self.store, 'talk')['task'], before)
        from lumos_agents import check_plan
        for role in ('aipm', 'maintainer'):
            with self.assertRaises(lumos.Error):
                check_plan(role, self.plan(source_refs=[{'id': 'talk', 'excerpt': '同步条件已核对'}]))

    def test_diagnostics_separate_replaced_inputs_from_unresolved_current_failures(self):
        from lumos_agents import diagnostics
        def job(ident, status='failed', **extra):
            return {'id': ident, 'kind': 'intake', 'data': {'workspace': 'lingguang', 'status': status,
                    'title': ident, 'updated_at': '2026-11-20T00:00:00+00:00', **extra}}
        nodes = {'note': {'id': 'note', 'kind': 'note', 'data': {'status': 'active', 'revision': 3}},
                 'old': job('old', note={'id': 'note', 'revision': 1}),
                 'current': job('current', note={'id': 'note', 'revision': 3}),
                 'unrelated': job('unrelated'), 'obsolete': job('obsolete', 'obsolete'),
                 'expired': job('expired', 'running', lease_until='2000-01-01T00:00:00+00:00')}
        original = copy.deepcopy(nodes)
        self.assertEqual({f['episode_id'] for f in diagnostics(nodes, 'lingguang')}, {'current','unrelated','expired'})
        self.assertEqual(len(diagnostics(nodes, 'lingguang', True)), 5)
        self.assertEqual(nodes, original)
        nodes['note']['data']['status'] = 'archived'
        self.assertNotIn('current', {f['episode_id'] for f in diagnostics(nodes, 'lingguang')})

    def setUp(self):
        super().setUp(); self.seed()
        self.source = {'type': 'user', 'ref': 'ISOLATED ROLE TEST'}
        batch = self.store.begin({'reason': 'synthetic authorization', 'updates': [{'id': POLICY, 'kind': 'decision',
            'data': {'context': 'mapping', 'text': '授权', 'reason': '测试', 'scope': '测试',
                     'autonomy_workspaces': ['lingguang'], 'source': self.source}}]}, True)
        self.store.commit(batch['batch'], True)

    def create(self, role='lumos', chat=True):
        request = {'request_id': uuid.uuid4().hex, 'agent_role': role, 'text': '同步条件已核对，继续检查。', 'source': self.source}
        if chat:
            request['chat_id'] = uuid.uuid4().hex
        return save_intake(self.store, request)['intake']

    def plan(self, **extra):
        return {'summary': '已检查', 'reply': '已收到', 'updates': [], 'questions': [], 'resolutions': [], **extra}

    def update(self, kind='action'):
        return {'id': 'talk' if kind == 'action' else 'knowledge-test', 'kind': kind,
            'changes': {'progress': '同步条件已核对', 'follow_up': '2026-11-22', 'review_basis': 'agent'} if kind == 'action' else {'context': 'mapping', 'title': '同步依据', 'text': '同步条件已核对'},
            'reason': '原话报告', 'excerpt': '同步条件已核对', 'mode': 'reported'}

    def test_chat_role_survives_restart_model_change_and_request_replay(self):
        for role in ('lumos', 'aipm', 'librarian', 'maintainer'):
            first = self.create(role)
            run_once(self.store, lambda *_: self.plan())
            request = {'request_id': uuid.uuid4().hex, 'chat_id': first['data']['chat_id'],
                'chat_parent': first['id'], 'text': '继续讨论', 'source': self.source,
                'model': 'test-other-model'}
            store = lumos.Store(self.root)
            saved = save_intake(store, request)['intake']
            self.assertEqual(saved['data']['agent_role'], role)
            self.assertEqual(saved['data']['model'], 'test-other-model')
            self.assertNotIn('agent_role', request)
            self.assertTrue(save_intake(store, request)['replayed'])
            claim_intake(store, saved['id'])
            self.assertEqual(intake_context(store, saved['id'])['agent']['role'], role)
            fail_intake(store, saved['id'], intake_context(store, saved['id'])['intake']['data']['claim'], '模拟失败')

    def test_chat_rejects_role_and_workspace_changes_without_saving(self):
        first = self.create('aipm')
        run_once(self.store, lambda *_: self.plan())
        request = {'request_id': uuid.uuid4().hex, 'chat_id': first['data']['chat_id'],
            'chat_parent': first['id'], 'text': '继续讨论', 'source': self.source}
        before = self.store.status()['seq']
        for changes, message in [({'agent_role': 'lumos'}, '角色已固定'),
                                 ({'agent_role': 'maintainer'}, '角色已固定'),
                                 ({'workspace': 'lumos'}, '不属于当前空间')]:
            with self.assertRaisesRegex(lumos.Error, message):
                save_intake(self.store, {**request, **changes})
            self.assertEqual(self.store.status()['seq'], before)
        saved = save_intake(self.store, {**request, 'agent_role': 'aipm'})['intake']
        self.assertEqual(saved['data']['agent_role'], 'aipm')

    def test_legacy_mixed_role_chat_is_preserved_but_cannot_continue(self):
        with self.store.db(True) as db:
            db.execute('PRAGMA user_version=1')
        first = self.create('aipm')
        run_once(self.store, lambda *_: self.plan())
        second = self.create('librarian')
        run_once(self.store, lambda *_: self.plan())
        with self.store.db() as db:
            legacy = copy.deepcopy(self.store.nodes(db)[second['id']])
        legacy['data'].update(chat_id=first['data']['chat_id'], chat_parent=first['id'])
        batch = self.store.begin({'reason': 'synthetic pre-refactor mixed chat', 'updates': [legacy]}, True)
        self.store.commit(batch['batch'], True)
        before = self.store.status()['seq']
        with self.assertRaisesRegex(lumos.Error, '历史对话包含多个角色'):
            save_intake(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': first['data']['chat_id'],
                'chat_parent': second['id'], 'agent_role': 'librarian', 'text': '继续', 'source': self.source})
        self.assertEqual(self.store.status()['seq'], before)
        with self.store.db() as db:
            self.assertEqual(self.store.nodes(db)[second['id']], legacy)

    def test_pure_chat_has_one_step_and_no_business_changes(self):
        self.create()
        before = task_detail(self.store, 'talk')['task']
        calls = []
        def planner(context, root):
            calls.append(context['agent']['role'])
            return self.plan()
        result = run_once(self.store, planner)['intake']
        self.assertEqual(calls, ['lumos'])
        self.assertEqual(result['data']['status'], 'done')
        self.assertEqual(task_detail(self.store, 'talk')['task'], before)
        self.assertEqual(len(episodes(self.store)['episodes'][0]['agent_steps']), 1)
        self.assertEqual(episodes(self.store)['lumos_reports'], [])

    def test_read_only_roles_do_not_schedule_or_reconcile_tasks_as_a_side_effect(self):
        for role in ('lumos', 'librarian', 'maintainer'):
            self.create(role)
            with patch('lumos_worker.enqueue_due_reviews') as scheduled, patch('lumos_followup.synchronize_followups') as synchronized:
                result = run_once(self.store, lambda *_: self.plan())
                self.assertEqual(result['intake']['data']['status'], 'done')
                scheduled.assert_not_called(); synchronized.assert_not_called()

    def test_coordinator_draft_is_rechecked_by_specialists_and_saved_atomically(self):
        job = self.create()
        calls = []
        def planner(context, root):
            role, phase = context['agent']['role'], context['agent']['phase']
            calls.append((role, phase))
            if phase == 'coordinate':
                return self.plan(updates=[self.update(), self.update('evidence')])
            if role == 'librarian':
                return self.plan(updates=[self.update('evidence')])
            if role == 'aipm':
                update = self.update(); update['changes']['progress'] = '已核对；继续检查'
                return self.plan(updates=[update])
            return self.plan(updates=context['proposals']['specialists']['aipm']['updates'], reply='已接续任务与知识依据')
        outcome = run_once(self.store, planner)
        self.assertIn('intake', outcome, outcome)
        result = outcome['intake']
        self.assertEqual(calls, [('lumos', 'coordinate'), ('librarian', 'work'), ('aipm', 'work'), ('lumos', 'decide')])
        self.assertEqual(result['data']['reply'], '已接续任务与知识依据')
        self.assertEqual(task_detail(self.store, 'talk')['task']['data']['progress'], '已核对；继续检查')
        with self.store.db() as db:
            batches = db.execute('SELECT batch FROM history WHERE node IN (?,?) ORDER BY rowid DESC LIMIT 2', ('talk', 'knowledge-test')).fetchall()
            self.assertEqual(batches[0], batches[1])
        self.assertEqual(result['id'], job['id'])

    def test_direct_aipm_arrangement_is_decided_by_lumos_and_reported(self):
        self.create('aipm')
        calls = []
        def planner(context, root):
            calls.append((context['agent']['role'], context['agent']['phase']))
            update = self.update()
            update['changes']['progress'] = 'AIPM 候选' if context['agent']['role'] == 'aipm' else 'Lumos 最终决定'
            return self.plan(updates=[update])
        result = run_once(self.store, planner)['intake']
        self.assertEqual(calls, [('aipm', 'work'), ('lumos', 'decide')])
        self.assertEqual(task_detail(self.store, 'talk')['task']['data']['progress'], 'Lumos 最终决定')
        self.assertEqual(result['data']['lumos_report']['decision']['phase'], 'decide')
        report = episodes(lumos.Store(self.root))['lumos_reports'][0]
        self.assertEqual(report['episode_id'], result['id'])
        self.assertEqual(report['from_role'], 'aipm')
        self.assertEqual(report['status'], 'received')

    def test_lumos_repairs_missing_followup_before_saving_without_asking_user_for_a_date(self):
        self.create('aipm'); calls = []
        def planner(context, root):
            calls.append((context['agent']['role'], bool(context.get('proposals', {}).get('required_followups'))))
            item = self.update()
            if not context.get('proposals', {}).get('required_followups'):
                item['changes'].pop('follow_up'); item['changes'].pop('review_basis')
            return self.plan(updates=[item])
        result = run_once(self.store, planner)['intake']
        self.assertEqual(calls, [('aipm', False), ('lumos', False), ('lumos', True)])
        self.assertEqual(task_detail(self.store, 'talk')['task']['data']['follow_up'], '2026-11-22')
        self.assertEqual(result['data']['questions'], [])

    def test_incomplete_followup_is_rejected_after_one_repair_and_at_the_save_boundary(self):
        from lumos_agents import prepare_execution
        job = self.create('aipm'); calls = []
        item = self.update(); item['changes'].pop('follow_up'); item['changes'].pop('review_basis')
        plan = self.plan(updates=[item]); before = task_detail(self.store, 'talk')['task']
        def planner(context, root):
            calls.append(context['agent']['role']); return copy.deepcopy(plan)
        outcome = run_once(self.store, planner)
        self.assertEqual(outcome['status'], 'failed'); self.assertEqual(calls, ['aipm', 'lumos', 'lumos'])
        self.assertEqual(task_detail(self.store, 'talk')['task'], before)
        second = self.create('aipm'); claimed = claim_intake(self.store, second['id']); ctx = intake_context(self.store, second['id'])
        claim = claimed['data']['claim']
        for role, phase in [('lumos', 'decide'), ('aipm', 'apply')]:
            attempt = record_step(self.store, second['id'], claim, role, phase, ctx['basis'])
            record_step(self.store, second['id'], claim, role, phase, attempt=attempt, plan=plan)
        prepare_execution(self.store, second['id'], claim, plan)
        with self.assertRaisesRegex(lumos.Error, '下次关心时间'):
            apply_intake(self.store, {'id': second['id'], 'claim': claim, 'basis': ctx['basis'], 'plan': plan})

    def test_followup_completeness_preserves_explicit_clear_closed_and_unaffected_tasks(self):
        from lumos_agents import missing_followups
        item = self.update(); item['changes'] = {'progress': '进展'}
        nodes = {'talk': {'data': {'status': 'todo', 'review_basis': 'user', 'follow_up': ''}}}
        self.assertEqual(missing_followups({'updates': [item]}, nodes), [])
        for changes in ({'status': 'done'}, {'status': 'cancelled'}, {'follow_up': '', 'review_basis': 'user'}):
            self.assertEqual(missing_followups({'updates': [{**item, 'changes': changes}]}, {}), [])
        self.assertEqual(missing_followups({'updates': []}, {'other': {'data': {'status': 'todo'}}}), [])
        self.assertEqual(missing_followups({'updates': [item]}, {})[0]['id'], 'talk')
        for status in ('done', 'cancelled'):
            nodes['talk']['data'].update(status=status, follow_up='2026-11-20')
            reopened = {**item, 'changes': {'status': 'todo'}}
            self.assertEqual(missing_followups({'updates': [reopened]}, nodes)[0]['id'], 'talk')
            reopened['changes'].update(follow_up='2026-11-22', review_basis='agent')
            self.assertEqual(missing_followups({'updates': [reopened]}, nodes), [])

    def test_librarian_work_and_plain_answers_reach_lumos_without_extra_model_call(self):
        self.create('librarian')
        calls = []
        def planner(context, root):
            calls.append(context['agent']['role'])
            return self.plan(updates=[self.update('evidence')])
        result = run_once(self.store, planner)['intake']
        self.assertEqual(calls, ['librarian'])
        self.assertIsNone(result['data']['lumos_report']['decision'])
        job = self.create('lumos'); claim_intake(self.store, job['id'])
        self.assertIn(result['id'], [r['episode_id'] for r in intake_context(self.store, job['id'])['lumos_reports']])

    def test_clarification_choices_follow_lumos_decision_and_partial_answer_keeps_identity(self):
        from lumos_intake import list_intakes, open_questions
        first = self.create('aipm')
        def question(context, root):
            options = [{'text': '属于模拟建图定位', 'basis_ids': ['mapping']},
                       {'text': '属于模拟入职准备', 'basis_ids': ['prep']}]
            if context['agent']['phase'] == 'decide':
                options.reverse()
            return self.plan(questions=['属于哪个项目，实际结果如何？'], question_options=[{'index': 0, 'options': options}])
        done = run_once(self.store, question)['intake']
        self.assertEqual(done['data']['question_options'][0]['options'][0]['text'], '属于模拟入职准备')
        rows = list_intakes(lumos.Store(self.root))['intakes']
        self.assertTrue(next(n for n in rows if n['id'] == first['id'])['question_options'][0]['options'][0]['available'])
        key = 'question:'+first['id']+':0'
        request = {'request_id': uuid.uuid4().hex, 'chat_id': first['data']['chat_id'], 'chat_parent': first['id'],
                   'agent_role': 'aipm', 'text': '属于模拟建图定位', 'question_key': key, 'question_text': '属于哪个项目，实际结果如何？', 'source': self.source}
        second = save_intake(self.store, request)['intake']
        self.assertTrue(save_intake(self.store, request)['replayed'])
        with self.store.db() as db:
            self.assertEqual(len(open_questions(self.store.nodes(db), 'lingguang')), 1)
        def answer(context, root):
            self.assertEqual(context['intake']['data']['question_key'], key)
            return self.plan(resolutions=[{'intake_id': first['id'], 'index': 0, 'answer': request['text'],
                'excerpt': request['text'], 'state': 'pending', 'remaining': '实际结果如何？', 'review_on': '', 'waiting_for': ''}])
        result = run_once(self.store, answer)['intake']
        self.assertEqual(result['id'], second['id'])
        with self.store.db() as db:
            questions = open_questions(self.store.nodes(db), 'lingguang')
        self.assertEqual([(q['intake_id'], q['index'], q['question']) for q in questions], [(first['id'], 0, '实际结果如何？')])
        self.assertEqual(questions[0]['options'], [])
        self.assertEqual(questions[0]['answers'][0]['source_intake'], second['id'])
        self.assertEqual(questions[0]['answers'][0]['excerpt'], request['text'])

    def test_direct_specialist_and_tampered_prepared_decision_cannot_bypass_lumos(self):
        from lumos_agents import prepare_execution
        job = self.create('aipm'); claimed = claim_intake(self.store, job['id']); context = intake_context(self.store, job['id'])
        claim = claimed['data']['claim']; plan = self.plan(updates=[self.update()])
        request = {'id': job['id'], 'claim': claim, 'basis': context['basis'], 'plan': plan}
        with self.assertRaisesRegex(lumos.Error, 'Lumos'):
            apply_intake(self.store, request)
        for role, phase in [('lumos', 'decide'), ('aipm', 'apply')]:
            attempt = record_step(self.store, job['id'], claim, role, phase, context['basis'])
            record_step(self.store, job['id'], claim, role, phase, attempt=attempt, plan=plan)
        changed = copy.deepcopy(plan); changed['updates'][0]['changes']['owner'] = '另一人'
        prepare_execution(self.store, job['id'], claim, changed)
        with self.assertRaisesRegex(lumos.Error, 'Lumos'):
            apply_intake(self.store, {**request, 'plan': changed})
        prepare_execution(self.store, job['id'], claim, plan)
        self.assertEqual(apply_intake(self.store, request)['intake']['data']['status'], 'done')

    def test_failed_decision_is_reported_to_ops_and_restart_reuses_valid_candidate(self):
        job = self.create('aipm'); calls = []
        def broken(context, root):
            calls.append(context['agent']['role'])
            if context['agent']['role'] == 'lumos':
                raise lumos.Error('模拟执行器不可用')
            return self.plan(updates=[self.update()])
        self.assertEqual(run_once(self.store, broken)['status'], 'failed')
        report = episodes(self.store)['ops_reports'][0]
        self.assertEqual(report['report_to'], '王牧楠'); self.assertEqual(report['status'], 'pending')
        self.assertEqual(report['episode_id'], job['id'])
        with self.store.db() as db:
            failed = self.store.nodes(db)[job['id']]
        save_intake(self.store, {'id': job['id'], 'request_id': uuid.uuid4().hex, 'expected_revision': failed['data']['revision']})
        def resumed(context, root):
            calls.append(context['agent']['role'])
            return self.plan(updates=[self.update()])
        result = run_once(lumos.Store(self.root), resumed)['intake']
        self.assertEqual(calls, ['aipm', 'lumos', 'lumos'])
        self.assertTrue(any(s.get('reused_from') for s in result['data']['agent_steps']))
        self.assertEqual(result['data']['ops_report']['status'], 'recovered')

    def test_changed_source_forces_new_candidate_and_ops_diagnosis_is_not_repair(self):
        job = self.create('aipm')
        def broken(context, root):
            if context['agent']['role'] == 'lumos':
                raise lumos.Error('模拟权限拒绝')
            return self.plan(updates=[self.update()])
        run_once(self.store, broken)
        ops = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'agent_role': 'maintainer', 'episode_ref': job['id'],
            'chat_id': uuid.uuid4().hex, 'text': '核对原因', 'source': self.source})['intake']
        run_once(self.store, lambda *_: self.plan(reply='已核对拒绝记录，尚未修复。'))
        report = episodes(self.store)['ops_reports'][0]
        self.assertEqual(report['status'], 'diagnosed'); self.assertEqual(report['diagnosis_episode'], ops['id'])
        save_task(self.store, {'request_id': uuid.uuid4().hex, 'id': 'talk', 'expected_seq': self.store.status()['seq'],
            'changes': {'progress': '人工新输入'}, 'source': self.source})
        with self.store.db() as db:
            failed = self.store.nodes(db)[job['id']]
        save_intake(self.store, {'id': job['id'], 'request_id': uuid.uuid4().hex, 'expected_revision': failed['data']['revision']})
        calls = []
        def resumed(context, root):
            calls.append(context['agent']['role']); return self.plan(updates=[self.update()])
        run_once(self.store, resumed)
        self.assertEqual(calls, ['aipm', 'lumos'])

    def test_ops_does_not_overwrite_a_new_failure_with_an_old_diagnosis(self):
        job = self.create('aipm'); claimed = claim_intake(self.store, job['id'])
        fail_intake(self.store, job['id'], claimed['data']['claim'], '第一次模拟故障')
        ops = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'agent_role': 'maintainer', 'episode_ref': job['id'],
            'chat_id': uuid.uuid4().hex, 'text': '核对原因', 'source': self.source})['intake']
        ops_claim = claim_intake(self.store, ops['id']); ctx = intake_context(self.store, ops['id'])
        with self.store.db() as db:
            failed = self.store.nodes(db)[job['id']]
        save_intake(self.store, {'id': job['id'], 'request_id': uuid.uuid4().hex, 'expected_revision': failed['data']['revision']})
        new = claim_intake(self.store, job['id']); fail_intake(self.store, job['id'], new['data']['claim'], '第二次模拟故障')
        with self.assertRaisesRegex(lumos.Error, '重新领取'):
            apply_intake(self.store, {'id': ops['id'], 'claim': ops_claim['data']['claim'], 'basis': ctx['basis'], 'plan': self.plan()})
        self.assertEqual(episodes(self.store)['ops_reports'][0]['summary'], '第二次模拟故障')

    def test_atlas_material_impact_follows_aipm_proposal_and_lumos_decision(self):
        self.create('librarian'); calls = []
        def planner(context, root):
            role = context['agent']['role']; calls.append(role)
            if role == 'librarian':
                return self.plan(updates=[self.update('evidence')], delegate_to=['aipm'])
            return self.plan(updates=[self.update()])
        result = run_once(self.store, planner)['intake']
        self.assertEqual(calls, ['librarian', 'aipm', 'lumos'])
        self.assertEqual(set(result['data']['destinations']), {'talk', 'knowledge-test'})
        self.assertEqual(result['data']['lumos_report']['from_role'], 'librarian')

    def test_specialist_denial_and_retry_keep_attempt_history(self):
        job = self.create('librarian')
        before = task_detail(self.store, 'talk')['task']
        self.assertEqual(run_once(self.store, lambda *_: self.plan(updates=[self.update()]))['status'], 'failed')
        self.assertEqual(task_detail(self.store, 'talk')['task'], before)
        with self.store.db() as db:
            failed = self.store.nodes(db)[job['id']]
        save_intake(self.store, {'request_id': uuid.uuid4().hex, 'id': job['id'], 'expected_revision': failed['data']['revision']})
        result = run_once(self.store, lambda *_: self.plan())['intake']
        self.assertEqual([s['status'] for s in result['data']['agent_steps']], ['failed', 'proposed'])
        self.assertEqual([s['attempt'] for s in result['data']['agent_steps']], [1, 2])

    def test_atlas_reads_registers_and_passes_exact_material_to_decision(self):
        from lumos_knowledge import material_catalog
        (self.root/'PREVIEW').touch(); folder = self.root/'project-materials'; folder.mkdir()
        (folder/'条件.md').write_text('标定要求 25ms；实测未知。', encoding='utf-8')
        text = '登记条件.md到模拟建图定位；同步条件已核对。'
        save_intake(self.store, {'request_id': uuid.uuid4().hex, 'agent_role': 'librarian',
            'text': text, 'source': self.source, 'chat_id': uuid.uuid4().hex})
        calls = []
        def planner(context, root):
            role, phase = context['agent']['role'], context['agent']['phase']; calls.append((role, phase))
            if role == 'librarian' and phase == 'work':
                self.assertEqual(context['material_catalog'][0]['path'], '条件.md')
                return self.plan(material_reads=['条件.md'])
            read = context['material_reads'][0]
            self.assertEqual(read['excerpt'], '标定要求 25ms；实测未知。')
            if role == 'librarian':
                return self.plan(delegate_to=['aipm'], material_registrations=[{'path': '条件.md', 'context': 'mapping',
                    'sha256': read['sha256'], 'excerpt': text, 'reason': '确切登记请求'}])
            return self.plan(updates=[self.update()])
        result = run_once(self.store, planner)['intake']
        self.assertEqual(result['data']['status'], 'done')
        self.assertEqual(calls, [('librarian','work'), ('librarian','retrieve'), ('aipm','work'), ('lumos','decide')])
        self.assertEqual(material_catalog(self.store)[0]['registrations'][0]['revision'], 1)
        self.assertEqual(result['data']['lumos_report']['status'], 'received')

    def test_changed_material_refuses_entire_batch(self):
        from lumos_knowledge import material_catalog
        (self.root/'PREVIEW').touch(); folder = self.root/'project-materials'; folder.mkdir()
        file = folder/'条件.md'; file.write_text('旧条件', encoding='utf-8')
        text = '登记条件.md到模拟建图定位；同步条件已核对。'
        save_intake(self.store, {'request_id': uuid.uuid4().hex, 'agent_role': 'librarian', 'text': text, 'source': self.source})
        before = task_detail(self.store, 'talk')['task']
        def planner(context, root):
            if context['agent']['role'] != 'librarian':
                return self.plan(updates=[self.update()])
            if context['agent']['phase'] == 'work':
                return self.plan(material_reads=['条件.md'])
            sha = context['material_reads'][0]['sha256']; file.write_text('读取后人工改动', encoding='utf-8')
            return self.plan(delegate_to=['aipm'], material_registrations=[{'path': '条件.md', 'context': 'mapping',
                'sha256': sha, 'excerpt': text, 'reason': '确切登记请求'}])
        self.assertEqual(run_once(self.store, planner)['status'], 'failed')
        self.assertEqual(task_detail(self.store, 'talk')['task'], before)
        self.assertEqual(material_catalog(self.store)[0]['registrations'], [])

    def test_external_specialist_cannot_bypass_field_ownership(self):
        for role in ('librarian', 'maintainer'):
            job = self.create(role)
            claimed = claim_intake(self.store, job['id'])
            context = intake_context(self.store, job['id'])
            with self.assertRaises(lumos.Error):
                apply_intake(self.store, {'id': job['id'], 'claim': claimed['data']['claim'],
                    'basis': context['basis'], 'plan': self.plan(updates=[self.update()])})

    def test_old_context_and_unprepared_results_are_rejected(self):
        job = self.create()
        def planner(context, root):
            save_task(self.store, {'request_id': uuid.uuid4().hex, 'id': 'talk', 'expected_seq': self.store.status()['seq'],
                                  'changes': {'progress': '人工修改'}, 'source': self.source})
            return self.plan()
        self.assertEqual(run_once(self.store, planner)['status'], 'failed')
        self.assertEqual(task_detail(self.store, 'talk')['task']['data']['progress'], '人工修改')
        second = self.create(); claim = claim_intake(self.store, second['id'])
        context = intake_context(self.store, second['id'])
        record_step(self.store, second['id'], claim['data']['claim'], 'lumos', 'coordinate', context['basis'])
        with self.assertRaises(lumos.Error):
            apply_intake(self.store, {'id': second['id'], 'claim': claim['data']['claim'], 'basis': context['basis'], 'plan': self.plan()})

    def test_patrol_is_deterministic_idempotent_and_does_not_write_business(self):
        job = self.create()
        claim = claim_intake(self.store, job['id'])
        fail_intake(self.store, job['id'], claim['data']['claim'], '模拟离线')
        with self.store.db() as db:
            before = {i: n for i, n in self.store.nodes(db).items() if n['kind'] != 'intake'}
        request = {'request_id': uuid.uuid4().hex, 'workspace': 'lingguang', 'source': self.source}
        result = inspect_once(self.store, request)
        self.assertEqual(result['intake']['data']['findings'][0]['episode_id'], job['id'])
        seq = self.store.status()['seq']
        self.assertTrue(inspect_once(self.store, request)['replayed'])
        self.assertEqual(self.store.status()['seq'], seq)
        with self.store.db() as db:
            self.assertEqual({i: n for i, n in self.store.nodes(db).items() if n['kind'] != 'intake'}, before)

    def test_claim_takeover_marks_interrupted_attempt_and_refuses_old_writer(self):
        job = self.create(); first = claim_intake(self.store, job['id'])
        attempt = record_step(self.store, job['id'], first['data']['claim'], 'lumos', 'coordinate')
        with patch('lumos_intake.now', return_value='2999-01-01T00:00:00+00:00'):
            second = claim_intake(self.store, job['id'])
        self.assertEqual(second['data']['agent_steps'][0]['status'], 'interrupted')
        with self.assertRaises(lumos.Error):
            record_step(self.store, job['id'], first['data']['claim'], 'lumos', 'coordinate', attempt=attempt, plan=self.plan())

    def test_committed_receipt_recovers_after_return_failure_without_duplicate_writes(self):
        self.create()
        def interrupted(request_store, request):
            apply_intake(request_store, request)
            raise OSError('simulated transport error after commit')
        with patch('lumos_worker.apply_intake', side_effect=interrupted):
            result = run_once(self.store, lambda *_: self.plan())
        self.assertTrue(result['recovered'])
        self.assertEqual(result['intake']['data']['status'], 'done')
        self.assertEqual(run_once(self.store), {'status': 'idle'})

    def test_librarian_search_reads_versioned_sources_without_archived_notes(self):
        self.create('librarian')
        calls = []
        def planner(context, root):
            calls.append(context)
            return self.plan(search_query='同步') if len(calls) == 1 else self.plan(reply='检索到固定来源')
        result = run_once(self.store, planner)['intake']
        self.assertIn('catalog', calls[0]['knowledge'])
        self.assertTrue(calls[1]['knowledge']['results'])
        self.assertEqual(result['data']['reply'], '检索到固定来源')
