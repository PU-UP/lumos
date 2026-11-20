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
            'changes': {'progress': '同步条件已核对'} if kind == 'action' else {'context': 'mapping', 'title': '同步依据', 'text': '同步条件已核对'},
            'reason': '原话报告', 'excerpt': '同步条件已核对', 'mode': 'reported'}

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
            return self.plan(reply='已接续任务与知识依据')
        outcome = run_once(self.store, planner)
        self.assertIn('intake', outcome, outcome)
        result = outcome['intake']
        self.assertEqual(calls, [('lumos', 'coordinate'), ('librarian', 'work'), ('aipm', 'work'), ('lumos', 'synthesize')])
        self.assertEqual(result['data']['reply'], '已接续任务与知识依据')
        self.assertEqual(task_detail(self.store, 'talk')['task']['data']['progress'], '已核对；继续检查')
        with self.store.db() as db:
            batches = db.execute('SELECT batch FROM history WHERE node IN (?,?) ORDER BY rowid DESC LIMIT 2', ('talk', 'knowledge-test')).fetchall()
            self.assertEqual(batches[0], batches[1])
        self.assertEqual(result['id'], job['id'])

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
