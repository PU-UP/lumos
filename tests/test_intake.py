import copy
import uuid
import threading
import time
from datetime import date, timedelta
from unittest.mock import patch

import lumos
from lumos_intake import (POLICY, save_intake, list_intakes, intake_context, claim_intake,
                          apply_intake, note_intake, note_intake_status, today, enqueue_due_reviews)
from lumos_mainlines import save_review, mainline_detail
from lumos_notes import save_note, note_detail
from lumos_tasks import task_detail, save_task, list_tasks
from lumos_worker import run_once
from lumos_transfer import backup, restore
from test_core import BaseStoreCase


class IntakeTest(BaseStoreCase):
    def test_existing_sources_archive_note_without_duplicate_updates_or_questions(self):
        request = self.job(note=True)
        request['plan']['source_refs'] = [{'id': 'talk', 'excerpt': '同步讨论已完成。'}]
        before = task_detail(self.store, 'talk')['task']
        for refs in ([{'id': 'missing', 'excerpt': '同步讨论已完成。'}],
                     [{'id': POLICY, 'excerpt': '同步讨论已完成。'}],
                     [{'id': 'talk', 'excerpt': '伪造本轮原话'}], None):
            seq = self.store.status()['seq']
            with self.assertRaises(lumos.Error):
                apply_intake(self.store, {**request, 'plan': {**request['plan'], 'source_refs': refs}})
            self.assertEqual(self.store.status()['seq'], seq)
        result = apply_intake(self.store, request)['intake']['data']
        self.assertEqual(result['status'], 'done')
        self.assertEqual(result['destinations'], [])
        self.assertEqual(len(result['source_refs'][0]['basis']), 64)
        note = note_detail(self.store, result['note']['id'])['note']['data']
        self.assertEqual(note['status'], 'archived')
        self.assertIn('已有来源 talk', note['archive_reason'])
        self.assertEqual(task_detail(self.store, 'talk')['task'], before)
        self.assertTrue(apply_intake(self.store, request)['replayed'])
        save_task(self.store, {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'],
            'id': 'talk', 'changes': {'progress': '后续改变不覆盖旧引用'}, 'source': self.source})
        self.assertEqual(self.store.verify()['integrity'], 'ok')
        self.assertEqual(intake_context(self.store, request['id'])['intake']['data']['source_refs'], result['source_refs'])

    def test_existing_source_rejects_cross_workspace_and_questions_have_archive_destination(self):
        request = self.job(note=True)
        with self.store.db() as db:
            nodes = self.store.nodes(db)
            context, job = nodes['prep'], nodes[request['id']]
        context['data']['workspace'] = 'lumos'
        job['data']['note_mode'] = 'archive'
        batch = self.store.begin({'reason': 'synthetic scope and explicit archive', 'updates': [context, job]}, True)
        self.store.commit(batch['batch'], True)
        request['basis'] = intake_context(self.store, request['id'])['basis']
        request['plan']['source_refs'] = [{'id': 'prep', 'excerpt': '同步讨论已完成。'}]
        with self.assertRaisesRegex(lumos.Error, '当前资料范围'):
            apply_intake(self.store, request)
        request['plan'].update(source_refs=[], questions=['哪项条件阻止下一步？'])
        result = apply_intake(self.store, request)['intake']['data']
        self.assertIn('待答问题 '+request['id'], note_detail(self.store, result['note']['id'])['note']['data']['archive_reason'])

    def test_question_choices_reject_invalid_sources_and_survive_source_changes_without_rewriting_history(self):
        first = self.job()
        options = [{'index': 0, 'options': [{'text': '讨论当前同步任务', 'basis_ids': ['talk']},
                                         {'text': '讨论入职准备', 'basis_ids': ['prep']}]}]
        first['plan'].update(questions=['想讨论哪件事？'], question_options=options)
        for bad in ([{'index': 1, 'options': options[0]['options']}],
                    [{'index': 0, 'options': [{'text': '不存在', 'basis_ids': ['missing']}]}],
                    [{'index': 0, 'options': [{'text': '不能把授权记录当选项', 'basis_ids': [POLICY]}]}],
                    [{'index': 0, 'options': [{'text': '无依据', 'basis_ids': []}]}]):
            with self.assertRaises(lumos.Error):
                apply_intake(self.store, {**first, 'plan': {**first['plan'], 'question_options': bad}})
        saved = apply_intake(self.store, first)['intake']
        self.assertTrue(list_intakes(self.store)['intakes'][0]['question_options'][0]['options'][0]['available'])
        save_task(self.store, {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'], 'id': 'talk',
                              'changes': {'progress': '背景已改变'}, 'source': self.source})
        row = next(n for n in list_intakes(self.store)['intakes'] if n['id'] == first['id'])
        self.assertFalse(row['question_options'][0]['options'][0]['available'])
        self.assertTrue(row['question_options'][0]['options'][1]['available'])
        self.assertEqual(row['data']['question_options'], saved['data']['question_options'])
        self.assertTrue(apply_intake(self.store, first)['replayed'])

    def test_question_choice_cannot_reference_another_workspace(self):
        first = self.job()
        with self.store.db() as db:
            context = self.store.nodes(db)['prep']
        context['data']['workspace'] = 'lumos'
        batch = self.store.begin({'reason': 'synthetic scope change', 'updates': [context]}, True)
        self.store.commit(batch['batch'], True)
        first['basis'] = intake_context(self.store, first['id'])['basis']
        first['plan'].update(questions=['属于哪个项目？'], question_options=[{'index': 0, 'options': [{'text': '入职准备', 'basis_ids': ['prep']}]}])
        with self.assertRaisesRegex(lumos.Error, '当前资料范围'):
            apply_intake(self.store, first)

    def test_waiting_followup_is_atomic_bounded_and_preserves_business_history(self):
        self.enable_management()
        first = self.job(); first['plan']['questions'] = ['T-001 的阶段结果？']
        apply_intake(self.store, first)
        second = self.job()
        future = (date.fromisoformat(today()) + timedelta(days=3)).isoformat()
        second['plan']['resolutions'] = [{'intake_id': first['id'], 'index': 0,
            'answer': '暂无结果', 'excerpt': intake_context(self.store, second['id'])['text'],
            'state': 'waiting', 'remaining': 'T-001 的阶段结果？', 'review_on': future, 'waiting_for': '测试结果'}]
        before = task_detail(self.store, 'talk')['task']['data']
        apply_intake(self.store, second)
        after = task_detail(self.store, 'talk')['task']['data']
        self.assertEqual(after['follow_up'], future)
        for field in ('status', 'due', 'progress', 'updated_at'):
            self.assertEqual(after.get(field), before.get(field))
        board = list_tasks(self.store)
        self.assertEqual(board['open_questions'][0]['follow_up_on'], future)
        seq = board['seq']; enqueue_due_reviews(self.store)
        self.assertEqual(self.store.status()['seq'], seq)
        third = self.job()
        third['plan']['resolutions'] = [{**second['plan']['resolutions'][0], 'review_on': ''}]
        apply_intake(self.store, third)
        q = list_tasks(self.store)['open_questions'][0]
        self.assertEqual(q['follow_up_on'], future)
        self.assertEqual(len(q['answers']), 2)

    def test_grouped_reply_must_continue_all_selected_open_questions(self):
        first = self.job(); first['plan']['questions'] = ['阶段结果？', '关键阻塞？']
        apply_intake(self.store, first)
        keys = [f"question:{first['id']}:{i}" for i in range(2)]
        job = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'text': '暂无变化',
            'source': self.source, 'question_key': keys[0], 'question_keys': keys})['intake']
        claim = claim_intake(self.store, job['id'])
        ctx = intake_context(self.store, job['id'])
        answer = {'intake_id': first['id'], 'index': 0, 'answer': '暂无变化', 'excerpt': ctx['text'],
            'state': 'waiting', 'remaining': '阶段结果？', 'review_on': '', 'waiting_for': '新消息'}
        request = {'id': job['id'], 'claim': claim['data']['claim'], 'basis': ctx['basis'],
            'plan': {'summary': '继续等待', 'questions': [], 'updates': [], 'resolutions': [answer]}}
        with self.assertRaisesRegex(lumos.Error, '接续所选问题'):
            apply_intake(self.store, request)
        request['plan']['resolutions'].append({**answer, 'index': 1, 'remaining': '关键阻塞？'})
        apply_intake(self.store, request)
        questions = list_tasks(self.store)['open_questions']
        self.assertEqual(len(questions), 2)
        expected = (date.fromisoformat(today()) + timedelta(days=7)).isoformat()
        self.assertTrue(all(q['follow_up_on'] == expected for q in questions))

    def enable_management(self):
        with self.store.db() as db:
            policy = self.store.nodes(db)[POLICY]
        policy['data']['task_management_workspaces'] = ['lingguang']
        batch = self.store.begin({'reason': 'synthetic task management grant', 'updates': [policy]}, True)
        self.store.commit(batch['batch'], True)

    def full_review(self):
        from lumos_task_review import request_task_review
        job = request_task_review(self.store, {'request_id': uuid.uuid4().hex, 'workspace': 'lingguang', 'source': self.source})['intake']
        claimed = claim_intake(self.store, job['id']); ctx = intake_context(self.store, job['id'])
        return ctx, {'id': job['id'], 'claim': claimed['data']['claim'], 'basis': ctx['basis'],
                    'plan': {'summary': '已核对全部模拟任务', 'questions': [], 'updates': [], 'resolutions': [],
                             'task_reviews': [{'id': 'talk', 'question': '', 'reason': '核对模拟任务安排'}]}}

    def apply_review(self, request):
        from lumos_agents import record_step, prepare_execution
        for role, phase in [('lumos', 'decide'), ('aipm', 'apply')]:
            attempt = record_step(self.store, request['id'], request['claim'], role, phase, request['basis'])
            record_step(self.store, request['id'], request['claim'], role, phase, attempt=attempt, plan=request['plan'])
        prepare_execution(self.store, request['id'], request['claim'], request['plan'])
        return apply_intake(self.store, request)

    def test_full_review_requires_grant_coverage_and_real_questions_then_stamps_atomically(self):
        from lumos_task_review import request_task_review
        request = {'request_id': uuid.uuid4().hex, 'workspace': 'lingguang', 'source': self.source, 'model': 'gpt-6.2-astra'}
        with self.assertRaisesRegex(lumos.Error, '统筹授权'):
            request_task_review(self.store, request)
        self.enable_management()
        first = request_task_review(self.store, request)['intake']
        self.assertEqual(first['data']['model'], 'gpt-6.2-astra')
        again = request_task_review(self.store, {**request, 'request_id': uuid.uuid4().hex, 'model': 'gpt-6.2-sol'})['intake']
        self.assertEqual(first['id'], again['id'])
        self.assertEqual(again['data']['model'], 'gpt-6.2-astra')
        ctx, env = self.full_review()
        before = task_detail(self.store, 'talk')['task']['data']
        for reviews in ([], [{'id': 'talk', 'question': '', 'reason': '未处理异常'}],
                        [{'id': 'talk', 'question': 'new:99', 'reason': '不存在的问题'}]):
            env['plan']['task_reviews'] = reviews
            with self.assertRaises(lumos.Error):
                self.apply_review(env)
            self.assertEqual(task_detail(self.store, 'talk')['task']['data'], before)
        env['plan']['task_reviews'] = [{'id': 'talk', 'question': 'new:0', 'reason': '尚缺关键节点结果'}]
        env['plan']['questions'] = ['模拟主线的实际阶段结果是什么？']
        receipt = self.apply_review(env)['intake']
        self.assertTrue(receipt['data']['completed_at'])
        board = list_tasks(self.store)
        self.assertEqual(board['task_reviews']['lingguang']['completed']['id'], first['id'])
        task = next(t for t in board['tasks'] if t['id'] == 'talk')
        self.assertEqual(task['management_question']['question'], env['plan']['questions'][0])
        self.assertEqual(task['management_question']['related_ids'], ['talk'])
        self.assertEqual(task['data'].get('progress'), before.get('progress'))
        self.assertEqual(task['data'].get('updated_at'), before.get('updated_at'))

    def test_manual_edits_are_preserved_and_management_can_rearrange_without_faking_progress(self):
        self.enable_management()
        save_task(self.store, {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'], 'id': 'talk',
                              'changes': {'owner': '王牧楠', 'follow_up': '2020-01-01'}, 'source': self.source})
        ctx, env = self.full_review()
        future = (date.fromisoformat(today()) + timedelta(days=3)).isoformat()
        env['plan']['updates'] = [{'id': 'talk', 'kind': 'action', 'mode': 'planned', 'excerpt': ctx['text'],
                                  'reason': '依据模拟同事既有分工接续', 'changes': {'owner': '模拟同事', 'follow_up': future, 'planned_due': future}}]
        self.apply_review(env)
        task = task_detail(self.store, 'talk')['task']['data']
        self.assertEqual(task['owner'], '模拟同事')
        self.assertEqual(task['manual_edits']['owner']['value'], '王牧楠')
        self.assertTrue(task['manual_edits']['owner']['seen_at'])
        self.assertEqual(task['status'], 'todo')
        self.assertEqual(task['task_review']['issues'], [])
        ctx, env = self.full_review()
        env['plan']['updates'] = [{'id': 'talk', 'kind': 'action', 'mode': 'reported', 'excerpt': ctx['text'],
                                  'reason': '不应伪造', 'changes': {'status': 'done'}}]
        with self.assertRaisesRegex(lumos.Error, '新进展报告'):
            self.apply_review(env)

    def test_full_review_rejects_concurrent_manual_changes_and_keeps_previous_completion(self):
        self.enable_management(); ctx, env = self.full_review()
        env['plan']['questions'] = ['模拟关键节点？']; env['plan']['task_reviews'][0]['question'] = 'new:0'
        first = self.apply_review(env)['intake']
        ctx, env = self.full_review()
        save_task(self.store, {'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'], 'id': 'talk',
                              'changes': {'progress': '王牧楠新修改'}, 'source': self.source})
        with self.assertRaisesRegex(lumos.Error, '已变化'):
            self.apply_review(env)
        board = list_tasks(self.store)
        self.assertEqual(board['task_reviews']['lingguang']['completed']['id'], first['id'])
        self.assertNotIn('seen_at', task_detail(self.store, 'talk')['task']['data']['manual_edits']['progress'])

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
            # Keep these fixtures as pre-upgrade queued notes to test historical compatibility.
            def legacy_queue(node, mode):
                job = note_intake(node)
                job['data'].pop('note_mode')
                return job
            with patch('lumos_intake.note_intake', side_effect=legacy_queue):
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
        apply_request = {'id': job['id'], 'claim': job['data']['claim'], 'basis': context['basis'],
                         'plan': {'summary': '仍需核对', 'questions': [], 'updates': [evidence], 'resolutions': []}}
        with self.assertRaisesRegex(lumos.Error, '尚未接续'):
            apply_intake(self.store, apply_request)
        apply_request['plan']['resolutions'] = [{'intake_id': first['id'], 'index': 0,
            'answer': '阶段结果仍待核对', 'excerpt': request['text'], 'state': 'waiting',
            'remaining': '阶段核对结果是什么？', 'review_on': '', 'waiting_for': '阶段结果产生'}]
        apply_intake(self.store, apply_request)
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
        future = (date.fromisoformat(today()) + timedelta(days=3)).isoformat()
        request['plan']['updates'] = [self.item(changes={'status': 'done', 'progress': '讨论完成'}),
            self.item('mainline-test', 'mainline', {'summary': '讨论阶段完成，整体未验收', 'review_on': future, 'review_basis': 'agent'}),
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

    def test_roster_followup_uses_original_user_facts_and_reports_written_person(self):
        from lumos_worker import run_once
        chat = uuid.uuid4().hex
        def send(text, parent=''):
            return save_intake(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': chat,
                'chat_parent': parent, 'text': text, 'source': self.source})['intake']['id']
        facts = '姓名更正为模拟甲，目前确定12/2入职。'
        first = send(facts)
        empty = {'reply': '已核对', 'summary': '核对', 'questions': [], 'updates': []}
        run_once(self.store, lambda *_: empty.copy())
        directive = '请更正这些信息'
        second = send(directive, first)
        changes = {'title': '模拟甲', 'arrival_note': '目前确定12/2入职',
                   'fact_ref': {'id': first, 'quote': facts}}
        item = {**self.item('person-test', 'person', changes), 'excerpt': directive}
        result = run_once(self.store, lambda *_: {**empty, 'updates': [item]})['intake']
        self.assertEqual(result['id'], second)
        self.assertEqual(result['data']['destinations'], ['person-test'])
        self.assertEqual([s['phase'] for s in result['data']['agent_steps']], ['coordinate', 'work', 'decide', 'apply'])
        person = next(n['data'] for n in list_tasks(self.store)['people'] if n['id'] == 'person-test')
        self.assertEqual((person['title'], person['arrival_note']), ('模拟甲', '目前确定12/2入职'))
        self.assertEqual(person['last_source']['fact_ref'], changes['fact_ref'])
        self.assertEqual(person['last_source']['quote'], directive)
        self.assertEqual(person['role'], '原正式角色')

        # A separate chat cannot borrow this user's statement from the first one.
        chat = uuid.uuid4().hex
        send(directive)
        failed = run_once(self.store, lambda *_: {**empty, 'updates': [item]})
        self.assertIn('同一对话', failed['error'])

    def test_direct_roster_correction_preserves_owner_and_replays_once(self):
        text = '把模拟同事更正为模拟甲，入职日期还没有确定'
        job = save_intake(self.store, {'request_id': uuid.uuid4().hex, 'text': text, 'source': self.source})['intake']
        claimed = claim_intake(self.store, job['id'])
        update = {**self.item('person-test', 'person', {'title': '模拟甲', 'arrival_note': '入职日期还没有确定'}),
                  'excerpt': text}
        request = {'id': job['id'], 'claim': claimed['data']['claim'], 'basis': intake_context(self.store, job['id'])['basis'],
                   'plan': {'summary': '更正名册', 'updates': [update], 'questions': []}}
        owner = task_detail(self.store, 'talk')['task']['data'].get('owner')
        self.assertEqual(apply_intake(self.store, request)['intake']['data']['destinations'], ['person-test'])
        self.assertTrue(apply_intake(self.store, request)['replayed'])
        self.assertEqual(task_detail(self.store, 'talk')['task']['data'].get('owner'), owner)

    def test_roster_field_cannot_be_invented_inferred_or_silently_dropped(self):
        from lumos_worker import run_once
        for mode, name, omit, error in [('planned', '模拟甲', False, '明确报告'),
                                        ('reported', '模拟乙', False, '原话'),
                                        ('reported', '模拟甲', True, '尚未写入'),
                                        ('reported', '模拟甲', 'old-value', '尚未写入')]:
            with self.subTest(mode=mode, name=name, omit=omit):
                text = '姓名更正为模拟甲'
                save_intake(self.store, {'request_id': uuid.uuid4().hex, 'chat_id': uuid.uuid4().hex,
                            'text': text, 'source': self.source})
                item = {**self.item('person-test', 'person', {'title': name}, mode), 'excerpt': text}
                def planner(ctx, root):
                    updates = [] if omit is True and ctx['agent']['phase'] == 'work' else [item]
                    if omit == 'old-value' and ctx['agent']['phase'] == 'decide':
                        updates = [{**item, 'changes': {'title': '模拟同事'}}]
                    if ctx['agent']['phase'] == 'synthesize':
                        updates = []
                    return {'summary': '核对', 'reply': '核对', 'questions': [], 'updates': updates}
                self.assertIn(error, run_once(self.store, planner)['error'])
                with self.store.db() as db:
                    self.assertEqual(self.store.nodes(db)['person-test']['data']['title'], '模拟同事')

    def test_current_plan_replaces_old_deadline_without_losing_promise(self):
        from lumos_task_review import task_issues
        self.enable_management()
        request = self.job()
        request['plan']['updates'] = [self.item(changes={'due': '2020-01-01'})]
        apply_intake(self.store, request)
        request = self.job()
        request['plan']['updates'] = [self.item(changes={'planned_due': '2099-01-10', 'follow_up': '2099-01-09'}, mode='planned')]
        apply_intake(self.store, request)
        data = task_detail(self.store, 'talk')['task']['data']
        self.assertEqual(data['due'], '2020-01-01')
        self.assertEqual(data['planned_due'], '2099-01-10')
        self.assertFalse(any('交付' in issue for issue in task_issues(data, today())))
        request = self.job()
        request['plan']['updates'] = [self.item(changes={'planned_due': '2099-01-08'}, mode='planned')]
        with self.assertRaisesRegex(lumos.Error, '不能晚于'):
            apply_intake(self.store, request)
        request['plan']['updates'] = [self.item(changes={'due': '2099-01-12'})]
        apply_intake(self.store, request)
        self.assertFalse(task_detail(self.store, 'talk')['task']['data'].get('planned_due'))

    def test_server_review_metadata_is_rejected_without_partial_task_write(self):
        request = self.job()
        before = task_detail(self.store, 'talk')
        request['plan']['updates'] = [self.item(changes={'progress': 'must not save', 'task_review': {}})]
        with self.assertRaisesRegex(lumos.Error, 'task_review.*任务未更新'):
            apply_intake(self.store, request)
        self.assertEqual(task_detail(self.store, 'talk'), before)

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
        with self.assertRaisesRegex(lumos.Error, '换批次'):
            apply_intake(self.store, request)
        self.assertEqual(intake_context(self.store, request['id'])['intake']['data']['status'], 'obsolete')
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

    def test_partial_answers_wait_then_resolve_preserve_identity_history_and_task(self):
        first = self.job(); first['plan']['questions'] = ['演示是否成功，谁确认发布？']
        apply_intake(self.store, first)
        task_before = task_detail(self.store, 'talk')['task']
        second = self.job(); second['plan']['updates'] = []
        answer = {'intake_id': first['id'], 'index': 0, 'answer': '演示成功，发布人待定',
                  'excerpt': '下一步由模拟同事检查接口。', 'state': 'pending',
                  'remaining': '谁确认发布？', 'review_on': '', 'waiting_for': ''}
        second['plan']['resolutions'] = [answer]
        apply_intake(self.store, second)
        self.assertTrue(apply_intake(self.store, second)['replayed'])
        q = intake_context(self.store, second['id'])['open_questions'][0]
        self.assertEqual(q['question'], '谁确认发布？')
        self.assertEqual(q['original_question'], '演示是否成功，谁确认发布？')
        self.assertEqual(q['answer_state'], 'pending')
        third = self.job(); third['plan']['updates'] = []
        third['plan']['resolutions'] = [{**answer, 'state': 'waiting', 'answer': '暂不确定'}]
        with self.assertRaisesRegex(lumos.Error, '触发条件'):
            apply_intake(self.store, third)
        self.assertEqual(len(intake_context(self.store, third['id'])['open_questions'][0]['answers']), 1)
        third['plan']['resolutions'][0]['waiting_for'] = '发布准备时再核对'
        apply_intake(self.store, third)
        q = intake_context(self.store, third['id'])['open_questions'][0]
        self.assertEqual(q['answer_state'], 'waiting')
        self.assertEqual(len(q['answers']), 2)
        fourth = self.job(); fourth['plan']['updates'] = []
        fourth['plan']['resolutions'] = [{**answer, 'state': 'resolved', 'remaining': '', 'answer': '不再需要确认此事项'}]
        apply_intake(self.store, fourth)
        self.assertFalse(intake_context(self.store, fourth['id'])['open_questions'])
        original = intake_context(self.store, first['id'])['intake']['data']
        self.assertEqual(len(original['resolutions']), 3)
        self.assertEqual(original['questions'], ['演示是否成功，谁确认发布？'])
        self.assertEqual(task_detail(self.store, 'talk')['task'], task_before)
        self.assertEqual(self.store.verify()['integrity'], 'ok')

    def test_note_polish_then_explicit_archive_updates_work_with_original_preserved(self):
        ident = 'note-'+uuid.uuid4().hex
        raw = '同步讨论已完成。下一步由模拟同事检查接口。新结果待验证。'
        save_note(self.store, {'id': ident, 'request_id': uuid.uuid4().hex, 'expected_revision': 0,
            'operation': 'finish', 'changes': {'body': raw, 'title': '原题'}, 'source': self.source})
        job = claim_intake(self.store); ctx = intake_context(self.store, job['id'])
        self.assertEqual(job['data']['note_mode'], 'format')
        self.assertEqual(job['data']['model'], 'gpt-6.2-astra')
        plan = {'summary': '润色并关联', 'questions': [], 'updates': [], 'resolutions': [],
                'note_format': {'title': '接口讨论', 'body': '# 进展\n'+raw, 'related_ids': ['talk', 'mainline-test']}}
        request = {'id': job['id'], 'claim': job['data']['claim'], 'basis': ctx['basis'], 'plan': plan}
        before = task_detail(self.store, 'talk')['task']
        plan['updates'] = [self.item()]
        with self.assertRaisesRegex(lumos.Error, '润色不能'):
            apply_intake(self.store, request)
        plan['updates'] = []; plan['source_refs'] = [{'id': 'talk', 'excerpt': raw}]
        with self.assertRaisesRegex(lumos.Error, '润色不能'):
            apply_intake(self.store, request)
        plan.pop('source_refs'); apply_intake(self.store, request)
        self.assertTrue(apply_intake(self.store, request)['replayed'])
        detail = note_detail(self.store, ident)
        self.assertEqual(detail['note']['data']['status'], 'active')
        self.assertEqual(len(detail['suggestions']), 2)
        self.assertEqual(note_detail(self.store, ident, 1)['note']['data']['body'], raw)
        self.assertEqual(len(detail['history']), 2)
        self.assertEqual(task_detail(self.store, 'talk')['task'], before)
        save_note(self.store, {'id': ident, 'request_id': uuid.uuid4().hex, 'expected_revision': 2,
            'operation': 'process', 'changes': {}, 'source': self.source})
        job = claim_intake(self.store); ctx = intake_context(self.store, job['id'])
        self.assertEqual(job['data']['note_mode'], 'archive')
        self.assertEqual(job['data']['model'], 'gpt-6.2-astra')
        plan = {'summary': '已承接笔记并保留后续问题', 'questions': ['后续验证结果？'], 'resolutions': [],
                'updates': [self.item(changes={'progress': '讨论完成，等待验证'}),
                            self.item('mainline-test', 'mainline', {'summary': '讨论完成，验证仍未知'}),
                            self.item('note-knowledge', 'evidence', {'context': 'mapping', 'title': '接口讨论依据', 'text': raw})]}
        apply_intake(self.store, {'id': job['id'], 'claim': job['data']['claim'], 'basis': ctx['basis'], 'plan': plan})
        self.assertEqual(note_detail(self.store, ident)['note']['data']['status'], 'archived')
        self.assertEqual(task_detail(self.store, 'talk')['task']['data']['progress'], '讨论完成，等待验证')
        self.assertEqual(task_detail(self.store, 'talk')['task']['data']['status'], before['data']['status'])
        self.assertTrue(intake_context(self.store, job['id'])['open_questions'])
        self.assertEqual(self.store.verify()['integrity'], 'ok')

    def test_rewrite_edit_restore_and_archive_gate(self):
        ident = 'note-'+uuid.uuid4().hex
        def save(operation, **changes):
            revision = note_detail(self.store, ident)['note']['data']['revision']
            return save_note(self.store, {'id': ident, 'request_id': uuid.uuid4().hex,
                'expected_revision': revision, 'operation': operation, 'changes': changes, 'source': self.source})['note']
        save_note(self.store, {'id': ident, 'request_id': uuid.uuid4().hex, 'expected_revision': 0,
            'operation': 'finish', 'changes': {'body': '重复原稿', 'title': '原题'}, 'source': self.source})
        with self.assertRaisesRegex(lumos.Error, '自动整理'):
            save('process')
        with self.assertRaisesRegex(lumos.Error, '自动整理'):
            save_intake(self.store, {'request_id': uuid.uuid4().hex, 'note_id': ident, 'source': self.source})
        job = claim_intake(self.store); ctx = intake_context(self.store, job['id'])
        apply_intake(self.store, {'id': job['id'], 'claim': job['data']['claim'], 'basis': ctx['basis'],
            'plan': {'summary': '重写', 'questions': [], 'updates': [],
                     'note_format': {'title': '整理题', 'body': '# 重写\n正文', 'related_ids': ['talk']}}})
        edited = save('edit')
        self.assertEqual(edited['data']['body'], '# 重写\n正文')
        self.assertTrue(edited['data']['formatted_revision'])
        save('finish')
        self.assertEqual(note_detail(self.store, ident)['intake']['data']['status'], 'done')
        save('edit')
        modified = save('save', body='# 重写\n正文\n新问题')
        self.assertFalse(modified['data']['formatted_revision'])
        save('finish')
        with self.assertRaisesRegex(lumos.Error, '自动整理'):
            save('process')
        job = claim_intake(self.store)
        restored = save('restore')
        self.assertEqual(restored['data']['body'], '重复原稿')
        self.assertEqual(restored['data']['title'], '原题')
        self.assertEqual(restored['data']['recording'], 'editing')
        self.assertFalse(restored['data']['formatted_revision'])
        self.assertEqual(restored['data']['suggested_refs'], [])
        self.assertEqual(intake_context(self.store, job['id'])['intake']['data']['status'], 'obsolete')
        self.assertEqual(note_detail(self.store, ident, 2)['note']['data']['body'], '# 重写\n正文')

    def test_manual_archive_delete_cancel_running_note_and_preserve_pinned_source(self):
        from lumos_notes import list_notes
        for operation in ('archive', 'delete'):
            ident = 'note-'+uuid.uuid4().hex
            save_note(self.store, {'id': ident, 'request_id': uuid.uuid4().hex, 'expected_revision': 0,
                'operation': 'finish', 'changes': {'body': '模拟原文'}, 'source': self.source})
            save_task(self.store, {'id': 'talk', 'request_id': uuid.uuid4().hex, 'expected_seq': self.store.status()['seq'],
                'changes': {}, 'note_refs': [{'id': ident, 'revision': 1, 'excerpt': '模拟原文'}], 'source': self.source})
            job = claim_intake(self.store); ctx = intake_context(self.store, job['id'])
            request = {'id': ident, 'request_id': uuid.uuid4().hex, 'expected_revision': 1,
                       'operation': operation, 'changes': {}, 'source': self.source}
            with self.assertRaisesRegex(lumos.Error, '确认'):
                save_note(self.store, request)
            request['confirmed'] = True
            save_note(self.store, request)
            self.assertTrue(save_note(self.store, request)['replayed'])
            self.assertFalse(any(n['id']==ident for n in list_notes(self.store)['notes']))
            self.assertEqual(note_detail(self.store, ident, 1)['note']['data']['body'], '模拟原文')
            self.assertEqual(task_detail(self.store, 'talk')['note_sources'][0]['note']['data']['body'], '模拟原文')
            self.assertEqual(note_intake_status({n['id']: n for n in list_intakes(self.store)['intakes']}, ident)['data']['status'], 'obsolete')
            with self.assertRaises(lumos.Error):
                apply_intake(self.store, {'id': job['id'], 'claim': job['data']['claim'], 'basis': ctx['basis'],
                    'plan': {'summary': '晚到结果不能应用', 'questions': [], 'updates': [],
                             'note_format': {'title': '旧结果', 'body': '不应写入', 'related_ids': []}}})
            with self.assertRaises(lumos.Error):
                save_intake(self.store, {'request_id': uuid.uuid4().hex, 'note_id': ident, 'source': self.source})
        self.assertEqual(self.store.verify()['integrity'], 'ok')

    def test_ordinary_archive_during_writing_never_queues_an_agent(self):
        ident = 'note-'+uuid.uuid4().hex
        save_note(self.store, {'id': ident, 'request_id': uuid.uuid4().hex, 'expected_revision': 0,
            'changes': {'body': '普通临时笔记'}, 'source': self.source})
        save_note(self.store, {'id': ident, 'request_id': uuid.uuid4().hex, 'expected_revision': 1,
            'operation': 'archive', 'confirmed': True, 'changes': {}, 'source': self.source})
        self.assertIsNone(note_detail(self.store, ident)['intake'])
        self.assertEqual(note_detail(self.store, ident)['note']['data']['status'], 'archived')

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
