import copy
import uuid
import threading
import time
from datetime import date, timedelta
from unittest.mock import patch

import lumos
from lumos_intake import (POLICY, save_intake, list_intakes, intake_context, claim_intake,
                          apply_intake, note_intake_status, today, enqueue_due_reviews)
from lumos_mainlines import save_review, mainline_detail
from lumos_notes import save_note, note_detail
from lumos_tasks import task_detail, save_task, list_tasks
from lumos_worker import run_once
from lumos_transfer import backup, restore
from test_core import BaseStoreCase


class IntakeTest(BaseStoreCase):
    def setUp(self):
        super().setUp(); self.seed()
        self.source = {'type': 'user', 'ref': 'ISOLATED SYNTHETIC AUTHORIZATION'}
        updates = [
            {'id': POLICY, 'kind': 'decision', 'data': {'context': 'mapping', 'text': '模拟授权', 'reason': '模拟', 'scope': '模拟',
                'autonomy_workspaces': ['lingguang'], 'source': self.source}},
            {'id': 'person-test', 'kind': 'person', 'data': {'title': '模拟同事', 'context': 'mapping', 'workspaces': ['lingguang'],
                'role': '原正式角色', 'source': self.source}},
            {'id': 'mainline-test', 'kind': 'mainline', 'data': {'title': '模拟主线', 'context': 'mapping', 'goal': '模拟目标',
                'summary': '待讨论', 'task_ids': ['talk'], 'milestone_ids': ['talk'], 'source': self.source}}]
        batch = self.store.begin({'reason': 'synthetic autonomy fixture', 'updates': updates}, True)
        self.store.commit(batch['batch'], True)

    def test_feedback_pins_selected_subject_without_mixing_it_into_user_words(self):
        request={'request_id':uuid.uuid4().hex,'workspace':'lingguang','text':'请先核对结果',
                 'related_ids':['mainline-test'],'source':self.source}
        saved=save_intake(self.store,request)
        context=intake_context(self.store,saved['intake']['id'])
        self.assertEqual(context['text'],'请先核对结果')
        self.assertEqual(context['intake']['data']['related_ids'],['mainline-test'])
        self.assertTrue(save_intake(self.store,request)['replayed'])
        receipt = list_intakes(self.store)['intakes'][0]
        self.assertEqual(receipt['subjects'], [{'id': 'mainline-test', 'title': '模拟主线'}])
        self.assertEqual(receipt['data']['text'], '请先核对结果')
        with self.assertRaises(lumos.Error):
            save_intake(self.store,{**request,'request_id':uuid.uuid4().hex,'related_ids':['missing']})

    def test_chat_discussion_history_model_and_atomic_progress_update(self):
        request = {'request_id': uuid.uuid4().hex, 'chat_id': uuid.uuid4().hex, 'chat_parent': '',
                   'model': 'test-model', 'text': '先讨论同步方案。', 'source': self.source}
        first = save_intake(self.store, request)['intake']
        self.assertTrue(save_intake(self.store, request)['replayed'])
        with self.assertRaisesRegex(lumos.Error, '等待'):
            save_intake(self.store, {**request, 'request_id': uuid.uuid4().hex, 'chat_parent': first['id']})
        job = claim_intake(self.store, first['id'])
        ctx = intake_context(self.store, job['id'])
        self.assertEqual(ctx['chat_history'], [])
        self.assertEqual(ctx['intake']['data']['model'], 'test-model')
        before = task_detail(self.store, 'talk')['task']
        plan = {'summary': '仅讨论', 'reply': '可以先确认同步条件。', 'questions': [], 'updates': []}
        envelope = {'id': job['id'], 'claim': job['data']['claim'], 'basis': ctx['basis'], 'plan': plan}
        receipt = apply_intake(self.store, envelope)['intake']
        self.assertEqual(receipt['data']['reply'], plan['reply'])
        self.assertEqual(receipt['data']['destinations'], [])
        self.assertEqual(task_detail(self.store, 'talk')['task'], before)
        self.assertTrue(apply_intake(self.store, envelope)['replayed'])
        with self.assertRaisesRegex(lumos.Error, '新消息'):
            save_intake(self.store, {**request, 'request_id': uuid.uuid4().hex})
        with self.assertRaisesRegex(lumos.Error, '当前空间'):
            save_intake(self.store, {**request, 'request_id': uuid.uuid4().hex, 'workspace': 'lumos'})
        second = save_intake(self.store, {**request, 'request_id': uuid.uuid4().hex, 'chat_parent': first['id'],
                                        'text': '同步讨论已完成。'})['intake']
        job = claim_intake(self.store, second['id']); ctx = intake_context(self.store, job['id'])
        self.assertEqual([h['id'] for h in ctx['chat_history']], [first['id']])
        self.assertEqual(ctx['chat_history'][0]['reply'], plan['reply'])
        update = {'summary': '已保存进展', 'reply': '讨论结果已接续，验证仍待进行。', 'questions': [],
                  'updates': [self.item(changes={'progress': '讨论已完成，验证待进行'})]}
        apply_intake(self.store, {'id': job['id'], 'claim': job['data']['claim'], 'basis': ctx['basis'], 'plan': update})
        self.assertEqual(task_detail(self.store, 'talk')['task']['data']['progress'], '讨论已完成，验证待进行')

    def test_chat_validation_does_not_relax_ordinary_intake_or_apply_partial_results(self):
        for extra in ({'chat_id': []}, {'chat_id': 'bad'}, {'chat_parent': 'missing'}, {'model': '--bad'}, {'model': '../bad'}):
            with self.assertRaises(lumos.Error):
                save_intake(self.store, {'request_id': uuid.uuid4().hex, 'text': '模拟讨论', 'source': self.source, **extra})
        ordinary = self.job()
        ordinary['plan']['reply'] = '不能靠聊天字段跳过普通整理'
        with self.assertRaises(lumos.Error):
            apply_intake(self.store, ordinary)
        request = {'request_id': uuid.uuid4().hex, 'chat_id': uuid.uuid4().hex, 'text': '同步讨论已完成。', 'source': self.source}
        saved = save_intake(self.store, request)['intake']; job = claim_intake(self.store, saved['id'])
        ctx = intake_context(self.store, job['id']); seq = self.store.status()['seq']
        plan = {'summary': '无效更新', 'reply': '不应保存', 'questions': [],
                'updates': [self.item(), self.item('missing', changes={'progress': '没有这个任务'})]}
        with self.assertRaises(lumos.Error):
            apply_intake(self.store, {'id': job['id'], 'claim': job['data']['claim'], 'basis': ctx['basis'], 'plan': plan})
        self.assertEqual(self.store.status()['seq'], seq)
        self.assertNotIn('reply', intake_context(self.store, job['id'])['intake']['data'])

    def job(self, note=False):
        text = '同步讨论已完成。下一步由模拟同事检查接口。新结果待验证。'
        if note:
            ident = 'note-'+uuid.uuid4().hex
            first = save_note(self.store, {'id': ident, 'request_id': uuid.uuid4().hex, 'expected_revision': 0,
                'changes': {'body': text, 'title': '模拟进展'}, 'source': self.source})
            save_note(self.store, {'id': ident, 'request_id': uuid.uuid4().hex, 'expected_revision': first['note']['data']['revision'],
                'operation': 'finish', 'changes': {}, 'source': self.source})
        else:
            save_intake(self.store, {'request_id': uuid.uuid4().hex, 'text': text, 'source': self.source})
        job = claim_intake(self.store)
        context = intake_context(self.store, job['id'])
        return {'id': job['id'], 'claim': job['data']['claim'], 'basis': context['basis'],
                'plan': {'summary': '模拟处理回执', 'questions': [], 'updates': []}}

    def test_question_receipt_key_survives_processing_and_replay_without_resolving_questions(self):
        first = self.job()
        first['plan']['questions'] = ['阶段结果？']
        apply_intake(self.store, first)
        request = {'request_id': uuid.uuid4().hex, 'text': '阶段结果待核对', 'source': self.source,
                   'question_key': 'question:'+first['id']+':0', 'question_text': '阶段结果？'}
        saved = save_intake(self.store, request)['intake']
        self.assertTrue(save_intake(self.store, request)['replayed'])
        job = claim_intake(self.store, saved['id'])
        context = intake_context(self.store, job['id'])
        self.assertEqual(context['intake']['data']['question_key'], request['question_key'])
        self.assertEqual(context['intake']['data']['question_text'], request['question_text'])
        self.assertEqual(context['text'], request['text'])
        evidence = {'id': job['id']+'-basis', 'kind': 'evidence', 'mode': 'reported',
                    'changes': {'context': 'mapping', 'title': '模拟阶段答复', 'text': request['text']},
                    'excerpt': request['text'], 'reason': '仅保存答复，旧问题未解决'}
        apply_intake(self.store, {'id': job['id'], 'claim': job['data']['claim'], 'basis': context['basis'],
                                 'plan': {'summary': '仍需核对', 'questions': [], 'updates': [evidence], 'resolutions': []}})
        self.assertEqual(len(intake_context(self.store, job['id'])['open_questions']), 1)
        result = next(n for n in list_intakes(self.store)['intakes'] if n['id'] == job['id'])
        self.assertEqual(result['data']['status'], 'done')
        self.assertEqual(result['data']['question_key'], request['question_key'])
        self.assertEqual(result['data']['question_text'], request['question_text'])
        for question in (None, [], 'x'*4001):
            with self.assertRaisesRegex(lumos.Error, 'Invalid intake question_text'):
                save_intake(self.store, {**request, 'request_id': uuid.uuid4().hex, 'question_text': question})
        for key in (None, [], 'x'*501):
            with self.assertRaisesRegex(lumos.Error, 'Invalid question key'):
                save_intake(self.store, {**request, 'request_id': uuid.uuid4().hex, 'question_key': key})

    def item(self, ident='talk', kind='action', changes=None, mode='reported'):
        return {'id': ident, 'kind': kind, 'changes': changes or {'progress': '已讨论，验证待接续'},
                'mode': mode, 'reason': '模拟原文和既有职责依据', 'excerpt': '同步讨论已完成。'}

    def test_atomic_reconciliation_and_pinned_note_archive_replay(self):
        request = self.job(note=True)
        request['plan']['updates'] = [self.item(changes={'status': 'done', 'progress': '讨论完成'}),
            self.item('mainline-test', 'mainline', {'summary': '讨论阶段完成，整体未验收', 'review_on': '2026-11-20', 'review_basis': 'agent'}),
            self.item('person-test', 'person', {'assessment': {'summary': '可继续负责接口', 'responsibilities': ['接口核对'],
                'uncertainties': ['实际验证待确认'], 'basis_ids': ['talk']}})]
        before = task_detail(self.store, 'talk')['task']['data']
        result = apply_intake(self.store, request)
        after = task_detail(self.store, 'talk')
        self.assertEqual(after['task']['data']['completed_on'], today())
        self.assertEqual(before.get('due'), after['task']['data'].get('due'))
        note_id = result['intake']['data']['note']['id']
        note = note_detail(self.store, note_id)
        self.assertEqual(note['note']['data']['status'], 'archived')
        self.assertEqual(after['note_sources'][0]['note']['data']['revision'], 2)
        self.assertEqual(len(note['history']), 1)
        seq = self.store.status()['seq']
        self.assertTrue(apply_intake(self.store, request)['replayed'])
        self.assertEqual(seq, self.store.status()['seq'])
        with self.store.db() as db:
            person = self.store.nodes(db)['person-test']['data']
        self.assertEqual(person['role'], '原正式角色')
        self.assertEqual(person['assessment']['basis_ids'], ['talk'])
        self.assertEqual(self.store.verify()['integrity'], 'ok')

    def test_mainline_priority_keeps_current_basis_and_task_commitments(self):
        before = task_detail(self.store, 'talk')
        for priority, mode, basis in [('P1', 'reported', 'user'), ('P2', 'planned', 'agent')]:
            request = self.job()
            request['plan']['updates'] = [self.item('mainline-test', 'mainline', {'priority': priority}, mode)]
            apply_intake(self.store, request)
            data = mainline_detail(self.store, 'mainline-test')['mainline']['data']
            self.assertEqual(data['priority'], priority)
            self.assertEqual(data['priority_basis'], basis)
            self.assertEqual(data['priority_reason'], request['plan']['updates'][0]['reason'])
            self.assertNotIn('review_on', data)
        after = task_detail(self.store, 'talk')
        self.assertEqual(after['task'], before['task'])
        self.assertEqual(after['history'], before['history'])

    def test_invalid_later_update_rolls_back_entire_result(self):
        request = self.job(note=True)
        before = task_detail(self.store, 'talk')
        request['plan']['updates'] = [self.item(), self.item('person-test', 'person', {'role': '不允许任命'})]
        with self.assertRaises(lumos.Error):
            apply_intake(self.store, request)
        after = task_detail(self.store, 'talk')
        self.assertEqual(before, after)
        self.assertEqual(list_intakes(self.store)['intakes'][0]['data']['status'], 'running')
        self.assertIsNone(self.store.status()['session'])

    def test_agent_followup_cannot_skip_future_delivery_but_can_check_past_outcome(self):
        request = self.job()
        request['plan']['updates'] = [self.item(changes={'due': '2099-01-10'})]
        apply_intake(self.store, request)
        request = self.job()
        request['plan']['updates'] = [self.item(changes={'follow_up': '2099-01-11'}, mode='planned')]
        before = task_detail(self.store, 'talk')['task']
        with self.assertRaisesRegex(lumos.Error, '不能晚于'):
            apply_intake(self.store, request)
        self.assertEqual(task_detail(self.store, 'talk')['task'], before)
        request['plan']['updates'][0]['changes']['follow_up'] = '2099-01-10'
        apply_intake(self.store, request)
        request = self.job()
        request['plan']['updates'] = [self.item(changes={'due': '2020-01-01', 'follow_up': today(), 'review_basis': 'agent'})]
        apply_intake(self.store, request)
        data = task_detail(self.store, 'talk')['task']['data']
        self.assertEqual(data['due'], '2020-01-01')
        self.assertEqual(data['follow_up'], today())

    def test_note_edit_obsoletes_old_plan_without_writes(self):
        request = self.job(note=True)
        job = list_intakes(self.store)['intakes'][0]
        note = job['data']['note']
        save_note(self.store, {'request_id': uuid.uuid4().hex, 'id': note['id'], 'expected_revision': note['revision'],
            'operation': 'edit', 'changes': {'body': '新版内容，旧说法撤回'}, 'source': self.source})
        request['plan']['updates'] = [self.item()]
        self.assertEqual(apply_intake(self.store, request)['intake']['data']['status'], 'obsolete')
        self.assertNotIn('progress', task_detail(self.store, 'talk')['task']['data'])

    def test_task_conflict_refuses_but_unrelated_note_save_does_not(self):
        request = self.job()
        save_note(self.store, {'request_id': uuid.uuid4().hex, 'id': 'note-'+uuid.uuid4().hex, 'expected_revision': 0,
            'changes': {'body': '其他笔记'}, 'source': self.source})
        request['plan']['updates'] = [self.item()]
        self.assertEqual(apply_intake(self.store, request)['intake']['data']['status'], 'done')
        request = self.job()
        save_task(self.store, {'id': 'talk', 'request_id': uuid.uuid4().hex, 'expected_seq': list_tasks(self.store)['seq'],
            'changes': {'progress': '人工刚修改'}, 'source': self.source})
        request['plan']['updates'] = [self.item()]
        with self.assertRaisesRegex(lumos.Error, '已变化'):
            apply_intake(self.store, request)
        self.assertEqual(task_detail(self.store, 'talk')['task']['data']['progress'], '人工刚修改')

    def test_internal_schedule_and_assignment_preserve_commitments(self):
        save_task(self.store, {'id': 'talk', 'request_id': uuid.uuid4().hex, 'expected_seq': list_tasks(self.store)['seq'],
            'changes': {'due': '2026-12-01', 'owner': '已明确人员'}, 'source': self.source})
        request = self.job()
        request['plan']['updates'] = [self.item(changes={'planned_due': '2026-11-29', 'follow_up': '2026-11-20'}, mode='planned')]
        apply_intake(self.store, request)
        data = task_detail(self.store, 'talk')['task']['data']
        self.assertEqual(data['due'], '2026-12-01')
        self.assertEqual(data['planned_due'], '2026-11-29')
        self.assertEqual(data['review_basis'], 'agent')
        for changes in [{'due': '2026-12-03'}, {'owner': '模拟同事'}, {'status': 'done', 'completed_on': today()}]:
            request = self.job(); request['plan']['updates'] = [self.item(changes=changes, mode='planned')]
            with self.assertRaises(lumos.Error):
                apply_intake(self.store, request)
            # Finish this synthetic attempt so the next assertion gets a separate claim.
            from lumos_intake import fail_intake
            fail_intake(self.store, request['id'], request['claim'], 'synthetic rejected')

    def test_new_delegated_task_and_source_validation(self):
        request = self.job()
        request['plan']['updates'] = [self.item('new-task', changes={'context': 'mapping', 'text': '模拟接口检查',
            'condition': '检查记录已形成', 'owner': '模拟同事', 'planned_due': '2026-11-20'}, mode='planned')]
        apply_intake(self.store, request)
        data = task_detail(self.store, 'new-task')['task']['data']
        self.assertEqual(data['source']['type'], 'agent')
        self.assertEqual(data['owner_basis'], 'agent')
        self.assertFalse(data.get('due'))
        request = self.job(); request['plan']['updates'] = [self.item()]
        request['plan']['updates'][0]['excerpt'] = '没有这句话'
        with self.assertRaisesRegex(lumos.Error, 'excerpt'):
            apply_intake(self.store, request)

    def test_questions_keep_note_and_failure_receipt_is_retriable(self):
        request = self.job(note=True)
        request['plan']['questions'] = ['存在无法确定的项目归属']
        result = apply_intake(self.store, request)
        self.assertEqual(result['intake']['data']['status'], 'needs_review')
        self.assertEqual(note_detail(self.store, result['intake']['data']['note']['id'])['note']['data']['status'], 'active')
        retry = {'request_id': uuid.uuid4().hex, 'id': request['id'], 'expected_revision': result['intake']['data']['revision']}
        with self.assertRaises(lumos.Error):
            save_intake(self.store, retry)
        save_intake(self.store, {'request_id': uuid.uuid4().hex, 'text': '新补充', 'source': self.source})
        def broken(*args):
            raise RuntimeError('synthetic provider unavailable')
        result = run_once(self.store, broken)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(list_intakes(self.store)['intakes'][0]['data']['status'], 'failed')
        failed = list_intakes(self.store)['intakes'][0]
        retry.update(id=failed['id'], expected_revision=failed['data']['revision'])
        save_intake(self.store, retry)
        self.assertTrue(save_intake(self.store, retry)['replayed'])

    def set_review(self, day):
        save_review(self.store, {'request_id': uuid.uuid4().hex, 'id': 'mainline-test',
            'expected_seq': list_tasks(self.store)['seq'], 'review_on': day, 'source': self.source})

    def test_due_review_runs_once_survives_restart_and_preserves_user_date(self):
        self.set_review(today())
        before = task_detail(self.store, 'talk')
        with patch('lumos_intake.today', return_value='2000-01-01'):
            self.assertEqual(enqueue_due_reviews(self.store), 0)
        self.assertEqual(enqueue_due_reviews(self.store), 1)
        self.assertEqual(enqueue_due_reviews(lumos.Store(self.root)), 0)
        def planner(context, root):
            self.assertIn('review', context['intake']['data'])
            return {'summary': '已核对；没有新增结果，仍待验证', 'questions': [], 'updates': []}
        self.assertEqual(run_once(self.store, planner)['intake']['data']['status'], 'done')
        self.assertEqual(run_once(self.store, planner), {'status': 'idle'})
        data = mainline_detail(self.store, 'mainline-test')['mainline']['data']
        self.assertEqual(data['review_on'], today())
        self.assertEqual(data['review_basis'], 'user')
        self.assertEqual(data['review_checked_on'], today())
        self.assertEqual(data['review_checked_revision'], data['review_revision'])
        after = task_detail(self.store, 'talk')
        self.assertEqual(after['task'], before['task'])
        self.assertEqual(after['history'], before['history'])
        self.set_review(today())  # An explicit new arrangement can request another review the same day.
        self.assertEqual(enqueue_due_reviews(self.store), 1)

    def test_rescheduled_review_is_obsolete_and_human_input_has_priority(self):
        self.set_review(today()); enqueue_due_reviews(self.store)
        human = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'text': '用户新进展', 'source': self.source})['intake']
        self.assertEqual(claim_intake(self.store)['id'], human['id'])
        self.set_review((date.fromisoformat(today())+timedelta(days=3)).isoformat())
        self.assertIsNone(claim_intake(self.store))
        scheduled = next(n for n in list_intakes(self.store)['intakes'] if n['data'].get('review'))
        self.assertEqual(scheduled['data']['status'], 'obsolete')

    def test_scheduled_review_cannot_invent_completion_and_failure_does_not_loop(self):
        self.set_review(today())
        def invalid(context, root):
            return {'summary': '错误计划', 'questions': [], 'updates': [{**self.item(changes={'status': 'done'}), 'excerpt': context['text']}]}
        self.assertEqual(run_once(self.store, invalid)['status'], 'failed')
        self.assertEqual(run_once(self.store, invalid), {'status': 'idle'})
        self.assertNotEqual(task_detail(self.store, 'talk')['task']['data']['status'], 'done')
        self.assertNotIn('review_checked_on', mainline_detail(self.store, 'mainline-test')['mainline']['data'])

    def test_user_dates_cannot_be_relabelled_or_overridden_by_agent_plan(self):
        day = (date.fromisoformat(today())+timedelta(days=5)).isoformat()
        self.set_review(day)
        request = self.job()
        for changes in [{'review_on': '2099-01-01'}, {'review_basis': 'agent'}]:
            request['plan']['updates'] = [self.item('mainline-test', 'mainline', changes, 'planned')]
            with self.assertRaises(lumos.Error):
                apply_intake(self.store, request)
        request['plan']['updates'] = [self.item('mainline-test', 'mainline', {'review_on': day}, 'planned')]
        apply_intake(self.store, request)
        self.assertEqual(mainline_detail(self.store, 'mainline-test')['mainline']['data']['review_basis'], 'user')
        save_task(self.store, {'id': 'talk', 'request_id': uuid.uuid4().hex, 'expected_seq': list_tasks(self.store)['seq'],
            'changes': {'follow_up': day}, 'source': self.source})
        request = self.job(); request['plan']['updates'] = [self.item(changes={'follow_up': '2099-01-01'}, mode='planned')]
        with self.assertRaisesRegex(lumos.Error, '用户安排'):
            apply_intake(self.store, request)

    def test_explicit_user_reschedule_keeps_provenance_and_old_plan_is_rejected(self):
        self.set_review(today())
        save_intake(self.store, {'request_id': uuid.uuid4().hex, 'text': '主线改为2099-01-01复核', 'source': self.source})
        job = claim_intake(self.store); context = intake_context(self.store, job['id'])
        request = {'id': job['id'], 'claim': job['data']['claim'], 'basis': context['basis'], 'plan': {
            'summary': '按用户安排改期', 'questions': [], 'updates': [{**self.item('mainline-test', 'mainline', {'review_on': '2099-01-01'}), 'excerpt': context['text']}]}}
        self.set_review('2098-01-01')
        with self.assertRaisesRegex(lumos.Error, '已变化'):
            apply_intake(self.store, request)
        request['basis'] = intake_context(self.store, job['id'])['basis']
        apply_intake(self.store, request)
        data = mainline_detail(self.store, 'mainline-test')['mainline']['data']
        self.assertEqual(data['review_basis'], 'user')
        self.assertEqual(data['review_source']['quote'], context['text'])
        self.assertEqual(data['review_on'], '2099-01-01')

    def test_followup_answers_close_questions_atomically_and_archive_original_note(self):
        first = self.job(note=True); first['plan']['questions'] = ['归属哪个项目？', '由谁负责？']
        original = apply_intake(self.store, first)['intake']
        second = self.job(); context = intake_context(self.store, second['id'])
        self.assertEqual(len(context['open_questions']), 2)
        answer = {'intake_id': first['id'], 'index': 0, 'answer': '归属已确认项目', 'excerpt': '下一步由模拟同事检查接口。'}
        second['plan']['resolutions'] = [answer]
        second['plan']['updates'] = [self.item()]
        apply_intake(self.store, second)
        unresolved = intake_context(self.store, second['id'])['open_questions']
        self.assertEqual([q['index'] for q in unresolved], [1])
        third = self.job(); third['plan']['resolutions'] = [{**answer, 'index': 1, 'answer': '模拟同事负责'}]
        third['plan']['updates'] = [self.item('person-test', 'person', {'role': '不能任命'})]
        with self.assertRaises(lumos.Error):
            apply_intake(self.store, third)
        self.assertEqual(len(intake_context(self.store, third['id'])['open_questions']), 1)
        third['plan']['updates'] = []
        apply_intake(self.store, third)
        receipts = {n['id']: n for n in list_intakes(self.store)['intakes']}
        self.assertEqual(receipts[first['id']]['data']['questions'], first['plan']['questions'])
        self.assertEqual(receipts[first['id']]['data']['status'], 'done')
        self.assertEqual(len(receipts[first['id']]['data']['resolutions']), 2)
        self.assertEqual(note_detail(self.store, original['data']['note']['id'])['note']['data']['status'], 'archived')
        self.assertTrue(apply_intake(self.store, third)['replayed'])
        self.assertEqual(self.store.verify()['integrity'], 'ok')

    def test_answer_does_not_archive_edited_note_or_overwrite_concurrent_answer(self):
        first = self.job(note=True); first['plan']['questions'] = ['负责人？']
        original = apply_intake(self.store, first)['intake']
        second = self.job(); third = self.job()
        for request in (second, third):
            request['plan']['resolutions'] = [{'intake_id': first['id'], 'index': 0, 'answer': '模拟同事', 'excerpt': '下一步由模拟同事检查接口。'}]
        note = original['data']['note']
        save_note(self.store, {'request_id': uuid.uuid4().hex, 'id': note['id'], 'expected_revision': note['revision'],
            'operation': 'edit', 'changes': {'body': '还有一段新的待整理内容'}, 'source': self.source})
        apply_intake(self.store, second)
        with self.assertRaisesRegex(lumos.Error, '已变化'):
            apply_intake(self.store, third)
        self.assertEqual(note_detail(self.store, note['id'])['note']['data']['status'], 'active')

    def test_review_context_reads_only_exact_linked_document_version(self):
        request = self.job()
        request['plan']['updates'] = [self.item('mainline-test', 'mainline', {'source_ids': ['plan']})]
        apply_intake(self.store, request)
        records = {n['id']: n for n in intake_context(self.store, request['id'])['records']}
        self.assertIn('同步与标定尚待核实', records['plan']['content'])
        self.assertNotIn('map', records)
        # A working draft is not silently promoted to evidence.
        (self.root/'work/mapping.md').write_text('未经吸收的新草稿', encoding='utf-8')
        records = {n['id']: n for n in intake_context(self.store, request['id'])['records']}
        self.assertNotIn('新草稿', records['plan']['content'])

    def test_note_queue_and_assessments_survive_backup_restore(self):
        request = self.job(note=True)
        request['plan']['updates'] = [self.item('person-test', 'person', {'assessment': {'summary': '模拟职责理解',
            'responsibilities': ['接口'], 'uncertainties': [], 'basis_ids': ['talk']}})]
        apply_intake(self.store, request)
        snapshot = self.area/'backup'
        backup(self.store, snapshot, True)
        restore(snapshot, self.area/'restored', sandbox=True)
        self.assertEqual(list_intakes(lumos.Store(self.area/'restored')), list_intakes(self.store))

    def test_conversation_claim_is_not_taken_by_background_worker(self):
        result = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'text': '本对话处理', 'execution': 'conversation', 'source': self.source})
        self.assertIsNone(claim_intake(self.store))
        self.assertEqual(claim_intake(self.store, result['intake']['id'])['id'], result['intake']['id'])

    def test_short_background_write_does_not_break_note_reads(self):
        ready = threading.Event()
        def hold():
            with lumos.process_lock(self.root):
                ready.set(); time.sleep(0.1)
        thread = threading.Thread(target=hold)
        thread.start(); self.assertTrue(ready.wait(1))
        self.assertEqual(len(list_tasks(self.store)['tasks']), 1)
        thread.join()
